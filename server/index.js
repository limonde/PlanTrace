/**
 * PlanTrace production server (cloud deployment).
 *
 * Serves:
 *   - /api/*  → the shared API router (accounts, per-user data, backup, update)
 *   - static  → the built SPA in dist/ with history fallback (BrowserRouter)
 *
 * Env:
 *   PLANTRACE_PORT           port to listen on            (default 3000)
 *   PLANTRACE_HOST           bind address                 (default 0.0.0.0)
 *   PLANTRACE_TRUST_PROXY    "1" when behind a reverse proxy (Caddy/Nginx)
 *   PLANTRACE_SECURE_COOKIE  "1" to force the Secure cookie flag
 *   PLANTRACE_SETUP_TOKEN    fixed first-run setup token
 *   PLANTRACE_SELF_UPDATE    "1" to allow in-app git-based updates
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleApiRequest } from './apiRouter.js';
import { ensureSetupToken } from './auth.js';
import { readLocalVersion } from './update.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PLANTRACE_PORT || 3000);
const HOST = process.env.PLANTRACE_HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.PLANTRACE_TRUST_PROXY === '1') {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end('Method not allowed');
    return;
  }

  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

  let filePath = path.normalize(path.join(DIST, relative));
  if (!filePath.startsWith(DIST)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let isHistoryFallback = false;
  let stat = null;
  try { stat = fs.statSync(filePath); } catch { /* missing */ }
  if (!stat || stat.isDirectory()) {
    filePath = path.join(DIST, 'index.html');
    isHistoryFallback = true;
    try { stat = fs.statSync(filePath); } catch { stat = null; }
  }

  if (!stat || !stat.isFile()) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<h1>PlanTrace 尚未构建</h1><p>请先在项目目录执行 <code>npm run build</code>，再启动服务。</p>');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
  if (isHistoryFallback || ext === '.html') {
    res.setHeader('Cache-Control', 'no-cache');
  } else if (relative.startsWith('/assets/')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
  res.setHeader('Content-Length', stat.size);

  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(req, res);

  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch { /* keep '/' */ }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const handled = await handleApiRequest(req, res, pathname, { includeUpdate: true });
    if (!handled) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: '接口不存在' }));
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const version = readLocalVersion(ROOT);
  console.log('');
  console.log(`  PlanTrace v${version} 已启动`);
  console.log(`  监听地址: http://${HOST}:${PORT}`);
  if (!fs.existsSync(DIST)) {
    console.log('  ⚠ 未找到 dist/，请先执行: npm run build');
  }

  const setupToken = ensureSetupToken();
  if (setupToken) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────┐');
    console.log('  │  首次部署：还没有任何账号                              │');
    console.log('  │  注册第一个（管理员）账号需要初始化令牌：              │');
    console.log(`  │                                                      │`);
    console.log(`  │        初始化令牌:  ${setupToken.padEnd(33)}│`);
    console.log('  │                                                      │');
    console.log('  │  也可通过环境变量 PLANTRACE_SETUP_TOKEN 固定此令牌     │');
    console.log('  └──────────────────────────────────────────────────────┘');
    console.log('');
  }
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
