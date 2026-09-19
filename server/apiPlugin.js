import { handleApiRequest } from './apiRouter.js';

/**
 * Vite dev-server integration: routes /api/* through the shared API router.
 * /api/update/* is excluded so the Windows one-click update plugin in
 * vite.config.js keeps handling it during development.
 */
export function apiPlugin() {
  return {
    name: 'plantrace-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0];
        if (!pathname.startsWith('/api/')) { next(); return; }

        handleApiRequest(req, res, pathname, { includeUpdate: false })
          .then((handled) => {
            if (!handled) next();
          })
          .catch((err) => {
            if (res.headersSent) { res.end(); return; }
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: err.message || '服务器内部错误' }));
          });
      });
    },
  };
}
