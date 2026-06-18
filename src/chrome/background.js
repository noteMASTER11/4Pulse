/** @typedef {import('./js/types.js').Settings} Settings */
/** @typedef {import('./js/types.js').DiagnosticsSnapshot} DiagnosticsSnapshot */
/** @typedef {import('./js/types.js').AppState} AppState */
// background.js - Chrome Extension MV3 Service Worker
import {CS, SETTINGS} from './js/cs.js';
import {open_url, setBlinkBadge} from './js/browser.js';
import {getLogDatetime, fetch4} from "./js/utils.js";
import { fetchWithRetry, fetchText } from "./js/fetcher.js";
import {registerWsKeepAlive} from "./js/ws.js";

// 🛡️ Global error handlers
self.addEventListener('unhandledrejection', (event) => {
    console.error('🚨 Unhandled promise rejection:', {
        reason: event.reason,
        promise: event.promise
    });
    event.preventDefault(); // Prevent extension crash
    try { addEventLog('error', 'Unhandled promise rejection', 'error', { reason: String(event.reason?.message || event.reason || '') }); } catch (_) {}
});

self.addEventListener('error', (event) => {
    console.error('🚨 Global error:', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
    });
    try { addEventLog('error', 'Global JS error', 'error', { message: String(event.message || ''), filename: event.filename || '', lineno: event.lineno || 0 }); } catch (_) {}
});


// ──────────────────────────────────────────────────────────────
// 🎵 Radio cookie/CORS guard
// ──────────────────────────────────────────────────────────────
// Firefox warns about third-party cookies like "hssuid" on radio stream hosts.
// 4Pulse does not need cookies for radio streams or radio metadata, so strip them
// for all known stream domains. 4PDA cookies are NOT touched.
const RADIO_COOKIE_GUARD_HOSTS = [
    'hostingradio.ru',
    'radiorecord.hostingradio.ru',
    'rusradio.hostingradio.ru',
    'dfm.hostingradio.ru',
    'dfm-dfmrusdance.hostingradio.ru',
    'maximum.hostingradio.ru',
    'nashe1.hostingradio.ru',
    'nrj-nrjkaz.hostingradio.ru',
    'chanson.hostingradio.ru',
    'ep256.hostingradio.ru',
    'retro.hostingradio.ru',
    'rs.kartina.tv',
    'kartina.tv',
    'icecast-vgtrk.cdnvideo.ru',
    'icecast.luxfm.kz',
    'icecast.ns.kz',
    'online.hitfm.ua',
    'online.kissfm.ua',
    'online.radioroks.ua',
];

const RADIO_COOKIE_GUARD_URLS = [...new Set(
    RADIO_COOKIE_GUARD_HOSTS.flatMap(host => [`*://${host}/*`, `*://*.${host}/*`])
)];

function isRadioCookieGuardUrl(url = '') {
    try {
        const host = new URL(String(url)).hostname.toLowerCase();
        return RADIO_COOKIE_GUARD_HOSTS.some(h => host === h || host.endsWith('.' + h));
    } catch (_) {
        return false;
    }
}

function registerRadioCookieGuard() {
    // Chrome MV3 package uses declarativeNetRequest rules instead of webRequestBlocking.
    if (chrome.declarativeNetRequest) return;
    try {
        if (!chrome.webRequest?.onBeforeSendHeaders || !chrome.webRequest?.onHeadersReceived) return;
        if (globalThis.__4pulseRadioCookieGuardRegistered) return;
        globalThis.__4pulseRadioCookieGuardRegistered = true;

        chrome.webRequest.onBeforeSendHeaders.addListener(
            details => {
                if (!isRadioCookieGuardUrl(details.url)) return {};
                const requestHeaders = (details.requestHeaders || []).filter(h => {
                    const name = String(h.name || '').toLowerCase();
                    return name !== 'cookie' && name !== 'authorization';
                });
                return { requestHeaders };
            },
            { urls: RADIO_COOKIE_GUARD_URLS },
            ['blocking', 'requestHeaders']
        );

        chrome.webRequest.onHeadersReceived.addListener(
            details => {
                if (!isRadioCookieGuardUrl(details.url)) return {};
                const responseHeaders = (details.responseHeaders || []).filter(h => {
                    const name = String(h.name || '').toLowerCase();
                    return name !== 'set-cookie' && name !== 'set-cookie2';
                });
                return { responseHeaders };
            },
            { urls: RADIO_COOKIE_GUARD_URLS },
            ['blocking', 'responseHeaders']
        );
    } catch (e) {
        try { console.warn('[Radio] cookie guard unavailable:', e?.message || e); } catch (_) {}
    }
}

registerRadioCookieGuard();

const ALARM_NAME = 'periodicUpdate';
const RADIO_KEEPALIVE_ALARM = 'radioKeepalive'; // ★ FIX: держит аудио живым при выгрузке фона
const TICKET_QUICK_POLL_ALARM = 'ticketQuickPoll'; // Быстрая сверка тикетов без ожидания общего polling
/**
 * Интервал HTTP-polling когда WS подключён (минуты).
 * Только редкая сверка состояния — на случай пропущенного push при реконнекте.
 */
const WS_FALLBACK_INTERVAL_MIN = 15;
const bg = new CS();

const DEBUG = () => globalThis.__FOURPULSE_DEBUG__ === true;
function debugLog(...args) { if (DEBUG()) console.log(...args); }
function debugWarn(...args) { if (DEBUG()) console.warn(...args); }


function normalize4pdaForumUrl(url) {
    if (!url) return '';
    url = String(url).trim().replace(/&amp;/g, '&');
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return 'https://4pda.to' + url;
    if (/^https?:\/\//i.test(url)) return url;
    return 'https://4pda.to/forum/' + url.replace(/^\.\//, '');
}

function directPostFromHref(href) {
    const url = normalize4pdaForumUrl(href);
    if (!url) return null;
    const m = url.match(/(?:[?&](?:p|pid)=|#entry)(\d{5,})/i);
    if (!m) return null;
    const postId = m[1];
    return {
        post_id: postId,
        post_url: `https://4pda.to/forum/index.php?act=findpost&pid=${postId}`
    };
}

function resolveFavoritePreviewFromFavHtml(html, topicId) {
    const tid = String(topicId || '').replace(/\D+/g, '');
    if (!tid || !html) return null;
    const rows = String(html).split(/<tr\b/i).map((part, i) => i ? '<tr' + part : part);
    let row = rows.find(r => new RegExp(`showtopic=${tid}(?:\\D|$)`, 'i').test(r));
    if (!row) {
        const idx = String(html).search(new RegExp(`showtopic=${tid}(?:\\D|$)`, 'i'));
        if (idx < 0) return null;
        row = String(html).slice(Math.max(0, idx - 5000), Math.min(String(html).length, idx + 8000));
    }

    const hrefs = [];
    row.replace(/href=["']([^"']+)["']/gi, (_, href) => { hrefs.push(href.replace(/&amp;/g, '&')); return ''; });

    // Сначала берём прямые ссылки на конкретный пост. getnewpost намеренно игнорируем.
    for (const href of hrefs) {
        if (/view=getnewpost/i.test(href)) continue;
        if (/(?:act=findpost|view=findpost|showpost(?:\.php)?|#entry|[?&]p=|[?&]pid=)/i.test(href)) {
            const direct = directPostFromHref(href);
            if (direct) return direct;
        }
    }

    // Иногда прямой pid лежит не в href, а рядом в html-фрагменте.
    const m = row.match(/(?:act=findpost[^"'<>]*?pid=|view=findpost[^"'<>]*?[?&]p=|#entry)(\d{5,})/i);
    if (m) return { post_id: m[1], post_url: `https://4pda.to/forum/index.php?act=findpost&pid=${m[1]}` };

    return null;
}



// ════════════════════════════════════════════════════════
// 🩺 4Pulse Health & Event Log
// ════════════════════════════════════════════════════════
const EVENT_LOG_LIMIT = 80;
let eventLogBuffer = [];
let eventLogClearedAt = 0;
let lastUpdateStartedAt = 0;
let lastUpdateFinishedAt = 0;
let lastUpdateOk = false;
let lastUpdateError = '';

function addEventLog(type, message, level = 'info', details = {}) {
    try {
        const item = {
            ts: Date.now(),
            type: String(type || 'event'),
            level: String(level || 'info'),
            message: String(message || ''),
            details: details && typeof details === 'object' ? details : {}
        };
        if (eventLogClearedAt && item.ts <= eventLogClearedAt) return;
        eventLogBuffer = eventLogBuffer.filter(ev => !eventLogClearedAt || (ev.ts || 0) > eventLogClearedAt);
        eventLogBuffer.unshift(item);
        if (eventLogBuffer.length > EVENT_LOG_LIMIT) eventLogBuffer.length = EVENT_LOG_LIMIT;
        chrome.storage.local.set({ event_log_cache: eventLogBuffer, event_log_cleared_at: eventLogClearedAt }).catch(()=>{});
    } catch (_) {}
}

async function loadEventLog() {
    try {
        const s = await chrome.storage.local.get(['event_log_cache', 'event_log_cleared_at']);
        eventLogClearedAt = Number(s.event_log_cleared_at || 0);
        const rawLog = Array.isArray(s.event_log_cache) ? s.event_log_cache : [];
        eventLogBuffer = rawLog.filter(ev => !eventLogClearedAt || (ev.ts || 0) > eventLogClearedAt).slice(0, EVENT_LOG_LIMIT);
    } catch (_) { eventLogBuffer = []; }
}

async function clearEventLog() {
    eventLogClearedAt = Date.now();
    eventLogBuffer = [];
    await chrome.storage.local.set({ event_log_cache: [], event_log_cleared_at: eventLogClearedAt });
    return { ok: true, clearedAt: eventLogClearedAt };
}

function buildSmartInsights(snapshot) {
    const insights = [];
    const counts = snapshot.counts || {};
    const health = snapshot.health || {};
    const bookmarks = snapshot.bookmarks || {};
    const radio = snapshot.radio || {};
    const total = (counts.qms || 0) + (counts.favorites || 0) + (counts.mentions || 0) + (counts.tickets || 0);

    if (!snapshot.authorized) insights.push({ level: 'danger', title: 'Нет входа на 4PDA', text: 'Расширение не сможет получить QMS, избранное, тикеты и закладки, пока cookie авторизации недоступны.', action: 'Открой 4PDA и войди в аккаунт.', target: 'auth' });
    if (!snapshot.wsConnected) insights.push({ level: 'warning', title: 'WebSocket offline', text: 'Realtime-события могут приходить с задержкой. Расширение будет опираться на polling.', action: 'Нажми «Починить 4Pulse» или перезапусти расширение.' });
    if (health.polling && !health.polling.exists) insights.push({ level: 'danger', title: 'Polling alarm не найден', text: 'Фоновая проверка может не запускаться автоматически.', action: 'Нажми «Починить 4Pulse» — alarm будет создан заново.' });
    if (health.polling && health.polling.is429Active) insights.push({ level: 'warning', title: 'Активна защита 429', text: '4PDA недавно ограничивал частоту запросов. Расширение специально замедляет проверки.', action: 'Не ставь слишком маленький интервал обновления.' });
    if (bookmarks.enabled && !bookmarks.loaded) insights.push({ level: 'warning', title: 'Закладки не загружены', text: 'Вкладка закладок включена, но в памяти расширения сейчас нет данных.', action: 'Запусти принудительное обновление или проверь WebSocket.' });
    if (snapshot.settings?.tickets_enabled && (counts.tickets || 0) > 0) insights.push({ level: 'hot', title: 'Есть тикеты', text: 'Найдено тикетов: ' + counts.tickets + '.', action: 'Открой раздел тикетов.', target: 'tickets' });
    if ((counts.qms || 0) > 0) insights.push({ level: 'info', title: 'Есть новые QMS', text: 'Новых диалогов/сообщений: ' + counts.qms + '.', action: 'Проверь личные сообщения.', target: 'qms' });
    if (total === 0 && snapshot.authorized && snapshot.wsConnected && (!health.issues || !health.issues.length)) insights.push({ level: 'ok', title: 'Всё спокойно', text: 'Критичных событий нет, авторизация и WebSocket выглядят нормально.', action: 'Можно оставить расширение работать в фоне.' });
    if (radio.enabled && radio.lastError) insights.push({ level: 'warning', title: 'Ошибка радио', text: radio.lastError, action: 'Смени станцию или перезапусти радио.', target: 'radio' });

    return insights.slice(0, 8);
}

// 🧱 4Pulse 2.0 Foundation helpers
const FOUNDATION_BACKUP_KEYS = [
  'notification_qms_level','notification_themes_level','notification_mentions_level','notification_tickets_level',
  'toolbar_button_open_all','toolbar_button_pinned','toolbar_button_read_all','toolbar_simple_list','toolbar_default_view',
  'show_all_favorites','show_all_qms','show_all_mentions','open_themes_limit','open_in_current_tab','open_new_tab_foreground',
  'bw_icons','mirror_mode','accent_color','theme_mode','compact_mode','show_bookmarks_tab','primary_click_action',
  'compact_stats','compact_hide_qms','compact_hide_favorites','compact_hide_mentions','compact_only_stats','compact_show_topics','show_fav_toolbar','show_topic_action_buttons',
  'popup_width','popup_width_auto','max_visible_topics','sound_qms','sound_themes','sound_mentions','sound_tickets','sound_volume',
  'dnd_enabled','dnd_from','dnd_to','dnd_days','dnd_allow_mentions','dnd_allow_qms','dnd_allow_tickets','dnd_mute_radio',
  'tickets_enabled','tickets_unlocked','radio_enabled','radio_volume','icon_pack','disable_topic_animations',
  'attention_center_enabled','attention_center_mode','user_profile_mode','stable_mode','silent_doctor_enabled','auto_backup_enabled'
];

async function foundationCreateBackup(manual = false) {
  const data = await chrome.storage.local.get(FOUNDATION_BACKUP_KEYS);
  const backup = { id: 'backup_' + Date.now(), created_at: Date.now(), manual: !!manual, version: chrome.runtime.getManifest().version, data };
  const old = await chrome.storage.local.get(['foundation_backups']);
  const backups = Array.isArray(old.foundation_backups) ? old.foundation_backups : [];
  backups.unshift(backup);
  await chrome.storage.local.set({ foundation_backups: backups.slice(0, 3), foundation_last_backup_at: backup.created_at });
  addEventLog('backup', manual ? 'Создана ручная резервная копия настроек' : 'Создана автокопия настроек', 'info', { id: backup.id });
  return { ok:true, backup };
}

async function foundationRestoreLatestBackup() {
  const old = await chrome.storage.local.get(['foundation_backups']);
  const backup = Array.isArray(old.foundation_backups) ? old.foundation_backups[0] : null;
  if (!backup || !backup.data) return { ok:false, error:'Резервные копии не найдены' };
  await chrome.storage.local.set(backup.data);
  await syncSettingsFromStorage();
  initializeAlarm();
  addEventLog('backup', 'Восстановлена резервная копия настроек', 'info', { id: backup.id });
  return { ok:true, backup };
}

async function foundationApplyProfile(profile) {
  const current = await chrome.storage.local.get(['tickets_unlocked', 'tickets_enabled']);
  const ticketsAllowed = !!current.tickets_unlocked;
  const profiles = {
    standard: { title:'Обычный пользователь', values:{ user_profile_mode:'standard', stable_mode:false, tickets_enabled:false, attention_center_enabled:false, compact_stats:false, compact_only_stats:false, compact_show_topics:true, show_fav_toolbar:true, show_topic_action_buttons:true, toolbar_button_open_all:true, toolbar_button_pinned:true, toolbar_button_read_all:true, radio_enabled:false, show_bookmarks_tab:true, primary_click_action:'forum', popup_width_auto:false, dnd_allow_tickets:false } },
    // Профиль не разблокирует закрытые функции. Тикеты появляются только после отдельной разблокировки доступа.
    moderator: { title:'Куратор / Модератор', values:{ user_profile_mode:'moderator', stable_mode:false, tickets_enabled:ticketsAllowed, attention_center_enabled:false, compact_stats:false, compact_only_stats:false, compact_show_topics:true, show_fav_toolbar:true, show_topic_action_buttons:true, toolbar_button_open_all:true, toolbar_button_pinned:true, toolbar_button_read_all:true, radio_enabled:false, show_bookmarks_tab:true, primary_click_action:'popup', popup_width_auto:false, notification_tickets_level:ticketsAllowed ? 20 : 0, dnd_allow_tickets:ticketsAllowed } },
    minimal: { title:'Минимализм', values:{ user_profile_mode:'minimal', stable_mode:true, attention_center_enabled:false, compact_stats:true, compact_only_stats:true, compact_show_topics:true, toolbar_default_view:'collapsed', primary_click_action:'popup', show_fav_toolbar:false, show_topic_action_buttons:false, toolbar_button_open_all:false, toolbar_button_pinned:false, toolbar_button_read_all:false, radio_enabled:false, show_bookmarks_tab:false, tickets_enabled:false, popup_width_auto:false, dnd_allow_tickets:false } },
    radio: { title:'Радио', values:{ user_profile_mode:'radio', stable_mode:false, attention_center_enabled:false, compact_stats:false, compact_only_stats:false, compact_show_topics:true, show_fav_toolbar:true, show_topic_action_buttons:true, toolbar_button_open_all:true, toolbar_button_pinned:true, toolbar_button_read_all:true, radio_enabled:true, show_bookmarks_tab:true, popup_width_auto:false, dnd_allow_tickets:false } }
  };
  const cfg = profiles[profile] || profiles.standard;
  await foundationCreateBackup(false).catch(()=>{});
  await chrome.storage.local.set(cfg.values);
  Object.entries(cfg.values).forEach(([k,v]) => { if (k in SETTINGS) SETTINGS[k] = v; });
  if (cfg.values.radio_enabled === false) { try { await radioPause(); } catch(_){} }
  initializeAlarm();
  await createContextMenus().catch(()=>{});
  const note = (profile === 'moderator' && !ticketsAllowed) ? 'Доступ к тикетам не разблокирован, поэтому тикеты скрыты.' : '';
  addEventLog('profile', 'Применён профиль 4Pulse: ' + cfg.title + (note ? ' ' + note : ''), 'info', { profile, ticketsAllowed });
  return { ok:true, profile, title: cfg.title, values: cfg.values, ticketsAllowed, notice: note };
}


async function foundationRunDoctor(auto = false) {
  const actions = [];
  const st = await chrome.storage.local.get(['silent_doctor_enabled','auto_backup_enabled','foundation_last_backup_at','is_429_active','backoff_until']);
  if (auto && st.silent_doctor_enabled === false) return { ok:true, actions:['disabled'] };
  const alarm = await chrome.alarms.get(ALARM_NAME).catch(()=>null);
  if (!alarm) { initializeAlarm(); actions.push('polling восстановлен'); }
  const wsAlarm = await chrome.alarms.get('4pulse_ws_keepalive').catch(()=>null);
  if (!wsAlarm) { registerWsKeepAlive(); actions.push('ws keep-alive восстановлен'); }
  if (bg && !bg.wsConnected) { try { bg.update(false); actions.push('мягкий update запущен'); } catch(_){} }
  if (st.is_429_active && st.backoff_until && Date.now() > Number(st.backoff_until)) {
    await chrome.storage.local.set({ is_429_active:false, backoff_multiplier:1, backoff_until:0 });
    actions.push('устаревший 429 сброшен');
  }
  const lastBackup = Number(st.foundation_last_backup_at || 0);
  if (st.auto_backup_enabled !== false && Date.now() - lastBackup > 7*24*60*60*1000) {
    await foundationCreateBackup(false).catch(()=>{}); actions.push('создана автокопия');
  }
  if (!actions.length) actions.push('проблем не найдено');
  if (!auto) addEventLog('doctor', 'Тихий доктор выполнен вручную', 'info', { actions });
  return { ok:true, actions };
}

async function runSelfHeal() {
    addEventLog('repair', 'Запущено самовосстановление 4Pulse', 'info');
    await chrome.storage.local.set({ backoff_multiplier: 1, is_429_active: false, backoff_until: 0, auto_mode_active: true });
    try { registerWsKeepAlive(); } catch (_) {}
    try { await initializeAlarm(); } catch (_) {}
    try { await bg.update(true); } catch (e) {
        addEventLog('repair', 'Самовосстановление: обновление завершилось ошибкой', 'error', { error: String(e?.message || e) });
    }
    addEventLog('repair', 'Самовосстановление завершено', 'ok');
    return getDiagnosticsSnapshot();
}

function wrapUpdateWithHealthLog() {
    if (!bg || typeof bg.update !== 'function' || bg.__healthWrapped) return;
    const originalUpdate = bg.update.bind(bg);
    bg.update = async function(force = false) {
        lastUpdateStartedAt = Date.now();
        addEventLog('update', force ? 'Запущено принудительное обновление' : 'Запущено фоновое обновление', 'info', { force: !!force });
        try {
            const result = await originalUpdate(force);
            lastUpdateFinishedAt = Date.now();
            lastUpdateOk = true;
            lastUpdateError = '';
            addEventLog('update', 'Обновление завершено', 'ok', {
                qms: bg.qms?.count || 0,
                favorites: bg.favorites?.count || 0,
                mentions: bg.mentions?.count || 0,
                tickets: bg.tickets?.count || 0,
                ms: lastUpdateFinishedAt - lastUpdateStartedAt
            });
            return result;
        } catch (e) {
            lastUpdateFinishedAt = Date.now();
            lastUpdateOk = false;
            lastUpdateError = String(e?.message || e || 'unknown');
            addEventLog('update', 'Ошибка обновления', 'error', { error: lastUpdateError });
            throw e;
        }
    };
    bg.__healthWrapped = true;
}

loadEventLog().then(() => addEventLog('system', 'Background запущен', 'info', { version: chrome.runtime.getManifest()?.version || '' })).catch(()=>{});
wrapUpdateWithHealthLog();

// 🔊 Audio cache for better performance
const audioCache = {};

// ════════════════════════════════════════════════════════
// 🎵 RADIO — persistent audio player in background
// ════════════════════════════════════════════════════════
let radioState = {
    enabled:      false,
    isPlaying:    false,
    station:      '',
    stationName:  '',
    volume:       0.7,
    lastError:    '',  // ★ FIX: сохраняем последнюю ошибку для отображения в UI
    currentTrack: '',  // 🎵 ICY StreamTitle — "Artist - Title"
    trackArt:     '',  // 🖼 album art URL (iTunes)
    trackStationKey: '', // station key that owns currentTrack/trackArt
    sleepEndsAt:  0,   // ⏱ timestamp таймера сна (0 = выкл)
};
let _icyPollTimer = null;
let _metaInitTimer = null; // ★ OPT: ref для первого опроса метаданных
let _sleepTimerId = null;
let _radioReconnectTimer = null;
let _radioReconnectInProgress = false;
let _radioReconnectAttempts = 0;
let _radioMetaSeq = 0; // guards against stale metadata from previous station

async function loadRadioState() {
    try {
        const s = await chrome.storage.local.get([
            'radio_enabled','radio_playing','radio_station','radio_station_name','radio_volume','radio_last_error'
        ]);
        radioState.enabled      = s.radio_enabled     ?? false;
        radioState.isPlaying    = s.radio_playing      ?? false;
        radioState.station      = s.radio_station      ?? '';
        radioState.stationName  = s.radio_station_name ?? '';
        radioState.volume       = s.radio_volume       !== undefined ? s.radio_volume / 100 : 0.7;
        radioState.lastError    = s.radio_last_error   ?? '';
    } catch(e) { console.error('Radio loadState:', e); }
}

async function saveRadioState() {
    try {
        await chrome.storage.local.set({
            radio_enabled:       radioState.enabled,
            radio_playing:       radioState.isPlaying,
            radio_station:       radioState.station,
            radio_station_name:  radioState.stationName,
            radio_volume:        Math.round(radioState.volume * 100),
            radio_last_error:    radioState.lastError || '',
        });
    } catch(e) {}
}


function clearRadioReconnect() {
    if (_radioReconnectTimer) {
        clearTimeout(_radioReconnectTimer);
        _radioReconnectTimer = null;
    }
    _radioReconnectInProgress = false;
}

function scheduleRadioReconnect(reason = 'stream interrupted', delayMs = 2500) {
    if (!radioState.enabled || !radioState.station || !radioState.isPlaying) return;
    if (_radioReconnectTimer || _radioReconnectInProgress) return;

    _radioReconnectAttempts = Math.min(_radioReconnectAttempts + 1, 8);
    const backoff = Math.min(delayMs * _radioReconnectAttempts, 30000);
    radioState.lastError = `Восстанавливаю радио: ${reason}`;
    debugWarn('[Radio] reconnect scheduled:', reason, `in ${backoff}ms`);
    broadcastRadioState();

    _radioReconnectTimer = setTimeout(async () => {
        _radioReconnectTimer = null;
        if (!radioState.enabled || !radioState.station || !radioState.isPlaying) return;
        _radioReconnectInProgress = true;
        try {
            await radioPlay();
        } catch(e) {
            debugWarn('[Radio] reconnect failed:', e?.message || e);
            _radioReconnectInProgress = false;
            if (radioState.enabled && radioState.station && radioState.isPlaying) {
                scheduleRadioReconnect('повторная попытка', 4000);
            }
        }
    }, backoff);
}

// Chrome MV3 service workers do not have DOM Audio.
// Use an offscreen document for stable radio playback; background owns state/metadata.
const OFFSCREEN_DOCUMENT_PATH = 'html/offscreen.html';
let _creatingOffscreenDocument = null;

async function hasOffscreenDocument() {
    try {
        if (!chrome.offscreen) return false;
        if (chrome.runtime.getContexts) {
            const contexts = await chrome.runtime.getContexts({
                contextTypes: ['OFFSCREEN_DOCUMENT'],
                documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
            });
            return contexts.length > 0;
        }
        return false;
    } catch (_) {
        return false;
    }
}

async function ensureRadioOffscreenDocument() {
    if (!chrome.offscreen) throw new Error('Chrome Offscreen API is unavailable');
    if (await hasOffscreenDocument()) return;
    if (_creatingOffscreenDocument) {
        await _creatingOffscreenDocument;
        return;
    }
    _creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['AUDIO_PLAYBACK'],
        justification: '4Pulse uses an offscreen document to play the built-in radio in Chrome Manifest V3.'
    }).finally(() => { _creatingOffscreenDocument = null; });
    await _creatingOffscreenDocument;
}

async function sendRadioOffscreenCommand(command) {
    await ensureRadioOffscreenDocument();
    return await chrome.runtime.sendMessage({ action: 'radio_offscreen_command', ...command });
}

async function closeRadioOffscreenIfIdle() {
    try {
        if (chrome.offscreen && await hasOffscreenDocument()) {
            await chrome.offscreen.closeDocument();
        }
    } catch (_) {}
}


async function radioPlay(stationUrl, stationName) {
    if (stationUrl) {
        const nextStation = stationUrl;
        const nextName = stationName || '';
        const stationChanged = nextStation !== radioState.station || nextName !== radioState.stationName;
        clearRadioReconnect();
        _radioReconnectAttempts = 0;
        radioState.station = nextStation;
        radioState.stationName = nextName;
        if (stationChanged) {
            _radioMetaSeq++;
            stopIcyPolling();
            clearRadioMetadata('station changed');
            radioState.lastError = '';
            broadcastRadioState();
        }
    }
    if (!radioState.station) return;

    try {
        const result = await sendRadioOffscreenCommand({
            cmd: 'play',
            station: radioState.station,
            stationName: radioState.stationName,
            volume: Math.round(radioState.volume * 100)
        });
        radioState.isPlaying = !!result?.isPlaying;
        radioState.lastError = result?.lastError || '';
        if (radioState.isPlaying) {
            clearRadioReconnect();
            _radioReconnectAttempts = 0;
            startRadioKeepalive();
            startIcyPolling();
            addEventLog('radio', 'Радио воспроизводится', 'ok', { station: radioState.stationName || radioState.station });
        }
    } catch (e) {
        radioState.isPlaying = false;
        radioState.lastError = e?.message || 'Радио недоступно в Chrome';
        addEventLog('radio', radioState.lastError, 'error', { station: radioState.stationName || radioState.station });
    }

    await saveRadioState();
    broadcastRadioState();
}

async function radioPause() {
    clearRadioReconnect();
    try { await sendRadioOffscreenCommand({ cmd: 'pause' }); } catch (_) {}
    radioState.isPlaying = false;
    stopRadioKeepalive();
    stopIcyPolling();
    await saveRadioState();
    broadcastRadioState();
    await closeRadioOffscreenIfIdle();
}

async function radioSetVolume(pct) {
    radioState.volume = Math.max(0, Math.min(1, pct / 100));
    try { await sendRadioOffscreenCommand({ cmd: 'volume', volume: Math.round(radioState.volume * 100) }); } catch (_) {}
    await saveRadioState();
}


// ★ OPT: debounce radio state broadcasts — batches multiple calls in one tick.
let _broadcastPending = false;
function broadcastRadioState() {
    if (_broadcastPending) return;
    _broadcastPending = true;
    queueMicrotask(() => {
        _broadcastPending = false;
        chrome.runtime.sendMessage({ action: 'radio_state', state: getRadioPublicState() }).catch(() => {});
    });
}

function getRadioPublicState() {
    const safeTrack = getSafeRadioTrack();
    return {
        enabled:     radioState.enabled,
        isPlaying:   radioState.isPlaying,
        station:     radioState.station,
        stationName: radioState.stationName,
        volume:      Math.round(radioState.volume * 100),
        lastError:   radioState.lastError || '',
        currentTrack: safeTrack.currentTrack,
        trackArt:    safeTrack.trackArt,
        sleepEndsAt: radioState.sleepEndsAt || 0,
    };
}

// ════════════════════════════════════════════════════════
// 🎵 RADIO METADATA — CORS-safe provider APIs first
// ════════════════════════════════════════════════════════
let _radioRecordStationsCache = null;
let _radioRecordStationsCacheTs = 0;

function normalizeRadioUrl(url = '') {
    return String(url || '')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/^www\./i, '')
        .replace(/[?#].*$/, '')
        .replace(/\/+$/, '')
        .toLowerCase();
}


function getRadioStationKey(url = radioState.station, name = radioState.stationName) {
    const u = normalizeRadioUrl(url);
    const n = String(name || '').trim().toLowerCase();
    return `${u}|${n}`;
}

function clearRadioMetadata(reason = '') {
    radioState.currentTrack = '';
    radioState.trackArt = '';
    radioState.trackStationKey = '';
}

function setRadioMetadataForCurrentStation(title = '', art = '') {
    const cleanTitle = String(title || '').trim();
    const cleanArt = String(art || '').trim();
    if (!cleanTitle) {
        clearRadioMetadata('empty');
        return false;
    }
    radioState.currentTrack = cleanTitle;
    radioState.trackArt = cleanArt;
    radioState.trackStationKey = getRadioStationKey();
    return true;
}

function getSafeRadioTrack() {
    const key = getRadioStationKey();
    if (!radioState.trackStationKey || radioState.trackStationKey !== key) return { currentTrack: '', trackArt: '' };
    return {
        currentTrack: radioState.currentTrack || '',
        trackArt: radioState.trackArt || '',
    };
}

function isRadioRecordStream(url = '') {
    const u = String(url || '').toLowerCase();
    return u.includes('radiorecord') || u.includes('hostingradio.ru/rr_') || u.includes('/rr_');
}

function canPollIcyMetadata(url = '') {
    // Direct ICY fetch uses the Icy-MetaData header and usually triggers CORS/preflight.
    // Keep it opt-in only; known stations should use provider APIs instead.
    const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; } })();
    const safeHosts = new Set([
        // Add hosts here only after confirming they return CORS headers for Icy-MetaData.
    ]);
    return safeHosts.has(host);
}

function canFetchRadioMetadata(url = '') {
    return isRadioRecordStream(url) || canPollIcyMetadata(url);
}

async function fetchRadioRecordStations() {
    if (_radioRecordStationsCache && Date.now() - _radioRecordStationsCacheTs < 6 * 60 * 60 * 1000) {
        return _radioRecordStationsCache;
    }
    try {
        const r = await fetch('https://www.radiorecord.ru/api/stations/', {
            credentials: 'omit',
            cache: 'no-store',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return _radioRecordStationsCache || [];
        const d = await r.json();
        const stations = d?.result?.stations || d?.stations || [];
        if (Array.isArray(stations) && stations.length) {
            _radioRecordStationsCache = stations;
            _radioRecordStationsCacheTs = Date.now();
        }
        return _radioRecordStationsCache || [];
    } catch (_) {
        return _radioRecordStationsCache || [];
    }
}

function normalizeRadioRecordImage(url = '') {
    const u = String(url || '').trim();
    if (!u) return '';
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return 'https://www.radiorecord.ru' + u;
    return u;
}

function matchRadioRecordStation(stations, stationUrl = '', stationName = '') {
    const target = normalizeRadioUrl(stationUrl);
    if (!target) return null;

    const byUrl = stations.find(st => [st.stream_64, st.stream_128, st.stream_320, st.stream_hls]
        .filter(Boolean)
        .some(u => {
            const n = normalizeRadioUrl(u);
            return n && (n === target || n.includes(target) || target.includes(n));
        }));
    if (byUrl) return byUrl;

    const rr = target.match(/rr_([a-z0-9_\-]+?)(?:\d+)?\.(?:aacp?|mp3|ogg|m3u8)$/i);
    const prefix = rr?.[1]?.replace(/_$/, '');
    if (prefix) {
        const byPrefix = stations.find(st => String(st.prefix || '').toLowerCase() === prefix.toLowerCase());
        if (byPrefix) return byPrefix;
    }

    const name = String(stationName || '').toLowerCase().replace(/^.*?радио\s*/i, '').replace(/^radio\s*/i, '').trim();
    if (name) {
        return stations.find(st => String(st.title || '').toLowerCase().includes(name) || name.includes(String(st.title || '').toLowerCase())) || null;
    }
    return null;
}

async function fetchRadioRecordMetadata(stationUrl, stationName) {
    const stations = await fetchRadioRecordStations();
    const station = matchRadioRecordStation(stations, stationUrl, stationName);
    if (!station?.id) return null;

    try {
        const r = await fetch(`https://www.radiorecord.ru/api/station/history/?id=${encodeURIComponent(station.id)}`, {
            credentials: 'omit',
            cache: 'no-store',
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return null;
        const d = await r.json();
        const track = d?.result?.history?.[0] || d?.history?.[0];
        if (!track) return null;
        const artist = String(track.artist || '').trim();
        const song = String(track.song || track.title || '').trim();
        const title = artist && song ? `${artist} - ${song}` : (song || artist);
        const art = normalizeRadioRecordImage(track.image600 || track.image500 || track.image300 || track.image200 || track.image100 || '');
        return title ? { title, art } : null;
    } catch (_) {
        return null;
    }
}

async function fetchIcyMetadata(url) {
    if (!canPollIcyMetadata(url)) return null;
    try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, {
            headers: { 'Icy-MetaData': '1' },
            signal: ctrl.signal,
        });
        clearTimeout(to);
        const metaint = parseInt(res.headers.get('icy-metaint') || '0');
        if (!metaint) return null;

        const reader = res.body.getReader();
        let buf = new Uint8Array(0);
        while (buf.length < metaint + 513) {
            const { done, value } = await reader.read();
            if (done) break;
            const tmp = new Uint8Array(buf.length + value.length);
            tmp.set(buf); tmp.set(value, buf.length); buf = tmp;
        }
        reader.cancel().catch(() => {});

        if (buf.length <= metaint) return null;
        const metaLen = buf[metaint] * 16;
        if (!metaLen) return null;
        const meta = new TextDecoder().decode(buf.slice(metaint + 1, metaint + 1 + metaLen));
        const match = meta.match(/StreamTitle='([^']*)'/);
        const title = match ? match[1].trim() : null;
        return title ? { title, art: '' } : null;
    } catch(e) { return null; }
}

async function fetchRadioMetadata(url, stationName) {
    if (isRadioRecordStream(url)) {
        const rr = await fetchRadioRecordMetadata(url, stationName);
        if (rr) return rr;
    }
    return await fetchIcyMetadata(url);
}

// 🖼 ALBUM ART — пробуем несколько источников по очереди
// ★ OPT: Кеш обложек треков — исключает повторные запросы к iTunes/MusicBrainz
const _artCache = new Map(); // key(title) → url
const _ART_CACHE_MAX = 120;

async function fetchTrackArt(trackTitle) {
    if (!trackTitle) return '';

    // Проверяем кеш
    const cacheKey = trackTitle.trim().toLowerCase();
    if (_artCache.has(cacheKey)) return _artCache.get(cacheKey);

    // Пробуем разбить по ' - ' (Artist - Title), иначе ищем по всему заголовку
    const hasDash = trackTitle.includes(' - ');
    const [artist, track] = hasDash
        ? trackTitle.split(' - ').map(s => s.trim())
        : ['', trackTitle.trim()];

    // 1️⃣ iTunes Search API — хорошо для зарубежной музыки
    try {
        const q = encodeURIComponent(hasDash ? `${artist} ${track}` : trackTitle);
        const r = await fetch(
            `https://itunes.apple.com/search?term=${q}&entity=song&limit=1`,
            { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) }
        );
        const d = await r.json();
        const art = d?.results?.[0]?.artworkUrl100;
        if (art) { const artUrl = art.replace('100x100bb', '600x600bb'); _artCache.set(cacheKey, artUrl); if (_artCache.size > _ART_CACHE_MAX) _artCache.delete(_artCache.keys().next().value); return artUrl; }
    } catch(e) {}

    // 2️⃣ MusicBrainz + Cover Art Archive — работает для кириллицы
    if (hasDash) {
        try {
            const mbQ = encodeURIComponent(`recording:"${track}" AND artist:"${artist}"`);
            const mbR = await fetch(
                `https://musicbrainz.org/ws/2/recording?query=${mbQ}&limit=1&fmt=json`,
                { credentials: 'omit', cache: 'no-store', headers: { 'User-Agent': '4Pulse/1.0 (firefox-extension)' },
                  signal: AbortSignal.timeout(5000) }
            );
            const mbD = await mbR.json();
            const releaseId = mbD?.recordings?.[0]?.releases?.[0]?.id;
            if (releaseId) {
                const caR = await fetch(
                    `https://coverartarchive.org/release/${releaseId}/front-250`,
                    { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) }
                );
                if (caR.ok) { const artUrl = caR.url; _artCache.set(cacheKey, artUrl); if (_artCache.size > _ART_CACHE_MAX) _artCache.delete(_artCache.keys().next().value); return artUrl; }
            }
        } catch(e) {}
    }

    _artCache.set(cacheKey, '');
    return '';
}

// 📋 ИСТОРИЯ — сохраняем треки
async function addToRadioHistory(trackTitle, stationName) {
    try {
        const s = await chrome.storage.local.get('radio_history');
        const history = Array.isArray(s.radio_history) ? s.radio_history : [];
        // Не дублируем последний трек
        if (history.length && history[0].track === trackTitle) return;
        history.unshift({ track: trackTitle, station: stationName, ts: Date.now() });
        if (history.length > 100) history.length = 100;
        await chrome.storage.local.set({ radio_history: history });
    } catch(e) {}
}

// ⏱ ICY POLL — опрашиваем поток каждые 20с
const ICY_POLL_ALARM = 'icyPoll'; // ★ FIX: алармы вместо setInterval (живут при выгрузке фона)

function startIcyPolling() {
    stopIcyPolling();
    if (!canFetchRadioMetadata(radioState.station)) {
        clearRadioMetadata('metadata provider unavailable');
        broadcastRadioState();
        return;
    }
    // ★ FIX: используем chrome.alarms вместо setInterval — алармы переживают выгрузку event page
    chrome.alarms.create(ICY_POLL_ALARM, { periodInMinutes: 0.35 }); // ~21 сек
    // Первый опрос сразу через 3 сек. Важно: привязываем результат к станции,
    // иначе поздний ответ от предыдущей станции перетирает UI новой станции.
    const seq = _radioMetaSeq;
    const stationAtStart = radioState.station;
    const stationNameAtStart = radioState.stationName;
    // ★ OPT: сохраняем ref чтобы отменить при смене станции
    if (_metaInitTimer) clearTimeout(_metaInitTimer);
    _metaInitTimer = setTimeout(async () => {
        _metaInitTimer = null;
        if (seq !== _radioMetaSeq || stationAtStart !== radioState.station) return;
        if (!radioState.isPlaying || !stationAtStart || !canFetchRadioMetadata(stationAtStart)) return;
        const meta = await fetchRadioMetadata(stationAtStart, stationNameAtStart);
        if (seq !== _radioMetaSeq || stationAtStart !== radioState.station) return;
        if (meta?.title) {
            const art = meta.art || await fetchTrackArt(meta.title);
            if (seq !== _radioMetaSeq || stationAtStart !== radioState.station) return;
            setRadioMetadataForCurrentStation(meta.title, art);
            addToRadioHistory(meta.title, stationNameAtStart);
            broadcastRadioState();
        } else {
            clearRadioMetadata('no metadata');
            broadcastRadioState();
        }
    }, 3000);
}

function stopIcyPolling() {
    if (_icyPollTimer) { clearInterval(_icyPollTimer); _icyPollTimer = null; } // legacy guard
    chrome.alarms.clear(ICY_POLL_ALARM).catch(() => {});
    clearRadioMetadata('stop polling');
}

// ★ FIX: Radio keepalive — будит фон каждые 25 сек пока играет радио,
// чтобы event page не был выгружен браузером и Audio не потерялся
function startRadioKeepalive() {
    chrome.alarms.create(RADIO_KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~25 сек
}

function stopRadioKeepalive() {
    chrome.alarms.clear(RADIO_KEEPALIVE_ALARM).catch(() => {});
}

// ⏰ SLEEP TIMER
function radioSetSleepTimer(minutes) {
    if (_sleepTimerId) { clearTimeout(_sleepTimerId); _sleepTimerId = null; }
    if (!minutes || minutes <= 0) {
        radioState.sleepEndsAt = 0;
        broadcastRadioState();
        return;
    }
    radioState.sleepEndsAt = Date.now() + minutes * 60 * 1000;
    _sleepTimerId = setTimeout(async () => {
        _sleepTimerId = null;
        radioState.sleepEndsAt = 0;
        await radioPause();
    }, minutes * 60 * 1000);
    broadcastRadioState();
}

// ════════════════════════════════════════════════════════
// 🔧 FIX: Load SETTINGS from storage on startup
// Without this, after restart SETTINGS keeps defaults and
// notifications fire even when the user disabled them!
// ════════════════════════════════════════════════════════
async function syncSettingsFromStorage() {
    try {
        const stored = await chrome.storage.local.get(null);
        for (const [k, v] of Object.entries(stored)) {
            if (k in SETTINGS) SETTINGS[k] = v;
        }
    } catch(e) { console.error('syncSettings:', e); }
}

// 🌙 DND — проверяет, активен ли режим «Не беспокоить» прямо сейчас
async function isDndActive(type) {
    try {
        const s = await chrome.storage.local.get([
            'dnd_enabled', 'dnd_from', 'dnd_to', 'dnd_days',
            'dnd_allow_mentions', 'dnd_allow_qms', 'dnd_allow_tickets', 'dnd_mute_radio',
            'smart_silence_until', 'smart_silence_mode'
        ]);

        const silenceUntil = Number(s.smart_silence_until || 0);
        if (silenceUntil && Date.now() < silenceUntil) {
            const mode = s.smart_silence_mode || 'focus';
            if (type === 'tickets') return false;
            if (mode === 'focus' && type === 'qms') return false;
            return true;
        }

        if (!s.dnd_enabled) return false;

        // Smart DND matrix: отдельные типы событий могут пробивать тихие часы
        const normalizedType = (type === 'themes_comment') ? 'themes' : type;
        if (normalizedType === 'mentions' && s.dnd_allow_mentions) return false;
        if (normalizedType === 'qms' && s.dnd_allow_qms) return false;
        if (normalizedType === 'tickets' && s.dnd_allow_tickets) return false;

        const now = new Date();
        const day = now.getDay(); // 0=Вс … 6=Сб

        const days = Array.isArray(s.dnd_days) ? s.dnd_days : [0,1,2,3,4,5,6];
        if (!days.includes(day)) return false;

        // Парсим HH:MM
        const parseTime = (str) => {
            const [h, m] = (str || '23:00').split(':').map(Number);
            return h * 60 + m;
        };
        const fromMin = parseTime(s.dnd_from || '23:00');
        const toMin   = parseTime(s.dnd_to   || '08:00');
        const nowMin  = now.getHours() * 60 + now.getMinutes();

        // Диапазон может переходить через полночь (23:00 → 08:00)
        if (fromMin <= toMin) {
            return nowMin >= fromMin && nowMin < toMin;
        } else {
            return nowMin >= fromMin || nowMin < toMin;
        }
    } catch {
        return false;
    }
}

// 🔊 Play notification sound - Firefox compatible version
// ★ OPT: Кеш настроек звука — избегаем IPC при каждом уведомлении
let _soundSettingsCache = null;
const _SOUND_SETTINGS_KEYS = [
    'sound_qms', 'sound_themes', 'sound_themes_all_comments', 'sound_mentions',
    'sound_file_qms', 'sound_file_themes', 'sound_file_mentions',
    'sound_tickets', 'sound_file_tickets', 'sound_volume'
];
chrome.storage.onChanged.addListener((changes) => {
    if (_SOUND_SETTINGS_KEYS.some(k => k in changes)) _soundSettingsCache = null;
});

async function playNotificationSound(type) {
    try {
        // 🌙 Не играть звук в режиме DND
        if (await isDndActive(type)) return;

        // Check if sound is enabled for this type (кешируем настройки)
        if (!_soundSettingsCache) {
            _soundSettingsCache = await chrome.storage.local.get(_SOUND_SETTINGS_KEYS);
        }
        const settings = _soundSettingsCache;
        
        // Check if this type of sound is enabled
        const soundEnabled = {
            'qms': settings.sound_qms,
            'themes': settings.sound_themes,
            'themes_comment': settings.sound_themes_all_comments,
            'mentions': settings.sound_mentions,
            'tickets': settings.sound_tickets
        };
        
        if (!soundEnabled[type]) {
            return;
        }
        
        // 🆕 Per-type sound file selection
        const soundFileMap = {
            'qms':           settings.sound_file_qms     || 'notify',
            'themes':        settings.sound_file_themes   || 'notify',
            'themes_comment':settings.sound_file_themes   || 'notify',
            'mentions':      settings.sound_file_mentions || 'notify',
            'tickets':       settings.sound_file_tickets || 'notify',
        };
        const soundFile = soundFileMap[type] || 'notify';
        const volume = (settings.sound_volume !== undefined ? settings.sound_volume : 50) / 100;
        
        
        // Chrome MV3 service worker has no DOM Audio.
        // Play notification sounds through the existing offscreen audio document.
        await sendRadioOffscreenCommand({
            cmd: 'notifySound',
            soundFile,
            volume: Math.round(Math.max(0, Math.min(1, volume)) * 100)
        });
        
        
    } catch (error) {
        console.error('🔊 Failed to play notification sound:', error);
    }
}

// 🔊 Export for use in other modules
globalThis.playNotificationSound = playNotificationSound;
globalThis.isDndActive = isDndActive;

// 🖼 Notification icons: use real cached 4PDA avatar when available.
// Falls back to the feature icon if avatar is not cached or invalid.
globalThis.getNotificationIcon = async function getNotificationIcon(fallbackIcon) {
    try {
        const data = await chrome.storage.local.get(['cached_user_avatar']);
        const avatar = String(data.cached_user_avatar || '').trim();
        if (avatar && (/^data:image\//i.test(avatar) || /^https?:\/\//i.test(avatar))) return avatar;
    } catch (e) {}
    return fallbackIcon;
};

// ════════════════════════════════════════════════════════
// 🎯 PRIORITY BLINK — иконка мигает когда есть обновление
//    в "приоритетной" теме (режим концентрации)
//    Использует chrome.alarms вместо setInterval —
//    выживает при перезапуске сервис-воркера MV3
// ════════════════════════════════════════════════════════
const BLINK_ALARM = 'priorityBlink';
let _priorityBlinkPhase = false;
let _priorityBlinking   = false;

async function startPriorityBlink() {
    if (_priorityBlinking) return;
    _priorityBlinking = true;
    _priorityBlinkPhase = false;
    await chrome.storage.local.set({ priority_blinking: true });
    // Alarm fires every ~0.7s (minimum 1 min in MV3, so we simulate via storage ping)
    // For sub-minute blinking we use the onMessage ping from content script / popup
    // Actual visual blink is driven each time bg wakes (alarm or message)
    _applyBlinkPhase();
    chrome.alarms.create(BLINK_ALARM, { periodInMinutes: 1 });
}

function stopPriorityBlink() {
    _priorityBlinking = false;
    chrome.alarms.clear(BLINK_ALARM).catch(() => {});
    chrome.storage.local.set({ priority_blinking: false }).catch(() => {});
    // 🔧 FIX: Снимаем blink-блок в browser.js (восстанавливает бейдж из _prevBadgeCount),
    // затем bg.update_action() делает полный canvas-redraw если нужно.
    setBlinkBadge(false);
    bg.update_action();
}

function _applyBlinkPhase() {
    if (!_priorityBlinking) return;
    _priorityBlinkPhase = !_priorityBlinkPhase;
    // 🔧 FIX: Роутим через setBlinkBadge из browser.js.
    // Раньше ON-фаза писала напрямую в chrome.action, bypassing очередь дебаунса.
    // Это приводило к тому, что WS-события перетирали '!!' через 16ms дебаунс.
    // Теперь setBlinkBadge(true) блокирует очередь до setBlinkBadge(false).
    setBlinkBadge(_priorityBlinkPhase);
    // OFF-фаза: setBlinkBadge(false) сам восстанавливает бейдж из _prevBadgeCount.
    // bg.update_action() вызывать не нужно — это было бы лишним canvas redraw.
}

// Resume blink state after SW restart
async function restorePriorityBlinkIfNeeded() {
    try {
        const s = await chrome.storage.local.get(['priority_blinking', 'focused_topics']);
        if (!s.priority_blinking) return;
        // Only blink if there are still focused unread topics
        const ft = (s.focused_topics || []).map(String);
        if (!ft.length) { chrome.storage.local.set({ priority_blinking: false }); return; }
        _priorityBlinking = true;
        _applyBlinkPhase();
        chrome.alarms.create(BLINK_ALARM, { periodInMinutes: 1 });
    } catch(e) {}
}

globalThis.startPriorityBlink = startPriorityBlink;
globalThis.stopPriorityBlink  = stopPriorityBlink;

async function createContextMenus() {
    // ★ OPT: contextMenus — optional permission, проверяем наличие
    if (!chrome.contextMenus) return;
    try {
        const st = await chrome.storage.local.get(['tickets_enabled','tickets_unlocked','user_profile_mode','ui_language']);
        const showTickets = !!(st.tickets_unlocked && st.tickets_enabled);
        const lang = st.ui_language || 'ru';
        const menuI18n = {
            ru: { update:'4Pulse: обновить всё', qms:'Открыть QMS', fav:'Открыть избранное', mentions:'Открыть упоминания', tickets:'Открыть тикеты', site:'Открыть 4PDA', auth:'Авторизация / вход на 4PDA', profile:'Мой профиль на 4PDA', options:'Настройки 4Pulse', diagnostics:'Диагностика 4Pulse' },
            en: { update:'4Pulse: refresh everything', qms:'Open QMS', fav:'Open Favorites', mentions:'Open Mentions', tickets:'Open Tickets', site:'Open 4PDA', auth:'Authorization / sign in to 4PDA', profile:'My 4PDA profile', options:'4Pulse settings', diagnostics:'4Pulse diagnostics' },
            de: { update:'4Pulse: alles aktualisieren', qms:'QMS öffnen', fav:'Favoriten öffnen', mentions:'Erwähnungen öffnen', tickets:'Tickets öffnen', site:'4PDA öffnen', auth:'Autorisierung / Anmeldung bei 4PDA', profile:'Mein 4PDA-Profil', options:'4Pulse-Einstellungen', diagnostics:'4Pulse-Diagnose' },
            uk: { update:'4Pulse: оновити все', qms:'Відкрити QMS', fav:'Відкрити обране', mentions:'Відкрити згадки', tickets:'Відкрити тікети', site:'Відкрити 4PDA', auth:'Авторизація / вхід на 4PDA', profile:'Мій профіль на 4PDA', options:'Налаштування 4Pulse', diagnostics:'Діагностика 4Pulse' }
        };
        const m = menuI18n[lang] || menuI18n.ru;
        chrome.contextMenus.removeAll(() => {
            const base = { contexts: ["action"] };
            chrome.contextMenus.create({ ...base, id: 'update.all', title: m.update });
            chrome.contextMenus.create({ ...base, id: 'open.qms', title: m.qms });
            chrome.contextMenus.create({ ...base, id: 'open.favorites', title: m.fav });
            chrome.contextMenus.create({ ...base, id: 'open.mentions', title: m.mentions });
            if (showTickets) chrome.contextMenus.create({ ...base, id: 'open.tickets', title: m.tickets });
            chrome.contextMenus.create({ ...base, id: 'sep.auth', type: 'separator' });
            chrome.contextMenus.create({ ...base, id: 'open.site', title: m.site });
            chrome.contextMenus.create({ ...base, id: 'open.auth', title: m.auth });
            chrome.contextMenus.create({ ...base, id: 'open.profile', title: m.profile });
            chrome.contextMenus.create({ ...base, id: 'sep.settings', type: 'separator' });
            chrome.contextMenus.create({ ...base, id: 'open.options', title: m.options });
            chrome.contextMenus.create({ ...base, id: 'open.diagnostics', title: m.diagnostics });
        });
    } catch (e) {
        debugWarn('[4Pulse] context menu init failed:', e);
    }
}

async function collectStorageIntegrity() {
    const result = { ok: true, issues: [], staleKeys: [], quotaWarning: false, keys: 0 };
    try {
        const all = await chrome.storage.local.get(null);
        result.keys = Object.keys(all || {}).length;
        const expected = {
            bm_cache: 'array', bm_deleted_ids: 'array', bm_renamed_map: 'object', bm_collapsed_folders: 'array',
            qms_cache: 'array', mentions_cache: 'array', tickets_cache: 'array', radio_history: 'array',
            tiles_row_config: 'object', visible_user_avatar_map: 'object'
        };
        for (const [key, type] of Object.entries(expected)) {
            if (!(key in all)) continue;
            const value = all[key];
            const ok = type === 'array' ? Array.isArray(value) : value && typeof value === type && !Array.isArray(value);
            if (!ok) result.issues.push(`${key}: invalid ${type}`);
        }
        for (const key of Object.keys(all)) {
            if (/^(old_|legacy_|tmp_|debug_|backup_legacy)/i.test(key)) result.staleKeys.push(key);
        }
        if (chrome.storage.local.getBytesInUse) {
            const bytes = await chrome.storage.local.getBytesInUse(null).catch(() => 0);
            result.bytesInUse = bytes;
            result.quotaWarning = bytes > 4.5 * 1024 * 1024;
            if (result.quotaWarning) result.issues.push('storage quota warning');
        }
        result.ok = result.issues.length === 0;
    } catch (e) {
        result.ok = false;
        result.issues.push(String(e?.message || e));
    }
    return result;
}

async function collectAlarmIntegrity(now = Date.now()) {
    const result = { ok: true, issues: [], total: 0, duplicates: [], expired: [] };
    try {
        const alarms = await chrome.alarms.getAll();
        result.total = alarms.length;
        const seen = new Set();
        for (const alarm of alarms) {
            if (seen.has(alarm.name)) result.duplicates.push(alarm.name);
            seen.add(alarm.name);
            if (alarm.scheduledTime && alarm.scheduledTime < now - 60_000) result.expired.push(alarm.name);
        }
        if (result.duplicates.length) result.issues.push('alarm duplicates: ' + result.duplicates.join(', '));
        if (result.expired.length) result.issues.push('expired alarms: ' + result.expired.join(', '));
        result.ok = result.issues.length === 0;
    } catch (e) {
        result.ok = false;
        result.issues.push(String(e?.message || e));
    }
    return result;
}

async function getDiagnosticsSnapshot() {
    let bmCache = [];
    let bmDeletedIds = [];
    let bmRenamedMap = {};
    let bmCollapsedFolders = [];

    try {
        const stored = await chrome.storage.local.get([
            'bm_cache',
            'bm_deleted_ids',
            'bm_renamed_map',
            'bm_collapsed_folders'
        ]);
        bmCache = Array.isArray(stored.bm_cache) ? stored.bm_cache : [];
        bmDeletedIds = Array.isArray(stored.bm_deleted_ids) ? stored.bm_deleted_ids : [];
        bmRenamedMap = stored.bm_renamed_map && typeof stored.bm_renamed_map === 'object' ? stored.bm_renamed_map : {};
        bmCollapsedFolders = Array.isArray(stored.bm_collapsed_folders) ? stored.bm_collapsed_folders : [];
    } catch (e) {
        debugWarn('[Diagnostics] bookmarks storage read failed:', e);
    }

    let alarmInfo = null;
    let backoffInfo = {};
    let httpHealth = {};
    const storageIntegrity = await collectStorageIntegrity();
    const alarmIntegrity = await collectAlarmIntegrity(Date.now());
    try { alarmInfo = await chrome.alarms.get(ALARM_NAME); } catch (_) {}
    try {
        backoffInfo = await chrome.storage.local.get(['backoff_multiplier', 'backoff_until', 'is_429_active', 'last_429_time', 'auto_mode_active']);
        httpHealth = await chrome.storage.local.get(['fetcher_last_success_at','fetcher_last_error_at','fetcher_last_error']);
    } catch (_) { backoffInfo = {}; }

    const liveBookmarks = Array.isArray(bg.bookmarks) ? bg.bookmarks : [];
    const activeBookmarks = liveBookmarks.filter(b => !b.deleted);
    const folders = activeBookmarks.filter(b => b.isFolder);
    const links = activeBookmarks.filter(b => !b.isFolder);
    const countsForHealth = {
        qms: bg.qms?.count || 0,
        favorites: bg.favorites?.count || 0,
        mentions: bg.mentions?.count || 0,
        tickets: SETTINGS.tickets_enabled ? (bg.tickets?.count || 0) : 0,
    };
    const totalForHealth = countsForHealth.qms + countsForHealth.favorites + countsForHealth.mentions + countsForHealth.tickets;
    const now = Date.now();
    const healthIssues = [];
    if (!bg.user_id) healthIssues.push('Нет авторизации');
    if (!bg.wsConnected) healthIssues.push('WebSocket offline');
    if (backoffInfo.is_429_active) healthIssues.push('Активна защита 429');
    if (lastUpdateFinishedAt && !lastUpdateOk) healthIssues.push('Последнее обновление с ошибкой');
    if (!alarmInfo) healthIssues.push('Polling alarm не найден');
    if (!storageIntegrity.ok) healthIssues.push('Проблемы целостности storage');
    if (!alarmIntegrity.ok) healthIssues.push('Проблемы chrome.alarms');
    if (httpHealth.fetcher_last_success_at && now - Number(httpHealth.fetcher_last_success_at) > 60*60*1000) healthIssues.push('HTTP давно не отвечал успешно');

    const snapshot = {
        ok: true,
        version: chrome.runtime.getManifest()?.version || '',
        authorized: !!bg.user_id,
        user_id: bg.user_id || null,
        wsConnected: !!bg.wsConnected,
        health: {
            status: healthIssues.length ? 'warning' : 'ok',
            issues: healthIssues,
            lastUpdateStartedAt,
            lastUpdateFinishedAt,
            lastUpdateAgeSec: lastUpdateFinishedAt ? Math.round((now - lastUpdateFinishedAt) / 1000) : null,
            lastUpdateOk,
            lastUpdateError,
            totalEvents: totalForHealth,
            polling: {
                exists: !!alarmInfo,
                scheduledTime: alarmInfo?.scheduledTime || null,
                scheduledInSec: alarmInfo?.scheduledTime ? Math.max(0, Math.round((alarmInfo.scheduledTime - now) / 1000)) : null,
                periodMinutes: alarmInfo?.periodInMinutes || null,
                backoffMultiplier: backoffInfo.backoff_multiplier || 1,
                backoffUntil: backoffInfo.backoff_until || null,
                is429Active: !!backoffInfo.is_429_active,
                last429Time: backoffInfo.last_429_time || null,
                autoModeActive: !!backoffInfo.auto_mode_active
            },
            http: {
                lastSuccessAt: httpHealth.fetcher_last_success_at || null,
                lastSuccessAgeSec: httpHealth.fetcher_last_success_at ? Math.round((now - Number(httpHealth.fetcher_last_success_at)) / 1000) : null,
                lastErrorAt: httpHealth.fetcher_last_error_at || null,
                lastError: httpHealth.fetcher_last_error || ''
            },
            storageIntegrity,
            alarmIntegrity
        },
        eventLog: eventLogBuffer.slice(0, 50),
        counts: countsForHealth,
        bookmarks: {
            enabled: !!SETTINGS.show_bookmarks_tab,
            loaded: liveBookmarks.length > 0,
            total: liveBookmarks.length,
            active: activeBookmarks.length,
            links: links.length,
            folders: folders.length,
            deletedLocal: bmDeletedIds.length,
            renamedLocal: Object.keys(bmRenamedMap).length,
            collapsedFolders: bmCollapsedFolders.length,
            cacheRows: bmCache.length,
            sample: activeBookmarks.slice(0, 5).map(b => ({
                id: b.id,
                title: b.title,
                isFolder: !!b.isFolder,
                parentId: b.parentId,
                url: b.url || ''
            }))
        },
        radio: getRadioPublicState(),
        settings: {
            interval: SETTINGS.interval,
            tickets_enabled: !!SETTINGS.tickets_enabled,
            tickets_unlocked: !!SETTINGS.tickets_unlocked,
            bookmarks_enabled: !!SETTINGS.show_bookmarks_tab,
            dnd_enabled: !!SETTINGS.dnd_enabled,
            dnd_allow_qms: !!SETTINGS.dnd_allow_qms,
            dnd_allow_mentions: !!SETTINGS.dnd_allow_mentions,
            dnd_allow_tickets: !!SETTINGS.dnd_allow_tickets,
            dnd_mute_radio: !!SETTINGS.dnd_mute_radio,
            attention_center_enabled: !!SETTINGS.attention_center_enabled,
            attention_center_mode: SETTINGS.attention_center_mode || 'full',
            user_profile_mode: SETTINGS.user_profile_mode || 'standard',
            stable_mode: !!SETTINGS.stable_mode,
            silent_doctor_enabled: !!SETTINGS.silent_doctor_enabled,
            auto_backup_enabled: !!SETTINGS.auto_backup_enabled,
            theme_mode: SETTINGS.theme_mode,
        },
        ts: Date.now(),
    };
    snapshot.smartInsights = buildSmartInsights(snapshot);
    snapshot.eventLog = eventLogBuffer.filter(ev => !eventLogClearedAt || (ev.ts || 0) > eventLogClearedAt).slice(0, 50);
    return snapshot;
}
// ════════════════════════════════════════════════════════
// 🎯 Attention Center + Comfort Pack 1.8.8
// ════════════════════════════════════════════════════════
function _stripHtmlText(value) {
    return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildAttentionCenter(data) {
    const tasks = [];
    const favList = Array.isArray(data?.favorites?.list) ? data.favorites.list : [];
    const qmsList = Array.isArray(data?.qms?.list) ? data.qms.list : [];
    const mentionsList = Array.isArray(data?.mentions?.list) ? data.mentions.list : [];
    // Тикеты не подмешиваем в Центр внимания: для модераторов уже есть отдельная, полноценная вкладка тикетов.
    // Для обычных пользователей этот блок вообще не должен всплывать.

    qmsList.filter(d => (d.unread || d.count || d.new_count) && !d.viewed).slice(0, 4).forEach(d => {
        tasks.push({
            type: 'qms', priority: 80, id: d.id, dialog_id: d.id, opponent_id: d.opponent_id || d.mid,
            title: _stripHtmlText(d.title || d.name || d.username || 'Новое QMS'),
            meta: _stripHtmlText(d.last_message || d.text || 'Личное сообщение'),
            actions: ['open_qms']
        });
    });

    mentionsList.filter(m => (m.unread || !m.viewed)).slice(0, 4).forEach(m => {
        tasks.push({
            type: 'mention', priority: 70, id: m.id, topic_id: m.topic_id, post_id: m.post_id,
            title: _stripHtmlText(m.title || m.topic_title || 'Упоминание'),
            meta: _stripHtmlText(m.author || m.section || 'Ответ/упоминание'),
            actions: ['open_mention']
        });
    });

    favList.filter(t => !t.viewed).slice(0, 8).forEach(t => {
        const unread = Number(t.unread_count || t.count || 1);
        const focused = !!t.focused;
        const pinned = !!t.pin;
        tasks.push({
            type: 'favorite', priority: (focused ? 68 : 45) + Math.min(20, unread) + (pinned ? 6 : 0),
            id: t.id, title: _stripHtmlText(t.title || 'Избранная тема'),
            meta: unread > 1 ? ('Новых сообщений: ' + unread) : 'Есть новое сообщение',
            unread, actions: ['open_favorite', 'mute_topic']
        });
    });

    tasks.sort((a, b) => b.priority - a.priority);
    return {
        ts: Date.now(), total: tasks.length, critical: 0,
        headline: tasks.length ? 'Есть события для реакции' : 'Сейчас всё спокойно',
        tasks: tasks.slice(0, 12)
    };
}

function buildMorningDigest(data) {
    const counts = {
        tickets: data?.tickets?.enabled ? (data.tickets.count || 0) : 0,
        qms: data?.qms?.count || 0,
        mentions: data?.mentions?.count || 0,
        favorites: data?.favorites?.count || 0,
        bookmarks: Array.isArray(data?.bookmarks?.list) ? data.bookmarks.list.filter(b => !b.deleted).length : 0
    };
    const total = counts.tickets + counts.qms + counts.mentions + counts.favorites;
    return {
        ts: Date.now(), counts, total,
        title: total ? 'Утренний дайджест готов' : 'Дайджест: новых событий нет',
        text: total
            ? ((counts.tickets ? 'Тикеты: ' + counts.tickets + ', ' : '') + 'QMS: ' + counts.qms + ', ответы: ' + counts.mentions + ', темы: ' + counts.favorites + '.')
            : 'Новых QMS, ответов и тем сейчас нет. Закладок в памяти: ' + counts.bookmarks + '.'
    };
}

function buildFavoritesCleanup(data) {
    const favList = Array.isArray(data?.favorites?.list) ? data.favorites.list : [];
    const nowSec = Math.floor(Date.now() / 1000);
    const suggestions = [];
    favList.forEach(t => {
        const ageDays = t.last_post_ts ? Math.round((nowSec - Number(t.last_post_ts)) / 86400) : null;
        const unread = Number(t.unread_count || t.count || 0);
        if (unread >= 15) suggestions.push({ type: 'noisy', id: t.id, title: _stripHtmlText(t.title), reason: 'Много новых сообщений: ' + unread, action: 'mute_week' });
        else if (ageDays !== null && ageDays >= 45 && t.viewed) suggestions.push({ type: 'stale', id: t.id, title: _stripHtmlText(t.title), reason: 'Нет активности примерно ' + ageDays + ' дн.', action: 'review' });
    });
    return { total: suggestions.length, suggestions: suggestions.slice(0, 8) };
}

function buildPopupEnvelope() {
    const data = bg.popup_data;
    data.attention = buildAttentionCenter(data);
    data.morning_digest = buildMorningDigest(data);
    data.favorites_cleanup = buildFavoritesCleanup(data);
    data.health_compact = {
        wsConnected: !!bg.wsConnected,
        lastUpdateOk,
        lastUpdateFinishedAt,
        issues: [!bg.wsConnected ? 'WebSocket offline' : '', lastUpdateFinishedAt && !lastUpdateOk ? 'Последнее обновление с ошибкой' : ''].filter(Boolean)
    };
    return data;
}


async function getAvatarFromOpen4pdaTabs() {
    try {
        const hasTabsPermission = await chrome.permissions?.contains?.({ permissions: ['tabs'] }).catch(() => false);
        if (!hasTabsPermission) return '';

        const tabs = await chrome.tabs.query({ url: ['https://4pda.to/forum/index.php*'] });
        // Сначала профиль текущего пользователя, потом любые страницы 4PDA.
        const uid = String(bg.user_id || '');
        tabs.sort((a, b) => {
            const au = a.url || '', bu = b.url || '';
            return (bu.includes('showuser=' + uid) ? 1 : 0) - (au.includes('showuser=' + uid) ? 1 : 0);
        });
        for (const tab of tabs) {
            // 1) Быстрый путь: если content-script уже внедрён, спрашиваем его.
            try {
                const res = await chrome.tabs.sendMessage(tab.id, { action: 'user_avatar_from_page' });
                if (res?.user_avatar_url) return res.user_avatar_url;
            } catch (_) {}

            // 2) Надёжный путь для уже открытых вкладок после переустановки расширения:
            // content-script мог не быть внедрён, поэтому выполняем разовый DOM-сборщик.
            try {
                const injected = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    args: [uid, String(bg.user_name || '')],
                    func: (userId, userName) => {
                        const abs = (u) => {
                            if (!u) return '';
                            u = String(u).trim().replace(/&amp;/g, '&');
                            if (u.startsWith('//')) return 'https:' + u;
                            if (u.startsWith('/')) return 'https://4pda.to' + u;
                            return /^https?:\/\//i.test(u) ? u : '';
                        };
                        const badUrl = (u) => /(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon|sprite|button)/i.test(String(u || ''));
                        const scoreImg = (img) => {
                            if (!img) return null;
                            const url = abs(img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '');
                            if (!url || badUrl(url)) return null;
                            const ctx = ((img.alt || '') + ' ' + (img.title || '') + ' ' + (img.className || '') + ' ' + (img.closest('.photo,.user-box,.profile,.avatar')?.className || '')).toLowerCase();
                            let score = 0;
                            if (img.closest('.user-box .photo')) score += 120;
                            if (img.closest('.photo')) score += 80;
                            if (/аватар|avatar|photo|userpic/.test(ctx)) score += 50;
                            if (/\/s\/[^?#]+\.(gif|png|jpe?g|webp)(?:$|[?#])/i.test(url)) score += 45;
                            if (userName && (img.alt === userName || img.title === userName)) score += 35;
                            if (userId && location.href.includes('showuser=' + userId)) score += 25;
                            const w = img.naturalWidth || img.width || 0;
                            const h = img.naturalHeight || img.height || 0;
                            if (w >= 48 && h >= 48) score += 20;
                            if (w && h && (w < 24 || h < 24)) score -= 80;
                            if (/emoji|smile|rank|group|warn|reputation|badge|logo|icon/i.test(ctx)) score -= 40;
                            return score > 0 ? { url, score } : null;
                        };
                        const preferred = [
                            '.user-box .photo img',
                            '.photo img[alt*="Аватар" i]',
                            '.photo img',
                            'img[alt*="Аватар" i]',
                            userName ? `img[title="${CSS.escape(userName)}"]` : '',
                            userName ? `img[alt="${CSS.escape(userName)}"]` : ''
                        ].filter(Boolean);
                        const candidates = [];
                        for (const sel of preferred) {
                            try { document.querySelectorAll(sel).forEach(img => { const c = scoreImg(img); if (c) candidates.push(c); }); } catch (_) {}
                        }
                        document.querySelectorAll('img').forEach(img => { const c = scoreImg(img); if (c) candidates.push(c); });
                        candidates.sort((a, b) => b.score - a.score);
                        return candidates[0]?.url || '';
                    }
                });
                const url = injected?.[0]?.result || '';
                if (url) return url;
            } catch (_) {}
        }
    } catch (_) {}
    return '';
}

async function cacheAvatarUrlAsDataUrl(url) {
    try {
        if (!url) return '';
        if (/^data:image\//i.test(url)) return url;
        const r = await fetch(url, { credentials: 'include', cache: 'reload' });
        if (!r.ok) return '';
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.startsWith('image/')) return '';
        const buf = await r.arrayBuffer();
        if (!buf || buf.byteLength > 512 * 1024) return '';
        const bytes = new Uint8Array(buf);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        return `data:${ct.split(';')[0]};base64,${btoa(binary)}`;
    } catch (_) { return ''; }
}
const __authorAvatarPending = new Map();
const __authorAvatarFailedUntil = new Map();
const AUTHOR_AVATAR_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

async function lookupAuthorAvatar(userId, userName = '', profileUrl = '') {
    userId = String(userId || '').trim();
    userName = String(userName || '').trim();
    profileUrl = String(profileUrl || '').trim();
    const idKey = userId ? `id:${userId}` : '';
    const lookupKey = idKey || (userName ? 'name:' + userName : profileUrl);
    const now = Date.now();

    if (!lookupKey) return { ok: false, error: 'no_profile_url' };

    const failedUntil = __authorAvatarFailedUntil.get(lookupKey) || 0;
    if (failedUntil > now) return { ok: false, error: 'avatar_lookup_cooldown' };
    if (__authorAvatarPending.has(lookupKey)) return __authorAvatarPending.get(lookupKey);

    const promise = (async () => {
        const cache = await chrome.storage.local.get(['visible_user_avatar_map']).catch(() => ({}));
        const map = (cache.visible_user_avatar_map && typeof cache.visible_user_avatar_map === 'object') ? cache.visible_user_avatar_map : {};
        if (idKey && map[idKey]) return { ok: true, avatar: map[idKey], cached: true };
        if (userName && map[userName]) return { ok: true, avatar: map[userName], cached: true };

        const url = profileUrl || (userId ? `https://4pda.to/forum/index.php?showuser=${userId}` : '');
        if (!url) return { ok: false, error: 'no_profile_url' };

        try {
            const r = await fetch(url, { credentials: 'include', cache: 'reload' });
            if (!r.ok) {
                __authorAvatarFailedUntil.set(lookupKey, Date.now() + AUTHOR_AVATAR_FAILURE_COOLDOWN_MS);
                return { ok: false, error: 'profile_http_' + r.status };
            }
            const buf = await r.arrayBuffer();
            const html = new TextDecoder('windows-1251').decode(buf);
            const abs = (u) => {
                if (!u) return '';
                u = String(u).trim().replace(/&amp;/g, '&');
                if (u.startsWith('//')) return 'https:' + u;
                if (u.startsWith('/')) return 'https://4pda.to' + u;
                return /^https?:\/\//i.test(u) ? u : '';
            };
            const bad = (u) => /(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon|sprite|button|rate|warn|reputation|logo|icon)/i.test(String(u || ''));
            const candidates = [];
            const add = (raw, score) => {
                const u = abs(raw);
                if (u && !bad(u)) candidates.push({ url: u, score });
            };
            let m;
            m = html.match(/<div[^>]+class=["'][^"']*user-box[^"']*["'][\s\S]*?<div[^>]+class=["'][^"']*photo[^"']*["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i);
            if (m) add(m[1], 200);
            m = html.match(/<div[^>]+class=["'][^"']*photo[^"']*["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i);
            if (m) add(m[1], 160);
            const re = /<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["'][^>]*(?:alt|title)=["']([^"']*)["'][^>]*>/ig;
            while ((m = re.exec(html))) {
                const ctx = (m[0] + ' ' + (m[2] || '')).toLowerCase();
                let score = /аватар|avatar|photo|userpic/.test(ctx) ? 90 : 0;
                if (/\/s\/[^"']+\.(gif|png|jpe?g|webp)/i.test(m[1])) score += 60;
                if (userName && ctx.includes(userName.toLowerCase())) score += 40;
                if (score > 0) add(m[1], score);
            }
            candidates.sort((a, b) => b.score - a.score);
            const avatarUrl = candidates[0]?.url || '';
            if (!avatarUrl) {
                __authorAvatarFailedUntil.set(lookupKey, Date.now() + AUTHOR_AVATAR_FAILURE_COOLDOWN_MS);
                return { ok: false, error: 'avatar_not_found' };
            }
            const dataAvatar = await cacheAvatarUrlAsDataUrl(avatarUrl);
            const avatar = dataAvatar || avatarUrl;
            if (idKey) map[idKey] = avatar;
            if (userName) map[userName] = avatar;
            const mapKeys = Object.keys(map);
            if (mapKeys.length > 500) {
                const pruned = {};
                mapKeys.slice(-500).forEach(k => pruned[k] = map[k]);
                Object.keys(map).forEach(k => { if (!pruned[k]) delete map[k]; });
            }
            await chrome.storage.local.set({ visible_user_avatar_map: map }).catch(() => {});
            __authorAvatarFailedUntil.delete(lookupKey);
            return { ok: true, avatar, source: avatarUrl };
        } catch (e) {
            __authorAvatarFailedUntil.set(lookupKey, Date.now() + AUTHOR_AVATAR_FAILURE_COOLDOWN_MS);
            return { ok: false, error: String(e?.message || e) };
        }
    })().finally(() => {
        __authorAvatarPending.delete(lookupKey);
    });

    __authorAvatarPending.set(lookupKey, promise);
    return promise;
}

async function setSmartSilence(minutes = 30, mode = 'focus') {
    const until = Date.now() + Math.max(5, Number(minutes) || 30) * 60 * 1000;
    await chrome.storage.local.set({ smart_silence_until: until, smart_silence_mode: mode });
    addEventLog('comfort', 'Умная тишина включена на ' + minutes + ' мин.', 'ok', { mode, until });
    return { ok: true, until, mode };
}

async function clearSmartSilence() {
    await chrome.storage.local.remove(['smart_silence_until', 'smart_silence_mode']);
    addEventLog('comfort', 'Умная тишина выключена', 'ok');
    return { ok: true, until: 0 };
}

async function ensureSilentDoctorAlarm() {
    try {
        const current = await chrome.alarms.get('4pulse_silent_doctor').catch(() => null);
        if (!current) chrome.alarms.create('4pulse_silent_doctor', { periodInMinutes: 5 });
    } catch (_) {}
}

// Initialize alarm on install
chrome.runtime.onInstalled.addListener(async reason => {
    loadRadioState();
    
    // 🔌 Регистрируем keep-alive будильник для WebSocket (MV3 SW не засыпает)
    registerWsKeepAlive();
    
    // Сразу ставим серую иконку до первого входа
    chrome.action.setIcon({ path: {
        16: 'img/icons/icon_19_out.png',
        19: 'img/icons/icon_19_out.png',
        32: 'img/icons/icon_19_out.png',
        48: 'img/icons/icon_19_out.png'
    }});
    
    createContextMenus();
    
    // Initialize alarm immediately
    await ensureSilentDoctorAlarm();
    await initializeAlarm();
    syncTicketQuickPollAlarm();
    foundationRunDoctor(true).catch(()=>{});
});

// Reinitialize alarm on browser startup
chrome.runtime.onStartup.addListener(async () => {
    syncSettingsFromStorage().catch(()=>{});
    await loadRadioState();
    if (radioState.enabled && radioState.isPlaying && radioState.station) {
        radioPlay(); // ★ FIX: внутри radioPlay вызывается startRadioKeepalive()
    }
    restorePriorityBlinkIfNeeded();
    
    // 🔌 Переподключаем keep-alive будильник после перезапуска браузера
    registerWsKeepAlive();
    
    // Ставим серую иконку сразу при старте браузера, до первого запроса
    chrome.action.setIcon({ path: {
        16: 'img/icons/icon_19_out.png',
        19: 'img/icons/icon_19_out.png',
        32: 'img/icons/icon_19_out.png',
        48: 'img/icons/icon_19_out.png'
    }});
    createContextMenus();
    
    // Восстанавливаем авторежим: alarm создаётся всегда — он управляет фоновым обновлением
    // auto_mode_active в storage используется только для popup-polling
    const stored = await chrome.storage.local.get(['auto_mode_active']);
    await ensureSilentDoctorAlarm();
    await initializeAlarm();
    syncTicketQuickPollAlarm();
    foundationRunDoctor(true).catch(()=>{});
});

// Function to create/update the alarm with current backoff multiplier
async function initializeAlarm() {
    await chrome.alarms.clear(ALARM_NAME).catch(() => false);

    const stored = await chrome.storage.local.get([
        'backoff_multiplier',
        'backoff_until',
        'is_429_active',
        'last_429_time'
    ]);

    const now = Date.now();
    let multiplier = stored.backoff_multiplier || 1.0;

    if (stored.is_429_active || (stored.last_429_time && (now - stored.last_429_time < 900000))) {
        multiplier = Math.max(multiplier, 5.0);
        debugWarn(`🛡️ Защитный режим: множитель увеличен до ${multiplier}x из-за недавних лимитов`);
    }

    let finalInterval;
    if (bg.wsConnected) {
        finalInterval = WS_FALLBACK_INTERVAL_MIN;
        debugLog(`[Alarm] WS активен — polling каждые ${finalInterval} мин (fallback)`);
    } else {
        const baseInterval = Math.max(SETTINGS.interval / 60, 1.0);
        const backoffInterval = baseInterval * multiplier;
        const jitter = backoffInterval * 0.2 * (Math.random() * 2 - 1);
        finalInterval = Math.max(backoffInterval + jitter, 1.0);
        debugLog(`[Alarm] WS недоступен — polling каждые ${finalInterval.toFixed(1)} мин (normal)`);
    }

    const delayMinutes = stored.backoff_until > now
        ? Math.max((stored.backoff_until - now) / 60000, 1.0)
        : 0.17;

    chrome.alarms.create(ALARM_NAME, {
        delayInMinutes: delayMinutes,
        periodInMinutes: finalInterval
    });
    addEventLog('polling', 'Polling настроен', 'info', {
        delayMinutes: Number(delayMinutes.toFixed ? delayMinutes.toFixed(2) : delayMinutes),
        periodMinutes: Number(finalInterval.toFixed ? finalInterval.toFixed(2) : finalInterval),
        wsConnected: !!bg.wsConnected
    });
}

// 🔌 Экспортируем initializeAlarm глобально, чтобы cs.js мог вызвать
// пересоздание alarm при смене статуса WS (connect/disconnect).
globalThis.reinitializeAlarm = initializeAlarm;

async function syncTicketQuickPollAlarm() {
    try {
        const st = await chrome.storage.local.get(['tickets_enabled', 'tickets_unlocked']);
        if (st.tickets_enabled && st.tickets_unlocked) {
            chrome.alarms.create(TICKET_QUICK_POLL_ALARM, { periodInMinutes: 3 });
        } else {
            chrome.alarms.clear(TICKET_QUICK_POLL_ALARM).catch(() => {});
        }
    } catch (_) {}
}

// Listen to alarm events
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
        chrome.idle.queryState(300, (state) => {
            if (state === 'locked') return;
            if (state === 'idle' && Math.random() > 0.33) return;
            bg.update();
        });
    }
    if (alarm.name === BLINK_ALARM) {
        _applyBlinkPhase();
    }
    if (alarm.name === TICKET_QUICK_POLL_ALARM) {
        chrome.idle.queryState(120, async (state) => {
            if (state === 'locked') return;
            try {
                const st = await chrome.storage.local.get(['tickets_enabled', 'tickets_unlocked']);
                if (!st.tickets_enabled || !st.tickets_unlocked) {
                    syncTicketQuickPollAlarm();
                    return;
                }
                await bg.tickets.update(false);
                bg.update_action();
            } catch (e) {
                debugWarn('[BG] ticketQuickPoll failed:', e?.message || e);
            }
        });
    }
    if (alarm.name === '4pulse_silent_doctor') {
        foundationRunDoctor(true).catch(()=>{});
    }
    // 🔌 WS keep-alive: при каждом alarm проверяем состояние WS.
    // Если WS отвалился (SW перезапустился, сеть мигнула) — bg.update()
    // обнаружит что WS не подключён и запустит переподключение.
    // Это решает проблему "уведомления только при ручном обновлении".
    if (alarm.name === '4pulse_ws_keepalive') {
        if (bg && !bg.wsConnected) {
            debugLog('[BG] Keep-alive: WS не подключён — запускаем update()');
            bg.update();
        }
    }
    // ★ FIX: ICY metadata polling через alarm (вместо setInterval)
    if (alarm.name === ICY_POLL_ALARM) {
        if (!radioState.isPlaying || !radioState.station || !canFetchRadioMetadata(radioState.station)) {
            chrome.alarms.clear(ICY_POLL_ALARM).catch(() => {});
            return;
        }
        const seq = _radioMetaSeq;
        const stationAtStart = radioState.station;
        const stationNameAtStart = radioState.stationName;
        fetchRadioMetadata(stationAtStart, stationNameAtStart).then(async meta => {
            if (seq !== _radioMetaSeq || stationAtStart !== radioState.station) return;
            if (meta?.title) {
                const art = meta.art || await fetchTrackArt(meta.title);
                if (seq !== _radioMetaSeq || stationAtStart !== radioState.station) return;
                const before = radioState.currentTrack;
                setRadioMetadataForCurrentStation(meta.title, art);
                if (meta.title !== before) addToRadioHistory(meta.title, stationNameAtStart);
                broadcastRadioState();
            } else if (radioState.currentTrack) {
                clearRadioMetadata('no metadata alarm');
                broadcastRadioState();
            }
        }).catch(() => {});
    }
    // Chrome MV3 radio keepalive: ask offscreen player for its state and restart if needed.
    if (alarm.name === RADIO_KEEPALIVE_ALARM) {
        if (radioState.isPlaying && radioState.station) {
            sendRadioOffscreenCommand({ cmd: 'state' }).then(result => {
                if (!result?.isPlaying) radioPlay().catch(() => {});
            }).catch(() => radioPlay().catch(() => {}));
        }
    }
});

// Listen for backoff state changes - merged below with main storage listener


chrome.contextMenus.onClicked.addListener((info, tab) => {
    switch (info.menuItemId) {
        case 'update.all':
            addEventLog('action', 'Контекстное меню: обновить всё', 'info');
            bg.update(true);
            break;
        case 'open.qms':
            open_url('https://4pda.to/forum/index.php?act=qms', true, false);
            break;
        case 'open.favorites':
            open_url('https://4pda.to/forum/index.php?act=fav', true, false);
            break;
        case 'open.mentions':
            open_url('https://4pda.to/forum/index.php?act=mentions', true, false);
            break;
        case 'open.tickets':
            open_url('https://4pda.to/forum/index.php?act=ticket', true, false);
            break;
        case 'open.site':
            open_url('https://4pda.to/forum/', true, false);
            break;
        case 'open.auth':
            open_url('https://4pda.to/forum/index.php?act=auth', true, false);
            break;
        case 'open.profile':
            if (bg.user_id) {
                open_url('https://4pda.to/forum/index.php?showuser=' + bg.user_id, true, false);
            } else {
                open_url('https://4pda.to/forum/index.php?act=auth', true, false);
            }
            break;
        case 'open.options':
            open_url(chrome.runtime.getURL('/html/options.html?section=fourpulse'), true, true);
            break;
        case 'open.diagnostics':
            open_url(chrome.runtime.getURL('/html/options.html?section=diagnostics#diagnostics'), true, true);
            break;
    }
});

// Listen for messages from popup or other extension parts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Events from Chrome offscreen radio player.
    if (message?.action === 'radio_offscreen_event') {
        if (message.type === 'playing') {
            radioState.isPlaying = true;
            radioState.lastError = '';
            startIcyPolling();
        } else if (message.type === 'pause') {
            radioState.isPlaying = false;
        } else if (message.type === 'error') {
            radioState.isPlaying = false;
            radioState.lastError = message.lastError || 'Станция не отвечает или формат не поддерживается';
        }
        saveRadioState().then(() => broadcastRadioState()).catch(() => broadcastRadioState());
        sendResponse({ ok: true });
        return true;
    }

    // Runtime message tracing is intentionally silent in release builds.
    // Enable manually only while debugging, otherwise frequent UI polling
    // (for example radio_get_state) floods the extension console.

    // Bookmark operations — handled before switch to avoid any JS lexical issues
    if (message.action === 'bookmark_delete') {
        if (globalThis.__FOURPULSE_DEBUG__) debugLog('[BG] bookmark_delete id=', message.id, 'typeof bg.deleteBookmark=', typeof bg.deleteBookmark);
        bg.deleteBookmark(message.id)
            .then(ok => { if (globalThis.__FOURPULSE_DEBUG__) debugLog('[BG] delete ok=', ok); sendResponse({ ok }); })
            .catch(e => { console.error('[BG] delete error:', e); sendResponse({ ok: false }); });
        return true;
    }
    if (message.action === 'bookmark_rename') {
        if (globalThis.__FOURPULSE_DEBUG__) debugLog('[BG] bookmark_rename id=', message.id, 'title=', message.title, 'typeof bg.renameBookmark=', typeof bg.renameBookmark);
        bg.renameBookmark(message.id, message.title)
            .then(ok => { if (globalThis.__FOURPULSE_DEBUG__) debugLog('[BG] rename ok=', ok); sendResponse({ ok }); })
            .catch(e => { console.error('[BG] rename error:', e); sendResponse({ ok: false }); });
        return true;
    }
    if (message.action === 'bookmark_add') {
        if (globalThis.__FOURPULSE_DEBUG__) debugLog('[BG] bookmark_add title=', message.title, 'url=', message.url, 'parentId=', message.parentId);
        bg.addBookmark(message.title, message.url, message.parentId ?? 0)
            .then(ok => { if (globalThis.__FOURPULSE_DEBUG__) debugLog('[BG] bookmark_add ok=', ok); sendResponse({ ok }); })
            .catch(e => { console.error('[BG] bookmark_add error:', e); sendResponse({ ok: false }); });
        return true;
    }
    if (message.action === 'folder_add') {
        if (globalThis.__FOURPULSE_DEBUG__) debugLog('[BG] folder_add title=', message.title, 'parentId=', message.parentId);
        bg.addFolder(message.title, message.parentId ?? 0)
            .then(ok => { if (globalThis.__FOURPULSE_DEBUG__) debugLog('[BG] folder_add ok=', ok); sendResponse({ ok }); })
            .catch(e => { console.error('[BG] folder_add error:', e); sendResponse({ ok: false }); });
        return true;
    }

    if (message.action === 'pda_smileys_capture') {
        (async () => {
            try {
                const incoming = Array.isArray(message.items) ? message.items : [];
                const seen = new Set();
                const items = incoming.filter(item => {
                    const code = String(item?.code || '').trim();
                    const src = String(item?.src || '').trim();
                    if (!code || !src || seen.has(code)) return false;
                    if (!(/^:[^\s]{1,80}:$/.test(code) || code === ':)' || code === ';)' || code === ':P' || code === ':-D')) return false;
                    if (!/^https?:\/\//i.test(src)) return false;
                    seen.add(code);
                    return true;
                }).map(item => ({
                    code: String(item.code).trim(),
                    src: String(item.src).trim(),
                    title: String(item.title || item.code || '').trim(),
                    alt: String(item.alt || item.code || '').trim()
                }));
                if (items.length < 20) {
                    sendResponse({ ok: false, captured: items.length });
                    return;
                }
                await chrome.storage.local.set({
                    pda_smileys_catalog_v1: {
                        ts: Date.now(),
                        items,
                        source_url: String(message.source_url || ''),
                        captured_count: items.length
                    }
                });
                sendResponse({ ok: true, captured: items.length });
            } catch (error) {
                sendResponse({ ok: false, error: String(error?.message || error) });
            }
        })();
        return true;
    }

    switch (message.action) {
        case 'radio_get_state':
            sendResponse(getRadioPublicState());
            break;

        case 'radio_play':
            radioPlay(message.station, message.stationName).then(() => sendResponse(getRadioPublicState()));
            return true;

        case 'radio_pause':
            radioPause().then(() => sendResponse(getRadioPublicState()));
            return true;

        case 'radio_set_volume':
            radioSetVolume(message.volume).then(() => sendResponse({ ok: true }));
            return true;

        case 'radio_set_enabled':
            radioState.enabled = !!message.enabled;
            if (!radioState.enabled) radioPause();
            else saveRadioState();
            sendResponse({ ok: true });
            break;

        case 'radio_set_sleep_timer':
            radioSetSleepTimer(message.minutes);
            sendResponse(getRadioPublicState());
            break;

        case 'radio_get_history':
            chrome.storage.local.get('radio_history').then(s =>
                sendResponse(s.radio_history || [])
            );
            return true;

        case 'radio_clear_history':
            chrome.storage.local.set({ radio_history: [] }).then(() => sendResponse({ ok: true }));
            return true;


        case 'foundation_apply_profile':
            foundationApplyProfile(message.profile)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ ok:false, error:String(error?.message || error) }));
            return true;

        case 'foundation_create_backup':
            foundationCreateBackup(!!message.manual)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ ok:false, error:String(error?.message || error) }));
            return true;

        case 'foundation_restore_latest_backup':
            foundationRestoreLatestBackup()
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ ok:false, error:String(error?.message || error) }));
            return true;

        case 'foundation_run_doctor':
            foundationRunDoctor(false)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ ok:false, error:String(error?.message || error) }));
            return true;

        case 'diagnostics_clear_log':
            clearEventLog().then(result => sendResponse(result || { ok: true })).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
            return true;

        case 'diagnostics_self_heal':
            runSelfHeal()
                .then(snapshot => sendResponse(snapshot))
                .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
            return true;

        case 'diagnostics_snapshot':
            getDiagnosticsSnapshot()
                .then(snapshot => sendResponse(snapshot))
                .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
            return true;

        case 'smart_silence_set':
            setSmartSilence(message.minutes || 30, message.mode || 'focus')
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
            return true;

        case 'smart_silence_clear':
            clearSmartSilence()
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
            return true;

        case 'attention_snapshot':
            try {
                const env = buildPopupEnvelope();
                sendResponse({ ok: true, attention: env.attention, digest: env.morning_digest, cleanup: env.favorites_cleanup });
            } catch (error) { sendResponse({ ok: false, error: String(error?.message || error) }); }
            return true;


        case 'author_avatar_lookup':
            lookupAuthorAvatar(message.user_id, message.user_name, message.profile_url)
                .then(result => sendResponse(result))
                .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
            return true;

        case 'user_avatar_refresh':
            (async () => {
                let result = await bg.refreshUserAvatar(!!message.force).catch(error => ({ ok: false, error: String(error?.message || error), user_avatar_url: bg.user_avatar || '' }));
                if (!result?.user_avatar_url) {
                    const fromPage = await getAvatarFromOpen4pdaTabs();
                    if (fromPage) {
                        const dataAvatar = await cacheAvatarUrlAsDataUrl(fromPage);
                        const finalAvatar = dataAvatar || fromPage;
                        await chrome.storage.local.set({ cached_user_avatar: finalAvatar, cached_user_avatar_source: fromPage }).catch(() => {});
                        // Обновляем внутренний кэш через force-запрос уже не нужен — popup получит URL сразу.
                        result = { ok: true, user_avatar_url: finalAvatar, source: fromPage };
                    }
                }
                sendResponse(result || { ok: false, user_avatar_url: bg.user_avatar || '' });
            })().catch(error => sendResponse({ ok: false, error: String(error?.message || error), user_avatar_url: bg.user_avatar || '' }));
            return true;

        case 'popup_loaded':
            // Stop blink when user opens popup
            stopPriorityBlink();
            if (bg.user_id) {
                sendResponse(buildPopupEnvelope());
            } else {
                // 🔧 FIX: Service worker may still be initializing (MV3 restarts).
                // Wait up to 4s for user_id to appear before giving up and redirecting to auth.
                (async () => {
                    let waited = 0;
                    while (!bg.user_id && waited < 4000) {
                        await new Promise(r => setTimeout(r, 250));
                        waited += 250;
                    }
                    if (bg.user_id) {
                        sendResponse(buildPopupEnvelope());
                    } else {
                        open_url('https://4pda.to/forum/index.php?act=auth');
                        sendResponse(null);
                    }
                })();
            }
            return true;
            
        case 'reload_settings':
            // После импорта настроек — перезагружаем весь объект SETTINGS из storage
            (async () => {
                try {
                    const stored = await chrome.storage.local.get(Object.keys(SETTINGS));
                    for (const [key, val] of Object.entries(stored)) {
                        if (key in SETTINGS) SETTINGS[key] = val;
                    }
                    sendResponse({ ok: true });
                } catch(e) {
                    sendResponse({ ok: false });
                }
            })();
            return true;

        case 'force_update':
            // 🆕 NEW: Force immediate update with full HTML page fetch (forceRefresh = true)
            bg.update(true).then(() => {
                sendResponse({ success: true });
            }).catch(error => {
                console.error('❌ Force update failed:', error);
                sendResponse({ success: false });
            });
            return true; // Keep channel open for async response

        case 'start_priority_blink':
            startPriorityBlink();
            sendResponse({ ok: true });
            break;

        case 'stop_priority_blink':
            stopPriorityBlink();
            sendResponse({ ok: true });
            break;
        case 'mark_as_read':
            bg.favorites.do_read(message.id)
                .then(result => {
                    // If there are no more unread focused topics, stop blinking
                    chrome.storage.local.get(['focused_topics']).then(stored => {
                        const ft = (stored.focused_topics || []).map(String);
                        const anyFocusedUnread = bg.favorites.list.some(
                            t => !t.viewed && ft.includes(String(t.id))
                        );
                        if (!anyFocusedUnread) stopPriorityBlink();
                    });
                    sendResponse(result);
                })
                .catch((error) => {
                    console.error('Error marking theme as read:', error);
                    sendResponse(false);
                });
            return true; // Keep channel open for async response
        case 'open_url': {
            // Из сайдбара (message.sidebar===true) всегда открываем вкладку активной,
            // т.к. сайдбар не закрывается сам в отличие от попапа.
            // message.background===true (Shift/Ctrl/Cmd/MiddleClick) — фоновая вкладка.
            let setActive;
            if (message.background === true) {
                setActive = false;  // 🆕 Принудительно фоновая вкладка (модификатор клавиатуры/средняя кнопка)
            } else if (message.sidebar === true) {
                setActive = true;
            } else {
                setActive = SETTINGS.toolbar_open_theme_hide;
            }

            switch (message.what) {
                case 'user':
                    return open_url(`https://4pda.to/forum/index.php?showuser=${bg.user_id}`, true, true);
                case 'options':
                    return open_url(chrome.runtime.getURL('/html/options.html?section=fourpulse'), true, true);
                case 'qms':
                    if (message.dialog_id) {
                        const dialogId = message.dialog_id;
                        const marked = bg.qms.markAsViewed(dialogId);
                        if (marked) bg.update_action();
                    }
                    if (message.opponent_id && message.dialog_id && message.dialog_id !== message.opponent_id) {
                        return open_url(
                            `https://4pda.to/forum/index.php?act=qms&mid=${message.opponent_id}&t=${message.dialog_id}`,
                            setActive, false
                        );
                    }
                    if (message.opponent_id) {
                        return open_url(
                            `https://4pda.to/forum/index.php?act=qms&mid=${message.opponent_id}`,
                            setActive, false
                        );
                    }
                    return bg.qms.open();

                case 'favorites':
                    bg.favorites.open(message.id, message['view'], setActive)
                        .then(async (result) => {
                            const [tab, theme] = Array.isArray(result) ? result : [result, null];
                            if (theme && theme.viewed) {
                                await bg.mentions.markTopicMentionsAsViewed(theme.id);
                                bg.update_action();
                            }
                        }).catch(err => { debugWarn('Error opening favorite:', err); });
                    break;

                case 'bookmarks':
                    return open_url('https://4pda.to/forum/index.php?act=fav', true, false);

                case 'tickets':
                    return open_url('https://4pda.to/forum/index.php?act=ticket', true, false);

                case 'external':
                    if (message.url) return open_url(message.url, true, false);
                    break;

                case 'mentions':
                    if (message.topic_id && message.post_id) {
                        const mentionId = `${message.topic_id}_${message.post_id}`;
                        bg.mentions.markAsViewed(mentionId)
                            .then(() => bg.update_action())
                            .catch(err => { console.error('Failed to save mention viewed state:', err); });
                        bg.update_action();
                        return open_url(
                            `https://4pda.to/forum/index.php?showtopic=${message.topic_id}&view=findpost&p=${message.post_id}`,
                            setActive, false
                        );
                    }
                    return bg.mentions.open();
            }
            break;
        }
        case 'get_counts':
            // Return current counts for popup polling
            sendResponse({
                favorites: bg.favorites.count,
                qms: bg.qms.count,
                mentions: bg.mentions.count
            });
            break;
        
        case 'page_topic_opened':
            // 🆕 NEW: Content script сообщает, что пользователь открыл тему напрямую в браузере
            // Мгновенно помечаем тему как прочитанную и обновляем бейдж
            if (message.topic_id && message.is_read) {
                const topicId = String(message.topic_id);
                const theme = bg.favorites._list[topicId];
                if (theme && !theme.viewed) {
                    theme.viewed = true;
                    bg.update_action();
                }
            }
            break;
        case 'request':
            switch (message.what) {
                case 'favorites.count':
                    sendResponse(bg.favorites.count);
                    break;
                case 'qms.count':
                    sendResponse(bg.qms.count);
                    break;
                case 'mentions.count':
                    sendResponse(bg.mentions.count);
                    break;
            }
            break;
        case 'fetch_qms_subject':
            // 🆕 NEW: Fetch dialog subject for a specific QMS user
            if (message.opponent_id) {
                bg.qms.fetchDialogSubject(message.opponent_id)
                    .then(result => {
                        sendResponse(result);
                    })
                    .catch(error => {
                        console.error('Error fetching QMS subject:', error);
                        sendResponse(null);
                    });
                return true; // Keep channel open for async response
            }
            break;

        case 'resolve_favorite_preview':
            if (message.topic_id) {
                fetch4('https://4pda.to/forum/index.php?act=fav')
                    .then(html => {
                        const found = resolveFavoritePreviewFromFavHtml(html, message.topic_id);
                        sendResponse(found ? { ok: true, ...found } : { ok: false, error: 'no direct post link' });
                    })
                    .catch(err => sendResponse({ ok: false, error: String(err) }));
                return true;
            }
            sendResponse({ ok: false, error: 'no topic_id' });
            break;

        case 'fetch_page':
            // Generic page fetch via background (has credentials/cookies, bypasses CORS)
            if (message.url) {
                fetch4(message.url)
                    .then(html => sendResponse({ ok: true, html }))
                    .catch(err => sendResponse({ ok: false, error: String(err) }));
                return true;
            }
            break;

        // 🎫 TICKETS — handled via sendMessage (not port) so popup gets response
        case 'open_ticket':
            bg.tickets.open(message['id'], !!message['sidebar'])
                .then(result => {
                    sendResponse({ ok: true, count: bg.tickets.count });
                })
                .catch(err => {
                    debugWarn('Error opening ticket:', err);
                    sendResponse({ ok: false });
                });
            return true;

        case 'open_ticket_source':
            bg.tickets.openSource(message['id'], !!message['sidebar'])
                .then(result => {
                    sendResponse({ ok: true, count: bg.tickets.count });
                })
                .catch(err => {
                    debugWarn('Error opening ticket source:', err);
                    sendResponse({ ok: false });
                });
            return true;

        case 'ticket_change_status':
            bg.tickets.changeStatus(message['id'], message['status'])
                .then(ok => {
                    if (ok) bg.update_action();
                    sendResponse({ ok, count: bg.tickets.count });
                })
                .catch(err => {
                    debugWarn('Error changing ticket status:', err);
                    sendResponse({ ok: false });
                });
            return true;

        case 'ticket_mark_viewed':
            bg.tickets.markAsViewed(message['id'])
                .then(() => { bg.update_action(); sendResponse({ ok: true }); })
                .catch(err => { debugWarn('Error marking ticket viewed:', err); sendResponse({ ok: false }); });
            return true;

        // 💬 Quick comment on ticket
        case 'ticket_add_comment': {
            const { id: tcid, comment } = message;
            if (!tcid || !comment) { sendResponse({ ok: false }); break; }

            // 4PDA форум работает в Windows-1251. FormData отправляет UTF-8 → кракозябры.
            // Перекодируем строки в Win1251 вручную и шлём как application/x-www-form-urlencoded
            // с явным указанием charset в Content-Type.
            function toWin1251Bytes(str) {
                const map = new Map();
                for (let i = 0; i < 128; i++) map.set(i, i);
                // Кириллица A-я: U+0410–U+044F → 0xC0–0xEF
                for (let i = 0; i < 64; i++) map.set(0x0410 + i, 0xC0 + i);
                map.set(0x0401, 0xA8); // Ё
                map.set(0x0451, 0xB8); // ё
                // Прочие win1251 символы (0x80–0xBF)
                const extra = [0x20AC,0,0x201A,0x192,0x201E,0x2026,0x2020,0x2021,
                               0x2C6,0x2030,0x160,0x2039,0x152,0,0x17D,0,
                               0,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,
                               0x2DC,0x2122,0x161,0x203A,0x153,0,0x17E,0x178,
                               0xA0,0xA1,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,
                               0xA8,0xA9,0xAA,0xAB,0xAC,0xAD,0xAE,0xAF,
                               0xB0,0xB1,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7,
                               0xB8,0xB9,0xBA,0xBB,0xBC,0xBD,0xBE,0xBF];
                extra.forEach((cp, i) => { if (cp) map.set(cp, 0x80 + i); });
                const buf = new Uint8Array(str.length * 2);
                let len = 0;
                for (const ch of str) {
                    const cp = ch.codePointAt(0);
                    buf[len++] = map.has(cp) ? map.get(cp) : 0x3F; // '?' для неизвестных
                }
                return buf.slice(0, len);
            }
            function win1251EncodeField(str) {
                // percent-encode каждого байта win1251
                return Array.from(toWin1251Bytes(str))
                    .map(b => '%' + b.toString(16).toUpperCase().padStart(2, '0'))
                    .join('');
            }

            const body = [
                'tact=add',
                't_id=' + encodeURIComponent(String(tcid)),
                'm_comment=' + win1251EncodeField(comment),
                'confirm=' + win1251EncodeField('Написал хорошо, можно публиковать'),
            ].join('&');

            fetchWithRetry(`https://4pda.to/forum/index.php?act=ticket&s=thread&`, {
                method: 'POST',
                credentials: 'include',
                referrerPolicy: 'no-referrer-when-downgrade',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=windows-1251' },
                body,
            })
            .then(r => sendResponse({ ok: r.ok }))
            .catch(() => sendResponse({ ok: false }));
            return true;
        }

        // 🎯 Fetch curator from ticket thread page
        case 'ticket_fetch_curator': {
            const tid = message['id'];
            if (!tid) { sendResponse({ ok: false }); break; }
            const threadUrl = `https://4pda.to/forum/index.php?act=ticket&s=thread&t_id=${tid}`;
            fetchText(threadUrl, {
                credentials: 'include',
                referrerPolicy: 'no-referrer-when-downgrade',
            }, 'windows-1251')
            .then(async html => {

                const clean = (s) => s.replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').trim();

                // Куратор темы: <strong>Куратор:</strong> <a ...>Name</a>
                const curatorRe = /<strong>[^<]*\u041a\u0443\u0440\u0430\u0442\u043e\u0440[^<]*<\/strong>\s*<a[^>]*>([^<]+)<\/a>/i;
                const curatorM  = html.match(curatorRe);
                const curator   = curatorM ? clean(curatorM[1]) : '';

                // Тема форума: <strong>Тема:</strong> <a href="URL">Title</a>
                const topicRe = /<strong>[^<]*\u0422\u0435\u043c\u0430[^<]*<\/strong>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i;
                const topicM  = html.match(topicRe);
                const topicTitle = topicM ? clean(topicM[2]) : '';
                const topicUrl   = topicM ? topicM[1].replace(/&amp;/g,'&') : '';

                // Ответственный (t-mod): кто взял тикет в работу
                const modRe = new RegExp(`id="t-mod-${tid}"[^>]*>([\\s\\S]*?)<\\/div>`, 'i');
                const modM  = html.match(modRe);
                let responsible = '';
                if (modM) {
                    responsible = modM[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/[–\-]/g,'').trim();
                }

                sendResponse({ ok: true, curator, responsible, topicTitle, topicUrl });
            })
            .catch(() => sendResponse({ ok: false }));
            return true;
        }

        // 🔬 Диагностика: получить HTML страницы закладок через content script
        case 'fav_debug_page':
            chrome.tabs.query({ url: 'https://4pda.to/forum/*' }).then(tabs => {
                if (!tabs.length) { sendResponse({ ok: false, error: 'no 4pda tab' }); return; }
                chrome.tabs.sendMessage(tabs[0].id, { action: 'fav_fetch_page' }, resp => {
                    sendResponse(resp);
                });
            });
            return true;


        case 'ticket_nav_count': {
            const count = Number(message.count);
            if (!Number.isFinite(count) || count < 0) {
                sendResponse({ ok: false });
                return false;
            }
            bg.tickets.applyPageSnapshot({ totalUnprocessed: count, tickets: [] })
                .then(ok => {
                    if (ok) bg.update_action();
                    sendResponse({ ok, count: bg.tickets.count });
                })
                .catch(err => {
                    debugWarn('Error applying ticket nav count:', err);
                    sendResponse({ ok: false });
                });
            return true;
        }

        case 'ticket_page_snapshot':
            bg.tickets.applyPageSnapshot(message.snapshot || {})
                .then(ok => {
                    if (ok) bg.update_action();
                    sendResponse({ ok, count: bg.tickets.count, list: bg.tickets.list });
                })
                .catch(err => {
                    console.error('Error applying ticket page snapshot:', err);
                    sendResponse({ ok: false });
                });
            return true;

        case 'tickets_refresh':
            bg.tickets.update(true)
                .then(() => {
                    bg.update_action();
                    sendResponse({ count: bg.tickets.count, list: bg.tickets.list });
                })
                .catch(err => {
                    debugWarn('Error refreshing tickets:', err);
                    sendResponse({ count: 0, list: [] });
                });
            return true;

        case 'request_history':
            bg.requestHistoryFromWs();
            sendResponse({ ok: true });
            return false;

    }
    // 🔧 FIX: Don't return true by default!
    // Only cases that call sendResponse() asynchronously should return true.
    // Returning true here would cause "message channel closed" errors for cases
    // that handle responses synchronously or don't send responses at all.
});

chrome.runtime.onConnect.addListener(async (port) => {
    
    const isPortConnected = () => {
        try {
            return port.name !== undefined;
        } catch (e) {
            return false;
        }
    };

    const safePostMessage = (msg) => {
        try {
            if (isPortConnected()) {
                port.postMessage(msg);
                return true;
            }
        } catch (e) {
            debugWarn('Port disconnected, cannot send message:', e);
        }
        return false;
    };

    switch (port.name) {
        case 'themes-read-all':
            for (let theme of bg.favorites.list) {
                if (await theme.read()) {
                    safePostMessage({
                        id: theme.id,
                        count: bg.favorites.count,
                    });
                }
            }
            break;
        case 'themes-open-all':
            let count_TPA = 0;
            for (let theme of bg.favorites.list) {
                theme.open(false, false)
                    .then(([tab, theme]) => {
                        if (theme.viewed) {
                            safePostMessage({
                                id: theme.id,
                                count: bg.favorites.count,
                            });
                        }
                    })
                    .catch(err => debugWarn('Error opening theme:', err));
                if (++count_TPA >= SETTINGS.open_themes_limit) break;
            }
            break;
        case 'themes-open-all-pin':
            let count_TPAP = 0;
            for (let theme of bg.favorites.list_pin) {
                theme.open(false, false)
                    .then(([tab, theme]) => {
                        if (theme.viewed) {
                            safePostMessage({
                                id: theme.id,
                                count: bg.favorites.count,
                            });
                        }
                    })
                    .catch(err => debugWarn('Error opening pinned theme:', err));
                if (++count_TPAP >= SETTINGS.open_themes_limit) break;
            }
            break;

    }
});

chrome.notifications.onClicked.addListener(notificationId => {
    const n_data = notificationId.split('/'),
        funcs = {
            theme: (id) => bg.favorites.open(id, 'getlastpost'),
            dialog: (id) => bg.qms.open(id),
            mention: (id) => bg.mentions.open(id),
            ticket: (id) => bg.tickets.open(parseInt(id)),
        };

    if (n_data[1] in funcs) {
        funcs[n_data[1]](n_data[2])
            .then(result => {
                const tab = Array.isArray(result) ? result[0] : result;
                if (!tab?.id) return null;
                // Firefox: activate tab and, where available, focus its window.
                return chrome.tabs.update(tab.id, { active: true })
                    .then(() => tab.windowId != null && chrome.windows?.update
                        ? chrome.windows.update(tab.windowId, { focused: true })
                        : null);
            })
            .catch(err => console.error('Error handling notification click:', err));
    }
    chrome.notifications.clear(notificationId);
});

// Единый обработчик изменений storage
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== 'local') return;

    // Синхронизируем SETTINGS
    for (let [key, { oldValue, newValue }] of Object.entries(changes)) {
        SETTINGS[key] = newValue;
    }

    // 🔧 FIX: Синхронизируем radioState.enabled при записи radio_enabled в storage.
    // Проблема: saveSettings() из страницы настроек пишет radio_enabled напрямую в storage,
    // минуя radio_set_enabled message. radioState.enabled оставался несинхронизированным
    // до следующего перезапуска SW, из-за чего радио-тогл «не срабатывал» с первой попытки.
    if ('radio_enabled' in changes) {
        const newEnabled = !!changes.radio_enabled.newValue;
        if (radioState.enabled !== newEnabled) {
            radioState.enabled = newEnabled;
            if (!radioState.enabled && radioState.isPlaying) {
                // Chrome MV3: radio playback lives in the offscreen document.
                clearRadioReconnect();
                try { sendRadioOffscreenCommand({ cmd: 'pause' }).catch(() => {}); } catch (_) {}
                radioState.isPlaying = false;
                stopRadioKeepalive();
                stopIcyPolling();
                closeRadioOffscreenIfIdle().catch(() => {});
            }
            broadcastRadioState();
        }
    }

    // Backoff / alarm — пересоздать если нужно
    if (changes.backoff_multiplier) {
        const oldM = changes.backoff_multiplier.oldValue || 1.0;
        const newM = changes.backoff_multiplier.newValue || 1.0;
        if (oldM !== newM) initializeAlarm();
    }
    if (changes.is_429_active || changes.interval) {
        initializeAlarm();
    }

    if (!bg.initialized) return;

    // Реакция на конкретные настройки
    if (changes.toolbar_pin_themes_level) {
        const { oldValue, newValue } = changes.toolbar_pin_themes_level;
        if (oldValue == 20) bg.favorites.filter_pin(false);
        else if (newValue == 20) bg.favorites.filter_pin(true);
    }
    if (changes.interval) {
        initializeAlarm();
    }

    // Rebuild action context menu immediately after UI language/ticket visibility changes.
    if (changes.ui_language || changes.tickets_enabled || changes.tickets_unlocked) {
        createContextMenus();
        syncTicketQuickPollAlarm();
    }

    // 📖 Когда пользователь включает вкладку «История» — сразу запрашиваем данные через WS
    if (changes.show_history_tab?.newValue === true) {
        bg.requestHistoryFromWs();
    }
});


