// background.js - Chrome Extension MV3 Service Worker
import {CS, SETTINGS} from './js/cs.js';
import {open_url} from './js/browser.js';
import {getLogDatetime, fetch4} from "./js/utils.js";
import {registerWsKeepAlive} from "./js/ws.js";

// 🛡️ Global error handlers
self.addEventListener('unhandledrejection', (event) => {
    console.error('🚨 Unhandled promise rejection:', {
        reason: event.reason,
        promise: event.promise
    });
    event.preventDefault(); // Prevent extension crash
});

self.addEventListener('error', (event) => {
    console.error('🚨 Global error:', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
    });
});

const ALARM_NAME = 'periodicUpdate';
const RADIO_KEEPALIVE_ALARM = 'radioKeepalive'; // ★ FIX: держит аудио живым при выгрузке фона
/**
 * Интервал HTTP-polling когда WS подключён (минуты).
 * Только редкая сверка состояния — на случай пропущенного push при реконнекте.
 */
const WS_FALLBACK_INTERVAL_MIN = 15;
const bg = new CS();

// 🔊 Audio cache for better performance
const audioCache = {};

// ════════════════════════════════════════════════════════
// 🎵 RADIO — persistent audio player in background
// ════════════════════════════════════════════════════════
let radioAudio = null;
let radioState = {
    enabled:      false,
    isPlaying:    false,
    station:      '',
    stationName:  '',
    volume:       0.7,
    lastError:    '',  // ★ FIX: сохраняем последнюю ошибку для отображения в UI
    currentTrack: '',  // 🎵 ICY StreamTitle — "Artist - Title"
    trackArt:     '',  // 🖼 album art URL (iTunes)
    sleepEndsAt:  0,   // ⏱ timestamp таймера сна (0 = выкл)
};
let _icyPollTimer = null;
let _sleepTimerId = null;

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

function getOrCreateRadioAudio() {
    if (!radioAudio) {
        radioAudio = new Audio();
        radioAudio.preload = 'none';     // не буферизовать до явного play()
        radioAudio.volume = radioState.volume;

        // ── Обработка ошибок ────────────────────────────────
        radioAudio.onerror = (e) => {
            const code = e?.target?.error?.code;
            const errMsg = code === 2 ? 'Ошибка сети — поток недоступен'
                         : code === 3 ? 'Ошибка декодирования потока'
                         : code === 4 ? 'Станция не отвечает или формат не поддерживается'
                         : 'Поток недоступен';
            console.warn('🎵 Radio stream error:', errMsg);
            radioState.isPlaying = false;
            radioState.lastError = errMsg; // ★ FIX
            saveRadioState();
            broadcastRadioState();
        };

        // ── Stall detection — поток завис, данные не идут ────
        radioAudio.onstalled = () => {
            console.warn('🎵 Radio stream stalled');
        };

        // ── Абсолютный watchdog: если за 15с не пошёл звук — сбрасываем ──
        radioAudio.onloadstart = () => {
            clearTimeout(radioAudio._watchdog);
            radioAudio._watchdog = setTimeout(() => {
                if (radioAudio && radioAudio.readyState < 2 && radioState.isPlaying) {
                    console.warn('🎵 Radio watchdog: no data after 15s — aborting');
                    try { radioAudio.pause(); radioAudio.removeAttribute('src'); radioAudio.load(); } catch(_) {}
                    radioState.isPlaying = false;
                    radioState.lastError = 'Нет ответа от станции (15с)'; // ★ FIX
                    saveRadioState();
                    broadcastRadioState();
                }
            }, 15000);
        };

        // ── Очищаем watchdog когда данные пошли ──
        radioAudio.onplaying = () => {
            clearTimeout(radioAudio._watchdog);
            radioState.lastError = ''; // ★ FIX: сброс ошибки при успешном воспроизведении
            broadcastRadioState();
            startIcyPolling(); // 🎵 запускаем опрос метаданных
        };
    }
    return radioAudio;
}

function broadcastRadioState() {
    chrome.runtime.sendMessage({ action: 'radio_state', state: getRadioPublicState() }).catch(()=>{});
}

function getRadioPublicState() {
    return {
        enabled:     radioState.enabled,
        isPlaying:   radioState.isPlaying,
        station:     radioState.station,
        stationName: radioState.stationName,
        volume:      Math.round(radioState.volume * 100),
        lastError:   radioState.lastError || '',  // ★ FIX: передаём ошибку в popup
        currentTrack: radioState.currentTrack || '',
        trackArt:    radioState.trackArt || '',
        sleepEndsAt: radioState.sleepEndsAt || 0,
    };
}

async function radioPlay(stationUrl, stationName) {
    if (stationUrl) {
        radioState.station     = stationUrl;
        radioState.stationName = stationName || '';
    }
    if (!radioState.station) return;
    const audio = getOrCreateRadioAudio();

    // Сбросить предыдущий поток, если URL сменился
    if (audio.src !== radioState.station) {
        audio.pause();
        audio.src = radioState.station;
    }
    audio.volume = radioState.volume;
    try {
        // Race play() против таймаута — защита от мёртвых серверов
        const playPromise = audio.play();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout (12s)')), 12000)
        );
        await Promise.race([playPromise, timeoutPromise]);
        radioState.isPlaying = true;
        radioState.lastError = ''; // ★ FIX: сброс ошибки при успехе
    } catch(e) {
        console.warn('🎵 Radio play error (attempt 1):', e.message || e);

        // ★ FIX: HTTPS на нестандартном порту часто блокируется из фонового скрипта
        // расширения из-за недоверенного TLS-сертификата. Пробуем HTTP-версию.
        const httpsUrl = radioState.station;
        if (httpsUrl.startsWith('https://')) {
            const httpUrl = 'http://' + httpsUrl.slice(8);
            console.warn('🎵 Retrying with HTTP fallback:', httpUrl);
            try {
                audio.pause();
                audio.src = httpUrl;
                const playPromise2 = audio.play();
                const timeoutPromise2 = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Connection timeout (12s)')), 12000)
                );
                await Promise.race([playPromise2, timeoutPromise2]);
                radioState.isPlaying = true;
                radioState.lastError = '';
                await saveRadioState();
                broadcastRadioState();
                return;
            } catch(e2) {
                console.error('🎵 HTTP fallback also failed:', e2.message || e2);
            }
        }

        try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch(_) {}
        radioState.isPlaying = false;

        // Более информативное сообщение об ошибке
        const msg = e.message || '';
        if (msg.includes('timeout') || msg.includes('Timeout')) {
            radioState.lastError = 'Нет ответа от станции (таймаут)';
        } else if (msg.includes('SSL') || msg.includes('TLS') || msg.includes('certificate') || msg.includes('net::ERR_CERT')) {
            radioState.lastError = 'Ошибка TLS-сертификата станции';
        } else {
            radioState.lastError = 'Станция не отвечает или формат не поддерживается';
        }
    }
    await saveRadioState();
    broadcastRadioState();
    if (radioState.isPlaying) startRadioKeepalive(); // ★ FIX: держим фон живым
}

async function radioPause() {
    if (radioAudio) radioAudio.pause();
    radioState.isPlaying = false;
    stopRadioKeepalive(); // ★ FIX: останавливаем keepalive
    stopIcyPolling(); // 🎵 останавливаем опрос
    await saveRadioState();
    broadcastRadioState();
}

async function radioSetVolume(pct) {
    radioState.volume = Math.max(0, Math.min(1, pct / 100));
    if (radioAudio) radioAudio.volume = radioState.volume;
    await saveRadioState();
}

// ════════════════════════════════════════════════════════
// 🎵 ICY METADATA — читаем название трека из потока
// ════════════════════════════════════════════════════════
async function fetchIcyMetadata(url) {
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
        return match ? match[1].trim() : null;
    } catch(e) { return null; }
}

// 🖼 ALBUM ART — пробуем несколько источников по очереди
async function fetchTrackArt(trackTitle) {
    if (!trackTitle) return '';

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
            { signal: AbortSignal.timeout(5000) }
        );
        const d = await r.json();
        const art = d?.results?.[0]?.artworkUrl100;
        if (art) return art.replace('100x100bb', '600x600bb');
    } catch(e) {}

    // 2️⃣ MusicBrainz + Cover Art Archive — работает для кириллицы
    if (hasDash) {
        try {
            const mbQ = encodeURIComponent(`recording:"${track}" AND artist:"${artist}"`);
            const mbR = await fetch(
                `https://musicbrainz.org/ws/2/recording?query=${mbQ}&limit=1&fmt=json`,
                { headers: { 'User-Agent': '4Pulse/1.0 (firefox-extension)' },
                  signal: AbortSignal.timeout(5000) }
            );
            const mbD = await mbR.json();
            const releaseId = mbD?.recordings?.[0]?.releases?.[0]?.id;
            if (releaseId) {
                const caR = await fetch(
                    `https://coverartarchive.org/release/${releaseId}/front-250`,
                    { signal: AbortSignal.timeout(5000) }
                );
                if (caR.ok) return caR.url; // CAA redirects к реальному URL
            }
        } catch(e) {}
    }

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
    // ★ FIX: используем chrome.alarms вместо setInterval — алармы переживают выгрузку event page
    chrome.alarms.create(ICY_POLL_ALARM, { periodInMinutes: 0.35 }); // ~21 сек
    // Первый опрос сразу через 3 сек
    setTimeout(async () => {
        if (!radioState.isPlaying || !radioState.station) return;
        const title = await fetchIcyMetadata(radioState.station);
        if (title) {
            radioState.currentTrack = title;
            addToRadioHistory(title, radioState.stationName);
            radioState.trackArt = await fetchTrackArt(title);
            broadcastRadioState();
        }
    }, 3000);
}

function stopIcyPolling() {
    if (_icyPollTimer) { clearInterval(_icyPollTimer); _icyPollTimer = null; }
    chrome.alarms.clear(ICY_POLL_ALARM).catch(() => {});
    radioState.currentTrack = '';
    radioState.trackArt = '';
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
            'dnd_enabled', 'dnd_from', 'dnd_to', 'dnd_days', 'dnd_allow_mentions'
        ]);
        if (!s.dnd_enabled) return false;

        // Упоминания пробиваются сквозь DND если включена опция
        if (type === 'mentions' && s.dnd_allow_mentions) return false;

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
async function playNotificationSound(type) {
    try {
        // 🌙 Не играть звук в режиме DND
        if (await isDndActive(type)) return;

        // Check if sound is enabled for this type
        const settings = await chrome.storage.local.get([
            'sound_qms', 'sound_themes', 'sound_themes_all_comments', 'sound_mentions',
            'sound_file_qms', 'sound_file_themes', 'sound_file_mentions',
            'sound_volume'
        ]);
        
        // Check if this type of sound is enabled
        const soundEnabled = {
            'qms': settings.sound_qms,
            'themes': settings.sound_themes,
            'themes_comment': settings.sound_themes_all_comments,
            'mentions': settings.sound_mentions
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
        };
        const soundFile = soundFileMap[type] || 'notify';
        const volume = (settings.sound_volume !== undefined ? settings.sound_volume : 50) / 100;
        
        
        // Firefox: Use Audio API directly (works in background pages)
        const soundUrl = chrome.runtime.getURL(`sounds/${soundFile}.ogg`);
        
        // Create or reuse audio element
        if (!audioCache[soundFile]) {
            audioCache[soundFile] = new Audio(soundUrl);
        }
        
        const audio = audioCache[soundFile];
        audio.volume = Math.max(0, Math.min(1, volume)); // Clamp to 0-1
        
        // Reset to start if already playing
        audio.currentTime = 0;
        
        // Play sound
        await audio.play();
        
        
    } catch (error) {
        console.error('🔊 Failed to play notification sound:', error);
    }
}

// 🔊 Export for use in other modules
globalThis.playNotificationSound = playNotificationSound;
globalThis.isDndActive = isDndActive;

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
    bg.update_action();
}

function _applyBlinkPhase() {
    if (!_priorityBlinking) return;
    _priorityBlinkPhase = !_priorityBlinkPhase;
    if (_priorityBlinkPhase) {
        // RED — visible against ANY accent color (orange, blue, purple, teal)
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
        chrome.action.setBadgeText({ text: '!!' }).catch(() => {});
    } else {
        bg.update_action();
    }
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

// Initialize alarm on install
chrome.runtime.onInstalled.addListener(reason => {
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
    
    // Create context menu
    chrome.contextMenus.create({
        title: '4Pulse: Принудительное обновление',
        id: 'update.all',
        contexts: ["action"],
        icons: { '16': 'img/icons/icon_48.png', '32': 'img/icons/icon_48.png' },
    });
    
    // Initialize alarm immediately
    initializeAlarm();
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
    
    // Восстанавливаем авторежим: alarm создаётся всегда — он управляет фоновым обновлением
    // auto_mode_active в storage используется только для popup-polling
    const stored = await chrome.storage.local.get(['auto_mode_active']);
    initializeAlarm();
});

// Function to create/update the alarm with current backoff multiplier
async function initializeAlarm() {
    // Clear existing alarm first
    chrome.alarms.clear(ALARM_NAME, async (wasCleared) => {
        
        const stored = await chrome.storage.local.get([
            'backoff_multiplier',
            'backoff_until',
            'is_429_active',
            'last_429_time'
        ]);

        const now = Date.now();
        let multiplier = stored.backoff_multiplier || 1.0;

        // Если был недавний бан (менее 15 мин назад) — принудительно замедляемся
        if (stored.is_429_active || (stored.last_429_time && (now - stored.last_429_time < 900000))) {
            multiplier = Math.max(multiplier, 5.0);
            console.warn(`🛡️ Защитный режим: множитель увеличен до ${multiplier}x из-за недавних лимитов`);
        }

        let finalInterval;

        // 🔌 WS жив → редкий fallback-интервал, не нагружаем Cloudflare зря
        if (bg.wsConnected) {
            finalInterval = WS_FALLBACK_INTERVAL_MIN;
            console.log(`[Alarm] WS активен — polling каждые ${finalInterval} мин (fallback)`);
        } else {
            // WS недоступен → обычный polling с backoff
            // Chrome MV3 минимум — 1 минута
            const baseInterval = Math.max(SETTINGS.interval / 60, 1.0);
            const backoffInterval = baseInterval * multiplier;

            // Jitter ±20% для рандомизации паттерна запросов
            const jitter = backoffInterval * 0.2 * (Math.random() * 2 - 1);
            finalInterval = Math.max(backoffInterval + jitter, 1.0);
            console.log(`[Alarm] WS недоступен — polling каждые ${finalInterval.toFixed(1)} мин (normal)`);
        }

        // Запуск через 10 сек после старта — успеваем до того, как WS
        // соединится и перепишет alarm на 15-минутный fallback.
        // Так гарантированно делаем первый HTTP-чек при каждом старте браузера.
        let delayMinutes = stored.backoff_until > now
            ? Math.max((stored.backoff_until - now) / 60000, 1.0)
            : 0.17;  // ~10 секунд
        
        // Create new alarm
        chrome.alarms.create(ALARM_NAME, {
            delayInMinutes: delayMinutes,
            periodInMinutes: finalInterval
        });
        
    });
}

// 🔌 Экспортируем initializeAlarm глобально, чтобы cs.js мог вызвать
// пересоздание alarm при смене статуса WS (connect/disconnect).
globalThis.reinitializeAlarm = initializeAlarm;

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
    // 🔌 WS keep-alive: при каждом alarm проверяем состояние WS.
    // Если WS отвалился (SW перезапустился, сеть мигнула) — bg.update()
    // обнаружит что WS не подключён и запустит переподключение.
    // Это решает проблему "уведомления только при ручном обновлении".
    if (alarm.name === '4pulse_ws_keepalive') {
        if (bg && !bg.wsConnected) {
            console.log('[BG] Keep-alive: WS не подключён — запускаем update()');
            bg.update();
        }
    }
    // ★ FIX: ICY metadata polling через alarm (вместо setInterval)
    if (alarm.name === ICY_POLL_ALARM) {
        if (!radioState.isPlaying || !radioState.station) return;
        fetchIcyMetadata(radioState.station).then(async title => {
            if (title && title !== radioState.currentTrack) {
                radioState.currentTrack = title;
                addToRadioHistory(title, radioState.stationName);
                radioState.trackArt = await fetchTrackArt(title);
                broadcastRadioState();
            }
        }).catch(() => {});
    }
    // ★ FIX: Radio keepalive — проверяем и восстанавливаем воспроизведение
    if (alarm.name === RADIO_KEEPALIVE_ALARM) {
        if (radioState.isPlaying && radioState.station) {
            const audio = radioAudio;
            if (!audio || audio.paused || audio.ended || audio.readyState === 0) {
                console.log('[Radio] Keepalive: аудио остановилось — перезапускаем');
                radioPlay().catch(() => {});
            }
        }
    }
});

// Listen for backoff state changes - merged below with main storage listener

chrome.idle.onStateChanged.addListener(newState => {
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    switch (info.menuItemId) {
        case 'update.all':
            bg.update(true); // Force refresh with full HTML fetch
            break;
    }
});

// Listen for messages from popup or other extension parts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[BG] onMessage:', message?.action, message);

    // Bookmark operations — handled before switch to avoid any JS lexical issues
    if (message.action === 'bookmark_delete') {
        console.log('[BG] bookmark_delete id=', message.id, 'typeof bg.deleteBookmark=', typeof bg.deleteBookmark);
        bg.deleteBookmark(message.id)
            .then(ok => { console.log('[BG] delete ok=', ok); sendResponse({ ok }); })
            .catch(e => { console.error('[BG] delete error:', e); sendResponse({ ok: false }); });
        return true;
    }
    if (message.action === 'bookmark_rename') {
        console.log('[BG] bookmark_rename id=', message.id, 'title=', message.title, 'typeof bg.renameBookmark=', typeof bg.renameBookmark);
        bg.renameBookmark(message.id, message.title)
            .then(ok => { console.log('[BG] rename ok=', ok); sendResponse({ ok }); })
            .catch(e => { console.error('[BG] rename error:', e); sendResponse({ ok: false }); });
        return true;
    }
    if (message.action === 'bookmark_add') {
        console.log('[BG] bookmark_add title=', message.title, 'url=', message.url, 'parentId=', message.parentId);
        bg.addBookmark(message.title, message.url, message.parentId ?? 0)
            .then(ok => { console.log('[BG] bookmark_add ok=', ok); sendResponse({ ok }); })
            .catch(e => { console.error('[BG] bookmark_add error:', e); sendResponse({ ok: false }); });
        return true;
    }
    if (message.action === 'folder_add') {
        console.log('[BG] folder_add title=', message.title, 'parentId=', message.parentId);
        bg.addFolder(message.title, message.parentId ?? 0)
            .then(ok => { console.log('[BG] folder_add ok=', ok); sendResponse({ ok }); })
            .catch(e => { console.error('[BG] folder_add error:', e); sendResponse({ ok: false }); });
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

        case 'popup_loaded':
            // Stop blink when user opens popup
            stopPriorityBlink();
            if (bg.user_id) {
                sendResponse(bg.popup_data);
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
                        sendResponse(bg.popup_data);
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
                    return open_url(chrome.runtime.getURL('/html/options.html'), true, true);
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
                        }).catch(err => { console.warn('Error opening favorite:', err); });
                    break;

                case 'bookmarks':
                    return open_url('https://4pda.to/forum/index.php?act=fav', true, false);

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
                    console.warn('Error opening ticket:', err);
                    sendResponse({ ok: false });
                });
            return true;

        case 'open_ticket_source':
            bg.tickets.openSource(message['id'], !!message['sidebar'])
                .then(result => {
                    sendResponse({ ok: true, count: bg.tickets.count });
                })
                .catch(err => {
                    console.warn('Error opening ticket source:', err);
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
                    console.warn('Error changing ticket status:', err);
                    sendResponse({ ok: false });
                });
            return true;

        case 'ticket_mark_viewed':
            bg.tickets.markAsViewed(message['id'])
                .then(() => { bg.update_action(); sendResponse({ ok: true }); })
                .catch(err => { console.warn('Error marking ticket viewed:', err); sendResponse({ ok: false }); });
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

            fetch(`https://4pda.to/forum/index.php?act=ticket&s=thread&`, {
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
            fetch(threadUrl, {
                credentials: 'include',
                referrerPolicy: 'no-referrer-when-downgrade',
            })
            .then(async res => {
                if (!res.ok) { sendResponse({ ok: false }); return; }
                const buf  = await res.arrayBuffer();
                const html = new TextDecoder('windows-1251').decode(buf);

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

        case 'tickets_refresh':
            bg.tickets.update(true)
                .then(() => {
                    bg.update_action();
                    sendResponse({ count: bg.tickets.count, list: bg.tickets.list });
                })
                .catch(err => {
                    console.warn('Error refreshing tickets:', err);
                    sendResponse({ count: 0, list: [] });
                });
            return true;
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
            console.warn('Port disconnected, cannot send message:', e);
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
                    .catch(err => console.warn('Error opening theme:', err));
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
                    .catch(err => console.warn('Error opening pinned theme:', err));
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
            .then(([tab, entity]) => {
                // 🔧 FIX: Firefox requires tabs.update(active) + windows.update(focused)
                // Using only windows.update is not enough to bring FF to foreground.
                return chrome.tabs.update(tab.id, { active: true })
                    .then(() => chrome.windows.update(tab.windowId, { focused: true }));
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
});
