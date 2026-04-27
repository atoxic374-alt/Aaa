import { getDMsList, copyToClipboard } from '../utils/discord.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';

export class DMManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting = false;
    this.isSending = false;
    this.currentDMs = [];
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
            <div class="list-item" data-id="${dm.id}" data-username="${dm.username}">
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

    checkboxes.forEach(checkbox => checkbox.checked = isSelectAll);
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
      const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
        const item = checkbox.closest('.list-item');
        return { id: item.dataset.id, username: item.dataset.username };
      });

      await handleBulkDMActions(selectedDMs, 'delete', window.electronAPI);
      this.refreshDMsList();
    } finally {
      this.isDeleting = false;
    }
  }

  async closeSelectedDMs() {
    if (this.isDeleting) return;
    this.isDeleting = true;

    try {
      const selectedDMs = Array.from(document.querySelectorAll('.dm-checkbox:checked')).map(checkbox => {
        const item = checkbox.closest('.list-item');
        return { id: item.dataset.id, username: item.dataset.username };
      });

      await handleBulkDMActions(selectedDMs, 'close', window.electronAPI);
      this.refreshDMsList();
    } finally {
      this.isDeleting = false;
    }
  }

  copyToClipboard = copyToClipboard;

  async deleteDMMessages(channelId, username, oldestFirst = false, skipRefresh = false) {
    if (this.isDeleting) return;
    this.isDeleting = true;

    try {
      await deleteDMMessages({
        channelId,
        username,
        electronAPI: window.electronAPI,
        onComplete: () => {
          this.isDeleting = false;
          if (!skipRefresh) this.refreshDMsList();
        },
        skipRefresh,
        oldestFirst
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
    } catch (error) {
      console.error('Failed to close DM:', error);
    }
  }

  // ─── DM Sender ───────────────────────────────────────────────────────────────

  async showSendMessageModal() {
    const selectedIds = Array.from(document.querySelectorAll('.dm-checkbox:checked'))
      .map(cb => cb.closest('.list-item').dataset.id);

    const servers = await window.electronAPI.getServers();
    const serverList = servers.success ? servers.servers : [];

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content send-modal-content">
        <h2>Send Message</h2>

        <span class="modal-label">Target</span>
        <div class="send-target-group">
          <button class="send-target-btn active" data-target="all">
            All DMs <span class="target-count">(${this.currentDMs.length})</span>
          </button>
          <button class="send-target-btn${selectedIds.length === 0 ? ' send-target-disabled' : ''}"
            data-target="selected"
            ${selectedIds.length === 0 ? 'disabled title="Select DMs from the list first"' : ''}>
            Selected <span class="target-count">(${selectedIds.length})</span>
          </button>
          <button class="send-target-btn" data-target="server">
            Server Members
          </button>
        </div>

        <div id="serverSection" style="display:none;">
          <span class="modal-label">Server</span>
          <select class="modal-select" id="serverSelect">
            <option value="">— Choose a server —</option>
            ${serverList.map(s => `<option value="${s.id}">${s.name}</option>`).join('')}
          </select>

          <span class="modal-label">Channel</span>
          <select class="modal-select" id="channelSelect" disabled>
            <option value="all">All Channels</option>
          </select>

          <div id="memberCountBadge" style="display:none; margin-bottom:10px;">
            <span class="member-count-badge" id="memberCountText">Calculating...</span>
          </div>
        </div>

        <span class="modal-label">Message</span>
        <textarea class="modal-textarea" id="sendMessageText" placeholder="Enter your message..."></textarea>

        <div class="button-group" style="margin-top:20px;">
          <button id="startSendBtn">Start Sending</button>
          <button class="secondary-btn" id="cancelSendModalBtn">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let currentTarget = 'all';
    let currentServerMembers = [];

    // Target button switching
    modal.querySelectorAll('.send-target-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.querySelectorAll('.send-target-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTarget = btn.dataset.target;
        const serverSection = modal.querySelector('#serverSection');
        serverSection.style.display = currentTarget === 'server' ? 'block' : 'none';
      });
    });

    const serverSelect = modal.querySelector('#serverSelect');
    const channelSelect = modal.querySelector('#channelSelect');
    const memberCountBadge = modal.querySelector('#memberCountBadge');
    const memberCountText = modal.querySelector('#memberCountText');

    // Server change → load channels + members
    serverSelect.addEventListener('change', async () => {
      const serverId = serverSelect.value;
      if (!serverId) {
        channelSelect.innerHTML = '<option value="all">All Channels</option>';
        channelSelect.disabled = true;
        memberCountBadge.style.display = 'none';
        currentServerMembers = [];
        return;
      }

      channelSelect.disabled = true;
      channelSelect.innerHTML = '<option value="">Loading channels...</option>';
      memberCountBadge.style.display = 'block';
      memberCountText.textContent = 'Loading members...';

      const [chRes, memRes] = await Promise.all([
        window.electronAPI.getServerChannels(serverId),
        window.electronAPI.getServerMembers(serverId, 'all')
      ]);

      channelSelect.innerHTML = '<option value="all">All Channels</option>';
      if (chRes.success) {
        chRes.channels.forEach(ch => {
          const opt = document.createElement('option');
          opt.value = ch.id;
          opt.textContent = `#${ch.name}`;
          channelSelect.appendChild(opt);
        });
      }
      channelSelect.disabled = false;

      currentServerMembers = memRes.success ? memRes.members : [];
      memberCountText.textContent = `${currentServerMembers.length} members`;
    });

    // Channel change → update member count
    channelSelect.addEventListener('change', async () => {
      const serverId = serverSelect.value;
      if (!serverId) return;
      const channelId = channelSelect.value;

      memberCountText.textContent = 'Loading...';
      const memRes = await window.electronAPI.getServerMembers(serverId, channelId);
      currentServerMembers = memRes.success ? memRes.members : [];
      memberCountText.textContent = `${currentServerMembers.length} members`;
    });

    // Cancel
    modal.querySelector('#cancelSendModalBtn').addEventListener('click', () => modal.remove());

    // Start sending
    modal.querySelector('#startSendBtn').addEventListener('click', async () => {
      const textarea = modal.querySelector('#sendMessageText');
      const message = textarea.value.trim();

      if (!message) {
        textarea.style.borderColor = 'var(--danger)';
        textarea.focus();
        return;
      }

      let userIds = [];

      if (currentTarget === 'all') {
        userIds = this.currentDMs.map(dm => dm.id);
      } else if (currentTarget === 'selected') {
        userIds = selectedIds;
      } else if (currentTarget === 'server') {
        if (!serverSelect.value) {
          serverSelect.style.borderColor = 'var(--danger)';
          return;
        }
        userIds = currentServerMembers.map(m => m.id);
      }

      if (userIds.length === 0) {
        const err = document.createElement('p');
        err.className = 'error';
        err.style.marginTop = '10px';
        err.textContent = 'No targets found.';
        modal.querySelector('.modal-content').appendChild(err);
        return;
      }

      modal.remove();
      await this._startSending(userIds, message);
    });
  }

  async _startSending(userIds, message) {
    if (this.isSending) return;
    this.isSending = true;

    const total = userIds.length;
    let sent = 0;
    let failed = 0;
    let shouldStop = false;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        <h2>Sending Messages</h2>
        <div class="message-counter">
          <span id="senderCurrent">0</span> / <span id="senderTotal">${total}</span>
        </div>
        <div class="progress-container">
          <div class="progress-bar">
            <div class="progress" id="senderBar" style="width:0%"></div>
          </div>
          <div class="progress-text" id="senderPct">0%</div>
        </div>
        <div class="send-stats">
          <span class="stat-sent">✓ Sent: <strong id="statSent">0</strong></span>
          <span class="stat-failed">✗ Failed: <strong id="statFailed">0</strong></span>
        </div>
        <p id="senderStatus" style="margin-top:10px;font-size:0.85rem;color:var(--text-secondary);text-align:center;"></p>
        <button class="cancel-button" id="senderCancelBtn">Cancel</button>
      </div>
    `;
    document.body.appendChild(modal);

    const bar      = modal.querySelector('#senderBar');
    const pct      = modal.querySelector('#senderPct');
    const curEl    = modal.querySelector('#senderCurrent');
    const sentEl   = modal.querySelector('#statSent');
    const failedEl = modal.querySelector('#statFailed');
    const statusEl = modal.querySelector('#senderStatus');

    const updateUI = () => {
      const done = sent + failed;
      const p = Math.round((done / total) * 100);
      bar.style.width = `${p}%`;
      pct.textContent = `${p}%`;
      curEl.textContent = done;
      sentEl.textContent = sent;
      failedEl.textContent = failed;
    };

    modal.querySelector('#senderCancelBtn').addEventListener('click', () => {
      shouldStop = true;
      const btn = modal.querySelector('#senderCancelBtn');
      btn.textContent = 'Cancelling...';
      btn.disabled = true;
    });

    for (let i = 0; i < userIds.length; i++) {
      if (shouldStop) break;

      const userId = userIds[i];
      statusEl.textContent = `Sending to user ${i + 1} of ${total}...`;

      let success = false;
      let retries = 0;

      while (!success && retries < 3 && !shouldStop) {
        const result = await window.electronAPI.sendDM(userId, message);

        if (result.success) {
          success = true;
          sent++;
        } else if (result.rateLimited) {
          retries++;
          const waitMs = result.retryAfter
            ? Math.max(result.retryAfter * 1000, 5000) + 1000
            : 6000;
          statusEl.textContent = `Rate limited — waiting ${Math.ceil(waitMs / 1000)}s...`;
          await this._sleep(waitMs);
        } else {
          retries++;
          await this._sleep(2500);
        }
      }

      if (!success) failed++;
      updateUI();

      if (!shouldStop) {
        if ((i + 1) % 5 === 0 && i + 1 < total) {
          statusEl.textContent = 'Short pause to protect rate limits...';
          await this._sleep(3000);
        } else {
          await this._sleep(1200);
        }
      }
    }

    bar.style.width = '100%';
    pct.textContent = '100%';
    statusEl.textContent = shouldStop ? 'Cancelled.' : 'Done!';
    statusEl.style.color = shouldStop ? 'var(--danger)' : 'var(--success)';

    const cancelBtn = modal.querySelector('#senderCancelBtn');
    cancelBtn.textContent = 'Close';
    cancelBtn.disabled = false;
    cancelBtn.className = 'secondary-btn';
    cancelBtn.style.cssText = 'margin-top:16px; width:100%; display:block;';
    cancelBtn.onclick = () => modal.remove();

    this.isSending = false;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
