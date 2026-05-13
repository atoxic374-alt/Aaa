import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';

export class DMManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;
    this.isSending = false;
    this.currentDMs = [];
    this._activeSSE = null;
  }

  async refreshDMsList() {
    try {
      const dms = await getDMsList();
      this.currentDMs = dms;
      this.contentArea.innerHTML = `
        <h2>DMs List</h2>
        <div class="actions-bar">
          <button id="selectAllDMsBtn" onclick="window.dmManager.toggleSelectAllDMs()">Select All</button>
          <button id="deleteSelectedMessagesBtn" onclick="window.dmManager.deleteSelectedMessages()" disabled>Delete Selected Messages</button>
          <button id="closeSelectedDMsBtn" onclick="window.dmManager.closeSelectedDMs()" disabled>Close Selected DMs</button>
          <button id="sendMessageBtn" onclick="window.dmManager.showSendMessageModal()" class="send-btn">Send Message</button>
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
                <button onclick="window.dmManager.deleteDMMessages('${dm.id}', '${dm.username}', false)" class="secondary-btn">Delete Messages</button>
                <button onclick="window.dmManager.deleteDMMessages('${dm.id}', '${dm.username}', true)" class="secondary-btn">Delete Oldest First</button>
                <button onclick="window.dmManager.closeDM('${dm.id}')" class="danger-btn">Close DM</button>
              </div>
            </div>
          `).join('')}
        </div>`;
    } catch (error) {
      this.contentArea.innerHTML = '<p class="error">Failed to load DMs</p>';
    }
  }

  toggleSelectAllDMs() {
    const checkboxes = document.querySelectorAll('.dm-checkbox');
    const btn = document.getElementById('selectAllDMsBtn');
    const isAll = btn.textContent === 'Select All';
    checkboxes.forEach(cb => cb.checked = isAll);
    btn.textContent = isAll ? 'Deselect All' : 'Select All';
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n = document.querySelectorAll('.dm-checkbox:checked').length;
    const delBtn = document.getElementById('deleteSelectedMessagesBtn');
    const closeBtn = document.getElementById('closeSelectedDMsBtn');
    delBtn.disabled = n === 0;
    closeBtn.disabled = n === 0;
    delBtn.textContent = `Delete Selected Messages (${n})`;
    closeBtn.textContent = `Close Selected DMs (${n})`;
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

  async deleteDMMessages(channelId, username, oldestFirst = false, skipRefresh = false) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      await deleteDMMessages({
        channelId, username, electronAPI: window.electronAPI,
        onComplete: () => { this.isDeleting = false; if (!skipRefresh) this.refreshDMsList(); },
        skipRefresh, oldestFirst
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
  //  Multi-Account DM Modal
  // ─────────────────────────────────────────────────────────────────────────

  async showSendMessageModal() {
    const selectedUserIds = Array.from(document.querySelectorAll('.dm-checkbox:checked'))
      .map(cb => cb.closest('.list-item').dataset.userId).filter(Boolean);

    const [serversRes, tokensRes] = await Promise.all([
      window.electronAPI.getServers(),
      window.electronAPI.getTokens()
    ]);
    const serverList  = serversRes.success ? serversRes.servers : [];
    const savedTokens = tokensRes.success   ? (tokensRes.tokens || []) : [];

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
            data-target="selected"
            ${selectedUserIds.length === 0 ? 'disabled' : ''}>
            Selected Contacts <span class="target-count">(${selectedUserIds.length})</span>
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
                <span class="mdm-acc-name">${t.name || 'Account ' + (i+1)}</span>
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

        <!-- MESSAGE -->
        <span class="modal-label">Message</span>
        <textarea class="modal-textarea" id="sendMessageText" placeholder="Enter your message…" rows="3"></textarea>

        <!-- IMAGES -->
        <span class="modal-label">
          Images
          <span style="opacity:.55;font-size:.76rem;"> (max 10 · 8 MB each)</span>
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

    let currentTarget = 'all';
    let currentServerMembers = [];
    const uploadedImages = [];

    // ── helpers ──────────────────────────────────────────────────────────────
    const updatePreview = () => {
      const checked = modal.querySelectorAll('.mdm-acc-check:checked').length;
      let members = 0;
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
        const sec = Math.ceil(perAcc * 0.95);
        modal.querySelector('#mdmSE').textContent =
          sec >= 60 ? `~${Math.floor(sec/60)}m${sec%60}s` : `~${sec}s`;
      } else { prev.style.display = 'none'; }
    };

    // ── target buttons ───────────────────────────────────────────────────────
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

    modal.querySelectorAll('.mdm-acc-check').forEach(cb =>
      cb.addEventListener('change', updatePreview));

    // ── server selects ───────────────────────────────────────────────────────
    const serverSel = modal.querySelector('#serverSelect');
    const channelSel = modal.querySelector('#channelSelect');
    const badge = modal.querySelector('#memberCountBadge');
    const badgeTxt = modal.querySelector('#memberCountText');

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

    // ── validate button ──────────────────────────────────────────────────────
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
          const row = modal.querySelector(`#mdmRow_${i}`);
          const valBadge = modal.querySelector(`#mdmVal_${i}`);
          const dot = row?.querySelector('.mdm-acc-dot');
          const cb = modal.querySelectorAll('.mdm-acc-check')[i];
          if (r.valid) {
            valid++;
            if (valBadge) { valBadge.textContent = '✓ valid'; valBadge.className = 'mdm-val-badge valid'; }
            if (dot) dot.style.background = '#3ba55d';
          } else {
            dead++;
            if (valBadge) { valBadge.textContent = '✗ 401'; valBadge.className = 'mdm-val-badge dead'; }
            if (dot) { dot.style.background = 'var(--danger)'; dot.style.boxShadow = '0 0 6px var(--danger)'; }
            if (cb) cb.checked = false;
            if (row) row.style.opacity = '0.5';
          }
        });
        hint.textContent = `${valid} valid · ${dead} dead`;
        hint.style.color = dead > 0 ? 'var(--danger)' : '#3ba55d';
        updatePreview();
      }

      vBtn.disabled = false;
      vBtn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> Validate Tokens`;
    });

    // ── image upload ─────────────────────────────────────────────────────────
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

    // ── cancel ───────────────────────────────────────────────────────────────
    modal.querySelector('#cancelSendModalBtn').addEventListener('click', () => modal.remove());
    modal.querySelector('#cancelSendModalBtn2').addEventListener('click', () => modal.remove());

    // ── start ────────────────────────────────────────────────────────────────
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
        box.style.boxShadow = '0 0 0 2px rgba(232,17,35,.25)';
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
      await this._startBlast(accounts, [...new Set(userIds)], msg, uploadedImages);
    });

    updatePreview();
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  Progress Modal
  // ─────────────────────────────────────────────────────────────────────────

  async _startBlast(accountList, userIds, message, images) {
    if (this.isSending) return;
    this.isSending = true;

    const startRes = await window.electronAPI.multiDMStart(accountList, userIds, message, images);
    if (!startRes.success) {
      alert('Failed to start: ' + startRes.error);
      this.isSending = false;
      return;
    }

    const { jobId, total } = startRes;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content mdm-progress-modal">

        <div class="mdm-compose-header" style="margin-bottom:14px;">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <span>DM Blast — Live Progress</span>
        </div>

        <!-- Global stats row -->
        <div class="mdm-overall-stats">
          <div class="mdm-ost-item"><span id="pgTotal">${total}</span><small>Total</small></div>
          <div class="mdm-ost-item success-color"><span id="pgSent">0</span><small>Sent</small></div>
          <div class="mdm-ost-item danger-color"><span id="pgFailed">0</span><small>Failed</small></div>
          <div class="mdm-ost-item"><span id="pgAlive">${accountList.length}</span><small>Active Acc.</small></div>
          <div class="mdm-ost-item"><span id="pgSpeed">—</span><small>msg/s</small></div>
          <div class="mdm-ost-item"><span id="pgETA">—</span><small>ETA</small></div>
        </div>

        <!-- Global progress bar -->
        <div class="progress-container" style="margin:10px 0 16px;">
          <div class="progress-bar"><div class="progress" id="pgBar" style="width:0%"></div></div>
          <div class="progress-text" id="pgPct">0%</div>
        </div>

        <!-- Per-account workers -->
        <div class="mdm-workers-grid" id="pgWorkers">
          ${accountList.map((acc, i) => `
            <div class="mdm-worker-card" id="pgW_${i}">
              <div class="mdm-worker-header">
                <span class="mdm-worker-name">${acc.name || 'Account ' + (i+1)}</span>
                <span class="mdm-worker-badge idle" id="pgWS_${i}">idle</span>
              </div>
              <div class="mdm-worker-bar-track">
                <div class="mdm-worker-bar" id="pgWB_${i}" style="width:0%"></div>
              </div>
              <div class="mdm-worker-stats">
                <span class="mdm-ws-sent">✓ <b id="pgWSent_${i}">0</b></span>
                <span class="mdm-ws-failed">✗ <b id="pgWFail_${i}">0</b></span>
                <span style="opacity:.45;font-size:.75rem;">skip <b id="pgWSkip_${i}">0</b></span>
                <span style="opacity:.45;font-size:.75rem;">RL <b id="pgWRL_${i}">0</b></span>
              </div>
              <div class="mdm-worker-delay" id="pgWDelay_${i}"></div>
            </div>`).join('')}
        </div>

        <div id="pgStatusMsg" style="text-align:center;font-size:.82rem;color:var(--text-secondary);margin-top:12px;min-height:18px;"></div>

        <button class="cancel-button" id="pgStopBtn" style="margin-top:14px;">Stop</button>
      </div>`;
    document.body.appendChild(modal);

    const stopBtn = modal.querySelector('#pgStopBtn');
    stopBtn.addEventListener('click', async () => {
      stopBtn.textContent = 'Stopping…';
      stopBtn.disabled = true;
      await window.electronAPI.multiDMStop(jobId);
    });

    const applyState = (st) => {
      const done = st.done || 0;
      const pct  = st.total > 0 ? Math.round((done / st.total) * 100) : 0;

      modal.querySelector('#pgBar').style.width = `${pct}%`;
      modal.querySelector('#pgPct').textContent  = `${pct}%`;
      modal.querySelector('#pgSent').textContent   = st.sent   || 0;
      modal.querySelector('#pgFailed').textContent = st.failed || 0;
      modal.querySelector('#pgAlive').textContent  = st.alive  ?? accountList.length;
      modal.querySelector('#pgSpeed').textContent  = (st.speed && +st.speed > 0) ? `${(+st.speed).toFixed(2)}` : '—';

      const eta = st.eta;
      modal.querySelector('#pgETA').textContent = eta != null
        ? (eta >= 60 ? `~${Math.floor(eta/60)}m${eta%60}s` : `~${eta}s`) : '—';

      (st.workers || []).forEach((w, i) => {
        const wDone = (w.sent || 0) + (w.failed || 0) + (w.skipped || 0);
        const wTotal = Math.max(1, Math.ceil((st.total || 1) / (st.workers?.length || 1)));
        const wPct   = Math.min(100, Math.round((wDone / wTotal) * 100));

        const bar   = modal.querySelector(`#pgWB_${i}`);
        const badge = modal.querySelector(`#pgWS_${i}`);
        const card  = modal.querySelector(`#pgW_${i}`);
        const delay = modal.querySelector(`#pgWDelay_${i}`);

        if (bar)   bar.style.width = `${wPct}%`;
        if (modal.querySelector(`#pgWSent_${i}`))  modal.querySelector(`#pgWSent_${i}`).textContent  = w.sent    || 0;
        if (modal.querySelector(`#pgWFail_${i}`))  modal.querySelector(`#pgWFail_${i}`).textContent  = w.failed  || 0;
        if (modal.querySelector(`#pgWSkip_${i}`))  modal.querySelector(`#pgWSkip_${i}`).textContent  = w.skipped || 0;
        if (modal.querySelector(`#pgWRL_${i}`))    modal.querySelector(`#pgWRL_${i}`).textContent    = w.rateLimited || 0;
        if (delay) delay.textContent = w.delay ? `${w.delay}ms delay` : '';

        if (badge) {
          badge.textContent = w.status || 'idle';
          badge.className = `mdm-worker-badge ${
            w.dead                       ? 'dead-badge'  :
            w.status === 'done'          ? 'done'        :
            w.status === 'running' || w.status === 'sending' || w.status === 'opening DM' ? 'running' :
            w.status?.includes('rate')   ? 'ratelimit'   :
            w.status === 'stopped' || w.status?.includes('stop') ? 'stopped' : 'idle'
          }`;
        }
        if (card && w.dead) card.classList.add('mdm-worker-dead');
      });

      if (st.finished || st.stopped) {
        const msg = modal.querySelector('#pgStatusMsg');
        const ok  = !st.stopped && !st.workers?.some(w => w.dead && w.sent === 0);
        msg.textContent = st.stopped ? 'Blast stopped by user.' : '✓ Blast complete!';
        msg.style.color = st.stopped ? 'var(--danger)' : '#3ba55d';
        stopBtn.textContent = 'Close';
        stopBtn.disabled = false;
        stopBtn.className = 'secondary-btn';
        stopBtn.style.cssText = 'margin-top:16px;width:100%;display:block;';
        stopBtn.onclick = () => modal.remove();
        if (this._activeSSE) { this._activeSSE.close(); this._activeSSE = null; }
        this.isSending = false;
      }
    };

    const sse = new EventSource(`/api/multi-dm/stream/${jobId}`);
    this._activeSSE = sse;
    sse.onmessage = e => { try { applyState(JSON.parse(e.data)); } catch (_) {} };
    sse.onerror = () => {
      const msg = modal.querySelector('#pgStatusMsg');
      if (msg) { msg.textContent = 'SSE disconnected.'; msg.style.color = 'var(--danger)'; }
      sse.close();
      this.isSending = false;
    };
  }
}
