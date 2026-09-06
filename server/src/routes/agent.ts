import path from 'node:path';
import { Router, type Application, type NextFunction, type Request, type Response } from 'express';
import { ApiError, Orchestrator } from '../agent/orchestrator.js';
import {
  createKimiProvider,
  createMockProvider,
  createOllamaProvider,
  type ChatMessage,
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

  router.post(
    '/:id/edit',
    handle((req, res) => {
      const body = bodyObject(req);
      if (typeof body.instruction !== 'string') throw new ApiError(400, 'instruction must be a string');
      res.json(orchestrator.edit(paramId(req), body.instruction));
    }),
  );

  router.post(
    '/:id/fixError',
    handle((req, res) => {
      const body = bodyObject(req);
      if (typeof body.message !== 'string') throw new ApiError(400, 'message must be a string');
      if (body.file !== undefined && typeof body.file !== 'string') {
        throw new ApiError(400, 'file must be a string when provided');
      }
      if (body.line !== undefined && typeof body.line !== 'number') {
        throw new ApiError(400, 'line must be a number when provided');
      }
      const opts: { file?: unknown; line?: unknown } = {};
      if (body.file !== undefined) opts.file = body.file;
      if (body.line !== undefined) opts.line = body.line;
      res.json(orchestrator.fixError(paramId(req), body.message, opts));
    }),
  );

  router.post(
    '/:id/pause',
    handle((req, res) => {
      res.json(orchestrator.pause(paramId(req)));
    }),
  );

  router.post(
    '/:id/resume',
    handle((req, res) => {
      res.json(orchestrator.resume(paramId(req)));
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
  const checkpoints = app.locals.checkpointService as
    | import('../agent/checkpoints.js').CheckpointService
    | undefined;
  const orchestrator = await Orchestrator.open({
    sitesRoot: path.join(dataRoot, 'sites'),
    dataDir: dataRoot,
    hub,
    getProvider: () => defaultProvider(dataRoot),
    ...(checkpoints !== undefined ? { checkpoints } : {}),
  });
  // Published for the lazily-mounted checkpoint/share routers (index.ts).
  app.locals.orchestrator = orchestrator;
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

/* ------------------------------------------------------------------ */
/* POST /api/enhance-prompt: one cheap provider round that rewrites a */
/* rough draft into a complete website brief. The mock provider has   */
/* no free-text mode, so mock config uses the deterministic canned    */
/* enhancer below. Mounted at /api/enhance-prompt by index.ts.        */
/* ------------------------------------------------------------------ */

export const ENHANCE_DRAFT_MAX_CHARS = 8000;

const ENHANCE_SYSTEM_PROMPT = [
  'You rewrite rough website ideas into clear, complete briefs for an AI website builder.',
  'Return only the rewritten brief as plain prose: one or two short paragraphs covering the',
  "site's purpose, its audience, the key sections it needs, and the look and feel.",
  'Do not ask questions, add explanations, use markdown, or wrap the result in quotes.',
].join(' ');

export function enhanceMessages(draft: string): ChatMessage[] {
  return [
    { role: 'system', content: ENHANCE_SYSTEM_PROMPT },
    { role: 'user', content: draft.trim() },
  ];
}

/**
 * Canned enhancer for the mock provider: deterministic, derived from the
 * draft, and structured like a real enhanced brief. Mock mode is explicitly
 * a demo mode, so a fixed recipe here matches the rest of the pipeline.
 */
export function mockEnhance(draft: string): string {
  const core = draft.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
  const lead = core.charAt(0).toUpperCase() + core.slice(1);
  return [
    `${lead}. The site exists to make that idea obvious within the first screen: a sticky glass navigation, an animated hero with one clear call to action, three to six sections that build the case, real social proof, and a footer with contact details.`,
    'Look and feel: dark premium surfaces with gradient accents, fluid typography, generous whitespace, and scroll-reveal motion throughout - all of it settling instantly when the visitor prefers reduced motion.',
  ].join('\n\n');
}

function cleanEnhanced(raw: string): string {
  let text = raw.trim();
  // Some models wrap the whole reply in quotes despite the instruction.
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

export interface EnhanceRouterDeps {
  /** Provider kind from the persisted config; 'mock' skips the provider round. */
  getKind: () => string | Promise<string>;
  /** Lazily resolve the configured provider (only called for non-mock kinds). */
  getProvider: () => Promise<Provider>;
}

export function createEnhanceRouter(deps: EnhanceRouterDeps): Router {
  const router = Router();

  router.post(
    '/',
    handle(async (req, res) => {
      const body = bodyObject(req);
      if (typeof body.draft !== 'string' || body.draft.trim() === '') {
        throw new ApiError(400, 'draft must be a non-empty string');
      }
      if (body.draft.length > ENHANCE_DRAFT_MAX_CHARS) {
        throw new ApiError(400, `draft is too long (max ${ENHANCE_DRAFT_MAX_CHARS} characters)`);
      }
      if ((await deps.getKind()) === 'mock') {
        res.json({ enhanced: mockEnhance(body.draft) });
        return;
      }
      let enhanced: string;
      try {
        const provider = await deps.getProvider();
        enhanced = cleanEnhanced(
          await provider.complete(enhanceMessages(body.draft), { temperature: 0.4, maxTokens: 600 }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ApiError(502, `enhancement failed: ${message}`);
      }
      if (enhanced === '') {
        throw new ApiError(502, 'enhancement failed: the provider returned an empty response');
      }
      res.json({ enhanced });
    }),
  );

  return router;
}

const enhanceInitialized = new WeakMap<Application, Promise<Router>>();

function buildEnhanceRouter(app: Application): Promise<Router> {
  const dataRoot = dataRootFor(app);
  return Promise.resolve(
    createEnhanceRouter({
      getKind: async () => (await readConfig(dataRoot)).provider,
      getProvider: () => defaultProvider(dataRoot),
    }),
  );
}

export const enhanceRouter = Router().use((req: Request, res: Response, next: NextFunction) => {
  let pending = enhanceInitialized.get(req.app);
  if (pending === undefined) {
    pending = buildEnhanceRouter(req.app);
    enhanceInitialized.set(req.app, pending);
    pending.catch(() => enhanceInitialized.delete(req.app));
  }
  pending.then((router) => router(req, res, next)).catch(next);
});
