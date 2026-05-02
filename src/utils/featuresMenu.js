// Top-right hamburger dropdown — animated panel with feature shortcuts + sound toggle.
import { icon } from './icons.js';
import { t } from './i18n.js';
import { sfx, isSoundOn, setSoundOn } from './sounds.js';

const ITEMS = [
  { id: 'sound',       i18n: 'fm.sound_fx',     ic: 'volume',     accent: '#e07c35', toggle: true },
  { id: 'clone',       i18n: 'cl.title',        ic: 'copy',       accent: '#5865f2' },
  { id: 'stats',       i18n: 'nav.stats',       ic: 'bar_chart',  accent: '#f59e0b' },
  { id: 'historylog',  i18n: 'fm.history_log',  ic: 'scroll',     accent: '#3a8fd1' },
  { id: 'tokenhealth', i18n: 'fm.token_health', ic: 'shield',     accent: '#27ae60' },
  { id: 'mentions',    i18n: 'fm.mentions',     ic: 'bell',       accent: '#e03535' },
  { id: 'pic',         i18n: 'fm.pic_capture',  ic: 'image',      accent: '#a855f7' },
  { id: 'antiprune',   i18n: 'fm.antiprune',    ic: 'shield',     accent: '#5865f2' },
  { id: 'search',      i18n: 'fm.search',       ic: 'search',     accent: '#06b6d4' },
  { id: 'massfriend',  i18n: 'fm.mass_friend',  ic: 'users',      accent: '#e07c35' },
  { id: 'voice',       i18n: 'fm.voice',        ic: 'mic',        accent: '#22c55e' },
];

export function mountFeaturesMenu(controlsEl) {
  if (!controlsEl) return;

  const btn = document.createElement('button');
  btn.id = 'featuresMenuBtn';
  btn.className = 'features-menu-btn hidden';
  btn.title = t('fm.menu_title');
  btn.innerHTML = `<span class="fm-burger"><span></span><span></span><span></span></span>`;
  controlsEl.insertBefore(btn, controlsEl.firstChild);

  const panel = document.createElement('div');
  panel.id = 'featuresMenuPanel';
  panel.className = 'features-menu-panel';
  document.body.appendChild(panel);

  function renderItems() {
    panel.innerHTML = `
      <div class="fm-panel-head">
        <span class="fm-panel-spark">${icon('rocket')}</span>
        <span>${t('fm.menu_title')}</span>
      </div>
      <div class="fm-panel-items">
        ${ITEMS.map((it, i) => {
          if (it.toggle) {
            const on = isSoundOn();
            return `
              <button class="fm-item" data-id="${it.id}" style="--fm-accent:${it.accent};animation-delay:${i * 35}ms">
                <span class="fm-ic">${icon(on ? 'volume' : 'volume_x')}</span>
                <span class="fm-label">${t(it.i18n)}</span>
                <span class="fm-toggle ${on ? 'on' : 'off'}"><span></span></span>
              </button>
            `;
          }
          return `
            <button class="fm-item" data-id="${it.id}" style="--fm-accent:${it.accent};animation-delay:${i * 35}ms">
              <span class="fm-ic">${icon(it.ic)}</span>
              <span class="fm-label">${t(it.i18n)}</span>
              <span class="fm-arrow">›</span>
            </button>
          `;
        }).join('')}
      </div>
      <div class="fm-panel-foot">${icon('crown')} <span>AHMED · @4_3a</span></div>
    `;
    panel.querySelectorAll('.fm-item').forEach(el => {
      el.addEventListener('click', () => {
        sfx.click();
        const id = el.dataset.id;
        if (id === 'sound') {
          const next = !isSoundOn();
          setSoundOn(next);
          if (next) sfx.ding();
          renderItems();
          return;
        }
        close();
        window.dispatchEvent(new CustomEvent('feature-nav', { detail: id }));
      });
    });
  }

  function position() {
    const r = btn.getBoundingClientRect();
    panel.style.top = (r.bottom + 6) + 'px';
    const isRTL = document.documentElement.dir === 'rtl';
    if (isRTL) {
      panel.style.left = Math.max(8, r.left) + 'px';
      panel.style.right = 'auto';
    } else {
      panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
      panel.style.left = 'auto';
    }
  }

  function open() {
    renderItems();
    position();
    requestAnimationFrame(() => panel.classList.add('open'));
    btn.classList.add('open');
    sfx.pop();
  }
  function close() {
    panel.classList.remove('open');
    btn.classList.remove('open');
  }
  function toggle() { panel.classList.contains('open') ? close() : open(); }

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && !btn.contains(e.target)) close();
  });
  window.addEventListener('resize', () => { if (panel.classList.contains('open')) position(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  return { open, close, toggle };
}
