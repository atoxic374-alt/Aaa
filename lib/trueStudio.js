/**
 * trueStudio.js — TOTP-based Discord automation engine.
 *
 * The previous Bot-Tokens flow relied on hCaptcha solving (fragile, requires a
 * paid 2captcha key, and Discord rotates sitekeys frequently). True-Studio
 * stores per-account credentials (email + password + base32 TOTP secret) and
 * uses RFC-6238 codes to satisfy Discord's MFA endpoints — no captcha service
 * required, and challenges are answered automatically every step of the way.
 *
 * Pipeline (configurable per session):
 *   1. login(email, password, totpSecret)        → user token
 *   2. (optional) createTeam(prefix)             → team id
 *   3. (optional) createApplication × N          → app ids + bot tokens
 *   4. (optional) transferApplication → team     → bots become team-owned
 *
 * Each step waits `waitMinutes` between bot creations to look organic and
 * avoid Discord's bot-creation throttle.
 */
const crypto = require('crypto');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
// We deliberately do NOT use axios-cookiejar-support here. That wrapper is
// incompatible with a custom https.Agent (it throws "does not support for use
// with other http(s).Agent" at request time). Instead we use the underlying
// `http-cookie-agent` library directly: HttpsCookieAgent both injects the
// cookie jar AND lets us pass our Chrome-like TLS settings (ciphers / ALPN /
// curves / sigalgs) on the same agent. Single agent → both features work.
const { HttpsCookieAgent, HttpCookieAgent } = require('http-cookie-agent/http');

const API = 'https://discord.com/api/v9';

// ─────────────────────────────────────────────────────────────────
// TLS fingerprint mitigation
// Node's default TLS handshake produces a JA3 hash that's distinct from real
// Chrome — Discord's anti-bot stack scores those automation-like JA3s heavily.
// We cannot perfectly impersonate Chrome's JA3 in pure Node (that needs a
// native TLS lib like curl-impersonate), but we can get *much* closer by:
//   • presenting Chrome 131's cipher suite list in Chrome's preference order
//   • advertising the same ALPN protocols (h2, http/1.1)
//   • using Chrome's ECDH curve preferences (X25519 first)
//   • advertising Chrome's signature algorithm preferences
// The resulting JA3 still differs in extension order (Node hard-codes that),
// but the cipher/curve/sigalg fingerprint matches Chrome exactly — enough to
// move the request out of the "headless / scraping library" bucket.
// ─────────────────────────────────────────────────────────────────
const CHROME_TLS_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES128-SHA',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-ECDSA-AES256-SHA',
  'ECDHE-RSA-AES256-SHA',
  'AES128-GCM-SHA256',
  'AES256-GCM-SHA384',
  'AES128-SHA',
  'AES256-SHA',
].join(':');

const CHROME_SIGALGS = [
  'ecdsa_secp256r1_sha256',
  'rsa_pss_rsae_sha256',
  'rsa_pkcs1_sha256',
  'ecdsa_secp384r1_sha384',
  'rsa_pss_rsae_sha384',
  'rsa_pkcs1_sha384',
  'rsa_pss_rsae_sha512',
  'rsa_pkcs1_sha512',
].join(':');

// Build a single agent that combines:
//   • the Chrome-like TLS handshake (cipher order / ALPN / curves / sigalgs)
//   • cookie-jar persistence via http-cookie-agent
// Returns { httpsAgent, httpAgent } — axios needs both even though we only
// ever talk to https://discord.com (axios still validates the http one).
function _createChromeAgents(jar) {
  // ALPN note: Chrome advertises ['h2', 'http/1.1'] but Node's https.Agent
  // (and our HttpsCookieAgent extension) only speaks HTTP/1.1. If we offer h2
  // and the server picks it (Discord/Cloudflare always do), Node receives raw
  // HTTP/2 binary frames into the HTTP/1.1 parser and dies with HPE_INVALID_
  // CONSTANT / "Expected HTTP/, RTSP/, or ICE/". So we have to advertise only
  // http/1.1. Cost: small JA3 difference vs real Chrome. Worth it — without
  // this the entire TrueStudio session can't even connect.
  const tlsOpts = {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    ciphers: CHROME_TLS_CIPHERS,
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ALPNProtocols: ['http/1.1'],
    ecdhCurve: 'X25519:secp256r1:secp384r1',
    sigalgs: CHROME_SIGALGS,
  };
  return {
    httpsAgent: new HttpsCookieAgent({ cookies: { jar }, ...tlsOpts }),
    httpAgent: new HttpCookieAgent({ cookies: { jar }, keepAlive: true, keepAliveMsecs: 30_000 }),
  };
}

// Discord client build numbers rotate; this matches a recent stable web build
// and is sent as X-Super-Properties so login succeeds without "client outdated".
// We refresh from Discord's live build manifest at session start (see fetchBuildNumber).
const SUPER_PROPS = {
  os: 'Windows',
  browser: 'Chrome',
  device: '',
  system_locale: 'en-US',
  browser_user_agent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  browser_version: '131.0.0.0',
  os_version: '10',
  referrer: '',
  referring_domain: '',
  referrer_current: '',
  referring_domain_current: '',
  release_channel: 'stable',
  client_build_number: 354655,
  client_event_source: null,
  design_id: 0,
};
const UA = SUPER_PROPS.browser_user_agent;

function _encodeSuperProps(buildNumber) {
  const sp = { ...SUPER_PROPS, client_build_number: buildNumber || SUPER_PROPS.client_build_number };
  return Buffer.from(JSON.stringify(sp)).toString('base64');
}

// Per-session client: holds an isolated cookie jar (so __dcfduid / __sdcfduid /
// __cfruid set by Discord's CDN persist across requests, mirroring what a real
// browser does), an axios instance wired to that jar, a Chrome-like TLS agent
// (matched cipher list / ALPN / curves / sigalgs to weaken the JA3 signal),
// the live build_number, and the X-Fingerprint Discord assigns on the first
// /experiments call. We also track `currentPage` — the URL the simulated
// "browser" is currently on — so every API call carries the same Referer the
// real Discord web client would send from that page.
function createClient() {
  const jar = new CookieJar();
  const { httpsAgent, httpAgent } = _createChromeAgents(jar);
  // Plain axios.create — no cookiejar wrapper. The HttpsCookieAgent already
  // handles Set-Cookie / Cookie headers using the same `jar` we pass in.
  const http = axios.create({
    timeout: 25000,
    validateStatus: () => true,
    httpAgent,
    httpsAgent,
    // Default browser-style headers; per-request headers override these.
    headers: {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'sec-ch-ua': '"Not_A Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    },
  });
  return {
    jar,
    http,
    httpsAgent,
    httpAgent,
    fingerprint: null,
    buildNumber: SUPER_PROPS.client_build_number,
    superPropsB64: _encodeSuperProps(SUPER_PROPS.client_build_number),
    warmedUp: false,
    // The simulated browser's "current page" — drives the Referer header on
    // every API call so it matches what a real Chrome session would send.
    currentPage: 'https://discord.com/login',
    // Set to true after simulateBrowsing+loadDevPortal has run once on this
    // session, so the orchestrator doesn't re-do it on every restart.
    devPortalLoaded: false,
  };
}

// ─────────────────────────────────────────────────────────────────
// Live build_number fetcher
// Discord ships a new web build every few days. The X-Super-Properties header
// must carry a current `client_build_number` — anything more than ~2 weeks
// old is one of the signals their anti-bot stack flags as "outdated/forged
// client". We fetch the live number from the bundled JS at session start and
// fall back to the static constant only if the fetch fails.
//
// Strategy:
//   1. GET https://discord.com/login → HTML containing <script src="/assets/X.js">
//   2. Walk the script tags from the bottom up (manifest is in the last 3-5)
//   3. Each candidate is fetched and grep'd for `build_number:NNNNNN`
//   4. Returns the first valid number, or null
// ─────────────────────────────────────────────────────────────────
async function fetchBuildNumber(client) {
  try {
    const r = await client.http.get('https://discord.com/login', {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
      },
    });
    const html = String(r.data || '');
    const scriptRe = /<script[^>]+src="(\/assets\/[A-Za-z0-9._-]+\.js)"/g;
    const scripts = [];
    let m;
    while ((m = scriptRe.exec(html)) !== null) scripts.push(m[1]);
    if (!scripts.length) return null;
    // The build manifest is typically in the last 4 chunks of the bundle.
    const candidates = scripts.slice(-4).reverse();
    for (const src of candidates) {
      try {
        const sr = await client.http.get('https://discord.com' + src, {
          headers: {
            'User-Agent': UA,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://discord.com/login',
            'sec-fetch-dest': 'script',
            'sec-fetch-mode': 'no-cors',
            'sec-fetch-site': 'same-origin',
          },
          // Some bundles are several MB — bump axios's response cap.
          maxContentLength: 50 * 1024 * 1024,
          maxBodyLength: 50 * 1024 * 1024,
        });
        const body = String(sr.data || '');
        // Match either `build_number:354655` (minified) or `"build_number":354655`
        const bm = body.match(/build_number["':\s]+(\d{5,7})/);
        if (bm) {
          const num = parseInt(bm[1], 10);
          if (num > 100000 && num < 9999999) return num;
        }
      } catch (_) { /* try next */ }
    }
  } catch (_) { /* swallow — caller falls back to default */ }
  return null;
}

// Pre-warm the client like a real browser visiting discord.com:
//   1) GET https://discord.com/login    → sets __dcfduid / __sdcfduid cookies
//                                          + parses live build_number from JS
//   2) GET /api/v9/experiments          → returns X-Fingerprint we'll send on login
//   3) GET /api/v9/auth/location-metadata
// This sequence matches the network log of a fresh Chrome session opening
// discord.com/login, dramatically reducing automation signals.
async function warmUpClient(client) {
  if (client.warmedUp) return;
  // Fetch the live build_number — also primes __dcfduid / __sdcfduid cookies
  // because fetchBuildNumber's first request is the same /login HTML page.
  try {
    const liveBuild = await fetchBuildNumber(client);
    if (liveBuild && liveBuild !== client.buildNumber) {
      client.buildNumber = liveBuild;
      client.superPropsB64 = _encodeSuperProps(liveBuild);
    }
  } catch (_) { /* non-fatal — keep static fallback */ }
  try {
    const expR = await client.http.get(`${API}/experiments?with_guild_experiments=true`, {
      headers: {
        'User-Agent': UA,
        'X-Super-Properties': client.superPropsB64,
        'X-Discord-Locale': 'en-US',
        'X-Discord-Timezone': 'UTC',
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/login',
      },
    });
    const fp = expR.headers?.['x-fingerprint'] || expR.data?.fingerprint;
    if (fp) client.fingerprint = String(fp);
  } catch (_) { /* non-fatal — fingerprint is best-effort */ }
  try {
    await client.http.get(`${API}/auth/location-metadata`, {
      headers: {
        'User-Agent': UA,
        'X-Super-Properties': client.superPropsB64,
        'X-Discord-Locale': 'en-US',
        'X-Fingerprint': client.fingerprint || undefined,
        'Origin': 'https://discord.com',
        'Referer': 'https://discord.com/login',
      },
    });
  } catch (_) { /* non-fatal */ }
  client.warmedUp = true;
  client.currentPage = 'https://discord.com/login';
}

// ─────────────────────────────────────────────────────────────────
// Behavioural simulation: post-login browsing
// After a fresh login Chrome opens discord.com/channels/@me and immediately
// fires a constellation of GETs to render the app shell (settings, library,
// guilds, affinities, etc). Skipping all of that and going straight to
// /api/v9/teams is one of Discord's strongest "automated client" signals.
//
// We page through the same endpoints with small human-ish delays. We don't
// care about the responses — only that the telemetry pattern Discord sees
// matches a real session before we touch the developer-portal endpoints.
// ─────────────────────────────────────────────────────────────────
async function simulateBrowsing({ client, token, netOpts = {} }) {
  if (!client) return;
  // Land on the main app first — all subsequent API calls will use this Referer.
  await navigateTo({ client, page: 'https://discord.com/channels/@me' });
  await _humanDelay(900, 2200);
  // The actual telemetry burst Chrome fires within ~5–10s of landing on @me.
  const calls = [
    '/users/@me',
    '/users/@me/settings',
    '/users/@me/connections',
    '/users/@me/library',
    '/users/@me/billing/payment-sources',
    '/users/@me/billing/subscriptions',
    '/users/@me/guilds?with_counts=true',
    '/users/@me/affinities/users',
    '/users/@me/affinities/guilds',
    '/users/@me/relationships',
    '/applications/detectable',
  ];
  for (const path of calls) {
    try {
      await _request({ method: 'GET', url: API + path, token, netOpts: { ...netOpts, client } });
    } catch (_) { /* tolerate failures — best effort */ }
    await _humanDelay(180, 600);
  }
}

// HTML-style navigation. Updates `client.currentPage` so every subsequent API
// call carries the Referer the real browser would send from this page. Also
// sends the `sec-fetch-*` headers Chrome uses for top-level navigations, which
// is what plants the cookies the dev portal needs (e.g. _gcl_au, _ga).
async function navigateTo({ client, page, netOpts = {} }) {
  if (!client) return;
  const url = page.startsWith('http') ? page : 'https://discord.com' + page;
  try {
    await client.http.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': client.currentPage || 'https://discord.com/channels/@me',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        'sec-ch-ua': '"Not_A Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
    });
  } catch (_) { /* non-fatal */ }
  client.currentPage = url;
}

// "Open a new tab and load the Developer Portal." Once this runs, future API
// calls naturally carry Referer=https://discord.com/developers/applications,
// matching what Chrome sends from the real dev portal SPA.
async function loadDevPortal({ client, token, netOpts = {} }) {
  if (!client) return;
  await navigateTo({ client, page: 'https://discord.com/developers/applications' });
  await _humanDelay(900, 2000);
  // The dev portal SPA fires these on load.
  try { await _request({ method: 'GET', url: `${API}/applications?with_team_applications=true`, token, netOpts: { ...netOpts, client } }); } catch (_) {}
  await _humanDelay(150, 450);
  try { await _request({ method: 'GET', url: `${API}/teams`, token, netOpts: { ...netOpts, client } }); } catch (_) {}
  await _humanDelay(150, 450);
  try { await _request({ method: 'GET', url: `${API}/users/@me`, token, netOpts: { ...netOpts, client } }); } catch (_) {}
  await _humanDelay(300, 800);
  client.devPortalLoaded = true;
}

// Sleep helpers — Discord's anti-bot tolerates more delay than rapid-fire calls.
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _humanDelay(min = 800, max = 2200) {
  return _sleep(Math.floor(min + Math.random() * (max - min)));
}

// ─────────────────────────────────────────────────────────────────
// TOTP (RFC 6238) — base32 secret → 6-digit code
// ─────────────────────────────────────────────────────────────────
function _base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of cleaned) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret, step = 30, digits = 6, t = Date.now()) {
  const key = _base32Decode(secret);
  if (!key.length) throw new Error('Invalid 2FA secret');
  const counter = Math.floor(t / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[off] & 0x7f) << 24) |
    ((hmac[off + 1] & 0xff) << 16) |
    ((hmac[off + 2] & 0xff) << 8) |
    (hmac[off + 3] & 0xff);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function isValidTotpSecret(s) {
  try { return _base32Decode(s).length >= 10; } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────
// HTTP wrapper
// ─────────────────────────────────────────────────────────────────
function _headers(client, token, extra) {
  // Referer always reflects the simulated browser's current page. This is
  // critical: a POST /api/v9/teams from Referer=/channels/@me looks fake
  // (the dev portal lives on a different SPA at /developers).
  const referer = client?.currentPage || 'https://discord.com/channels/@me';
  return {
    'Authorization': token || undefined,
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'X-Super-Properties': client?.superPropsB64 || _encodeSuperProps(),
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'UTC',
    'X-Debug-Options': 'bugReporterEnabled',
    'X-Fingerprint': client?.fingerprint || undefined,
    'Origin': 'https://discord.com',
    'Referer': referer,
    ...(extra || {}),
  };
}

// Detect whether a Discord response is asking us to solve a captcha. Discord
// returns { captcha_key: [...], captcha_sitekey, captcha_service, captcha_rqdata?, captcha_rqtoken? }
// and the HTTP status is usually 400. We treat it uniformly across all endpoints.
function _isCaptchaChallenge(d) {
  return !!(d && (d.captcha_key || d.captcha_sitekey) && (Array.isArray(d.captcha_key) ? d.captcha_key.length : true));
}

async function _request({ method, url, token, body, netOpts = {}, mfa, _retry = 0, _captchaTries = 0 }) {
  // Strip our internal opts before handing to axios
  const { solveCaptcha, captchaContext, client: passedClient, ...axiosNetOpts } = netOpts || {};
  // Resolve which axios instance to use: a session-scoped client (with cookie
  // jar + warmed fingerprint) when provided, else fall back to the global axios.
  const client = passedClient || null;
  const httpClient = client?.http || axios;
  const opts = {
    method,
    url,
    headers: _headers(client, token, mfa ? { 'X-Discord-MFA-Authorization': mfa } : null),
    data: body,
    timeout: 25000,
    validateStatus: () => true,
    // `text` so axios still hands us the body as a string when Discord/CF
    // returns a non-JSON error page (HTML challenge, plain-text "Cloudflare
    // ray" page, etc). Without this, axios would throw on parse and we'd
    // lose the only useful diagnostic.
    transitional: { silentJSONParsing: true, forcedJSONParsing: true },
    responseType: 'json',
    ...axiosNetOpts,
  };
  for (const k of Object.keys(opts.headers)) if (opts.headers[k] == null) delete opts.headers[k];
  const r = await httpClient(opts);

  // Capture an X-Fingerprint Discord might assign on a hot endpoint, in case
  // warmUp didn't get one (e.g. /experiments was rate-limited).
  if (client && !client.fingerprint && r.headers?.['x-fingerprint']) {
    client.fingerprint = String(r.headers['x-fingerprint']);
  }

  // Auto-retry on 429 (Cloudflare / Discord rate-limit). Discord's body usually
  // contains { retry_after: <seconds> }; CF uses the Retry-After header.
  if (r.status === 429 && _retry < 3) {
    const bodyWait = Number(r.data?.retry_after) || 0;
    const headerWait = Number(r.headers?.['retry-after']) || 0;
    const waitSec = Math.min(60, Math.max(bodyWait, headerWait, 2));
    await new Promise(res => setTimeout(res, Math.ceil(waitSec * 1000)));
    return _request({ method, url, token, body, netOpts, mfa, _retry: _retry + 1, _captchaTries });
  }

  // Captcha challenge — Discord wants us to solve hCaptcha before continuing.
  // Only ONE retry per request: solving the same challenge twice in a row is a
  // strong automation signal and Discord's heuristics flag the account.
  if (_isCaptchaChallenge(r.data) && _captchaTries < 1) {
    const sitekey = r.data.captcha_sitekey || r.data.captcha_session_id || null;
    const service = r.data.captcha_service || 'hcaptcha';
    const rqdata = r.data.captcha_rqdata || null;
    const rqtoken = r.data.captcha_rqtoken || null;
    if (typeof solveCaptcha === 'function' && sitekey) {
      let solved = null;
      try {
        solved = await solveCaptcha({
          sitekey,
          service,
          rqdata,
          rqtoken,
          url,
          context: captchaContext || 'discord',
        });
      } catch (e) {
        throw new DiscordError('Captcha solving failed: ' + (e?.message || e), {
          code: 'CAPTCHA_FAILED', status: r.status, data: r.data,
        });
      }
      if (solved && typeof solved === 'string') {
        const newBody = {
          ...(body || {}),
          captcha_key: solved,
        };
        if (rqtoken) newBody.captcha_rqtoken = rqtoken;
        return _request({
          method, url, token, body: newBody, netOpts, mfa,
          _retry, _captchaTries: _captchaTries + 1,
        });
      }
    }
    throw new DiscordError(
      'Discord requested a captcha challenge and no solver is available. Configure an hCaptcha service key or solve it manually.',
      { code: 'CAPTCHA_REQUIRED', status: r.status, data: { sitekey, service, rqdata, rqtoken } }
    );
  }

  return { status: r.status, data: r.data, headers: r.headers };
}

class DiscordError extends Error {
  constructor(message, { code, status, data } = {}) {
    super(message);
    this.code = code || '';
    this.status = status || 0;
    this.data = data;
  }
}

function _flattenDiscordErrors(errors, depth = 0) {
  // Walks Discord's nested error tree { foo: { _errors: [{ code, message }] } }
  // and returns a flat "field: msg" array. Caps depth to avoid runaway recursion.
  if (!errors || typeof errors !== 'object' || depth > 6) return [];
  const out = [];
  if (Array.isArray(errors._errors)) {
    for (const e of errors._errors) {
      if (e?.message) out.push(e.message);
      else if (typeof e === 'string') out.push(e);
    }
  }
  for (const [k, v] of Object.entries(errors)) {
    if (k === '_errors' || !v || typeof v !== 'object') continue;
    const nested = _flattenDiscordErrors(v, depth + 1);
    for (const m of nested) out.push(`${k}: ${m}`);
  }
  return out;
}

function _errFromResponse(prefix, r) {
  const d = r?.data;
  let msg = d?.message || `HTTP ${r.status}`;
  // Always surface nested field errors when Discord returned them — even if
  // a top-level "message" is also present. Discord's "Invalid Form Body" is
  // useless without the nested details.
  if (d?.errors && typeof d.errors === 'object') {
    const details = _flattenDiscordErrors(d.errors).slice(0, 4);
    if (details.length) msg = `${msg} — ${details.join('; ')}`;
  }
  if (d?.code) msg = `${msg} [code ${d.code}]`;
  // ─────────────────────────────────────────────────────────────
  // Last-resort body dump. When Discord returns a 4xx with neither a
  // "message" nor an "errors" tree, the previous logic produced uselessly
  // generic "HTTP 400" output. Surface up to 300 chars of whatever the body
  // actually was (JSON object → keys, raw text/HTML → first chunk) so the
  // operator can see if it's a Cloudflare block page, a captcha challenge
  // we missed, a phone-required block, etc.
  // ─────────────────────────────────────────────────────────────
  const looksLikeMissingDetail = !d?.message && !(d?.errors && Object.keys(d.errors).length);
  if (looksLikeMissingDetail) {
    let extra = '';
    if (typeof d === 'string') {
      extra = d.replace(/\s+/g, ' ').slice(0, 300);
    } else if (d && typeof d === 'object') {
      const keys = Object.keys(d);
      if (keys.length) {
        try { extra = JSON.stringify(d).slice(0, 300); }
        catch { extra = 'keys=' + keys.join(','); }
      }
    }
    if (extra) msg += ` — body: ${extra}`;
  }
  // Server-side console dump so logs always carry the FULL response for
  // post-mortem analysis, even when the user-facing message is truncated.
  try {
    const ct = r?.headers?.['content-type'] || '';
    /* eslint-disable no-console */
    console.error(`[trueStudio][${prefix}] HTTP ${r.status} content-type=${ct}`);
    if (d) console.error('[trueStudio][body]', typeof d === 'string' ? d.slice(0, 1000) : d);
    /* eslint-enable no-console */
  } catch (_) { /* never let logging itself throw */ }
  return new DiscordError(`${prefix}: ${msg}`, { code: d?.code, status: r.status, data: d });
}

// ─────────────────────────────────────────────────────────────────
// Authentication
// ─────────────────────────────────────────────────────────────────
async function login({ email, password, totpSecret, netOpts = {} }) {
  if (!email || !password) throw new Error('Email and password are required');
  // Use a session-scoped client so cookies & X-Fingerprint persist. If the
  // caller already passed a client (multi-step session), reuse it.
  if (!netOpts.client) netOpts = { ...netOpts, client: createClient() };
  // Pre-warm: visit discord.com/login → /experiments → /auth/location-metadata
  // to obtain cookies + X-Fingerprint before sending credentials. A real user
  // never POSTs /auth/login as their first network request.
  await warmUpClient(netOpts.client);
  // A small human-like pause between "page loaded" and "form submitted"
  await _humanDelay(700, 1800);

  // Tag the captcha context so the solver UI can show "Login captcha for foo@bar"
  const loginNetOpts = { ...(netOpts || {}), captchaContext: 'login:' + email };
  const r1 = await _request({
    method: 'POST',
    url: `${API}/auth/login`,
    token: null,
    body: {
      login: email,
      password,
      undelete: false,
      login_source: null,
      gift_code_sku_id: null,
    },
    netOpts: loginNetOpts,
  });

  // Captcha was already handled inside _request via the solver callback.
  // If we still see one here, _request exhausted retries and threw — never get here.
  if (r1.status >= 400 && !r1.data?.mfa) throw _errFromResponse('Login failed', r1);

  // MFA required: send TOTP. Retries up to 2 times: if Discord rejects the
  // code (60008 / "Invalid two-factor code") we wait until the next 30-sec
  // TOTP window and try a freshly generated code. This handles small clock
  // drift and Discord's anti-replay rejection of recently-used codes.
  if (r1.data?.mfa && r1.data?.ticket) {
    if (!totpSecret) throw new DiscordError('Account requires 2FA but no TOTP secret was provided', { code: 'MFA_REQUIRED' });
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        // Wait until the start of the next 30-sec TOTP window so we generate
        // a different code than the one Discord just rejected.
        const msIntoStep = Date.now() % 30000;
        const waitMs = 30000 - msIntoStep + 1500; // +1.5s into the new window
        await new Promise(res => setTimeout(res, Math.min(waitMs, 32000)));
      }
      const code = generateTOTP(totpSecret);
      const r2 = await _request({
        method: 'POST',
        url: `${API}/auth/mfa/totp`,
        token: null,
        body: {
          ticket: r1.data.ticket,
          code,
          login_source: null,
          gift_code_sku_id: null,
        },
        netOpts,
      });
      if (r2.status < 400 && r2.data?.token) {
        return { token: r2.data.token, userId: r2.data.user_id || null };
      }
      lastErr = _errFromResponse('MFA verification failed', r2);
      // Only retry on the specific "invalid code" error (60008). Anything else
      // (account locked, bad ticket, etc.) is permanent — fail fast.
      if (r2.data?.code !== 60008) break;
    }
    throw lastErr || new DiscordError('MFA verification failed', { code: 'MFA_FAILED' });
  }

  if (!r1.data?.token) throw new DiscordError('Login response did not include a token', { code: 'NO_TOKEN', status: r1.status, data: r1.data });
  return { token: r1.data.token, userId: r1.data.user_id || null };
}

// Pre-flight check — log into Discord and immediately fetch /users/@me to
// confirm the credentials are valid, the account is healthy, and (when a TOTP
// secret was supplied) MFA works. Returns a small status object the UI can
// surface as a "verified" badge. Does NOT create teams or bots.
async function verifyAccount({ email, password, totpSecret, netOpts = {} }) {
  const out = { ok: false, status: 'unknown', message: '', user: null, mfa: false, at: Date.now(), client: null };
  // If no client passed, allocate one and return it so the caller can reuse
  // the warmed jar for the next session — avoids a second cold login.
  if (!netOpts.client) netOpts = { ...netOpts, client: createClient() };
  out.client = netOpts.client;
  try {
    const { token, userId } = await login({ email, password, totpSecret, netOpts });
    const r = await _request({ method: 'GET', url: `${API}/users/@me`, token, netOpts });
    if (r.status >= 400) {
      out.status = 'token_unusable';
      out.message = `Login succeeded but /users/@me returned ${r.status}`;
      return out;
    }
    out.ok = true;
    out.status = 'verified';
    out.user = {
      id: r.data?.id || userId || null,
      username: r.data?.username || '',
      globalName: r.data?.global_name || '',
      mfa_enabled: !!r.data?.mfa_enabled,
      verified: !!r.data?.verified,
    };
    out.mfa = !!totpSecret;
    out.message = 'Account verified';
    return out;
  } catch (e) {
    out.status = e.code || 'login_failed';
    out.message = e.message || String(e);
    return out;
  }
}

// Acquire an MFA "X-Discord-MFA-Authorization" cookie for sensitive ops.
// Some endpoints (app/team deletion, transferring ownership, etc.) require
// an MFA-backed authorization header rather than a plain token.
async function acquireMfa({ token, totpSecret, netOpts = {} }) {
  if (!totpSecret) return null;
  // Same TOTP retry logic as login(): one retry across the next 30-sec window
  // if Discord rejects the first code as invalid (60008).
  let lastStatus = 0;
  let lastData = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      const msIntoStep = Date.now() % 30000;
      const waitMs = 30000 - msIntoStep + 1500;
      await new Promise(res => setTimeout(res, Math.min(waitMs, 32000)));
    }
    const r = await _request({
      method: 'POST',
      url: `${API}/users/@me/mfa/totp/verify`,
      token,
      body: { code: generateTOTP(totpSecret) },
      netOpts,
    });
    if (r.status < 400 && r.data?.token) return r.data.token;
    lastStatus = r.status;
    lastData = r.data;
    if (r.data?.code !== 60008) break;
  }
  // Soft-fail: caller decides whether to abort. We log via thrown DiscordError
  // only when explicitly desired by callers; here we return null to keep the
  // existing "MFA is optional" semantics for sessions that don't need it.
  if (lastStatus) {
    const e = new DiscordError(
      'Acquire MFA failed: ' + (lastData?.message || `HTTP ${lastStatus}`),
      { code: lastData?.code || 'MFA_ACQUIRE_FAILED', status: lastStatus, data: lastData }
    );
    e.softFail = true;
    throw e;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Teams
// ─────────────────────────────────────────────────────────────────
async function createTeam({ token, name, netOpts = {} }) {
  const r = await _request({
    method: 'POST',
    url: `${API}/teams`,
    token,
    body: { name: String(name || 'Team').slice(0, 50) },
    netOpts,
  });
  if (r.status >= 400 || !r.data?.id) throw _errFromResponse('Create team failed', r);
  return { id: r.data.id, name: r.data.name };
}

async function listTeams({ token, netOpts = {} }) {
  const r = await _request({ method: 'GET', url: `${API}/teams`, token, netOpts });
  if (r.status >= 400) throw _errFromResponse('List teams failed', r);
  return r.data || [];
}

// ─────────────────────────────────────────────────────────────────
// Applications & bots
// ─────────────────────────────────────────────────────────────────
async function listApplications({ token, netOpts = {} }) {
  const r = await _request({ method: 'GET', url: `${API}/applications?with_team_applications=true`, token, netOpts });
  if (r.status >= 400) throw _errFromResponse('List apps failed', r);
  return r.data || [];
}

async function createApplication({ token, name, teamId = null, netOpts = {} }) {
  const body = { name: String(name || 'App').slice(0, 32) };
  if (teamId) body.team_id = teamId;
  const r = await _request({ method: 'POST', url: `${API}/applications`, token, body, netOpts });
  if (r.status >= 400 || !r.data?.id) throw _errFromResponse('Create app failed', r);
  return r.data; // { id, name, bot, ... }
}

async function ensureBot({ token, appId, netOpts = {} }) {
  // Convert an application into a bot (idempotent — Discord returns 400 if
  // already a bot, in which case we just fetch the existing bot user).
  const r = await _request({
    method: 'POST',
    url: `${API}/applications/${appId}/bot`,
    token,
    body: {},
    netOpts,
  });
  if (r.status >= 400 && r.status !== 400) throw _errFromResponse('Convert to bot failed', r);
  // Always fetch app to get the bot.user data
  const r2 = await _request({ method: 'GET', url: `${API}/applications/${appId}`, token, netOpts });
  if (r2.status >= 400) throw _errFromResponse('Fetch app failed', r2);
  return r2.data;
}

async function resetBotToken({ token, appId, mfa = null, netOpts = {} }) {
  const r = await _request({
    method: 'POST',
    url: `${API}/applications/${appId}/bot/reset`,
    token,
    body: {},
    mfa,
    netOpts,
  });
  if (r.status >= 400 || !r.data?.token) throw _errFromResponse('Reset bot token failed', r);
  return r.data.token;
}

async function transferAppToTeam({ token, appId, teamId, mfa = null, netOpts = {} }) {
  const r = await _request({
    method: 'POST',
    url: `${API}/applications/${appId}/transfer`,
    token,
    body: { team_id: teamId },
    mfa,
    netOpts,
  });
  if (r.status >= 400) throw _errFromResponse('Transfer app failed', r);
  return r.data;
}

// ─────────────────────────────────────────────────────────────────
// High-level session — orchestrates the full automation per request
// ─────────────────────────────────────────────────────────────────
function makeSession() {
  return {
    state: 'idle',           // idle | running | waiting | done | cancelled | error
    account: null,           // email of the active account
    rules: { createTeams: false, createBots: true, linkBots: false },
    total: 0,
    done: 0,
    failed: 0,
    current: '',
    log: [],                 // [{ ts, level, msg }]
    teamId: null,
    teamName: null,
    waitUntilTs: 0,          // epoch ms — 0 if not waiting
    waitTotalMs: 0,          // total ms of the current wait period
    startedAt: 0,
    finishedAt: 0,
    cancelRequested: false,
    bots: [],                // [{ name, appId, botUserId, token }]
    lastError: null,
  };
}

module.exports = {
  generateTOTP,
  isValidTotpSecret,
  login,
  verifyAccount,
  acquireMfa,
  createTeam,
  listTeams,
  listApplications,
  createApplication,
  ensureBot,
  resetBotToken,
  transferAppToTeam,
  makeSession,
  DiscordError,
  createClient,
  warmUpClient,
  fetchBuildNumber,
  simulateBrowsing,
  navigateTo,
  loadDevPortal,
  humanDelay: _humanDelay,
};
