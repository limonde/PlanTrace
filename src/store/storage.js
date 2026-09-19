/**
 * storage.js
 * Per-user storage backed by the PlanTrace server (JSON files under data/).
 *
 * The rest of the app keeps using the original synchronous getJSON/setJSON
 * API, but reads/writes hit an in-memory cache that is loaded once after
 * login and flushed to the server (debounced). This keeps every store and
 * component unchanged while isolating data per account.
 *
 * Multi-device safety:
 *  - every collection has a server revision; PUTs carry the revision they
 *    were based on, and the server merges (by id) instead of clobbering
 *    when another device wrote meanwhile
 *  - when the tab regains focus and has nothing pending, stale data is
 *    silently refreshed from the server
 *
 * User collections: tasks, action_logs, atomic_sessions
 * Everything else (theme, show_edge, rollover_dismissed, ...) → prefs object
 */

const STORAGE_PREFIX = 'plantrace_';
const COLLECTION_KEYS = ['tasks', 'action_logs', 'atomic_sessions'];
const FLUSH_DELAY_MS = 500;
const STALE_REFRESH_MS = 60 * 1000;

let memory = createEmptyMemory();
let currentUserId = null;
let revisions = {};
let lastSyncAt = 0;
const generation = { tasks: 0, action_logs: 0, atomic_sessions: 0, prefs: 0 };
const dirty = new Set();
let flushTimer = null;
let flushChain = Promise.resolve();

function createEmptyMemory() {
    return { tasks: [], action_logs: [], atomic_sessions: [], prefs: {} };
}

function isCollection(key) {
    return COLLECTION_KEYS.includes(key);
}

function storageKey(key) {
    return isCollection(key) ? key : 'prefs';
}

// ---------------------------------------------------------------------------
// Lifecycle — called once after login / on logout
// ---------------------------------------------------------------------------

export function initUserData(userId, data = {}) {
    currentUserId = userId;
    memory = {
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        action_logs: Array.isArray(data.action_logs) ? data.action_logs : [],
        atomic_sessions: Array.isArray(data.atomic_sessions) ? data.atomic_sessions : [],
        prefs: data.prefs && typeof data.prefs === 'object' && !Array.isArray(data.prefs) ? data.prefs : {},
    };
    revisions = data.revisions && typeof data.revisions === 'object' ? data.revisions : {};
    for (const key of Object.keys(generation)) generation[key] = 0;
    lastSyncAt = Date.now();
    dirty.clear();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

export function resetUserData() {
    currentUserId = null;
    memory = createEmptyMemory();
    revisions = {};
    lastSyncAt = 0;
    for (const key of Object.keys(generation)) generation[key] = 0;
    dirty.clear();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

export function getStorageUserId() {
    return currentUserId;
}

// ---------------------------------------------------------------------------
// Synchronous get/set used by all stores
// ---------------------------------------------------------------------------

export function getJSON(key) {
    if (isCollection(key)) return memory[key];
    return Object.prototype.hasOwnProperty.call(memory.prefs, key) ? memory.prefs[key] : null;
}

export function setJSON(key, value) {
    if (isCollection(key)) memory[key] = value;
    else memory.prefs[key] = value;
    generation[storageKey(key)] += 1;
    scheduleFlush(storageKey(key));
}

export function removeKey(key) {
    if (isCollection(key)) memory[key] = [];
    else delete memory.prefs[key];
    generation[storageKey(key)] += 1;
    scheduleFlush(storageKey(key));
}

// ---------------------------------------------------------------------------
// Server sync
// ---------------------------------------------------------------------------

function scheduleFlush(collection) {
    if (!currentUserId) return;
    dirty.add(collection);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushUserData();
    }, FLUSH_DELAY_MS);
}

export function flushUserData() {
    flushChain = flushChain.then(doFlush).catch(() => {});
    return flushChain;
}

function dispatchUnauthorized() {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('plantrace:unauthorized'));
}

async function doFlush() {
    if (!currentUserId || dirty.size === 0) return;
    const collections = [...dirty];
    dirty.clear();

    for (const key of collections) {
        const gen = generation[key];
        const value = key === 'prefs' ? memory.prefs : memory[key];
        try {
            const res = await fetch(`/api/data/${key}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value, baseRevision: revisions[key] ?? 0 }),
            });
            if (res.status === 401) { dispatchUnauthorized(); return; }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const result = await res.json();
            if (result.revision != null) revisions[key] = result.revision;
            if (result.merged) {
                // The server merged our write with another device's changes.
                if (generation[key] !== gen) {
                    dirty.add(key); // local edits happened meanwhile — push again
                } else if (result.value !== undefined) {
                    if (key === 'prefs') memory.prefs = result.value;
                    else memory[key] = result.value;
                }
            }
            lastSyncAt = Date.now();
        } catch {
            dirty.add(key); // keep for the next flush
        }
    }
}

/**
 * Best-effort synchronous flush used when the page is being hidden/closed.
 * sendBeacon survives navigation; the server accepts POST for collections too.
 */
export function flushUserDataSync() {
    if (!currentUserId || dirty.size === 0) return;
    const collections = [...dirty];
    dirty.clear();
    for (const key of collections) {
        const value = key === 'prefs' ? memory.prefs : memory[key];
        const payload = new Blob(
            [JSON.stringify({ value, baseRevision: revisions[key] ?? 0 })],
            { type: 'application/json' },
        );
        const ok = typeof navigator !== 'undefined' && navigator.sendBeacon
            ? navigator.sendBeacon(`/api/data/${key}`, payload)
            : false;
        if (!ok) dirty.add(key);
    }
}

/**
 * Refresh all collections from the server when this tab was idle for a while
 * (e.g. the user edited the same account on their phone). Skipped whenever
 * local changes are pending.
 */
export async function refreshUserDataIfStale(maxAgeMs = STALE_REFRESH_MS) {
    if (!currentUserId || dirty.size > 0 || flushTimer) return false;
    if (Date.now() - lastSyncAt < maxAgeMs) return false;

    const userId = currentUserId;
    try {
        const res = await fetch('/api/data', { credentials: 'same-origin' });
        if (res.status === 401) { dispatchUnauthorized(); return false; }
        if (!res.ok) return false;
        const data = await res.json();
        if (currentUserId !== userId || dirty.size > 0) return false;
        initUserData(userId, data);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new Event('plantrace:data-refreshed'));
        }
        return true;
    } catch {
        return false;
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushUserDataSync);
    window.addEventListener('focus', () => { refreshUserDataIfStale(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushUserDataSync();
        else refreshUserDataIfStale();
    });
}

// ---------------------------------------------------------------------------
// Legacy localStorage reading (one-time migration to the first admin account)
// ---------------------------------------------------------------------------

function readLegacyKey(key) {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function readLegacyLocalData() {
    const prefs = {};
    for (const key of ['rollover_dismissed', 'show_edge', 'theme']) {
        const value = readLegacyKey(key);
        if (value !== null) prefs[key] = value;
    }
    return {
        tasks: readLegacyKey('tasks') || [],
        action_logs: readLegacyKey('action_logs') || [],
        atomic_sessions: readLegacyKey('atomic_sessions') || [],
        prefs,
    };
}

export function hasLegacyLocalData(data) {
    if (!data) return false;
    return (
        (data.tasks?.length || 0) > 0 ||
        (data.action_logs?.length || 0) > 0 ||
        (data.atomic_sessions?.length || 0) > 0 ||
        Object.keys(data.prefs || {}).length > 0
    );
}

// ---------------------------------------------------------------------------
// Backup export — the server writes to backups/<username>/
// ---------------------------------------------------------------------------

function beijingDateStr() {
    const now = new Date();
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    const bj = new Date(utcMs + 8 * 60 * 60000);
    const y = bj.getFullYear();
    const m = String(bj.getMonth() + 1).padStart(2, '0');
    const d = String(bj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export async function exportBackup() {
    const payload = {
        tasks: memory.tasks,
        actionLogs: memory.action_logs,
        atomicSessions: memory.atomic_sessions,
        exportedAt: new Date().toISOString(),
    };
    const filename = `plantrace_backup_${beijingDateStr()}.json`;
    const jsonStr = JSON.stringify(payload, null, 2);

    try {
        const res = await fetch('/api/backup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: jsonStr }),
        });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.error || `HTTP ${res.status}`);
        alert(`✅ Backup saved to:\n${result.path}`);
    } catch {
        // Fallback: browser download
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
