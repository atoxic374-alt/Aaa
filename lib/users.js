/**
 * users.js — multi-user account store.
 *
 * Stores users in `data/users.json`. Each user has:
 *   { id, username, passwordHash, discordId?, discordUsername?, discordAvatar?,
 *     createdAt, lastLogin, deviceTokens: [{ id, hash, createdAt, ua, ip }] }
 *
 * Passwords are bcrypt-hashed. Device "remember me" tokens are random opaque
 * strings; only the SHA-256 hash is persisted server-side. The client
 * presents the raw token in a long-lived cookie and the server verifies by
 * hashing and comparing.
 */
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getStore } = require('./jsonStore');

const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');
const store = getStore(USERS_FILE, { users: [] });

function _list() {
  const d = store.read() || { users: [] };
  if (!Array.isArray(d.users)) d.users = [];
  return d.users;
}

function _save() { store.touch(); }

function _newId() {
  return 'u_' + crypto.randomBytes(8).toString('hex');
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    discordId: u.discordId || null,
    discordUsername: u.discordUsername || null,
    discordAvatar: u.discordAvatar || null,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin || null,
  };
}

function findById(id) {
  return _list().find(u => u.id === id) || null;
}
function findByUsername(username) {
  const v = String(username || '').trim().toLowerCase();
  if (!v) return null;
  return _list().find(u => (u.username || '').toLowerCase() === v) || null;
}
function findByDiscordId(discordId) {
  if (!discordId) return null;
  return _list().find(u => u.discordId === discordId) || null;
}

function count() { return _list().length; }

// Create a user. Password is ALWAYS required — even when linking Discord —
// to prevent anyone with access to the user's Discord account from taking
// over their managed token data. Discord login is treated as a second
// factor / convenient identity, not a primary credential.
async function createUser({ username, password, discord = null }) {
  const uname = String(username || '').trim();
  if (uname.length < 3 || uname.length > 32) throw new Error('Username must be 3–32 characters');
  if (!/^[a-zA-Z0-9_.-]+$/.test(uname)) throw new Error('Username may only contain letters, numbers, dot, dash, underscore');
  if (findByUsername(uname)) throw new Error('Username already taken');
  if (!password || String(password).length < 6) throw new Error('Password must be at least 6 characters');
  if (discord?.id && findByDiscordId(discord.id)) throw new Error('That Discord account is already linked to another user');

  const passwordHash = await bcrypt.hash(String(password), 10);
  const u = {
    id: _newId(),
    username: uname,
    passwordHash,
    discordId: discord?.id || null,
    discordUsername: discord?.username || null,
    discordAvatar: discord?.avatar || null,
    createdAt: Date.now(),
    lastLogin: null,
    deviceTokens: [],
  };
  _list().push(u);
  _save();
  return publicUser(u);
}

async function verifyPassword(usernameOrUser, password) {
  const u = typeof usernameOrUser === 'string' ? findByUsername(usernameOrUser) : usernameOrUser;
  if (!u) return null;
  const ok = await bcrypt.compare(String(password || ''), u.passwordHash || '');
  return ok ? u : null;
}

async function changePassword(userId, oldPassword, newPassword) {
  const u = findById(userId);
  if (!u) throw new Error('User not found');
  const ok = await bcrypt.compare(String(oldPassword || ''), u.passwordHash || '');
  if (!ok) throw new Error('Wrong current password');
  if (!newPassword || String(newPassword).length < 6) throw new Error('New password too short');
  u.passwordHash = await bcrypt.hash(String(newPassword), 10);
  _save();
}

function touchLogin(userId) {
  const u = findById(userId);
  if (!u) return;
  u.lastLogin = Date.now();
  _save();
}

function linkDiscord(userId, discord) {
  const u = findById(userId);
  if (!u) throw new Error('User not found');
  if (discord?.id) {
    const other = findByDiscordId(discord.id);
    if (other && other.id !== userId) throw new Error('That Discord account is linked to another user');
  }
  u.discordId = discord?.id || null;
  u.discordUsername = discord?.username || null;
  u.discordAvatar = discord?.avatar || null;
  _save();
  return publicUser(u);
}

function unlinkDiscord(userId) {
  const u = findById(userId);
  if (!u) throw new Error('User not found');
  u.discordId = null;
  u.discordUsername = null;
  u.discordAvatar = null;
  _save();
  return publicUser(u);
}

// ── Device "remember me" tokens ────────────────────────────────────
function _hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function issueDeviceToken(userId, meta = {}) {
  const u = findById(userId);
  if (!u) throw new Error('User not found');
  if (!Array.isArray(u.deviceTokens)) u.deviceTokens = [];
  // Cap at 20 devices per user — drop oldest
  while (u.deviceTokens.length >= 20) u.deviceTokens.shift();
  const id = crypto.randomBytes(8).toString('hex');
  const raw = crypto.randomBytes(32).toString('base64url');
  const composite = `${id}.${raw}`;
  u.deviceTokens.push({
    id,
    hash: _hashToken(composite),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    ua: String(meta.ua || '').slice(0, 256),
    ip: String(meta.ip || '').slice(0, 64),
  });
  _save();
  return composite;
}

function verifyDeviceToken(composite) {
  if (!composite || typeof composite !== 'string') return null;
  const dot = composite.indexOf('.');
  if (dot < 1) return null;
  const id = composite.slice(0, dot);
  const h = _hashToken(composite);
  for (const u of _list()) {
    if (!Array.isArray(u.deviceTokens)) continue;
    const dt = u.deviceTokens.find(d => d.id === id && d.hash === h);
    if (dt) {
      dt.lastSeen = Date.now();
      _save();
      return u;
    }
  }
  return null;
}

function revokeDeviceToken(userId, tokenId) {
  const u = findById(userId);
  if (!u || !Array.isArray(u.deviceTokens)) return;
  const before = u.deviceTokens.length;
  u.deviceTokens = u.deviceTokens.filter(d => d.id !== tokenId);
  if (u.deviceTokens.length !== before) _save();
}

function revokeAllDevices(userId) {
  const u = findById(userId);
  if (!u) return;
  u.deviceTokens = [];
  _save();
}

function listDevices(userId) {
  const u = findById(userId);
  if (!u || !Array.isArray(u.deviceTokens)) return [];
  return u.deviceTokens.map(d => ({
    id: d.id,
    createdAt: d.createdAt,
    lastSeen: d.lastSeen,
    ua: d.ua,
    ip: d.ip,
  }));
}

function allUserIds() { return _list().map(u => u.id); }

module.exports = {
  publicUser,
  findById,
  findByUsername,
  findByDiscordId,
  createUser,
  verifyPassword,
  changePassword,
  touchLogin,
  linkDiscord,
  unlinkDiscord,
  issueDeviceToken,
  verifyDeviceToken,
  revokeDeviceToken,
  revokeAllDevices,
  listDevices,
  count,
  allUserIds,
};
