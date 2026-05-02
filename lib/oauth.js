/**
 * oauth.js — Discord OAuth2 helper.
 *
 * Requires env vars:
 *   DISCORD_CLIENT_ID
 *   DISCORD_CLIENT_SECRET
 *
 * Redirect URI is derived from REPLIT_DEV_DOMAIN (or DISCORD_OAUTH_REDIRECT
 * if you want to override). Path is always `/api/auth/discord/callback`.
 */
const axios = require('axios');
const crypto = require('crypto');

const SCOPES = ['identify'];
const PATH = '/api/auth/discord/callback';

function isConfigured() {
  return !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
}

function redirectUri(req) {
  if (process.env.DISCORD_OAUTH_REDIRECT) return process.env.DISCORD_OAUTH_REDIRECT;
  // Prefer Replit dev domain; otherwise reflect host header
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}${PATH}`;
  }
  const proto = (req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${PATH}`;
}

function authorizeUrl(req, state) {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID || '',
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    prompt: 'consent',
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

async function exchangeCode(req, code) {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID || '',
    client_secret: process.env.DISCORD_CLIENT_SECRET || '',
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(req),
  });
  const r = await axios.post('https://discord.com/api/oauth2/token', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`Discord OAuth token exchange failed (${r.status}): ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}`);
}

async function fetchMe(accessToken) {
  const r = await axios.get('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status >= 200 && r.status < 300) {
    const d = r.data;
    const av = d.avatar
      ? `https://cdn.discordapp.com/avatars/${d.id}/${d.avatar}.${d.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${(Number(BigInt(d.id) >> 22n) % 6)}.png`;
    return {
      id: d.id,
      username: d.global_name || d.username,
      avatar: av,
      raw: d,
    };
  }
  throw new Error(`Discord OAuth /users/@me failed (${r.status})`);
}

function newState() { return crypto.randomBytes(24).toString('base64url'); }

module.exports = {
  isConfigured,
  authorizeUrl,
  exchangeCode,
  fetchMe,
  newState,
  redirectUri,
};
