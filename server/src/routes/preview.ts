import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { SiteError, resolveSitePath, siteExists } from '../sites.js';

const PREVIEW_CSP = "default-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:";

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

async function serveFile(sitesRoot: string, id: string, tail: string, res: Response): Promise<void> {
  let target: string;
  try {
    target = await resolveSitePath(sitesRoot, id, tail === '' ? 'index.html' : tail);
    let stat = await fs.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      target = await resolveSitePath(sitesRoot, id, path.posix.join(tail, 'index.html'));
      stat = await fs.stat(target).catch(() => null);
    }
    if (!stat || !stat.isFile()) {
      sendError(res, 404, `not found: /${tail}`);
      return;
    }
    const type = CONTENT_TYPES[path.extname(target).toLowerCase()];
    if (!type) {
      sendError(res, 404, `unsupported file type: ${path.extname(target)}`);
      return;
    }
    const body = await fs.readFile(target);
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Content-Security-Policy', PREVIEW_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.end(body);
  } catch (err) {
    if (err instanceof SiteError) {
      const status = err.code === 'INVALID_ID' ? 404 : err.status;
      sendError(res, status, err.message);
      return;
    }
    throw err;
  }
}

export function createPreviewRouter(sitesRoot: string): Router {
  const router = Router();

  // The wildcard route must come first: with non-strict routing '/:id'
  // also matches '/:id/', which would otherwise redirect onto itself.
  router.get('/:id/*', (req: Request, res: Response, next) => {
    const { id } = req.params as { id: string };
    const tail = (req.params as Record<string, string | undefined>)[0] ?? '';
    serveFile(sitesRoot, id, tail, res).catch(next);
  });

  // Bare /preview/:id redirects to the trailing-slash form so relative
  // asset URLs in the generated site resolve correctly.
  router.get('/:id', (req: Request, res: Response, next) => {
    const { id } = req.params as { id: string };
    siteExists(sitesRoot, id)
      .then((exists) => {
        if (!exists) {
          sendError(res, 404, `no such site: ${id}`);
          return;
        }
        res.redirect(302, `/preview/${encodeURIComponent(id)}/`);
      })
      .catch(next);
  });

  return router;
}
