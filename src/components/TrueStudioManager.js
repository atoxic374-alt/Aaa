// TrueStudioManager — TOTP-based Discord automation (accounts + teams + bots).
// Replaces the old captcha-based BotsManager with a more reliable, batched
// orchestrator. Stores email/password/2FA secret per account (encrypted on
// the server) and runs a configurable pipeline: create team → create bots →
// link bots into the team. Live progress + countdown + log are streamed via SSE.
import { showNotification, showConfirm } from '../utils/ui.js';
import { copyToClipboard } from '../utils/clipboard.js';
import { t } from '../utils/i18n.js';
import { sfx } from '../utils/sounds.js';

const VERSION = '6.0';

export class TrueStudioManager {
  constructor(contentArea) {
    this.contentArea = contentArea;
    this.accounts = [];               // [{email, hasPassword, hasTotp, addedAt}]
    this.snapshot = null;
    this.selectedEmail = null;
    this.form = {
      email: '',
      password: '',
      totpSecret: '',
      rules: { createTeams: false, createBots: true, linkBots: false },
      count: 10,
      prefix: 'True-Studio',
      waitMinutes: 15,
    };
    this.sse = null;
    this._countdownTimer = null;
    this._inited = false;
    this.library = null;          // { teams: [...], personal: [...], totals: {} }
    this.libraryEmail = null;     // which account is currently loaded
    this.libraryLoading = false;
    this.libraryError = '';
    // Captcha solver settings + the currently-open manual challenge modal.
    this.captchaSettings = { provider: '2captcha', hasApiKey: false, manualFallback: true };
    this._captchaModal = null;     // DOM root of the open modal (or null)
    this._captchaCurrentId = null; // id of the challenge the modal is solving
    this._hcaptchaLoaded = false;  // lazy-loaded the hCaptcha script yet?
  }

  async init() {
    if (!this._inited) {
      await this.refresh();
      await this._loadCaptchaSettings();
      this.openSSE();
      this._startCountdownTicker();
      this._inited = true;
    } else {
      await this.refresh();
    }
    this.render();
    // If a captcha is already pending when this view opens, surface the modal.
    this._maybeOpenCaptchaModal();
  }

  async _loadCaptchaSettings() {
    try {
      const r = await window.electronAPI.tsCaptchaSettings();
      if (r && r.settings) this.captchaSettings = r.settings;
    } catch (e) { /* non-fatal */ }
  }

  async refresh() {
    try {
      const r = await window.electronAPI.tsState();
      this.snapshot = r?.snapshot || null;
      this.accounts = r?.accounts || [];
      // Auto-select the most recently added account if nothing is selected
      if (!this.selectedEmail && this.accounts.length) {
        this.selectedEmail = this.accounts[0].email;
      } else if (this.selectedEmail && !this.accounts.find(a => a.email === this.selectedEmail)) {
        this.selectedEmail = this.accounts[0]?.email || null;
      }
      // Mirror selected email into the editor inputs (so password/2FA placeholders update)
      if (this.selectedEmail) this.form.email = this.selectedEmail;
    } catch (e) {
      showNotification('Failed to load True-Studio state: ' + e.message, 'error');
    }
  }

  openSSE() {
    try {
      const types = [
        'ts_progress', 'ts_log', 'ts_bot_created', 'ts_done',
        'ts_captcha', 'ts_captcha_resolved', 'ts_captcha_cancelled', 'ts_captcha_timeout',
      ].join(',');
      this.sse = new EventSource(`/api/features/stream?types=${types}`);
      this.sse.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.snapshot) this.snapshot = data.snapshot;
          if (data.type === 'ts_done') sfx.ding?.();
          if (data.type === 'ts_bot_created') sfx.click?.();
          if (data.type === 'ts_captcha') {
            sfx.ding?.();
            this._openCaptchaModal(data.challenge || data.snapshot?.pendingCaptcha);
          }
          if (data.type === 'ts_captcha_resolved' || data.type === 'ts_captcha_cancelled' || data.type === 'ts_captcha_timeout') {
            this._closeCaptchaModal();
          }
          this._renderLive();
        } catch (e) {}
      };
      this.sse.onerror = () => {};
    } catch (e) {}
  }

  // ── Manual captcha modal ────────────────────────────────────
  _maybeOpenCaptchaModal() {
    const pc = this.snapshot?.pendingCaptcha;
    if (pc && pc.id && (!this._captchaModal || this._captchaCurrentId !== pc.id)) {
      this._openCaptchaModal(pc);
    }
  }

  _ensureHcaptchaScript() {
    return new Promise((resolve) => {
      if (window.hcaptcha) { this._hcaptchaLoaded = true; return resolve(true); }
      // Use the explicit-render API so we control when widgets mount.
      const sc = document.createElement('script');
      sc.src = 'https://js.hcaptcha.com/1/api.js?render=explicit&recaptchacompat=off';
      sc.async = true; sc.defer = true;
      sc.onload = () => { this._hcaptchaLoaded = true; resolve(true); };
      sc.onerror = () => resolve(false);
      document.head.appendChild(sc);
    });
  }

  async _openCaptchaModal(challenge) {
    if (!challenge || !challenge.id) return;
    // If we already have a modal open for the same challenge, leave it alone.
    if (this._captchaModal && this._captchaCurrentId === challenge.id) return;
    this._closeCaptchaModal();

    this._captchaCurrentId = challenge.id;
    const ctx = challenge.context || 'discord';
    const sitekey = challenge.sitekey || '';
    // rqdata binds the produced hCaptcha token to Discord's specific request.
    // Without it, even a perfectly-solved captcha returns
    // {captcha_key:["invalid-response"]} from Discord's API.
    const rqdata = challenge.rqdata || null;

    const overlay = document.createElement('div');
    overlay.className = 'ts-captcha-overlay';
    overlay.innerHTML = `
      <div class="ts-captcha-modal">
        <div class="ts-captcha-head">
          <div class="ts-captcha-title">${escapeHtml(t('ts.captcha_modal_title') || 'Solve captcha challenge')}</div>
          <button class="ts-captcha-close" type="button" aria-label="close">×</button>
        </div>
        <div class="ts-captcha-body">
          <div class="ts-captcha-context">${escapeHtml(t('ts.captcha_context_label') || 'Context')}: <b>${escapeHtml(ctx)}</b></div>
          <div class="ts-captcha-hint">${escapeHtml(t('ts.captcha_hint') || 'Discord requested verification. Click the checkbox below to continue. The session is paused until you solve it (5 min timeout).')}</div>
          <div id="ts-hcaptcha-mount" class="ts-captcha-widget"></div>
          <div class="ts-captcha-loading">${escapeHtml(t('ts.captcha_loading') || 'Loading hCaptcha…')}</div>
          <div class="ts-captcha-fallback">
            ${escapeHtml(t('ts.captcha_fallback_hint') || 'Widget not loading?')}
            <a href="https://newassets.hcaptcha.com/captcha/v1/demo?sitekey=${encodeURIComponent(sitekey)}" target="_blank" rel="noopener">${escapeHtml(t('ts.captcha_open_external') || 'Open in new tab')}</a>
            <textarea id="ts-captcha-token" class="ts-input" rows="3" placeholder="${escapeHtml(t('ts.captcha_paste_token') || 'Paste captcha token here…')}"></textarea>
            <button class="ts-btn mint" id="ts-captcha-submit">${escapeHtml(t('ts.captcha_submit') || 'Submit token')}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._captchaModal = overlay;

    overlay.querySelector('.ts-captcha-close')?.addEventListener('click', () => this._cancelCaptcha());
    overlay.querySelector('#ts-captcha-submit')?.addEventListener('click', () => {
      const ta = overlay.querySelector('#ts-captcha-token');
      const tok = (ta?.value || '').trim();
      if (tok) this._submitCaptchaToken(tok);
      else showNotification(t('ts.captcha_paste_token') || 'Paste a token first', 'error');
    });

    // Try to render the widget. If hCaptcha can't load (network/CSP), the
    // fallback textarea + external link is always available.
    const ok = await this._ensureHcaptchaScript();
    if (ok && window.hcaptcha) {
      try {
        const mount = overlay.querySelector('#ts-hcaptcha-mount');
        const loading = overlay.querySelector('.ts-captcha-loading');
        if (loading) loading.style.display = 'none';
        const renderOpts = {
          sitekey,
          theme: 'dark',
          callback: (token) => this._submitCaptchaToken(token),
          'error-callback': () => {
            showNotification(t('ts.captcha_widget_error') || 'hCaptcha widget error — paste token manually', 'error');
          },
        };
        // Bind the solution to Discord's specific challenge. Required —
        // omitting this causes Discord to reject the captcha as "invalid-response".
        if (rqdata) renderOpts.rqdata = rqdata;
        window.hcaptcha.render(mount, renderOpts);
      } catch (e) {
        showNotification('hCaptcha render failed: ' + (e.message || e), 'error');
      }
    } else {
      const loading = overlay.querySelector('.ts-captcha-loading');
      if (loading) loading.textContent = t('ts.captcha_widget_blocked') || 'hCaptcha could not load — use the external link or paste a token.';
    }
  }

  async _submitCaptchaToken(token) {
    if (!this._captchaCurrentId) return;
    try {
      await window.electronAPI.tsResolveCaptcha(this._captchaCurrentId, token);
      showNotification(t('ts.captcha_submitted') || 'Captcha submitted ✓', 'success');
      this._closeCaptchaModal();
    } catch (e) {
      showNotification(e.message || 'Submit failed', 'error');
    }
  }

  async _cancelCaptcha() {
    if (!this._captchaCurrentId) { this._closeCaptchaModal(); return; }
    try { await window.electronAPI.tsCancelCaptcha(this._captchaCurrentId); } catch {}
    this._closeCaptchaModal();
  }

  _closeCaptchaModal() {
    if (this._captchaModal && this._captchaModal.parentNode) {
      this._captchaModal.parentNode.removeChild(this._captchaModal);
    }
    this._captchaModal = null;
    this._captchaCurrentId = null;
  }

  _startCountdownTicker() {
    if (this._countdownTimer) return;
    this._countdownTimer = setInterval(() => {
      // Re-render only the status card during a wait so the countdown updates smoothly
      const s = this.snapshot;
      if (s && s.state === 'waiting' && s.waitUntilTs > Date.now()) {
        const el = this.contentArea.querySelector('#ts-status-value');
        const bar = this.contentArea.querySelector('#ts-countdown-bar > span');
        if (el && bar) {
          const left = Math.max(0, s.waitUntilTs - Date.now());
          const total = Math.max(1, s.waitTotalMs || 1);
          const elapsedPct = Math.min(100, Math.max(0, ((total - left) / total) * 100));
          el.innerHTML = `${t('ts.state_waiting')} <span class="ts-stat-extra">(${this._fmtMs(left)})</span>`;
          bar.style.width = elapsedPct + '%';
        }
      }
    }, 500);
  }

  _fmtMs(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(1, '0')}:${String(s).padStart(2, '0')}`;
  }

  _stateMeta(state) {
    const map = {
      idle:      { label: t('ts.state_idle'),      cls: '',       fmt: 'plain' },
      running:   { label: t('ts.state_running'),   cls: 'mint',   fmt: 'plain' },
      waiting:   { label: t('ts.state_waiting'),   cls: 'mint',   fmt: 'wait'  },
      done:      { label: t('ts.state_done'),      cls: 'mint',   fmt: 'plain' },
      cancelled: { label: t('ts.state_cancelled'), cls: 'warn',   fmt: 'plain' },
      error:     { label: t('ts.state_error'),     cls: 'danger', fmt: 'plain' },
    };
    return map[state] || map.idle;
  }

  // ── Render ───────────────────────────────────────────
  render() {
    const s = this.snapshot || { state: 'idle', total: 0, done: 0, failed: 0, bots: [], log: [] };
    const meta = this._stateMeta(s.state);
    const sel = this.accounts.find(a => a.email === this.selectedEmail) || null;

    this.contentArea.innerHTML = `
      <div class="ts-wrap" dir="rtl">
        <div class="ts-brand">
          <div class="ts-brand-pulse" title="online"></div>
          <div class="ts-brand-title">
            <div class="ts-brand-name">Bot-Studio</div>
            <div class="ts-brand-sub">Automation Ultra · v${VERSION}</div>
          </div>
        </div>

        <div class="ts-stats">
          <div class="ts-stat">
            <div class="ts-stat-label">${t('ts.live_progress')}</div>
            <div class="ts-stat-value" id="ts-progress-value">${this._renderProgress(s)}</div>
          </div>
          <div class="ts-stat">
            <div class="ts-stat-label">${t('ts.automation_status')}</div>
            <div class="ts-stat-value ${meta.cls}" id="ts-status-value">${this._renderStatus(s, meta)}</div>
            ${s.state === 'waiting' ? `<div class="ts-countdown-bar" id="ts-countdown-bar"><span style="width:0%"></span></div>` : ''}
          </div>
        </div>

        <!-- Account picker -->
        <div class="ts-card">
          <div class="ts-card-head">
            <div class="ts-card-title ar">${t('ts.accounts_section')}</div>
          </div>
          <div class="ts-field">
            <div class="ts-field-label">${t('ts.active_account')}</div>
            <div class="ts-account-row">
              <button class="ts-btn danger" id="ts-acct-delete" ${sel ? '' : 'disabled'}>${t('ts.delete')}</button>
              <button class="ts-btn mint" id="ts-acct-save">${t('ts.save_account')}</button>
              <select class="ts-select" id="ts-acct-select">
                <option value="">${t('ts.choose_or_add')}</option>
                ${this.accounts.map(a => `
                  <option value="${escapeAttr(a.email)}" ${a.email === this.selectedEmail ? 'selected' : ''}>${this._optionLabel(a)}</option>
                `).join('')}
              </select>
            </div>
            <div class="ts-account-row" style="margin-top:8px;">
              <button class="ts-btn" id="ts-acct-test" ${sel ? '' : 'disabled'}>${t('ts.test_account')}</button>
              <div></div>
              <div id="ts-verify-info" class="ts-verify-info">${this._verifyLabel(sel)}</div>
            </div>
            ${this.accounts.length === 0 ? `<div class="ts-account-empty">${t('ts.no_accounts_yet')}</div>` : ''}
          </div>
        </div>

        <!-- Selected account credentials -->
        <div class="ts-card">
          <div class="ts-card-head">
            <div class="ts-card-title ar">${t('ts.account_data')}</div>
          </div>
          <div class="ts-form-grid">
            <div class="ts-field">
              <div class="ts-field-label">Email</div>
              <input type="email" id="ts-email" class="ts-input ltr" value="${escapeAttr(this.form.email)}" placeholder="account@example.com" autocomplete="off" />
            </div>
            <div class="ts-field">
              <div class="ts-field-label">Password</div>
              <input type="password" id="ts-password" class="ts-input ltr" value="" placeholder="${sel?.hasPassword ? '••••••••' : ''}" autocomplete="off" />
            </div>
          </div>
          <div class="ts-field">
            <div class="ts-field-label">2FA Auth Secret Key</div>
            <input type="text" id="ts-totp" class="ts-input totp" value="" placeholder="${sel?.hasTotp ? '•••• •••• •••• ••••' : 'BASE32 SECRET'}" autocomplete="off" />
          </div>
        </div>

        <!-- Automation rules -->
        <div class="ts-card">
          <div class="ts-card-head">
            <div class="ts-card-title">AUTOMATION RULES</div>
          </div>
          ${this._renderToggle('createTeams', t('ts.rule_create_teams'))}
          ${this._renderToggle('createBots', t('ts.rule_create_bots'))}
          ${this._renderToggle('linkBots', t('ts.rule_link_bots'))}

          <div class="ts-form-grid" style="margin-top:14px;">
            <div class="ts-field">
              <div class="ts-field-label">${t('ts.quantity')}</div>
              <input type="number" id="ts-count" class="ts-input numeric" min="1" max="50" value="${this.form.count}" />
            </div>
            <div class="ts-field">
              <div class="ts-field-label">${t('ts.bot_prefix')}</div>
              <input type="text" id="ts-prefix" class="ts-input" value="${escapeAttr(this.form.prefix)}" maxlength="24" />
            </div>
          </div>
          <div class="ts-field">
            <div class="ts-field-label">${t('ts.wait_minutes')}</div>
            <input type="number" id="ts-wait" class="ts-input numeric" min="0" max="60" value="${this.form.waitMinutes}" />
          </div>
        </div>

        <!-- Captcha solver settings -->
        ${this._renderCaptchaSettings()}

        <!-- Action buttons -->
        <div class="ts-actions">
          <button class="ts-btn danger big" id="ts-stop">${t('ts.stop')}</button>
          <button class="ts-btn mint big" id="ts-start">${t('ts.start_session')}</button>
        </div>

        <!-- Live log -->
        <div class="ts-log" id="ts-log">${this._renderLog(s.log || [])}</div>

        <!-- Library trigger button — opens a full-screen overlay with three
             tabs: Teams / Personal apps / Created bots (this session).
             Replaces the inline library card + bots list that used to live
             at the bottom of this page; the inline view was hard to use on
             mobile and felt cluttered alongside the running session. -->
        <div id="ts-lib-trigger">${this._renderLibraryTrigger(s)}</div>
      </div>
    `;
    this._bind();
  }

  _renderProgress(s) {
    if (!s.total) return `0/0`;
    return `${s.done}/${s.total} <span class="ts-stat-extra">${s.failed ? '· ' + s.failed + ' ✕' : ''}</span>`;
  }

  _renderStatus(s, meta) {
    if (meta.fmt === 'wait') {
      const left = Math.max(0, (s.waitUntilTs || 0) - Date.now());
      return `${meta.label} <span class="ts-stat-extra">(${this._fmtMs(left)})</span>`;
    }
    return meta.label;
  }

  _optionLabel(a) {
    const v = a.verify;
    let badge = '';
    if (v) badge = v.ok ? '  ✓' : '  !';
    return escapeHtml(a.email) + badge;
  }

  _verifyLabel(sel) {
    if (!sel) return '';
    const v = sel.verify;
    if (!v) return `<span class="ts-verify v-idle">${t('ts.verify_not_tested')}</span>`;
    const ago = Math.max(1, Math.round((Date.now() - (v.at || 0)) / 60000));
    if (v.ok) {
      const u = v.username ? ' · ' + escapeHtml(v.username) : '';
      return `<span class="ts-verify v-ok">✓ ${t('ts.verify_ok')} (${ago}m)${u}</span>`;
    }
    return `<span class="ts-verify v-bad" title="${escapeAttr(v.message || '')}">✕ ${t('ts.verify_failed')}: ${escapeHtml(v.status || '')}</span>`;
  }

  _renderToggle(key, label) {
    const on = !!this.form.rules[key];
    return `
      <div class="ts-toggle-row">
        <div class="ts-toggle-label">${label}</div>
        <div class="ts-toggle ${on ? 'on' : ''}" data-toggle="${key}" role="switch" aria-checked="${on}"></div>
      </div>
    `;
  }

  _renderCaptchaSettings() {
    const c = this.captchaSettings || {};
    const hasKey = !!c.hasApiKey;
    const fbOn = c.manualFallback !== false;
    return `
      <div class="ts-card" style="margin-top:14px;">
        <div class="ts-card-head">
          <div class="ts-card-title">${escapeHtml(t('ts.captcha_settings_title') || 'CAPTCHA SOLVER')}</div>
          <div class="ts-captcha-status ${hasKey ? 'on' : 'off'}">${hasKey
            ? (escapeHtml(t('ts.captcha_status_auto') || '2Captcha key set — auto-solve on'))
            : (escapeHtml(t('ts.captcha_status_manual') || 'No key — manual fallback'))}</div>
        </div>
        <div class="ts-field">
          <div class="ts-field-label">${escapeHtml(t('ts.captcha_provider') || 'Provider')}</div>
          <select id="ts-captcha-provider" class="ts-input">
            <option value="2captcha" ${(c.provider || '2captcha') === '2captcha' ? 'selected' : ''}>2Captcha (hCaptcha)</option>
          </select>
          <div class="ts-field-hint">
            ${escapeHtml(t('ts.captcha_provider_hint') || 'Get an hCaptcha solving API key at')}
            <a href="https://2captcha.com/?from=signup" target="_blank" rel="noopener">2captcha.com</a>
            ·
            <a href="https://2captcha.com/2captcha-api#solving_hcaptcha" target="_blank" rel="noopener">${escapeHtml(t('ts.captcha_docs') || 'API docs')}</a>
          </div>
        </div>
        <div class="ts-field">
          <div class="ts-field-label">${escapeHtml(t('ts.captcha_api_key') || 'API key')}</div>
          <div class="ts-account-row">
            <input type="password" id="ts-captcha-key" class="ts-input ltr"
              placeholder="${hasKey ? '•••••••••••• ' + (t('ts.captcha_key_set') || '(saved — leave blank to keep)') : (t('ts.captcha_key_placeholder') || 'paste your 2Captcha API key')}"
              autocomplete="off" />
            <button class="ts-btn mint" id="ts-captcha-save">${escapeHtml(t('ts.save') || 'Save')}</button>
            ${hasKey ? `<button class="ts-btn danger" id="ts-captcha-clear">${escapeHtml(t('ts.captcha_clear') || 'Clear')}</button>` : ''}
          </div>
        </div>
        <div class="ts-toggle-row">
          <div class="ts-toggle-label">${escapeHtml(t('ts.captcha_manual_fallback') || 'Manual fallback (open captcha popup if auto-solve fails)')}</div>
          <div class="ts-toggle ${fbOn ? 'on' : ''}" id="ts-captcha-fallback" role="switch" aria-checked="${fbOn}"></div>
        </div>
      </div>
    `;
  }

  _renderLog(log) {
    if (!log.length) return `<div class="ts-log-empty">${t('ts.log_empty')}</div>`;
    return log.map(e => {
      const time = new Date(e.ts).toLocaleTimeString([], { hour12: false });
      return `<div class="ts-log-line"><span class="ts-time">[${time}]</span><span class="lv-${e.level}">${escapeHtml(e.msg)}</span></div>`;
    }).join('');
  }

  // ── Library trigger button ────────────────────────────
  // Compact button that lives on the main page and opens the full-screen
  // library overlay. Shows two badges so the user can see at a glance:
  //   • how many bots they've created in this session
  //   • how many teams/apps the loaded library has (when it's already loaded)
  _renderLibraryTrigger(s) {
    const sessionBots = (s?.bots || []).length;
    const lib = this.library;
    const libCount = lib ? ((lib.totals?.teams || 0) + (lib.totals?.apps || 0)) : null;
    const badges = [];
    if (sessionBots) badges.push(`<span class="ts-libbtn-badge mint">${sessionBots} ${t('ts.lib_btn_session_short') || 'جديد'}</span>`);
    if (libCount !== null) badges.push(`<span class="ts-libbtn-badge">${libCount} ${t('ts.lib_btn_total_short') || 'إجمالي'}</span>`);
    return `
      <div class="ts-libbtn-wrap" style="margin-top:14px;">
        <button class="ts-libbtn" id="ts-lib-open" type="button">
          <span class="ts-libbtn-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3.5" y="4" width="6" height="16" rx="1.4"/>
              <rect x="10.5" y="4" width="4" height="16" rx="1.2"/>
              <path d="M16.6 5.2l3.3 .9a1 1 0 0 1 .7 1.22l-3 11.2a1 1 0 0 1 -1.22 .7l-1.38 -.37"/>
            </svg>
          </span>
          <span class="ts-libbtn-text">
            <span class="ts-libbtn-title">${t('ts.lib_btn_title') || 'فتح المكتبة'}</span>
            <span class="ts-libbtn-sub">${t('ts.lib_btn_sub') || 'التيمز · البوتات الحالية · البوتات المنشأة'}</span>
          </span>
          <span class="ts-libbtn-badges">${badges.join('')}</span>
        </button>
      </div>
    `;
  }

  // ── Full-screen library overlay ───────────────────────
  // Three tabs:
  //   teams    → all teams the account belongs to (with apps under each)
  //   personal → standalone apps not under any team
  //   created  → bots produced by the current TrueStudio session
  _openLibraryModal(initialTab = 'teams') {
    if (this._libModal) {
      // Already open — just switch to the requested tab
      this._switchLibraryTab(initialTab);
      return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'ts-lib-overlay';
    overlay.innerHTML = `
      <div class="ts-lib-page">
        <header class="ts-lib-page-head">
          <button class="ts-lib-back" id="ts-lib-close" aria-label="back">←</button>
          <div class="ts-lib-page-title">${t('ts.lib_btn_title') || 'فتح المكتبة'}</div>
          <button class="ts-btn" id="ts-lib-refresh-modal" ${this.libraryLoading || !this.selectedEmail ? 'disabled' : ''}>
            ${this.libraryLoading ? (t('ts.testing') || '...') : (t('ts.lib_refresh') || 'تحديث')}
          </button>
        </header>
        <nav class="ts-lib-tabs" role="tablist">
          <button class="ts-lib-tab" data-tab="teams" role="tab">${t('ts.lib_tab_teams') || 'التيمز'}</button>
          <button class="ts-lib-tab" data-tab="personal" role="tab">${t('ts.lib_tab_personal') || 'البوتات الحالية'}</button>
          <button class="ts-lib-tab" data-tab="created" role="tab">${t('ts.lib_tab_created') || 'البوتات المنشأة'}</button>
        </nav>
        <div class="ts-lib-page-body" id="ts-lib-page-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._libModal = overlay;
    this._libCurrentTab = initialTab;

    overlay.querySelector('#ts-lib-close').addEventListener('click', () => this._closeLibraryModal());
    overlay.querySelector('#ts-lib-refresh-modal').addEventListener('click', () => this.loadLibrary());
    overlay.querySelectorAll('.ts-lib-tab').forEach(btn => {
      btn.addEventListener('click', () => this._switchLibraryTab(btn.dataset.tab));
    });

    this._switchLibraryTab(initialTab);
    // Auto-load library on first open if not loaded yet (and we have an account)
    if (!this.library && !this.libraryLoading && this.selectedEmail) {
      this.loadLibrary();
    }
  }

  _closeLibraryModal() {
    if (this._libModal && this._libModal.parentNode) {
      this._libModal.parentNode.removeChild(this._libModal);
    }
    this._libModal = null;
    this._libCurrentTab = null;
  }

  _switchLibraryTab(tab) {
    if (!this._libModal) return;
    this._libCurrentTab = tab;
    this._libModal.querySelectorAll('.ts-lib-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    this._renderLibraryTab();
  }

  _renderLibraryTab() {
    if (!this._libModal) return;
    const body = this._libModal.querySelector('#ts-lib-page-body');
    if (!body) return;
    const tab = this._libCurrentTab || 'teams';
    if (tab === 'created') {
      body.innerHTML = this._renderCreatedBotsTab();
      this._bindCreatedTab(body);
      return;
    }
    // teams + personal share the loading/error/empty story since they come
    // from the same /api/ts/library response
    if (this.libraryLoading) {
      body.innerHTML = `<div class="ts-lib-empty">${t('ts.lib_loading') || 'جاري التحميل…'}</div>`;
      return;
    }
    if (this.libraryError) {
      body.innerHTML = `<div class="ts-lib-empty error">${escapeHtml(this.libraryError)}</div>`;
      return;
    }
    if (!this.selectedEmail) {
      body.innerHTML = `<div class="ts-lib-empty">${t('ts.pick_account_first') || 'اختر حساباً أولاً من الأعلى'}</div>`;
      return;
    }
    if (!this.library) {
      body.innerHTML = `<div class="ts-lib-empty">${t('ts.lib_hint') || 'اضغط تحديث لتحميل المكتبة'}</div>`;
      return;
    }
    if (tab === 'teams') {
      const teams = this.library.teams || [];
      if (!teams.length) {
        body.innerHTML = `<div class="ts-lib-empty">${t('ts.lib_no_teams') || 'لا توجد تيمز على هذا الحساب'}</div>`;
        return;
      }
      body.innerHTML = teams.map(team => `
        <div class="ts-team">
          <div class="ts-team-head">
            <div class="ts-team-name">${escapeHtml(team.name)}</div>
            <div class="ts-team-badge">${team.apps.length}/${team.appLimit || 25}</div>
          </div>
          ${team.apps.length
            ? `<div class="ts-cards">${team.apps.map(a => this._renderAppCard(a)).join('')}</div>`
            : `<div class="ts-team-empty">${t('ts.lib_team_empty') || 'لا تطبيقات'}</div>`}
        </div>
      `).join('');
      this._bindResetButtons(body);
      return;
    }
    if (tab === 'personal') {
      const apps = this.library.personal || [];
      if (!apps.length) {
        body.innerHTML = `<div class="ts-lib-empty">${t('ts.lib_no_personal') || 'لا توجد تطبيقات شخصية على هذا الحساب'}</div>`;
        return;
      }
      body.innerHTML = `<div class="ts-cards">${apps.map(a => this._renderAppCard(a)).join('')}</div>`;
      this._bindResetButtons(body);
      return;
    }
  }

  // Wire up the per-card "Reset Token" buttons inside the library overlay.
  // Triggered after every render of the Teams/Personal tabs so freshly-rendered
  // cards always receive their handler.
  _bindResetButtons(root) {
    root.querySelectorAll('[data-reset-bot]').forEach(btn => {
      // Idempotent — never bind the same button twice. Without this guard,
      // re-rendering the library tab would stack click handlers on already-
      // rendered DOM nodes, causing one click to fire the reset N times and
      // freezing the UI while N parallel requests execute.
      if (btn._resetBound) return;
      btn._resetBound = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const appId = btn.getAttribute('data-reset-bot');
        const name  = btn.getAttribute('data-bot-name') || appId;
        this._resetBotToken(appId, name, btn);
      });
    });
  }

  async _resetBotToken(appId, name, btn) {
    if (!appId || !this.selectedEmail) {
      showNotification(t('ts.pick_account_first'), 'error');
      return;
    }
    // Hard click-protection: refuse to start a second reset while one is
    // already running anywhere in the app (the request can take 15-30s and
    // a panicked second click was previously firing a duplicate request).
    if (this._resetInFlight) {
      showNotification(t('ts.reset_in_progress') || 'Reset already in progress…', 'info');
      return;
    }
    if (btn?.disabled) return;

    const ok = await showConfirm(
      (t('ts.confirm_reset_token') || 'Reset the bot token for {name}?').replace('{name}', name),
      { confirmText: t('ts.reset_token') }
    );
    if (!ok) return;

    this._resetInFlight = true;
    const origText = btn?.querySelector('.ts-card-reset-label')?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.classList.add('loading');
      const lbl = btn.querySelector('.ts-card-reset-label');
      if (lbl) lbl.textContent = t('ts.resetting_token') || 'Resetting…';
    }
    // Show a same-page progress overlay so the user gets immediate visual
    // feedback (the API call takes 15-30s — without this it looked frozen).
    const progress = this._openResetProgress(name);
    try {
      const r = await window.electronAPI.tsResetBot(appId, this.selectedEmail);
      const newToken = r?.token;
      if (!newToken) throw new Error('No token returned');
      // Persist it under the session "bots" list so it appears in the
      // "Created bots" tab and the export-tokens download.
      this._appendBotToSession({ name, appId, token: newToken });
      progress.success();
      showNotification(t('ts.token_reset_ok') || 'New bot token generated ✓', 'success');
      sfx.ding?.();
      // Token modal is rendered ON TOP of the library overlay (z-index handled
      // in CSS) so the user stays on the same page — no "press back" needed.
      this._openTokenModal({ name, appId, token: newToken });
    } catch (e) {
      progress.fail(e?.message || String(e));
      const raw = (e && (e.message || String(e))) || '';
      // Discord rejects /bot/reset without an MFA header. Surface a clear,
      // actionable message instead of the cryptic "Two-factor required".
      const looksLikeMfa = /two[-\s]?factor|mfa|2fa|60003|enable.*2fa/i.test(raw);
      const msg = looksLikeMfa
        ? (t('ts.token_reset_needs_mfa') ||
           'Discord requires the account to have 2FA enabled and its TOTP secret saved here. Edit the account → add the 2FA secret → retry.')
        : (t('ts.token_reset_failed') || 'Token reset failed') + ': ' + raw;
      showNotification(msg, 'error');
    } finally {
      this._resetInFlight = false;
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('loading');
        const lbl = btn.querySelector('.ts-card-reset-label');
        if (lbl && origText) lbl.textContent = origText;
      }
    }
  }

  // Lightweight progress overlay shown while a token reset is in flight.
  // Returns { success(), fail(msg) } — the overlay auto-dismisses shortly
  // after either is called so the user sees a final confirmed state.
  _openResetProgress(name) {
    document.querySelector('.ts-reset-progress')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'ts-reset-progress';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    wrap.innerHTML = `
      <div class="ts-reset-progress-card">
        <div class="ts-reset-progress-spinner" aria-hidden="true">
          <span></span><span></span><span></span>
        </div>
        <div class="ts-reset-progress-title">
          ${(t('ts.resetting_token_for') || 'Resetting bot token for')}
          <b>${this._escapeHtml(name)}</b>
        </div>
        <div class="ts-reset-progress-hint">
          ${t('ts.resetting_token_hint') || 'This usually takes 15–30 seconds. Please don’t close this window.'}
        </div>
        <div class="ts-reset-progress-bar"><i></i></div>
      </div>
    `;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    return {
      success: () => {
        wrap.classList.add('done');
        const title = wrap.querySelector('.ts-reset-progress-title');
        if (title) title.textContent = t('ts.token_reset_ok') || 'New bot token generated ✓';
        setTimeout(() => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 240); }, 600);
      },
      fail: (msg) => {
        wrap.classList.add('failed');
        const title = wrap.querySelector('.ts-reset-progress-title');
        if (title) title.textContent = t('ts.token_reset_failed') || 'Token reset failed';
        const hint = wrap.querySelector('.ts-reset-progress-hint');
        if (hint && msg) hint.textContent = String(msg).slice(0, 200);
        setTimeout(() => { wrap.classList.remove('open'); setTimeout(() => wrap.remove(), 240); }, 1400);
      },
    };
  }

  _escapeHtml(s = '') {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // Append a freshly-reset bot to the in-memory snapshot so the "Created bots"
  // tab and the token-export download include it. (Reset bots were not part
  // of the current automation session, but the user still wants them grouped.)
  _appendBotToSession({ name, appId, token }) {
    if (!this.snapshot) this.snapshot = { bots: [], log: [] };
    if (!Array.isArray(this.snapshot.bots)) this.snapshot.bots = [];
    // Replace any existing entry for this appId so we always have the latest token.
    this.snapshot.bots = this.snapshot.bots.filter(b => b.appId !== appId);
    this.snapshot.bots.unshift({
      name, appId,
      botUserId: '',
      hasToken: true,
      token, // local-only — server snapshot omits the raw token from /state
    });
    // Live-refresh the trigger badge + "Created bots" tab if it's open
    const trig = this.contentArea.querySelector('#ts-lib-trigger');
    if (trig) trig.innerHTML = this._renderLibraryTrigger(this.snapshot);
    if (this._libModal && this._libCurrentTab === 'created') this._renderLibraryTab();
  }

  // Modal that surfaces a freshly-generated bot token. The token is rendered
  // ONCE — Discord won't return it again — with a prominent Copy button.
  _openTokenModal({ name, appId, token }) {
    // Tear down any previous instance
    document.querySelector('.ts-token-modal-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'ts-token-modal-overlay';
    overlay.innerHTML = `
      <div class="ts-token-modal">
        <div class="ts-token-modal-head">
          <div class="ts-token-modal-title">${escapeHtml(t('ts.new_token_modal_title') || 'New bot token')}</div>
          <button class="ts-token-modal-close" type="button" aria-label="close">×</button>
        </div>
        <div class="ts-token-modal-body">
          <div class="ts-token-modal-bot">${escapeHtml(name)} <span class="ts-token-modal-id">${escapeHtml(appId)}</span></div>
          <div class="ts-token-modal-hint">${escapeHtml(t('ts.new_token_modal_hint') || 'Copy this token now — it will not be shown again.')}</div>
          <div class="ts-token-box" id="ts-token-value">${escapeHtml(token)}</div>
          <div class="ts-token-modal-actions">
            <button class="ts-btn mint" id="ts-token-copy">${escapeHtml(t('ts.copy_token') || 'Copy Token')}</button>
            <button class="ts-btn" id="ts-token-close-btn">${escapeHtml(t('ts.close') || 'Close')}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.ts-token-modal-close').addEventListener('click', close);
    overlay.querySelector('#ts-token-close-btn').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelector('#ts-token-copy').addEventListener('click', async () => {
      try {
        await copyToClipboard(token);
        showNotification(t('ts.token_copied') || 'Token copied ✓', 'success');
      } catch (e) {
        showNotification(t('ts.copy_failed') || 'Copy failed', 'error');
      }
    });
  }

  _renderCreatedBotsTab() {
    const bots = this.snapshot?.bots || [];
    if (!bots.length) {
      return `<div class="ts-lib-empty">${t('ts.lib_no_created') || 'لم يتم إنشاء أي بوت في هذه الجلسة بعد'}</div>`;
    }
    const exportHref = window.electronAPI.tsExportUrl('text');
    return `
      <div class="ts-created-head">
        <div class="ts-created-count">${bots.length} ${t('ts.lib_created_count_label') || 'بوت'}</div>
        <a class="ts-btn" href="${exportHref}" download>${t('ts.export_tokens') || 'تصدير التوكنات'}</a>
      </div>
      <div class="ts-bots-list">
        ${bots.map(b => `
          <div class="ts-bot-row">
            <span class="name">${escapeHtml(b.name)}</span>
            <span class="token">${b.hasToken ? (b.appId.slice(0, 6) + '… · ' + (b.botUserId || '').slice(0, 8)) : ''}</span>
            <button class="ts-btn" data-copy-id="${escapeAttr(b.appId)}">${t('ts.copy_id') || 'نسخ المعرف'}</button>
          </div>
        `).join('')}
      </div>
    `;
  }

  _bindCreatedTab(root) {
    root.querySelectorAll('[data-copy-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-copy-id');
        try {
          navigator.clipboard.writeText(id);
          showNotification(t('ts.copied') || 'تم النسخ ✓', 'success');
        } catch (_) {
          showNotification('Copy failed', 'error');
        }
      });
    });
  }

  _renderLibrary() {
    const lib = this.library;
    const refreshBtn = `<button class="ts-btn" id="ts-lib-refresh" ${this.libraryLoading || !this.selectedEmail ? 'disabled' : ''}>${this.libraryLoading ? t('ts.testing') : t('ts.lib_refresh')}</button>`;
    let body = '';
    if (this.libraryLoading) {
      body = `<div class="ts-lib-empty">${t('ts.lib_loading')}</div>`;
    } else if (this.libraryError) {
      body = `<div class="ts-lib-empty error">${escapeHtml(this.libraryError)}</div>`;
    } else if (!lib) {
      body = `<div class="ts-lib-empty">${t('ts.lib_hint')}</div>`;
    } else if ((lib.teams || []).length === 0 && (lib.personal || []).length === 0) {
      body = `<div class="ts-lib-empty">${t('ts.lib_no_apps')}</div>`;
    } else {
      const teamsHtml = (lib.teams || []).map(team => `
        <div class="ts-team">
          <div class="ts-team-head">
            <div class="ts-team-name">${escapeHtml(team.name)}</div>
            <div class="ts-team-badge">${team.apps.length}/${team.appLimit || 25}</div>
          </div>
          ${team.apps.length ? `<div class="ts-cards">${team.apps.map(a => this._renderAppCard(a)).join('')}</div>` :
            `<div class="ts-team-empty">${t('ts.lib_team_empty')}</div>`}
        </div>
      `).join('');
      const personalHtml = (lib.personal || []).length ? `
        <div class="ts-team">
          <div class="ts-team-head">
            <div class="ts-team-name">${t('ts.lib_personal')}</div>
            <div class="ts-team-badge personal">${lib.personal.length}</div>
          </div>
          <div class="ts-cards">${lib.personal.map(a => this._renderAppCard(a)).join('')}</div>
        </div>
      ` : '';
      body = teamsHtml + personalHtml;
    }
    return `
      <div class="ts-card" style="margin-top:14px;">
        <div class="ts-card-head">
          <div class="ts-card-title ar">${t('ts.lib_title')}</div>
          ${refreshBtn}
        </div>
        ${lib ? `<div class="ts-lib-summary">${t('ts.lib_summary').replace('{teams}', lib.totals?.teams || 0).replace('{apps}', lib.totals?.apps || 0)}</div>` : ''}
        <div class="ts-lib-body">${body}</div>
      </div>
    `;
  }

  _renderAppCard(a) {
    const initials = this._initialsFor(a.name);
    const iconUrl = a.icon ? `https://cdn.discordapp.com/app-icons/${a.id}/${a.icon}.png?size=128` : null;
    const tag = a.isBot ? '<span class="ts-card-tag bot">BOT</span>' : '<span class="ts-card-tag app">APP</span>';
    // Reset button is only meaningful for actual bot applications (not pure apps).
    // It is rendered at the BOTTOM of the card (below the name) so it never
    // covers the avatar or the bot name, and the card keeps its square look.
    const resetBtn = a.isBot ? `
      <button class="ts-card-reset" type="button"
        data-reset-bot="${escapeAttr(a.id)}"
        data-bot-name="${escapeAttr(a.name)}"
        title="${escapeAttr(t('ts.reset_token'))}">
        <span class="ts-card-reset-icon" aria-hidden="true">⟳</span>
        <span class="ts-card-reset-label">${escapeHtml(t('ts.reset_token'))}</span>
      </button>` : '';
    return `
      <div class="ts-app-card${a.isBot ? ' has-reset' : ''}" title="${escapeAttr(a.id)}">
        <div class="ts-app-thumb">
          ${iconUrl ? `<img src="${iconUrl}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${escapeAttr(initials)}',className:'ts-thumb-text'}))">` : `<span class="ts-thumb-text">${escapeHtml(initials)}</span>`}
        </div>
        <div class="ts-app-name">${escapeHtml(a.name)}</div>
        ${tag}
        ${resetBtn}
      </div>
    `;
  }

  _initialsFor(name) {
    const s = String(name || '').trim();
    if (!s) return '?';
    // "True-Studio7035" → "T-S"; "MyBot" → "MB"; "alpha beta" → "AB"
    const parts = s.split(/[\s\-_]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + '-' + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  _renderBots(bots) {
    if (!bots.length) return '';
    return `
      <div class="ts-card" style="margin-top:6px;">
        <div class="ts-card-head">
          <div class="ts-card-title">${t('ts.created_bots')} (${bots.length})</div>
          <a class="ts-btn" href="${window.electronAPI.tsExportUrl('text')}" download>${t('ts.export_tokens')}</a>
        </div>
        <div class="ts-bots-list">
          ${bots.map(b => `
            <div class="ts-bot-row">
              <span class="name">${escapeHtml(b.name)}</span>
              <span class="token">${b.hasToken ? (b.appId.slice(0, 6) + '… · ' + (b.botUserId || '').slice(0, 8)) : ''}</span>
              <button data-copy-id="${escapeAttr(b.appId)}">${t('ts.copy_id')}</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  _renderLive() {
    const s = this.snapshot;
    if (!s) return;
    const prog = this.contentArea.querySelector('#ts-progress-value');
    if (prog) prog.innerHTML = this._renderProgress(s);
    const stat = this.contentArea.querySelector('#ts-status-value');
    if (stat) {
      const meta = this._stateMeta(s.state);
      stat.className = 'ts-stat-value ' + meta.cls;
      stat.innerHTML = this._renderStatus(s, meta);
    }
    const log = this.contentArea.querySelector('#ts-log');
    if (log) {
      log.innerHTML = this._renderLog(s.log || []);
      log.scrollTop = log.scrollHeight;
    }
    // Refresh the "open library" trigger button so its session-bots badge
    // updates as new bots are produced. (The old inline #ts-bots / #ts-library
    // sections were replaced by this single trigger.)
    const trig = this.contentArea.querySelector('#ts-lib-trigger');
    if (trig) {
      trig.innerHTML = this._renderLibraryTrigger(s);
      // CRITICAL: rebuilding innerHTML wipes the click handler that _bind()
      // attached to #ts-lib-open. Without re-attaching here, the library
      // button stops responding after the very first SSE update — that's the
      // "hang" the user reported. Same goes for the inline refresh button.
      trig.querySelector('#ts-lib-open')
          ?.addEventListener('click', () => this._openLibraryModal('teams'));
      trig.querySelector('#ts-lib-refresh')
          ?.addEventListener('click', () => this.loadLibrary());
    }
    // If the library overlay is open AND the user is on the "created" tab,
    // re-render its body so newly-created bots appear live.
    if (this._libModal && this._libCurrentTab === 'created') {
      this._renderLibraryTab();
    }
    // Add or remove the countdown bar dynamically
    const stats = this.contentArea.querySelector('.ts-stats .ts-stat:nth-child(2)');
    if (stats) {
      const existing = stats.querySelector('#ts-countdown-bar');
      if (s.state === 'waiting' && !existing) {
        stats.insertAdjacentHTML('beforeend', `<div class="ts-countdown-bar" id="ts-countdown-bar"><span style="width:0%"></span></div>`);
      } else if (s.state !== 'waiting' && existing) {
        existing.remove();
      }
    }
  }

  // ── Bindings ──────────────────────────────────────────
  _bind() {
    const $ = (sel) => this.contentArea.querySelector(sel);

    $('#ts-acct-select')?.addEventListener('change', (e) => {
      this.selectedEmail = e.target.value || null;
      this.form.email = this.selectedEmail || '';
      this.form.password = '';
      this.form.totpSecret = '';
      // Clear library if it belongs to a different account
      if (this.libraryEmail && this.libraryEmail !== this.selectedEmail) {
        this.library = null; this.libraryEmail = null; this.libraryError = '';
      }
      this.render();
    });
    $('#ts-lib-refresh')?.addEventListener('click', () => this.loadLibrary());
    // Open the full-screen library overlay (Teams / Personal / Created tabs)
    $('#ts-lib-open')?.addEventListener('click', () => this._openLibraryModal('teams'));
    $('#ts-acct-save')?.addEventListener('click', () => this.saveAccount());
    $('#ts-acct-delete')?.addEventListener('click', () => this.deleteAccount());
    $('#ts-acct-test')?.addEventListener('click', () => this.testAccount());

    $('#ts-email')?.addEventListener('input', (e) => this.form.email = e.target.value.trim());
    $('#ts-password')?.addEventListener('input', (e) => this.form.password = e.target.value);
    $('#ts-totp')?.addEventListener('input', (e) => this.form.totpSecret = e.target.value.replace(/\s+/g, ''));

    this.contentArea.querySelectorAll('[data-toggle]').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.dataset.toggle;
        this.form.rules[key] = !this.form.rules[key];
        sfx.click?.();
        el.classList.toggle('on');
        el.setAttribute('aria-checked', String(this.form.rules[key]));
      });
    });

    $('#ts-count')?.addEventListener('input', (e) => {
      this.form.count = Math.max(1, Math.min(50, parseInt(e.target.value) || 1));
    });
    $('#ts-prefix')?.addEventListener('input', (e) => this.form.prefix = e.target.value);
    $('#ts-wait')?.addEventListener('input', (e) => {
      this.form.waitMinutes = Math.max(0, Math.min(60, parseInt(e.target.value) || 0));
    });

    $('#ts-start')?.addEventListener('click', () => this.startSession());
    $('#ts-stop')?.addEventListener('click', () => this.stopSession());

    // Captcha settings
    $('#ts-captcha-save')?.addEventListener('click', () => this.saveCaptchaSettings());
    $('#ts-captcha-clear')?.addEventListener('click', () => this.clearCaptchaKey());
    $('#ts-captcha-fallback')?.addEventListener('click', () => this.toggleCaptchaFallback());

    this.contentArea.querySelectorAll('[data-copy-id]').forEach(el => {
      el.addEventListener('click', async () => {
        try { await copyToClipboard(el.dataset.copyId); showNotification(t('ts.copied'), 'success'); }
        catch (e) { showNotification(t('ts.copy_failed'), 'error'); }
      });
    });
  }

  // ── Actions ───────────────────────────────────────────
  async saveAccount() {
    const email = (this.form.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      showNotification(t('ts.invalid_email'), 'error');
      return;
    }
    const payload = { email };
    // Only send password / TOTP if user typed one (so editing existing account doesn't wipe creds)
    if (this.form.password) payload.password = this.form.password;
    if (this.form.totpSecret) payload.totpSecret = this.form.totpSecret;
    try {
      await window.electronAPI.tsSaveAccount(payload);
      showNotification(t('ts.account_saved'), 'success');
      this.selectedEmail = email;
      this.form.password = '';
      this.form.totpSecret = '';
      await this.refresh();
      this.render();
    } catch (e) {
      showNotification(e.message || 'Save failed', 'error');
    }
  }

  async loadLibrary() {
    if (!this.selectedEmail) { showNotification(t('ts.pick_account_first'), 'error'); return; }
    this.libraryLoading = true;
    this.libraryError = '';
    // Re-render only the library card to show the loading state
    this._patchLibrary();
    try {
      const r = await window.electronAPI.tsLibrary(this.selectedEmail);
      this.library = { teams: r.teams || [], personal: r.personal || [], totals: r.totals || {} };
      this.libraryEmail = this.selectedEmail;
    } catch (e) {
      this.libraryError = e.message || 'Failed to load library';
      this.library = null;
    } finally {
      this.libraryLoading = false;
      this._patchLibrary();
    }
  }

  _patchLibrary() {
    // Trigger button shows the live "loaded apps" badge
    const trig = this.contentArea.querySelector('#ts-lib-trigger');
    if (trig) trig.innerHTML = this._renderLibraryTrigger(this.snapshot);
    // If the overlay is open, refresh its body and the refresh-button state
    if (this._libModal) {
      const refreshBtn = this._libModal.querySelector('#ts-lib-refresh-modal');
      if (refreshBtn) {
        refreshBtn.disabled = !!(this.libraryLoading || !this.selectedEmail);
        refreshBtn.textContent = this.libraryLoading
          ? (t('ts.testing') || '...')
          : (t('ts.lib_refresh') || 'تحديث');
      }
      this._renderLibraryTab();
    }
  }

  async testAccount() {
    if (!this.selectedEmail) { showNotification(t('ts.pick_account_first'), 'error'); return; }
    const btn = this.contentArea.querySelector('#ts-acct-test');
    const info = this.contentArea.querySelector('#ts-verify-info');
    if (btn) { btn.disabled = true; btn.textContent = t('ts.testing'); }
    if (info) info.innerHTML = `<span class="ts-verify v-idle">${t('ts.testing')}</span>`;
    try {
      const r = await window.electronAPI.tsTestAccount(this.selectedEmail);
      this.accounts = r?.accounts || this.accounts;
      const ok = r?.verify?.ok;
      showNotification(ok ? t('ts.verify_ok') : (t('ts.verify_failed') + ': ' + (r?.verify?.message || '')), ok ? 'success' : 'error');
    } catch (e) {
      showNotification(e.message || 'Test failed', 'error');
    } finally {
      this.render();
    }
  }

  async deleteAccount() {
    if (!this.selectedEmail) return;
    const target = this.selectedEmail;
    const confirmed = await showConfirm(
      t('ts.confirm_delete_msg').replace('{email}', target),
      { confirmText: t('ts.delete') }
    );
    if (!confirmed) return;
    try {
      await window.electronAPI.tsDeleteAccount(target);
      showNotification(t('ts.account_deleted'), 'success');
      this.selectedEmail = null;
      this.form.email = '';
      await this.refresh();
      this.render();
    } catch (e) {
      showNotification(e.message || 'Delete failed', 'error');
    }
  }

  async startSession() {
    if (!this.selectedEmail) {
      showNotification(t('ts.pick_account_first'), 'error');
      return;
    }
    const r = this.form.rules;
    if (!r.createTeams && !r.createBots && !r.linkBots) {
      showNotification(t('ts.pick_at_least_one_rule'), 'error');
      return;
    }
    try {
      await window.electronAPI.tsStart({
        email: this.selectedEmail,
        rules: r,
        count: this.form.count,
        prefix: this.form.prefix,
        waitMinutes: this.form.waitMinutes,
      });
      showNotification(t('ts.session_started'), 'success');
      sfx.ding?.();
      await this.refresh();
      this._renderLive();
    } catch (e) {
      showNotification(e.message || 'Start failed', 'error');
    }
  }

  async stopSession() {
    try {
      await window.electronAPI.tsStop();
      showNotification(t('ts.session_stopping'), 'warn');
      await this.refresh();
      this._renderLive();
    } catch (e) {
      showNotification(e.message || 'Stop failed', 'error');
    }
  }

  // ── Captcha settings actions ──────────────────────────────
  async saveCaptchaSettings() {
    const provEl = this.contentArea.querySelector('#ts-captcha-provider');
    const keyEl = this.contentArea.querySelector('#ts-captcha-key');
    const provider = provEl?.value || '2captcha';
    const apiKey = (keyEl?.value || '').trim();
    const payload = { provider };
    if (apiKey) payload.apiKey = apiKey;
    try {
      const r = await window.electronAPI.tsSaveCaptchaSettings(payload);
      if (r?.settings) this.captchaSettings = r.settings;
      showNotification(t('ts.captcha_saved') || 'Captcha settings saved ✓', 'success');
      this.render();
    } catch (e) {
      showNotification(e.message || 'Save failed', 'error');
    }
  }

  async clearCaptchaKey() {
    const ok = await showConfirm(t('ts.captcha_clear_confirm') || 'Remove the saved API key?', { confirmText: t('ts.captcha_clear') || 'Clear' });
    if (!ok) return;
    try {
      const r = await window.electronAPI.tsSaveCaptchaSettings({ clearKey: true });
      if (r?.settings) this.captchaSettings = r.settings;
      showNotification(t('ts.captcha_cleared') || 'API key removed', 'success');
      this.render();
    } catch (e) {
      showNotification(e.message || 'Clear failed', 'error');
    }
  }

  async toggleCaptchaFallback() {
    const next = !(this.captchaSettings?.manualFallback !== false);
    try {
      const r = await window.electronAPI.tsSaveCaptchaSettings({ manualFallback: next });
      if (r?.settings) this.captchaSettings = r.settings;
      this.render();
    } catch (e) {
      showNotification(e.message || 'Toggle failed', 'error');
    }
  }
}

// ─── Local helpers ────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
