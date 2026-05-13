const BASE = 'https://discord.com/api/v9';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeHeaders(token) {
  return {
    'Authorization': token,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'X-Discord-Locale': 'en-US',
  };
}

async function createDMChannel(token, userId) {
  try {
    const res = await fetch(`${BASE}/users/@me/channels`, {
      method: 'POST',
      headers: { ...makeHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: userId })
    });
    const data = await res.json();
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { message: e.message } };
  }
}

async function sendMessageToChannel(token, channelId, content, images) {
  try {
    if (images && images.length > 0) {
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
        headers: makeHeaders(token),
        body: fd
      });
      const data = await res.json();
      return { status: res.status, data };
    } else {
      const res = await fetch(`${BASE}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { ...makeHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      const data = await res.json();
      return { status: res.status, data };
    }
  } catch (e) {
    return { status: 0, data: { message: e.message } };
  }
}

class MultiDMJob {
  constructor(jobId, accountList, members, message, images) {
    this.jobId = jobId;
    this.accountList = accountList;
    this.members = members;
    this.message = message;
    this.images = images;
    this.stopped = false;
    this.broadcast = null;

    this.total = members.length;
    this.sent = 0;
    this.failed = 0;
    this.done = 0;
    this.workersDone = 0;
    this.startedAt = Date.now();
    this.finishedAt = null;

    this.memberLock = new Set();

    this.chunks = this._distribute(members, accountList.length);

    this.workerStats = accountList.map((acc, i) => ({
      index: i,
      name: acc.name || `Account ${i + 1}`,
      tokenTail: acc.token.slice(-6),
      total: this.chunks[i].length,
      sent: 0,
      failed: 0,
      rateLimited: 0,
      status: 'idle',
      delay: 900,
      currentUser: null,
      lastRateLimitWait: 0
    }));
  }

  _distribute(members, n) {
    const chunks = Array.from({ length: n }, () => []);
    members.forEach((m, i) => chunks[i % n].push(m));
    return chunks;
  }

  getState() {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const speed = elapsed > 0 ? (this.done / elapsed).toFixed(2) : 0;
    const remaining = this.total - this.done;
    const eta = speed > 0 ? Math.ceil(remaining / speed) : null;
    const allDone = this.workersDone >= this.accountList.length;
    return {
      total: this.total,
      sent: this.sent,
      failed: this.failed,
      done: this.done,
      workers: this.workerStats,
      finished: allDone,
      stopped: this.stopped,
      elapsed,
      speed,
      eta,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt
    };
  }

  async start(broadcast) {
    this.broadcast = broadcast;
    broadcast({ type: 'state', ...this.getState() });

    await Promise.all(
      this.accountList.map((acc, i) => this._runWorker(acc.token, i))
    );

    this.finishedAt = Date.now();
    this.workerStats.forEach(w => {
      if (w.status === 'running') w.status = 'done';
    });
    broadcast({ type: 'state', ...this.getState() });
  }

  async _runWorker(token, idx) {
    const stats = this.workerStats[idx];
    const chunk = this.chunks[idx];
    stats.status = 'running';
    this.broadcast({ type: 'state', ...this.getState() });

    for (const userId of chunk) {
      if (this.stopped) break;
      if (this.memberLock.has(userId)) continue;
      this.memberLock.add(userId);

      stats.currentUser = userId;
      let success = false;
      let retries = 0;

      while (!success && retries < 3 && !this.stopped) {
        await sleep(stats.delay);

        const chRes = await createDMChannel(token, userId);

        if (chRes.status === 429) {
          const retryAfter = (chRes.data?.retry_after || 2);
          const waitMs = Math.ceil(retryAfter * 1000) + 600;
          stats.rateLimited++;
          stats.lastRateLimitWait = Math.ceil(waitMs / 1000);
          stats.status = `rate-limited (${stats.lastRateLimitWait}s)`;
          stats.delay = Math.min(5000, Math.floor(stats.delay * 1.7));
          this.broadcast({ type: 'state', ...this.getState() });
          await sleep(waitMs);
          stats.status = 'running';
          continue;
        }

        if (chRes.status === 200 || chRes.status === 201) {
          const channelId = chRes.data.id;
          const sendRes = await sendMessageToChannel(token, channelId, this.message, this.images);

          if (sendRes.status === 200 || sendRes.status === 201) {
            success = true;
            stats.sent++;
            this.sent++;
            this.done++;
            stats.delay = Math.max(700, Math.floor(stats.delay * 0.97));
            stats.status = 'running';
          } else if (sendRes.status === 429) {
            const retryAfter = (sendRes.data?.retry_after || 2);
            const waitMs = Math.ceil(retryAfter * 1000) + 600;
            stats.rateLimited++;
            stats.lastRateLimitWait = Math.ceil(waitMs / 1000);
            stats.status = `rate-limited (${stats.lastRateLimitWait}s)`;
            stats.delay = Math.min(5000, Math.floor(stats.delay * 1.7));
            this.broadcast({ type: 'state', ...this.getState() });
            await sleep(waitMs);
            stats.status = 'running';
          } else {
            retries++;
            await sleep(700);
          }
        } else {
          retries++;
          await sleep(700);
        }
      }

      if (!success) {
        stats.failed++;
        this.failed++;
        this.done++;
      }

      stats.currentUser = null;
      this.broadcast({ type: 'state', ...this.getState() });
    }

    stats.status = this.stopped ? 'stopped' : 'done';
    stats.currentUser = null;
    this.workersDone++;
    this.broadcast({ type: 'state', ...this.getState() });
  }

  stop() {
    this.stopped = true;
    this.workerStats.forEach(w => {
      if (w.status === 'running') w.status = 'stopping...';
    });
    if (this.broadcast) this.broadcast({ type: 'state', ...this.getState() });
  }
}

function createJob(jobId, accountList, members, message, images) {
  return new MultiDMJob(jobId, accountList, members, message, images);
}

module.exports = { createJob };
