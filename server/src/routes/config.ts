import { Router, type Request, type Response } from 'express';
import { PROVIDERS, readConfig, readKey, writeConfig, writeKey, type Provider } from '../config.js';

const MAX_MODEL_LEN = 128;
const MAX_KEY_LEN = 4096;

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function isValidEndpoint(endpoint: string): boolean {
  if (endpoint === '') return true;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // Plain http is only acceptable for a loopback endpoint (e.g. Ollama).
  if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
  return false;
}

/**
 * Provider configuration. The API key is never exposed: GET reports only
 * whether one is stored. Mounted at /api/config.
 */
export function createConfigRouter(dataRoot: string): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response, next) => {
    (async () => {
      const config = await readConfig(dataRoot);
      const key = await readKey(dataRoot);
      res.json({
        provider: config.provider,
        endpoint: config.endpoint,
        model: config.model,
        hasKey: key !== '',
      });
    })().catch(next);
  });

  router.put('/', (req: Request, res: Response, next) => {
    (async () => {
      const body = req.body as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        badRequest(res, 'body must be a JSON object');
        return;
      }
      const { provider, endpoint, model, apiKey } = body as Record<string, unknown>;

      if (typeof provider !== 'string' || !(PROVIDERS as readonly string[]).includes(provider)) {
        badRequest(res, `provider must be one of: ${PROVIDERS.join(', ')}`);
        return;
      }
      if (typeof endpoint !== 'string' || !isValidEndpoint(endpoint)) {
        badRequest(res, 'endpoint must be an https URL, a localhost http URL, or empty');
        return;
      }
      if (typeof model !== 'string' || model.trim() === '' || model.length > MAX_MODEL_LEN) {
        badRequest(res, `model must be a non-empty string of at most ${MAX_MODEL_LEN} characters`);
        return;
      }
      if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.length > MAX_KEY_LEN)) {
        badRequest(res, `apiKey must be a string of at most ${MAX_KEY_LEN} characters`);
        return;
      }

      await writeConfig(dataRoot, { provider: provider as Provider, endpoint, model });
      if (apiKey !== undefined) await writeKey(dataRoot, apiKey);

      const key = await readKey(dataRoot);
      res.json({ provider, endpoint, model, hasKey: key !== '' });
    })().catch(next);
  });

  return router;
}
