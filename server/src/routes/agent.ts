import path from 'node:path';
import { Router, type Application, type NextFunction, type Request, type Response } from 'express';
import { ApiError, Orchestrator } from '../agent/orchestrator.js';
import {
  createKimiProvider,
  createMockProvider,
  createOllamaProvider,
  type Provider,
} from '../agent/provider.js';
import { readConfig, readKey } from '../config.js';
import type { SseHub } from '../sse.js';

export interface AgentRouterDeps {
  orchestrator: Orchestrator;
  /** The shared hub (app.locals.sseHub); subscribe() takes over the events response. */
  hub: Pick<SseHub, 'subscribe'>;
}

function paramId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || id === '') throw new ApiError(400, 'missing build id');
  return id;
}

type Handler = (req: Request, res: Response) => void | Promise<void>;

function handle(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch((err: unknown) => {
      if (err instanceof ApiError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      next(err);
    });
  };
}

function bodyObject(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/**
 * Build-orchestration routes. Mounted at /api/builds (which also carries the
 * download router for /:id/download). The event stream is delegated to the
 * SSE hub: subscribe() writes headers, replays the ring buffer, then streams.
 */
export function createAgentRouter(deps: AgentRouterDeps): Router {
  const { orchestrator, hub } = deps;
  const router = Router();

  router.post(
    '/',
    handle((req, res) => {
      const body = bodyObject(req);
      if (typeof body.brief !== 'string') throw new ApiError(400, 'brief must be a string');
      const { id, queued } = orchestrator.createBuild(body.brief);
      res.status(202).json({ id, queued });
    }),
  );

  router.get(
    '/',
    handle((_req, res) => {
      res.json(orchestrator.list());
    }),
  );

  router.get(
    '/:id',
    handle((req, res) => {
      const state = orchestrator.get(paramId(req));
      if (state === undefined) throw new ApiError(404, `unknown build id: ${paramId(req)}`);
      res.json(state);
    }),
  );

  router.post(
    '/:id/answer',
    handle((req, res) => {
      const body = bodyObject(req);
      if (typeof body.questionId !== 'string' || body.questionId.trim() === '') {
        throw new ApiError(400, 'questionId must be a non-empty string');
      }
      if (typeof body.answer !== 'string') {
        throw new ApiError(400, 'answer must be a string');
      }
      res.json(orchestrator.answer(paramId(req), body.questionId, body.answer));
    }),
  );

  router.post(
    '/:id/approve',
    handle((req, res) => {
      const body = bodyObject(req);
      if (body.plan !== undefined && (!body.plan || typeof body.plan !== 'object' || Array.isArray(body.plan))) {
        throw new ApiError(400, 'plan must be an object when provided');
      }
      res.json(orchestrator.approve(paramId(req), body.plan));
    }),
  );

  router.post(
    '/:id/cancel',
    handle((req, res) => {
      res.json(orchestrator.cancel(paramId(req)));
    }),
  );

  router.get('/:id/events', (req, res) => {
    const id = paramId(req);
    if (orchestrator.get(id) === undefined) {
      res.status(404).json({ error: `unknown build id: ${id}` });
      return;
    }
    hub.subscribe(id, res);
  });

  return router;
}

/* ------------------------------------------------------------------ */
/* Default wiring: the orchestrator needs the shared hub, a data root */
/* and a provider built from the persisted config. Initialization is  */
/* lazy (first request) so importing this module stays side-effect    */
/* free and failures surface as honest 500s, not a crashed process.   */
/* ------------------------------------------------------------------ */

function dataRootFor(app: Application): string {
  // createServer owns the data root; it publishes sseHub on app.locals and may
  // publish dataRoot the same way. The fallback mirrors index.ts's own default.
  const published: unknown = app.locals.dataRoot;
  if (typeof published === 'string' && published !== '') return published;
  return process.env.FOUNDRY_DATA_DIR ?? path.resolve(process.cwd(), 'data');
}

async function defaultProvider(dataRoot: string): Promise<Provider> {
  const config = await readConfig(dataRoot);
  switch (config.provider) {
    case 'mock':
      return createMockProvider();
    case 'ollama':
      return createOllamaProvider({
        endpoint: config.endpoint !== '' ? config.endpoint : undefined,
        model: config.model !== '' ? config.model : undefined,
      });
    case 'kimi':
    case 'openai-compatible': {
      if (config.provider === 'openai-compatible' && config.endpoint.trim() === '') {
        throw new Error('provider "openai-compatible" needs an endpoint URL — set one with PUT /api/config');
      }
      return createKimiProvider({
        endpoint: config.endpoint !== '' ? config.endpoint : undefined,
        model: config.model !== '' && config.model !== 'mock' ? config.model : undefined,
        getKey: () => readKey(dataRoot),
      });
    }
    default:
      throw new Error(`unknown provider in config: ${String(config.provider)}`);
  }
}

async function buildDefaultRouter(app: Application): Promise<Router> {
  const hub = app.locals.sseHub as SseHub | undefined;
  if (hub === undefined || typeof hub.send !== 'function' || typeof hub.subscribe !== 'function') {
    throw new Error('agentRouter needs app.locals.sseHub (an SseHub); see server/src/index.ts');
  }
  const dataRoot = dataRootFor(app);
  const orchestrator = await Orchestrator.open({
    sitesRoot: path.join(dataRoot, 'sites'),
    dataDir: dataRoot,
    hub,
    getProvider: () => defaultProvider(dataRoot),
  });
  return createAgentRouter({ orchestrator, hub });
}

const initialized = new WeakMap<Application, Promise<Router>>();

export const agentRouter = Router().use((req: Request, res: Response, next: NextFunction) => {
  let pending = initialized.get(req.app);
  if (pending === undefined) {
    pending = buildDefaultRouter(req.app);
    initialized.set(req.app, pending);
    // A failed init (e.g. unreadable config) must not poison later requests.
    pending.catch(() => initialized.delete(req.app));
  }
  pending.then((router) => router(req, res, next)).catch(next);
});
