import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BACKUP_DIR,
  ensureDir,
  readUserFile,
  writeUserFile,
  removeUserDir,
} from './db.js';
import {
  countAdmins,
  createSession,
  createUserRecord,
  deleteUserRecord,
  destroySession,
  destroyUserSessions,
  ensureSetupToken,
  findUserByName,
  findUserById,
  getAllUsers,
  getSessionToken,
  getSessionUser,
  getSettings,
  publicUser,
  saveSettings,
  sessionCookie,
  clearSessionCookie,
  setUserFlag,
  updateUserRecord,
  validatePassword,
  validateUsername,
  verifyPassword,
  verifySetupToken,
} from './auth.js';
import { clientIp, isLoopback, rateLimit } from './rateLimit.js';
import {
  fetchRemoteVersionManifest,
  readLocalVersion,
  runSelfUpdate,
  selfUpdateCapable,
} from './update.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COLLECTIONS = {
  tasks: 'array',
  action_logs: 'array',
  atomic_sessions: 'array',
  prefs: 'object',
};

const BODY_LIMIT = 20 * 1024 * 1024; // 20 MB per request
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 15;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;
const REGISTER_MAX_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

/** HTTPS detection behind a reverse proxy. */
function isSecureRequest(req) {
  if (process.env.PLANTRACE_SECURE_COOKIE === '1') return true;
  if (process.env.PLANTRACE_TRUST_PROXY === '1') {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto) return proto === 'https';
  }
  return false;
}

function currentUser(req) {
  return getSessionUser(req);
}

function requireAdmin(req, res) {
  const user = currentUser(req);
  if (!user) {
    sendJson(res, 401, { error: '未登录' });
    return null;
  }
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: '仅管理员可执行此操作' });
    return null;
  }
  return user;
}

function userStats(userId) {
  const tasks = readUserFile(userId, 'tasks', []);
  const logs = readUserFile(userId, 'action_logs', []);
  const sessions = readUserFile(userId, 'atomic_sessions', []);
  return {
    tasks: Array.isArray(tasks) ? tasks.length : 0,
    logs: Array.isArray(logs) ? logs.length : 0,
    sessions: Array.isArray(sessions) ? sessions.length : 0,
  };
}

function beijingDateStr() {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const bj = new Date(utcMs + 8 * 60 * 60000);
  const y = bj.getFullYear();
  const m = String(bj.getMonth() + 1).padStart(2, '0');
  const d = String(bj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Multi-device merge (per-account optimistic concurrency)
// Arrays are merged by id (client wins for the same id, server keeps the rest);
// objects (prefs) are shallow-merged with client precedence.
// ---------------------------------------------------------------------------

function entryId(item) {
  if (!item || typeof item !== 'object') return null;
  return item.id ?? item.log_id ?? item.session_id ?? null;
}

function mergeArrays(serverValue, clientValue) {
  const server = Array.isArray(serverValue) ? serverValue : [];
  const client = Array.isArray(clientValue) ? clientValue : [];
  const indexById = new Map();
  const result = [];

  for (const item of server) {
    const id = entryId(item);
    if (id != null && !indexById.has(id)) indexById.set(id, result.length);
    result.push(item);
  }
  for (const item of client) {
    const id = entryId(item);
    const idx = id != null ? indexById.get(id) : undefined;
    if (idx !== undefined) {
      result[idx] = item;
    } else {
      if (id != null) indexById.set(id, result.length);
      result.push(item);
    }
  }
  return result;
}

function readRevisions(userId) {
  const revs = readUserFile(userId, 'revisions', {});
  return revs && typeof revs === 'object' ? revs : {};
}

// ---------------------------------------------------------------------------
// Auth routes — /api/auth/*
// ---------------------------------------------------------------------------

async function handleAuth(req, res, pathname) {
  const method = req.method;

  // ── GET /api/auth/config — public ───────────────────────────────────────
  if (pathname === '/api/auth/config' && method === 'GET') {
    const settings = getSettings();
    const hasUsers = getAllUsers().length > 0;
    sendJson(res, 200, {
      allowRegistration: settings.allowRegistration,
      hasUsers,
      setupRequired: !hasUsers,
    });
    return;
  }

  // ── GET /api/auth/me ────────────────────────────────────────────────────
  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = currentUser(req);
    if (!user) { sendJson(res, 401, { error: '未登录' }); return; }
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  // ── POST /api/auth/register ─────────────────────────────────────────────
  if (pathname === '/api/auth/register' && method === 'POST') {
    const rl = rateLimit(`register:${clientIp(req)}`, { limit: REGISTER_MAX_ATTEMPTS, windowMs: REGISTER_WINDOW_MS });
    if (!rl.allowed) {
      sendJson(res, 429, { error: `操作过于频繁，请 ${Math.ceil(rl.retryAfterSec / 60)} 分钟后再试` });
      return;
    }

    const { username, password, setupToken } = await readBody(req);
    const users = getAllUsers();
    const isFirstUser = users.length === 0;

    if (isFirstUser && !isLoopback(req) && !verifySetupToken(setupToken)) {
      sendJson(res, 403, { error: '首次部署需要初始化令牌，请在服务器日志或 data/setup-token.txt 中查看' });
      return;
    }
    if (!isFirstUser && !getSettings().allowRegistration) {
      sendJson(res, 403, { error: '当前未开放注册，请联系管理员创建账号' });
      return;
    }
    const invalid = validateUsername(username) || validatePassword(password);
    if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    if (findUserByName(username)) { sendJson(res, 409, { error: '用户名已被占用' }); return; }

    const user = createUserRecord({ username, password, role: isFirstUser ? 'admin' : 'user' });
    const token = createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecureRequest(req) }));
    sendJson(res, 201, { user: publicUser(user), firstUser: isFirstUser });
    return;
  }

  // ── POST /api/auth/login ────────────────────────────────────────────────
  if (pathname === '/api/auth/login' && method === 'POST') {
    const rl = rateLimit(`login:${clientIp(req)}`, { limit: LOGIN_MAX_ATTEMPTS, windowMs: LOGIN_WINDOW_MS });
    if (!rl.allowed) {
      sendJson(res, 429, { error: `尝试次数过多，请 ${Math.ceil(rl.retryAfterSec / 60)} 分钟后再试` });
      return;
    }

    const { username, password } = await readBody(req);
    const user = findUserByName(username);
    if (!user || !verifyPassword(String(password ?? ''), user.password)) {
      sendJson(res, 401, { error: '用户名或密码错误' });
      return;
    }
    if (user.disabled) { sendJson(res, 403, { error: '该账号已被禁用' }); return; }
    const token = createSession(user.id);
    res.setHeader('Set-Cookie', sessionCookie(token, { secure: isSecureRequest(req) }));
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  // ── POST /api/auth/logout ───────────────────────────────────────────────
  if (pathname === '/api/auth/logout' && method === 'POST') {
    destroySession(getSessionToken(req));
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: isSecureRequest(req) }));
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── GET /api/auth/users — admin ─────────────────────────────────────────
  if (pathname === '/api/auth/users' && method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const users = getAllUsers().map((u) => ({ ...publicUser(u), stats: userStats(u.id) }));
    sendJson(res, 200, { users });
    return;
  }

  // ── POST /api/auth/users — admin creates an account ─────────────────────
  if (pathname === '/api/auth/users' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const { username, password, role } = await readBody(req);
    const invalid = validateUsername(username) || validatePassword(password);
    if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    if (findUserByName(username)) { sendJson(res, 409, { error: '用户名已被占用' }); return; }
    const user = createUserRecord({ username, password, role });
    sendJson(res, 201, { user: publicUser(user) });
    return;
  }

  // ── PATCH /api/auth/users/:id — admin ───────────────────────────────────
  const patchMatch = pathname.match(/^\/api\/auth\/users\/([^/]+)$/);
  if (patchMatch && method === 'PATCH') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const targetId = patchMatch[1];
    const target = findUserById(targetId);
    if (!target) { sendJson(res, 404, { error: '用户不存在' }); return; }
    const body = await readBody(req);
    if (target.id === admin.id) {
      if (body.disabled === true) { sendJson(res, 400, { error: '不能禁用当前登录的管理员账号' }); return; }
      if (body.role && body.role !== admin.role) { sendJson(res, 400, { error: '不能修改自己的角色' }); return; }
    }
    if (body.password !== undefined) {
      const invalid = validatePassword(body.password);
      if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    }
    const demoting = body.role === 'user' && target.role === 'admin';
    const disabling = body.disabled === true && !target.disabled;
    if ((demoting || disabling) && target.role === 'admin' && countAdmins() <= 1) {
      sendJson(res, 400, { error: '至少需要保留一名可用的管理员账号' });
      return;
    }
    const updated = updateUserRecord(targetId, body);
    if (body.password !== undefined || disabling) destroyUserSessions(targetId);
    sendJson(res, 200, { user: publicUser(updated) });
    return;
  }

  // ── DELETE /api/auth/users/:id — admin ──────────────────────────────────
  const deleteMatch = pathname.match(/^\/api\/auth\/users\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const target = findUserById(deleteMatch[1]);
    if (!target) { sendJson(res, 404, { error: '用户不存在' }); return; }
    if (target.id === admin.id) { sendJson(res, 400, { error: '不能删除当前登录的账号' }); return; }
    if (target.role === 'admin' && countAdmins() <= 1) {
      sendJson(res, 400, { error: '至少需要保留一名可用的管理员账号' });
      return;
    }
    deleteUserRecord(target.id);
    destroyUserSessions(target.id);
    removeUserDir(target.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  // ── PUT /api/auth/config — admin toggles open registration ──────────────
  if (pathname === '/api/auth/config' && method === 'PUT') {
    if (!requireAdmin(req, res)) return;
    const { allowRegistration } = await readBody(req);
    if (typeof allowRegistration !== 'boolean') {
      sendJson(res, 400, { error: 'allowRegistration 必须是布尔值' });
      return;
    }
    const settings = saveSettings({ allowRegistration });
    sendJson(res, 200, { allowRegistration: settings.allowRegistration });
    return;
  }

  sendJson(res, 404, { error: '接口不存在' });
}

// ---------------------------------------------------------------------------
// User data routes — /api/data/*
// ---------------------------------------------------------------------------

async function handleData(req, res, pathname) {
  const method = req.method;
  const user = currentUser(req);
  if (!user) { sendJson(res, 401, { error: '未登录' }); return; }

  // ── GET /api/data — everything for the logged-in user ──────────────────
  if (pathname === '/api/data' && method === 'GET') {
    sendJson(res, 200, {
      tasks: readUserFile(user.id, 'tasks', []),
      action_logs: readUserFile(user.id, 'action_logs', []),
      atomic_sessions: readUserFile(user.id, 'atomic_sessions', []),
      prefs: readUserFile(user.id, 'prefs', {}),
      revisions: readRevisions(user.id),
    });
    return;
  }

  // ── POST /api/data/legacy-import — one-time localStorage migration ──────
  if (pathname === '/api/data/legacy-import' && method === 'POST') {
    if (user.role !== 'admin') { sendJson(res, 403, { error: '仅管理员可导入旧数据' }); return; }
    if (user.legacyMigrated) { sendJson(res, 200, { ok: true, skipped: true }); return; }

    // Safety: never overwrite data the account already has.
    const hasExistingData = ['tasks', 'action_logs', 'atomic_sessions'].some((name) => {
      const value = readUserFile(user.id, name, []);
      return Array.isArray(value) && value.length > 0;
    });
    if (hasExistingData) {
      setUserFlag(user.id, 'legacyMigrated', true);
      sendJson(res, 200, { ok: true, skipped: true, reason: '账号已有数据，跳过导入' });
      return;
    }

    const body = await readBody(req);
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    const logs = Array.isArray(body.action_logs) ? body.action_logs : [];
    const sessions = Array.isArray(body.atomic_sessions) ? body.atomic_sessions : [];
    const prefs = body.prefs && typeof body.prefs === 'object' && !Array.isArray(body.prefs) ? body.prefs : {};
    writeUserFile(user.id, 'tasks', tasks);
    writeUserFile(user.id, 'action_logs', logs);
    writeUserFile(user.id, 'atomic_sessions', sessions);
    writeUserFile(user.id, 'prefs', prefs);
    setUserFlag(user.id, 'legacyMigrated', true);
    sendJson(res, 200, { ok: true, imported: { tasks: tasks.length, logs: logs.length, sessions: sessions.length } });
    return;
  }

  // ── PUT/POST /api/data/:collection — replace/merge one collection ───────
  const collectionMatch = pathname.match(/^\/api\/data\/([^/]+)$/);
  if (collectionMatch && (method === 'PUT' || method === 'POST')) {
    const name = collectionMatch[1];
    const kind = COLLECTIONS[name];
    if (!kind) { sendJson(res, 404, { error: '未知的数据集合' }); return; }
    const body = await readBody(req);
    const value = body.value;
    if (kind === 'array' && !Array.isArray(value)) {
      sendJson(res, 400, { error: `${name} 必须是数组` });
      return;
    }
    if (kind === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
      sendJson(res, 400, { error: `${name} 必须是对象` });
      return;
    }

    const revisions = readRevisions(user.id);
    const currentRevision = Number(revisions[name]) || 0;
    const baseRevision = body.baseRevision !== undefined ? Number(body.baseRevision) : undefined;

    let finalValue = value;
    let merged = false;
    if (baseRevision !== undefined && baseRevision !== currentRevision) {
      // Another device wrote this collection meanwhile — merge instead of clobber.
      const existing = readUserFile(user.id, name, kind === 'array' ? [] : {});
      finalValue = kind === 'array'
        ? mergeArrays(existing, value)
        : { ...(existing && typeof existing === 'object' ? existing : {}), ...value };
      merged = true;
    }

    writeUserFile(user.id, name, finalValue);
    revisions[name] = Date.now();
    writeUserFile(user.id, 'revisions', revisions);
    sendJson(res, 200, {
      ok: true,
      collection: name,
      revision: revisions[name],
      merged,
      value: merged ? finalValue : undefined,
    });
    return;
  }

  sendJson(res, 404, { error: '接口不存在' });
}

// ---------------------------------------------------------------------------
// Backup route — /api/backup (per-user folder, filename built server-side)
// ---------------------------------------------------------------------------

async function handleBackup(req, res, pathname) {
  if (pathname !== '/api/backup') { sendJson(res, 404, { error: '接口不存在' }); return; }
  const user = currentUser(req);
  if (!user) { sendJson(res, 401, { error: '未登录' }); return; }
  if (req.method !== 'POST') { sendJson(res, 405, { error: 'Method not allowed' }); return; }

  const { data } = await readBody(req);
  if (typeof data !== 'string' || !data) { sendJson(res, 400, { error: '备份内容为空' }); return; }

  const safeName = user.username.replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  const dir = path.join(BACKUP_DIR, safeName);
  ensureDir(dir);
  const filename = `plantrace_backup_${beijingDateStr()}.json`;
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, data, 'utf-8');
  sendJson(res, 200, { success: true, path: filePath });
}

// ---------------------------------------------------------------------------
// Update routes — /api/update/* (production server; dev uses the Vite plugin)
// ---------------------------------------------------------------------------

async function handleUpdate(req, res, pathname) {
  const method = req.method;

  if (pathname === '/api/update/version' && method === 'GET') {
    sendJson(res, 200, { version: readLocalVersion(PROJECT_ROOT) });
    return;
  }

  if (pathname === '/api/update/check' && method === 'GET') {
    try {
      const manifest = await fetchRemoteVersionManifest();
      sendJson(res, 200, {
        ...manifest,
        selfUpdate: selfUpdateCapable(PROJECT_ROOT),
      });
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/update/apply' && method === 'POST') {
    const user = currentUser(req);
    if (!user) { sendJson(res, 401, { error: '未登录' }); return; }
    if (user.role !== 'admin') { sendJson(res, 403, { error: '仅管理员可执行更新' }); return; }

    // SSE stream
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (payload) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* closed */ }
    };

    if (!selfUpdateCapable(PROJECT_ROOT)) {
      send({
        type: 'error',
        message: '当前部署未启用应用内更新。请在服务器上执行更新命令（git pull && npm install && npm run build）或重新部署 Docker 镜像。',
      });
      res.end();
      return;
    }

    send({ type: 'progress', message: `操作者: ${user.username}` });
    try {
      await runSelfUpdate(PROJECT_ROOT, send);
    } catch (err) {
      send({ type: 'error', message: `更新失败：${err.message}` });
    }
    res.end();
    return;
  }

  sendJson(res, 404, { error: '接口不存在' });
}

// ---------------------------------------------------------------------------
// Entry point used by both the Vite dev middleware and server/index.js
// ---------------------------------------------------------------------------

export async function handleApiRequest(req, res, pathname, options = {}) {
  const { includeUpdate = true } = options;
  try {
    if (pathname === '/api/health') {
      sendJson(res, 200, { ok: true, version: readLocalVersion(PROJECT_ROOT), time: Date.now() });
      return true;
    }
    if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
      await handleAuth(req, res, pathname);
      return true;
    }
    if (pathname === '/api/data' || pathname.startsWith('/api/data/')) {
      await handleData(req, res, pathname);
      return true;
    }
    if (pathname === '/api/backup' || pathname.startsWith('/api/backup/')) {
      await handleBackup(req, res, pathname);
      return true;
    }
    if (pathname.startsWith('/api/update')) {
      if (!includeUpdate) return false; // let the Vite dev plugin handle it
      await handleUpdate(req, res, pathname);
      return true;
    }
    return false;
  } catch (err) {
    sendJson(res, 400, { error: err.message || '请求处理失败' });
    return true;
  }
}

export { ensureSetupToken };
