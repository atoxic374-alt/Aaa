import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';

export class DMManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;
    this.isSending = false;
    this.currentDMs = [];
    this._activeJobId = null;
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
        </div>
      `;
    } catch (error) {
      this.contentArea.innerHTML = '<p class="error">Failed to load DMs</p>';
    }
  }

  toggleSelectAllDMs() {
    const checkboxes = document.querySelectorAll('.dm-checkbox');
    const selectAllBtn = document.getElementById('selectAllDMsBtn');
    const isSelectAll = selectAllBtn.textContent === 'Select All';
    checkboxes.forEach(cb => cb.checked = isSelectAll);
    selectAllBtn.textContent = isSelectAll ? 'Deselect All' : 'Select All';
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const selectedCount = document.querySelectorAll('.dm-checkbox:checked').length;
    const deleteSelectedBtn = document.getElementById('deleteSelectedMessagesBtn');
    const closeSelectedBtn = document.getElementById('closeSelectedDMsBtn');
    deleteSelectedBtn.disabled = selectedCount === 0;
    closeSelectedBtn.disabled = selectedCount === 0;
    deleteSelectedBtn.textContent = `Delete Selected Messages (${selectedCount})`;
    closeSelectedBtn.textContent = `Close Selected DMs (${selectedCount})`;
  }

  async deleteSelectedMessages() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(cb => {
        const item = cb.closest('.list-item');
        return { id: item.dataset.id, username: item.dataset.username };
      });
      await handleBulkDMActions(selectedDMs, 'delete', window.electronAPI);
      this.refreshDMsList();
    } finally { this.isDeleting = false; }
  }

  async closeSelectedDMs() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(cb => {
        const item = cb.closest('.list-item');
        return { id: item.dataset.id, username: item.dataset.username };
      });
      await handleBulkDMActions(selectedDMs, 'close', window.electronAPI);
      this.refreshDMsList();
    } finally { this.isDeleting = false; }
  }

  copyToClipboard = copyToClipboard;

  async deleteDMMessages(channelId, username, oldestFirst = false, skipRefresh = false) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      await deleteDMMessages({
        channelId, username,
        electronAPI: window.electronAPI,
        onComplete: () => { this.isDeleting = false; if (!skipRefresh) this.refreshDMsList(); },
        skipRefresh, oldestFirst
      });
    } catch (error) {
      console.error('Failed to delete messages:', error);
      this.isDeleting = false;
    }
  }

  async closeDM(channelId) {
    if (this.isDeleting) return;
    try {
      const result = await window.electronAPI.closeDM(channelId);
      if (result.success) this.refreshDMsList();
    } catch (error) { console.error('Failed to close DM:', error); }
  }

  // ─── Multi-Account DM Sender ─────────────────────────────────────────────────

  async showSendMessageModal() {
    const selectedUserIds = Array.from(document.querySelectorAll('.dm-checkbox:checked'))
      .map(cb => cb.closest('.list-item').dataset.userId).filter(Boolean);

    const [serversRes, tokensRes] = await Promise.all([
      window.electronAPI.getServers(),
      window.electronAPI.getTokens()
    ]);

    const serverList = serversRes.success ? serversRes.servers : [];
    const savedTokens = tokensRes.success ? (tokensRes.tokens || []) : [];

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content send-modal-content">
        <h2 class="mdm-title">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:8px">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Multi-Account DM Blast
        </h2>

        <!-- TARGET -->
        <span class="modal-label">Target</span>
        <div class="send-target-group">
          <button class="send-target-btn active" data-target="all">
            All DM Contacts <span class="target-count">(${this.currentDMs.length})</span>
          </button>
          <button class="send-target-btn${selectedUserIds.length === 0 ? ' send-target-disabled' : ''}"
            data-target="selected"
            ${selectedUserIds.length === 0 ? 'disabled title="Select DMs from the list first"' : ''}>
            Selected Contacts <span class="target-count">(${selectedUserIds.length})</span>
          </button>
          <button class="send-target-btn" data-target="server">
            Server Members
          </button>
        </div>

        <!-- SERVER SECTION -->
        <div id="serverSection" style="display:none;">
          <span class="modal-label">Server</span>
          <select class="modal-select" id="serverSelect">
            <option value="">— Choose a server —</option>
            ${serverList.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
          </select>
          <span class="modal-label">Member Filter</span>
          <select class="modal-select" id="channelSelect" disabled>
            <option value="all">All Server Members</option>
          </select>
          <div id="memberCountBadge" style="display:none;margin-bottom:10px;">
            <span class="member-count-badge" id="memberCountText">Calculating...</span>
          </div>
        </div>

        <!-- ACCOUNTS -->
        <span class="modal-label">Accounts to Use</span>
        <div class="mdm-accounts-box" id="mdmAccountsBox">
          ${savedTokens.length === 0
            ? `<p class="mdm-no-accounts">No saved tokens found. Save tokens from the Login page first.</p>`
            : savedTokens.map((t, i) => `
              <label class="mdm-account-row" id="mdmAcc_${i}">
                <input type="checkbox" class="mdm-acc-check" data-name="${t.name}" data-token="${t.token}" checked>
                <span class="mdm-acc-dot"></span>
                <span class="mdm-acc-name">${t.name || 'Account ' + (i+1)}</span>
                <span class="mdm-acc-tail">···${t.token.slice(-6)}</span>
              </label>
            `).join('')}
        </div>
        <p class="mdm-accounts-hint">Each account gets its own queue. Members are split evenly with a lock to prevent duplicates.</p>

        <!-- MESSAGE -->
        <span class="modal-label">Message</span>
        <textarea class="modal-textarea" id="sendMessageText" placeholder="Enter your message..."></textarea>

        <!-- IMAGES -->
        <span class="modal-label">Attach Images <span style="opacity:.6;font-size:.78rem;">(max 10, 8 MB each)</span></span>
        <div class="mdm-image-area" id="mdmImageArea">
          <div class="mdm-image-drop" id="mdmImageDrop">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span>Click or drag images here</span>
            <input type="file" id="mdmFileInput" accept="image/*" multiple style="display:none;">
          </div>
          <div class="mdm-image-previews" id="mdmImagePreviews"></div>
        </div>

        <!-- STATS PREVIEW -->
        <div class="mdm-stats-preview" id="mdmStatsPreview" style="display:none;">
          <div class="mdm-stat-item"><span id="mdmStatAccounts">0</span><small>Accounts</small></div>
          <div class="mdm-stat-item"><span id="mdmStatMembers">0</span><small>Members</small></div>
          <div class="mdm-stat-item"><span id="mdmStatPer">0</span><small>Per Account</small></div>
          <div class="mdm-stat-item"><span id="mdmStatETA">—</span><small>Est. Time</small></div>
        </div>

        <div class="button-group" style="margin-top:18px;">
          <button id="startSendBtn" class="send-btn">Start Sending</button>
          <button class="secondary-btn" id="cancelSendModalBtn">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let currentTarget = 'all';
    let currentServerMembers = [];
    const uploadedImages = [];

    const updateStatsPreview = () => {
      const checkedAccounts = modal.querySelectorAll('.mdm-acc-check:checked').length;
      let memberCount = 0;
      if (currentTarget === 'all') memberCount = this.currentDMs.length;
      else if (currentTarget === 'selected') memberCount = selectedUserIds.length;
      else memberCount = currentServerMembers.length;

      const preview = modal.querySelector('#mdmStatsPreview');
      if (checkedAccounts > 0 && memberCount > 0) {
        preview.style.display = 'flex';
        modal.querySelector('#mdmStatAccounts').textContent = checkedAccounts;
        modal.querySelector('#mdmStatMembers').textContent = memberCount;
        const perAcc = Math.ceil(memberCount / checkedAccounts);
        modal.querySelector('#mdmStatPer').textContent = perAcc;
        const estSec = Math.ceil(perAcc * 0.9);
        const mm = Math.floor(estSec / 60), ss = estSec % 60;
        modal.querySelector('#mdmStatETA').textContent = mm > 0 ? `~${mm}m ${ss}s` : `~${ss}s`;
      } else {
        preview.style.display = 'none';
      }
    };

    modal.querySelectorAll('.send-target-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.send-target-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTarget = btn.dataset.target;
        modal.querySelector('#serverSection').style.display = currentTarget === 'server' ? 'block' : 'none';
        updateStatsPreview();
      });
    });

    modal.querySelectorAll('.mdm-acc-check').forEach(cb => {
      cb.addEventListener('change', updateStatsPreview);
    });

    const serverSelect = modal.querySelector('#serverSelect');
    const channelSelect = modal.querySelector('#channelSelect');
    const memberCountBadge = modal.querySelector('#memberCountBadge');
    const memberCountText = modal.querySelector('#memberCountText');

    serverSelect.addEventListener('change', async () => {
      const serverId = serverSelect.value;
      if (!serverId) {
        channelSelect.innerHTML = '<option value="all">All Server Members</option>';
        channelSelect.disabled = true;
        memberCountBadge.style.display = 'none';
        currentServerMembers = [];
        updateStatsPreview();
        return;
      }
      channelSelect.disabled = true;
      channelSelect.innerHTML = '<option value="">Loading...</option>';
      memberCountBadge.style.display = 'block';
      memberCountText.textContent = 'Loading members...';

      const [chRes, memRes] = await Promise.all([
        window.electronAPI.getServerChannels(serverId),
        window.electronAPI.getServerMembers(serverId, 'all')
      ]);

      channelSelect.innerHTML = '<option value="all">All Server Members</option>';
      if (chRes.success) {
        chRes.channels.forEach(ch => {
          const opt = document.createElement('option');
          opt.value = ch.id; opt.textContent = `#${ch.name}`;
          channelSelect.appendChild(opt);
        });
      }
      channelSelect.disabled = false;
      currentServerMembers = memRes.success ? memRes.members : [];
      memberCountText.textContent = `${currentServerMembers.length} members`;
      updateStatsPreview();
    });

    channelSelect.addEventListener('change', async () => {
      if (!serverSelect.value) return;
      memberCountText.textContent = 'Loading...';
      const memRes = await window.electronAPI.getServerMembers(serverSelect.value, channelSelect.value);
      currentServerMembers = memRes.success ? memRes.members : [];
      memberCountText.textContent = `${currentServerMembers.length} members`;
      updateStatsPreview();
    });

    // Image Upload
    const imageArea = modal.querySelector('#mdmImageDrop');
    const fileInput = modal.querySelector('#mdmFileInput');
    const previewsEl = modal.querySelector('#mdmImagePreviews');

    const renderImagePreviews = () => {
      previewsEl.innerHTML = uploadedImages.map((img, i) => `
        <div class="mdm-img-thumb" title="${img.name}">
          <img src="data:${img.type};base64,${img.data}" alt="${img.name}">
          <button class="mdm-img-remove" onclick="window._mdmRemoveImg(${i})">✕</button>
        </div>
      `).join('');
      imageArea.querySelector('span').textContent =
        uploadedImages.length >= 10 ? 'Max images reached' : 'Click or drag images here';
    };

    window._mdmRemoveImg = (i) => {
      uploadedImages.splice(i, 1);
      renderImagePreviews();
    };

    const processFiles = async (files) => {
      const remaining = 10 - uploadedImages.length;
      const toProcess = Array.from(files).slice(0, remaining);
      for (const file of toProcess) {
        if (!file.type.startsWith('image/')) continue;
        if (file.size > 8 * 1024 * 1024) continue;
        const data = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = e => resolve(e.target.result.split(',')[1]);
          reader.readAsDataURL(file);
        });
        uploadedImages.push({ name: file.name, type: file.type, data });
      }
      renderImagePreviews();
    };

    imageArea.addEventListener('click', () => { if (uploadedImages.length < 10) fileInput.click(); });
    fileInput.addEventListener('change', () => processFiles(fileInput.files));
    imageArea.addEventListener('dragover', e => { e.preventDefault(); imageArea.classList.add('drag-over'); });
    imageArea.addEventListener('dragleave', () => imageArea.classList.remove('drag-over'));
    imageArea.addEventListener('drop', e => {
      e.preventDefault();
      imageArea.classList.remove('drag-over');
      processFiles(e.dataTransfer.files);
    });

    modal.querySelector('#cancelSendModalBtn').addEventListener('click', () => modal.remove());

    modal.querySelector('#startSendBtn').addEventListener('click', async () => {
      const textarea = modal.querySelector('#sendMessageText');
      const message = textarea.value.trim();
      if (!message) { textarea.style.borderColor = 'var(--danger)'; textarea.focus(); return; }

      const checkedAccounts = Array.from(modal.querySelectorAll('.mdm-acc-check:checked')).map(cb => ({
        name: cb.dataset.name,
        token: cb.dataset.token
      }));

      if (checkedAccounts.length === 0) {
        const box = modal.querySelector('#mdmAccountsBox');
        box.style.borderColor = 'var(--danger)';
        box.style.boxShadow = '0 0 0 2px rgba(232,17,35,0.25)';
        return;
      }

      let userIds = [];
      if (currentTarget === 'all') userIds = this.currentDMs.map(dm => dm.userId).filter(Boolean);
      else if (currentTarget === 'selected') userIds = selectedUserIds;
      else if (currentTarget === 'server') {
        if (!serverSelect.value) { serverSelect.style.borderColor = 'var(--danger)'; return; }
        userIds = currentServerMembers.map(m => m.id);
      }

      if (userIds.length === 0) {
        const err = document.createElement('p');
        err.className = 'error'; err.style.marginTop = '10px';
        err.textContent = 'No target members found.';
        modal.querySelector('.modal-content').appendChild(err);
        return;
      }

      modal.remove();
      await this._startMultiSending(checkedAccounts, [...new Set(userIds)], message, uploadedImages);
    });

    updateStatsPreview();
  }

  async _startMultiSending(accountList, userIds, message, images) {
    if (this.isSending) return;
    this.isSending = true;

    const startRes = await window.electronAPI.multiDMStart(accountList, userIds, message, images);
    if (!startRes.success) {
      alert(`Failed to start: ${startRes.error}`);
      this.isSending = false;
      return;
    }

    const jobId = startRes.jobId;
    const total = userIds.length;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content mdm-progress-modal">
        <h2 class="mdm-title">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:8px">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          Sending in Progress
        </h2>

        <div class="mdm-overall-stats">
          <div class="mdm-ost-item">
            <span id="mdmpTotal">${total}</span><small>Total</small>
          </div>
          <div class="mdm-ost-item success-color">
            <span id="mdmpSent">0</span><small>Sent</small>
          </div>
          <div class="mdm-ost-item danger-color">
            <span id="mdmpFailed">0</span><small>Failed</small>
          </div>
          <div class="mdm-ost-item">
            <span id="mdmpETA">—</span><small>ETA</small>
          </div>
          <div class="mdm-ost-item">
            <span id="mdmpSpeed">—</span><small>Sent/s</small>
          </div>
        </div>

        <div class="progress-container" style="margin-bottom:16px;">
          <div class="progress-bar">
            <div class="progress" id="mdmpBar" style="width:0%"></div>
          </div>
          <div class="progress-text" id="mdmpPct">0%</div>
        </div>

        <div class="mdm-workers-grid" id="mdmpWorkers">
          ${accountList.map((acc, i) => `
            <div class="mdm-worker-card" id="mdmWorker_${i}">
              <div class="mdm-worker-header">
                <span class="mdm-worker-name">${acc.name || 'Account ' + (i+1)}</span>
                <span class="mdm-worker-badge idle" id="mdmWStatus_${i}">idle</span>
              </div>
              <div class="mdm-worker-progress">
                <div class="mdm-worker-bar-track">
                  <div class="mdm-worker-bar" id="mdmWBar_${i}" style="width:0%"></div>
                </div>
              </div>
              <div class="mdm-worker-stats">
                <span class="mdm-ws-sent">✓ <strong id="mdmWSent_${i}">0</strong></span>
                <span class="mdm-ws-failed">✗ <strong id="mdmWFailed_${i}">0</strong></span>
                <span class="mdm-ws-total" style="opacity:.55;">/ <span id="mdmWTotal_${i}">${Math.ceil(total / accountList.length)}</span></span>
              </div>
            </div>
          `).join('')}
        </div>

        <div id="mdmpStatusMsg" style="margin-top:12px;font-size:0.82rem;color:var(--text-secondary);text-align:center;min-height:18px;"></div>
        <button class="cancel-button" id="mdmpStopBtn">Stop</button>
      </div>
    `;
    document.body.appendChild(modal);

    const stopBtn = modal.querySelector('#mdmpStopBtn');
    stopBtn.addEventListener('click', async () => {
      stopBtn.textContent = 'Stopping...';
      stopBtn.disabled = true;
      await window.electronAPI.multiDMStop(jobId);
    });

    const applyState = (state) => {
      const done = state.done || 0;
      const pct = state.total > 0 ? Math.round((done / state.total) * 100) : 0;
      modal.querySelector('#mdmpBar').style.width = `${pct}%`;
      modal.querySelector('#mdmpPct').textContent = `${pct}%`;
      modal.querySelector('#mdmpSent').textContent = state.sent || 0;
      modal.querySelector('#mdmpFailed').textContent = state.failed || 0;
      modal.querySelector('#mdmpTotal').textContent = state.total || total;

      const eta = state.eta;
      modal.querySelector('#mdmpETA').textContent = eta != null
        ? (eta >= 60 ? `~${Math.floor(eta/60)}m${eta%60}s` : `~${eta}s`)
        : '—';
      modal.querySelector('#mdmpSpeed').textContent =
        state.speed && state.speed > 0 ? `${state.speed}/s` : '—';

      (state.workers || []).forEach((w, i) => {
        const wTotal = w.total || 1;
        const wDone = (w.sent || 0) + (w.failed || 0);
        const wPct = Math.round((wDone / wTotal) * 100);

        const barEl = modal.querySelector(`#mdmWBar_${i}`);
        const statusEl = modal.querySelector(`#mdmWStatus_${i}`);
        const sentEl = modal.querySelector(`#mdmWSent_${i}`);
        const failedEl = modal.querySelector(`#mdmWFailed_${i}`);
        const totalEl = modal.querySelector(`#mdmWTotal_${i}`);

        if (barEl) barEl.style.width = `${wPct}%`;
        if (totalEl) totalEl.textContent = wTotal;
        if (sentEl) sentEl.textContent = w.sent || 0;
        if (failedEl) failedEl.textContent = w.failed || 0;
        if (statusEl) {
          statusEl.textContent = w.status || 'idle';
          statusEl.className = `mdm-worker-badge ${
            w.status === 'done' ? 'done' :
            w.status === 'running' ? 'running' :
            w.status?.includes('rate') ? 'ratelimit' :
            w.status === 'stopped' ? 'stopped' : 'idle'
          }`;
        }
      });

      if (state.finished || state.stopped) {
        const msg = modal.querySelector('#mdmpStatusMsg');
        msg.textContent = state.stopped ? 'Operation stopped.' : 'All done!';
        msg.style.color = state.stopped ? 'var(--danger)' : 'var(--success)';
        stopBtn.textContent = 'Close';
        stopBtn.disabled = false;
        stopBtn.className = 'secondary-btn';
        stopBtn.style.cssText = 'margin-top:16px;width:100%;display:block;';
        stopBtn.onclick = () => modal.remove();
        if (this._activeSSE) { this._activeSSE.close(); this._activeSSE = null; }
        this.isSending = false;
        this._activeJobId = null;
      }
    };

    this._activeJobId = jobId;
    const sse = new EventSource(`/api/multi-dm/stream/${jobId}`);
    this._activeSSE = sse;
    sse.onmessage = (e) => {
      try { applyState(JSON.parse(e.data)); } catch (err) {}
    };
    sse.onerror = () => {
      const msg = modal.querySelector('#mdmpStatusMsg');
      if (msg) { msg.textContent = 'Connection lost — check console.'; msg.style.color = 'var(--danger)'; }
      sse.close();
      this.isSending = false;
    };
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
