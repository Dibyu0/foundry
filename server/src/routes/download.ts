import archiver from 'archiver';
import { Router, type Request, type Response } from 'express';
import { assertValidId, siteDir, siteExists } from '../sites.js';

/**
 * Streams the whole site directory as a zip. Mounted at /api/builds, so the
 * route is GET /api/builds/:id/download.
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
