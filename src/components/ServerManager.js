import { getServersList, copyToClipboard } from '../utils/discord.js';
import { showNotification, showProgressModal } from '../utils/ui.js';

export class ServerManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
  }

  async muteServer(serverId) {
    try {
      await window.electronAPI.muteServer(serverId);
      showNotification('Server muted', 'success');
      this.refreshServersList();
    } catch (e) {
      showNotification('Failed to mute server', 'error');
    }
  }

  async unmuteServer(serverId) {
    try {
      await window.electronAPI.unmuteServer(serverId);
      showNotification('Server unmuted', 'success');
      this.refreshServersList();
    } catch (e) {
      showNotification('Failed to unmute server', 'error');
    }
  }

  async readAll() {
    try {
      const result = await window.electronAPI.readAll();
      if (result.success) showNotification('Marked all as read!', 'success');
      else showNotification('Failed to mark all as read', 'error');
    } catch (e) {
      showNotification('Failed to mark all as read', 'error');
    }
  }

  async muteSelectedServers() {
    const selected = document.querySelectorAll('.server-checkbox:checked');
    const total    = selected.length;
    let completed  = 0;
    const { updateProgress, closeModal } = showProgressModal('Muting Servers', total);

    for (const cb of selected) {
      const item     = cb.closest('.list-item');
      const serverId = item.dataset.id;
      try {
        await window.electronAPI.muteServer(serverId);
        completed++;
        updateProgress(completed);
      } catch (e) { console.error(e); }
    }
    setTimeout(() => { closeModal(); this.refreshServersList(); }, 700);
  }

  async leaveSelectedServers() {
    const selected = document.querySelectorAll('.server-checkbox:checked');
    const total    = selected.length;
    let completed  = 0;
    const { updateProgress, closeModal } = showProgressModal('Leaving Servers', total);

    for (const cb of selected) {
      const item     = cb.closest('.list-item');
      const serverId = item.dataset.id;
      try {
        await window.electronAPI.leaveServer(serverId);
        completed++;
        updateProgress(completed);
        item.style.opacity   = '0';
        item.style.transform = 'translateX(-20px)';
        await new Promise(r => setTimeout(r, 80));
        item.remove();
      } catch (e) { console.error(e); }
    }
    setTimeout(() => { closeModal(); this.refreshServersList(); }, 700);
  }

  async leaveServer(serverId) {
    const item = document.querySelector(`.list-item[data-id="${serverId}"]`);
    if (item) {
      item.style.transition = 'opacity 0.25s, transform 0.25s';
      item.style.opacity    = '0';
      item.style.transform  = 'translateX(-20px)';
      await new Promise(r => setTimeout(r, 250));
    }
    try {
      await window.electronAPI.leaveServer(serverId);
      this.refreshServersList();
    } catch (e) {
      showNotification('Failed to leave server', 'error');
      this.refreshServersList();
    }
  }

  toggleSelectAllServers() {
    const boxes       = document.querySelectorAll('.server-checkbox');
    const btn         = document.getElementById('selectAllServersBtn');
    const isSelectAll = btn.textContent.trim() === 'Select All';
    boxes.forEach(cb => cb.checked = isSelectAll);
    btn.textContent = isSelectAll ? 'Deselect All' : 'Select All';
    this.updateSelectedServersCount();
  }

  updateSelectedServersCount() {
    const n         = document.querySelectorAll('.server-checkbox:checked').length;
    const leaveBtn  = document.getElementById('leaveSelectedServersBtn');
    const muteBtn   = document.getElementById('muteSelectedServersBtn');
    if (!leaveBtn) return;
    leaveBtn.disabled  = n === 0;
    muteBtn.disabled   = n === 0;
    leaveBtn.innerHTML = n > 0
      ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3H6a2 2 0 00-2 2v14c0 1.1.9 2 2 2h4M16 17l5-5-5-5M21 12H9"/></svg> Leave (${n})`
      : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3H6a2 2 0 00-2 2v14c0 1.1.9 2 2 2h4M16 17l5-5-5-5M21 12H9"/></svg> Leave Selected`;
    muteBtn.innerHTML = n > 0
      ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg> Mute (${n})`
      : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg> Mute Selected`;
  }

  copyToClipboard(id) {
    copyToClipboard(id);
  }

  async refreshServersList() {
    this.contentArea.innerHTML = `
      <h2>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
          <line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>
        </svg>
        Servers
      </h2>
      <div class="actions-bar">
        <button id="selectAllServersBtn" onclick="window.serverManager.toggleSelectAllServers()">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
          Select All
        </button>
        <button id="leaveSelectedServersBtn" onclick="window.serverManager.leaveSelectedServers()" disabled class="danger-btn">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10 3H6a2 2 0 00-2 2v14c0 1.1.9 2 2 2h4M16 17l5-5-5-5M21 12H9"/>
          </svg>
          Leave Selected
        </button>
        <button id="muteSelectedServersBtn" onclick="window.serverManager.muteSelectedServers()" disabled class="secondary-btn">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
          </svg>
          Mute Selected
        </button>
        <button id="readAllBtn" onclick="window.serverManager.readAll()" class="secondary-btn">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          Read All
        </button>
      </div>
      <div id="serversList"><div style="text-align:center;padding:40px;color:var(--text-3);font-size:.85rem;">Loading servers…</div></div>`;

    try {
      const servers = await getServersList();
      const list    = document.getElementById('serversList');
      if (!list) return;

      if (!servers.length) {
        list.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-3);font-size:.85rem;">No servers found</div>`;
        return;
      }

      list.innerHTML = servers.map((server, idx) => `
        <div class="list-item" data-id="${server.id}" style="animation-delay:${Math.min(idx * 0.03, 0.4)}s">
          <div class="list-item-left">
            <input type="checkbox" class="server-checkbox" onchange="window.serverManager.updateSelectedServersCount()">
            <img src="${server.icon || ''}" alt="${server.name}"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"
                 style="border-radius:12px;">
            <div class="user-avatar" style="display:none;border-radius:12px;font-size:.7rem;background:var(--accent);">
              ${(server.name || '?')[0].toUpperCase()}
            </div>
            <div class="user-info">
              <span class="display-name">${server.name}</span>
              <span class="username">ID: ${server.id}</span>
            </div>
          </div>
          <div class="button-group">
            <button onclick="window.serverManager.copyToClipboard('${server.id}')" class="secondary-btn">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              Copy ID
            </button>
            <button onclick="window.serverManager.muteServer('${server.id}')" class="secondary-btn">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
              </svg>
              Mute
            </button>
            <button onclick="window.serverManager.leaveServer('${server.id}')" class="danger-btn">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10 3H6a2 2 0 00-2 2v14c0 1.1.9 2 2 2h4M16 17l5-5-5-5M21 12H9"/>
              </svg>
              Leave
            </button>
          </div>
        </div>`).join('');
    } catch (error) {
      const list = document.getElementById('serversList');
      if (list) list.innerHTML = `<div style="text-align:center;padding:30px;color:var(--danger);font-size:.85rem;">${error.message}</div>`;
    }
  }
}
