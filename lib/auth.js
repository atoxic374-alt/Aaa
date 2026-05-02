/**
 * auth.js — session gate + device-token "remember me" + per-IP backoff.
 *
 * Session shape: req.session.user = { id, username, loginAt }
 *
 * - Persistent device login: when /api/auth/login is called with
 *   { remember: true } the server issues a long-lived "remember me" cookie
 *   `dam.dev` containing an opaque token. On subsequent requests, if there
 *   is no session but a valid device token, we restore the session
 *   automatically.
 *
 * - All /api/* (except /api/auth/*) require an authenticated session.
 */
const fs = require('fs');
const path = require('path');
const { randomSecret } = require('./crypto');
const users = require('./users');

const SECRET_FILE = path.join(__dirname, '..', 'data', '.session_secret');

function _ensureSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }
  try { fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true }); } catch {}
  if (fs.existsSync(SECRET_FILE)) {
    try {
      const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (s.length >= 32) return s;
    } catch {}
  }
  const s = randomSecret(48);
  try {
    fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
    try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
  } catch {}
  return s;
}

const SESSION_SECRET = _ensureSessionSecret();

const DEVICE_COOKIE = 'dam.dev';
const DEVICE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function setDeviceCookie(res, token) {
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false, // proxy terminates TLS
    maxAge: DEVICE_MAX_AGE_MS,
    path: '/',
  });
}

function clearDeviceCookie(res) {
  res.clearCookie(DEVICE_COOKIE, { path: '/' });
}

// Per-IP login backoff: count consecutive failures, force a small delay.
const _failures = new Map(); // ip -> { count, last }
function _failureDelay(ip) {
  const f = _failures.get(ip);
  if (!f) return 0;
  if (Date.now() - f.last > 5 * 60_000) { _failures.delete(ip); return 0; }
  return Math.min(4000, 250 * Math.pow(2, Math.max(0, f.count - 2)));
}
function _noteFailure(ip) {
  const f = _failures.get(ip) || { count: 0, last: 0 };
  f.count += 1; f.last = Date.now();
  _failures.set(ip, f);
}
function _clearFailures(ip) { _failures.delete(ip); }

/**
 * tryRestoreFromDeviceToken — if no active session but a valid device cookie
 * is present, populate req.session.user from it. Synchronous in spirit
 * (uses the in-memory users store).
 */
function tryRestoreFromDeviceToken(req) {
  if (req.session?.user) return false;
  const token = req.cookies?.[DEVICE_COOKIE];
  if (!token) return false;
  const u = users.verifyDeviceToken(token);
  if (!u) return false;
  req.session.user = { id: u.id, username: u.username, loginAt: Date.now(), viaDevice: true };
  users.touchLogin(u.id);
  return true;
}

// Express middleware: gate everything that isn't whitelisted.
function requireAuth() {
  const allowPaths = new Set([
    '/login',
    '/signup',
    '/discord.png',
    '/favicon.ico',
  ]);
  const allowPrefixes = ['/api/auth/', '/src/', '/public/', '/images/'];
  return (req, res, next) => {
    const url = req.path || req.url;
    if (allowPaths.has(url)) return next();
    if (allowPrefixes.some(p => url.startsWith(p))) return next();
    if (url.endsWith('.css') || url.endsWith('.js') || url.endsWith('.png') ||
        url.endsWith('.svg') || url.endsWith('.ico') || url.endsWith('.woff') ||
        url.endsWith('.woff2') || url.endsWith('.jpg') || url.endsWith('.jpeg')) return next();

    // Try device token restore (opportunistic).
    if (!req.session?.user) tryRestoreFromDeviceToken(req);

    if (req.session && req.session.user) return next();

    if (url.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'unauthorized' });
    }
    return res.redirect('/login');
  };
}

module.exports = {
  SESSION_SECRET,
  DEVICE_COOKIE,
  DEVICE_MAX_AGE_MS,
  setDeviceCookie,
  clearDeviceCookie,
  tryRestoreFromDeviceToken,
  requireAuth,
  _failureDelay,
  _noteFailure,
  _clearFailures,
};
