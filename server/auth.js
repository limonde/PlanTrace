import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, ensureDir, readJson, writeJson } from './db.js';

const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SETUP_TOKEN_FILE = path.join(DATA_DIR, 'setup-token.txt');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const COOKIE_NAME = 'pt_session';

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no external deps)
// ---------------------------------------------------------------------------

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const actual = crypto.scryptSync(password, stored.salt, 64);
  const expected = Buffer.from(stored.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateUsername(username) {
  if (!username || typeof username !== 'string') return '用户名不能为空';
  if (!/^[\w\u4e00-\u9fa5-]{2,20}$/u.test(username.trim())) {
    return '用户名需为 2-20 位中文、字母、数字、下划线或短横线';
  }
  return null;
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6) return '密码至少需要 6 位';
  if (password.length > 100) return '密码过长';
  return null;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function getAllUsers() {
  return readJson(USERS_FILE, []);
}

function saveUsers(users) {
  writeJson(USERS_FILE, users);
}

export function findUserByName(username) {
  if (typeof username !== 'string') return null;
  const name = username.trim().toLowerCase();
  return getAllUsers().find((u) => u.username.toLowerCase() === name) || null;
}

export function findUserById(id) {
  return getAllUsers().find((u) => u.id === id) || null;
}

function generateUserId() {
  return `user_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

export function createUserRecord({ username, password, role = 'user' }) {
  const users = getAllUsers();
  const user = {
    id: generateUserId(),
    username: username.trim(),
    role: role === 'admin' ? 'admin' : 'user',
    password: hashPassword(password),
    createdAt: Date.now(),
    disabled: false,
    legacyMigrated: false,
  };
  users.push(user);
  saveUsers(users);
  return user;
}

/** Public (safe to send to the client) shape of a user. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    disabled: !!user.disabled,
    legacyMigrated: !!user.legacyMigrated,
  };
}

export function setUserFlag(userId, flag, value) {
  const users = getAllUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) return null;
  users[idx][flag] = value;
  saveUsers(users);
  return users[idx];
}

export function updateUserRecord(userId, { password, role, disabled }) {
  const users = getAllUsers();
  const idx = users.findIndex((u) => u.id === userId);
  if (idx === -1) return null;
  const user = users[idx];
  if (typeof password === 'string' && password.length > 0) user.password = hashPassword(password);
  if (role === 'admin' || role === 'user') user.role = role;
  if (typeof disabled === 'boolean') user.disabled = disabled;
  saveUsers(users);
  return user;
}

export function deleteUserRecord(userId) {
  const users = getAllUsers();
  const next = users.filter((u) => u.id !== userId);
  if (next.length === users.length) return false;
  saveUsers(next);
  return true;
}

export function countAdmins() {
  return getAllUsers().filter((u) => u.role === 'admin' && !u.disabled).length;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSettings() {
  return { allowRegistration: true, ...readJson(SETTINGS_FILE, {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJson(SETTINGS_FILE, next);
  return next;
}

// ---------------------------------------------------------------------------
// Sessions (persisted, cookie based)
// ---------------------------------------------------------------------------

function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

function saveSessions(sessions) {
  writeJson(SESSIONS_FILE, sessions);
}

export function createSession(userId) {
  const sessions = loadSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  saveSessions(sessions);
  return token;
}

export function destroySession(token) {
  if (!token) return;
  const sessions = loadSessions();
  if (sessions[token]) {
    delete sessions[token];
    saveSessions(sessions);
  }
}

export function destroyUserSessions(userId) {
  const sessions = loadSessions();
  let changed = false;
  for (const [token, sess] of Object.entries(sessions)) {
    if (sess.userId === userId) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) saveSessions(sessions);
}

export function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

export function getSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

/** Resolve the logged-in user for a request, or null. */
export function getSessionUser(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const sessions = loadSessions();
  const sess = sessions[token];
  if (!sess) return null;
  if (sess.expiresAt < Date.now()) {
    delete sessions[token];
    saveSessions(sessions);
    return null;
  }
  const user = findUserById(sess.userId);
  if (!user || user.disabled) return null;
  return user;
}

export function sessionCookie(token, { secure = false } = {}) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie({ secure = false } = {}) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

// ---------------------------------------------------------------------------
// First-run setup token
// When no account exists yet, creating the first (admin) account requires a
// setup token so a fresh public deployment cannot be claimed by a stranger.
// The token comes from PLANTRACE_SETUP_TOKEN or is generated and written to
// data/setup-token.txt (also printed to the server log).
// ---------------------------------------------------------------------------

export function ensureSetupToken() {
  if (getAllUsers().length > 0) return null;

  ensureDir(DATA_DIR);

  const envToken = String(process.env.PLANTRACE_SETUP_TOKEN || '').trim();
  if (envToken) {
    try { fs.writeFileSync(SETUP_TOKEN_FILE, envToken, 'utf-8'); } catch { /* ignore */ }
    return envToken;
  }

  let token = '';
  try { token = fs.readFileSync(SETUP_TOKEN_FILE, 'utf-8').trim(); } catch { /* not created yet */ }
  if (!token) {
    token = crypto.randomBytes(4).toString('hex');
    try { fs.writeFileSync(SETUP_TOKEN_FILE, token, 'utf-8'); } catch { /* ignore */ }
  }
  return token;
}

export function verifySetupToken(provided) {
  const token = ensureSetupToken();
  if (!token) return true; // already initialized
  if (typeof provided !== 'string' || !provided.trim()) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(provided.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
