import { showProgressModal, showNotification } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { deleteDMMessages } from '../utils/messageDeleter.js';

export class GroupManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.isDeleting  = false;
    this.defaultGroupIcon = `data:image/svg+xml,${encodeURIComponent(`
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="36" height="36" rx="18" fill="#5865F2"/>
        <path d="M26 14c0 2.76-2.24 5-5 5s-5-2.24-5-5 2.24-5 5-5 5 2.24 5 5z" fill="white"/>
        <path d="M11 22c0-2.76 2.24-5 5-5h8c2.76 0 5 2.24 5 5v2c0 1.1-.9 2-2 2H13c-1.1 0-2-.9-2-2v-2z" fill="white"/>
        <circle cx="9" cy="16" r="3" fill="white" opacity=".75"/>
        <path d="M5 23c0-1.66 1.34-3 3-3h3c.55 0 1 .45 1 1v1c0 1.1-.9 2-2 2H6c-.55 0-1-.45-1-1v-1z" fill="white" opacity=".75"/>
      </svg>`)}`;
  }

  toggleSelectAll() {
    const boxes       = document.querySelectorAll('.group-checkbox');
    const btn         = document.getElementById('selectAllGroupsBtn');
    const isSelectAll = btn.textContent.trim().startsWith('Select');
    boxes.forEach(cb => cb.checked = isSelectAll);
    btn.textContent = isSelectAll ? 'Deselect All' : 'Select All';
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n         = document.querySelectorAll('.group-checkbox:checked').length;
    const leaveBtn  = document.getElementById('leaveSelectedGroupsBtn');
    const deleteBtn = document.getElementById('deleteSelectedMessagesBtn');
    if (!leaveBtn) return;
    leaveBtn.disabled  = n === 0;
    deleteBtn.disabled = n === 0;
    leaveBtn.textContent  = n > 0 ? `Leave (${n})` : 'Leave Selected';
    deleteBtn.textContent = n > 0 ? `Delete Messages (${n})` : 'Delete Selected Messages';
  }

  async copyId(id) {
    await copyToClipboard(id);
  }

  async leaveGroup(groupId) {
    const item = document.querySelector(`.list-item[data-id="${groupId}"]`);
    if (item) {
      item.style.transition = 'opacity 0.22s, transform 0.22s';
      item.style.opacity    = '0';
      item.style.transform  = 'translateX(-16px)';
      await new Promise(r => setTimeout(r, 220));
    }
    try {
      const result = await window.electronAPI.leaveGroup(groupId);
      if (result.success) this.refreshGroupsList();
    } catch (e) {
      showNotification('Failed to leave group', 'error');
      this.refreshGroupsList();
    }
  }

  async leaveSelectedGroups() {
    const selected = document.querySelectorAll('.group-checkbox:checked');
    const total    = selected.length;
    let completed  = 0;
    const { updateProgress, closeModal } = showProgressModal('Leaving Groups', total);

    for (const cb of selected) {
      const groupItem = cb.closest('.list-item');
      const groupId   = groupItem.dataset.id;
      try {
        await window.electronAPI.leaveGroup(groupId);
        completed++;
        updateProgress(completed);
      } catch (e) { console.error(e); }
    }
    setTimeout(() => { closeModal(); this.refreshGroupsList(); }, 700);
  }

  async deleteMessages(groupId, groupName, oldestFirst = false, skipRefresh = false, bypassLock = false) {
    if (this.isDeleting && !bypassLock) return;
    if (!bypassLock) this.isDeleting = true;
    try {
      await deleteDMMessages({
        channelId: groupId,
        username: groupName,
        electronAPI: window.electronAPI,
        onComplete: () => {
          if (!bypassLock) this.isDeleting = false;
          if (!skipRefresh) this.refreshGroupsList();
        },
        skipRefresh,
        isGroup: true,
        oldestFirst
      });
    } catch (e) {
      console.error(e);
      if (!bypassLock) this.isDeleting = false;
    }
  }

  async deleteSelectedMessages() {
    if (this.isDeleting) return;
    this.isDeleting = true;
    const selected  = document.querySelectorAll('.group-checkbox:checked');
    const total     = selected.length;
    let completed   = 0;
    const { updateProgress, closeModal } = showProgressModal('Deleting Messages', total);

    for (const cb of selected) {
      const item      = cb.closest('.list-item');
      const groupId   = item.dataset.id;
      const groupName = item.dataset.name;
      try {
        await this.deleteMessages(groupId, groupName, false, true, true);
        completed++;
        updateProgress(completed);
      } catch (e) { console.error(e); }
    }
    setTimeout(() => { closeModal(); this.isDeleting = false; this.refreshGroupsList(); }, 700);
  }

  async refreshGroupsList() {
    this.contentArea.innerHTML = `
      <h2>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Groups
      </h2>
      <div class="actions-bar">
        <button id="selectAllGroupsBtn" onclick="window.groupManager.toggleSelectAll()">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
          Select All
        </button>
        <button id="leaveSelectedGroupsBtn" onclick="window.groupManager.leaveSelectedGroups()" disabled class="danger-btn">Leave Selected</button>
        <button id="deleteSelectedMessagesBtn" onclick="window.groupManager.deleteSelectedMessages()" disabled class="secondary-btn">Delete Selected Messages</button>
      </div>
      <div id="groupsList"><div style="text-align:center;padding:40px;color:var(--text-3);font-size:.85rem;">Loading groups…</div></div>`;

    try {
      const result = await window.electronAPI.getGroups();
      const list   = document.getElementById('groupsList');
      if (!list) return;

      if (!result.success) {
        list.innerHTML = `<div style="text-align:center;padding:30px;color:var(--danger);font-size:.85rem;">Failed to load groups</div>`;
        return;
      }
      if (!result.groups.length) {
        list.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-3);font-size:.85rem;">No groups found</div>`;
        return;
      }

      list.innerHTML = result.groups.map((group, idx) => {
        const icon = (!group.icon || group.icon === '/discord.png')
          ? this.defaultGroupIcon : group.icon;
        return `
          <div class="list-item" data-id="${group.id}" data-name="${group.name}" style="animation-delay:${Math.min(idx * 0.03, 0.4)}s">
            <div class="list-item-left">
              <input type="checkbox" class="group-checkbox" onchange="window.groupManager.updateSelectedCount()">
              <img src="${icon}" alt="${group.name}" style="border-radius:12px;"
                   onerror="this.src='${this.defaultGroupIcon}'">
              <div class="group-info">
                <span class="group-name">${group.name}</span>
                <span class="group-members">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:3px">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                  </svg>
                  ${group.recipients} members
                </span>
              </div>
            </div>
            <div class="button-group">
              <button onclick="window.groupManager.copyId('${group.id}')" class="secondary-btn">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
                Copy ID
              </button>
              <button onclick="window.groupManager.deleteMessages('${group.id}','${group.name}',false)" class="secondary-btn">Del Msgs</button>
              <button onclick="window.groupManager.deleteMessages('${group.id}','${group.name}',true)" class="secondary-btn">Del Oldest</button>
              <button onclick="window.groupManager.leaveGroup('${group.id}')" class="danger-btn">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10 3H6a2 2 0 00-2 2v14c0 1.1.9 2 2 2h4M16 17l5-5-5-5M21 12H9"/>
                </svg>
                Leave
              </button>
            </div>
          </div>`;
      }).join('');
    } catch (error) {
      const list = document.getElementById('groupsList');
      if (list) list.innerHTML = `<div style="text-align:center;padding:30px;color:var(--danger);font-size:.85rem;">${error.message}</div>`;
    }
  }
}
