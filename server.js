const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { Client } = require('discord.js-selfbot-v13');
const { getStore } = require('./lib/jsonStore');
const { tryDecrypt } = require('./lib/crypto');
const { withUser, currentUserId } = require('./lib/userScope');

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const tokensPath = path.join(__dirname, 'saved_tokens.json');
if (!fs.existsSync(tokensPath)) fs.writeFileSync(tokensPath, '[]', 'utf8');

let discordClient = null;

// Data Store Mock/Minimal
const dataPath = path.join(__dirname, 'app_data.json');
const dataStore = getStore(dataPath, { tsAccounts: [], tsLastNumber: 0 });
function ensureData() { return dataStore.read(); }
function writeData(d) { dataStore.write(d); }

// ── Tokens ────────────────────────────────────────────────────────────────────
app.get('/api/tokens', (req, res) => {
  try {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    res.json({ success: true, tokens });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/tokens', (req, res) => {
  try {
    const { name, token } = req.body;
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    tokens.push({ name, token });
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── SSE ───────────────────────────────────────────────────────────────────────
const featureSSE = new Set();
function sseBroadcast(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  for (const s of featureSSE) {
    if (!s.types || s.types.includes(type)) {
      try { s.res.write(`data: ${data}\n\n`); } catch (e) {}
    }
  }
}

app.get('/api/features/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const types = req.query.types ? req.query.types.split(',') : null;
  const entry = { res, types };
  featureSSE.add(entry);
  req.on('close', () => featureSSE.delete(entry));
});

// ── TrueStudio Logic ─────────────────────────────────────────────────────────
const ts = require('./lib/trueStudio');
const _tsSessions = new Map();
function tsSession() {
  const uid = currentUserId();
  if (!_tsSessions.has(uid)) _tsSessions.set(uid, ts.makeSession());
  return _tsSessions.get(uid);
}

function tsSnapshot() {
  const s = tsSession();
  return {
    state: s.state, account: s.account, rules: s.rules, total: s.total, done: s.done,
    failed: s.failed, current: s.current, teamId: s.teamId, teamName: s.teamName,
    waitUntilTs: s.waitUntilTs, waitTotalMs: s.waitTotalMs, startedAt: s.startedAt,
    finishedAt: s.finishedAt, bots: (s.bots || []).map(b => ({ name: b.name, appId: b.appId, hasToken: !!b.token })),
    lastError: s.lastError, log: s.log.slice(-50), pendingCaptcha: s.pendingCaptcha
  };
}

function pushTsEvent(type, payload = {}) {
  sseBroadcast(type, { ...payload, snapshot: tsSnapshot(), _uid: currentUserId() });
}

function tsLog(level, msg) {
  const s = tsSession();
  s.log.push({ ts: Date.now(), level, msg: String(msg).slice(0, 500) });
  pushTsEvent('ts_log', { entry: s.log[s.log.length - 1] });
}

function tsAccountsPublic() {
  const d = ensureData();
  return (d.tsAccounts || []).map(a => ({
    email: a.email, hasPassword: !!a.password, hasTotp: !!a.totpSecret, addedAt: a.addedAt || 0, verify: a.verify || null
  }));
}

// ── TrueStudio Endpoints ─────────────────────────────────────────────────────
app.get('/api/ts/state', (req, res) => res.json({ success: true, snapshot: tsSnapshot(), accounts: tsAccountsPublic() }));

app.post('/api/ts/accounts', (req, res) => {
  const { email, password, totpSecret } = req.body;
  const d = ensureData();
  if (!d.tsAccounts) d.tsAccounts = [];
  const existing = d.tsAccounts.find(a => a.email === email);
  if (existing) {
    existing.password = password;
    existing.totpSecret = totpSecret;
  } else {
    d.tsAccounts.push({ email, password, totpSecret, addedAt: Date.now() });
  }
  writeData(d);
  res.json({ success: true, accounts: tsAccountsPublic() });
});

app.delete('/api/ts/accounts/:email', (req, res) => {
  const d = ensureData();
  d.tsAccounts = (d.tsAccounts || []).filter(a => a.email !== req.params.email);
  writeData(d);
  res.json({ success: true, accounts: tsAccountsPublic() });
});

app.post('/api/ts/start', async (req, res) => {
  const s = tsSession();
  const { email, rules, count, prefix, waitMinutes } = req.body;
  Object.assign(s, ts.makeSession());
  s.account = email; s.rules = rules; s.total = count; s.state = 'running';
  pushTsEvent('ts_progress');
  res.json({ success: true, snapshot: tsSnapshot() });
  // Background task simulation for brevity in this step
  tsLog('info', `Starting session for ${email}...`);
});

app.post('/api/ts/stop', (req, res) => {
  const s = tsSession();
  s.state = 'cancelled';
  pushTsEvent('ts_progress');
  res.json({ success: true, snapshot: tsSnapshot() });
});

// ── Discord ───────────────────────────────────────────────────────────────────
app.post('/api/discord/connect', async (req, res) => {
  try {
    const { token } = req.body;
    if (discordClient) { await discordClient.destroy(); discordClient = null; }
    discordClient = new Client({ checkUpdate: false, fetchAllMembers: false });
    await discordClient.login(token);
    res.json({ success: true, username: discordClient.user.tag });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/friends', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    const response = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { Authorization: discordClient.token }
    });
    const friends = response.data.filter(r => r.type === 1).map(f => ({
      id: f.user.id, username: f.user.username, displayName: f.user.global_name || f.user.username,
      avatar: f.user.avatar ? `https://cdn.discordapp.com/avatars/${f.user.id}/${f.user.avatar}.png` : '/src/icons/app-icon.png'
    }));
    res.json({ success: true, friends });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/servers', async (req, res) => {
  try {
    if (!discordClient?.guilds) return res.json({ success: false, error: 'Not connected' });
    const servers = Array.from(discordClient.guilds.cache.values())
      .map(s => ({ id: s.id, name: s.name, icon: s.iconURL() || '/src/icons/app-icon.png' }));
    res.json({ success: true, servers });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/dms', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const dms = Array.from(discordClient.channels.cache.values()).filter(c => c.type === 'DM').map(dm => ({
      id: dm.id, username: dm.recipient?.username || 'Unknown', displayName: dm.recipient?.globalName || dm.recipient?.username || 'Unknown',
      avatar: dm.recipient?.avatarURL() || '/src/icons/app-icon.png'
    }));
    res.json({ success: true, dms });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/groups', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const groups = Array.from(discordClient.channels.cache.values()).filter(c => c.type === 'GROUP_DM').map(g => ({
      id: g.id, name: g.name || 'Unnamed Group', icon: g.iconURL() || '/src/icons/app-icon.png', recipients: g.recipients.size
    }));
    res.json({ success: true, groups });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Discord Account Manager → http://localhost:${PORT}`));
