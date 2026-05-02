// Replaces native <select> elements with a fully-themed, animated dropdown.
// Native selects use the OS popup which never matches our theme. This module
// renders a button + custom popover and forwards changes to the original
// <select> so all existing JS (including .value, change events, form code)
// keeps working.
//
// Skip a select by adding `data-raw` or the `raw` class.

const MOUNTED = new WeakSet();

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function rebuildOptions(host, sel) {
  const list = host.querySelector('.ts-list');
  list.innerHTML = '';
  Array.from(sel.options).forEach((opt, i) => {
    const li = document.createElement('div');
    li.className = 'ts-opt' + (opt.disabled ? ' is-disabled' : '') + (i === sel.selectedIndex ? ' is-selected' : '');
    li.dataset.value = opt.value;
    li.dataset.index = String(i);
    li.innerHTML = `
      <span class="ts-opt-label">${escapeHtml(opt.textContent || opt.label || opt.value)}</span>
      <span class="ts-opt-check">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
    `;
    list.appendChild(li);
  });
  refreshLabel(host, sel);
}

function refreshLabel(host, sel) {
  const label = host.querySelector('.ts-label');
  const opt = sel.options[sel.selectedIndex];
  label.textContent = opt ? (opt.textContent || opt.label || opt.value || '—') : '—';
  host.classList.toggle('is-disabled', sel.disabled);
}

function wrap(sel) {
  if (MOUNTED.has(sel)) return;
  if (sel.dataset.raw !== undefined || sel.classList.contains('raw')) return;
  if (sel.multiple || sel.size > 1) return;
  // Don't wrap selects that live inside hidden offscreen containers used as
  // option templates (their parent form needs to manipulate them directly).
  if (sel.closest('[data-no-themed-select]')) return;

  const host = document.createElement('div');
  host.className = 'ts-host';
  if (sel.classList.contains('acct-picker-select')) host.classList.add('ts-acct');
  host.innerHTML = `
    <button type="button" class="ts-btn" tabindex="0">
      <span class="ts-label">—</span>
      <span class="ts-caret" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </span>
    </button>
    <div class="ts-pop" role="listbox">
      <div class="ts-list"></div>
    </div>
  `;

  // Mirror class names so external CSS keeps targeting our select.
  // Insert host before the original select, then hide the select.
  sel.parentNode.insertBefore(host, sel);
  sel.classList.add('ts-orig');
  sel.style.position = 'absolute';
  sel.style.opacity = '0';
  sel.style.pointerEvents = 'none';
  sel.style.width = '1px';
  sel.style.height = '1px';
  // Move the original inside the host so it stays scoped.
  host.appendChild(sel);

  MOUNTED.add(sel);
  rebuildOptions(host, sel);

  const btn = host.querySelector('.ts-btn');
  const pop = host.querySelector('.ts-pop');
  const list = host.querySelector('.ts-list');

  // Move the popover under <body> so ancestors with overflow:auto can't clip it.
  // Restore it on close so MutationObserver and lifecycle stay sane.
  let popPortaled = false;
  let portalInTimer = null;   // pending "move pop back into host" timeout
  function portalOut() {
    // Cancel any pending portalIn — if the user reopens the menu while the
    // close transition is still running, we must NOT pull the popover back
    // into the host afterwards (that's what was making the menu "disappear"
    // on rapid clicks).
    if (portalInTimer) { clearTimeout(portalInTimer); portalInTimer = null; }
    if (popPortaled) return;
    document.body.appendChild(pop);
    pop.classList.add('ts-pop-portal');
    popPortaled = true;
  }
  function portalIn() {
    portalInTimer = null;
    if (!popPortaled) return;
    // Safety: if the host re-opened in the meantime, leave the portal alone.
    if (host.classList.contains('is-open')) return;
    host.appendChild(pop);
    pop.classList.remove('ts-pop-portal');
    pop.classList.remove('is-open');
    pop.style.left = pop.style.top = pop.style.minWidth = pop.style.maxWidth = '';
    popPortaled = false;
  }
  function showPortal()  { pop.classList.add('is-open'); }
  function hidePortal()  { pop.classList.remove('is-open'); }
  function position() {
    const r = btn.getBoundingClientRect();
    // Make pop briefly visible-but-hidden to measure
    pop.style.visibility = 'hidden';
    pop.style.display = 'block';
    const popH = pop.scrollHeight || 240;
    pop.style.visibility = '';
    pop.style.display = '';
    const room = window.innerHeight - r.bottom;
    const dropUp = room < popH + 16 && r.top > popH + 16;
    host.classList.toggle('drop-up', dropUp);
    pop.style.minWidth = `${r.width}px`;
    pop.style.maxWidth = `min(380px, 92vw)`;
    pop.style.left = `${r.left}px`;
    if (dropUp) {
      const top = Math.max(8, r.top - popH - 6);
      pop.style.top = `${top}px`;
    } else {
      pop.style.top = `${r.bottom + 6}px`;
    }
  }
  function open() {
    if (host.classList.contains('is-open') || sel.disabled) return;
    document.querySelectorAll('.ts-host.is-open').forEach(h => { if (h !== host) closeOther(h); });
    portalOut();
    host.classList.add('is-open');
    // The CSS show-rule is `.ts-host.is-open .ts-pop` — but once we portal
    // pop to <body> it's no longer a descendant of host, so that rule never
    // matches. Mirror the open state directly on the popover so the portaled
    // version still becomes visible (without this, menus appeared dead until
    // you clicked them several times).
    showPortal();
    requestAnimationFrame(() => {
      position();
      const cur = list.querySelector('.ts-opt.is-selected');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    });
  }
  function close() {
    if (!host.classList.contains('is-open')) return;
    host.classList.remove('is-open');
    hidePortal();
    // Wait for transition before pulling back. Track the timer so portalOut()
    // can cancel it if the menu is reopened mid-close (rapid clicks).
    if (portalInTimer) clearTimeout(portalInTimer);
    portalInTimer = setTimeout(portalIn, 220);
  }
  function closeOther(otherHost) {
    otherHost.classList.remove('is-open');
    // Strip is-open from the portaled pop too — without this the previously-
    // opened menu's popover stays visible AND clickable in <body>, blocking
    // clicks to anything underneath until you click somewhere "neutral".
    const portaled = document.querySelectorAll('body > .ts-pop-portal.is-open');
    portaled.forEach(p => p.classList.remove('is-open'));
  }
  function toggle() { host.classList.contains('is-open') ? close() : open(); }

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  list.addEventListener('click', (e) => {
    const opt = e.target.closest('.ts-opt');
    if (!opt || opt.classList.contains('is-disabled')) return;
    sel.selectedIndex = Number(opt.dataset.index);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    list.querySelectorAll('.ts-opt.is-selected').forEach(o => o.classList.remove('is-selected'));
    opt.classList.add('is-selected');
    refreshLabel(host, sel);
    close();
  });
  document.addEventListener('click', (e) => {
    if (host.contains(e.target)) return;
    if (pop.contains(e.target)) return; // portal click is fine
    close();
  });
  // Reposition on scroll/resize while open; only close on resize
  window.addEventListener('scroll', () => { if (host.classList.contains('is-open')) position(); }, true);
  window.addEventListener('resize', () => { if (host.classList.contains('is-open')) position(); });

  // Watch for option changes / value updates from external code.
  const mo = new MutationObserver(() => rebuildOptions(host, sel));
  mo.observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'value'] });
  // Also catch programmatic .value = ... assignments
  const origDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (origDescriptor && !sel._tsValuePatched) {
    Object.defineProperty(sel, 'value', {
      get() { return origDescriptor.get.call(this); },
      set(v) {
        origDescriptor.set.call(this, v);
        refreshLabel(host, sel);
        list.querySelectorAll('.ts-opt.is-selected').forEach(o => o.classList.remove('is-selected'));
        const i = sel.selectedIndex;
        const li = list.querySelector(`.ts-opt[data-index="${i}"]`);
        if (li) li.classList.add('is-selected');
      },
      configurable: true
    });
    sel._tsValuePatched = true;
  }
}

function scan(root = document) {
  root.querySelectorAll('select').forEach(wrap);
}

export function mountThemedSelect() {
  scan();
  // Watch the whole document for newly inserted <select> elements.
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach(n => {
        if (!(n instanceof Element)) return;
        if (n.tagName === 'SELECT') wrap(n);
        else n.querySelectorAll && n.querySelectorAll('select').forEach(wrap);
      });
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
}
