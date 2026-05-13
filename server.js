const express = require('express');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
const { Client }           = require('discord.js-selfbot-v13');
const { getStore }         = require('./lib/jsonStore');
const { tryDecrypt }       = require('./lib/crypto');
const { withUser, currentUserId, clientsPool, activeRef, scopedStore } = require('./lib/userScope');
const { createJob, validateAccounts } = require('./lib/multiDM');

const app  = express();
const PORT = 5000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// ── Data paths ────────────────────────────────────────────────────────────────
const tokensPath = path.join(__dirname, 'saved_tokens.json');
if (!fs.existsSync(tokensPath)) fs.writeFileSync(tokensPath, '[]', 'utf8');

const dataPath  = path.join(__dirname, 'app_data.json');
const dataStore = getStore(dataPath, { tsAccounts: [], tsLastNumber: 0 });
function ensureData() { return dataStore.read(); }
function writeData(d) { dataStore.write(d); }

const checkpointDir = path.join(__dirname, 'data', 'mdm_checkpoints');
fs.mkdirSync(checkpointDir, { recursive: true });

let discordClient = null;

// ── SSE ───────────────────────────────────────────────────────────────────────
const featureSSE = new Set();
function sseBroadcast(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  for (const s of featureSSE) {
    if (!s.types || s.types.includes(type)) {
      try { s.res.write(`data: ${data}\n\n`); } catch {}
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
    if (!name || !token) return res.json({ success: false, error: 'Name and token required' });
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    const existing = tokens.findIndex(t => t.name === name);
    if (existing >= 0) tokens[existing] = { name, token };
    else tokens.push({ name, token });
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/tokens/:name', (req, res) => {
  try {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'))
      .filter(t => t.name !== decodeURIComponent(req.params.name));
    fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── TrueStudio ────────────────────────────────────────────────────────────────
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

app.get('/api/ts/state',           (req, res) => res.json({ success: true, snapshot: tsSnapshot(), accounts: tsAccountsPublic() }));
app.post('/api/ts/accounts',       (req, res) => {
  const { email, password, totpSecret } = req.body;
  const d = ensureData();
  if (!d.tsAccounts) d.tsAccounts = [];
  const existing = d.tsAccounts.find(a => a.email === email);
  if (existing) { existing.password = password; existing.totpSecret = totpSecret; }
  else d.tsAccounts.push({ email, password, totpSecret, addedAt: Date.now() });
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
    if (discordClient) { try { await discordClient.destroy(); } catch {} discordClient = null; }
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
      id: f.user.id, username: f.user.username,
      displayName: f.user.global_name || f.user.username,
      avatar: f.user.avatar
        ? `https://cdn.discordapp.com/avatars/${f.user.id}/${f.user.avatar}.png`
        : '/src/icons/app-icon.png'
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

app.get('/api/discord/servers/:id/channels', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const guild = discordClient.guilds.cache.get(req.params.id);
    if (!guild) return res.json({ success: false, error: 'Server not found' });
    const channels = Array.from(guild.channels.cache.values())
      .filter(c => c.type === 'GUILD_TEXT')
      .map(c => ({ id: c.id, name: c.name }));
    res.json({ success: true, channels });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/servers/:id/members', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const guild = discordClient.guilds.cache.get(req.params.id);
    if (!guild) return res.json({ success: false, error: 'Server not found' });
    await guild.members.fetch();
    const channelId = req.query.channel;
    let members;
    if (!channelId || channelId === 'all') {
      members = Array.from(guild.members.cache.values())
        .filter(m => !m.user.bot)
        .map(m => ({ id: m.user.id, username: m.user.username, displayName: m.displayName }));
    } else {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return res.json({ success: false, error: 'Channel not found' });
      members = Array.from(guild.members.cache.values())
        .filter(m => !m.user.bot && channel.permissionsFor(m)?.has('VIEW_CHANNEL'))
        .map(m => ({ id: m.user.id, username: m.user.username, displayName: m.displayName }));
    }
    res.json({ success: true, members });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/dms', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const dms = Array.from(discordClient.channels.cache.values())
      .filter(c => c.type === 'DM')
      .map(dm => ({
        id: dm.id,
        userId: dm.recipient?.id,
        username: dm.recipient?.username || 'Unknown',
        displayName: dm.recipient?.globalName || dm.recipient?.username || 'Unknown',
        avatar: dm.recipient?.avatarURL() || '/src/icons/app-icon.png'
      }));
    res.json({ success: true, dms });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/dms/:id/messages', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const channel = discordClient.channels.cache.get(req.params.id);
    if (!channel) return res.json({ success: false, error: 'Channel not found' });
    const opts = { limit: 100 };
    if (req.query.before) opts.before = req.query.before;
    const msgs = await channel.messages.fetch(opts);
    const messages = msgs.map(m => ({
      id: m.id, content: m.content, authorId: m.author.id,
      timestamp: m.createdTimestamp,
      isMine: m.author.id === discordClient.user.id
    }));
    res.json({ success: true, messages });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/discord/dms/:channelId/messages/:messageId', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const channel = discordClient.channels.cache.get(req.params.channelId);
    if (!channel) return res.json({ success: false, error: 'Channel not found' });
    const msg = await channel.messages.fetch(req.params.messageId);
    await msg.delete();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/dms/:id/close', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const channel = discordClient.channels.cache.get(req.params.id);
    if (!channel) return res.json({ success: false, error: 'Channel not found' });
    await channel.delete();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/dms/send', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const { userId, message } = req.body;
    const user = await discordClient.users.fetch(userId);
    const dm   = await user.createDM();
    await dm.send(message);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/groups', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const groups = Array.from(discordClient.channels.cache.values())
      .filter(c => c.type === 'GROUP_DM')
      .map(g => ({
        id: g.id, name: g.name || 'Unnamed Group',
        icon: g.iconURL() || '/src/icons/app-icon.png',
        recipients: g.recipients.size
      }));
    res.json({ success: true, groups });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/groups/:id/messages', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const channel = discordClient.channels.cache.get(req.params.id);
    if (!channel) return res.json({ success: false, error: 'Channel not found' });
    const opts = { limit: 100 };
    if (req.query.before) opts.before = req.query.before;
    const msgs = await channel.messages.fetch(opts);
    const messages = msgs.map(m => ({
      id: m.id, content: m.content, authorId: m.author.id,
      timestamp: m.createdTimestamp,
      isMine: m.author.id === discordClient.user.id
    }));
    res.json({ success: true, messages });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/discord/groups/:channelId/messages/:messageId', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const channel = discordClient.channels.cache.get(req.params.channelId);
    if (!channel) return res.json({ success: false, error: 'Channel not found' });
    const msg = await channel.messages.fetch(req.params.messageId);
    await msg.delete();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/groups/:id/leave', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const channel = discordClient.channels.cache.get(req.params.id);
    if (!channel) return res.json({ success: false, error: 'Channel not found' });
    await channel.delete();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/discord/friends/:id', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    await axios.delete(`https://discord.com/api/v9/users/@me/relationships/${req.params.id}`, {
      headers: { Authorization: discordClient.token }
    });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/servers/:id/leave', async (req, res) => {
  try {
    if (!discordClient) return res.json({ success: false, error: 'Not connected' });
    const guild = discordClient.guilds.cache.get(req.params.id);
    if (!guild) return res.json({ success: false, error: 'Server not found' });
    await guild.leave();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/updates', (req, res) => res.json({ success: true, upToDate: true }));

// ── Multi-DM ─────────────────────────────────────────────────────────────────
const _multiDMJobs    = new Map();
const _multiDMStreams = new Map();
const _multiDMActStr  = new Map(); // activity streams

function _getStreams(jobId)    { return _multiDMStreams.get(jobId) || new Set(); }
function _getActStreams(jobId) { return _multiDMActStr.get(jobId)  || new Set(); }

function _broadcastJob(jobId, data) {
  const str = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of _getStreams(jobId)) { try { res.write(str); } catch {} }
}
function _broadcastActivity(jobId, data) {
  const str = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of _getActStreams(jobId)) { try { res.write(str); } catch {} }
}

// SSE — state stream
app.get('/api/multi-dm/stream/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { jobId } = req.params;
  if (!_multiDMStreams.has(jobId)) _multiDMStreams.set(jobId, new Set());
  _multiDMStreams.get(jobId).add(res);

  const job = _multiDMJobs.get(jobId);
  if (job) res.write(`data: ${JSON.stringify({ type: 'state', ...job.getState() })}\n\n`);

  req.on('close', () => { _multiDMStreams.get(jobId)?.delete(res); });
});

// SSE — activity feed stream
app.get('/api/multi-dm/activity/:jobId', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const { jobId } = req.params;
  if (!_multiDMActStr.has(jobId)) _multiDMActStr.set(jobId, new Set());
  _multiDMActStr.get(jobId).add(res);

  req.on('close', () => { _multiDMActStr.get(jobId)?.delete(res); });
});

// Start
app.post('/api/multi-dm/start', async (req, res) => {
  const { accountList, userIds, message, images, speedMode } = req.body;
  if (!accountList?.length) return res.json({ success: false, error: 'No accounts provided' });
  if (!userIds?.length)     return res.json({ success: false, error: 'No users provided' });
  if (!message?.trim())     return res.json({ success: false, error: 'No message provided' });
  if (images && images.length > 10) return res.json({ success: false, error: 'Max 10 images' });

  const jobId    = `mdm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const uniqueIds = [...new Set(userIds)];
  const job = createJob(jobId, accountList, uniqueIds, message, images || [], speedMode || 'normal');

  const cpPath = path.join(checkpointDir, `${jobId}.json`);
  job.setCheckpointPath(cpPath);

  _multiDMJobs.set(jobId, job);
  res.json({ success: true, jobId, total: uniqueIds.length });

  job.start(
    data => _broadcastJob(jobId, data),
    data => _broadcastActivity(jobId, data)
  ).catch(e => {
    console.error('MultiDM error:', e);
    _broadcastJob(jobId, { type: 'error', error: e.message });
  });
});

// Pause
app.post('/api/multi-dm/pause/:jobId', (req, res) => {
  const job = _multiDMJobs.get(req.params.jobId);
  if (!job) return res.json({ success: false, error: 'Job not found' });
  job.pause();
  res.json({ success: true, paused: true });
});

// Resume
app.post('/api/multi-dm/resume/:jobId', (req, res) => {
  const job = _multiDMJobs.get(req.params.jobId);
  if (!job) return res.json({ success: false, error: 'Job not found' });
  job.resume();
  res.json({ success: true, paused: false });
});

// Stop
app.post('/api/multi-dm/stop/:jobId', (req, res) => {
  const job = _multiDMJobs.get(req.params.jobId);
  if (job) { job.stop(); res.json({ success: true }); }
  else res.json({ success: false, error: 'Job not found' });
});

// Validate
app.post('/api/multi-dm/validate', async (req, res) => {
  const { accountList } = req.body;
  if (!accountList?.length) return res.json({ success: false, error: 'No accounts' });
  try {
    const results = await validateAccounts(accountList);
    res.json({ success: true, results });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Get state of a specific job (for reconnect after refresh)
app.get('/api/multi-dm/state/:jobId', (req, res) => {
  const job = _multiDMJobs.get(req.params.jobId);
  if (!job) return res.json({ success: false, error: 'Job not found or expired' });
  res.json({ success: true, ...job.getState() });
});

// List active jobs
app.get('/api/multi-dm/jobs', (req, res) => {
  const jobs = [];
  for (const [jobId, job] of _multiDMJobs) {
    const s = job.getState();
    if (!s.finished && !s.stopped) {
      jobs.push({ jobId, total: s.total, sent: s.sent, done: s.done, paused: s.paused });
    }
  }
  res.json({ success: true, jobs });
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`Discord Account Manager → http://localhost:${PORT}`)
);
