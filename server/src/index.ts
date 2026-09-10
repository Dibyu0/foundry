import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ensureCerts } from './certs.js';
import { ensureDataDirs, writeConfig, readConfig, DEFAULT_CONFIG } from './config.js';
import { appShellHeaders, rateLimit, requestId } from './security.js';
import { SseHub } from './sse.js';
import { agentRouter } from './routes/agent.js';
import { createConfigRouter } from './routes/config.js';
import { createDownloadRouter } from './routes/download.js';
import { createPreviewRouter } from './routes/preview.js';
import { createCheckpointsRouter, type BuildRegistryLike } from './routes/checkpoints.js';
import { createCheckpointService } from './agent/checkpoints.js';
import { createShareApiRouter, createShareRouter } from './routes/share.js';
import { enhanceRouter } from './routes/agent.js';

export interface ServerOptions {
  dataRoot?: string;
  httpsPort?: number;
  httpPort?: number;
  webRoot?: string;
  /** Bind ports. Defaults to false so tests can drive the app directly. */
  listen?: boolean;
  log?: (message: string) => void;
}

export interface FoundryServer {
  app: express.Express;
  hub: SseHub;
  dataRoot: string;
  httpsServer: https.Server | null;
  httpServer: http.Server | null;
  close(): Promise<void>;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function portFrom(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${JSON.stringify(value)}`);
  }
  return port;
}

function listen(server: http.Server | https.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
}

/**
 * Preloads the configured Ollama model (plus any per-role overrides) so the
 * first build never pays a multi-second cold load. An empty-messages call
 * makes Ollama load the weights and exit immediately; keep_alive pins them.
 * Best-effort: failures are silent — the first real call will just load then.
 */
async function warmOllama(dataRoot: string, log: (message: string) => void): Promise<void> {
  try {
    const config = await readConfig(dataRoot);
    if (config.provider !== 'ollama') return;
    const endpoint = (config.endpoint !== '' ? config.endpoint : 'http://localhost:11434').replace(/\/+$/, '');
    const models = new Set<string>([config.model !== '' ? config.model : 'qwen2.5-coder:7b']);
    for (const m of Object.values(config.perRoleModels ?? {})) {
      if (typeof m === 'string' && m.trim() !== '') models.add(m.trim());
    }
    for (const model of models) {
      try {
        const res = await fetch(`${endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [], keep_alive: '24h' }),
          signal: AbortSignal.timeout(120_000),
        });
        await res.arrayBuffer();
        log(`[foundry] ollama model warmed and pinned (keep_alive 24h): ${model}`);
      } catch {
        log(`[foundry] ollama warmup skipped for ${model} (server unreachable?)`);
      }
    }
  } catch {
    // A broken/missing config already surfaces through /api/config; warmup stays silent.
  }
}

/**
 * Bind host for both listeners. Loopback is the default on purpose: the API
 * is unauthenticated and holds provider keys + endpoint settings, so binding
 * all interfaces would let any LAN peer redirect provider traffic (and the
 * key) through their host. Set FOUNDRY_HOST (e.g. 0.0.0.0) to expose
 * deliberately — the log line then says so honestly.
 */
function bindHost(): string {
  const host = process.env.FOUNDRY_HOST?.trim();
  return host === undefined || host === '' ? '127.0.0.1' : host;
}

export async function createServer(opts: ServerOptions = {}): Promise<FoundryServer> {
  const log = opts.log ?? console.log;
  const dataRoot = opts.dataRoot ?? process.env.FOUNDRY_DATA_DIR ?? path.resolve(process.cwd(), 'data');
  const httpsPort = opts.httpsPort ?? portFrom(process.env.FOUNDRY_HTTPS_PORT, 8443);
  const httpPort = opts.httpPort ?? portFrom(process.env.FOUNDRY_HTTP_PORT, 8080);
  const webRoot = opts.webRoot ?? path.resolve(moduleDir, '../../web/dist');

  const dirs = await ensureDataDirs(dataRoot);
  // Persist defaults on first run so the file is discoverable to edit.
  const configStat = await fs.stat(dirs.configFile).catch(() => null);
  if (!configStat) await writeConfig(dataRoot, DEFAULT_CONFIG);

  const app = express();
  app.disable('x-powered-by');

  const hub = new SseHub();
  // Consumed by the orchestration routes (agent workstream).
  app.locals.sseHub = hub;
  // Published for the lazily-initialized routers (agent/enhance), which read
  // app.locals.dataRoot rather than re-deriving it.
  app.locals.dataRoot = dataRoot;

  app.use(requestId());
  app.use(appShellHeaders());
  app.use(rateLimit({ windowMs: 60_000, max: 300 }));

  const buildsPostLimit = rateLimit({ windowMs: 60_000, max: 60 });
  // Checkpoint service: snapshots flow in from the orchestrator (published
  // on app.locals by the agent router's lazy init).
  const checkpointService = createCheckpointService({
    dataDir: dataRoot,
    sitesStore: dirs.sites,
  });
  app.locals.checkpointService = checkpointService;
  // The orchestrator is built lazily on the first agent request and
  // published on app.locals; until then the registry honestly reports
  // "unknown build" (no builds can exist before init anyway).
  const lazyBuildRegistry: BuildRegistryLike = {
    get: (id: string) => app.locals.orchestrator?.get(id),
  };
  app.use(
    '/api/builds',
    (req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'POST' && (req.path === '/' || req.path === '')) {
        buildsPostLimit(req, res, next);
        return;
      }
      next();
    },
    express.json({ limit: '256kb' }),
    createDownloadRouter(dirs.sites),
    createCheckpointsRouter({
      sitesRoot: dirs.sites,
      builds: lazyBuildRegistry,
      service: checkpointService,
      hub,
    }),
    createShareApiRouter(dirs.sites, { httpsPort }),
    agentRouter,
  );
  app.use('/api/enhance-prompt', express.json({ limit: '64kb' }), enhanceRouter);
  app.use('/api/config', express.json({ limit: '64kb' }), createConfigRouter(dataRoot));
  app.use('/p', createShareRouter(dirs.sites));
  app.use('/preview', createPreviewRouter(dirs.sites));

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  const indexHtml = path.join(webRoot, 'index.html');
  app.use(express.static(webRoot, { index: false }));
  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || !req.accepts('html')) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    fs.stat(indexHtml)
      .then(() => {
        res.sendFile(indexHtml, (err) => {
          if (err) next(err);
        });
      })
      .catch(() => {
        res
          .status(503)
          .json({ error: 'web UI not built yet — run `npm run build:web` and restart' });
      });
  });

  // Body-parser and fallback errors always surface as JSON, never HTML.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const typed = err as { type?: string; status?: number; message?: string };
    if (typed?.type === 'entity.too.large') {
      res.status(413).json({ error: 'request body too large' });
      return;
    }
    if (typed?.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'request body is not valid JSON' });
      return;
    }
    const status = typeof typed?.status === 'number' ? typed.status : 500;
    res.status(status).json({ error: status === 500 ? 'internal server error' : typed?.message ?? 'error' });
  });

  let httpsServer: https.Server | null = null;
  let httpServer: http.Server | null = null;

  if (opts.listen) {
    const host = bindHost();
    const certs = await ensureCerts(dirs.certs);
    httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, app);
    await listen(httpsServer, httpsPort, host);

    httpServer = http.createServer((req, res) => {
      const reqHost = (req.headers.host ?? 'localhost').split(':')[0];
      const location = `https://${reqHost}:${httpsPort}${req.url ?? '/'}`;
      res.writeHead(301, { Location: location, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Moved permanently: ${location}`);
    });
    await listen(httpServer, httpPort, host);

    log(`Foundry listening at https://localhost:${httpsPort}`);
    if (host !== '127.0.0.1' && host !== '::1') {
      log(`WARNING: bound to ${host} — the unauthenticated API (config, keys, builds) is reachable from other hosts`);
    }

    log(`Foundry listening at https://localhost:${httpsPort}`);
    log('Dev certificate is self-signed: the browser will warn once. Proceed past the warning, or import');
    log(`${path.join(dirs.certs, 'cert.pem')} into your OS trust store to silence it permanently.`);
    log(`Redirecting http://localhost:${httpPort} -> https://localhost:${httpsPort}`);

    void warmOllama(dataRoot, log);
  }

  return {
    app,
    hub,
    dataRoot,
    httpsServer,
    httpServer,
    async close() {
      hub.shutdown();
      const servers = [httpsServer, httpServer].filter(
        (server): server is http.Server | https.Server => server !== null && server.listening,
      );
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeIdleConnections();
              server.close(() => resolve());
            }),
        ),
      );
    },
  };
}

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
  const server = await createServer({ listen: true });
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error('error during shutdown:', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
