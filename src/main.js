import { checkForUpdates } from './utils/updates.js';
import { loadSavedTokens, saveToken } from './utils/tokenManager.js';
import { DMManager }      from './components/DMManager.js';
import { ServerManager }  from './components/ServerManager.js';
import { FriendsManager } from './components/FriendsManager.js';
import { GroupManager }   from './components/GroupManager.js';
import { BlastManager }   from './components/BlastManager.js';
import { showInfoModal }  from './utils/ui.js';
import { copyToClipboard } from './utils/clipboard.js';
import { getFriendsList }  from './utils/discord.js';

window.dmManager      = new DMManager(document.getElementById('dms-page'));
window.serverManager  = new ServerManager(document.getElementById('servers-page'));
window.friendsManager = new FriendsManager(document.getElementById('friends-page'));
window.groupManager   = new GroupManager(document.getElementById('groups-page'));
window.dmBlast        = new BlastManager(document.getElementById('dmblast-page'),     'dm');
window.serverBlast    = new BlastManager(document.getElementById('serverblast-page'), 'server');

window.copyToClipboard = copyToClipboard;
window.getFriendsList  = getFriendsList;

const navItems     = document.querySelectorAll('.nav-item');
const pages        = document.querySelectorAll('.page-container');
const userProfile  = document.getElementById('userProfile');
const loginNavItem = document.getElementById('loginNavItem');

function showUserProfile(username) {
  document.getElementById('userInitial').textContent = username.charAt(0).toUpperCase();
  document.getElementById('userName').textContent    = username;
  userProfile.classList.add('visible');
}
function hideUserProfile() { userProfile.classList.remove('visible'); }

function toggleNavItems(show) {
  document.querySelectorAll('.nav-item:not(#loginNavItem)').forEach(item =>
    item.classList.toggle('hidden', !show));
  document.querySelectorAll('.nav-divider').forEach(d =>
    d.classList.toggle('hidden', !show));
  loginNavItem.classList.toggle('hidden', show);
}

let _activePage = null;

function switchPage(pageId) {
  if (_activePage === pageId) return;
  _activePage = pageId;

  pages.forEach(page => {
    if (page.classList.contains('active')) {
      page.style.opacity   = '0';
      page.style.transform = 'translateY(8px)';
      setTimeout(() => {
        page.classList.remove('active');
        page.style.opacity = page.style.transform = '';
      }, 160);
    }
  });

  navItems.forEach(item => item.classList.toggle('active', item.dataset.page === pageId));

  const target = document.getElementById(`${pageId}-page`);
  if (target) {
    target.style.opacity   = '0';
    target.style.transform = 'translateY(12px)';
    setTimeout(() => {
      target.classList.add('active');
      requestAnimationFrame(() => {
        target.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        target.style.opacity    = '1';
        target.style.transform  = 'translateY(0)';
        setTimeout(() => { target.style.transition = target.style.opacity = target.style.transform = ''; }, 230);
      });
    }, 160);
  }

  switch (pageId) {
    case 'friends':     window.friendsManager.refreshFriendsList(); break;
    case 'servers':     window.serverManager.refreshServersList();  break;
    case 'dms':         window.dmManager.refreshDMsList();          break;
    case 'groups':      window.groupManager.refreshGroupsList();    break;
    case 'dmblast':     window.dmBlast.init();                      break;
    case 'serverblast': window.serverBlast.init();                  break;
  }
}

toggleNavItems(false);
switchPage('login');

navItems.forEach(item => item.addEventListener('click', () => switchPage(item.dataset.page)));

document.addEventListener('DOMContentLoaded', async () => {
  try { await checkForUpdates(); await loadSavedTokens(); } catch (e) { console.error('Init error:', e); }
});

document.getElementById('minimizeBtn').addEventListener('click', () => window.electronAPI.minimize());
document.getElementById('maximizeBtn').addEventListener('click', () => window.electronAPI.maximize());
document.getElementById('closeBtn').addEventListener('click',    () => window.electronAPI.close());
document.getElementById('infoBtn').addEventListener('click',     showInfoModal);

document.getElementById('saveTokenBtn').addEventListener('click', () => saveToken(tokenInput.value, status));

document.getElementById('disconnectBtn').addEventListener('click', () => {
  hideUserProfile();
  toggleNavItems(false);
  _activePage = null;
  switchPage('login');
  tokenInput.value   = '';
  status.textContent = '';
  status.className   = '';
});

const connectBtn = document.getElementById('connectBtn');
const tokenInput = document.getElementById('tokenInput');
const status     = document.getElementById('status');

connectBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    status.textContent = 'Please enter a token';
    status.className   = 'error';
    tokenInput.focus();
    tokenInput.style.borderColor = 'var(--danger)';
    setTimeout(() => { tokenInput.style.borderColor = ''; }, 1500);
    return;
  }

  const btnText = connectBtn.querySelector('.btn-text');
  const loader  = connectBtn.querySelector('.loader');
  btnText.style.display = 'none';
  loader.style.display  = 'inline-block';
  connectBtn.disabled   = true;
  status.textContent    = '';
  status.className      = '';

  try {
    const result = await window.electronAPI.connectDiscord(token);
    if (result.success) {
      status.textContent = `Connected as ${result.username}`;
      status.className   = 'success';
      showUserProfile(result.username);
      toggleNavItems(true);
      _activePage = null;
      switchPage('friends');
    } else {
      status.textContent = result.error || 'Connection failed';
      status.className   = 'error';
    }
  } catch {
    status.textContent = 'Connection failed — check your token';
    status.className   = 'error';
  } finally {
    btnText.style.display = 'inline-block';
    loader.style.display  = 'none';
    connectBtn.disabled   = false;
  }
});

tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') connectBtn.click(); });
