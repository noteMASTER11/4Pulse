const ACTION_BUTTON_ICONS = {
    default: {
        16: 'img/icons/icon_48.png',
        19: 'img/icons/icon_48.png',
        32: 'img/icons/icon_48.png',
        48: 'img/icons/icon_48.png',
    },
    has_qms: {
        16: 'img/icons/icon_48_qms.png',
        19: 'img/icons/icon_48_qms.png',
        32: 'img/icons/icon_48_qms.png',
        48: 'img/icons/icon_48_qms.png',
    },
    logout: {
        16: 'img/icons/icon_19_out.png',
        19: 'img/icons/icon_19_out.png',
        32: 'img/icons/icon_19_out.png',
        48: 'img/icons/icon_19_out.png',
    }
}

const BADGE_STYLES = {
    favorites: { bg: '#ffffff', text: '#111111' },
    qms:       { bg: '#e53935', text: '#ffffff' },
    tickets:   { bg: '#8b5cf6', text: '#ffffff' },
    mentions:  { bg: '#f5c518', text: '#111111' },
}

const BADGE_STYLES_GLASS = {
    favorites: { glow: 'rgba(40,180,255,1.0)',  glowDim: 'rgba(40,180,255,0.25)',   glow2: 'rgba(100,210,255,0.90)', text: '#ffffff' },
    qms:       { glow: 'rgba(255,60,160,1.0)',  glowDim: 'rgba(255,60,160,0.28)',   glow2: 'rgba(255,120,200,0.90)', text: '#ffffff' },
    tickets:   { glow: 'rgba(160,100,255,1.0)', glowDim: 'rgba(160,100,255,0.28)',  glow2: 'rgba(205,170,255,0.90)', text: '#ffffff' },
    mentions:  { glow: 'rgba(255,200,30,1.0)',  glowDim: 'rgba(255,200,30,0.28)',   glow2: 'rgba(255,230,100,0.90)', text: '#1a1a00' },
}

let _cachedTheme = 'light';
chrome.storage.local.get(['theme_mode'], d => { _cachedTheme = d.theme_mode || 'light'; });
chrome.storage.onChanged.addListener(changes => {
    if (changes.theme_mode) _cachedTheme = changes.theme_mode.newValue || 'light';
});

// FIX 1: Bitmap-кэш — PNG грузится один раз, затем переиспользуется
const _bitmapCache = new Map();

async function _getBitmap(iconPath, size) {
    const key = `${iconPath}:${size}`;
    if (_bitmapCache.has(key)) return _bitmapCache.get(key);
    const resp = await fetch(chrome.runtime.getURL(iconPath));
    const blob = await resp.blob();
    const bmp  = await createImageBitmap(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
    _bitmapCache.set(key, bmp);
    return bmp;
}

function _set_popup(available) {
    chrome.action.setPopup({ 'popup': available ? 'html/popup.html' : '' });
}

function _getBadge(q_count, f_count, m_count, t_count = 0) {
    const total = (q_count || 0) + (f_count || 0) + (m_count || 0) + (t_count || 0);
    if (total === 0) return { label: null, style: null };
    const label = total > 99 ? '99+' : String(total);
    const key   = q_count ? 'qms' : t_count ? 'tickets' : m_count ? 'mentions' : 'favorites';
    const style = { ...BADGE_STYLES[key], _glassKey: key };
    return { label, style };
}

async function _make_badge_icon(iconPath, label, badgeStyle, size) {
    try {
        const bitmap = await _getBitmap(iconPath, size);
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, size, size);
        if (label && badgeStyle) await _draw_badge_on_ctx(ctx, label, badgeStyle, size);
        return ctx.getImageData(0, 0, size, size);
    } catch (e) { console.warn('_make_badge_icon failed:', e); return null; }
}

async function _make_qms_icon(size) {
    try {
        const bitmap = await _getBitmap('img/icons/icon_48_qms.png', size);
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, size, size);
        return ctx.getImageData(0, 0, size, size);
    } catch(e) { console.warn('_make_qms_icon failed:', e); return null; }
}

// Отслеживаем последний применённый стиль бейджа — нужен для восстановления после блинка
let _prevBadgeStyle = null;

async function _update_toolbar_icon(icon, label, badgeStyle) {
    try {
        const isQms = icon === ACTION_BUTTON_ICONS.has_qms;
        if (isQms) {
            const [d16, d32, d48] = await Promise.all([_make_qms_icon(16), _make_qms_icon(32), _make_qms_icon(48)]);
            if (d16 && d32 && d48) chrome.action.setIcon({ imageData: { 16: d16, 32: d32, 48: d48 } });
            else chrome.action.setIcon({ path: icon });
        } else {
            chrome.action.setIcon({ path: icon });
        }
        if (label && badgeStyle) {
            _prevBadgeStyle = badgeStyle;
            chrome.action.setBadgeText({ text: label });
            chrome.action.setBadgeBackgroundColor({ color: badgeStyle.bg });
            if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: badgeStyle.text });
        } else {
            _prevBadgeStyle = null;
            chrome.action.setBadgeText({ text: '' });
        }
    } catch(e) { chrome.action.setIcon({ path: icon }); chrome.action.setBadgeText({ text: '' }); }
}

async function _overlay_badge_on_imagedata(imageData, label, badgeStyle, size) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const baseBitmap = await createImageBitmap(new ImageData(
        new Uint8ClampedArray(imageData.data), imageData.width, imageData.height
    ));
    ctx.drawImage(baseBitmap, 0, 0);
    await _draw_badge_on_ctx(ctx, label, badgeStyle, size);
    return ctx.getImageData(0, 0, size, size);
}

async function _draw_badge_on_ctx(ctx, label, badgeStyle, size) {
    const isGlass = _cachedTheme === 'liquid-glass';
    const gs = isGlass ? (BADGE_STYLES_GLASS[badgeStyle._glassKey] || BADGE_STYLES_GLASS.qms) : null;

    const baseR  = Math.round(size * 0.19);
    const stroke = Math.max(1.5, Math.round(size * 0.06));
    const cx = size - baseR - 1;
    const cy = baseR + 1;
    const fs = label.length >= 3 ? Math.round(baseR * 0.72) : Math.round(baseR * 0.95);

    function pillPath() {
        ctx.beginPath();
        ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
    }

    if (isGlass) {
        const outerGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, baseR * 2.8);
        outerGlow.addColorStop(0, gs.glowDim.replace('0.25','0.45').replace('0.28','0.50'));
        outerGlow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = outerGlow; ctx.beginPath(); ctx.arc(cx, cy, baseR * 2.8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.70)';
        ctx.shadowColor = 'rgba(0,0,0,0.70)'; ctx.shadowBlur = stroke + 2;
        pillPath(); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(0,0,0,0.40)'; pillPath(); ctx.fill();
        const glassGrad = ctx.createRadialGradient(cx - baseR * 0.20, cy - baseR * 0.25, 0, cx, cy, baseR * 1.2);
        glassGrad.addColorStop(0, gs.glow2); glassGrad.addColorStop(0.45, gs.glow); glassGrad.addColorStop(1, gs.glowDim);
        ctx.fillStyle = glassGrad; ctx.globalAlpha = 0.90; pillPath(); ctx.fill(); ctx.globalAlpha = 1.0;
        const hlGrad = ctx.createLinearGradient(cx, cy - baseR, cx, cy);
        hlGrad.addColorStop(0, 'rgba(255,255,255,0.65)'); hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hlGrad; pillPath(); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.50)'; ctx.lineWidth = Math.max(1, stroke * 0.55);
        pillPath(); ctx.stroke();
        ctx.shadowColor = 'rgba(0,0,0,0.80)'; ctx.shadowBlur = Math.round(baseR * 0.5);
        ctx.fillStyle = gs.text;
        ctx.font = `bold ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, cy + fs * 0.05); ctx.shadowBlur = 0;
    } else {
        ctx.fillStyle = 'rgba(0,0,0,0.50)';
        ctx.shadowColor = 'rgba(0,0,0,0.50)'; ctx.shadowBlur = stroke + 1;
        pillPath(); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = badgeStyle.bg; pillPath(); ctx.fill();
        ctx.fillStyle = badgeStyle.text;
        ctx.font = `bold ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, cy + fs * 0.05);
    }
}

async function _make_badge_icon_on_blank(label, badgeStyle, size) {
    try {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        await _draw_badge_on_ctx(ctx, label, badgeStyle, size);
        return ctx.getImageData(0, 0, size, size);
    } catch(e) { return null; }
}

async function _update_sidebar_icon(icon, label, badgeStyle) {
    if (typeof browser === 'undefined' || !browser.sidebarAction) return;
    try {
        const SZ = 64, canvas = new OffscreenCanvas(SZ, SZ), ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
        const bmp = await _getBitmap(icon[48], SZ);
        ctx.drawImage(bmp, 0, 0, SZ, SZ);
        if (label && badgeStyle) {
            const R = Math.round(SZ * 0.17), isL = label.length >= 2, pp = isL ? Math.round(R * 0.6) : 0;
            const cx = SZ - R - 1, cy = R + 1, lx = isL ? Math.max(R + 1, cx - pp * 2) : cx;
            const fs = label.length >= 3 ? Math.round(R * 0.75) : Math.round(R), tx = isL ? (lx + cx) / 2 : cx;
            function pill() { ctx.beginPath(); if (!isL) { ctx.arc(cx, cy, R, 0, Math.PI * 2); } else { ctx.moveTo(lx, cy - R); ctx.arcTo(cx + R, cy - R, cx + R, cy, R); ctx.arcTo(cx + R, cy + R, lx, cy + R, R); ctx.arcTo(lx - R, cy + R, lx - R, cy, R); ctx.arcTo(lx - R, cy - R, lx, cy - R, R); ctx.closePath(); } }
            ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 8; ctx.fillStyle = badgeStyle.bg; pill(); ctx.fill(); ctx.shadowBlur = 0;
            ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(4, SZ * 0.07); ctx.lineJoin = 'round'; pill(); ctx.stroke();
            ctx.fillStyle = badgeStyle.bg; pill(); ctx.fill();
            ctx.fillStyle = badgeStyle.text; ctx.font = `bold ${fs}px -apple-system,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, tx, cy + fs * 0.06);
        }
        const out = new OffscreenCanvas(32, 32), oc = out.getContext('2d');
        oc.imageSmoothingEnabled = true; oc.imageSmoothingQuality = 'high'; oc.drawImage(canvas, 0, 0, 32, 32);
        await browser.sidebarAction.setIcon({ imageData: { 32: oc.getImageData(0, 0, 32, 32) } });
    } catch(e) { try { await browser.sidebarAction.setIcon({ path: icon }); } catch(_) {} }
}

export function print_unavailable() {
    _set_popup(false);
    chrome.action.setBadgeText({ text: 'N/A' });
    chrome.action.setBadgeBackgroundColor({ color: '#9e9e9e' });
    chrome.action.setIcon({ path: ACTION_BUTTON_ICONS.logout });
    chrome.action.setTitle({ title: '4PDA - Сайт недоступен' });
    _update_sidebar_icon(ACTION_BUTTON_ICONS.logout, null, null);
}

export function print_logout() {
    _set_popup(false);
    chrome.action.setBadgeText({ text: 'login' });
    chrome.action.setBadgeBackgroundColor({ color: '#9e9e9e' });
    chrome.action.setIcon({ path: ACTION_BUTTON_ICONS.logout });
    chrome.action.setTitle({ title: '4PDA - Не в сети' });
    _update_sidebar_icon(ACTION_BUTTON_ICONS.logout, null, null);
}

// ─────────────────────────────────────────────────────────────────
// FIX 2: Debounce + очередь, FIX 3: Атомарный _prevBadgeCount,
// FIX 4: Отмена анимации, FIX 5: Интеграция с blink
// ─────────────────────────────────────────────────────────────────
let _pendingArgs    = null;
let _iconLock       = false;
let _debounceTimer  = null;
let _animAbortFlag  = { cancelled: false };
let _prevBadgeCount = -1;
let _blinkActive    = false;  // FIX 5: когда true — print_count не перетирает бейдж

async function _applyIconUpdate(q_count, f_count, m_count, t_count) {
    // FIX 5: Blink активен — не трогаем badge, запоминаем счётчики для восстановления
    if (_blinkActive) {
        _pendingArgs = { q: q_count, f: f_count, m: m_count, t: t_count };
        _iconLock = false;
        return;
    }

    _iconLock = true;
    const prevCount = _prevBadgeCount;

    try {
        const icon = q_count ? ACTION_BUTTON_ICONS.has_qms : ACTION_BUTTON_ICONS.default;
        const { label, style } = _getBadge(q_count, f_count, m_count, t_count);
        const badgeCount = (f_count || 0) + (q_count || 0) + (m_count || 0) + (t_count || 0);

        chrome.action.setTitle({ title: `4PDA - В сети\nНепрочитанных тем: ${f_count}\nНепрочитанных диалогов: ${q_count}\nУпоминаний: ${m_count || 0}\nТикетов: ${t_count || 0}` });

        if (prevCount > 0 && badgeCount < prevCount && badgeCount >= 0) {
            // FIX 4: Отменяем предыдущую анимацию
            _animAbortFlag.cancelled = true;
            const myAbortFlag = { cancelled: false };
            _animAbortFlag = myAbortFlag;
            await _animateBadgeCount(prevCount, badgeCount, q_count, f_count, m_count, t_count, icon, myAbortFlag);
        } else {
            await _update_toolbar_icon(icon, label, style);
        }

        // FIX 3: Атомарное обновление внутри lock — не после await снаружи
        _prevBadgeCount = badgeCount;

        // Sidebar обновляем параллельно — не блокируем toolbar
        _update_sidebar_icon(icon, label, style).catch(() => {});
    } finally {
        _iconLock = false;
        // Подхватываем накопленный вызов
        if (_pendingArgs) {
            const { q, f, m, t } = _pendingArgs;
            _pendingArgs = null;
            Promise.resolve().then(() => _applyIconUpdate(q, f, m, t));
        }
    }
}

export async function print_count(q_count, f_count, m_count, t_count = 0) {
    _set_popup(true);
    _pendingArgs = { q: q_count, f: f_count, m: m_count, t: t_count };

    if (_iconLock) return;
    if (_debounceTimer) return;

    // FIX 2: Дебаунс 16ms — мержит burst-вызовы в один
    _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        if (!_pendingArgs) return;
        const { q, f, m, t } = _pendingArgs;
        _pendingArgs = null;
        _applyIconUpdate(q, f, m, t).catch(e => console.warn('[browser] _applyIconUpdate:', e));
    }, 16);
}

// FIX 5: Управление блинком — вызывается из background.js вместо прямых chrome.action вызовов.
// ON  → блокирует print_count, немедленно ставит !! / красный
// OFF → снимает блок, восстанавливает бейдж из последнего известного состояния
export function setBlinkBadge(active) {
    _blinkActive = active;

    if (active) {
        // Отменяем дебаунс — иначе он затрёт !! через 16ms
        if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
        chrome.action.setBadgeText({ text: '!!' }).catch(() => {});
    } else {
        // Восстанавливаем бейдж без canvas redraw — только текст/цвет
        const count = _prevBadgeCount > 0 ? _prevBadgeCount : 0;
        const label = count > 99 ? '99+' : count > 0 ? String(count) : '';
        chrome.action.setBadgeText({ text: label }).catch(() => {});
        if (label && _prevBadgeStyle) {
            chrome.action.setBadgeBackgroundColor({ color: _prevBadgeStyle.bg }).catch(() => {});
            if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: _prevBadgeStyle.text }).catch(() => {});
        } else if (!label) {
            chrome.action.setBadgeBackgroundColor({ color: '#9e9e9e' }).catch(() => {});
        }
        // Если есть накопленные счётчики — применяем полный редraw
        if (_pendingArgs && !_iconLock) {
            const { q, f, m, t } = _pendingArgs;
            _pendingArgs = null;
            _applyIconUpdate(q, f, m, t).catch(() => {});
        }
    }
}

// FIX 4: Анимация с флагом отмены
async function _animateBadgeCount(from, to, q_count, f_count, m_count, t_count, icon, abortFlag) {
    const steps = Math.min(from - to, 5);
    if (steps <= 1) {
        const { label, style } = _getBadge(q_count, f_count, m_count, t_count);
        await _update_toolbar_icon(icon, label, style);
        return;
    }
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const stepSize = (from - to) / steps;
    const { style } = _getBadge(q_count, f_count, m_count, t_count);
    for (let i = 1; i <= steps; i++) {
        if (abortFlag.cancelled) return;
        const val = Math.round(from - stepSize * i);
        const lbl = val > 0 ? (val > 99 ? '99+' : String(val)) : null;
        await _update_toolbar_icon(icon, lbl, style);
        await delay(80);
    }
    if (abortFlag.cancelled) return;
    const { label } = _getBadge(q_count, f_count, m_count, t_count);
    await _update_toolbar_icon(icon, label, style);
}

export async function open_url(url, set_active = true, do_search = false) {
    const settings = await chrome.storage.local.get(['open_in_current_tab', 'open_new_tab_foreground']);
    const openInCurrentTab     = settings.open_in_current_tab    || false;
    const openNewTabForeground = settings.open_new_tab_foreground || false;

    const focusTab = async (tab) => {
        if (!tab || !tab.id) return tab;
        try {
            await chrome.tabs.update(tab.id, { active: true });
            if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
        } catch (_) {}
        return tab;
    };

    if (do_search) {
        return chrome.tabs.query({ url }).then(async (tabs) => {
            if (tabs.length > 0) {
                const tab = await chrome.tabs.update(tabs[0].id, { active: true });
                if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
                return tab;
            } else {
                return open_url(url, set_active, false);
            }
        });
    }

    if (openInCurrentTab) {
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (currentTab) return chrome.tabs.update(currentTab.id, { url, active: true });
    }

    const shouldActivateNewTab = !!set_active || !!openNewTabForeground;
    const tab = await chrome.tabs.create({ url, active: shouldActivateNewTab });
    return shouldActivateNewTab ? focusTab(tab) : tab;
}
