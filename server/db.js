import fs from 'fs';
import path from 'path';

// Server-side data root. Created on first use; excluded from git.
export const DATA_DIR = path.resolve('data');
export const BACKUP_DIR = path.resolve('backups');
const USERS_DIR = path.join(DATA_DIR, 'users');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Read a JSON file, returning `fallback` when missing or corrupt. */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (tmp file + rename) so a crash never leaves a half-written file. */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function userDataDir(userId) {
  return path.join(USERS_DIR, userId);
}

export function readUserFile(userId, name, fallback) {
  return readJson(path.join(userDataFile(userId, name)), fallback);
}

export function writeUserFile(userId, name, value) {
  writeJson(userDataFile(userId, name), value);
}

export function userDataFile(userId, name) {
  return path.join(userDataDir(userId), `${name}.json`);
}

export function removeUserDir(userId) {
  fs.rmSync(userDataDir(userId), { recursive: true, force: true });
}
