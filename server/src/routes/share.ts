import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { SiteError, readSiteFile, resolveSitePath, siteExists } from '../sites.js';
import { promises as fs } from 'node:fs';

// Must stay in sync with PREVIEW_CSP in preview.ts (BRIDGE-owned, not exported)
// and with CONTENT_TYPES there: share pages render untrusted generated sites,
// so they get the preview policy, not the app-shell policy.
const SHARE_CSP = "default-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:";

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

const SHARE_BAR_HEIGHT_PX = 44;

const SHARE_BAR_CSS = `
#foundry-share-bar{position:fixed!important;top:0;left:0;right:0;height:${SHARE_BAR_HEIGHT_PX}px;z-index:2147483647;display:flex!important;align-items:center;gap:14px;padding:0 16px!important;box-sizing:border-box;background:#101319;color:#e8eaf0;border-bottom:1px solid #262c38;font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;letter-spacing:.01em}
#foundry-share-bar *{box-sizing:border-box;margin:0;padding:0}
#foundry-share-bar .fsb-dot{width:7px;height:7px;border-radius:50%;background:#4f8cff;flex:none}
#foundry-share-bar .fsb-title{color:#e8eaf0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw}
#foundry-share-bar .fsb-spacer{flex:1 1 auto}
#foundry-share-bar a{color:#9db8e8;text-decoration:none;font-weight:600;white-space:nowrap;padding:5px 10px;border-radius:6px;border:1px solid #2c3442;background:#171c26}
#foundry-share-bar a:hover{background:#1f2634;color:#cfe0ff}
#foundry-share-bar .fsb-brand{color:#7d8494;white-space:nowrap}
body{padding-top:${SHARE_BAR_HEIGHT_PX}px!important}
`.trim();

function extractTitle(html: string): string | null {
  const match = /<title\b[^>]*>([^<]*)<\/title\s*>/i.exec(html);
  if (!match) return null;
  const raw = (match[1] ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * Inserts the Foundry share bar into a site's index.html. The bar is
 * fixed-position and the page body is padded down by the bar height, so the
 * page renders unclipped underneath. The title captured from <title> is
 * entity-encoded by the page itself and is inserted verbatim — re-escaping
 * would double-encode (the [^<]* capture already excludes markup).
 */
export function injectShareBanner(html: string, id: string): string {
  const title = extractTitle(html) ?? 'Untitled site';
  const bar =
    `<div id="foundry-share-bar"><span class="fsb-dot"></span>` +
    `<span class="fsb-title">${title}</span><span class="fsb-spacer"></span>` +
    `<a href="/preview/${id}/">Open preview</a>` +
    `<a href="/api/builds/${id}/download">Download</a>` +
    `<span class="fsb-brand">Built with Foundry</span></div>`;
  const snippet = `<style id="foundry-share-bar-style">${SHARE_BAR_CSS}</style>${bar}`;

  const bodyOpen = /<body\b[^>]*>/i.exec(html);
  if (bodyOpen) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, at) + snippet + html.slice(at);
  }
  const headClose = /<\/head\s*>/i.exec(html);
  if (headClose) {
    const at = headClose.index + headClose[0].length;
    return html.slice(0, at) + snippet + html.slice(at);
  }
  return snippet + html;
}

/** First non-loopback IPv4 address of the machine, or '' when there is none. */
export function firstNonLoopbackIPv4(nets: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  for (const infos of Object.values(nets)) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return '';
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function setShareHeaders(res: Response, type: string, length: number): void {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(length));
  res.setHeader('Content-Security-Policy', SHARE_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Robots-Tag', 'noindex');
}

function siteErrorStatus(err: SiteError): number {
  // Mirror the preview route: an unparseable id is 'no such site' to callers.
  return err.code === 'INVALID_ID' ? 404 : err.status;
}

async function serveShareIndex(sitesRoot: string, id: string, res: Response): Promise<void> {
  try {
    const raw = await readSiteFile(sitesRoot, id, 'index.html');
    const body = Buffer.from(injectShareBanner(raw.toString('utf8'), id), 'utf8');
    setShareHeaders(res, 'text/html; charset=utf-8', body.length);
    res.end(body);
  } catch (err) {
    if (err instanceof SiteError) {
      sendError(res, siteErrorStatus(err), err.message);
      return;
    }
    throw err;
  }
}

async function serveShareAsset(sitesRoot: string, id: string, tail: string, res: Response): Promise<void> {
  try {
    let target = await resolveSitePath(sitesRoot, id, tail);
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
    setShareHeaders(res, type, body.length);
    res.end(body);
  } catch (err) {
    if (err instanceof SiteError) {
      sendError(res, siteErrorStatus(err), err.message);
      return;
    }
    throw err;
  }
}

/**
 * Public share pages under /p/: the site's index.html with a slim Foundry
 * banner injected, plus the site's assets so relative links keep working.
 */
export function createShareRouter(sitesRoot: string): Router {
  const router = Router();

  // The wildcard route must come first, same as in the preview router:
  // with non-strict routing '/:id' also matches '/:id/', which would
  // otherwise redirect onto itself.
  router.get('/:id/*', (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params as { id: string };
    const tail = (req.params as Record<string, string | undefined>)[0] ?? '';
    const work = tail === '' ? serveShareIndex(sitesRoot, id, res) : serveShareAsset(sitesRoot, id, tail, res);
    work.catch(next);
  });

  // Bare /p/:id redirects to the trailing-slash form so relative asset URLs
  // in the shared site resolve correctly.
  router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params as { id: string };
    siteExists(sitesRoot, id)
      .then((exists) => {
        if (!exists) {
          sendError(res, 404, `no such site: ${id}`);
          return;
        }
        res.redirect(302, `/p/${encodeURIComponent(id)}/`);
      })
      .catch(next);
  });

  return router;
}

export interface ShareApiOptions {
  httpsPort: number;
}

/**
 * Share metadata for a build. Mounted at /api/builds, so the route is
 * GET /api/builds/:id/share.
 */
export function createShareApiRouter(sitesRoot: string, opts: ShareApiOptions): Router {
  const router = Router();

  router.get('/:id/share', (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params as { id: string };
    (async () => {
      if (!(await siteExists(sitesRoot, id))) {
        sendError(res, 404, `no such build: ${id}`);
        return;
      }
      const lanAddress = firstNonLoopbackIPv4(networkInterfaces());
      res.json({
        shareUrl: `/p/${id}/`,
        lanUrl: lanAddress === '' ? '' : `http://${lanAddress}:${opts.httpsPort}/p/${id}/`,
      });
    })().catch(next);
  });

  return router;
}
