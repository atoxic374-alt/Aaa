/**
 * userScope.js — implicit per-user context using AsyncLocalStorage.
 *
 * Lets us namespace the global runtime state (clients pool, active client,
 * per-user JsonStore files) without rewriting every call site. The current
 * userId flows through async/await automatically.
 */
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const fs = require('fs');
const { getStore } = require('./jsonStore');

const ctx = new AsyncLocalStorage();
const SYSTEM_UID = '__system__';

function runWithUser(userId, fn) {
  return ctx.run({ userId: userId || SYSTEM_UID }, fn);
}

function currentUserId() {
  const s = ctx.getStore();
  return s?.userId || SYSTEM_UID;
}

function withUser(userId, fn) {
  return ctx.run({ userId: userId || SYSTEM_UID }, fn);
}

// ── Per-user data root ──────────────────────────────────────────────
const ROOT = path.join(__dirname, '..', 'data', 'users');
function userDir(userId) {
  const safe = String(userId || SYSTEM_UID).replace(/[^a-zA-Z0-9_-]/g, '_');
  const d = path.join(ROOT, safe);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function currentUserDir() { return userDir(currentUserId()); }
function userFile(name) { return path.join(currentUserDir(), name); }

/**
 * scopedStore(filename, defaults) — returns a JsonStore-like wrapper
 * that resolves to the current user's file each call. Read/write/touch
 * delegate to the right per-user JsonStore based on AsyncLocalStorage
 * context. Falls back to a "system" store outside any request.
 */
function scopedStore(filename, defaults) {
  const cache = new Map(); // userId -> JsonStore instance
  function pick() {
    const uid = currentUserId();
    if (!cache.has(uid)) {
      cache.set(uid, getStore(path.join(userDir(uid), filename), defaults));
    }
    return cache.get(uid);
  }
  return {
    read() { return pick().read(); },
    write(v) { return pick().write(v); },
    touch() { return pick().touch(); },
    flush() { return pick().flush(); },
    flushSync() { return pick().flushSync(); },
    forUser(userId, fn) {
      return runWithUser(userId, () => fn(pick()));
    },
  };
}

// ── Scoped client pool ─────────────────────────────────────────────
// Internally a single Map keyed by `${uid}::${name}`. Wrapper exposes the
// same API as the old `clients` Map but transparently scopes by current uid.
const _all = new Map(); // composite key -> entry
function _key(uid, name) { return `${uid}::${name}`; }
function _split(k) {
  const i = k.indexOf('::');
  if (i < 0) return [SYSTEM_UID, k];
  return [k.slice(0, i), k.slice(i + 2)];
}

const clientsPool = {
  // Public Map-like API (always operates on the current user's namespace)
  get(name) { return _all.get(_key(currentUserId(), name)); },
  set(name, val) { _all.set(_key(currentUserId(), name), val); return clientsPool; },
  has(name) { return _all.has(_key(currentUserId(), name)); },
  delete(name) { return _all.delete(_key(currentUserId(), name)); },
  clear() {
    const uid = currentUserId();
    for (const k of [..._all.keys()]) if (k.startsWith(uid + '::')) _all.delete(k);
  },
  get size() {
    const uid = currentUserId();
    let n = 0;
    for (const k of _all.keys()) if (k.startsWith(uid + '::')) n++;
    return n;
  },
  *entries() {
    const uid = currentUserId();
    for (const [k, v] of _all) {
      const [u, n] = _split(k);
      if (u === uid) yield [n, v];
    }
  },
  *values() { for (const [, v] of clientsPool.entries()) yield v; },
  *keys()   { for (const [k] of clientsPool.entries()) yield k; },
  forEach(fn) { for (const [k, v] of clientsPool.entries()) fn(v, k, clientsPool); },

  // ── Cross-user helpers (use sparingly; only for system-level loops) ──
  _allRaw() { return _all; },
  _userOf(name) {
    // find which user owns `name` (used for runtime callbacks that lack ctx)
    for (const k of _all.keys()) {
      const [u, n] = _split(k);
      if (n === name) return u;
    }
    return null;
  },
  allUsers() {
    const set = new Set();
    for (const k of _all.keys()) set.add(_split(k)[0]);
    return [...set];
  },
};
// Make Symbol.iterator work like Map (entries)
clientsPool[Symbol.iterator] = function* () {
  yield* clientsPool.entries();
};

// ── Per-user "active" name ────────────────────────────────────────
const _activeMap = new Map(); // uid -> name | null
const activeRef = {
  get() { return _activeMap.get(currentUserId()) || null; },
  set(name) {
    const uid = currentUserId();
    if (name == null) _activeMap.delete(uid);
    else _activeMap.set(uid, name);
  },
};

module.exports = {
  ctx,
  runWithUser,
  withUser,
  currentUserId,
  userDir,
  currentUserDir,
  userFile,
  scopedStore,
  clientsPool,
  activeRef,
  SYSTEM_UID,
};
