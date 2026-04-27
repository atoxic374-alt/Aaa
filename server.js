const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { Client } = require('discord.js-selfbot-v13');

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const tokensPath = path.join(__dirname, 'saved_tokens.json');
if (!fs.existsSync(tokensPath)) fs.writeFileSync(tokensPath, '[]', 'utf8');

let discordClient = null;

// ── Tokens ────────────────────────────────────────────────────────────────────

app.get('/api/tokens', (req, res) => {
  try {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    const singleToken = Array.isArray(tokens) && tokens.length > 0 ? [tokens[0]] : [];
    res.json({ success: true, tokens: singleToken });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/tokens', (req, res) => {
  try {
    const { name, token } = req.body;
    const safeName = typeof name === 'string' && name.trim() ? name.trim() : 'Main Account';
    fs.writeFileSync(tokensPath, JSON.stringify([{ name: safeName, token }], null, 2));
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/tokens/:name', (req, res) => {
  try {
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    const newTokens = tokens.filter(t => t.name !== req.params.name).slice(0, 1);
    fs.writeFileSync(tokensPath, JSON.stringify(newTokens, null, 2));
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── Updates ───────────────────────────────────────────────────────────────────

app.get('/api/updates', async (req, res) => {
  try {
    const response = await axios.get('https://raw.githubusercontent.com/Bherl1/DiscordAccMgr/refs/heads/main/package.json');
    const latestVersion = response.data.version;
    const currentVersion = require('./package.json').version;
    res.json({
      hasUpdate: latestVersion > currentVersion,
      version: latestVersion,
      downloadUrl: `https://github.com/Bherl1/DiscordAccMgr/releases/download/v${latestVersion}/DiscordAccManager-Setup.exe`
    });
  } catch (e) { res.json({ hasUpdate: false }); }
});

// ── Discord ───────────────────────────────────────────────────────────────────

app.post('/api/discord/connect', async (req, res) => {
  try {
    const { token } = req.body;
    if (discordClient) { await discordClient.destroy(); discordClient = null; }
    discordClient = new Client({ checkUpdate: false, fetchAllMembers: false });
    await discordClient.login(token);
    res.json({ success: true, username: discordClient.user.tag });
  } catch (e) {
    console.error('Connect error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// Friends
app.get('/api/discord/friends', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    const response = await axios.get('https://discord.com/api/v9/users/@me/relationships', {
      headers: { Authorization: discordClient.token }
    });
    const friends = response.data
      .filter(r => r.type === 1)
      .map(f => ({
        id: f.user.id,
        username: f.user.username,
        displayName: f.user.global_name || f.user.username,
        avatar: f.user.avatar
          ? `https://cdn.discordapp.com/avatars/${f.user.id}/${f.user.avatar}.png`
          : '/src/icons/app-icon.png'
      }));
    res.json({ success: true, friends });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/discord/friends/:id', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    await axios.delete(`https://discord.com/api/v9/users/@me/relationships/${req.params.id}`, {
      headers: { Authorization: discordClient.token }
    });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Servers
app.get('/api/discord/servers', async (req, res) => {
  try {
    if (!discordClient?.guilds) return res.json({ success: false, error: 'Not connected' });
    const servers = Array.from(discordClient.guilds.cache.values())
      .filter(s => s.ownerId !== discordClient.user.id)
      .map(s => ({ id: s.id, name: s.name, icon: s.iconURL() || '/src/icons/app-icon.png' }));
    res.json({ success: true, servers });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/servers/:id/leave', async (req, res) => {
  try {
    if (!discordClient?.guilds) return res.json({ success: false, error: 'Not connected' });
    const guild = discordClient.guilds.cache.get(req.params.id);
    if (!guild) return res.json({ success: false, error: 'Server not found' });
    await guild.leave();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/servers/:id/mute', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    await axios.patch(`https://discord.com/api/v9/users/@me/guilds/${req.params.id}/settings`,
      { muted: true }, { headers: { Authorization: discordClient.token } });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/servers/:id/unmute', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    await axios.patch(`https://discord.com/api/v9/users/@me/guilds/${req.params.id}/settings`,
      { muted: false }, { headers: { Authorization: discordClient.token } });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/servers/readall', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    for (const guild of discordClient.guilds.cache.values()) {
      try { await guild.markAsRead(); } catch (_) {}
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/servers/:id/channels', async (req, res) => {
  try {
    if (!discordClient?.guilds) return res.json({ success: false, error: 'Not connected' });
    const guild = discordClient.guilds.cache.get(req.params.id);
    if (!guild) return res.json({ success: false, error: 'Server not found' });
    const channels = Array.from(guild.channels.cache.values())
      .filter(c => c.type === 'GUILD_TEXT' || c.type === 0)
      .map(c => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, channels });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/servers/:id/members', async (req, res) => {
  try {
    if (!discordClient?.guilds) return res.json({ success: false, error: 'Not connected' });
    const guild = discordClient.guilds.cache.get(req.params.id);
    if (!guild) return res.json({ success: false, error: 'Server not found' });
    try { await guild.members.fetch(); } catch (_) {}
    const channelId = req.query.channel;
    let rawMembers;
    if (channelId && channelId !== 'all') {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return res.json({ success: false, error: 'Channel not found' });
      rawMembers = Array.from(channel.members.values());
    } else {
      rawMembers = Array.from(guild.members.cache.values());
    }
    const members = rawMembers
      .filter(m => !m.user.bot && m.id !== discordClient.user.id)
      .map(m => ({ id: m.user.id, username: m.user.username, displayName: m.user.globalName || m.user.username }));
    res.json({ success: true, members, count: members.length });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// DMs
app.get('/api/discord/dms', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const dms = Array.from(discordClient.channels.cache.values())
      .filter(c => c.type === 'DM')
      .map(dm => ({
        id: dm.id,
        username: dm.recipient?.username || 'Unknown',
        displayName: dm.recipient?.globalName || dm.recipient?.username || 'Unknown',
        avatar: dm.recipient?.avatarURL() || '/src/icons/app-icon.png'
      }));
    res.json({ success: true, dms });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/dms/:id/messages', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const channel = await discordClient.channels.fetch(req.params.id);
    if (!channel || channel.type !== 'DM') return res.json({ success: false, error: 'Invalid DM' });
    const opts = req.query.before ? { before: req.query.before, limit: 100 } : { limit: 100 };
    const messages = await channel.messages.fetch(opts);
    res.json({
      success: true,
      currentUserId: discordClient.user.id,
      messages: Array.from(messages.values()).map(m => ({
        id: m.id, content: m.content,
        isDeletable: m.author.id === discordClient.user.id && !m.system
      }))
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/discord/dms/:channelId/messages/:messageId', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const channel = await discordClient.channels.fetch(req.params.channelId);
    if (!channel || channel.type !== 'DM') return res.json({ success: false, error: 'Invalid DM' });
    const message = await channel.messages.fetch(req.params.messageId);
    await message.delete();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/dms/:id/close', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const channel = await discordClient.channels.fetch(req.params.id);
    if (!channel || channel.type !== 'DM') return res.json({ success: false, error: 'Invalid DM' });
    await channel.delete();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/dms/send', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    const { userId, message } = req.body;
    const user = await discordClient.users.fetch(userId);
    const dm = await user.createDM();
    await dm.send(message);
    res.json({ success: true });
  } catch (e) {
    console.error('Send DM error:', e.message);
    const status = e.status || e.httpStatus;
    res.json({ success: false, error: e.message, rateLimited: status === 429, retryAfter: e.retryAfter || null });
  }
});

// Groups
app.get('/api/discord/groups', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const groups = Array.from(discordClient.channels.cache.values())
      .filter(c => c.type === 'GROUP_DM')
      .map(g => ({ id: g.id, name: g.name || 'Unnamed Group', icon: g.iconURL() || '/src/icons/app-icon.png', recipients: g.recipients.size }));
    res.json({ success: true, groups });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/discord/groups/:id/leave', async (req, res) => {
  try {
    if (!discordClient?.user) return res.json({ success: false, error: 'Not connected' });
    const group = await discordClient.channels.fetch(req.params.id);
    if (!group || group.type !== 'GROUP_DM') return res.json({ success: false, error: 'Invalid group' });
    await group.delete();
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/discord/groups/:id/messages', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    const url = `https://discord.com/api/v9/channels/${req.params.id}/messages?limit=100${req.query.before ? `&before=${req.query.before}` : ''}`;
    const response = await axios.get(url, { headers: { Authorization: discordClient.token } });
    res.json({
      success: true,
      currentUserId: discordClient.user.id,
      messages: response.data.map(m => ({ id: m.id, content: m.content, author: { id: m.author.id } }))
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/discord/groups/:channelId/messages/:messageId', async (req, res) => {
  try {
    if (!discordClient?.token) return res.json({ success: false, error: 'Not connected' });
    await axios.delete(`https://discord.com/api/v9/channels/${req.params.channelId}/messages/${req.params.messageId}`,
      { headers: { Authorization: discordClient.token } });
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Discord Account Manager → http://localhost:${PORT}`));
