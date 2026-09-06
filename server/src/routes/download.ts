import archiver from 'archiver';
import { Router, type Request, type Response } from 'express';
import { bundleSite, BundleError } from '../agent/bundle.js';
import { assertValidId, listSiteFiles, readSiteFile, siteDir, siteExists } from '../sites.js';

/**
 * Download routes for a built site. Mounted at /api/builds, so the route is
 * GET /api/builds/:id/download. Default format streams the whole site
 * directory as a zip; ?format=single returns one self-contained html file
 * with local stylesheets and scripts inlined.
 */
export function createDownloadRouter(sitesRoot: string): Router {
  const router = Router();

  router.get('/:id/download', (req: Request, res: Response, next) => {
    const { id } = req.params as { id: string };
    (async () => {
      try {
        assertValidId(id);
      } catch {
        res.status(404).json({ error: `no such build: ${id}` });
        return;
      }
      if (!(await siteExists(sitesRoot, id))) {
        res.status(404).json({ error: `no such build: ${id}` });
        return;
      }
      const format = typeof req.query.format === 'string' ? req.query.format : 'zip';
      if (format !== 'zip' && format !== 'single') {
        res.status(400).json({ error: `unknown download format: ${JSON.stringify(format)}; expected "zip" or "single"` });
        return;
      }
      if (format === 'single') {
        const entries = await listSiteFiles(sitesRoot, id);
        const files = new Map<string, string>();
        for (const entry of entries) {
          files.set(entry.path, (await readSiteFile(sitesRoot, id, entry.path)).toString('utf8'));
        }
        let html: string;
        try {
          html = bundleSite(files).html;
        } catch (err) {
          if (err instanceof BundleError) {
            res.status(422).json({ error: err.message });
            return;
          }
          throw err;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="foundry-site-${id.slice(0, 8)}.html"`);
        res.send(html);
        return;
      }
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="foundry-site-${id.slice(0, 8)}.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err: Error) => {
        if (!res.headersSent) {
          res.status(500).json({ error: `zip failed: ${err.message}` });
        }
        res.destroy();
      });
      res.on('close', () => {
        if (!res.writableFinished) archive.destroy();
      });
      archive.pipe(res);
      archive.directory(siteDir(sitesRoot, id), false);
      await archive.finalize();
    })().catch(next);
  });

  return router;
}
