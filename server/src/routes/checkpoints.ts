import { Router, type NextFunction, type Request, type Response } from 'express';
import { ApiError } from '../agent/orchestrator.js';
import { SiteError, assertValidId } from '../sites.js';
import type { SseHub } from '../sse.js';

/** Wire shape of one checkpoint as reported to clients. */
export interface CheckpointInfo {
  /** 1-based checkpoint sequence number. */
  n: number;
  /** Epoch ms when the snapshot was taken. */
  createdAt: number;
  /** Why the checkpoint exists (e.g. 'build', 'edit'); '' when unknown. */
  label: string;
  /** File count captured in the snapshot. */
  files: number;
  /** Total bytes captured in the snapshot. */
  bytes: number;
}

/**
 * Structural seam for the checkpoint service (server/src/agent/checkpoints.ts,
 * CKPT-SVC; createCheckpointService satisfies this). The route calls it
 * directly with the confined site store root.
 */
export interface CheckpointServiceLike {
  list(sitesRoot: string, buildId: string): Promise<CheckpointInfo[]>;
  /**
   * Returns the restored checkpoint. An unknown checkpoint surfaces as either
   * null or a thrown error carrying an HTTP status (e.g. CheckpointError 404).
   */
  restore(sitesRoot: string, buildId: string, n: number): Promise<CheckpointInfo | null>;
}

/** The build-registry read surface this router needs (the Orchestrator satisfies it). */
export interface BuildRegistryLike {
  get(id: string): { phase: string } | undefined;
}

export interface CheckpointsRouterDeps {
  /** Root of the confined site store; handed to the checkpoint service verbatim. */
  sitesRoot: string;
  /** Build registry (the shared Orchestrator) for existence and phase checks. */
  builds: BuildRegistryLike;
  /** Checkpoint service (server/src/agent/checkpoints.ts). */
  service: CheckpointServiceLike;
  /** Shared SSE hub; restore re-emits the current phase so clients refresh. */
  hub: Pick<SseHub, 'send'>;
}

// Restore is refused while a drive could be writing files. EDITING arrives
// with the edit workstream; comparing plain strings keeps this module
// decoupled from the orchestrator's phase union.
const ACTIVE_PHASES: ReadonlySet<string> = new Set(['BUILDING', 'EDITING', 'REVIEW']);

type Handler = (req: Request, res: Response) => void | Promise<void>;

function handle(fn: Handler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch((err: unknown) => {
      if (err instanceof ApiError || err instanceof SiteError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      // Service errors (e.g. CheckpointError from the checkpoint service)
      // carry an HTTP status; honor it, mirroring the app error middleware.
      const status = (err as { status?: unknown } | null | undefined)?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        res.status(status).json({ error: err instanceof Error ? err.message : 'error' });
        return;
      }
      next(err);
    });
  };
}

function paramId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || id === '') throw new ApiError(400, 'missing build id');
  assertValidId(id);
  return id;
}

function paramCheckpointN(req: Request): number {
  const raw = req.params.n;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new ApiError(400, `checkpoint number must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new ApiError(400, `checkpoint number must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

function mustGetBuild(builds: BuildRegistryLike, id: string): { phase: string } {
  const state = builds.get(id);
  if (state === undefined) throw new ApiError(404, `unknown build id: ${id}`);
  return state;
}

/** Wire-boundary validation: malformed service entries are dropped, not leaked. */
function toCheckpointInfo(raw: unknown): CheckpointInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Partial<CheckpointInfo>;
  if (typeof c.n !== 'number' || !Number.isSafeInteger(c.n) || c.n < 1) return null;
  if (typeof c.createdAt !== 'number' || !Number.isFinite(c.createdAt)) return null;
  return {
    n: c.n,
    createdAt: c.createdAt,
    label: typeof c.label === 'string' ? c.label : '',
    files: typeof c.files === 'number' && Number.isFinite(c.files) && c.files >= 0 ? c.files : 0,
    bytes: typeof c.bytes === 'number' && Number.isFinite(c.bytes) && c.bytes >= 0 ? c.bytes : 0,
  };
}

/**
 * Checkpoint REST routes. Mounted at /api/builds alongside the agent and
 * download routers:
 *
 *   app.use('/api/builds', createCheckpointsRouter({ sitesRoot, builds: orchestrator, service, hub }));
 *
 * Restore calls the checkpoint service directly with the sites store and then
 * re-emits the build's current phase through the hub itself (the orchestrator
 * is not involved in the restore), so connected clients refetch state and files.
 */
export function createCheckpointsRouter(deps: CheckpointsRouterDeps): Router {
  const { sitesRoot, builds, service, hub } = deps;
  const router = Router();

  router.get(
    '/:id/checkpoints',
    handle(async (req, res) => {
      const id = paramId(req);
      mustGetBuild(builds, id);
      const raw = await service.list(sitesRoot, id);
      const checkpoints = raw
        .map(toCheckpointInfo)
        .filter((c): c is CheckpointInfo => c !== null)
        .sort((a, b) => a.n - b.n);
      res.json(checkpoints);
    }),
  );

  router.post(
    '/:id/checkpoints/:n/restore',
    handle(async (req, res) => {
      const id = paramId(req);
      const n = paramCheckpointN(req);
      const state = mustGetBuild(builds, id);
      if (ACTIVE_PHASES.has(state.phase)) {
        throw new ApiError(409, `cannot restore a checkpoint while the build is ${state.phase.toLowerCase()}`);
      }
      const restored = await service.restore(sitesRoot, id, n);
      if (restored === null) throw new ApiError(404, `unknown checkpoint ${n} for build ${id}`);
      const checkpoint = toCheckpointInfo(restored);
      if (checkpoint === null) throw new Error('checkpoint service returned a malformed checkpoint');
      // Re-read the phase after the restore: it cannot have left a terminal
      // state, but a parked INTAKE build may have moved on concurrently.
      const phase = builds.get(id)?.phase ?? state.phase;
      hub.send(id, { type: 'phase', phase });
      res.json({ ok: true, restored: checkpoint.n, checkpoint });
    }),
  );

  return router;
}
