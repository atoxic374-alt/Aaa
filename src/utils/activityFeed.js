/**
 * activityFeed.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Aggregates every OperationLog session across all managers into a single
 * persistent slide-out panel.  Events are stored in memory (max 200 sessions)
 * and rendered in real-time as managers push start/success/fail/summary calls.
 *
 * Usage (called internally by operationLog.js wrapper):
 *   import * as AF from './activityFeed.js';
 *   AF.mount();                          // once, in main.js
 *   const id = AF.openSession(opts);     // per openOperationLog() call
 *   AF.logEvent(id, state, payload);     // per step event
 *   AF.finishSession(id, summaryData);   // on log.summary()
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { t } from './i18n.js';

const MAX_SESSIONS = 200;
const MAX_EVENTS_PER_SESSION = 300;

// ── State ─────────────────────────────────────────────────────────────────
const sessions = [];          // ordered newest-first
let unreadCount = 0;
let panelOpen   = false;
let mounted     = false;

// ── DOM refs ──────────────────────────────────────────────────────────────
let drawer, listEl, badgeEl, filterBtns, activeFilter = 'all';

// ── Helpers ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function timeStr(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  return Math.floor(diff / 3600000) + 'h ago';
}
function stateIcon(state) {
  const icons = {
    running:   '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/></svg>',
    done:      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    failed:    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    partial:   '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    ok:        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    fail:      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    spin:      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3.5-7.1"/></svg>',
    info:      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    warn:      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  };
  return icons[state] || icons.info;
}

// ── Session API ───────────────────────────────────────────────────────────

let _idCounter = 0;
export function openSession({ title = 'Operation', context = '', total = null } = {}) {
  const id = `af_${Date.now()}_${++_idCounter}`;
  const session = {
    id, title, context, total,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    ok: 0, fail: 0, done: 0,
    events: [],
    expanded: false,
  };
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) sessions.pop();

  if (!panelOpen) {
    unreadCount++;
    updateBadge();
  }
  renderList();
  return id;
}

export function logEvent(sessionId, state, payload = {}) {
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;

  if (state === 'ok')   { s.ok++;   s.done++; }
  if (state === 'fail') { s.fail++; s.done++; }

  // Update or add keyed event, or just push if no key
  const key = payload.key;
  if (key) {
    const existing = s.events.find(e => e.key === key);
    if (existing) {
      existing.state = state;
      existing.time  = Date.now();
      if (payload.title)   existing.title   = payload.title;
      if (payload.detail)  existing.detail  = payload.detail;
      if (payload.error)   existing.error   = payload.error;
      if (payload.context) existing.context = payload.context;
      renderSession(sessionId);
      return;
    }
  }
  if (s.events.length < MAX_EVENTS_PER_SESSION) {
    s.events.push({
      key: key || null,
      state,
      title:   payload.title   || '',
      context: payload.context || '',
      detail:  payload.detail  || '',
      error:   payload.error   || '',
      time:    Date.now(),
    });
  }
  renderSession(sessionId);
}

export function finishSession(sessionId, { ok, fail, total } = {}) {
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;
  if (ok   !== undefined) s.ok   = ok;
  if (fail !== undefined) s.fail = fail;
  if (total !== undefined) s.total = total;
  s.done       = s.ok + s.fail;
  s.finishedAt = Date.now();
  s.status     = s.fail === 0 ? 'done' : s.ok === 0 ? 'failed' : 'partial';

  if (!panelOpen) {
    unreadCount++;
    updateBadge();
  }
  renderSession(sessionId);
}

export function setSessionTotal(sessionId, total) {
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;
  s.total = total;
  renderSession(sessionId);
}

// ── Badge ─────────────────────────────────────────────────────────────────
function updateBadge() {
  if (!badgeEl) return;
  badgeEl.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
  badgeEl.style.display = unreadCount > 0 ? 'flex' : 'none';
}

// ── Render helpers ────────────────────────────────────────────────────────
function filteredSessions() {
  if (activeFilter === 'all')     return sessions;
  if (activeFilter === 'running') return sessions.filter(s => s.status === 'running');
  if (activeFilter === 'done')    return sessions.filter(s => s.status === 'done');
  if (activeFilter === 'failed')  return sessions.filter(s => ['failed','partial'].includes(s.status));
  return sessions;
}

function renderSessionCard(s) {
  const dur = s.finishedAt
    ? Math.round((s.finishedAt - s.startedAt) / 1000) + 's'
    : 'running…';
  const pct = s.total ? Math.min(100, Math.round((s.done / s.total) * 100)) : null;
  const statusClass = s.status;
  const eventsHtml = s.expanded ? s.events.map(e => `
    <div class="af-event af-ev-${e.state}">
      <span class="af-ev-icon ${e.state === 'spin' ? 'af-spin' : ''}">${stateIcon(e.state)}</span>
      <div class="af-ev-body">
        <span class="af-ev-title">${esc(e.title)}</span>
        ${e.detail  ? `<span class="af-ev-meta">${esc(e.detail)}</span>` : ''}
        ${e.error   ? `<span class="af-ev-error">${esc(e.error)}</span>` : ''}
        ${e.context ? `<span class="af-ev-ctx">${esc(e.context)}</span>` : ''}
      </div>
      <span class="af-ev-time">${timeStr(e.time)}</span>
    </div>
  `).join('') : '';

  return `
    <div class="af-card af-card-${statusClass}" data-id="${esc(s.id)}">
      <div class="af-card-head">
        <span class="af-status-dot af-dot-${statusClass} ${s.status === 'running' ? 'af-pulse' : ''}"></span>
        <div class="af-card-info">
          <span class="af-card-title">${esc(s.title)}</span>
          ${s.context ? `<span class="af-card-ctx">${esc(s.context)}</span>` : ''}
        </div>
        <div class="af-card-stats">
          ${s.ok   > 0 ? `<span class="af-stat ok">${stateIcon('ok')} ${s.ok}</span>`   : ''}
          ${s.fail > 0 ? `<span class="af-stat fail">${stateIcon('fail')} ${s.fail}</span>` : ''}
          ${s.total ? `<span class="af-stat tot">${s.done}/${s.total}</span>` : ''}
        </div>
        <div class="af-card-meta">
          <span class="af-time">${timeStr(s.startedAt)}</span>
          <span class="af-dur">${esc(dur)}</span>
        </div>
        ${s.events.length ? `<button class="af-expand-btn" data-id="${esc(s.id)}" title="${s.expanded ? 'Collapse' : 'Expand'}">
          ${s.expanded ? '▴' : '▾'} ${s.events.length}
        </button>` : ''}
      </div>
      ${pct !== null ? `
        <div class="af-card-bar">
          <div class="af-card-fill af-fill-${statusClass}" style="width:${pct}%"></div>
        </div>
      ` : s.status === 'running' ? `
        <div class="af-card-bar">
          <div class="af-card-fill af-fill-indeterminate"></div>
        </div>
      ` : ''}
      ${s.expanded && s.events.length ? `<div class="af-events">${eventsHtml}</div>` : ''}
    </div>
  `;
}

function renderList() {
  if (!listEl) return;
  const list = filteredSessions();
  if (!list.length) {
    listEl.innerHTML = `<div class="af-empty">
      <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      <span>No activity yet</span>
    </div>`;
    return;
  }
  listEl.innerHTML = list.map(renderSessionCard).join('');
  listEl.querySelectorAll('.af-expand-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const s = sessions.find(x => x.id === id);
      if (s) { s.expanded = !s.expanded; renderList(); }
    });
  });
}

function renderSession(sessionId) {
  if (!listEl) return;
  const el = listEl.querySelector(`[data-id="${sessionId}"]`);
  if (!el) { renderList(); return; }
  const s = sessions.find(x => x.id === sessionId);
  if (!s) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderSessionCard(s);
  const newCard = tmp.firstElementChild;
  el.replaceWith(newCard);
  newCard.querySelectorAll('.af-expand-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      const sess = sessions.find(x => x.id === id);
      if (sess) { sess.expanded = !sess.expanded; renderList(); }
    });
  });
}

// ── Panel mount ───────────────────────────────────────────────────────────
export function mount() {
  if (mounted) return;
  mounted = true;

  // ── Toggle button in the title bar ──
  const btn = document.createElement('button');
  btn.id = 'activityFeedBtn';
  btn.className = 'af-toggle-btn';
  btn.title = 'Activity Feed';
  btn.setAttribute('aria-label', 'Activity Feed');
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
    </svg>
    <span class="af-badge" id="af-badge" style="display:none">0</span>
  `;

  // Insert before the info button in the header
  const infoBtn = document.getElementById('infoBtn');
  infoBtn?.parentNode?.insertBefore(btn, infoBtn);
  badgeEl = document.getElementById('af-badge');

  // ── Drawer ──
  drawer = document.createElement('div');
  drawer.id = 'activityFeedDrawer';
  drawer.className = 'af-drawer';
  drawer.innerHTML = `
    <div class="af-drawer-head">
      <div class="af-drawer-title">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        <span>Activity Feed</span>
        <span class="af-running-badge" id="af-running-badge" style="display:none">Live</span>
      </div>
      <div class="af-drawer-controls">
        <button class="af-clear-btn" id="af-clear-btn" title="Clear finished">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
        <button class="af-close-btn" id="af-close-btn" title="Close">✕</button>
      </div>
    </div>
    <div class="af-filters" id="af-filters">
      <button class="af-filter active" data-f="all">All</button>
      <button class="af-filter" data-f="running">
        <span class="af-filter-dot running"></span>Running
      </button>
      <button class="af-filter" data-f="done">
        <span class="af-filter-dot done"></span>Done
      </button>
      <button class="af-filter" data-f="failed">
        <span class="af-filter-dot failed"></span>Failed
      </button>
    </div>
    <div class="af-list" id="af-list"></div>
  `;
  document.body.appendChild(drawer);
  listEl = drawer.querySelector('#af-list');

  // ── Backdrop ──
  const backdrop = document.createElement('div');
  backdrop.id = 'afBackdrop';
  backdrop.className = 'af-backdrop';
  document.body.appendChild(backdrop);

  // ── Wire events ──
  btn.addEventListener('click', togglePanel);
  backdrop.addEventListener('click', closePanel);
  drawer.querySelector('#af-close-btn').addEventListener('click', closePanel);
  drawer.querySelector('#af-clear-btn').addEventListener('click', () => {
    const running = sessions.filter(s => s.status === 'running');
    sessions.length = 0;
    running.forEach(s => sessions.push(s));
    renderList();
  });

  filterBtns = drawer.querySelectorAll('.af-filter');
  filterBtns.forEach(b => {
    b.addEventListener('click', () => {
      activeFilter = b.dataset.f;
      filterBtns.forEach(x => x.classList.toggle('active', x === b));
      renderList();
    });
  });

  renderList();
  startLiveBadge();
}

function togglePanel() {
  panelOpen ? closePanel() : openPanel();
}

function openPanel() {
  panelOpen = true;
  unreadCount = 0;
  updateBadge();
  drawer.classList.add('open');
  document.getElementById('afBackdrop').classList.add('show');
  renderList();
}

function closePanel() {
  panelOpen = false;
  drawer.classList.remove('open');
  document.getElementById('afBackdrop').classList.remove('show');
}

// Update the "Live" badge in the drawer header
function startLiveBadge() {
  setInterval(() => {
    const rb = document.getElementById('af-running-badge');
    if (!rb) return;
    const running = sessions.some(s => s.status === 'running');
    rb.style.display = running ? 'inline-flex' : 'none';
  }, 800);
}
