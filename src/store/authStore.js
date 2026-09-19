/**
 * authStore.js
 * Client for the PlanTrace account API + per-user data bootstrap.
 */

import {
    initUserData,
    resetUserData,
    readLegacyLocalData,
    hasLegacyLocalData,
    flushUserData,
} from './storage.js';
import { clearActiveSessionSS } from './atomicStore.js';

async function request(path, { method = 'GET', body } = {}) {
    const res = await fetch(`/api${path}`, {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
        const err = new Error(data?.error || `请求失败 (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return data || {};
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const fetchAuthConfig = () => request('/auth/config');
export const fetchMe = async () => (await request('/auth/me')).user;
export const login = (username, password) => request('/auth/login', { method: 'POST', body: { username, password } });
export const register = (username, password, setupToken) => request('/auth/register', { method: 'POST', body: { username, password, setupToken } });
export const logout = () => request('/auth/logout', { method: 'POST' });

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const listUsers = async () => (await request('/auth/users')).users;
export const createUser = (payload) => request('/auth/users', { method: 'POST', body: payload });
export const updateUser = (id, payload) => request(`/auth/users/${id}`, { method: 'PATCH', body: payload });
export const deleteUser = (id) => request(`/auth/users/${id}`, { method: 'DELETE' });
export const saveAuthConfig = (allowRegistration) => request('/auth/config', { method: 'PUT', body: { allowRegistration } });

// ---------------------------------------------------------------------------
// Per-user data bootstrap
// ---------------------------------------------------------------------------

export async function loadUserData(userId) {
    const data = await request('/data');
    initUserData(userId, data);
}

/**
 * Load the user's data and migrate legacy localStorage data into the very
 * first (admin) account, exactly once.
 */
export async function bootstrapUser(user) {
    await loadUserData(user.id);

    if (user.role === 'admin' && user.legacyMigrated === false) {
        const legacy = readLegacyLocalData();
        const payload = hasLegacyLocalData(legacy)
            ? legacy
            : { tasks: [], action_logs: [], atomic_sessions: [], prefs: {} };
        await request('/data/legacy-import', { method: 'POST', body: payload });
        await loadUserData(user.id);
        user = { ...user, legacyMigrated: true };
    }

    return user;
}

export async function doLogout() {
    try {
        await flushUserData();
        await logout();
    } finally {
        resetUserData();
        clearActiveSessionSS();
    }
}
