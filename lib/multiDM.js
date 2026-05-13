/**
 * Multi-Account DM Engine — Maximum Speed + Full Rate Limit Protection
 * Architecture: Shared atomic queue, per-worker adaptive delay, 401 detection
 */

const BASE = 'https://discord.com/api/v9';

// Real Discord client super-properties (Chrome/Windows)
const X_SUPER_PROPS = Buffer.from(JSON.stringify({
  os: 'Windows',
  browser: 'Chrome',
  device: '',
  system_locale: 'en-US',
  browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  browser_version: '120.0.0.0',
  os_version: '10',
  referrer: '',
  referring_domain: '',
  referrer_current: '',
  referring_domain_current: '',
  release_channel: 'stable',
  client_build_number: 335220,
  client_event_source: null
})).toString('base64');

function makeHeaders(token) {
  const clean = token.trim();
  return {
    'Authorization': clean,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Super-Properties': X_SUPER_PROPS,
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'America/New_York',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://discord.com',
    'Referer': 'https://discord.com/channels/@me',
    'Sec-CH-UA': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Shared Atomic Queue ─────────────────────────────────────────────────────
class SharedQueue {
  constructor(items) {
    this._items = [...items];
    this._pos = 0;
    this._lock = new Set();
  }
  next() {
    while (this._pos < this._items.length) {
      const item = this._items[this._pos++];
      if (!this._lock.has(item)) { this._lock.add(item); return item; }
    }
    return null;
  }
  get total() { return this._items.length; }
  get processed() { return this._pos; }
  get done() { return this._pos >= this._items.length; }
}

// ── Token Validation ────────────────────────────────────────────────────────
async function validateToken(token) {
  try {
    const res = await fetch(`${BASE}/users/@me`, {
      headers: { ...makeHeaders(token), 'Content-Type': 'application/json' }
    });
    if (res.status === 200) {
      const data = await res.json();
      return { valid: true, username: data.username, id: data.id };
    }
    return { valid: false, status: res.status };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ── Discord API Calls ───────────────────────────────────────────────────────
async function createDMChannel(token, userId) {
  try {
    const res = await fetch(`${BASE}/users/@me/channels`, {
      method: 'POST',
      headers: { ...makeHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId })
    });
    const data = await res.json();
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { message: e.message } }; }
}

async function sendText(token, channelId, content) {
  try {
    const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { ...makeHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    const data = await res.json();
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { message: e.message } }; }
}

async function sendWithImages(token, channelId, content, images) {
  try {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({
      content,
      attachments: images.map((img, i) => ({ id: i, filename: img.name }))
    }));
    images.forEach((img, i) => {
      const buf = Buffer.from(img.data, 'base64');
      const blob = new Blob([buf], { type: img.type || 'image/png' });
      fd.append(`files[${i}]`, blob, img.name);
    });
    const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: makeHeaders(token),  // no Content-Type, let browser set multipart boundary
      body: fd
    });
    const data = await res.json();
    return { status: res.status, data };
  } catch (e) { return { status: 0, data: { message: e.message } }; }
}

async function sendMessage(token, channelId, content, images) {
  if (images && images.length > 0) return sendWithImages(token, channelId, content, images);
  return sendText(token, channelId, content);
}

// ── Worker ─────────────────────────────────────────────────────────────────
class Worker {
  constructor(acc, queue, job) {
    this.token = acc.token.trim();
    this.name  = acc.name || 'Account';
    this.queue = queue;
    this.job   = job;
    this.dead  = false; // 401 = token invalid

    // Adaptive delay (ms)
    this.delay        = 950;
    this.minDelay     = 700;
    this.maxDelay     = 6000;
    this.successStreak = 0;

    // Stats
    this.sent       = 0;
    this.failed     = 0;
    this.skipped    = 0;
    this.rateLimited = 0;
    this.status     = 'idle';
    this.lastRL     = 0;
  }

  _adjustDelay(success) {
    if (success) {
      this.successStreak++;
      if (this.successStreak >= 5) {
        this.delay = Math.max(this.minDelay, Math.floor(this.delay * 0.93));
        this.successStreak = 0;
      }
    } else {
      this.successStreak = 0;
    }
  }

  async run() {
    this.status = 'starting';
    this.job.broadcast();

    while (!this.job.stopped && !this.dead) {
      const userId = this.queue.next();
      if (userId === null) break; // queue exhausted

      let success = false;
      let retries = 0;
      const maxRetries = 3;

      while (!success && retries < maxRetries && !this.job.stopped && !this.dead) {
        await sleep(this.delay);

        // ── Create DM Channel ───────────────────────────────────────────
        this.status = 'opening DM';
        const chRes = await createDMChannel(this.token, userId);

        if (chRes.status === 401) {
          this.dead = true;
          this.status = 'dead (401)';
          this.job.broadcast();
          return;
        }

        if (chRes.status === 429) {
          const wait = this._handleRateLimit(chRes.data);
          await sleep(wait);
          continue;
        }

        if (chRes.status === 403 || chRes.status === 400) {
          // User has DMs disabled or blocked — skip permanently
          this.skipped++;
          break;
        }

        if (chRes.status !== 200 && chRes.status !== 201) {
          retries++;
          await sleep(800);
          continue;
        }

        const channelId = chRes.data.id;

        // ── Send Message ────────────────────────────────────────────────
        this.status = 'sending';
        const sendRes = await sendMessage(this.token, channelId, this.job.message, this.job.images);

        if (sendRes.status === 200 || sendRes.status === 201) {
          success = true;
          this.sent++;
          this.job.sent++;
          this.job.done++;
          this._adjustDelay(true);
          this.status = 'running';
        } else if (sendRes.status === 401) {
          this.dead = true;
          this.status = 'dead (401)';
          this.job.broadcast();
          return;
        } else if (sendRes.status === 429) {
          const wait = this._handleRateLimit(sendRes.data);
          await sleep(wait);
        } else if (sendRes.data?.code === 50007) {
          // Cannot send to this user
          this.skipped++;
          break;
        } else {
          retries++;
          this._adjustDelay(false);
          await sleep(900);
        }
      }

      if (!success && !this.dead) {
        this.failed++;
        this.job.failed++;
        this.job.done++;
        this._adjustDelay(false);
      }

      this.job.broadcast();
    }

    this.status = this.dead ? 'dead (401)' : (this.job.stopped ? 'stopped' : 'done');
    this.job.broadcast();
  }

  _handleRateLimit(data) {
    const retryAfter = data?.retry_after ?? 2;
    const isGlobal   = data?.global === true;
    const waitMs     = Math.ceil(retryAfter * 1000) + (isGlobal ? 1500 : 700);
    this.rateLimited++;
    this.lastRL  = Math.ceil(waitMs / 1000);
    this.status  = `rate-limited ${this.lastRL}s${isGlobal ? ' (global)' : ''}`;
    this.delay   = Math.min(this.maxDelay, Math.floor(this.delay * 1.8));
    this.job.broadcast();
    return waitMs;
  }
}

// ── Job ─────────────────────────────────────────────────────────────────────
class MultiDMJob {
  constructor(jobId, accountList, members, message, images) {
    this.jobId      = jobId;
    this.message    = message;
    this.images     = images;
    this.stopped    = false;
    this._broadcast = null;
    this.startedAt  = Date.now();
    this.finishedAt = null;

    this.total    = members.length;
    this.sent     = 0;
    this.failed   = 0;
    this.done     = 0;

    this._queue   = new SharedQueue(members);
    this._workers = accountList.map(acc => new Worker(acc, this._queue, this));
  }

  broadcast() {
    if (this._broadcast) {
      try { this._broadcast({ type: 'state', ...this.getState() }); } catch (e) {}
    }
  }

  getState() {
    const elapsed = Math.max(1, (Date.now() - this.startedAt) / 1000);
    const speed   = (this.done / elapsed).toFixed(2);
    const rem     = this.total - this.done;
    const eta     = speed > 0 ? Math.ceil(rem / speed) : null;
    const alive   = this._workers.filter(w => !w.dead).length;
    const allDone = this._workers.every(w =>
      ['done', 'stopped', 'dead (401)'].includes(w.status));

    return {
      total: this.total,
      sent: this.sent,
      failed: this.failed,
      done: this.done,
      alive,
      finished: allDone,
      stopped: this.stopped,
      elapsed: Math.floor(elapsed),
      speed,
      eta,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      workers: this._workers.map(w => ({
        name:        w.name,
        tokenTail:   w.token.slice(-6),
        sent:        w.sent,
        failed:      w.failed,
        skipped:     w.skipped,
        rateLimited: w.rateLimited,
        status:      w.status,
        delay:       w.delay,
        dead:        w.dead
      }))
    };
  }

  async start(broadcastFn) {
    this._broadcast = broadcastFn;
    this.broadcast();

    await Promise.all(this._workers.map(w => w.run()));

    this.finishedAt = Date.now();
    this.broadcast();
  }

  stop() {
    this.stopped = true;
    this._workers.forEach(w => {
      if (w.status === 'running' || w.status === 'sending' || w.status === 'opening DM') {
        w.status = 'stopping...';
      }
    });
    this.broadcast();
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────
async function validateAccounts(accountList) {
  return Promise.all(accountList.map(async acc => {
    const res = await validateToken(acc.token.trim());
    return { ...acc, ...res };
  }));
}

function createJob(jobId, accountList, members, message, images) {
  return new MultiDMJob(jobId, accountList, members, message, images);
}

module.exports = { createJob, validateAccounts };
