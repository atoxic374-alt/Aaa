export const showNotification = (message, type = 'default') => {
  // Remove any existing toasts
  document.querySelectorAll('.copy-notification').forEach(n => n.remove());

  const n = document.createElement('div');
  n.className = 'copy-notification';

  const icons = {
    success: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    default: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="8 5 2 12 8 19"/><polyline points="16 5 22 12 16 19"/></svg>`,
  };

  const colors = {
    success: 'var(--success)',
    error:   'var(--danger)',
    default: 'var(--accent)',
  };

  n.style.cssText = `
    display:flex;align-items:center;gap:8px;
    border-left:3px solid ${colors[type] || colors.default};
  `;
  n.innerHTML = `
    <span style="color:${colors[type] || colors.default};flex-shrink:0;">${icons[type] || icons.default}</span>
    <span>${message}</span>
  `;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 2200);
};

export const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    showNotification('Copied to clipboard!', 'success');
  } catch {
    showNotification('Copy failed', 'error');
  }
};

export const showProgressModal = (title, total) => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content';
  content.style.cssText = 'width:min(90%,400px);';

  content.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">
      <div class="mdm-pulse-dot active"></div>
      <h2 style="font-size:0.95rem;margin:0;">${title}</h2>
    </div>
    <div class="mdm-progress-wrap">
      <div class="mdm-progress-track">
        <div class="mdm-progress-fill" id="_pgFill" style="width:0%"></div>
      </div>
      <div class="mdm-progress-labels">
        <span id="_pgText">0 / ${total}</span>
        <span id="_pgPct">0%</span>
      </div>
    </div>`;

  modal.appendChild(content);
  document.body.appendChild(modal);

  return {
    updateProgress(done) {
      const pct = Math.round((done / total) * 100);
      const fill = content.querySelector('#_pgFill');
      const txt  = content.querySelector('#_pgText');
      const pctEl = content.querySelector('#_pgPct');
      if (fill)  fill.style.width  = `${pct}%`;
      if (txt)   txt.textContent   = `${done} / ${total}`;
      if (pctEl) pctEl.textContent = `${pct}%`;
    },
    closeModal() {
      content.querySelector('.mdm-pulse-dot')?.classList.replace('active', 'stopped');
      setTimeout(() => modal.remove(), 350);
    }
  };
};

export const showInfoModal = () => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const content = document.createElement('div');
  content.className = 'modal-content info-modal';
  content.innerHTML = `
    <img src="src/icons/app-icon.png" alt="App Icon" onerror="this.style.display='none'">
    <h2>Discord Account Manager</h2>
    <p style="font-size:.82rem;color:var(--text-2);margin:6px 0 2px;">Version 1.5.6</p>
    <p style="font-size:.8rem;color:var(--text-3);">By Ahmed</p>
    <div class="links" style="margin:16px 0 12px;">
      <a href="https://discord.gg/ens" id="_infoLink">Discord Community</a>
    </div>
    <button id="_infoClose" class="secondary-btn" style="width:100%;">Close</button>`;

  modal.appendChild(content);
  document.body.appendChild(modal);

  content.querySelector('#_infoLink').addEventListener('click', e => {
    e.preventDefault();
    window.electronAPI.openExternal('https://discord.gg/ens');
  });
  content.querySelector('#_infoClose').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

export const showInputModal = (title, placeholder = '') => {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.cssText = 'width:min(90%,380px);';
    content.innerHTML = `
      <h2 style="font-size:.95rem;margin-bottom:14px;">${title}</h2>
      <input type="text" id="_inputVal" placeholder="${placeholder}" 
             style="width:100%;padding:10px 12px;background:var(--bg-1);border:1px solid var(--border-2);border-radius:var(--radius-md);color:var(--text);font-family:inherit;font-size:.87rem;outline:none;box-sizing:border-box;margin-bottom:14px;">
      <div style="display:flex;gap:8px;">
        <button id="_inputSave" style="flex:1;">Save</button>
        <button id="_inputCancel" class="secondary-btn" style="flex:1;">Cancel</button>
      </div>`;

    modal.appendChild(content);
    document.body.appendChild(modal);

    const inp = content.querySelector('#_inputVal');
    inp.focus();

    const done = (val) => { resolve(val); modal.remove(); };

    content.querySelector('#_inputSave').addEventListener('click', () => {
      const v = inp.value.trim();
      if (v) done(v);
      else { inp.style.borderColor = 'var(--danger)'; inp.focus(); }
    });
    content.querySelector('#_inputCancel').addEventListener('click', () => done(null));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') content.querySelector('#_inputSave').click(); });
    modal.addEventListener('click', e => { if (e.target === modal) done(null); });
  });
};
