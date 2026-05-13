/* ══════════════════════════════════════════════════════════
   UI Utilities — Notifications, Modals, Confirms, Progress
   ══════════════════════════════════════════════════════════ */

// ── Toast Notification ────────────────────────────────────
export const showNotification = (message, type = 'default') => {
  document.querySelectorAll('.copy-notification').forEach(n => n.remove());

  const icons = {
    success: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    warn:    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    default: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  const colors = { success: 'var(--success)', error: 'var(--danger)', warn: 'var(--warn)', default: 'var(--accent)' };
  const color  = colors[type] || colors.default;

  const n = document.createElement('div');
  n.className = 'copy-notification';
  n.style.cssText = `border-left: 3px solid ${color};`;
  n.innerHTML = `<span style="color:${color};flex-shrink:0;display:flex;">${icons[type] || icons.default}</span><span>${message}</span>`;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 2400);
};

// ── Copy to Clipboard ─────────────────────────────────────
export const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    showNotification('Copied to clipboard!', 'success');
  } catch {
    showNotification('Copy failed', 'error');
  }
};

// ── Confirm Modal ─────────────────────────────────────────
export const showConfirm = (message, opts = {}) => {
  return new Promise(resolve => {
    const { title = 'Confirm', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = opts;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="width:min(90%,380px);text-align:center;">
        <div style="width:44px;height:44px;border-radius:50%;background:${danger ? 'var(--danger-dim)' : 'var(--accent-dim)'};
             display:flex;align-items:center;justify-content:center;margin:0 auto 14px;
             border:1px solid ${danger ? 'rgba(224,55,55,0.25)' : 'rgba(88,101,242,0.25)'};">
          ${danger
            ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--danger)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
            : `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--accent)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`}
        </div>
        <h2 style="font-size:.95rem;margin-bottom:8px;">${title}</h2>
        <p style="color:var(--text-2);font-size:.85rem;line-height:1.55;margin-bottom:18px;">${message}</p>
        <div style="display:flex;gap:8px;">
          <button id="_confirmNo"  class="secondary-btn" style="flex:1;">${cancelText}</button>
          <button id="_confirmYes" class="${danger ? 'danger-btn' : ''}" style="flex:1;${!danger ? 'background:var(--accent);color:white;' : ''}">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const yes = modal.querySelector('#_confirmYes');
    const no  = modal.querySelector('#_confirmNo');
    const done = (v) => { resolve(v); modal.remove(); };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click',  () => done(false));
    modal.addEventListener('click', e => { if (e.target === modal) done(false); });
    yes.focus();
  });
};

// ── Progress Modal ────────────────────────────────────────
export const showProgressModal = (title, total) => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="width:min(90%,420px);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">
        <div class="mdm-pulse-dot active"></div>
        <h2 style="font-size:.95rem;margin:0;">${title}</h2>
      </div>
      <div class="mdm-progress-wrap">
        <div class="mdm-progress-track">
          <div class="mdm-progress-fill" id="_pgFill" style="width:0%"></div>
        </div>
        <div class="mdm-progress-labels">
          <span id="_pgText">0 / ${total}</span>
          <span id="_pgPct">0%</span>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  return {
    updateProgress(done) {
      const pct = Math.round((done / total) * 100);
      const fill = modal.querySelector('#_pgFill');
      const txt  = modal.querySelector('#_pgText');
      const pctEl = modal.querySelector('#_pgPct');
      if (fill)  fill.style.width  = `${pct}%`;
      if (txt)   txt.textContent   = `${done} / ${total}`;
      if (pctEl) pctEl.textContent = `${pct}%`;
    },
    closeModal() {
      modal.querySelector('.mdm-pulse-dot')?.classList.replace('active', 'stopped');
      setTimeout(() => modal.remove(), 350);
    }
  };
};

// ── Info Modal ────────────────────────────────────────────
export const showInfoModal = () => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content info-modal">
      <img src="src/icons/app-icon.png" alt="App" onerror="this.style.display='none'">
      <h2>Discord Account Manager</h2>
      <p>Version 1.5.6</p>
      <p style="color:var(--text-3);font-size:.8rem;">By Ahmed</p>
      <div class="info-social-links">
        <a href="#" id="_infoDiscord" class="info-social-btn info-discord-btn">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
          </svg>
          discord.gg/ens
        </a>
        <a href="#" id="_infoInsta" class="info-social-btn info-insta-btn">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
            <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
            <line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>
          </svg>
          a_13qn
        </a>
      </div>
      <button id="_infoClose" class="secondary-btn" style="width:100%;margin-top:4px;">Close</button>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#_infoDiscord').addEventListener('click', e => { e.preventDefault(); window.electronAPI.openExternal('https://discord.gg/ens'); });
  modal.querySelector('#_infoInsta').addEventListener('click', e => { e.preventDefault(); window.electronAPI.openExternal('https://instagram.com/a_13qn'); });
  modal.querySelector('#_infoClose').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

// ── Input Modal ───────────────────────────────────────────
export const showInputModal = (title, placeholder = '', opts = {}) => {
  return new Promise(resolve => {
    const { message = '' } = opts;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="width:min(90%,380px);">
        <h2 style="font-size:.95rem;margin-bottom:${message ? '8px' : '14px'};">${title}</h2>
        ${message ? `<p style="color:var(--text-2);font-size:.84rem;margin-bottom:14px;">${message}</p>` : ''}
        <input type="text" id="_inputVal" placeholder="${placeholder}"
               style="width:100%;padding:10px 12px;background:var(--bg-1);border:1px solid var(--border-2);
                      border-radius:var(--radius-md);color:var(--text);font-family:inherit;font-size:.87rem;
                      outline:none;box-sizing:border-box;margin-bottom:14px;transition:border-color .15s,box-shadow .15s;">
        <div style="display:flex;gap:8px;">
          <button id="_inputSave" style="flex:1;">Save</button>
          <button id="_inputCancel" class="secondary-btn" style="flex:1;">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const inp = modal.querySelector('#_inputVal');
    inp.addEventListener('focus', () => { inp.style.borderColor = 'var(--accent)'; inp.style.boxShadow = '0 0 0 3px var(--accent-glow)'; });
    inp.addEventListener('blur',  () => { inp.style.borderColor = ''; inp.style.boxShadow = ''; });
    inp.focus();
    const done = (v) => { resolve(v); modal.remove(); };
    modal.querySelector('#_inputSave').addEventListener('click', () => {
      const v = inp.value.trim();
      if (v) done(v); else { inp.style.borderColor = 'var(--danger)'; inp.focus(); }
    });
    modal.querySelector('#_inputCancel').addEventListener('click', () => done(null));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') modal.querySelector('#_inputSave').click(); });
    modal.addEventListener('click', e => { if (e.target === modal) done(null); });
  });
};
