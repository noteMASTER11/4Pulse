/** @typedef {import('./js/types.js').Settings} Settings */
/** @typedef {import('./js/types.js').DiagnosticsSnapshot} DiagnosticsSnapshot */
/** @typedef {import('./js/types.js').AppState} AppState */
// background.js - Chrome Extension MV3 Service Worker
import {CS, SETTINGS} from './js/cs.js';
import {open_url, setBlinkBadge} from './js/browser.js';
import {getLogDatetime, fetch4} from "./js/utils.js";
import { fetchWithRetry, fetchText } from "./js/fetcher.js";
import {registerWsKeepAlive} from "./js/ws.js";
import {
    canFetchRadioMetadata,
    canPollIcyMetadata,
    isRadioRecordStream,
    matchRadioRecordStation,
    normalizeRadioRecordImage,
    normalizeRadioUrl,
} from "./js/features/radio/metadata.js";
import {
    buildAttentionCenter,
    buildFavoritesCleanup,
    buildMorningDigest,
    buildSmartInsights,
} from "./js/features/diagnostics/insights.js";
import { createRadioMessageRouter } from "./js/features/radio/messages.js";
import { createFoundationMessageRouter } from "./js/features/foundation/messages.js";
import { FOUNDATION_BACKUP_KEYS, getFoundationProfile } from "./js/features/foundation/profiles.js";
import { createBookmarkMessageRouter } from "./js/features/bookmarks/messages.js";
import { createTicketMessageRouter } from "./js/features/tickets/messages.js";
import { createSmileyMessageRouter } from "./js/features/smileys/messages.js";
import { createAvatarMessageRouter } from "./js/features/avatar/messages.js";
import { createNavigationMessageRouter } from "./js/features/navigation/messages.js";
import { createPopupMessageRouter } from "./js/features/popup/messages.js";
import { createContentMessageRouter } from "./js/features/content/messages.js";
import { createFavoritesPortHandler } from "./js/features/favorites/ports.js";
import { createContextMenuService } from "./js/features/context-menu/service.js";
import { ALARM_NAMES, calculatePollingSchedule, createBackgroundAlarmHandler, shouldEnableTicketQuickPoll } from "./js/features/alarms/service.js";

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

const ALARM_NAME = ALARM_NAMES.periodicUpdate;
const RADIO_KEEPALIVE_ALARM = ALARM_NAMES.radioKeepalive;
const TICKET_QUICK_POLL_ALARM = ALARM_NAMES.ticketQuickPoll;
/**
 * Интервал HTTP-polling когда WS подключён (минуты).
 * Только редкая сверка состояния — на случай пропущенного push при реконнекте.
 */
const WS_FALLBACK_INTERVAL_MIN = 15;
const bg = new CS();

const DEBUG = () => globalThis.__FOURPULSE_DEBUG__ === true;
function debugLog(...args) { if (DEBUG()) console.log(...args); }
function debugWarn(...args) { if (DEBUG()) console.warn(...args); }


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

// 🧱 4Pulse 2.0 Foundation helpers
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
  const cfg = getFoundationProfile(profile, ticketsAllowed);
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
  const wsAlarm = await chrome.alarms.get(ALARM_NAMES.wsKeepalive).catch(()=>null);
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
const ICY_POLL_ALARM = ALARM_NAMES.icyPoll;

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
const BLINK_ALARM = ALARM_NAMES.priorityBlink;
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

const contextMenuService = createContextMenuService({
    api: chrome.contextMenus,
    loadState: () => chrome.storage.local.get(['tickets_enabled', 'tickets_unlocked', 'ui_language']),
    actions: {
        'update.all': () => { addEventLog('action', 'Контекстное меню: обновить всё', 'info'); return bg.update(true); },
        'open.qms': () => open_url('https://4pda.to/forum/index.php?act=qms', true, false),
        'open.favorites': () => open_url('https://4pda.to/forum/index.php?act=fav', true, false),
        'open.mentions': () => open_url('https://4pda.to/forum/index.php?act=mentions', true, false),
        'open.tickets': () => open_url('https://4pda.to/forum/index.php?act=ticket', true, false),
        'open.site': () => open_url('https://4pda.to/forum/', true, false),
        'open.auth': () => open_url('https://4pda.to/forum/index.php?act=auth', true, false),
        'open.profile': () => open_url(bg.user_id ? `https://4pda.to/forum/index.php?showuser=${bg.user_id}` : 'https://4pda.to/forum/index.php?act=auth', true, false),
        'open.options': () => open_url(chrome.runtime.getURL('/html/options.html?section=fourpulse'), true, true),
        'open.diagnostics': () => open_url(chrome.runtime.getURL('/html/options.html?section=diagnostics#diagnostics'), true, true),
    },
    onError: error => debugWarn('[4Pulse] context menu operation failed:', error),
});
async function createContextMenus() { return contextMenuService.refresh(); }

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
        const current = await chrome.alarms.get(ALARM_NAMES.silentDoctor).catch(() => null);
        if (!current) chrome.alarms.create(ALARM_NAMES.silentDoctor, { periodInMinutes: 5 });
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

    const schedule = calculatePollingSchedule({
        state: stored,
        wsConnected: bg.wsConnected,
        intervalSeconds: SETTINGS.interval,
        wsFallbackMinutes: WS_FALLBACK_INTERVAL_MIN,
    });
    const delayMinutes = schedule.delayInMinutes;
    const finalInterval = schedule.periodInMinutes;
    if (schedule.recentlyLimited) debugWarn(`🛡️ Защитный режим: множитель увеличен до ${schedule.multiplier}x из-за недавних лимитов`);
    debugLog(`[Alarm] polling каждые ${finalInterval.toFixed(1)} мин (${bg.wsConnected ? 'WS fallback' : 'normal'})`);

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
        if (shouldEnableTicketQuickPoll(st)) {
            chrome.alarms.create(TICKET_QUICK_POLL_ALARM, { periodInMinutes: 3 });
        } else {
            chrome.alarms.clear(TICKET_QUICK_POLL_ALARM).catch(() => {});
        }
    } catch (_) {}
}

async function pollRadioMetadataAlarm() {
    if (!radioState.isPlaying || !radioState.station || !canFetchRadioMetadata(radioState.station)) {
        await chrome.alarms.clear(ICY_POLL_ALARM).catch(() => {});
        return;
    }
    const seq = _radioMetaSeq;
    const stationAtStart = radioState.station;
    const stationNameAtStart = radioState.stationName;
    const meta = await fetchRadioMetadata(stationAtStart, stationNameAtStart).catch(() => null);
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
}

async function keepRadioAliveAlarm() {
    if (!radioState.isPlaying || !radioState.station) return;
    try {
        const result = await sendRadioOffscreenCommand({ cmd: 'state' });
        if (!result?.isPlaying) await radioPlay();
    } catch {
        await radioPlay().catch(() => {});
    }
}

const handleBackgroundAlarm = createBackgroundAlarmHandler({
    queryIdle: seconds => new Promise(resolve => chrome.idle.queryState(seconds, resolve)),
    update: force => bg.update(force),
    applyBlinkPhase: _applyBlinkPhase,
    loadTicketState: () => chrome.storage.local.get(['tickets_enabled', 'tickets_unlocked']),
    syncTicketQuickPoll: syncTicketQuickPollAlarm,
    updateTickets: force => bg.tickets.update(force),
    updateAction: () => bg.update_action(),
    runDoctor: foundationRunDoctor,
    isWsConnected: () => bg.wsConnected,
    pollRadioMetadata: pollRadioMetadataAlarm,
    keepRadioAlive: keepRadioAliveAlarm,
    onError: (error, alarm) => debugWarn(`[BG] alarm ${alarm?.name} failed:`, error),
});
chrome.alarms.onAlarm.addListener(handleBackgroundAlarm);

// Listen for backoff state changes - merged below with main storage listener


chrome.contextMenus.onClicked.addListener(info => { contextMenuService.handleClick(info.menuItemId); });

const routeRadioMessage = createRadioMessageRouter({
    getState: getRadioPublicState,
    play: radioPlay,
    pause: radioPause,
    setVolume: radioSetVolume,
    setEnabled: async enabled => {
        radioState.enabled = enabled;
        if (enabled) await saveRadioState();
        else await radioPause();
    },
    setSleepTimer: radioSetSleepTimer,
    getHistory: async () => (await chrome.storage.local.get('radio_history')).radio_history || [],
    clearHistory: () => chrome.storage.local.set({ radio_history: [] }),
});

const routeFoundationMessage = createFoundationMessageRouter({
    applyProfile: foundationApplyProfile,
    createBackup: foundationCreateBackup,
    restoreLatestBackup: foundationRestoreLatestBackup,
    runDoctor: foundationRunDoctor,
    clearEventLog,
    runSelfHeal,
    getDiagnosticsSnapshot,
    setSmartSilence,
    clearSmartSilence,
    getAttentionSnapshot: () => {
        const envelope = buildPopupEnvelope();
        return {
            attention: envelope.attention,
            digest: envelope.morning_digest,
            cleanup: envelope.favorites_cleanup,
        };
    },
});

const routeBookmarkMessage = createBookmarkMessageRouter({
    deleteBookmark: id => bg.deleteBookmark(id),
    renameBookmark: (id, title) => bg.renameBookmark(id, title),
    addBookmark: (title, url, parentId) => bg.addBookmark(title, url, parentId),
    addFolder: (title, parentId) => bg.addFolder(title, parentId),
});

const routeTicketMessage = createTicketMessageRouter({
    tickets: bg.tickets,
    updateAction: () => bg.update_action(),
    fetchWithRetry,
    fetchText,
});

const routeSmileyMessage = createSmileyMessageRouter({
    saveCatalog: catalog => chrome.storage.local.set({ pda_smileys_catalog_v1: catalog }),
});

const routeAvatarMessage = createAvatarMessageRouter({
    lookupAuthorAvatar,
    refreshUserAvatar: force => bg.refreshUserAvatar(force),
    getCurrentAvatar: () => bg.user_avatar,
    getAvatarFromPage: getAvatarFromOpen4pdaTabs,
    cacheAvatarAsDataUrl: cacheAvatarUrlAsDataUrl,
    saveUserAvatar: (avatar, source) => chrome.storage.local.set({
        cached_user_avatar: avatar,
        cached_user_avatar_source: source,
    }).catch(() => {}),
});

const routeNavigationMessage = createNavigationMessageRouter({
    getUserId: () => bg.user_id,
    getDefaultActive: () => SETTINGS.toolbar_open_theme_hide,
    getOptionsUrl: () => chrome.runtime.getURL('/html/options.html?section=fourpulse'),
    openUrl: open_url,
    qms: bg.qms,
    favorites: bg.favorites,
    mentions: bg.mentions,
    updateAction: () => bg.update_action(),
});

const routePopupMessage = createPopupMessageRouter({
    settings: SETTINGS,
    loadSettings: keys => chrome.storage.local.get(keys),
    getUserId: () => bg.user_id,
    buildEnvelope: buildPopupEnvelope,
    openAuth: () => open_url('https://4pda.to/forum/index.php?act=auth'),
    forceUpdate: () => bg.update(true),
    startBlink: startPriorityBlink,
    stopBlink: stopPriorityBlink,
    markFavoriteAsRead: id => bg.favorites.do_read(id),
    getFocusedTopics: async () => (await chrome.storage.local.get(['focused_topics'])).focused_topics || [],
    getFavorites: () => bg.favorites.list,
    getFavoriteById: id => bg.favorites._list[id],
    getCounts: () => ({
        favorites: bg.favorites.count,
        qms: bg.qms.count,
        mentions: bg.mentions.count,
    }),
    updateAction: () => bg.update_action(),
    requestHistory: () => bg.requestHistoryFromWs(),
});

const routeContentMessage = createContentMessageRouter({
    fetchQmsSubject: opponentId => bg.qms.fetchDialogSubject(opponentId),
    fetchPage: (url, options) => fetch4(url, options),
    getForumTabs: () => chrome.tabs.query({ url: 'https://4pda.to/forum/*' }),
    sendTabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
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

    if (routeRadioMessage(message, sendResponse)) return true;
    if (routeFoundationMessage(message, sendResponse)) return true;
    if (routeBookmarkMessage(message, sendResponse)) return true;
    if (routeTicketMessage(message, sendResponse)) return true;
    if (routeSmileyMessage(message, sendResponse)) return true;
    if (routeAvatarMessage(message, sendResponse)) return true;
    if (routeNavigationMessage(message, sendResponse)) return true;
    if (routePopupMessage(message, sendResponse)) return true;
    if (routeContentMessage(message, sendResponse)) return true;
});

const handleFavoritesPort = createFavoritesPortHandler({
    getFavorites: () => bg.favorites.list,
    getPinnedFavorites: () => bg.favorites.list_pin,
    getCount: () => bg.favorites.count,
    getOpenLimit: () => SETTINGS.open_themes_limit,
    onError: error => debugWarn('Favorites port operation failed:', error),
});
chrome.runtime.onConnect.addListener(port => { handleFavoritesPort(port); });

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


