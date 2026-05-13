/* ══════════════════════════════════════════════════════════════
   BlastManager — DM Blast & Server Blast  (fully fixed)
   mode: 'dm' | 'server'
   ══════════════════════════════════════════════════════════════ */
import { showNotification, showConfirm } from '../utils/ui.js';

const STORAGE_KEY = 'blast_active_job';
const DELAYS      = { safe: 1350, normal: 820, fast: 480 };

/* ── helpers ──────────────────────────────────────────────── */
function workerColor(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360},62%,62%)`;
}
const initial = (n = '?') => (n[0] || '?').toUpperCase();

function fmtETA(sec) {
  if (!sec || sec <= 0) return '—';
  if (sec >= 3600) return `~${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60)   return `~${Math.floor(sec / 60)}m${sec % 60}s`;
  return `~${sec}s`;
}

function animNum(el, to) {
  if (!el) return;
  const from = parseInt(el.textContent) || 0;
  if (from === to) return;
  const steps = Math.min(Math.abs(to - from), 14);
  let s = 0;
  const tick = () => { s++; el.textContent = Math.round(from + (to - from) * s / steps); if (s < steps) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

function badgeClass(w) {
  if (w.dead) return 'wbadge-dead';
  if (w.status === 'done') return 'wbadge-done';
  if (w.status === 'paused') return 'wbadge-pause';
  if (w.status?.includes('rate')) return 'wbadge-rl';
  if (w.status === 'stopped' || w.status?.includes('stop')) return 'wbadge-stop';
  if (['running','sending','opening DM'].includes(w.status)) return 'wbadge-run';
  return 'wbadge-idle';
}

const SPEED_META = {
  safe:   { emoji: '🛡️', name: 'Safe',   info: '~1.35s / msg', risk: 'Minimal risk',  riskClass: 'risk-low' },
  normal: { emoji: '⚡',  name: 'Normal', info: '~820ms / msg', risk: 'Balanced',      riskClass: 'risk-med' },
  fast:   { emoji: '🚀',  name: 'Fast',   info: '~480ms / msg', risk: 'Higher risk',   riskClass: 'risk-high' },
};

/* ══════════════════════════════════════════════════════════════ */
export class BlastManager {
  constructor(contentArea, mode) {
    this.contentArea    = contentArea;
    this.mode           = mode;           // 'dm' | 'server'
    this.tokens         = [];
    this.dmContacts     = [];
    this.servers        = [];
    this.serverMembers  = [];
    this.selectedTarget = mode === 'dm' ? 'all' : 'server';
    this.selectedSpeed  = 'normal';
    this.uploadedImages = [];
    this._sse           = null;
    this._actSSE        = null;
    this._jobId         = null;
    this.isSending      = false;
    this._elapsedTimer  = null;
    this._startTs       = 0;
  }

  /* ─── Public entry point ──────────────────────────────────── */
  async init() {
    if (this.isSending) { this._reconnect(); return; }
    this.contentArea.innerHTML = this._loadingHTML();

    try {
      const calls = [window.electronAPI.getTokens()];
      if (this.mode === 'dm')     calls.push(window.electronAPI.getDMs());
      if (this.mode === 'server') calls.push(window.electronAPI.getBlastServers());

      const [tokRes, dataRes] = await Promise.all(calls);
      this.tokens = tokRes.success ? this._deduplicateTokens(tokRes.tokens || []) : [];
      if (this.mode === 'dm')     this.dmContacts = dataRes?.success ? (dataRes.dms || []) : [];
      if (this.mode === 'server') this.servers    = dataRes?.success ? (dataRes.servers || []) : [];

      this._render();
      await this._reconnect();
    } catch (e) {
      this.contentArea.innerHTML = `<div class="state-empty"><p class="error">Load failed: ${e.message}</p></div>`;
    }
  }

  /* Deduplicate tokens by token value (same account, different names) */
  _deduplicateTokens(tokens) {
    const seen = new Set();
    return tokens.filter(t => {
      const key = t.token?.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _loadingHTML() {
    return `<div class="blast-loading"><div class="blast-loader"></div><span>Loading…</span></div>`;
  }

  /* ─── Render page ─────────────────────────────────────────── */
  _render() {
    const isServer = this.mode === 'server';

    this.contentArea.innerHTML = `
    <div class="blast-page">

      <!-- HEADER -->
      <div class="blast-header">
        <div class="blast-header-left">
          <div class="blast-header-icon ${isServer ? 'server' : 'dm'}">
            ${isServer
              ? `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`
              : `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`}
          </div>
          <div>
            <h2 class="blast-title">${isServer ? 'Server Blast' : 'DM Blast'}</h2>
            <p class="blast-subtitle">${isServer ? 'Mass-DM server members across accounts' : 'Mass-DM your contacts across accounts'}</p>
          </div>
        </div>
        <div class="blast-job-status" id="blastJobBadge" style="display:none;">
          <div class="mdm-pulse-dot active" style="width:8px;height:8px;"></div>
          <span>Blast running</span>
          <button class="blast-reconnect-btn" id="blastReconnectBtn">View Progress</button>
        </div>
      </div>

      <!-- TWO COLUMN LAYOUT -->
      <div class="blast-layout">

        <!-- ── LEFT PANEL ── -->
        <div class="blast-panel blast-left">

          <!-- ACCOUNTS -->
          <div class="blast-section" id="sectionAccounts">
            <div class="blast-section-head">
              <span class="blast-section-title">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                Accounts
              </span>
              <div class="blast-section-actions">
                <button class="blast-mini-btn" id="validateAllBtn" title="Validate all tokens">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  Validate
                </button>
                <button class="blast-mini-btn accent" id="addTokenBtn" title="Add new account">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Add Token
                </button>
              </div>
            </div>

            <!-- Inline add-token form -->
            <div class="blast-add-token-form" id="addTokenForm" style="display:none;">
              <input type="text"     id="newTokenName"  class="blast-input" placeholder="Account name (e.g. Alt 1)">
              <input type="password" id="newTokenValue" class="blast-input" placeholder="Paste Discord token…">
              <div class="blast-add-token-actions">
                <button class="blast-mini-btn accent" id="saveNewTokenBtn">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                  Validate & Save
                </button>
                <button class="blast-mini-btn" id="cancelAddTokenBtn">Cancel</button>
              </div>
              <div class="blast-add-token-status" id="addTokenStatus"></div>
            </div>

            <!-- Account rows -->
            <div class="blast-accounts-list" id="blastAccList">
              ${this._renderAccounts()}
            </div>
            <div class="blast-validate-summary" id="validateSummary" style="display:none;"></div>
          </div>

          <!-- SPEED -->
          <div class="blast-section">
            <div class="blast-section-head">
              <span class="blast-section-title">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                Speed Mode
              </span>
            </div>
            <div class="blast-speed-grid" id="blastSpeedGrid">
              ${Object.entries(SPEED_META).map(([key, m]) => `
              <button class="blast-speed-card${key === this.selectedSpeed ? ' active' : ''}" data-speed="${key}">
                <span class="blast-speed-emoji" data-emoji="${m.emoji}">${m.emoji}</span>
                <span class="blast-speed-name">${m.name}</span>
                <span class="blast-speed-info">${m.info}</span>
                <span class="blast-speed-risk ${m.riskClass}">${m.risk}</span>
              </button>`).join('')}
            </div>
          </div>

        </div><!-- /left -->

        <!-- ── RIGHT PANEL ── -->
        <div class="blast-panel blast-right">

          <!-- TARGET -->
          <div class="blast-section" id="sectionTarget">
            <div class="blast-section-head">
              <span class="blast-section-title">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
                Target
              </span>
              <span id="targetCountLabel" style="font-size:.72rem;color:var(--text-3);"></span>
            </div>
            ${isServer ? this._renderServerTarget() : this._renderDMTarget()}
          </div>

          <!-- MESSAGE -->
          <div class="blast-section">
            <div class="blast-section-head">
              <span class="blast-section-title">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                Message
              </span>
              <span class="blast-char-count" id="blastCharCount">0 / 2000</span>
            </div>
            <textarea class="blast-textarea" id="blastMessage" placeholder="Type your message…" maxlength="2000" rows="4"></textarea>

            <div class="blast-section-head" style="margin-top:11px;">
              <span class="blast-section-title" style="font-size:.64rem;">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                Attachments
              </span>
              <span style="font-size:.62rem;color:var(--text-3);">max 10 · 8 MB each</span>
            </div>
            <div class="blast-drop-zone" id="blastDropZone">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.3;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              <span id="blastDropLabel">Click or drag images here</span>
              <input type="file" id="blastFileInput" accept="image/*" multiple style="display:none;">
            </div>
            <div class="blast-image-previews" id="blastImagePreviews"></div>
          </div>

          <!-- STATS -->
          <div class="blast-stats-bar" id="blastStatsBar">
            <div class="blast-stat-cell"><span id="bsAccounts">0</span><small>Accounts</small></div>
            <div class="blast-stat-sep"></div>
            <div class="blast-stat-cell"><span id="bsTargets">0</span><small>Targets</small></div>
            <div class="blast-stat-sep"></div>
            <div class="blast-stat-cell"><span id="bsPerAcc">—</span><small>Per Acc.</small></div>
            <div class="blast-stat-sep"></div>
            <div class="blast-stat-cell accent"><span id="bsETA">—</span><small>ETA</small></div>
          </div>

          <!-- START -->
          <button class="blast-start-btn ${isServer ? 'server-mode' : ''}" id="blastStartBtn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span id="blastStartLabel">Start Blast</span>
          </button>

        </div><!-- /right -->
      </div><!-- /layout -->
    </div>`;

    this._bindEvents();
    this._updateStats();
  }

  /* ─── Accounts HTML ───────────────────────────────────────── */
  _renderAccounts() {
    if (!this.tokens.length) return `<div class="blast-no-accounts">No accounts — click <b>Add Token</b> to add one.</div>`;
    return this.tokens.map((t, i) => {
      const color = workerColor(t.name || `Acc ${i + 1}`);
      return `
      <label class="blast-acc-row" id="baccRow_${i}" style="--acc-color:${color};" data-idx="${i}">
        <input type="checkbox" class="blast-acc-check blast-acc-cb" data-name="${t.name}" data-token="${t.token}" checked>
        <div class="blast-acc-avatar">${initial(t.name)}</div>
        <div class="blast-acc-info">
          <div class="blast-acc-name">${t.name || 'Account ' + (i + 1)}</div>
          <div class="blast-acc-tail">···${(t.token || '').slice(-6)}</div>
        </div>
        <span class="blast-acc-badge pending" id="baccBadge_${i}">—</span>
        <button class="blast-acc-delete" data-name="${t.name}" title="Remove account">✕</button>
      </label>`;
    }).join('');
  }

  /* ─── DM target HTML ──────────────────────────────────────── */
  _renderDMTarget() {
    const n = this.dmContacts.length;
    return `
    <div class="blast-target-grid">
      <button class="blast-target-card active" data-target="all">
        <span class="blast-target-icon">💬</span>
        <span class="blast-target-name">All DMs</span>
        <span class="blast-target-count">${n} contacts</span>
      </button>
      <button class="blast-target-card" data-target="selected" ${n === 0 ? 'disabled' : ''}>
        <span class="blast-target-icon">✅</span>
        <span class="blast-target-name">Selected</span>
        <span class="blast-target-count" id="selectedDMCount">0 selected</span>
      </button>
    </div>`;
  }

  /* ─── Server target HTML ──────────────────────────────────── */
  _renderServerTarget() {
    const opts = this.servers.length
      ? this.servers.map(s => {
          const icon = s.icon ? `<img src="${s.icon}" width="16" height="16" style="border-radius:50%;vertical-align:middle;margin-right:5px;">` : '';
          return `<option value="${s.id}">${s.name}</option>`;
        }).join('')
      : '';
    return `
    <select class="blast-select" id="blastServerSelect">
      <option value="">— Choose a server —</option>
      ${opts}
    </select>
    ${!this.servers.length ? `<div class="blast-server-warning">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      No servers found. Make sure at least one token is saved.
    </div>` : ''}
    <select class="blast-select" id="blastChannelSelect" disabled>
      <option value="all">All Server Members</option>
    </select>
    <div id="blastMemberBadgeWrap" style="display:none;">
      <div class="blast-member-badge">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        <span id="blastMemberCount">0</span> members ready
      </div>
    </div>`;
  }

  /* ─── Bind all events ─────────────────────────────────────── */
  _bindEvents() {
    const $ = id => document.getElementById(id);

    /* Reconnect badge */
    $('blastReconnectBtn')?.addEventListener('click', () => this._reconnect(true));

    /* Add token toggle */
    $('addTokenBtn').addEventListener('click', () => {
      const form    = $('addTokenForm');
      const showing = form.style.display !== 'none';
      form.style.display = showing ? 'none' : 'flex';
      if (!showing) {
        $('newTokenName').focus();
        $('addTokenStatus').textContent = '';
        $('addTokenStatus').className   = 'blast-add-token-status';
      }
    });
    $('cancelAddTokenBtn').addEventListener('click', () => { $('addTokenForm').style.display = 'none'; });

    /* Save new token */
    $('saveNewTokenBtn').addEventListener('click', () => this._saveNewToken());
    $('newTokenValue').addEventListener('keydown', e => { if (e.key === 'Enter') this._saveNewToken(); });

    /* Validate all */
    $('validateAllBtn').addEventListener('click', () => this._validateAll());

    /* Bind account-row events */
    this._rebindAccEvents();

    /* Speed cards */
    document.querySelectorAll('.blast-speed-card').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.blast-speed-card').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedSpeed = btn.dataset.speed;
        /* trigger emoji animation */
        const emoji = btn.querySelector('.blast-speed-emoji');
        emoji.classList.remove('speed-anim');
        void emoji.offsetWidth;
        emoji.classList.add('speed-anim');
        this._updateStats();
      });
    });

    /* Target buttons (DM mode) */
    document.querySelectorAll('.blast-target-card').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        document.querySelectorAll('.blast-target-card').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedTarget = btn.dataset.target;
        this._updateStats();
      });
    });

    /* Server selects — use blast-specific endpoints */
    const serverSel  = $('blastServerSelect');
    const channelSel = $('blastChannelSelect');
    if (serverSel) {
      serverSel.addEventListener('change', async () => {
        const sid = serverSel.value;
        if (!sid) {
          this.serverMembers = [];
          $('blastMemberBadgeWrap').style.display = 'none';
          this._updateStats();
          return;
        }
        channelSel.disabled = true;
        channelSel.innerHTML = '<option>Loading channels…</option>';
        $('blastMemberBadgeWrap').style.display = 'block';
        $('blastMemberCount').textContent = '…';

        const [chRes, memRes] = await Promise.all([
          window.electronAPI.getBlastChannels(sid),
          window.electronAPI.getBlastMembers(sid, 'all')
        ]);

        channelSel.innerHTML = '<option value="all">All Server Members</option>';
        if (chRes.success) {
          chRes.channels.forEach(ch => {
            const o = document.createElement('option');
            o.value = ch.id; o.textContent = `# ${ch.name}`;
            channelSel.appendChild(o);
          });
        }
        channelSel.disabled = false;

        if (!memRes.success) {
          showNotification('Could not fetch members: ' + memRes.error, 'error');
          this.serverMembers = [];
        } else {
          this.serverMembers = memRes.members || [];
        }
        $('blastMemberCount').textContent = this.serverMembers.length;
        this._updateStats();
      });

      channelSel?.addEventListener('change', async () => {
        if (!serverSel.value) return;
        $('blastMemberCount').textContent = '…';
        const r = await window.electronAPI.getBlastMembers(serverSel.value, channelSel.value);
        this.serverMembers = r.success ? (r.members || []) : [];
        $('blastMemberCount').textContent = this.serverMembers.length;
        if (!r.success) showNotification('Could not fetch channel members: ' + r.error, 'error');
        this._updateStats();
      });
    }

    /* Message char count */
    $('blastMessage').addEventListener('input', () => {
      const len = $('blastMessage').value.length;
      const el  = $('blastCharCount');
      el.textContent = `${len} / 2000`;
      el.className   = `blast-char-count${len > 1800 ? ' danger' : len > 1500 ? ' warn' : ''}`;
      this._updateStats();
    });

    /* Image drop zone */
    this._bindDropZone();

    /* Start button */
    $('blastStartBtn').addEventListener('click', () => this._startBlast());
  }

  /* ─── Re-bind after account list refresh ──────────────────── */
  _rebindAccEvents() {
    document.querySelectorAll('.blast-acc-delete').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.preventDefault(); e.stopPropagation();
        const name = btn.dataset.name;
        const ok   = await showConfirm(`Remove account "${name}"?`, { danger: true, confirmText: 'Remove', cancelText: 'Keep' });
        if (!ok) return;
        await window.electronAPI.deleteToken(name);
        this.tokens = this.tokens.filter(t => t.name !== name);
        document.getElementById('blastAccList').innerHTML = this._renderAccounts();
        this._rebindAccEvents();
        this._updateStats();
        showNotification(`"${name}" removed`, 'success');
      });
    });
    document.querySelectorAll('.blast-acc-cb').forEach(cb => cb.addEventListener('change', () => this._updateStats()));
  }

  /* ─── Image drop zone ─────────────────────────────────────── */
  _bindDropZone() {
    this.uploadedImages = [];
    const drop  = document.getElementById('blastDropZone');
    const input = document.getElementById('blastFileInput');
    const prevs = document.getElementById('blastImagePreviews');
    const label = document.getElementById('blastDropLabel');

    const render = () => {
      prevs.innerHTML = this.uploadedImages.map((img, i) => `
        <div class="blast-img-thumb">
          <img src="data:${img.type};base64,${img.data}" alt="">
          <button class="blast-img-remove" data-i="${i}">✕</button>
        </div>`).join('');
      label.textContent = this.uploadedImages.length >= 10
        ? 'Max 10 images reached'
        : `Click or drag images here${this.uploadedImages.length ? ` (${this.uploadedImages.length}/10)` : ''}`;
      prevs.querySelectorAll('.blast-img-remove').forEach(btn => {
        btn.addEventListener('click', () => { this.uploadedImages.splice(+btn.dataset.i, 1); render(); });
      });
    };

    const processFiles = async files => {
      for (const f of Array.from(files).slice(0, 10 - this.uploadedImages.length)) {
        if (!f.type.startsWith('image/') || f.size > 8 * 1024 * 1024) continue;
        const data = await new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result.split(',')[1]); r.readAsDataURL(f); });
        this.uploadedImages.push({ name: f.name, type: f.type, data });
      }
      render();
    };

    drop.addEventListener('click', () => { if (this.uploadedImages.length < 10) input.click(); });
    input.addEventListener('change', () => processFiles(input.files));
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag-over'); processFiles(e.dataTransfer.files); });
  }

  /* ─── Validate & Save new token ───────────────────────────── */
  async _saveNewToken() {
    const nameEl   = document.getElementById('newTokenName');
    const tokenEl  = document.getElementById('newTokenValue');
    const statusEl = document.getElementById('addTokenStatus');

    const name  = nameEl.value.trim() || `Account ${this.tokens.length + 1}`;
    const token = tokenEl.value.trim();

    if (!token) { statusEl.textContent = 'Paste a token first'; statusEl.className = 'blast-add-token-status fail'; return; }

    /* ── Check duplicates ── */
    const dupByToken = this.tokens.find(t => t.token?.trim() === token);
    if (dupByToken) {
      statusEl.textContent = `✗ This token is already saved as "${dupByToken.name}"`;
      statusEl.className   = 'blast-add-token-status fail';
      return;
    }
    const dupByName = this.tokens.find(t => t.name?.toLowerCase() === name.toLowerCase());
    if (dupByName) {
      statusEl.textContent = `✗ An account named "${name}" already exists`;
      statusEl.className   = 'blast-add-token-status fail';
      return;
    }

    statusEl.textContent = '⏳ Validating…';
    statusEl.className   = 'blast-add-token-status';
    const btn = document.getElementById('saveNewTokenBtn');
    btn.disabled = true;

    try {
      const res = await window.electronAPI.multiDMValidate([{ name, token }]);
      if (!res.success || !res.results?.[0]?.valid) {
        statusEl.textContent = '✗ Token is dead or invalid — not saved';
        statusEl.className   = 'blast-add-token-status fail';
        btn.disabled = false;
        return;
      }
      const saveRes = await window.electronAPI.saveToken(name, token);
      if (!saveRes.success) {
        statusEl.textContent = `✗ Save failed: ${saveRes.error}`;
        statusEl.className   = 'blast-add-token-status fail';
        btn.disabled = false;
        return;
      }
      this.tokens.push({ name, token });
      document.getElementById('blastAccList').innerHTML = this._renderAccounts();
      this._rebindAccEvents();
      this._updateStats();
      document.getElementById('addTokenForm').style.display = 'none';
      nameEl.value = ''; tokenEl.value = '';
      showNotification(`"${name}" added & validated ✓`, 'success');
    } catch (e) {
      statusEl.textContent = `✗ Error: ${e.message}`;
      statusEl.className   = 'blast-add-token-status fail';
    }
    btn.disabled = false;
  }

  /* ─── Validate all tokens ─────────────────────────────────── */
  async _validateAll() {
    const btn     = document.getElementById('validateAllBtn');
    const summary = document.getElementById('validateSummary');
    if (!this.tokens.length) { showNotification('No accounts to validate', 'warn'); return; }

    btn.disabled = true;
    btn.innerHTML = `<span style="animation:spin .6s linear infinite;display:inline-block;">↻</span> Checking…`;
    summary.style.display = 'none';

    this.tokens.forEach((_, i) => {
      const badge = document.getElementById(`baccBadge_${i}`);
      if (badge) { badge.textContent = '…'; badge.className = 'blast-acc-badge checking'; }
    });

    const res = await window.electronAPI.multiDMValidate(this.tokens.map(t => ({ name: t.name, token: t.token })));
    let valid = 0, dead = 0;

    if (res.success) {
      res.results.forEach((r, i) => {
        const row   = document.getElementById(`baccRow_${i}`);
        const badge = document.getElementById(`baccBadge_${i}`);
        const cb    = document.querySelectorAll('.blast-acc-cb')[i];
        if (r.valid) {
          valid++;
          if (badge) { badge.textContent = '✓ valid'; badge.className = 'blast-acc-badge valid'; }
          row?.classList.remove('dead');
        } else {
          dead++;
          if (badge) { badge.textContent = '✗ dead'; badge.className = 'blast-acc-badge dead'; }
          if (cb) cb.checked = false;
          row?.classList.add('dead');
        }
      });
    }

    summary.className = `blast-validate-summary ${dead > 0 ? 'has-dead' : 'all-ok'}`;
    summary.innerHTML = dead > 0
      ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg> ${valid} valid · ${dead} dead (unchecked automatically)`
      : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> All ${valid} accounts valid ✓`;
    summary.style.display = 'flex';

    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Validate`;
    this._updateStats();
  }

  /* ─── Stats preview update ────────────────────────────────── */
  _updateStats() {
    const accounts = document.querySelectorAll('.blast-acc-cb:checked').length;
    let targets    = 0;

    if (this.mode === 'dm') {
      targets = this.selectedTarget === 'all'
        ? this.dmContacts.length
        : parseInt(document.getElementById('selectedDMCount')?.textContent) || 0;
    } else {
      targets = this.serverMembers.length;
    }

    const bar = document.getElementById('blastStatsBar');
    if (accounts > 0 && targets > 0) {
      bar?.classList.add('active');
      const perAcc  = Math.ceil(targets / accounts);
      const delayMs = DELAYS[this.selectedSpeed] || 820;
      const eta     = Math.ceil(perAcc * delayMs / 1000);
      animNum(document.getElementById('bsAccounts'), accounts);
      animNum(document.getElementById('bsTargets'),  targets);
      document.getElementById('bsPerAcc').textContent = perAcc;
      document.getElementById('bsETA').textContent    = fmtETA(eta);
    } else {
      bar?.classList.remove('active');
      document.getElementById('bsAccounts').textContent = accounts || 0;
      document.getElementById('bsTargets').textContent  = targets  || 0;
      document.getElementById('bsPerAcc').textContent   = '—';
      document.getElementById('bsETA').textContent      = '—';
    }
  }

  /* ─── Start blast ─────────────────────────────────────────── */
  async _startBlast() {
    const msg = document.getElementById('blastMessage').value.trim();
    if (!msg) {
      const ta = document.getElementById('blastMessage');
      ta.style.borderColor = 'var(--danger)'; ta.focus();
      setTimeout(() => { ta.style.borderColor = ''; }, 1400);
      showNotification('Write a message first', 'warn');
      return;
    }

    const accounts = Array.from(document.querySelectorAll('.blast-acc-cb:checked'))
      .map(cb => ({ name: cb.dataset.name, token: cb.dataset.token }));

    if (!accounts.length) {
      const sec = document.getElementById('sectionAccounts');
      sec.style.boxShadow = '0 0 0 2px var(--danger)';
      setTimeout(() => { sec.style.boxShadow = ''; }, 1400);
      showNotification('Select at least one account', 'warn');
      return;
    }

    let userIds = [];
    if (this.mode === 'dm') {
      userIds = this.selectedTarget === 'all'
        ? this.dmContacts.map(d => d.userId).filter(Boolean)
        : [];
    } else {
      if (!this.serverMembers.length) {
        const sel = document.getElementById('blastServerSelect');
        if (sel) { sel.style.borderColor = 'var(--danger)'; setTimeout(() => { sel.style.borderColor = ''; }, 1400); }
        showNotification('Select a server first', 'warn');
        return;
      }
      userIds = [...new Set(this.serverMembers.map(m => m.id))];
    }

    if (!userIds.length) { showNotification('No targets found', 'warn'); return; }

    /* Deduplicate user IDs */
    const uniqueIds = [...new Set(userIds)];

    const confirmed = await showConfirm(
      `Send to <b>${uniqueIds.length}</b> users via <b>${accounts.length}</b> account${accounts.length > 1 ? 's' : ''}?`,
      { title: 'Confirm Blast', confirmText: 'Start Blast', danger: false }
    );
    if (!confirmed) return;

    const startBtn = document.getElementById('blastStartBtn');
    startBtn.disabled = true;
    document.getElementById('blastStartLabel').textContent = 'Starting…';

    const startRes = await window.electronAPI.multiDMStart(
      accounts, uniqueIds, msg, this.uploadedImages, this.selectedSpeed
    );

    if (!startRes.success) {
      showNotification('Failed to start: ' + (startRes.error || 'Unknown error'), 'error');
      startBtn.disabled = false;
      document.getElementById('blastStartLabel').textContent = 'Start Blast';
      return;
    }

    this.isSending = true;
    this._jobId    = startRes.jobId;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId: startRes.jobId, accountList: accounts, total: startRes.total, mode: this.mode }));

    this._showProgressModal(startRes.jobId, accounts, startRes.total);
  }

  /* ─── Reconnect ───────────────────────────────────────────── */
  async _reconnect(forceOpen = false) {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      const { jobId, accountList, total, mode } = JSON.parse(saved);
      if (mode !== this.mode && !forceOpen) return;
      const stRes = await window.electronAPI.multiDMState(jobId);
      if (!stRes.success || (stRes.finished && !forceOpen) || stRes.stopped) {
        localStorage.removeItem(STORAGE_KEY); this.isSending = false;
        return;
      }
      this.isSending = true; this._jobId = jobId;
      const badge = document.getElementById('blastJobBadge');
      if (badge) badge.style.display = 'flex';
      if (forceOpen || !document.querySelector('.blast-progress-modal')) {
        this._showProgressModal(jobId, accountList, total, stRes);
      }
    } catch { localStorage.removeItem(STORAGE_KEY); this.isSending = false; }
  }

  /* ─── Progress Modal ──────────────────────────────────────── */
  _showProgressModal(jobId, accountList, total, initialState = null) {
    document.querySelectorAll('.blast-progress-modal-wrap').forEach(m => m.remove());

    const isServer = this.mode === 'server';
    const modal    = document.createElement('div');
    modal.className = 'modal-overlay blast-progress-modal-wrap';
    modal.innerHTML = `
      <div class="modal-content blast-progress-modal">

        <!-- Header -->
        <div class="blast-progress-header">
          <div class="mdm-pulse-dot" id="bpDot"></div>
          <span class="blast-progress-title">${isServer ? 'Server Blast' : 'DM Blast'} — Live</span>
          <span class="blast-mode-chip ${isServer ? 'chip-server' : 'chip-dm'}" id="bpSpeedChip">${this.selectedSpeed}</span>
        </div>

        <!-- Stats row -->
        <div class="blast-stats-row">
          <div class="blast-ost"><span id="bpTotal">${total}</span><small>Total</small></div>
          <div class="blast-ost c-ok">  <span id="bpSent">0</span>   <small>Sent ✓</small></div>
          <div class="blast-ost c-fail"><span id="bpFailed">0</span> <small>Failed ✗</small></div>
          <div class="blast-ost c-warn"><span id="bpSkipped">0</span><small>Skipped</small></div>
          <div class="blast-ost">       <span id="bpAlive">${accountList.length}</span><small>Active</small></div>
          <div class="blast-ost c-acc"> <span id="bpSpeed">—</span>  <small>msg/s</small></div>
          <div class="blast-ost">       <span id="bpETA">—</span>    <small>ETA</small></div>
        </div>

        <!-- Progress bar -->
        <div class="blast-pbar-wrap">
          <div class="blast-pbar-track"><div class="blast-pbar-fill" id="bpBar" style="width:0%"></div></div>
          <div class="blast-pbar-labels"><span id="bpDone">0 / ${total}</span><span id="bpPct">0%</span></div>
        </div>

        <!-- Split: workers | feed -->
        <div class="blast-split">
          <div class="blast-col">
            <div class="blast-col-title">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
              Workers
            </div>
            <div class="blast-workers-list" id="bpWorkers">
              ${accountList.map((acc, i) => {
                const c = workerColor(acc.name || `Account ${i + 1}`);
                return `
                <div class="blast-wcard" id="bpW_${i}" style="--wc:${c}">
                  <div class="blast-w-avatar">${initial(acc.name)}</div>
                  <div class="blast-w-body">
                    <div class="blast-w-name">${acc.name || 'Account ' + (i + 1)}</div>
                    <div class="blast-w-track"><div class="blast-w-bar" id="bpWBar_${i}"></div></div>
                    <div class="blast-w-stats">
                      <span class="w-ok">✓<b id="bpWSent_${i}">0</b></span>
                      <span class="w-fail">✗<b id="bpWFail_${i}">0</b></span>
                      <span>skip <b id="bpWSkip_${i}">0</b></span>
                    </div>
                  </div>
                  <span class="blast-w-badge wbadge-idle" id="bpWBadge_${i}">idle</span>
                </div>`;
              }).join('')}
            </div>
          </div>

          <div class="blast-col">
            <div class="blast-col-title">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
              Live Feed
              <span class="feed-count-badge" id="bpFeedCount">0</span>
            </div>
            <div class="blast-feed" id="bpFeed">
              <div class="blast-feed-empty">Waiting for activity…</div>
            </div>
          </div>
        </div>

        <!-- Finish message -->
        <div class="blast-finish-msg" id="bpFinishMsg"></div>

        <!-- Elapsed -->
        <div class="blast-elapsed">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          Elapsed: <span id="bpElapsed">0s</span>
        </div>

        <!-- Controls -->
        <div class="blast-ctrl">
          <button class="blast-ctrl-btn ctrl-pause" id="bpPauseBtn">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            Pause
          </button>
          <button class="blast-ctrl-btn ctrl-stop" id="bpStopBtn">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            Stop
          </button>
        </div>

      </div>`;
    document.body.appendChild(modal);

    /* ── State ── */
    let feedCount = 0, isPaused = initialState?.paused || false;
    const dot      = modal.querySelector('#bpDot');
    const pauseBtn = modal.querySelector('#bpPauseBtn');
    const stopBtn  = modal.querySelector('#bpStopBtn');
    const feedEl   = modal.querySelector('#bpFeed');
    const feedCnt  = modal.querySelector('#bpFeedCount');

    /* Elapsed timer */
    this._startTs = Date.now() - (initialState?.elapsed || 0) * 1000;
    clearInterval(this._elapsedTimer);
    this._elapsedTimer = setInterval(() => {
      const s  = Math.floor((Date.now() - this._startTs) / 1000);
      const el = modal.querySelector('#bpElapsed');
      if (el) el.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }, 1000);

    /* ── Apply state ── */
    const applyState = st => {
      const done = st.done || 0;
      const pct  = st.total > 0 ? Math.round((done / st.total) * 100) : 0;
      const skip = (st.workers || []).reduce((s, w) => s + (w.skipped || 0), 0);

      modal.querySelector('#bpBar').style.width  = `${pct}%`;
      modal.querySelector('#bpPct').textContent  = `${pct}%`;
      modal.querySelector('#bpDone').textContent = `${done} / ${st.total}`;

      animNum(modal.querySelector('#bpSent'),    st.sent    || 0);
      animNum(modal.querySelector('#bpFailed'),  st.failed  || 0);
      animNum(modal.querySelector('#bpSkipped'), skip);
      animNum(modal.querySelector('#bpAlive'),   st.alive  ?? accountList.length);

      const spEl = modal.querySelector('#bpSpeed');
      if (spEl) spEl.textContent = (st.speed && +st.speed > 0) ? (+st.speed).toFixed(2) : '—';
      const etaEl = modal.querySelector('#bpETA');
      if (etaEl) etaEl.textContent = fmtETA(st.eta);
      const chipEl = modal.querySelector('#bpSpeedChip');
      if (chipEl) chipEl.textContent = st.speedMode || this.selectedSpeed;

      isPaused = st.paused;
      if (isPaused) {
        dot.className  = 'mdm-pulse-dot paused';
        pauseBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`;
        pauseBtn.className = 'blast-ctrl-btn ctrl-resume';
      } else if (!st.finished && !st.stopped) {
        dot.className  = 'mdm-pulse-dot active';
        pauseBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`;
        pauseBtn.className = 'blast-ctrl-btn ctrl-pause';
      }

      /* Workers */
      (st.workers || []).forEach((w, i) => {
        const wDone  = (w.sent || 0) + (w.failed || 0) + (w.skipped || 0);
        const wTotal = Math.max(1, Math.ceil((st.total || 1) / Math.max(1, st.workers?.length || 1)));
        const wPct   = Math.min(100, Math.round((wDone / wTotal) * 100));

        const bar   = modal.querySelector(`#bpWBar_${i}`);
        const badge = modal.querySelector(`#bpWBadge_${i}`);
        const card  = modal.querySelector(`#bpW_${i}`);
        if (bar)   bar.style.width = `${wPct}%`;
        animNum(modal.querySelector(`#bpWSent_${i}`), w.sent    || 0);
        animNum(modal.querySelector(`#bpWFail_${i}`), w.failed  || 0);
        animNum(modal.querySelector(`#bpWSkip_${i}`), w.skipped || 0);
        if (badge) { badge.textContent = w.status || 'idle'; badge.className = `blast-w-badge ${badgeClass(w)}`; }
        if (card && w.dead) card.classList.add('dead');
      });

      /* Finished */
      if (st.finished || st.stopped) {
        clearInterval(this._elapsedTimer);
        dot.className = 'mdm-pulse-dot stopped';
        const finMsg = modal.querySelector('#bpFinishMsg');
        finMsg.textContent = st.stopped ? '⛔ Stopped by user.' : '✅ Blast complete!';
        finMsg.className   = `blast-finish-msg ${st.stopped ? 'finish-stop' : 'finish-ok'}`;
        pauseBtn.style.display = 'none';
        stopBtn.innerHTML  = 'Close';
        stopBtn.className  = 'blast-ctrl-btn ctrl-close';
        stopBtn.style.flex = '1';
        stopBtn.onclick    = () => {
          modal.remove(); localStorage.removeItem(STORAGE_KEY);
          this.isSending = false;
          const badge = document.getElementById('blastJobBadge');
          if (badge) badge.style.display = 'none';
          const sb = document.getElementById('blastStartBtn');
          if (sb) { sb.disabled = false; }
          const sl = document.getElementById('blastStartLabel');
          if (sl) sl.textContent = 'Start Blast';
        };
        if (this._sse)    { this._sse.close();    this._sse    = null; }
        if (this._actSSE) { this._actSSE.close(); this._actSSE = null; }
        this.isSending = false;
      }
    };

    if (initialState) applyState(initialState);

    /* ── Activity SSE ── */
    const actSSE = new EventSource(`/api/multi-dm/activity/${jobId}`);
    this._actSSE = actSSE;
    actSSE.onmessage = e => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type !== 'activity') return;
        this._addFeedItem(feedEl, ev, accountList);
        feedCount++;
        feedCnt.textContent = feedCount;
        feedCnt.classList.add('bump');
        setTimeout(() => feedCnt.classList.remove('bump'), 280);
      } catch {}
    };

    /* ── State SSE ── */
    const sse = new EventSource(`/api/multi-dm/stream/${jobId}`);
    this._sse = sse;
    sse.onmessage = e => { try { applyState(JSON.parse(e.data)); } catch {} };
    sse.onerror = () => {
      const fin = modal.querySelector('#bpFinishMsg');
      if (fin && !fin.textContent) { fin.textContent = '⚠ Connection lost — reconnecting…'; fin.className = 'blast-finish-msg finish-stop'; }
    };

    /* ── Pause / Resume ── */
    pauseBtn.addEventListener('click', async () => {
      pauseBtn.disabled = true;
      await (isPaused ? window.electronAPI.multiDMResume(jobId) : window.electronAPI.multiDMPause(jobId));
      pauseBtn.disabled = false;
    });

    /* ── Stop ── */
    stopBtn.addEventListener('click', async () => {
      if (stopBtn.textContent.trim() === 'Close') return;
      stopBtn.textContent = 'Stopping…'; stopBtn.disabled = true;
      await window.electronAPI.multiDMStop(jobId);
    });

    /* Show running badge */
    const badge = document.getElementById('blastJobBadge');
    if (badge) badge.style.display = 'flex';
  }

  /* ─── Add feed item ───────────────────────────────────────── */
  _addFeedItem(feedEl, ev, accountList) {
    const empty = feedEl.querySelector('.blast-feed-empty');
    if (empty) empty.remove();
    const color  = workerColor(ev.worker || '');
    const init   = initial(ev.worker || '?');
    const isOk   = ev.result === 'sent';
    const isFail = ev.result === 'failed';
    const time   = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    const item = document.createElement('div');
    item.className = `blast-feed-item ${isOk ? 'feed-sent' : isFail ? 'feed-failed' : 'feed-skip'}`;
    item.innerHTML = `
      <div class="feed-acc" style="background:${color}20;border:1px solid ${color}40;">
        <span class="feed-init" style="color:${color};font-size:.7rem;font-weight:700;">${init}</span>
      </div>
      <span class="feed-icon">${isOk ? '→' : isFail ? '✗' : '⊘'}</span>
      <div class="feed-user">
        <span class="feed-uid">${ev.userId ? `···${ev.userId.slice(-8)}` : '——'}</span>
        ${ev.reason ? `<span class="feed-reason">${ev.reason}</span>` : ''}
      </div>
      <span class="feed-result ${isOk ? 'res-ok' : isFail ? 'res-fail' : 'res-skip'}">${isOk ? 'Sent' : isFail ? 'Failed' : 'Skip'}</span>
      <span class="feed-time">${time}</span>`;

    feedEl.insertBefore(item, feedEl.firstChild);
    while (feedEl.children.length > 120) feedEl.removeChild(feedEl.lastChild);
  }
}
