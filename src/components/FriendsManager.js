import { showProgressModal, showNotification } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';

export class FriendsManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
  }

  async refreshFriendsList() {
    this.contentArea.innerHTML = `
      <h2>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        Friends
      </h2>
      <div class="actions-bar">
        <button id="selectAllFriendsBtn" onclick="window.friendsManager.toggleSelectAll()">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>
          </svg>
          Select All
        </button>
        <button id="removeSelectedFriendsBtn" onclick="window.friendsManager.removeSelected()" disabled class="danger-btn">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
          </svg>
          Remove Selected
        </button>
      </div>
      <div id="friendsList"><div style="text-align:center;padding:40px;color:var(--text-3);font-size:.85rem;">Loading friends…</div></div>`;

    try {
      const result = await window.electronAPI.getFriends();
      const list   = document.getElementById('friendsList');
      if (!list) return;

      if (!result.success) {
        list.innerHTML = `<div style="text-align:center;padding:30px;color:var(--danger);font-size:.85rem;">${result.error}</div>`;
        return;
      }

      if (!result.friends.length) {
        list.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-3);font-size:.85rem;">No friends found</div>`;
        return;
      }

      list.innerHTML = result.friends.map((friend, idx) => `
        <div class="list-item" data-id="${friend.id}" style="animation-delay:${Math.min(idx * 0.03, 0.4)}s">
          <div class="list-item-left">
            <input type="checkbox" class="friend-checkbox" onchange="window.friendsManager.updateSelectedCount()">
            <img src="${friend.avatar || ''}" alt="${friend.username}"
                 onerror="this.src='';this.style.background='var(--accent)';this.style.display='flex'">
            <div class="user-info">
              <span class="display-name">${friend.displayName || friend.username}</span>
              <span class="username">@${friend.username}</span>
            </div>
          </div>
          <div class="button-group">
            <button onclick="window.friendsManager.copyId('${friend.id}')" class="secondary-btn">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
              </svg>
              Copy ID
            </button>
            <button onclick="window.friendsManager.removeFriend('${friend.id}')" class="danger-btn">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              Remove
            </button>
          </div>
        </div>`).join('');
    } catch (error) {
      const list = document.getElementById('friendsList');
      if (list) list.innerHTML = `<div style="text-align:center;padding:30px;color:var(--danger);font-size:.85rem;">${error.message}</div>`;
    }
  }

  toggleSelectAll() {
    const boxes       = document.querySelectorAll('.friend-checkbox');
    const btn         = document.getElementById('selectAllFriendsBtn');
    const isSelectAll = btn.textContent.trim().startsWith('Select');
    boxes.forEach(cb => cb.checked = isSelectAll);
    btn.textContent = isSelectAll ? 'Deselect All' : 'Select All';
    this.updateSelectedCount();
  }

  updateSelectedCount() {
    const n         = document.querySelectorAll('.friend-checkbox:checked').length;
    const removeBtn = document.getElementById('removeSelectedFriendsBtn');
    if (!removeBtn) return;
    removeBtn.disabled = n === 0;
    removeBtn.innerHTML = n > 0
      ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Remove (${n})`
      : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Remove Selected`;
  }

  async copyId(id) {
    await copyToClipboard(id);
  }

  async removeFriend(friendId) {
    const item = document.querySelector(`.list-item[data-id="${friendId}"]`);
    if (item) {
      item.style.transition = 'opacity 0.22s, transform 0.22s';
      item.style.opacity    = '0';
      item.style.transform  = 'translateX(-16px)';
      await new Promise(r => setTimeout(r, 220));
    }
    try {
      await window.electronAPI.deleteFriend(friendId);
      this.refreshFriendsList();
    } catch (e) {
      showNotification('Failed to remove friend', 'error');
      this.refreshFriendsList();
    }
  }

  async removeSelected() {
    const selected = document.querySelectorAll('.friend-checkbox:checked');
    const total    = selected.length;
    const { updateProgress, closeModal } = showProgressModal('Removing Friends', total);
    let completed = 0;

    for (const cb of selected) {
      const friendId = cb.closest('.list-item').dataset.id;
      try {
        await window.electronAPI.deleteFriend(friendId);
        completed++;
        updateProgress(completed);
      } catch (e) { console.error(e); }
    }
    setTimeout(() => { closeModal(); this.refreshFriendsList(); }, 700);
  }
}
