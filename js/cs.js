import { parse_response, fetch4, getLogDatetime, FETCH_TIMEOUT, encodeWin1251 } from "./utils.js";
import { Favorites } from "./e/favorites.js";
import { Mentions } from "./e/mentions.js";
import { QMS } from "./e/qms.js";
import { Tickets } from "./e/tickets.js";
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
    open_in_current_tab: false,  // 🆕 NEW: Open links in current tab instead of new tabs
    bw_icons: false,  // 🆕 NEW: Black & white icons
    mirror_mode: false,  // 🆕 NEW: Mirror popup layout (icons on right)
    accent_color: 'blue',  // 🆕 NEW: Accent color (blue/green)
    compact_mode: false,  // 🆕 NEW: Компактный режим карточек
    show_bookmarks_tab: false,  // 🆕 v1.5.2: Показывать плитку и вкладку Закладок
    primary_click_action: 'forum',  // 🆕 NEW: 'forum' | 'popup' — действие ЛКМ на плитку
    compact_stats: false,          // 🆕 NEW: Горизонтальная компактная статистика
    compact_hide_qms: false,       // Скрыть плитку QMS в компактном режиме
    compact_hide_favorites: false, // Скрыть плитку Избранного в компактном режиме
    compact_hide_mentions: false,  // Скрыть плитку Упоминаний в компактном режиме
    compact_only_stats: false,     // Показывать только статистику (без списка тем)
    compact_show_topics: false,    // Показывать темы в режиме only_stats
    show_fav_toolbar: true,        // Показывать тулбар сортировки/группировки
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
    
    // Метод для загрузки аватара пользователя
    async #fetch_user_avatar() {
        if (!this.#user_id) return '';
        
        try {
            const response = await fetch(`https://4pda.to/forum/index.php?showuser=${this.#user_id}`);
            const html = await response.text();
            
            // Ищем URL аватара в HTML
            const avatarMatch = html.match(/<img[^>]+src=["'](https:\/\/4pda\.to\/s\/[^"']+)["'][^>]*alt=["']Аватар/i);
            if (avatarMatch && avatarMatch[1]) {
                this.#user_avatar = avatarMatch[1];
                // 🔧 FIX: Cache avatar too
                chrome.storage.local.set({ cached_user_avatar: this.#user_avatar }).catch(() => {});
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
                console.log(`[CS] BM cache restored: ${this.#rawBookmarks.length} items`);
            }
            console.log('[CS] Local BM overrides loaded: deleted=', this.#deletedBmIds.size, 'renamed=', this.#renamedBmMap.size);
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
                console.warn(`[CS] Интервал ${SETTINGS.interval}с слишком мал — сброс на 900с (защита от 429)`);
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
            this.#cookie_authorized = start_member_id != null;

            // 🔧 FIX: Restore cached user_id/user_name so popup works immediately
            // on service worker restart (MV3 kills SW after ~5 min idle).
            if (this.#cookie_authorized) {
                const cached = await chrome.storage.local.get(['cached_user_id', 'cached_user_name', 'cached_user_avatar']);
                if (cached.cached_user_id) {
                    this.#user_id     = cached.cached_user_id;
                    this.#user_name   = cached.cached_user_name   || '';
                    this.#user_avatar = cached.cached_user_avatar || '';
                }
            }

            // Heartbeat: check auth state every 5s (no need to poll more often)
            this.heartbeat = setInterval(async () => {
                if (this.#update_in_process) return;
                const member_id = await this.#get_cookie_member_id();
                if (this.#cookie_authorized === (member_id != null)) return;

                if (member_id) {
                    this.#cookie_authorized = true;
                    this.update();
                } else {
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
                    console.log('[CS] cookie not found yet but cached_user_id present — retry in 3s');
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
        // chrome.cookies.get с url без слеша не находит куки в Firefox
        // (браузер хранит их с domain=.4pda.to, path=/).
        // getAll({ domain }) работает одинаково в Chrome, Opera и Firefox.
        return chrome.cookies.getAll({ domain: '4pda.to', name: 'member_id' })
            .then(cookies => {
                const c = cookies.find(c => c.name === 'member_id');
                return c ? c.value : null;
            })
            .catch(() => null);
    }

    #do_logout() {
        this.#user_id = 0;
        this.#user_name = '';
        this.#rawBookmarks = [];
        this.#rawBookmarksRaw = [];
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
        
        console.warn(`⚠️ Rate limit (429) #${this.#rate_limit_count}!`);
        console.warn(`   Backing off: ${this.#backoff_multiplier.toFixed(1)}x multiplier`);
        console.warn(`   Next attempt: ${backoffMinutes} minutes (${untilTime})`);
        
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
     * Вызывается после того, как #user_id стал известен.
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

        console.log(`[CS] Запускаем WebSocket для userId=${this.#user_id}…`);

        this.#ws = await createWsClient(this.#user_id, {

            onConnect: () => {
                console.log('[CS] WS подключён ✅');
                // 🔌 WS жив — переключаем alarm на редкий fallback (15 мин)
                globalThis.reinitializeAlarm?.();

                // 🔧 FIX: Инициализируем notify=true для всех модулей при подключении WS.
                // Без этого первые WS-события не вызывают уведомления —
                // notify остаётся false до первого HTTP-опроса по alarm (до 15 мин).
                // Запускаем параллельно; ошибки HTTP (Cloudflare) логируем тихо.
                Promise.all([
                    this.qms.update().catch(e => console.debug('[CS] onConnect init qms:', e)),
                    this.mentions.update().catch(e => console.debug('[CS] onConnect init mentions:', e)),
                    this.favorites.update().catch(e => console.debug('[CS] onConnect init favorites:', e)),
                    ...(SETTINGS.tickets_enabled ? [this.tickets.update().catch(e => console.debug('[CS] onConnect init tickets:', e))] : []),
                ]).then(() => {
                    this.update_action();
                    console.log('[CS] WS onConnect: модули инициализированы, notify=true');
                }).catch(() => {});

                // 🔖 Запрашиваем закладки через WS всегда при коннекте —
                // это единственный способ получить список без HTTP (Cloudflare блокирует).
                // updateFromWs() корректно работает в обоих режимах show_all_favorites.
                this.#ws?.requestBookmarks();
            },

            onDisconnect: () => {
                console.log('[CS] WS отключён — будет переподключение');
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
                            console.log(`[CS] WS: новое QMS событие (id=${entityId})`);
                            await this.qms.update();
                            break;

                        case WsEventType.TOPIC:
                        case WsEventType.SITE:
                            // 🔧 FIX: TOPIC события — это и новые посты в избранных, и упоминания
                            console.log(`[CS] WS: новый пост/упоминание type=${type} (id=${entityId})`);
                            await Promise.all([
                                this.mentions.update(),
                                this.favorites.update(),
                            ]);
                            break;

                        case WsEventType.FORUM:
                            console.log(`[CS] WS: новое в форуме (id=${entityId})`);
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
                            console.debug(`[CS] WS: неизвестный тип события "${type}"`);
                    }
                } catch (e) {
                    // 🔌 При заблокированном HTTP логируем тихо — WS работает, это ожидаемо
                    if (this.#ws?.isConnected) {
                        console.debug(`[CS] WS-событие: HTTP обновление недоступно (Cloudflare): ${e.message ?? e}`);
                    } else {
                        console.error('[CS] Ошибка обработки WS-события:', e);
                    }
                }
                // ✅ Всегда обновляем бейдж и рассылаем счётчики в попап,
                // даже если модуль не смог обновить данные через HTTP
                this.update_action();
            },

            // 🔖 Закладки через WS: обновляем #rawBookmarks всегда.
            // updateFromWs вызываем только если show_all_favorites=true —
            // в режиме "только непрочитанные" WS не знает viewed-статус,
            // поэтому перетирать список Inspector'а нельзя (счётчик раздуется).
            onBookmarks: (bookmarks, raw) => {
                console.log(`[CS] WS: получено закладок ${bookmarks.length}`);
                // 🛡️ Защита от перезаписи WS-кешем после HTTP-операции.
                const graceSec = 60;
                if (Date.now() - this.#bookmarkEditTime < graceSec * 1000) {
                    console.log(`[CS] onBookmarks: пропускаем WS-синк — grace period (${graceSec}s) ещё активен`);
                    return;
                }
                // Сохраняем сырые данные для syncBookmarksWs (без трансформации)
                if (Array.isArray(raw)) this.#rawBookmarksRaw = raw;
                const filtered = this.#applyBmOverrides(bookmarks);

                // mb — таблица ручных закладок пользователя (папки, ссылки, темы форума).
                // Favorites (подписки форума с unread-статусом) приходят из Inspector API
                // отдельно — mb никак с ними не пересекается.
                // Поэтому #rawBookmarks = все записи из mb (без фильтра по URL).
                // favorites.updateFromWs вызываем ТОЛЬКО как fallback когда Inspector
                // недоступен (show_all_favorites=true и WS подключён).
                this.#rawBookmarks = filtered;

                // 💾 Кэшируем в storage — при следующем старте браузера закладки
                // будут доступны сразу, не ожидая WS-коннекта.
                chrome.storage.local.set({ bm_cache: raw }).catch(() => {});

                if (SETTINGS.show_all_favorites) {
                    this.favorites.updateFromWs(filtered);
                }
                console.log(`[CS] onBookmarks: ${filtered.length} закладок`);
                this.update_action();
                // 🔄 Мгновенно уведомляем открытый попап об обновлении закладок
                chrome.runtime.sendMessage({ action: 'ui_update_bookmarks', data: filtered })
                    .catch(() => {}); // попап может быть закрыт — игнорируем ошибку
            },
        });

        if (!this.#ws) {
            console.warn('[CS] Не удалось создать WS клиент (pass_hash отсутствует?)');
        }
    }

    /** Останавливает WebSocket (вызывается при логауте или смене пользователя). */
    #stop_ws() {
        if (this.#ws) {
            this.#ws.stop();
            this.#ws = null;
            console.log('[CS] WS остановлен');
        }
    }

    get initialized() { return this.#initialized; }
    get available()   { return this.#available; }
    get user_id()     { return this.#user_id; }
    get user_name()   { return this.#user_name; }
    /** Запрашивает список закладок через WebSocket (для Favorites.update()). */
    requestFavoritesFromWs() {
        if (this.#ws?.isConnected) {
            this.#ws.requestBookmarks();
        } else {
            console.warn('[CS] requestFavoritesFromWs: WS не подключён, пропуск');
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
            console.log('[CS] cookie header keys:', cookies.map(c => c.name).join(', '));
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
                        console.log('[CS] secure_key from page DOM:', resp.key.slice(0,8) + '…');
                        return resp.key;
                    }
                } catch (_) { /* content script не загружен на этой вкладке */ }
            }

            // 2) Фолбэк: получаем ключ через HTTP-запрос к странице форума
            console.log('[CS] secure_key: fallback — fetching from forum page...');
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
                    console.log('[CS] secure_key from HTTP fallback:', m[1].slice(0, 8) + '…');
                    return m[1];
                }
            }

            console.warn('[CS] secure_key: NOT FOUND (no tabs, no HTTP fallback)');
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
                    console.log('[CS] fav_action via tab resp:', resp.ok, resp.preview?.slice(0, 80));
                    return resp;
                }
            } catch (_) { /* content script не загружен на этой вкладке */ }
        }
        throw new Error('Не удалось выполнить запрос через content script');
    }

    async deleteBookmark(id) {
        console.log('[CS] deleteBookmark id=', id);
        try {
            if (!this.#ws?.isConnected) {
                console.warn('[CS] deleteBookmark: WS не подключён');
                return false;
            }
            const bm = this.#rawBookmarks.find(b => Number(b.id) === Number(id));
            if (!bm) { console.warn('[CS] deleteBookmark: закладка не найдена id=', id); return false; }

            // deleteBookmarkWs: mb,1 с одной записью deleted=1, win1251-бинарный фрейм
            const ok = await this.#ws.deleteBookmarkWs(id, bm);
            console.log('[CS] deleteBookmark WS status:', ok);

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
    async renameBookmark(id, newTitle) {
        console.log('[CS] renameBookmark id=', id, 'newTitle=', newTitle);
        try {
            if (!this.#ws?.isConnected) {
                console.warn('[CS] renameBookmark: WS не подключён');
                return false;
            }
            const bm = this.#rawBookmarks.find(b => Number(b.id) === Number(id));
            if (!bm) { console.warn('[CS] renameBookmark: закладка не найдена id=', id); return false; }

            // renameBookmarkWs: команда 'me' (fire-and-forget) + requestBookmarks через 700мс.
            // win1251-бинарный фрейм — сервер хранит строки в win1251.
            // НЕ ставим bookmarkEditTime — иначе onBookmarks заблокируется и не обновит список.
            const ok = await this.#ws.renameBookmarkWs(id, newTitle, bm);
            console.log('[CS] renameBookmark WS status:', ok);

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
    async addFolder(title, parentId = 0) {
        console.log('[CS] addFolder title=', title, 'parentId=', parentId);
        try {
            if (!this.#ws?.isConnected) {
                console.warn('[CS] addFolder: WS не подключён');
                return false;
            }
            const maxSort = this.#rawBookmarksRaw.reduce((m, r) => {
                const s = Array.isArray(r) ? Number(r[5]) : 0;
                return s > m ? s : m;
            }, 0);
            const ok = await this.#ws.addFolderWs(title, parentId, maxSort + 1);
            console.log('[CS] addFolder WS status:', ok);
            if (ok) {
                this.#bookmarkEditTime = 0;
            }
            return ok;
        } catch (e) { console.error('[CS] addFolder error:', e); return false; }
    }

    async addBookmark(title, url, parentId = 0) {
        console.log('[CS] addBookmark title=', title, 'url=', url, 'parentId=', parentId);
        try {
            if (!this.#ws?.isConnected) {
                console.warn('[CS] addBookmark: WS не подключён');
                return false;
            }
            if (this.#rawBookmarksRaw.length === 0) {
                console.warn('[CS] addBookmark: rawBookmarksRaw пуст — ждём данных от WS');
                return false;
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
            console.log(`[CS] addBookmark: отправляем ${allEntries.length} записей (${this.#rawBookmarksRaw.length} + 1 новая)`);
            const status = await this.#ws.syncBookmarksWs(allEntries, new Map(), new Set());
            console.log('[CS] addBookmark WS status=', status);

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
        
        // Send to popup (if open) - gracefully handle when popup is closed
        try {
            chrome.runtime.sendMessage({
                action: 'counts_updated',
                counts: counts,
                // 🔖 Передаём актуальный список тем, чтобы попап мог перерисовать
                // список без дополнительного roundtrip (popup_loaded).
                // Нужно при асинхронной WS-загрузке закладок после открытия попапа.
                favorites_list: this.favorites.list,
                bookmarks_list: this.#rawBookmarks,
            }).catch((error) => {
                // Popup might not be open - that's fine, ignore error
            });
        } catch (error) {
            // Ignore - popup is probably not open or extension context invalid
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
            // 🔧 FIX: WS активен, но всё равно опрашиваем модули на 15-минутном fallback-интервале
            // чтобы не пропускать уведомления при редких HTTP-проверках.
            console.debug('[CS] WS активен — запускаем fallback-опрос модулей');
            this.#update_in_process = false;
            Promise.all([
                this.qms.update().catch(e => console.debug('[CS] WS fallback qms:', e)),
                this.mentions.update().catch(e => console.debug('[CS] WS fallback mentions:', e)),
                this.favorites.update().catch(e => console.debug('[CS] WS fallback favorites:', e)),
            ]).then(() => this.update_action()).catch(() => {});
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
                    console.debug('[CS] WS активен — пропускаем HTTP fetch данных');
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

            // 🔌 WS подключён → сайт доступен, просто HTTP заблокирован Cloudflare.
            // Не инкрементируем счётчик ошибок, не ставим «Сайт недоступен».
            if (this.#ws?.isConnected) {
                console.warn('[CS] HTTP заблокирован, но WS активен — N/A не ставим');
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
                console.warn('[CS] 403 Cloudflare — HTTP заблокирован, сайт доступен');
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
                console.warn(`⚠️ ${errType} #${this.#consecutive_errors}/${CS.#MAX_ERRORS_BEFORE_UNAVAILABLE}: ${errorStr}`);
                
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
                
                // 🚀 NEW: Stagger requests with 2-second delays
                await this.qms.update(forceRefresh);
                
                await sleep(1500 + Math.random() * 1000);
                await this.favorites.update(forceRefresh);
                
                await sleep(1500 + Math.random() * 1000);
                await this.mentions.update(forceRefresh);
                
                // 🎫 Tickets (only if enabled)
                if (SETTINGS.tickets_enabled) {
                    await sleep(1500 + Math.random() * 1000);
                    await this.tickets.update(forceRefresh);
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
