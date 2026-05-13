/* ══════════════════════════════════════════════════════════════
   DMManager — DM list, delete messages, close DMs
   ══════════════════════════════════════════════════════════════ */
import { copyToClipboard } from '../utils/ui.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';
import { handleBulkDMActions } from '../utils/bulkDMHandler.js';

export class DMManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.currentDMs  = [];
    this.isDeleting  = false;
  }

  async refreshDMsList() {
    this.contentArea.innerHTML = `<div class="blast-loading"><div class="blast-loader"></div><span>Loading DMs…</span></div>`;
    try {
      const res = await window.electronAPI.getDMs();
      this.currentDMs = res.success ? (res.dms || []) : [];
    } catch { this.currentDMs = []; }
    this._render();
  }

  _render() {
    const dms = this.currentDMs;
    this.contentArea.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--border);">
        <div>
          <h2 style="font-size:1rem;font-weight:800;color:var(--text);margin-bottom:2px;">Direct Messages</h2>
          <p style="font-size:.76rem;color:var(--text-3);">${dms.length} open conversations</p>
        </div>
        <div style="display:flex;gap:7px;">
          <button id="dmSelectAllBtn" class="secondary-btn" style="font-size:.78rem;padding:6px 12px;">Select All</button>
          <button id="dmDeleteSelBtn" class="danger-btn"    style="font-size:.78rem;padding:6px 12px;" disabled>Delete Msgs</button>
          <button id="dmCloseSelBtn"  class="danger-btn"    style="font-size:.78rem;padding:6px 12px;" disabled>Close DMs</button>
        </div>
      </div>
      ${dms.length === 0
        ? `<div class="state-empty">
             <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
             <h3>No DMs</h3><p>Your DM list is empty.</p>
           </div>`
        : `<div id="dmList">${dms.map((dm, i) => this._dmRow(dm, i)).join('')}</div>`
      }`;

    this._bindEvents();
  }

  _dmRow(dm, i) {
    return `
    <div class="list-item" style="animation-delay:${i * 0.025}s;" data-id="${dm.id}" data-user-id="${dm.userId || ''}" data-username="${dm.username}">
      <div class="list-item-left">
        <input type="checkbox" class="dm-cb" style="width:14px;height:14px;cursor:pointer;accent-color:var(--accent);flex-shrink:0;">
        <img src="${dm.avatar || ''}" alt="${dm.username}"
             onerror="this.style.display='none'"
             style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--border-2);object-fit:cover;flex-shrink:0;background:var(--bg-4);">
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:.875rem;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${dm.displayName || dm.username}</div>
          <div style="font-size:.74rem;color:var(--text-3);">@${dm.username}</div>
        </div>
      </div>
      <div class="button-group" style="gap:5px;">
        <button class="secondary-btn dm-copy-id" data-id="${dm.id}" style="font-size:.76rem;padding:5px 9px;">Copy ID</button>
        <button class="secondary-btn dm-del-msgs" data-id="${dm.id}" data-name="${dm.username}" style="font-size:.76rem;padding:5px 9px;">Delete Msgs</button>
        <button class="danger-btn dm-close"     data-id="${dm.id}"  style="font-size:.76rem;padding:5px 9px;">Close</button>
      </div>
    </div>`;
  }

  _bindEvents() {
    /* Select All */
    document.getElementById('dmSelectAllBtn')?.addEventListener('click', () => {
      const cbs   = document.querySelectorAll('.dm-cb');
      const btn   = document.getElementById('dmSelectAllBtn');
      const isAll = btn.textContent.trim() === 'Select All';
      cbs.forEach(cb => cb.checked = isAll);
      btn.textContent = isAll ? 'Deselect All' : 'Select All';
      this._updateBulkBtns();
    });

    /* Checkbox changes */
    document.querySelectorAll('.dm-cb').forEach(cb => cb.addEventListener('change', () => this._updateBulkBtns()));

    /* Delete selected messages */
    document.getElementById('dmDeleteSelBtn')?.addEventListener('click', async () => {
      if (this.isDeleting) return;
      this.isDeleting = true;
      const selected = this._getSelected();
      await handleBulkDMActions(selected, 'delete', window.electronAPI);
      this.isDeleting = false;
      this.refreshDMsList();
    });

    /* Close selected DMs */
    document.getElementById('dmCloseSelBtn')?.addEventListener('click', async () => {
      if (this.isDeleting) return;
      this.isDeleting = true;
      const selected = this._getSelected();
      await handleBulkDMActions(selected, 'close', window.electronAPI);
      this.isDeleting = false;
      this.refreshDMsList();
    });

    /* Per-row buttons */
    document.querySelectorAll('.dm-copy-id').forEach(btn => {
      btn.addEventListener('click', () => copyToClipboard(btn.dataset.id));
    });
    document.querySelectorAll('.dm-del-msgs').forEach(btn => {
      btn.addEventListener('click', () => this._deleteMessages(btn.dataset.id, btn.dataset.name));
    });
    document.querySelectorAll('.dm-close').forEach(btn => {
      btn.addEventListener('click', () => this._closeDM(btn.dataset.id));
    });
  }

  _getSelected() {
    return Array.from(document.querySelectorAll('.dm-cb:checked')).map(cb => {
      const row = cb.closest('.list-item');
      return { id: row.dataset.id, username: row.dataset.username };
    });
  }

  _updateBulkBtns() {
    const n = document.querySelectorAll('.dm-cb:checked').length;
    const delBtn = document.getElementById('dmDeleteSelBtn');
    const clsBtn = document.getElementById('dmCloseSelBtn');
    if (delBtn) { delBtn.disabled = n === 0; delBtn.textContent = n ? `Delete Msgs (${n})` : 'Delete Msgs'; }
    if (clsBtn) { clsBtn.disabled = n === 0; clsBtn.textContent = n ? `Close DMs (${n})`  : 'Close DMs'; }
  }

  async _deleteMessages(channelId, username) {
    if (this.isDeleting) return;
    this.isDeleting = true;
    try {
      await deleteDMMessages({ channelId, username, electronAPI: window.electronAPI, onComplete: () => { this.isDeleting = false; this.refreshDMsList(); } });
    } catch { this.isDeleting = false; }
  }

  async _closeDM(channelId) {
    try {
      const r = await window.electronAPI.closeDM(channelId);
      if (r.success) this.refreshDMsList();
    } catch {}
  }
}
