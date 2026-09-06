import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ensureCerts } from './certs.js';
import { ensureDataDirs, writeConfig, DEFAULT_CONFIG } from './config.js';
import { appShellHeaders, rateLimit, requestId } from './security.js';
import { SseHub } from './sse.js';
import { agentRouter } from './routes/agent.js';
import { createConfigRouter } from './routes/config.js';
import { createDownloadRouter } from './routes/download.js';
import { createPreviewRouter } from './routes/preview.js';

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

function listen(server: http.Server | https.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });
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

  app.use(requestId());
  app.use(appShellHeaders());
  app.use(rateLimit({ windowMs: 60_000, max: 300 }));

  const buildsPostLimit = rateLimit({ windowMs: 60_000, max: 60 });
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
    agentRouter,
  );
  app.use('/api/config', express.json({ limit: '64kb' }), createConfigRouter(dataRoot));
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
    const certs = await ensureCerts(dirs.certs);
    httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, app);
    await listen(httpsServer, httpsPort);

    httpServer = http.createServer((req, res) => {
      const host = (req.headers.host ?? 'localhost').split(':')[0];
      const location = `https://${host}:${httpsPort}${req.url ?? '/'}`;
      res.writeHead(301, { Location: location, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Moved permanently: ${location}`);
    });
    await listen(httpServer, httpPort);

    log(`Foundry listening at https://localhost:${httpsPort}`);
    log('Dev certificate is self-signed: the browser will warn once. Proceed past the warning, or import');
    log(`${path.join(dirs.certs, 'cert.pem')} into your OS trust store to silence it permanently.`);
    log(`Redirecting http://localhost:${httpPort} -> https://localhost:${httpsPort}`);
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
