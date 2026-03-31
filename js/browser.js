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

// Цвета бейджа:
// Избранные (favorites) → белый фон + тёмный текст
// QMS (личные сообщения) → красный
// Упоминания → жёлтый
const BADGE_STYLES = {
    favorites: { bg: '#ffffff', text: '#111111' },   // белый — избранные
    qms:       { bg: '#e53935', text: '#ffffff' },   // красный — QMS
    mentions:  { bg: '#f5c518', text: '#111111' },
}

// Liquid Glass стиль бейджа — для темы liquid-glass
const BADGE_STYLES_GLASS = {
    favorites: { glow: 'rgba(40,180,255,1.0)',  glowDim: 'rgba(40,180,255,0.25)',   glow2: 'rgba(100,210,255,0.90)', text: '#ffffff' },
    qms:       { glow: 'rgba(255,60,160,1.0)',  glowDim: 'rgba(255,60,160,0.28)',   glow2: 'rgba(255,120,200,0.90)', text: '#ffffff' },
    mentions:  { glow: 'rgba(255,200,30,1.0)',  glowDim: 'rgba(255,200,30,0.28)',   glow2: 'rgba(255,230,100,0.90)', text: '#1a1a00' },
}

// Читаем текущую тему из storage (кэш, чтобы не блокировать)
let _cachedTheme = 'light';
chrome.storage.local.get(['theme_mode'], d => { _cachedTheme = d.theme_mode || 'light'; });
chrome.storage.onChanged.addListener(changes => {
    if (changes.theme_mode) _cachedTheme = changes.theme_mode.newValue || 'light';
});

function _set_popup(available) {
    chrome.action.setPopup({ 'popup': available ? 'html/popup.html' : '' });
}

// Определяет стиль бейджа и метку исходя из счётчиков
// Приоритет: qms > mentions > favorites
function _getBadge(q_count, f_count, m_count) {
    const total = (q_count || 0) + (f_count || 0) + (m_count || 0);
    if (total === 0) return { label: null, style: null };

    const label = total > 99 ? '99+' : String(total);
    const key   = q_count ? 'qms' : m_count ? 'mentions' : 'favorites';
    const style = { ...BADGE_STYLES[key], _glassKey: key };

    return { label, style };
}

// Рисует иконку + стильный бейдж на canvas заданного размера
async function _make_badge_icon(iconPath, label, badgeStyle, size) {
    try {
        const resp = await fetch(chrome.runtime.getURL(iconPath));
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);

        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Иконка на весь canvas
        ctx.drawImage(bitmap, 0, 0, size, size);

        if (label && badgeStyle) {
            await _draw_badge_on_ctx(ctx, label, badgeStyle, size);
        }

        return ctx.getImageData(0, 0, size, size);
    } catch (e) {
        console.warn('_make_badge_icon failed:', e);
        return null;
    }
}

// Загружает QMS-иконку из PNG файла
async function _make_qms_icon(size) {
    try {
        // Грузим иконку QMS
        const resp = await fetch(chrome.runtime.getURL('img/icons/icon_48_qms.png'));
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);

        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Рисуем иконку QMS из PNG файла
        ctx.drawImage(bitmap, 0, 0, size, size);

        return ctx.getImageData(0, 0, size, size);
    } catch(e) {
        console.warn('_make_qms_icon failed:', e);
        return null;
    }
}

// Нативный Chrome badge — мгновенный, чёткий
async function _update_toolbar_icon(icon, label, badgeStyle) {
    try {
        const isQms = icon === ACTION_BUTTON_ICONS.has_qms;
        if (isQms) {
            const [d16,d32,d48] = await Promise.all([_make_qms_icon(16),_make_qms_icon(32),_make_qms_icon(48)]);
            if (d16&&d32&&d48) chrome.action.setIcon({imageData:{16:d16,32:d32,48:d48}});
            else chrome.action.setIcon({path:icon});
        } else { chrome.action.setIcon({path:icon}); }
        if (label && badgeStyle) {
            chrome.action.setBadgeText({text:label});
            chrome.action.setBadgeBackgroundColor({color:badgeStyle.bg});
            if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({color:badgeStyle.text});
        } else { chrome.action.setBadgeText({text:''}); }
    } catch(e) { chrome.action.setIcon({path:icon}); chrome.action.setBadgeText({text:''}); }
}

// Накладывает бейдж поверх готового ImageData
async function _overlay_badge_on_imagedata(imageData, label, badgeStyle, size) {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    // Восстанавливаем базовую иконку как ImageBitmap для нормального drawImage
    const baseBitmap = await createImageBitmap(new ImageData(
        new Uint8ClampedArray(imageData.data),
        imageData.width, imageData.height
    ));
    ctx.drawImage(baseBitmap, 0, 0);
    // Рисуем бейдж поверх на том же ctx
    await _draw_badge_on_ctx(ctx, label, badgeStyle, size);
    return ctx.getImageData(0, 0, size, size);
}

// Рисует бейдж прямо на переданный ctx
async function _draw_badge_on_ctx(ctx, label, badgeStyle, size) {
    const isGlass = _cachedTheme === 'liquid-glass';
    const gs = isGlass ? (BADGE_STYLES_GLASS[badgeStyle._glassKey] || BADGE_STYLES_GLASS.qms) : null;

    const isLong = label.length >= 2;
    // Always circular badge — compact, readable
    const baseR = Math.round(size * 0.19);
    const pillPad = 0; // force circle always
    const stroke = Math.max(1.5, Math.round(size * 0.06));
    const cx = size - baseR - 1;
    const cy = baseR + 1;
    const lx = cx;
    const fs = label.length >= 3 ? Math.round(baseR * 0.72) : Math.round(baseR * 0.95);
    const textX = cx;

    function pillPath() {
        ctx.beginPath();
        // Always draw circle
        ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
        if (false) {
            ctx.moveTo(lx, cy - baseR);
            ctx.arcTo(cx + baseR, cy - baseR, cx + baseR, cy, baseR);
            ctx.arcTo(cx + baseR, cy + baseR, lx, cy + baseR, baseR);
            ctx.arcTo(lx - baseR, cy + baseR, lx - baseR, cy, baseR);
            ctx.arcTo(lx - baseR, cy - baseR, lx, cy - baseR, baseR);
            ctx.closePath();
        }
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
        ctx.fillText(label, textX, cy + fs * 0.05); ctx.shadowBlur = 0;
    } else {
        ctx.fillStyle = 'rgba(0,0,0,0.50)';
        ctx.shadowColor = 'rgba(0,0,0,0.50)'; ctx.shadowBlur = stroke + 1;
        pillPath(); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = badgeStyle.bg; pillPath(); ctx.fill();
        ctx.fillStyle = badgeStyle.text;
        ctx.font = `bold ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, textX, cy + fs * 0.05);
    }
}

// Рисует только бейдж на прозрачном canvas (без фоновой иконки)
async function _make_badge_icon_on_blank(label, badgeStyle, size) {
    try {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d');
        await _draw_badge_on_ctx(ctx, label, badgeStyle, size);
        return ctx.getImageData(0, 0, size, size);
    } catch(e) { return null; }
}

// Sidebar Firefox: canvas 64→32 для чёткого бейджа
async function _update_sidebar_icon(icon, label, badgeStyle) {
    if (typeof browser==='undefined'||!browser.sidebarAction) return;
    try {
        const SZ=64, canvas=new OffscreenCanvas(SZ,SZ), ctx=canvas.getContext('2d');
        ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
        const bmp=await createImageBitmap(await (await fetch(chrome.runtime.getURL(icon[48]))).blob());
        ctx.drawImage(bmp,0,0,SZ,SZ);
        if (label&&badgeStyle) {
            const R=Math.round(SZ*0.17),isL=label.length>=2,pp=isL?Math.round(R*0.6):0;
            const cx=SZ-R-1,cy=R+1,lx=isL?Math.max(R+1,cx-pp*2):cx;
            const fs=label.length>=3?Math.round(R*0.75):Math.round(R),tx=isL?(lx+cx)/2:cx;
            function pill(){ctx.beginPath();if(!isL){ctx.arc(cx,cy,R,0,Math.PI*2);}else{ctx.moveTo(lx,cy-R);ctx.arcTo(cx+R,cy-R,cx+R,cy,R);ctx.arcTo(cx+R,cy+R,lx,cy+R,R);ctx.arcTo(lx-R,cy+R,lx-R,cy,R);ctx.arcTo(lx-R,cy-R,lx,cy-R,R);ctx.closePath();}}
            ctx.shadowColor='rgba(0,0,0,0.85)';ctx.shadowBlur=8;ctx.fillStyle=badgeStyle.bg;pill();ctx.fill();ctx.shadowBlur=0;
            ctx.strokeStyle='#fff';ctx.lineWidth=Math.max(4,SZ*0.07);ctx.lineJoin='round';pill();ctx.stroke();
            ctx.fillStyle=badgeStyle.bg;pill();ctx.fill();
            ctx.fillStyle=badgeStyle.text;ctx.font=`bold ${fs}px -apple-system,sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,tx,cy+fs*0.06);
        }
        const out=new OffscreenCanvas(32,32),oc=out.getContext('2d');
        oc.imageSmoothingEnabled=true;oc.imageSmoothingQuality='high';oc.drawImage(canvas,0,0,32,32);
        await browser.sidebarAction.setIcon({imageData:{32:oc.getImageData(0,0,32,32)}});
    } catch(e) { try{await browser.sidebarAction.setIcon({path:icon})}catch(_){} }
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

let _prevBadgeCount = -1;

export async function print_count(q_count, f_count, m_count) {
    _set_popup(true);

    const icon = q_count ? ACTION_BUTTON_ICONS.has_qms : ACTION_BUTTON_ICONS.default;
    const { label, style } = _getBadge(q_count, f_count, m_count);
    const badgeCount = (f_count || 0) + (q_count || 0) + (m_count || 0);

    chrome.action.setTitle({ title: `4PDA - В сети\nНепрочитанных тем: ${f_count}\nНепрочитанных диалогов: ${q_count}\nУпоминаний: ${m_count || 0}` });

    if (_prevBadgeCount > 0 && badgeCount < _prevBadgeCount && badgeCount >= 0) {
        await _animateBadgeCount(_prevBadgeCount, badgeCount, q_count, f_count, m_count, icon);
    } else {
        await _update_toolbar_icon(icon, label, style);
    }
    _prevBadgeCount = badgeCount;

    _update_sidebar_icon(icon, label, style);
}

async function _animateBadgeCount(from, to, q_count, f_count, m_count, icon) {
    const steps = Math.min(from - to, 5);
    if (steps <= 1) {
        const { label, style } = _getBadge(q_count, f_count, m_count);
        await _update_toolbar_icon(icon, label, style);
        return;
    }
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const stepSize = (from - to) / steps;
    const { style } = _getBadge(q_count, f_count, m_count);
    for (let i = 1; i <= steps; i++) {
        const val = Math.round(from - stepSize * i);
        const lbl = val > 0 ? (val > 99 ? '99+' : String(val)) : null;
        await _update_toolbar_icon(icon, lbl, style);
        await delay(80);
    }
    const { label } = _getBadge(q_count, f_count, m_count);
    await _update_toolbar_icon(icon, label, style);
}

export async function open_url(url, set_active = true, do_search = false) {

    const settings = await chrome.storage.local.get(['open_in_current_tab']);
    const openInCurrentTab = settings.open_in_current_tab || false;

    if (do_search) {
        return chrome.tabs.query({ url }).then((tabs) => {
            if (tabs.length > 0) {
                return chrome.tabs.update(tabs[0].id, { highlighted: true });
            } else {
                return open_url(url, set_active, false);
            }
        });
    }

    if (openInCurrentTab) {
        const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (currentTab) {
            return chrome.tabs.update(currentTab.id, { url, active: set_active });
        }
    }

    return chrome.tabs.create({ url, active: set_active });
}
