import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'
import os from 'os'
import https from 'https'
import http from 'http'
import { execSync, spawn } from 'child_process'
import process from 'node:process'
import { apiPlugin } from './server/apiPlugin.js'
import { getSessionUser, publicUser } from './server/auth.js'
import { fetchRemoteVersionManifest } from './server/update.js'

// ---------------------------------------------------------------------------
// Plugin: auto-update endpoint
// GET  /api/update/version  → current local package.json version
// POST /api/update/apply    → download + extract + npm install (SSE stream)
// ---------------------------------------------------------------------------

/** Recursively copy a directory, skipping nothing. */
function copyDir(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Follow HTTP/HTTPS redirects and download to destPath. */
function downloadFile(url, destPath, { timeoutMs = 120000, idleTimeoutMs = 30000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let file = null;
    let settled = false;
    let downloaded = 0;
    let lastReportedMb = 0;
    let req = null;
    let idleTimer = null;
    const startedAt = Date.now();

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (req) req.destroy();
      if (file) file.destroy();
      try { if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true }); } catch { /* ignore */ }
      reject(err);
    };

    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const resetIdleTimer = (currentUrl) => {
      cleanup();
      idleTimer = setTimeout(() => {
        fail(new Error(`No download data for ${Math.round(idleTimeoutMs / 1000)}s from ${currentUrl}`));
      }, idleTimeoutMs);
    };

    const fetch = (u) => {
      const mod = u.startsWith('https') ? https : http;
      req = mod.get(u, { headers: { 'User-Agent': 'PlanTrace-Updater/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          cleanup();
          fetch(new URL(res.headers.location, u).toString());
          return;
        }
        if (res.statusCode !== 200) {
          fail(new Error(`HTTP ${res.statusCode} while downloading ${u}`));
          return;
        }
        file = fs.createWriteStream(destPath);
        resetIdleTimer(u);
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          resetIdleTimer(u);
          const downloadedMb = Math.floor(downloaded / 1024 / 1024);
          if (downloadedMb >= lastReportedMb + 3) {
            lastReportedMb = downloadedMb;
            onProgress?.(`${downloadedMb} MB downloaded...`);
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(done));
        file.on('error', fail);
      }).on('error', fail);
      req.setTimeout(timeoutMs, () => {
        fail(new Error(`Download timed out after ${Math.round((Date.now() - startedAt) / 1000)}s from ${u}`));
      });
    };
    fetch(url);
  });
}

async function downloadFirstAvailable(urls, destPath, send) {
  const errors = [];
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    try {
      if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
      send?.({ type: 'progress', message: `下载通道 ${i + 1}/${urls.length}: ${url}` });
      await downloadFile(url, destPath, {
        onProgress: (message) => send?.({ type: 'progress', message }),
      });
      return url;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      send?.({ type: 'progress', message: `该下载通道无响应，正在切换备用通道... (${err.message})` });
    }
  }
  throw new Error(`All download mirrors failed. ${errors.join(' | ')}`);
}

/** Run npm install, streaming stdout/stderr lines back via send(). */
function runNpmInstall(cwd, send) {
  return new Promise((resolve, reject) => {
    const npm = spawn(process.env.ComSpec || 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      'npm.cmd',
      'install',
      '--prefer-offline',
      '--loglevel',
      'warn',
    ], {
      cwd,
      windowsHide: true,
    });
    npm.stdout.on('data', (d) => {
      const line = d.toString().trim();
      if (line) send({ type: 'progress', message: line });
    });
    npm.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) send({ type: 'progress', message: line });
    });
    npm.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed with exit code ${code}`));
    });
    npm.on('error', reject);
  });
}

function updatePlugin() {
  return {
    name: 'plantrace-update',
    configureServer(server) {

      // GET /api/update/version — return local version
      server.middlewares.use('/api/update/version', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
          const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf-8'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ version: pkg.version || '0.0.0' }));
        } catch {
          res.statusCode = 500; res.end('{}');
        }
      });

      // POST /api/update/apply — stream update progress
      server.middlewares.use('/api/update/check', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
          const manifest = await fetchRemoteVersionManifest();
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(manifest));
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      server.middlewares.use('/api/update/apply', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }

        // Only administrators may update the shared installation.
        const user = getSessionUser(req);
        if (!user || user.role !== 'admin') {
          res.statusCode = user ? 403 : 401;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: user ? '仅管理员可执行更新' : '未登录' }));
          return;
        }
        const operator = publicUser(user);

        // SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Helper: send a structured SSE message
        const send = (payload) => {
          try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* closed */ }
        };

        send({ type: 'progress', message: `操作者: ${operator.username}` });

        const projectDir = path.resolve('.');
        const tmpDir = path.join(os.tmpdir(), `plantrace-update-${Date.now()}`);
        const zipPath = path.join(tmpDir, 'update.zip');
        const extractDir = path.join(tmpDir, 'extracted');

        try {
          fs.mkdirSync(tmpDir, { recursive: true });
          fs.mkdirSync(extractDir, { recursive: true });

          // ── Step 1: Download ZIP ──
          send({ type: 'step', step: 1, message: '正在从 GitHub 下载最新版本...' });
          const ZIP_URLS = [
            'https://codeload.github.com/limonde/PlanTrace/zip/refs/heads/main',
            'https://github.com/limonde/PlanTrace/archive/refs/heads/main.zip',
          ];
          const usedZipUrl = await downloadFirstAvailable(ZIP_URLS, zipPath, send);
          send({ type: 'progress', message: `下载通道: ${usedZipUrl}` });
          send({ type: 'progress', message: '下载完成 ✓' });

          // ── Step 2: Extract ──
          send({ type: 'step', step: 2, message: '正在解压...' });
          execSync(
            `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
            { timeout: 60000 }
          );
          send({ type: 'progress', message: '解压完成 ✓' });

          // Find the inner folder (PlanTrace-main)
          const innerFolders = fs.readdirSync(extractDir);
          if (!innerFolders.length) throw new Error('解压后找不到源码文件夹');
          const sourceRoot = path.join(extractDir, innerFolders[0]);

          // ── Step 3: Apply files (safe list only) ──
          send({ type: 'step', step: 3, message: '正在应用更新（不会覆盖用户数据）...' });

          // Directories to replace entirely
          const DIRS = ['src', 'public', 'server'];
          for (const dir of DIRS) {
            const src = path.join(sourceRoot, dir);
            const dest = path.join(projectDir, dir);
            if (fs.existsSync(src)) {
              // Remove old dir then copy fresh
              if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
              copyDir(src, dest);
              send({ type: 'progress', message: `已更新 ${dir}/ ✓` });
            }
          }

          // Directories to merge, not replace. This keeps locally-added helper files.
          const MERGE_DIRS = ['scripts', 'deploy'];
          for (const dir of MERGE_DIRS) {
            const src = path.join(sourceRoot, dir);
            const dest = path.join(projectDir, dir);
            if (fs.existsSync(src)) {
              copyDir(src, dest);
              send({ type: 'progress', message: `已更新 ${dir}/ ✓` });
            }
          }

          // Individual files to update (never touch: backups/, data/)
          const FILES = [
            'index.html',
            'package.json',
            'package-lock.json',
            'eslint.config.js',
            'vite.config.js',
            'install.bat',
            'start.bat',
            'Install-PlanTrace-From-GitHub.bat',
            'Update-PlanTrace.bat',
            'README.md',
            'DEPLOY.md',
            'DEPLOY-CLOUD.md',
            'Dockerfile',
            'docker-compose.yml',
            '.dockerignore',
            '.env.example',
            'LICENSE',
            '.gitignore',
          ];
          for (const file of FILES) {
            const src = path.join(sourceRoot, file);
            const dest = path.join(projectDir, file);
            if (fs.existsSync(src)) {
              fs.copyFileSync(src, dest);
              send({ type: 'progress', message: `已更新 ${file} ✓` });
            }
          }

          // ── Step 4: npm install ──
          send({ type: 'step', step: 4, message: '正在安装/更新依赖（约1-3分钟）...' });
          await runNpmInstall(projectDir, send);
          send({ type: 'progress', message: '依赖安装完成 ✓' });

          // ── Step 5: Cleanup ──
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

          send({ type: 'done', message: '更新完成！Vite 将自动热重载，若无变化请手动刷新。' });
          res.end();

        } catch (err) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
          send({ type: 'error', message: `更新失败：${err.message}` });
          res.end();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Vite config
// ---------------------------------------------------------------------------
export default defineConfig({
  server: {
    host: 'localhost',   // always bind to localhost, never 127.0.0.1
    port: 5173,
    open: 'http://localhost:5173',
  },
  plugins: [react(), tailwindcss(), apiPlugin(), updatePlugin()],
})
