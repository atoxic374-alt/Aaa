import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';

// ── helpers ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'mdm_active_job';

function fmtETA(sec) {
  if (!sec || sec <= 0) return '—';
  if (sec >= 3600) return `~${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  if (sec >= 60)   return `~${Math.floor(sec / 60)}m${sec % 60}s`;
  return `~${sec}s`;
}

function workerColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue},60%,60%)`;
}

function initial(name) { return (name || '?')[0].toUpperCase(); }

// ── DMManager ────────────────────────────────────────────────────────────────
export class DMManager {
  constructor(contentArea) {
    this.contentArea   = contentArea;
    this.isDeleting    = false;
    this.isSending     = false;
    this.currentDMs    = [];
    this._activeSSE    = null;
    this._activeActSSE = null;
    this._activeJobId  = null;
  }

  // Called when DMs page is opened — reconnect any active blast
  async onShow() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      const { jobId, accountList, total } = JSON.parse(saved);
      const stRes = await window.electronAPI.multiDMState(jobId);
      if (!stRes.success || stRes.finished || stRes.stopped) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      this._activeJobId = jobId;
      this._showProgressModal(jobId, accountList, total, stRes);
    } catch { localStorage.removeItem(STORAGE_KEY); }
  }

  async refreshDMsList() {
    try {
      const dms      = await getDMsList();
      this.currentDMs = dms;
      this.contentArea.innerHTML = `
        <h2>DMs List</h2>
        <div class="actions-bar">
          <button id="selectAllDMsBtn" onclick="window.dmManager.toggleSelectAllDMs()">Select All</button>
          <button id="deleteSelectedMessagesBtn" onclick="window.dmManager.deleteSelectedMessages()" disabled>Delete Selected Messages</button>
          <button id="closeSelectedDMsBtn" onclick="window.dmManager.closeSelectedDMs()" disabled>Close Selected DMs</button>
          <button id="sendMessageBtn" onclick="window.dmManager.showSendMessageModal()" class="send-btn">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:5px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            Multi-DM Blast
          </button>
        </div>
        <div id="dmsList">
          ${dms.map(dm => `
            <div class="list-item" data-id="${dm.id}" data-user-id="${dm.userId || ''}" data-username="${dm.username}">
              <div class="list-item-left">
                <input type="checkbox" class="dm-checkbox" onchange="window.dmManager.updateSelectedCount()">
                <img src="${dm.avatar}" alt="${dm.username}">
                <div class="user-info">
                  <span class="display-name">${dm.displayName}</span>
                  <span class="username">(${dm.username})</span>
                </div>
              </div>
              <div class="button-group">
                <button onclick="window.dmManager.copyToClipboard('${dm.id}')" class="secondary-btn">Copy ID</button>
                <button onclick="window.dmManager.deleteDMMessages('${dm.id}','${dm.username}',false)" class="secondary-btn">Delete Msgs</button>
                <button onclick="window.dmManager.closeDM('${dm.id}')" class="danger-btn">Close DM</button>
              </div>
            </div>`).join('')}
        </div>`;
    } catch {
      this.contentArea.innerHTML = '<p class="error">Failed to load DMs</p>';
    }
    await this.onShow();
  }

  toggleSelectAllDMs() {
    const checkboxes = document.querySelectorAll('.dm-checkbox');
    const btn        = document.getElementById('selectAllDMsBtn');
    const isAll      = btn.textContent.trim() === 'Select All';
    checkboxes.forEach(cb => cb.checked = isAll);
    btn.textContent = isAll ? 'Deselect All' : 'Select All';
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n      = document.querySelectorAll('.dm-checkbox:checked').length;
    const delBtn = document.getElementById('deleteSelectedMessagesBtn');
    const clsBtn = document.getElementById('closeSelectedDMsBtn');
    delBtn.disabled = n === 0;
    clsBtn.disabled = n === 0;
    delBtn.textContent = `Delete Selected Messages (${n})`;
    clsBtn.textContent = `Close Selected DMs (${n})`;
  }

  async deleteSelectedMessages() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      const selected = Array.from(document.querySelectorAll('.dm-checkbox:checked'))
        .map(cb => { const el = cb.closest('.list-item'); return { id: el.dataset.id, username: el.dataset.username }; });
      await handleBulkDMActions(selected, 'delete', window.electronAPI);
      this.refreshDMsList();
    } finally { this.isDeleting = false; }
  }

  async closeSelectedDMs() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      const selected = Array.from(document.querySelectorAll('.dm-checkbox:checked'))
        .map(cb => { const el = cb.closest('.list-item'); return { id: el.dataset.id, username: el.dataset.username }; });
      await handleBulkDMActions(selected, 'close', window.electronAPI);
      this.refreshDMsList();
    } finally { this.isDeleting = false; }
  }

  copyToClipboard = copyToClipboard;

  async deleteDMMessages(channelId, username, oldestFirst = false) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      await deleteDMMessages({
        channelId, username, electronAPI: window.electronAPI,
        onComplete: () => { this.isDeleting = false; this.refreshDMsList(); },
        oldestFirst
      });
    } catch (e) { console.error(e); this.isDeleting = false; }
  }

  async closeDM(channelId) {
    try {
      const r = await window.electronAPI.closeDM(channelId);
      if (r.success) this.refreshDMsList();
    } catch (e) { console.error(e); }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Compose Modal
  // ─────────────────────────────────────────────────────────────────────────
  async showSendMessageModal() {
    const selectedUserIds = Array.from(document.querySelectorAll('.dm-checkbox:checked'))
      .map(cb => cb.closest('.list-item').dataset.userId).filter(Boolean);

    const [serversRes, tokensRes] = await Promise.all([
      window.electronAPI.getServers(),
      window.electronAPI.getTokens()
    ]);
    const serverList  = serversRes.success ? serversRes.servers  : [];
    const savedTokens = tokensRes.success  ? (tokensRes.tokens || []) : [];

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content send-modal-content mdm-compose">

        <div class="mdm-compose-header">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <span>Multi-Account DM Blast</span>
          <button class="mdm-close-x" id="cancelSendModalBtn">✕</button>
        </div>

        <!-- TARGET -->
        <span class="modal-label">Target</span>
        <div class="send-target-group">
          <button class="send-target-btn active" data-target="all">
            All DM Contacts <span class="target-count">(${this.currentDMs.length})</span>
          </button>
          <button class="send-target-btn${selectedUserIds.length === 0 ? ' send-target-disabled' : ''}"
            data-target="selected" ${selectedUserIds.length === 0 ? 'disabled' : ''}>
            Selected <span class="target-count">(${selectedUserIds.length})</span>
          </button>
          <button class="send-target-btn" data-target="server">Server Members</button>
        </div>

        <!-- SERVER SECTION -->
        <div id="serverSection" style="display:none;">
          <span class="modal-label">Server</span>
          <select class="modal-select" id="serverSelect">
            <option value="">— Choose a server —</option>
            ${serverList.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
          </select>
          <span class="modal-label">Filter by Channel</span>
          <select class="modal-select" id="channelSelect" disabled>
            <option value="all">All Server Members</option>
          </select>
          <div id="memberCountBadge" style="display:none;margin-bottom:8px;">
            <span class="member-count-badge" id="memberCountText">…</span>
          </div>
        </div>

        <!-- ACCOUNTS -->
        <span class="modal-label">Accounts
          <span class="mdm-val-hint" id="valHint"></span>
        </span>
        <div class="mdm-accounts-box" id="mdmAccountsBox">
          ${savedTokens.length === 0
            ? `<p class="mdm-no-accounts">No saved tokens — save tokens from the Login page first.</p>`
            : savedTokens.map((t, i) => `
              <label class="mdm-account-row" id="mdmRow_${i}">
                <input type="checkbox" class="mdm-acc-check" data-name="${t.name}" data-token="${t.token}" checked>
                <span class="mdm-acc-dot"></span>
                <span class="mdm-acc-name">${t.name || 'Account ' + (i + 1)}</span>
                <span class="mdm-acc-tail" id="mdmTail_${i}">···${t.token.slice(-6)}</span>
                <span class="mdm-val-badge" id="mdmVal_${i}"></span>
              </label>`).join('')}
        </div>
        <button class="mdm-validate-btn" id="validateBtn" ${savedTokens.length === 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
          Validate Tokens
        </button>
        <p class="mdm-accounts-hint">Members split evenly across active accounts. Dead (401) tokens skipped automatically.</p>

        <!-- SPEED MODE -->
        <span class="modal-label">Speed Mode</span>
        <div class="mdm-speed-group" id="mdmSpeedGroup">
          <button class="mdm-speed-btn" data-speed="safe">
            🛡️ Safe
            <span class="mdm-speed-sub">~1.1s/msg · Min ban risk</span>
          </button>
          <button class="mdm-speed-btn active" data-speed="normal">
            ⚡ Normal
            <span class="mdm-speed-sub">~750ms/msg · Balanced</span>
          </button>
          <button class="mdm-speed-btn" data-speed="fast">
            🚀 Fast
            <span class="mdm-speed-sub">~480ms/msg · Higher risk</span>
          </button>
        </div>

        <!-- MESSAGE -->
        <span class="modal-label">Message</span>
        <textarea class="modal-textarea" id="sendMessageText" placeholder="Enter your message…" rows="3"></textarea>

        <!-- IMAGES -->
        <span class="modal-label">
          Images <span style="opacity:.55;font-size:.76rem;"> (max 10 · 8 MB each)</span>
        </span>
        <div class="mdm-image-drop" id="mdmImageDrop">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <span id="mdmDropLabel">Click or drag images here</span>
          <input type="file" id="mdmFileInput" accept="image/*" multiple style="display:none;">
        </div>
        <div class="mdm-image-previews" id="mdmImagePreviews"></div>

        <!-- STATS PREVIEW -->
        <div class="mdm-stats-preview" id="mdmStatsPreview" style="display:none;">
          <div class="mdm-stat-item"><span id="mdmSA">0</span><small>Accounts</small></div>
          <div class="mdm-stat-item"><span id="mdmSM">0</span><small>Members</small></div>
          <div class="mdm-stat-item"><span id="mdmSP">0</span><small>Per Acc.</small></div>
          <div class="mdm-stat-item"><span id="mdmSE">—</span><small>ETA</small></div>
        </div>

        <div class="mdm-footer-btns">
          <button id="startSendBtn" class="send-btn mdm-start-btn">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Start Blast
          </button>
          <button class="secondary-btn" id="cancelSendModalBtn2">Cancel</button>
        </div>

      </div>`;
    document.body.appendChild(modal);

    let currentTarget        = 'all';
    let currentServerMembers = [];
    let selectedSpeedMode    = 'normal';
    const uploadedImages     = [];

    // ── speed buttons ─────────────────────────────────────────────────────────
    modal.querySelectorAll('.mdm-speed-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.mdm-speed-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedSpeedMode = btn.dataset.speed;
      });
    });

    // ── preview updater ───────────────────────────────────────────────────────
    const updatePreview = () => {
      const checked = modal.querySelectorAll('.mdm-acc-check:checked').length;
      let members   = 0;
      if (currentTarget === 'all')      members = this.currentDMs.length;
      else if (currentTarget === 'selected') members = selectedUserIds.length;
      else members = currentServerMembers.length;
      const prev = modal.querySelector('#mdmStatsPreview');
      if (checked > 0 && members > 0) {
        prev.style.display = 'flex';
        modal.querySelector('#mdmSA').textContent = checked;
        modal.querySelector('#mdmSM').textContent = members;
        const perAcc = Math.ceil(members / checked);
        modal.querySelector('#mdmSP').textContent = perAcc;
        const delayMs = { safe: 1300, normal: 850, fast: 560 }[selectedSpeedMode] || 850;
        const sec = Math.ceil(perAcc * delayMs / 1000);
        modal.querySelector('#mdmSE').textContent = fmtETA(sec);
      } else { prev.style.display = 'none'; }
    };

    // ── target buttons ────────────────────────────────────────────────────────
    modal.querySelectorAll('.send-target-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.send-target-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTarget = btn.dataset.target;
        modal.querySelector('#serverSection').style.display =
          currentTarget === 'server' ? 'block' : 'none';
        updatePreview();
      });
    });
    modal.querySelectorAll('.mdm-acc-check').forEach(cb => cb.addEventListener('change', updatePreview));
    modal.querySelectorAll('.mdm-speed-btn').forEach(btn => btn.addEventListener('click', updatePreview));

    // ── server selects ────────────────────────────────────────────────────────
    const serverSel  = modal.querySelector('#serverSelect');
    const channelSel = modal.querySelector('#channelSelect');
    const badge      = modal.querySelector('#memberCountBadge');
    const badgeTxt   = modal.querySelector('#memberCountText');

    serverSel.addEventListener('change', async () => {
      const sid = serverSel.value;
      if (!sid) { currentServerMembers = []; badge.style.display = 'none'; updatePreview(); return; }
      channelSel.disabled = true;
      channelSel.innerHTML = '<option>Loading…</option>';
      badge.style.display = 'block'; badgeTxt.textContent = 'Loading…';
      const [chRes, memRes] = await Promise.all([
        window.electronAPI.getServerChannels(sid),
        window.electronAPI.getServerMembers(sid, 'all')
      ]);
      channelSel.innerHTML = '<option value="all">All Server Members</option>';
      if (chRes.success) chRes.channels.forEach(ch => {
        const o = document.createElement('option');
        o.value = ch.id; o.textContent = `#${ch.name}`;
        channelSel.appendChild(o);
      });
      channelSel.disabled = false;
      currentServerMembers = memRes.success ? memRes.members : [];
      badgeTxt.textContent = `${currentServerMembers.length} members`;
      updatePreview();
    });

    channelSel.addEventListener('change', async () => {
      if (!serverSel.value) return;
      badgeTxt.textContent = 'Loading…';
      const r = await window.electronAPI.getServerMembers(serverSel.value, channelSel.value);
      currentServerMembers = r.success ? r.members : [];
      badgeTxt.textContent = `${currentServerMembers.length} members`;
      updatePreview();
    });

    // ── validate ──────────────────────────────────────────────────────────────
    modal.querySelector('#validateBtn').addEventListener('click', async () => {
      const vBtn = modal.querySelector('#validateBtn');
      vBtn.disabled = true;
      vBtn.innerHTML = `<span class="mdm-spin">↻</span> Validating…`;
      const hint = modal.querySelector('#valHint');
      hint.textContent = '';

      const accounts = Array.from(modal.querySelectorAll('.mdm-acc-check')).map((cb, i) => ({
        i, name: cb.dataset.name, token: cb.dataset.token, cb
      }));

      const res = await window.electronAPI.multiDMValidate(
        accounts.map(a => ({ name: a.name, token: a.token }))
      );

      if (res.success) {
        let valid = 0, dead = 0;
        res.results.forEach((r, i) => {
          const row     = modal.querySelector(`#mdmRow_${i}`);
          const valBadge = modal.querySelector(`#mdmVal_${i}`);
          const dot     = row?.querySelector('.mdm-acc-dot');
          const cb      = modal.querySelectorAll('.mdm-acc-check')[i];
          if (r.valid) {
            valid++;
            if (valBadge) { valBadge.textContent = '✓ valid'; valBadge.className = 'mdm-val-badge valid'; }
            if (dot) dot.style.background = '#3ba55d';
          } else {
            dead++;
            if (valBadge) { valBadge.textContent = '✗ dead'; valBadge.className = 'mdm-val-badge dead'; }
            if (dot) { dot.style.background = 'var(--danger)'; dot.style.boxShadow = '0 0 6px var(--danger)'; }
            if (cb) cb.checked = false;
            if (row) row.style.opacity = '0.45';
          }
        });
        hint.textContent = `${valid} valid · ${dead} dead`;
        hint.style.color = dead > 0 ? 'var(--danger)' : '#3ba55d';
        updatePreview();
      }

      vBtn.disabled = false;
      vBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Validate Tokens`;
    });

    // ── image upload ──────────────────────────────────────────────────────────
    const dropEl    = modal.querySelector('#mdmImageDrop');
    const fileInput = modal.querySelector('#mdmFileInput');
    const prevsEl   = modal.querySelector('#mdmImagePreviews');
    const dropLabel = modal.querySelector('#mdmDropLabel');

    const renderPreviews = () => {
      prevsEl.innerHTML = uploadedImages.map((img, i) => `
        <div class="mdm-img-thumb">
          <img src="data:${img.type};base64,${img.data}" alt="${img.name}">
          <button class="mdm-img-remove" onclick="window._mdmRm(${i})">✕</button>
        </div>`).join('');
      dropLabel.textContent = uploadedImages.length >= 10
        ? 'Max 10 images reached'
        : `Click or drag images here${uploadedImages.length > 0 ? ` (${uploadedImages.length}/10)` : ''}`;
    };

    window._mdmRm = (i) => { uploadedImages.splice(i, 1); renderPreviews(); };

    const processFiles = async (files) => {
      for (const f of Array.from(files).slice(0, 10 - uploadedImages.length)) {
        if (!f.type.startsWith('image/') || f.size > 8 * 1024 * 1024) continue;
        const data = await new Promise(res => {
          const r = new FileReader();
          r.onload = e => res(e.target.result.split(',')[1]);
          r.readAsDataURL(f);
        });
        uploadedImages.push({ name: f.name, type: f.type, data });
      }
      renderPreviews();
    };

    dropEl.addEventListener('click', () => { if (uploadedImages.length < 10) fileInput.click(); });
    fileInput.addEventListener('change', () => processFiles(fileInput.files));
    dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('drag-over'); });
    dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag-over'));
    dropEl.addEventListener('drop', e => { e.preventDefault(); dropEl.classList.remove('drag-over'); processFiles(e.dataTransfer.files); });

    // ── cancel ────────────────────────────────────────────────────────────────
    modal.querySelector('#cancelSendModalBtn').addEventListener('click', () => modal.remove());
    modal.querySelector('#cancelSendModalBtn2').addEventListener('click', () => modal.remove());

    // ── start ─────────────────────────────────────────────────────────────────
    modal.querySelector('#startSendBtn').addEventListener('click', async () => {
      const msg = modal.querySelector('#sendMessageText').value.trim();
      if (!msg) {
        const ta = modal.querySelector('#sendMessageText');
        ta.style.borderColor = 'var(--danger)'; ta.focus(); return;
      }

      const accounts = Array.from(modal.querySelectorAll('.mdm-acc-check:checked'))
        .map(cb => ({ name: cb.dataset.name, token: cb.dataset.token }));

      if (accounts.length === 0) {
        const box = modal.querySelector('#mdmAccountsBox');
        box.style.borderColor = 'var(--danger)';
        box.style.boxShadow   = '0 0 0 2px rgba(232,17,35,.25)';
        setTimeout(() => { box.style.borderColor = ''; box.style.boxShadow = ''; }, 1500);
        return;
      }

      let userIds = [];
      if (currentTarget === 'all')           userIds = this.currentDMs.map(d => d.userId).filter(Boolean);
      else if (currentTarget === 'selected') userIds = selectedUserIds;
      else {
        if (!serverSel.value) { serverSel.style.borderColor = 'var(--danger)'; return; }
        userIds = currentServerMembers.map(m => m.id);
      }
      if (!userIds.length) return;

      modal.remove();
      await this._startBlast(accounts, [...new Set(userIds)], msg, uploadedImages, selectedSpeedMode);
    });

    updatePreview();
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Start Blast
  // ─────────────────────────────────────────────────────────────────────────
  async _startBlast(accountList, userIds, message, images, speedMode) {
    if (this.isSending) return;
    this.isSending = true;

    const startRes = await window.electronAPI.multiDMStart(accountList, userIds, message, images, speedMode);
    if (!startRes.success) {
      alert('Failed to start: ' + startRes.error);
      this.isSending = false;
      return;
    }

    const { jobId, total } = startRes;
    this._activeJobId = jobId;

    // Persist so we can reconnect after refresh
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId, accountList, total }));

    this._showProgressModal(jobId, accountList, total);
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Progress Modal (also used for reconnect)
  // ─────────────────────────────────────────────────────────────────────────
  _showProgressModal(jobId, accountList, total, initialState = null) {
    // Remove any existing progress modal
    document.querySelectorAll('.mdm-progress-modal-wrap').forEach(m => m.remove());

    const modal = document.createElement('div');
    modal.className = 'modal-overlay mdm-progress-modal-wrap';
    modal.innerHTML = `
      <div class="modal-content mdm-progress-modal">

        <!-- Header -->
        <div class="mdm-compose-header" style="margin-bottom:12px;">
          <div class="mdm-pulse-dot" id="pgPulseDot"></div>
          <span id="pgHeaderTitle">DM Blast — Live</span>
          <span class="mdm-speed-chip" id="pgSpeedChip">normal</span>
        </div>

        <!-- Global stats -->
        <div class="mdm-overall-stats">
          <div class="mdm-ost-item">
            <span id="pgTotal">${total}</span><small>Total</small>
          </div>
          <div class="mdm-ost-item success-color">
            <span id="pgSent">0</span><small>Sent ✓</small>
          </div>
          <div class="mdm-ost-item danger-color">
            <span id="pgFailed">0</span><small>Failed ✗</small>
          </div>
          <div class="mdm-ost-item warn-color">
            <span id="pgSkipped">0</span><small>Skipped</small>
          </div>
          <div class="mdm-ost-item">
            <span id="pgAlive">${accountList.length}</span><small>Active</small>
          </div>
          <div class="mdm-ost-item accent-color">
            <span id="pgSpeed">—</span><small>msg/s</small>
          </div>
          <div class="mdm-ost-item">
            <span id="pgETA">—</span><small>ETA</small>
          </div>
        </div>

        <!-- Global progress bar -->
        <div class="mdm-progress-wrap">
          <div class="mdm-progress-track">
            <div class="mdm-progress-fill" id="pgBar" style="width:0%"></div>
          </div>
          <div class="mdm-progress-labels">
            <span id="pgDone">0 / ${total}</span>
            <span id="pgPct">0%</span>
          </div>
        </div>

        <!-- Two-column layout: workers left, activity right -->
        <div class="mdm-main-split">

          <!-- Workers -->
          <div class="mdm-workers-col">
            <div class="mdm-col-title">Accounts</div>
            <div class="mdm-workers-list" id="pgWorkers">
              ${accountList.map((acc, i) => `
                <div class="mdm-worker-card2" id="pgW_${i}" style="--wc:${workerColor(acc.name || 'Account ' + (i+1))}">
                  <div class="mdm-w2-avatar">${initial(acc.name)}</div>
                  <div class="mdm-w2-body">
                    <div class="mdm-w2-name">${acc.name || 'Account ' + (i + 1)}</div>
                    <div class="mdm-w2-bar-track">
                      <div class="mdm-w2-bar" id="pgWB_${i}"></div>
                    </div>
                    <div class="mdm-w2-stats">
                      <span class="mdm-ws-sent">✓<b id="pgWSent_${i}">0</b></span>
                      <span class="mdm-ws-failed">✗<b id="pgWFail_${i}">0</b></span>
                      <span class="mdm-ws-skip">skip<b id="pgWSkip_${i}">0</b></span>
                    </div>
                  </div>
                  <span class="mdm-w2-badge idle" id="pgWS_${i}">idle</span>
                </div>`).join('')}
            </div>
          </div>

          <!-- Activity feed -->
          <div class="mdm-activity-col">
            <div class="mdm-col-title">
              Live Feed
              <span class="mdm-feed-count" id="pgFeedCount">0</span>
            </div>
            <div class="mdm-activity-feed" id="pgActivityFeed">
              <div class="mdm-feed-empty">Waiting for sends…</div>
            </div>
          </div>

        </div>

        <!-- Status message -->
        <div id="pgStatusMsg" class="mdm-status-msg"></div>

        <!-- Control buttons -->
        <div class="mdm-ctrl-btns">
          <button class="mdm-ctrl-btn mdm-pause-btn" id="pgPauseBtn">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
            </svg>
            Pause
          </button>
          <button class="mdm-ctrl-btn mdm-stop-btn" id="pgStopBtn">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
            </svg>
            Stop
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    let feedCount = 0;
    let isPaused  = initialState?.paused || false;

    const feedEl     = modal.querySelector('#pgActivityFeed');
    const feedCntEl  = modal.querySelector('#pgFeedCount');
    const pauseBtn   = modal.querySelector('#pgPauseBtn');
    const stopBtn    = modal.querySelector('#pgStopBtn');
    const pulseDot   = modal.querySelector('#pgPulseDot');

    // ── Activity SSE ─────────────────────────────────────────────────────────
    const actSSE = new EventSource(`/api/multi-dm/activity/${jobId}`);
    this._activeActSSE = actSSE;
    actSSE.onmessage = e => {
      try {
        const ev = JSON.parse(e.data);
        if (ev.type !== 'activity') return;
        this._addFeedItem(feedEl, ev, accountList);
        feedCount++;
        feedCntEl.textContent = feedCount;
      } catch {}
    };

    // ── State SSE ─────────────────────────────────────────────────────────────
    const applyState = (st) => {
      const done = st.done || 0;
      const pct  = st.total > 0 ? Math.round((done / st.total) * 100) : 0;
      const skipped = (st.workers || []).reduce((s, w) => s + (w.skipped || 0), 0);

      modal.querySelector('#pgBar').style.width    = `${pct}%`;
      modal.querySelector('#pgPct').textContent     = `${pct}%`;
      modal.querySelector('#pgDone').textContent    = `${done} / ${st.total}`;
      modal.querySelector('#pgSent').textContent    = st.sent    || 0;
      modal.querySelector('#pgFailed').textContent  = st.failed  || 0;
      modal.querySelector('#pgSkipped').textContent = skipped;
      modal.querySelector('#pgAlive').textContent   = st.alive  ?? accountList.length;
      modal.querySelector('#pgSpeed').textContent   =
        (st.speed && +st.speed > 0) ? `${(+st.speed).toFixed(2)}` : '—';
      modal.querySelector('#pgETA').textContent     = fmtETA(st.eta);
      modal.querySelector('#pgSpeedChip').textContent = st.speedMode || 'normal';

      isPaused = st.paused;
      pauseBtn.innerHTML = isPaused
        ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`
        : `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause`;
      pauseBtn.className = isPaused
        ? 'mdm-ctrl-btn mdm-resume-btn'
        : 'mdm-ctrl-btn mdm-pause-btn';

      // Pulse dot
      if (st.paused)        pulseDot.className = 'mdm-pulse-dot paused';
      else if (st.finished || st.stopped) pulseDot.className = 'mdm-pulse-dot stopped';
      else                  pulseDot.className = 'mdm-pulse-dot active';

      // Workers
      (st.workers || []).forEach((w, i) => {
        const wDone  = (w.sent || 0) + (w.failed || 0) + (w.skipped || 0);
        const wTotal = Math.max(1, Math.ceil((st.total || 1) / (st.workers?.length || 1)));
        const wPct   = Math.min(100, Math.round((wDone / wTotal) * 100));

        const bar   = modal.querySelector(`#pgWB_${i}`);
        const badge = modal.querySelector(`#pgWS_${i}`);
        const card  = modal.querySelector(`#pgW_${i}`);

        if (bar)   bar.style.width = `${wPct}%`;
        if (modal.querySelector(`#pgWSent_${i}`))  modal.querySelector(`#pgWSent_${i}`).textContent  = w.sent    || 0;
        if (modal.querySelector(`#pgWFail_${i}`))  modal.querySelector(`#pgWFail_${i}`).textContent  = w.failed  || 0;
        if (modal.querySelector(`#pgWSkip_${i}`))  modal.querySelector(`#pgWSkip_${i}`).textContent  = w.skipped || 0;

        if (badge) {
          badge.textContent = w.status || 'idle';
          badge.className = `mdm-w2-badge ${
            w.dead                         ? 'dead-badge'  :
            w.status === 'done'            ? 'done'        :
            w.status === 'paused'          ? 'paused-b'    :
            w.status === 'running' || w.status === 'sending' || w.status === 'opening DM' ? 'running' :
            w.status?.includes('rate')     ? 'ratelimit'   :
            w.status === 'stopped' || w.status?.includes('stop') ? 'stopped' : 'idle'
          }`;
        }
        if (card && w.dead) card.classList.add('mdm-worker-dead');
      });

      // Finished / stopped
      if (st.finished || st.stopped) {
        pulseDot.className = 'mdm-pulse-dot stopped';
        const msg = modal.querySelector('#pgStatusMsg');
        msg.textContent  = st.stopped ? '⛔ Blast stopped by user.' : '✅ Blast complete!';
        msg.style.color  = st.stopped ? 'var(--danger)' : '#3ba55d';
        msg.style.display = 'block';
        pauseBtn.style.display = 'none';
        stopBtn.textContent   = 'Close';
        stopBtn.className     = 'mdm-ctrl-btn mdm-done-btn';
        stopBtn.style.flex    = '1';
        stopBtn.onclick       = () => {
          modal.remove();
          localStorage.removeItem(STORAGE_KEY);
        };
        if (this._activeSSE)    { this._activeSSE.close();    this._activeSSE    = null; }
        if (this._activeActSSE) { this._activeActSSE.close(); this._activeActSSE = null; }
        this.isSending = false;
      }
    };

    // Apply initial state if reconnecting
    if (initialState) applyState(initialState);

    const sse = new EventSource(`/api/multi-dm/stream/${jobId}`);
    this._activeSSE = sse;
    sse.onmessage = e => { try { applyState(JSON.parse(e.data)); } catch {} };
    sse.onerror = () => {
      // Try to reconnect state via polling fallback
      const msg = modal.querySelector('#pgStatusMsg');
      if (msg && !msg.textContent) {
        msg.textContent = 'Connection lost — reconnecting…';
        msg.style.color = 'var(--danger)';
        msg.style.display = 'block';
      }
    };

    // ── Pause / Resume ────────────────────────────────────────────────────────
    pauseBtn.addEventListener('click', async () => {
      pauseBtn.disabled = true;
      if (isPaused) {
        await window.electronAPI.multiDMResume(jobId);
      } else {
        await window.electronAPI.multiDMPause(jobId);
      }
      pauseBtn.disabled = false;
    });

    // ── Stop ──────────────────────────────────────────────────────────────────
    stopBtn.addEventListener('click', async () => {
      if (stopBtn.textContent.trim() === 'Close') return;
      stopBtn.textContent = 'Stopping…';
      stopBtn.disabled    = true;
      await window.electronAPI.multiDMStop(jobId);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Add one item to the live activity feed
  // ─────────────────────────────────────────────────────────────────────────
  _addFeedItem(feedEl, ev, accountList) {
    // Remove "waiting" placeholder
    const empty = feedEl.querySelector('.mdm-feed-empty');
    if (empty) empty.remove();

    const color  = workerColor(ev.worker || '');
    const init   = initial(ev.worker || '?');
    const isOk   = ev.result === 'sent';
    const isFail = ev.result === 'failed';
    const isSkip = ev.result === 'skipped';

    const item = document.createElement('div');
    item.className = `mdm-feed-item mdm-feed-${ev.result}`;
    item.innerHTML = `
      <div class="mdm-feed-acc" style="background:${color}20;border-color:${color}40;">
        <span class="mdm-feed-init" style="color:${color}">${init}</span>
      </div>
      <div class="mdm-feed-arrow ${isOk ? 'arrow-ok' : isFail ? 'arrow-fail' : 'arrow-skip'}">
        ${isOk ? '→' : isFail ? '✗' : '⊘'}
      </div>
      <div class="mdm-feed-user">
        <span class="mdm-feed-uid">${ev.userId ? ev.userId.slice(-6) : '——'}</span>
        ${ev.reason ? `<span class="mdm-feed-reason">${ev.reason}</span>` : ''}
      </div>
      <div class="mdm-feed-result ${isOk ? 'res-ok' : isFail ? 'res-fail' : 'res-skip'}">
        ${isOk ? 'Sent' : isFail ? 'Failed' : 'Skip'}
      </div>`;

    // Prepend so newest is at top
    feedEl.insertBefore(item, feedEl.firstChild);

    // Limit to 100 items in DOM
    while (feedEl.children.length > 100) feedEl.removeChild(feedEl.lastChild);
  }
}
