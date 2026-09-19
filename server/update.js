import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Remote version manifest (shared by the dev plugin and the production server)
// ---------------------------------------------------------------------------

/** Follow HTTP/HTTPS redirects and read a URL as text. */
export function getText(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const fetch = (u) => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': 'PlanTrace-Updater/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetch(new URL(res.headers.location, u).toString());
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} while reading ${u}`));
          return;
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout while reading ${u}`)));
      req.on('error', reject);
    };
    fetch(url);
  });
}

export async function fetchRemoteVersionManifest() {
  const cacheBust = `t=${Date.now()}`;
  const sources = [
    {
      kind: 'json',
      url: `https://raw.githubusercontent.com/EmoLorry/PlanTrace/main/public/version.json?${cacheBust}`,
    },
    {
      kind: 'json',
      url: `https://cdn.jsdelivr.net/gh/EmoLorry/PlanTrace@main/public/version.json?${cacheBust}`,
    },
    {
      kind: 'github-content',
      url: `https://api.github.com/repos/EmoLorry/PlanTrace/contents/public/version.json?ref=main&${cacheBust}`,
    },
  ];

  const errors = [];
  for (const source of sources) {
    try {
      const text = await getText(source.url);
      if (source.kind === 'github-content') {
        const payload = JSON.parse(text);
        const content = String(payload.content || '').replace(/\s/g, '');
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        return JSON.parse(decoded);
      }
      return JSON.parse(text);
    } catch (err) {
      errors.push(`${source.kind}: ${err.message}`);
    }
  }

  throw new Error(`Could not fetch remote version manifest. ${errors.join(' | ')}`);
}

export function readLocalVersion(projectDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// Production self-update (opt-in)
// Only available when the deployment is a git checkout and
// PLANTRACE_SELF_UPDATE=1. The Docker image intentionally disables this and
// updates by pulling a new image instead.
// ---------------------------------------------------------------------------

export function selfUpdateCapable(projectDir) {
  return process.env.PLANTRACE_SELF_UPDATE === '1'
    && fs.existsSync(path.join(projectDir, '.git'));
}

function runCommand(cmd, args, cwd, send) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false });
    const relay = (data) => {
      const text = data.toString();
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) send({ type: 'progress', message: trimmed });
      }
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`));
    });
    child.on('error', reject);
  });
}

export async function runSelfUpdate(projectDir, send) {
  send({ type: 'step', step: 1, message: '正在拉取最新代码（git pull）...' });
  await runCommand('git', ['pull', '--ff-only'], projectDir, send);

  send({ type: 'step', step: 2, message: '正在安装依赖（npm install）...' });
  await runCommand('npm', ['install', '--no-audit', '--no-fund', '--loglevel=warn'], projectDir, send);

  send({ type: 'step', step: 3, message: '正在构建前端（npm run build）...' });
  await runCommand('npm', ['run', 'build'], projectDir, send);

  send({ type: 'done', message: '更新完成！静态资源已重新构建，刷新页面即可使用。' });
}
