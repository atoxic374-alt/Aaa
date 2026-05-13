/**
 * Multi-Account DM Engine — Maximum Speed + Full Rate Limit Protection
 * Architecture: Shared atomic queue, per-worker adaptive delay, pause/resume, persistence
 */

const fs   = require('fs');
const path = require('path');

const BASE = 'https://discord.com/api/v9';

const X_SUPER_PROPS = Buffer.from(JSON.stringify({
  os: 'Windows', browser: 'Chrome', device: '',
  system_locale: 'en-US',
  browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  browser_version: '124.0.0.0', os_version: '10',
  referrer: '', referring_domain: '', referrer_current: '', referring_domain_current: '',
  release_channel: 'stable', client_build_number: 340000, client_event_source: null
})).toString('base64');

function makeHeaders(token) {
  return {
    'Authorization': token.trim(),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'X-Super-Properties': X_SUPER_PROPS,
    'X-Discord-Locale': 'en-US',
    'X-Discord-Timezone': 'America/New_York',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://discord.com',
    'Referer': 'https://discord.com/channels/@me',
    'Sec-CH-UA': '"Not_A Brand";v="8","Chromium";v="124","Google Chrome";v="124"',
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
  constructor(items, startAt = 0) {
    this._items = [...items];
    this._pos   = startAt;
    this._lock  = new Set();
  }
  next() {
    while (this._pos < this._items.length) {
      const item = this._items[this._pos++];
      if (!this._lock.has(item)) { this._lock.add(item); return item; }
    }
    return null;
  }
  get total()     { return this._items.length; }
  get remaining() { return this._items.length - this._pos; }
  get pos()       { return this._pos; }
  get done()      { return this._pos >= this._items.length; }
}

// ── Token Validation ────────────────────────────────────────────────────────
async function validateToken(token) {
  try {
    const res = await fetch(`${BASE}/users/@me`, {
      headers: { ...makeHeaders(token), 'Content-Type': 'application/json' }
    });
    if (res.status === 200) {
      const data = await res.json();
      const avatarUrl = data.avatar
        ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(data.id) >> 22n) % 6n}.png`;
      return { valid: true, username: data.username, id: data.id, globalName: data.global_name, avatar: avatarUrl };
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
    const nonce = String(BigInt(Date.now() - 1420070400000) << 22n);
    const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { ...makeHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, nonce, tts: false })
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
      const buf  = Buffer.from(img.data, 'base64');
      const blob = new Blob([buf], { type: img.type || 'image/png' });
      fd.append(`files[${i}]`, blob, img.name);
    });
    const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: makeHeaders(token),
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

// ── Speed presets ────────────────────────────────────────────────────────────
const SPEED_PRESETS = {
  safe:   { min: 1100, start: 1400, max: 8000 },
  normal: { min:  750, start:  950, max: 6000 },
  fast:   { min:  480, start:  650, max: 4000 },
};

// ── Worker ──────────────────────────────────────────────────────────────────
class Worker {
  constructor(acc, queue, job) {
    this.token  = acc.token.trim();
    this.name   = acc.name || 'Account';
    this.queue  = queue;
    this.job    = job;
    this.dead   = false;

    const preset      = SPEED_PRESETS[job.speedMode] || SPEED_PRESETS.normal;
    this.delay        = preset.start;
    this.minDelay     = preset.min;
    this.maxDelay     = preset.max;
    this.successStreak = 0;

    this.sent        = 0;
    this.failed      = 0;
    this.skipped     = 0;
    this.rateLimited = 0;
    this.status      = 'idle';
    this.lastRL      = 0;
    this.currentUserId = null;
  }

  _adjustDelay(success) {
    if (success) {
      this.successStreak++;
      if (this.successStreak >= 4) {
        this.delay = Math.max(this.minDelay, Math.floor(this.delay * 0.92));
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
      // ── Pause support ────────────────────────────────────────────────────
      while (this.job.paused && !this.job.stopped) {
        this.status = 'paused';
        await sleep(300);
      }
      if (this.job.stopped) break;

      const userId = this.queue.next();
      if (userId === null) break;

      this.currentUserId = userId;
      let success  = false;
      let retries  = 0;
      const maxRetries = 3;

      while (!success && retries < maxRetries && !this.job.stopped && !this.dead) {
        // Respect pause mid-retry too
        while (this.job.paused && !this.job.stopped) {
          this.status = 'paused';
          await sleep(300);
        }
        if (this.job.stopped) break;

        await sleep(this.delay);

        // ── Create DM Channel ────────────────────────────────────────────
        this.status = 'opening DM';
        const chRes = await createDMChannel(this.token, userId);

        if (chRes.status === 401) {
          this.dead   = true;
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
          // DMs disabled / user blocked — permanently skip
          this.skipped++;
          this.job.emitActivity({ worker: this.name, userId, result: 'skipped', reason: 'DMs closed' });
          break;
        }
        if (chRes.status !== 200 && chRes.status !== 201) {
          retries++;
          await sleep(900 + retries * 300);
          continue;
        }

        const channelId = chRes.data.id;

        // ── Send Message ─────────────────────────────────────────────────
        this.status = 'sending';
        const sendRes = await sendMessage(this.token, channelId, this.job.message, this.job.images);

        if (sendRes.status === 200 || sendRes.status === 201) {
          success = true;
          this.sent++;
          this.job.sent++;
          this.job.done++;
          this._adjustDelay(true);
          this.status = 'running';
          this.job.emitActivity({ worker: this.name, userId, result: 'sent' });
        } else if (sendRes.status === 401) {
          this.dead   = true;
          this.status = 'dead (401)';
          this.job.broadcast();
          return;
        } else if (sendRes.status === 429) {
          const wait = this._handleRateLimit(sendRes.data);
          await sleep(wait);
        } else if (sendRes.data?.code === 50007) {
          // Cannot send messages to this user
          this.skipped++;
          this.job.emitActivity({ worker: this.name, userId, result: 'skipped', reason: 'Cannot DM user' });
          break;
        } else if (sendRes.data?.code === 40003) {
          // Explicit content cannot be sent
          this.skipped++;
          this.job.emitActivity({ worker: this.name, userId, result: 'skipped', reason: 'Content blocked' });
          break;
        } else {
          retries++;
          this._adjustDelay(false);
          await sleep(900 + retries * 400);
        }
      }

      if (!success && !this.dead) {
        this.failed++;
        this.job.failed++;
        this.job.done++;
        this._adjustDelay(false);
        this.job.emitActivity({ worker: this.name, userId, result: 'failed' });
      }

      this.currentUserId = null;
      this.job.broadcast();
      // Save checkpoint periodically
      if ((this.sent + this.failed) % 10 === 0) this.job.saveCheckpoint();
    }

    this.status = this.dead ? 'dead (401)' : (this.job.stopped ? 'stopped' : 'done');
    this.job.broadcast();
  }

  _handleRateLimit(data) {
    const retryAfter = data?.retry_after ?? 2;
    const isGlobal   = data?.global === true;
    const waitMs     = Math.ceil(retryAfter * 1000) + (isGlobal ? 2000 : 800);
    this.rateLimited++;
    this.lastRL  = Math.ceil(waitMs / 1000);
    this.status  = `rate-limited ${this.lastRL}s${isGlobal ? ' (global)' : ''}`;
    this.delay   = Math.min(this.maxDelay, Math.floor(this.delay * 1.9));
    this.job.broadcast();
    return waitMs;
  }
}

// ── Job ──────────────────────────────────────────────────────────────────────
class MultiDMJob {
  constructor(jobId, accountList, members, message, images, speedMode = 'normal', savedState = null) {
    this.jobId      = jobId;
    this.message    = message;
    this.images     = images;
    this.speedMode  = speedMode;
    this.stopped    = false;
    this.paused     = false;
    this._broadcast = null;
    this._actBroadcast = null;
    this.startedAt  = savedState?.startedAt  || Date.now();
    this.finishedAt = savedState?.finishedAt || null;

    const resumeAt = savedState?.done || 0;

    this.total  = members.length;
    this.sent   = savedState?.sent   || 0;
    this.failed = savedState?.failed || 0;
    this.done   = savedState?.done   || 0;

    this._queue   = new SharedQueue(members, resumeAt);
    this._workers = accountList.map(acc => new Worker(acc, this._queue, this));

    this._checkpointPath = savedState?._checkpointPath || null;
  }

  setCheckpointPath(p) { this._checkpointPath = p; }

  saveCheckpoint() {
    if (!this._checkpointPath) return;
    try {
      const data = {
        jobId: this.jobId, total: this.total, sent: this.sent,
        failed: this.failed, done: this.done,
        startedAt: this.startedAt, finishedAt: this.finishedAt,
        speedMode: this.speedMode, queuePos: this._queue.pos,
        _checkpointPath: this._checkpointPath
      };
      fs.writeFileSync(this._checkpointPath, JSON.stringify(data, null, 2));
    } catch {}
  }

  emitActivity(entry) {
    if (this._actBroadcast) {
      try { this._actBroadcast({ type: 'activity', ...entry, ts: Date.now() }); } catch {}
    }
  }

  broadcast() {
    if (this._broadcast) {
      try { this._broadcast({ type: 'state', ...this.getState() }); } catch {}
    }
  }

  getState() {
    const elapsed = Math.max(1, (Date.now() - this.startedAt) / 1000);
    const speed   = (this.done / elapsed).toFixed(2);
    const rem     = this.total - this.done;
    const eta     = +speed > 0 ? Math.ceil(rem / +speed) : null;
    const alive   = this._workers.filter(w => !w.dead).length;
    const allDone = this._workers.every(w =>
      ['done', 'stopped', 'dead (401)', 'paused'].includes(w.status) || this.job?.stopped
    );
    const finished = this.done >= this.total || this._workers.every(w =>
      ['done', 'stopped', 'dead (401)'].includes(w.status));

    return {
      jobId: this.jobId,
      total: this.total, sent: this.sent, failed: this.failed, done: this.done,
      alive, finished, stopped: this.stopped, paused: this.paused,
      elapsed: Math.floor(elapsed), speed, eta,
      speedMode: this.speedMode,
      startedAt: this.startedAt, finishedAt: this.finishedAt,
      workers: this._workers.map(w => ({
        name:          w.name,
        tokenTail:     w.token.slice(-6),
        sent:          w.sent,
        failed:        w.failed,
        skipped:       w.skipped,
        rateLimited:   w.rateLimited,
        status:        w.status,
        delay:         w.delay,
        dead:          w.dead,
        currentUserId: w.currentUserId,
      }))
    };
  }

  async start(broadcastFn, activityFn) {
    this._broadcast    = broadcastFn;
    this._actBroadcast = activityFn;
    this.broadcast();
    await Promise.all(this._workers.map(w => w.run()));
    this.finishedAt = Date.now();
    this.saveCheckpoint();
    this.broadcast();
  }

  pause() {
    if (this.stopped) return;
    this.paused = true;
    this._workers.forEach(w => { if (!w.dead && w.status !== 'done') w.status = 'paused'; });
    this.broadcast();
  }

  resume() {
    if (this.stopped) return;
    this.paused = false;
    this._workers.forEach(w => { if (w.status === 'paused') w.status = 'running'; });
    this.broadcast();
  }

  stop() {
    this.stopped = true;
    this.paused  = false;
    this._workers.forEach(w => {
      if (!['done', 'dead (401)', 'stopped'].includes(w.status)) w.status = 'stopping...';
    });
    this.saveCheckpoint();
    this.broadcast();
  }
}

// ── Exports ──────────────────────────────────────────────────────────────────
async function validateAccounts(accountList) {
  return Promise.all(accountList.map(async acc => {
    const res = await validateToken(acc.token.trim());
    return { ...acc, ...res };
  }));
}

function createJob(jobId, accountList, members, message, images, speedMode, savedState) {
  return new MultiDMJob(jobId, accountList, members, message, images, speedMode, savedState);
}

module.exports = { createJob, validateAccounts, SPEED_PRESETS };
