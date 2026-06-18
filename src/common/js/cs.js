
const DEBUG = () => globalThis.__FOURPULSE_DEBUG__ === true;
function debugLog(...args) { if (DEBUG()) console.log(...args); }
function debugWarn(...args) { if (DEBUG()) console.warn(...args); }

/** @typedef {import('./types.js').Settings} Settings */
/** @typedef {import('./types.js').DiagnosticsSnapshot} DiagnosticsSnapshot */
/** @typedef {import('./types.js').AppState} AppState */
import { parse_response, fetch4, getLogDatetime, FETCH_TIMEOUT, encodeWin1251 } from "./utils.js";
import { Favorites } from "./e/favorites.js";
import { Mentions } from "./e/mentions.js";
import { QMS } from "./e/qms.js";
import { Tickets } from "./e/tickets.js";
import { History } from "./e/history.js";
import { print_count, print_logout, print_unavailable } from "./browser.js";
import { createWsClient, WsEventType } from "./ws.js";

const PARSE_APPBK_REGEXP = /u\d+:\d+:\d+:(\d+)/;

export let SETTINGS = {
    notification_qms_level: 10,
    notification_themes_level: 10,
    notification_mentions_level: 20,
    toolbar_pin_themes_level: 0,
    toolbar_open_theme_hide: false,  // 🔧 FIXED: Changed from true to false
    toolbar_button_open_all: true,
    toolbar_button_pinned: true,
    toolbar_button_read_all: true,
    toolbar_simple_list: false,
    toolbar_default_view: 'favorites',  // 🔧 FIXED: Changed from 'collapsed' to 'favorites'
    show_all_favorites: false,
    show_all_qms: false,
    show_all_mentions: false,
    open_themes_limit: 5,
    interval: 900,  // 900 секунд (15 мин) — дефолт v1.5.2; WS делает polling fallback'ом
    open_in_current_tab: false,  // Open links in current tab instead of new tabs
    open_new_tab_foreground: false,  // Open new tabs in foreground when not using current tab
    bw_icons: false,  // 🆕 NEW: Black & white icons
    mirror_mode: false,  // 🆕 NEW: Mirror popup layout (icons on right)
    accent_color: 'blue',  // 🆕 NEW: Accent color (blue/green)
    compact_mode: false,  // 🆕 NEW: Компактный режим карточек
    show_bookmarks_tab: false,  // 🆕 v1.5.2: Показывать плитку и вкладку Закладок
    show_history_tab: false,    // 🆕 v1.8.4: Показывать вкладку «История» (последние просмотры)
    primary_click_action: 'forum',  // 🆕 NEW: 'forum' | 'popup' — действие ЛКМ на плитку
    compact_stats: false,          // 🆕 NEW: Горизонтальная компактная статистика
    compact_hide_qms: false,       // Скрыть плитку QMS в компактном режиме
    compact_hide_favorites: false, // Скрыть плитку Избранного в компактном режиме
    compact_hide_mentions: false,  // Скрыть плитку Упоминаний в компактном режиме
    compact_only_stats: false,     // Показывать только статистику (без списка тем)
    compact_show_topics: false,    // Показывать темы в режиме only_stats
    show_fav_toolbar: true,        // Показывать тулбар сортировки/группировки
    show_topic_action_buttons: true, // Показывать быстрые действия в карточках тем
    popup_width: 360,              // Ширина попапа в пикселях
    max_visible_topics: 0,         // 🆕 NEW: 0 = без ограничения; N = показывать N строк
    // 🔊 Sound settings
    sound_qms: false,
    sound_themes: false,
    sound_themes_all_comments: false,
    sound_mentions: false,
    // 🆕 Отдельная мелодия для каждого типа уведомлений
    sound_file_qms: 'notify',
    sound_file_themes: 'notify',
    sound_file_mentions: 'notify',
    sound_volume: 50,
    // 🌙 DND — Режим «Не беспокоить»
    dnd_enabled: false,
    dnd_from: '23:00',
    dnd_to: '08:00',
    dnd_days: [0, 1, 2, 3, 4, 5, 6],
    dnd_allow_mentions: false,
    dnd_allow_qms: false,             // QMS могут пробивать DND
    dnd_allow_tickets: true,          // тикеты могут пробивать DND, если модераторский раздел включён
    dnd_mute_radio: false,            // приглушать радио в тихие часы
    // 🎫 Tickets (curator/moderator feature, hidden until unlocked)
    tickets_enabled: false,
    tickets_unlocked: false,   // becomes true after secret tap sequence
    notification_tickets_level: 20,
    sound_tickets: false,
    sound_file_tickets: 'notify',
    radio_playing: false,
    radio_station: '',
    radio_station_name: '',
    radio_volume: 70,
    // 🎨 Icon pack
    icon_pack: 'default',              // 'default' | 'emoji' | 'custom'
    // 🎬 Animations
    disable_topic_animations: false,   // отключить анимацию появления/мерцания тем
    // 📐 Layout
    popup_width_auto: false,           // авто-ширина попапа под контент
    attention_center_enabled: false,    // Центр внимания: выключен по умолчанию, чтобы не загромождать popup
    attention_center_mode: 'full',       // 'compact' | 'full'
    user_profile_mode: 'standard',      // 'standard' | 'moderator' | 'minimal' | 'radio'
    stable_mode: false,                  // отключает экспериментальные визуальные блоки
    silent_doctor_enabled: true,         // тихое автовосстановление polling/ws/cookie-state
    auto_backup_enabled: true,           // хранить последние автокопии настроек
    // 🔀 Tiles row config handled separately via tiles_row_config key (not in SETTINGS)
}

// Helper function to wait/sleep
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export class CS {
    #initialized = false;
    #update_in_process = false;
    #cookie_authorized = false;
    #available = true;
    #user_id = 0;
    #user_name = '';
    #user_avatar = ''; // URL аватара
    /** Таймер отложенной проверки тикетов после WS-событий */
    #ticketCheckTimer = null;
    
    #normalizeAvatarUrl(url) {
        if (!url) return '';
        let clean = String(url).trim().replace(/&amp;/g, '&').replace(/\\\//g, '/');
        clean = clean.replace(/^url\((['"]?)(.*?)\1\)$/i, '$2').trim();
        if (!clean || clean.startsWith('blob:')) return '';
        if (clean.startsWith('data:image/')) return clean;
        if (clean.startsWith('data:')) return '';
        if (clean.startsWith('//')) clean = 'https:' + clean;
        if (clean.startsWith('/')) clean = 'https://4pda.to' + clean;
        if (!/^https?:\/\//i.test(clean)) return '';
        // Не берём технические/пустые картинки — иначе в popup появляется белый круг.
        if (/(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon|logo|sprite|icon)/i.test(clean)) return '';
        return clean;
    }

    #scoreAvatarCandidate(url, context = '') {
        if (!url) return 0;
        const ctx = String(context || '').toLowerCase();
        const u = String(url || '').toLowerCase();
        let score = 0;
        if (/photo-thumb|photo[-_]/i.test(u)) score += 60;
        if (/\/s\/[^'"?<>]+\.(?:gif|png|jpe?g|webp)(?:$|[?#])/i.test(u)) score += 45;
        if (/avatar|userpic|profile/i.test(u)) score += 35;
        if (/uploads|forum\/uploads/i.test(u)) score += 20;
        if (this.#user_id && u.includes(String(this.#user_id))) score += 35;
        if (/avatar|аватар|photo|userpic|profile/i.test(ctx)) score += 35;
        if (/width=['"]?(?:[4-9]\d|\d{3,})/i.test(ctx) || /height=['"]?(?:[4-9]\d|\d{3,})/i.test(ctx)) score += 10;
        if (/smile|emoji|rank|group|warn|reputation|badge|button|icon/i.test(ctx + ' ' + u)) score -= 50;
        return score;
    }

    #extractAvatarFromHtml(html) {
        if (!html) return '';

        const candidates = [];
        const pushCandidate = (url, context, bonus = 0) => {
            const clean = this.#normalizeAvatarUrl(url);
            if (!clean) return;
            const score = this.#scoreAvatarCandidate(clean, context) + bonus;
            if (score > 0) candidates.push({ url: clean, score });
        };

        // Надёжный случай профиля 4PDA: .user-box .photo img.
        const photoBlocks = html.match(/<div[^>]+class=['"][^'"]*(?:user-box|photo)[^'"]*['"][\s\S]{0,2500}?(?:<\/div>\s*){1,3}/gi) || [];
        for (const block of photoBlocks) {
            const imgTags = block.match(/<img\b[^>]*>/gi) || [];
            for (const tag of imgTags) {
                const srcs = [...tag.matchAll(/(?:src|data-src|data-original|data-lazy-src)=['"]([^'"]+)['"]/gi)].map(m => m[1]);
                for (const u of srcs) pushCandidate(u, block + ' ' + tag, /alt=['"]Аватар['"]/i.test(tag) ? 180 : 140);
            }
        }

        const imgRegex = /<img\b[^>]*>/gi;
        let match;
        while ((match = imgRegex.exec(html))) {
            const tag = match[0];
            const context = html.slice(Math.max(0, match.index - 800), Math.min(html.length, match.index + 800));
            const attrs = [...tag.matchAll(/(?:src|data-src|data-original|data-lazy-src)=['"]([^'"]+)['"]/gi)].map(m => m[1]);
            const bonus = /photo|user-box|alt=['"]Аватар|title=['"]BrantX/i.test(context + ' ' + tag) ? 90 : 0;
            for (const a of attrs) pushCandidate(a, context + ' ' + tag, bonus);
            const srcset = tag.match(/srcset=['"]([^'"]+)['"]/i)?.[1] || '';
            for (const part of srcset.split(',')) pushCandidate(part.trim().split(/\s+/)[0], context + ' ' + tag, bonus);
        }

        const styleUrlRegex = /url\((['"]?)(https?:\/\/[^)'"\s]+|\/[^)'"\s]+|\/\/[^)'"\s]+)\1\)/gi;
        while ((match = styleUrlRegex.exec(html))) {
            const context = html.slice(Math.max(0, match.index - 250), Math.min(html.length, match.index + 250));
            pushCandidate(match[2], context, /photo|avatar|аватар|user-box/i.test(context) ? 80 : 0);
        }

        const directRegex = /https?:\/\/[^'"\s<>]+(?:photo-thumb|photo-|avatar|userpic|\/s\/)[^'"\s<>]+/gi;
        while ((match = directRegex.exec(html))) {
            const context = html.slice(Math.max(0, match.index - 250), Math.min(html.length, match.index + 250));
            pushCandidate(match[0], context, /photo|avatar|аватар|user-box/i.test(context) ? 80 : 0);
        }

        candidates.sort((a, b) => b.score - a.score);
        debugLog('[Avatar] HTML candidates:', candidates.slice(0, 3));
        return candidates[0]?.url || '';
    }


    async #avatarUrlToDataUrl(url) {
        try {
            if (!url || url.startsWith('data:image/')) return url || '';
            const r = await fetch(url, { credentials: 'include', cache: 'reload' });
            if (!r.ok) return '';
            const ct = (r.headers.get('content-type') || '').toLowerCase();
            if (!ct.startsWith('image/')) return '';
            const buf = await r.arrayBuffer();
            // Аватары маленькие; если вдруг сервер отдаст что-то большое, не кладём это в storage.
            if (!buf || buf.byteLength > 512 * 1024) return '';
            const bytes = new Uint8Array(buf);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            return `data:${ct.split(';')[0]};base64,${btoa(binary)}`;
        } catch (e) {
            debugWarn('Failed to cache avatar image:', e);
            return '';
        }
    }

    // Метод для загрузки аватара пользователя
    async #fetch_user_avatar(force = false) {
        if (!this.#user_id) return '';
        if (this.#user_avatar && !force) return this.#user_avatar;

        try {
            const response = await fetch(`https://4pda.to/forum/index.php?showuser=${this.#user_id}`, {
                credentials: 'include',
                cache: force ? 'reload' : 'default'
            });
            const html = await response.text();
            const avatarUrl = this.#extractAvatarFromHtml(html);

            if (avatarUrl) {
                const dataAvatar = await this.#avatarUrlToDataUrl(avatarUrl);
                this.#user_avatar = dataAvatar || avatarUrl;
                chrome.storage.local.set({
                    cached_user_avatar: this.#user_avatar,
                    cached_user_avatar_source: avatarUrl
                }).catch(() => {});
                return this.#user_avatar;
            }
        } catch (error) {
            console.error('Failed to fetch avatar:', error);
        }

        return '';
    }
    #last_event = 0;

    // 🔌 WebSocket real-time client (дополняет HTTP-polling, не заменяет его)
    /** @type {import('./ws.js').ForpdaWebSocket|null} */
    #ws = null;

    /** Полный список закладок из WS (все типы: папки, ссылки, темы) */
    #rawBookmarks = [];
    /** Сырые массивы от сервера — для round-trip syncBookmarksWs без потерь */
    #rawBookmarksRaw = [];
    /** Timestamp последней HTTP-операции с закладкой. WS-синк игнорируется в течение 60 сек */
    #bookmarkEditTime = 0;
    /** Локальные переопределения: удалённые и переименованные закладки (персистируются в storage) */
    #deletedBmIds  = new Set();
    #renamedBmMap  = new Map(); // id → newTitle
    #bookmarkPendingDrain = false;


    // 🚀 NEW: Exponential backoff state
    #rate_limit_count = 0;
    #backoff_multiplier = 1.0;
    #backoff_until = 0;
    #consecutive_successes = 0;
    // 🛡️ FIX: N/A только после 2+ подряд ошибок сети (одиночный таймаут — не причина)
    #consecutive_errors = 0;
    static #MAX_ERRORS_BEFORE_UNAVAILABLE = 3;

    constructor() {

        this.favorites = new Favorites(this);
        this.qms = new QMS(this);
        this.mentions = new Mentions(this);
        this.tickets = new Tickets(this);
        this.history = new History(this);

        // Загружаем локальные переопределения закладок из storage
        chrome.storage.local.get(['bm_deleted_ids', 'bm_renamed_map', 'bm_cache']).then(r => {
            if (Array.isArray(r.bm_deleted_ids)) this.#deletedBmIds = new Set(r.bm_deleted_ids.map(Number));
            if (r.bm_renamed_map && typeof r.bm_renamed_map === 'object') {
                this.#renamedBmMap = new Map(Object.entries(r.bm_renamed_map).map(([k,v]) => [Number(k), v]));
            }
            // 🔖 Восстанавливаем кэш закладок — чтобы попап показывал их сразу,
            // не ожидая WS-коннекта (который может занять 2–10 сек).
            if (Array.isArray(r.bm_cache) && r.bm_cache.length > 0) {
                this.#rawBookmarks = this.#applyBmOverrides(r.bm_cache);
                debugLog(`[CS] BM cache restored: ${this.#rawBookmarks.length} items`);
            }
            debugLog('[CS] Local BM overrides loaded: deleted=', this.#deletedBmIds.size, 'renamed=', this.#renamedBmMap.size);
        }).catch(() => {});

        this.#init();
    }

    async #init() {
        try {
            // Load settings
            const items = await chrome.storage.local.get(Object.keys(SETTINGS));
            let to_save = {};
            for (const [key, value] of Object.entries(SETTINGS)) {
                if (key in items) SETTINGS[key] = items[key];
                else to_save[key] = value;
            }
            if (Object.keys(to_save).length) {
                await chrome.storage.local.set(to_save);
            }

            // 🛡️ v1.5.2 авто-коррекция: если интервал < 300 с — сбрасываем на 900 с
            // Защита от Error 429 при обновлении с ранних версий
            if (SETTINGS.interval < 300) {
                debugWarn(`[CS] Интервал ${SETTINGS.interval}с слишком мал — сброс на 900с (защита от 429)`);
                SETTINGS.interval = 900;
                await chrome.storage.local.set({ interval: 900 });
            }

            // Load backoff state (survives service worker restarts)
            const backoffState = await chrome.storage.local.get(['backoff_multiplier', 'backoff_until', 'rate_limit_count']);
            if (backoffState.backoff_multiplier) {
                this.#backoff_multiplier = backoffState.backoff_multiplier;
                this.#backoff_until = backoffState.backoff_until || 0;
                this.#rate_limit_count = backoffState.rate_limit_count || 0;
            }

            const start_member_id = await this.#get_cookie_member_id();

            // 🔧 AUTH FIX 2.2.20: сначала восстанавливаем кэш пользователя,
            // потом проверяем cookie. В Firefox после установки/перезапуска SW
            // cookies иногда доступны не сразу, из-за чего расширение ошибочно
            // показывало «Войдите на 4PDA» и очищало кэш.
            const cached = await chrome.storage.local.get(['cached_user_id', 'cached_user_name', 'cached_user_avatar']);
            if (cached.cached_user_id) {
                this.#user_id     = cached.cached_user_id;
                this.#user_name   = cached.cached_user_name   || '';
                this.#user_avatar = cached.cached_user_avatar || '';
                if (!this.#user_avatar) this.#fetch_user_avatar(false).catch(() => {});
            }

            this.#cookie_authorized = (start_member_id != null) || !!cached.cached_user_id;
            let missed_cookie_checks = start_member_id ? 0 : (cached.cached_user_id ? 1 : 0);

            // Heartbeat: check auth state every 5s (no need to poll more often)
            this.heartbeat = setInterval(async () => {
                if (this.#update_in_process) return;
                const member_id = await this.#get_cookie_member_id();
                if (member_id) {
                    missed_cookie_checks = 0;
                    if (!this.#cookie_authorized) {
                        this.#cookie_authorized = true;
                        this.update();
                    }
                    return;
                }

                // 🔧 AUTH FIX 2.2.20: не разлогиниваем по одному промаху cookie.
                // В Firefox cookies API может временно вернуть пусто после обновления
                // расширения или пробуждения service worker.
                missed_cookie_checks++;
                if (missed_cookie_checks < 4) return;

                if (this.#cookie_authorized) {
                    this.#do_logout();
                    this.#cookie_authorized = false;
                }
            }, 5000);

            if (this.#cookie_authorized) {
                setTimeout(() => this.update(), 2000);
            } else {
                // 🔧 Firefox fallback: куки могут быть недоступны в первые мс старта SW.
                // Если есть кэш пользователя — пробуем обновиться через 3с,
                // heartbeat сам обнаружит куки и сделает полный init.
                const cached = await chrome.storage.local.get(['cached_user_id']);
                if (cached.cached_user_id) {
                    debugLog('[CS] cookie not found yet but cached_user_id present — retry in 3s');
                    setTimeout(() => this.update(), 3000);
                } else {
                    this.#do_logout();
                }
            }
        } catch (error) {
            console.error('❌ CS init failed:', error);
        } finally {
            this.#initialized = true;
        }
    }

    #get_cookie_member_id() {
        // 🔧 AUTH FIX 2.2.20: максимально устойчивое чтение member_id.
        // В Firefox cookie может лежать как .4pda.to, а chrome.cookies.getAll({domain})
        // не всегда возвращает её сразу после переустановки/обновления расширения.
        return (async () => {
            const urls = [
                'https://4pda.to/',
                'https://4pda.to/forum/',
                'https://4pda.to/forum/index.php',
                'http://4pda.to/'
            ];
            for (const url of urls) {
                try {
                    const c = await chrome.cookies.get({ url, name: 'member_id' });
                    if (c && c.value) return c.value;
                } catch (_) {}
            }
            const queries = [
                { domain: '4pda.to', name: 'member_id' },
                { domain: '.4pda.to', name: 'member_id' },
                { name: 'member_id' }
            ];
            for (const q of queries) {
                try {
                    const cookies = await chrome.cookies.getAll(q);
                    const c = (cookies || []).find(c =>
                        c && c.name === 'member_id' && /(^|\.)4pda\.to$/.test(String(c.domain || '').replace(/^\./, ''))
                    ) || (cookies || []).find(c => c && c.name === 'member_id');
                    if (c && c.value) return c.value;
                } catch (_) {}
            }
            return null;
        })();
    }

    #do_logout() {
        this.#user_id = 0;
        this.#user_name = '';
        this.#rawBookmarks = [];
        this.#rawBookmarksRaw = [];
        this.history.reset();
        // 🔌 Останавливаем WS при выходе из аккаунта
        this.#stop_ws();
        // 🔧 FIX: Clear cached credentials and bookmarks on logout
        chrome.storage.local.remove([
            'cached_user_id', 'cached_user_name', 'cached_user_avatar',
            'bm_cache'
        ]).catch(() => {});
        print_logout();
    }
    
    // 🚀 NEW: Save backoff state to storage
    async #saveBackoffState(is429 = false) {
        await chrome.storage.local.set({
            backoff_multiplier: this.#backoff_multiplier,
            backoff_until: this.#backoff_until,
            rate_limit_count: this.#rate_limit_count,
            is_429_active: is429,
            last_429_time: is429 ? Date.now() : null
        });
    }
    
    /**
     * Планирует мягкую проверку тикетов после WS-события.
     * Сервер не всегда шлёт push по тикетам, поэтому делаем редкий debounce-опрос.
     * Не пишет полный snapshot в storage и не трогает открытый popup напрямую.
     * @param {number} [delay=45000] задержка перед проверкой, мс
     */
    #scheduleTicketCheck(delay = 45_000) {
        if (!SETTINGS.tickets_enabled) return;
        if (this.#ticketCheckTimer) return;
        this.#ticketCheckTimer = setTimeout(async () => {
            this.#ticketCheckTimer = null;
            if (!SETTINGS.tickets_enabled || this.#update_in_process) return;
            debugLog('[CS] scheduled ticket check after WS event');
            try {
                await this.tickets.update(false);
                this.update_action();
            } catch (e) {
                debugWarn('[CS] scheduled ticket check failed:', e?.message ?? e);
            }
        }, delay);
    }

    // 🚀 NEW: Trigger rate limit backoff
    async #triggerBackoff() {
        this.#rate_limit_count++;
        
        // Exponential backoff: 2x each time, max 32x (5.3 minutes at 10s interval)
        this.#backoff_multiplier = Math.min(Math.pow(2, this.#rate_limit_count), 32);
        
        // Calculate how long to wait (in milliseconds)
        const baseIntervalMs = SETTINGS.interval * 1000;
        const backoffMs = baseIntervalMs * this.#backoff_multiplier;
        this.#backoff_until = Date.now() + backoffMs;
        
        const backoffMinutes = (backoffMs / 60000).toFixed(1);
        const untilTime = new Date(this.#backoff_until).toLocaleTimeString();
        
        debugWarn(`⚠️ Rate limit (429) #${this.#rate_limit_count}!`);
        debugWarn(`   Backing off: ${this.#backoff_multiplier.toFixed(1)}x multiplier`);
        debugWarn(`   Next attempt: ${backoffMinutes} minutes (${untilTime})`);
        
        // Reset success counter
        this.#consecutive_successes = 0;
        
        // Save state
        await this.#saveBackoffState(true);
    }
    
    // 🚀 NEW: Handle successful request (gradual recovery)
    async #handleSuccess() {
        // 🛡️ FIX: Восстанавливаем статус если были в N/A
        if (!this.#available) {
            this.#available = true;
            this.#consecutive_errors = 0;
            // update_action обновит иконку через print_count после получения данных
        }

        if (this.#backoff_multiplier <= 1.0) {
            // Already at normal speed
            return;
        }
        
        this.#consecutive_successes++;
        
        // After 3 consecutive successes, reduce backoff multiplier by 20%
        if (this.#consecutive_successes >= 3) {
            const oldMultiplier = this.#backoff_multiplier;
            this.#backoff_multiplier = Math.max(this.#backoff_multiplier * 0.5, 1.0);
            
            if (this.#backoff_multiplier === 1.0) {
                this.#rate_limit_count = 0;
                this.#backoff_until = 0;
                await this.#saveBackoffState(false);
            } else {
                await this.#saveBackoffState(true);
            }
            
            this.#consecutive_successes = 0;
        }
    }

    // ════════════════════════════════════════════════════════
    // 🔌 WebSocket — реал-тайм дополнение к HTTP-polling
    // ════════════════════════════════════════════════════════

    /**
     * Запускает WebSocket-клиент, если он ещё не запущен.
     * Вызывается после того, как user_id стал известен.
     * WS не заменяет HTTP-polling, а дополняет его:
     *   push-событие → немедленный точечный update нужного модуля.
     */
    async #start_ws() {
        // Не создаём новый клиент если предыдущий уже подключён
        if (this.#ws?.isConnected) return;

        // Если старый клиент завис — останавливаем перед пересозданием
        if (this.#ws) {
            this.#ws.stop();
            this.#ws = null;
        }

        debugLog(`[CS] Запускаем WebSocket для userId=${this.#user_id}…`);

        this.#ws = await createWsClient(this.#user_id, {

            onConnect: () => {
                debugLog('[CS] WS подключён ✅');
                // 🔌 WS жив — переключаем alarm на редкий fallback (15 мин)
                globalThis.reinitializeAlarm?.();

                // 🔧 FIX: Инициализируем notify=true для всех модулей при подключении WS.
                // Без этого первые WS-события не вызывают уведомления —
                // notify остаётся false до первого HTTP-опроса по alarm (до 15 мин).
                // Запускаем параллельно; ошибки HTTP (Cloudflare) логируем тихо.
                Promise.all([
                    this.qms.update().catch(e => debugLog('[CS] onConnect init qms:', e)),
                    this.mentions.update().catch(e => debugLog('[CS] onConnect init mentions:', e)),
                    this.favorites.update().catch(e => debugLog('[CS] onConnect init favorites:', e)),
                    ...(SETTINGS.tickets_enabled ? [this.tickets.update().catch(e => debugLog('[CS] onConnect init tickets:', e))] : []),
                ]).then(() => {
                    this.update_action();
                    debugLog('[CS] WS onConnect: модули инициализированы, notify=true');
                }).catch(() => {});

                // 🔖 Запрашиваем закладки через WS всегда при коннекте —
                // это единственный способ получить список без HTTP (Cloudflare блокирует).
                // updateFromWs() корректно работает в обоих режимах show_all_favorites.
                this.#ws?.requestBookmarks();

                // 📖 Запрашиваем историю просмотров при каждом подключении
                if (SETTINGS.show_history_tab) {
                    this.#ws?.requestHistoryAll?.() || this.#ws?.requestHistory();
                }

                // 🔖 Если пользователь менял закладки пока WS был недоступен,
                // операции не теряются: складываются в bookmark_pending_ops и
                // выполняются после реконнекта. Даём onBookmarks короткое время
                // обновить rawBookmarksRaw, затем прогоняем очередь.
                setTimeout(() => this.#drainBookmarkPendingOps().catch(e => debugWarn('[CS] pending bookmark ops:', e)), 1200);
            },

            onDisconnect: () => {
                debugLog('[CS] WS отключён — будет переподключение');
                // 🔌 WS упал — возвращаем alarm к обычному интервалу polling
                globalThis.reinitializeAlarm?.();
            },

            /**
             * Push-событие от сервера.
             * Маппинг типов → модули:
             *   q (QMS)          → qms.update()
             *   t (topic)        → mentions.update()
             *   s (site comment) → mentions.update()
             *   f (forum)        → favorites.update()
             */
            onEvent: async (type, entityId, flag, msgId) => {
                // update_action() вызывается ВСЕГДА — даже если модуль не смог обновиться.
                // Иначе попап теряет отображение (broadcast_counts не рассылается).
                try {
                    switch (type) {
                        case WsEventType.QMS:
                            debugLog(`[CS] WS: новое QMS событие (id=${entityId})`);
                            // Передаём entityId (dialog_id) и msgId — qms.update может
                            // обновить счётчик через быстрый Inspector API без HTML-парсинга.
                            await this.qms.update(false, entityId, msgId);
                            break;

                        case WsEventType.TOPIC:
                        case WsEventType.SITE:
                            // 🔧 FIX: TOPIC события — это и новые посты в избранных, и упоминания
                            debugLog(`[CS] WS: новый пост/упоминание type=${type} (id=${entityId})`);
                            await Promise.all([
                                this.mentions.update(),
                                this.favorites.update(),
                            ]);
                            break;

                        case WsEventType.FORUM:
                            debugLog(`[CS] WS: новое в форуме (id=${entityId})`);
                            // 🔖 Если режим "все закладки" — запрашиваем данные
                            // через тот же сокет (ответ придёт в onBookmarks → updateFromWs).
                            // Иначе (только непрочитанные) — обычный Inspector API.
                            if (SETTINGS.show_all_favorites) {
                                this.#ws.requestBookmarks();
                                // update_action() вызовется из onBookmarks, не здесь
                                return;
                            } else {
                                await this.favorites.update();
                            }
                            break;

                        default:
                            debugLog(`[CS] WS: неизвестный тип события "${type}"`);
                    }
                } catch (e) {
                    // 🔌 При заблокированном HTTP логируем тихо — WS работает, это ожидаемо
                    if (this.#ws?.isConnected) {
                        debugLog(`[CS] WS-событие: HTTP обновление недоступно (Cloudflare): ${e.message ?? e}`);
                    } else {
                        console.error('[CS] Ошибка обработки WS-события:', e);
                    }
                }
                // Тикеты не всегда приходят push-событием; планируем редкую мягкую проверку.
                this.#scheduleTicketCheck();

                // ✅ Всегда обновляем бейдж и рассылаем счётчики в попап,
                // даже если модуль не смог обновить данные через HTTP
                this.update_action();
            },

            // 🔖 Закладки через WS: обновляем rawBookmarks всегда.
            // updateFromWs вызываем только если show_all_favorites=true —
            // в режиме "только непрочитанные" WS не знает viewed-статус,
            // поэтому перетирать список Inspector'а нельзя (счётчик раздуется).
            onBookmarks: (bookmarks, raw) => {
                debugLog(`[CS] WS: получено закладок ${bookmarks.length}`);
                // 🛡️ Защита от перезаписи WS-кешем после HTTP-операции.
                const graceSec = 60;
                if (Date.now() - this.#bookmarkEditTime < graceSec * 1000) {
                    debugLog(`[CS] onBookmarks: пропускаем WS-синк — grace period (${graceSec}s) ещё активен`);
                    return;
                }
                // Сохраняем сырые данные для syncBookmarksWs (без трансформации)
                if (Array.isArray(raw)) this.#rawBookmarksRaw = raw;
                const filtered = this.#applyBmOverrides(bookmarks);

                // mb — таблица ручных закладок пользователя (папки, ссылки, темы форума).
                // Favorites (подписки форума с unread-статусом) приходят из Inspector API
                // отдельно — mb никак с ними не пересекается.
                // Поэтому rawBookmarks = все записи из mb (без фильтра по URL).
                // favorites.updateFromWs вызываем ТОЛЬКО как fallback когда Inspector
                // недоступен (show_all_favorites=true и WS подключён).
                this.#rawBookmarks = filtered;

                // 💾 Кэшируем в storage — при следующем старте браузера закладки
                // будут доступны сразу, не ожидая WS-коннекта.
                chrome.storage.local.set({ bm_cache: raw }).catch(() => {});

                if (SETTINGS.show_all_favorites) {
                    this.favorites.updateFromWs(filtered);
                }
                debugLog(`[CS] onBookmarks: ${filtered.length} закладок`);
                this.update_action();
                // 🔄 Мгновенно уведомляем открытый попап об обновлении закладок
                chrome.runtime.sendMessage({ action: 'ui_update_bookmarks', data: filtered })
                    .catch(() => {}); // попап может быть закрыт — игнорируем ошибку
            },

            // 📖 История просмотренных тем (команда "mh")
            onHistory: (topics) => {
                debugLog(`[CS] onHistory: ${topics.length} тем`);
                this.history.updateFromWs(topics);
                // Уведомляем открытый попап
                chrome.runtime.sendMessage({ action: 'ui_update_history', data: topics })
                    .catch(() => {});
            },
        });

        if (!this.#ws) {
            debugWarn('[CS] Не удалось создать WS клиент (pass_hash отсутствует?)');
        }
    }

    /** Останавливает WebSocket (вызывается при логауте или смене пользователя). */
    #stop_ws() {
        if (this.#ws) {
            this.#ws.stop();
            this.#ws = null;
            debugLog('[CS] WS остановлен');
        }
    }

    get initialized() { return this.#initialized; }
    get available()   { return this.#available; }
    get user_id()     { return this.#user_id; }
    get user_name()   { return this.#user_name; }
    get user_avatar() { return this.#user_avatar; }

    async refreshUserAvatar(force = true) {
        const avatar = await this.#fetch_user_avatar(force);
        return { ok: !!avatar, user_avatar_url: avatar || this.#user_avatar || '' };
    }
    /** Запрашивает историю просмотров через WebSocket. */
    requestHistoryFromWs() {
        if (this.#ws?.isConnected) {
            this.#ws.requestHistoryAll?.() || this.#ws.requestHistory();
        } else {
            debugWarn('[CS] requestHistoryFromWs: WS не подключён');
        }
    }

    /** Запрашивает список закладок через WebSocket (для Favorites.update()). */
    requestFavoritesFromWs() {
        if (this.#ws?.isConnected) {
            this.#ws.requestBookmarks();
        } else {
            debugWarn('[CS] requestFavoritesFromWs: WS не подключён, пропуск');
        }
    }

    /** true — WebSocket подключён и авторизован */
    get wsConnected() { return this.#ws?.isConnected ?? false; }

    /** Полный список закладок (все типы, включая папки и внешние ссылки) */
    get bookmarks() { return this.#rawBookmarks; }

    /**
     * Удаляет закладку через WS и обновляет список.
     * @param {number} id
     * @returns {Promise<boolean>}
     */
    /**
     * Удаляет закладку через HTTP, затем обновляет список через WS.
     * WS не используется для записи — сервер возвращает status:3 на любые форматы.
     * @param {number} id
     * @returns {Promise<boolean>}
     */
    /**
     * Получает куки 4PDA через chrome.cookies API и строит Cookie-заголовок.
     * Background SW не передаёт credentials автоматически для cross-origin.
     */
    async #get4pdaCookieHeader() {
        try {
            const cookies = await chrome.cookies.getAll({ domain: '4pda.to' });
            const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
            debugLog('[CS] cookie header keys:', cookies.map(c => c.name).join(', '));
            return header;
        } catch (e) {
            console.error('[CS] #get4pdaCookieHeader error:', e);
            return '';
        }
    }

    /**
     * Получает secure_key (CSRF-токен IPB) со страницы избранного.
     * Передаём куки вручную через Cookie-заголовок.
     */
    /**
     * Получает secure_key через content script (page_watcher) из живой страницы 4PDA.
     * Content script имеет доступ к window.ipb.vars и DOM, background — нет.
     * Если 4PDA не открыт в активной вкладке — возвращает null.
     */
    // Публичная обёртка для background.js
    async getSecureKey() { return this.#getFavSecureKey(); }

    async #getFavSecureKey() {
        try {
            // 1) Сначала пробуем получить из открытой вкладки 4PDA (быстро)
            const tabs = await chrome.tabs.query({ url: 'https://4pda.to/forum/*' });
            for (const tab of tabs) {
                try {
                    const resp = await chrome.tabs.sendMessage(tab.id, { action: 'get_secure_key' });
                    if (resp?.key) {
                        debugLog('[CS] secure_key from page DOM:', resp.key.slice(0,8) + '…');
                        return resp.key;
                    }
                } catch (_) { /* content script не загружен на этой вкладке */ }
            }

            // 2) Фолбэк: получаем ключ через HTTP-запрос к странице форума
            debugLog('[CS] secure_key: fallback — fetching from forum page...');
            const pageResp = await fetch('https://4pda.to/forum/index.php?act=fav', {
                credentials: 'include',
                signal: AbortSignal.timeout(10000),
            });
            if (pageResp.ok) {
                const html = await pageResp.text();
                // IPB хранит ключ в разных местах HTML:
                // <input type="hidden" name="auth_key" value="..." />
                // ipb.vars['secure_hash'] = '...';
                const m = html.match(/secure_hash\s*[=:]\s*['"]([a-f0-9]{32})['"]/i)
                       || html.match(/auth_key['"]\s*value\s*=\s*['"]([a-f0-9]{32})['"]/i)
                       || html.match(/name\s*=\s*['"]secure_key['"]\s*value\s*=\s*['"]([a-f0-9]{32})['"]/i);
                if (m?.[1]) {
                    debugLog('[CS] secure_key from HTTP fallback:', m[1].slice(0, 8) + '…');
                    return m[1];
                }
            }

            debugWarn('[CS] secure_key: NOT FOUND (no tabs, no HTTP fallback)');
            return null;
        } catch (e) {
            console.error('[CS] #getFavSecureKey error:', e);
            return null;
        }
    }

    /** Сохраняет локальные переопределения закладок в chrome.storage */
    async #saveBmOverrides() {
        try {
            await chrome.storage.local.set({
                bm_deleted_ids: [...this.#deletedBmIds],
                bm_renamed_map: Object.fromEntries(this.#renamedBmMap),
            });
        } catch (e) { console.error('[CS] saveBmOverrides error:', e); }
    }

    /** Применяет локальные переопределения к массиву закладок из WS */
    #applyBmOverrides(bookmarks) {
        return bookmarks
            .filter(b => !this.#deletedBmIds.has(Number(b.id)))
            .map(b => {
                const renamed = this.#renamedBmMap.get(Number(b.id));
                return renamed ? { ...b, title: renamed } : b;
            });
    }

    /**
     * Выполняет POST-запрос к 4pda через content script открытой вкладки.
     * Content script имеет доступ к HttpOnly кукам (pass_hash, session_id),
     * которые недоступны из background через chrome.cookies.getAll().
     * @param {string} body — URL-encoded тело запроса
     * @returns {Promise<{ok: boolean, preview?: string, error?: string}>}
     */
    async #favActionViaTab(body) {
        const tabs = await chrome.tabs.query({ url: 'https://4pda.to/forum/*' });
        if (!tabs.length) throw new Error('Нет открытых вкладок 4PDA');
        for (const tab of tabs) {
            try {
                const resp = await chrome.tabs.sendMessage(tab.id, { action: 'fav_action', body });
                if (resp !== undefined) {
                    debugLog('[CS] fav_action via tab resp:', resp.ok, resp.preview?.slice(0, 80));
                    return resp;
                }
            } catch (_) { /* content script не загружен на этой вкладке */ }
        }
        throw new Error('Не удалось выполнить запрос через content script');
    }

    async #enqueueBookmarkPendingOp(op) {
        const entry = {
            ...op,
            queuedAt: Date.now(),
            uid: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
        try {
            const stored = await chrome.storage.local.get('bookmark_pending_ops');
            const list = Array.isArray(stored.bookmark_pending_ops) ? stored.bookmark_pending_ops : [];
            list.push(entry);
            await chrome.storage.local.set({ bookmark_pending_ops: list.slice(-50) });
            debugWarn('[CS] bookmark op queued until WS reconnect:', entry.type, entry.id || entry.title || '');
            return true;
        } catch (e) {
            console.warn('[CS] enqueue bookmark_pending_ops failed:', e);
            return false;
        }
    }

    async #drainBookmarkPendingOps() {
        if (this.#bookmarkPendingDrain || !this.#ws?.isConnected) return false;
        this.#bookmarkPendingDrain = true;
        try {
            const stored = await chrome.storage.local.get('bookmark_pending_ops');
            let queue = Array.isArray(stored.bookmark_pending_ops) ? stored.bookmark_pending_ops : [];
            if (!queue.length) return true;
            debugLog('[CS] draining bookmark_pending_ops:', queue.length);
            const failed = [];
            for (const op of queue) {
                let ok = false;
                try {
                    if (op.type === 'delete') ok = await this.deleteBookmark(op.id, { noQueue: true });
                    else if (op.type === 'rename') ok = await this.renameBookmark(op.id, op.title, { noQueue: true });
                    else if (op.type === 'add') ok = await this.addBookmark(op.title, op.url, op.parentId ?? 0, { noQueue: true });
                    else if (op.type === 'folder_add') ok = await this.addFolder(op.title, op.parentId ?? 0, { noQueue: true });
                } catch (e) {
                    console.warn('[CS] pending bookmark op failed:', op, e);
                    ok = false;
                }
                if (!ok) failed.push(op);
            }
            await chrome.storage.local.set({ bookmark_pending_ops: failed });
            if (failed.length !== queue.length) this.#ws?.requestBookmarks?.();
            return failed.length === 0;
        } finally {
            this.#bookmarkPendingDrain = false;
        }
    }

    async deleteBookmark(id, opts = {}) {
        debugLog('[CS] deleteBookmark id=', id);
        try {
            if (!this.#ws?.isConnected) {
                debugWarn('[CS] deleteBookmark: WS не подключён — операция поставлена в очередь');
                return opts.noQueue ? false : this.#enqueueBookmarkPendingOp({ type: 'delete', id: Number(id) });
            }
            const bm = this.#rawBookmarks.find(b => Number(b.id) === Number(id));
            if (!bm) { debugWarn('[CS] deleteBookmark: закладка не найдена id=', id); return false; }

            // deleteBookmarkWs: mb,1 с одной записью deleted=1, win1251-бинарный фрейм
            const ok = await this.#ws.deleteBookmarkWs(id, bm);
            debugLog('[CS] deleteBookmark WS status:', ok);

            if (ok) {
                // НЕ ставим bookmarkEditTime — иначе onBookmarks заблокируется grace period
                // и список не обновится из ответа сервера
                this.#rawBookmarks = this.#rawBookmarks.filter(b => Number(b.id) !== Number(id));
                this.#rawBookmarksRaw = this.#rawBookmarksRaw.filter(
                    r => Array.isArray(r) && Number(r[0]) !== Number(id)
                );
                this.#deletedBmIds.add(Number(id));
                await this.#saveBmOverrides();
                this.update_action();
                chrome.runtime.sendMessage({ action: 'ui_update_bookmarks', data: this.#rawBookmarks }).catch(() => {});
            }
            return ok;
        } catch (e) { console.error('[CS] deleteBookmark error:', e); return false; }
    }

    /**
     * Переименовывает закладку через HTTP, затем обновляет список через WS.
     * WS не используется для записи — сервер возвращает status:3 на любые форматы.
     * @param {number} id
     * @param {string} newTitle
     * @returns {Promise<boolean>}
     */
    async renameBookmark(id, newTitle, opts = {}) {
        debugLog('[CS] renameBookmark id=', id, 'newTitle=', newTitle);
        try {
            if (!this.#ws?.isConnected) {
                debugWarn('[CS] renameBookmark: WS не подключён — операция поставлена в очередь');
                return opts.noQueue ? false : this.#enqueueBookmarkPendingOp({ type: 'rename', id: Number(id), title: String(newTitle || '') });
            }
            const bm = this.#rawBookmarks.find(b => Number(b.id) === Number(id));
            if (!bm) { debugWarn('[CS] renameBookmark: закладка не найдена id=', id); return false; }

            // renameBookmarkWs: команда 'me' (fire-and-forget) + requestBookmarks через 700мс.
            // win1251-бинарный фрейм — сервер хранит строки в win1251.
            // НЕ ставим bookmarkEditTime — иначе onBookmarks заблокируется и не обновит список.
            const ok = await this.#ws.renameBookmarkWs(id, newTitle, bm);
            debugLog('[CS] renameBookmark WS status:', ok);

            if (ok) {
                // Обновляем UI немедленно, не дожидаясь onBookmarks
                bm.title = newTitle;
                const rawEntry = this.#rawBookmarksRaw.find(
                    r => Array.isArray(r) && Number(r[0]) === Number(id)
                );
                if (rawEntry) rawEntry[6] = newTitle;
                this.#renamedBmMap.set(Number(id), newTitle);
                await this.#saveBmOverrides();
                chrome.runtime.sendMessage({
                    action: 'ui_update_bookmarks',
                    data: this.#rawBookmarks,
                }).catch(() => {});
            }
            return ok;
        } catch (e) { console.error('[CS] renameBookmark error:', e); return false; }
    }


    /**
     * Добавляет новую закладку через HTTP (CODE=add_bk).
     * @param {string} title
     * @param {string} url — полный URL или путь относительно 4pda.to
     * @param {number} parentId — id папки (0 = корень)
     * @returns {Promise<boolean>}
     */

    /**
     * Создаёт папку (или подпапку) закладок через WS.
     * @param {string} title
     * @param {number} parentId — 0 = корень, id папки = подпапка
     * @returns {Promise<boolean>}
     */
    async addFolder(title, parentId = 0, opts = {}) {
        debugLog('[CS] addFolder title=', title, 'parentId=', parentId);
        try {
            if (!this.#ws?.isConnected) {
                debugWarn('[CS] addFolder: WS не подключён — операция поставлена в очередь');
                return opts.noQueue ? false : this.#enqueueBookmarkPendingOp({ type: 'folder_add', title: String(title || ''), parentId: Number(parentId) || 0 });
            }
            const maxSort = this.#rawBookmarksRaw.reduce((m, r) => {
                const s = Array.isArray(r) ? Number(r[5]) : 0;
                return s > m ? s : m;
            }, 0);
            const ok = await this.#ws.addFolderWs(title, parentId, maxSort + 1);
            debugLog('[CS] addFolder WS status:', ok);
            if (ok) {
                this.#bookmarkEditTime = 0;
            }
            return ok;
        } catch (e) { console.error('[CS] addFolder error:', e); return false; }
    }

    async addBookmark(title, url, parentId = 0, opts = {}) {
        debugLog('[CS] addBookmark title=', title, 'url=', url, 'parentId=', parentId);
        try {
            if (!this.#ws?.isConnected) {
                debugWarn('[CS] addBookmark: WS не подключён — операция поставлена в очередь');
                return opts.noQueue ? false : this.#enqueueBookmarkPendingOp({ type: 'add', title: String(title || ''), url: String(url || ''), parentId: Number(parentId) || 0 });
            }
            if (this.#rawBookmarksRaw.length === 0) {
                debugWarn('[CS] addBookmark: rawBookmarksRaw пуст — операция поставлена в очередь');
                return opts.noQueue ? false : this.#enqueueBookmarkPendingOp({ type: 'add', title: String(title || ''), url: String(url || ''), parentId: Number(parentId) || 0 });
            }

            const urlPath = url
                .replace('https://4pda.to/', '')
                .replace('https://4pda.ru/', '')
                .replace('http://4pda.to/', '');

            // Вычисляем следующий sortOrder = max текущих + 1
            const maxSort = this.#rawBookmarksRaw.reduce((m, r) => {
                const s = Array.isArray(r) ? Number(r[5]) : 0;
                return s > m ? s : m;
            }, 0);

            // id=0 → сервер назначит новый id сам
            // Формат: [id, date, deleted, isFolder, parentId, sortOrder, title, url]
            const newEntry = [
                0,                              // id = 0 (новая запись)
                Math.floor(Date.now() / 1000),  // date
                0,                              // deleted
                0,                              // isFolder
                Number(parentId),               // parentId
                maxSort + 1,                    // sortOrder
                title,                          // title
                urlPath,                        // url
            ];

            // Отправляем полный список + новую запись через mb,1
            const allEntries = [...this.#rawBookmarksRaw, newEntry];
            debugLog(`[CS] addBookmark: отправляем ${allEntries.length} записей (${this.#rawBookmarksRaw.length} + 1 новая)`);
            const status = await this.#ws.syncBookmarksWs(allEntries, new Map(), new Set());
            debugLog('[CS] addBookmark WS status=', status);

            if (status) {
                // Сервер вернёт обновлённый список в onBookmarks — сбрасываем grace period
                this.#bookmarkEditTime = 0;
            }
            return status;
        } catch (e) { console.error('[CS] addBookmark error:', e); return false; }
    }

    get popup_data() {
        return {
            user_id: this.#user_id,
            user_name: this.#user_name,
            user_avatar_url: this.#user_avatar,
            favorites: {
                count: this.favorites.count,
                list: this.favorites.list
            },
            qms: {
                count: this.qms.count,
                list: this.qms.list
            },
            mentions: {
                count: this.mentions.count,
                list: this.mentions.list
            },
            tickets: {
                count: this.tickets.count,
                list: this.tickets.list,
                enabled: SETTINGS.tickets_enabled,
                unlocked: SETTINGS.tickets_unlocked,
            },
            bookmarks: {
                list: this.#rawBookmarks,
            },
            history: {
                list: this.history.list,
            },
            settings: SETTINGS
        };
    }

    update_action() {
        print_count(
            this.qms.count,
            this.favorites.count,
            this.mentions.count,
            SETTINGS.tickets_enabled ? this.tickets.count : 0
        );
        
        // 🚀 NEW: Broadcast counts to popup in real-time
        this.broadcast_counts();
    }
    
    // 🚀 NEW: Broadcast count updates to all open popups
    broadcast_counts() {
        const counts = {
            favorites: this.favorites.count,
            qms: this.qms.count,
            mentions: this.mentions.count,
            tickets: SETTINGS.tickets_enabled ? this.tickets.count : 0,
        };
        
        const payload = {
            action: 'counts_updated',
            source: 'core',
            ts: Date.now(),
            counts: counts,
            // 🔖 Передаём актуальный список тем, чтобы попап мог перерисовать
            // список без дополнительного roundtrip (popup_loaded).
            // Нужно при асинхронной WS-загрузке закладок после открытия попапа.
            favorites_list: this.favorites.list,
            qms_list: this.qms.list,
            mentions_list: this.mentions.list,
            tickets_list: this.tickets.list,
            bookmarks_list: this.#rawBookmarks,
            snapshot: this.popup_data,
        };

        // Быстрый live-канал для открытых popup/sidebar.
        // ВАЖНО: не пишем полный snapshot в chrome.storage.local — это вызывало
        // лавину storage.onChanged, подвисания Firefox и пустой popup после старта.
        try {
            chrome.runtime.sendMessage(payload).catch(() => {});
        } catch (error) {
            // Popup/sidebar могут быть закрыты — это нормально.
        }
    }

    async update(forceRefresh = false) {
        
        if (!this.#cookie_authorized) { return;
        }
        
        if (this.#update_in_process) { return;
        }

        // 🚀 NEW: Check if we're in backoff period (only for automatic updates)
        if (!forceRefresh) {
            const now = Date.now();
            if (now < this.#backoff_until) {
                const waitSeconds = Math.ceil((this.#backoff_until - now) / 1000);
                return;
            }
            
            // 🔧 FIX: If backoff period expired but multiplier still high, reset it
            if (now >= this.#backoff_until && this.#backoff_multiplier > 1.0) {
                this.#backoff_multiplier = 1.0;
                this.#backoff_until = 0;
                this.#rate_limit_count = 0;
                
                try {
                    await this.#saveBackoffState(false);
                } catch (error) {
                    console.error('❌ Failed to save backoff state:', error);
                }
            }
        } else {
        }

        this.#update_in_process = true;

        // ══════════════════════════════════════════════════════
        // 🔌 WS-fast-path: сокет авторизован + user_id известен
        //    → HTTP auth-check (inspector&CODE=id) не нужен.
        //
        // WS-авторизация подтверждает валидность сессии.
        // Cloudflare блокирует HTTP-запросы расширения, WS — нет.
        // forceRefresh (кнопка «Обновить») всегда идёт HTTP-путём.
        // ══════════════════════════════════════════════════════
        if (this.#ws?.isConnected && this.#user_id && !forceRefresh) {
            // WS активен: модули опрашиваем HTTP-путём (для уведомлений).
            // Если HTTP заблокирован Cloudflare (403) — модули сами возвращают кеш.
            // После Promise.all всегда вызываем update_action() чтобы popup обновился.
            debugLog('[CS] WS активен — запускаем fallback-опрос модулей');
            // 🔧 FIX: НЕ сбрасываем флаг досрочно — держим до завершения Promise.all.
            // Раньше #update_in_process = false стоял здесь, до await, что позволяло
            // следующему alarm-вызову войти в update() пока HTTP-запросы ещё летели.
            Promise.all([
                this.qms.update().catch(e => debugWarn('[CS] WS fallback qms error:', e?.message || e)),
                this.mentions.update().catch(e => debugWarn('[CS] WS fallback mentions error:', e?.message || e)),
                this.favorites.update().catch(e => debugWarn('[CS] WS fallback favorites error:', e?.message || e)),
            ]).then(() => {
                this.update_action(); // всегда обновляем popup, даже с кешированными данными
            }).catch(e => {
                debugWarn('[CS] WS fallback catch:', e);
                this.update_action(); // показываем что есть
            }).finally(() => {
                this.#update_in_process = false; // сброс ПОСЛЕ завершения всех запросов
            });
            return;
        }

        try {
            const data = await fetch4('https://4pda.to/forum/index.php?act=inspector&CODE=id');
            
            // 🚀 NEW: Success! Handle recovery
            await this.#handleSuccess();
            // 🛡️ FIX: Сбрасываем счётчик ошибок при успешном запросе
            this.#consecutive_errors = 0;

            let user_data = parse_response(data);
            if (user_data && user_data.length == 2) {
                if (user_data[0] == this.#user_id) {
                    this.#user_name = user_data[1];
                } else {
                    this.#user_id = user_data[0];
                    this.#user_name = user_data[1];
                    
                    // 🔧 FIX: Cache user_id/user_name so popup works after SW restart
                    chrome.storage.local.set({
                        cached_user_id:   this.#user_id,
                        cached_user_name: this.#user_name,
                    }).catch(() => {});
                    
                    // Загружаем аватар нового пользователя
                    this.#fetch_user_avatar();

                    this.#last_event = 0;
                    this.favorites.reset();
                    this.qms.reset();
                    this.mentions.reset();

                    // 🔌 Сменился пользователь — перезапускаем WS с новым userId
                    this.#stop_ws();
                }

                // 🔌 Запускаем WS если ещё не запущен (или был остановлен)
                this.#start_ws().catch(e => console.error('[CS] #start_ws ошибка:', e));

                // 🔌 WS жив и это не принудительное обновление → auth-check выполнен,
                // данные не грузим: WS доставит push-события сам.
                // Если WS недоступен (или forceRefresh) — полный update как раньше.
                if (this.#ws?.isConnected && !forceRefresh) {
                    debugLog('[CS] WS активен — пропускаем HTTP fetch данных');
                    this.update_action();
                } else {
                    await this.#update_all_data(forceRefresh);
                }
            } else {
                this.#do_logout();
            }
        } catch (error) {
            const errorStr = String(error);
            console.error('API request failed:', errorStr);

            // 🔌 WS подключён → сайт доступен, HTTP заблокирован Cloudflare.
            if (this.#ws?.isConnected) {
                debugWarn('[CS] HTTP заблокирован, но WS активен — показываем кешированные данные');
                // Показываем кешированные данные всех модулей — не пустой список
                await Promise.all([
                    this.qms.update(false).catch(() => {}),
                    this.favorites.update(false).catch(() => {}),
                    this.mentions.update(false).catch(() => {}),
                ]);
                this.update_action();
                return;
            }
            
            if (errorStr.includes('429')) {
                // 🚀 NEW: Trigger exponential backoff
                await this.#triggerBackoff();
                this.#available = true; // Site is available, just rate limited
                this.#consecutive_errors = 0;
            } else if (errorStr.includes('403')) {
                // 🛡️ 403 = Cloudflare блокирует HTTP-запросы расширения.
                // Сайт ДОСТУПЕН — пользователь видит его в браузере.
                // Не инкрементируем счётчик, не ставим «Сайт недоступен».
                debugWarn('[CS] 403 Cloudflare — HTTP заблокирован, сайт доступен');
                this.#available = true;
                // Сбрасываем счётчик чтобы предыдущие сетевые ошибки не суммировались
                this.#consecutive_errors = 0;
            } else {
                // 🛡️ FIX: Показываем N/A только после нескольких подряд ошибок.
                // Одиночный таймаут или сетевой сбой — ещё не причина ставить N/A.
                this.#consecutive_errors++;
                const errType = errorStr.includes('AbortError') || errorStr.includes('timeout')
                    ? `таймаут (${FETCH_TIMEOUT / 1000}с)`
                    : 'сетевая ошибка';
                debugWarn(`⚠️ ${errType} #${this.#consecutive_errors}/${CS.#MAX_ERRORS_BEFORE_UNAVAILABLE}: ${errorStr}`);
                
                if (this.#consecutive_errors >= CS.#MAX_ERRORS_BEFORE_UNAVAILABLE) {
                    console.error(`❌ Сайт недоступен после ${this.#consecutive_errors} ошибок подряд`);
                    this.#available = false;
                    print_unavailable();
                }
                // Иначе — тихо пропускаем, значок не меняем
            }
        } finally {
            this.#update_in_process = false;
        }
    }

    async #update_all_data(forceRefresh = false) {
        try {
            const response = await fetch(
                `https://appbk.4pda.to/er/u${this.#user_id}/s${this.#last_event}`,
                {
                    method: 'GET',
                    signal: AbortSignal.timeout(FETCH_TIMEOUT),
                }
            );
            
            const data = await response.text();
            
            // 🔧 FIX: Check for new events OR force refresh
            let parsed = null;
            if (data) {
                parsed = data.match(PARSE_APPBK_REGEXP);
            }
            
            // Update if: (1) there are new events, OR (2) force refresh requested
            if (parsed || forceRefresh) {
                
                // 🚀 1.8.6: модули обновляем параллельно.
                // Backoff/retry теперь централизован в fetcher.js, поэтому ручные
                // последовательные sleep здесь только тормозили force-refresh на 4–7 секунд.
                const updateJobs = [
                    this.qms.update(forceRefresh),
                    this.favorites.update(forceRefresh),
                    this.mentions.update(forceRefresh),
                ];
                if (SETTINGS.tickets_enabled) updateJobs.push(this.tickets.update(forceRefresh));

                const results = await Promise.allSettled(updateJobs);
                for (const result of results) {
                    if (result.status === 'rejected') {
                        debugWarn('[CS] module update failed:', result.reason?.message || result.reason);
                    }
                }
                
                // Update last_event only if there were actual new events
                if (parsed) {
                    this.#last_event = parsed[1];
                }
            }
            
            this.update_action();
            this.#available = true;
            
        } catch (error) {
            console.error('Error in #update_all_data:', error);
            throw error;
        }
    }
}
