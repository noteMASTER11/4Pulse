/** @typedef {import('../js/types.js').Settings} Settings */
/** @typedef {import('../js/types.js').DiagnosticsSnapshot} DiagnosticsSnapshot */
/** @typedef {import('../js/types.js').AppState} AppState */

function __4pSanitizeFragment(fragment) {
    if (!fragment) return fragment;
    fragment.querySelectorAll?.('script, iframe, object, embed, link[rel="import"], meta[http-equiv]').forEach(node => node.remove());
    fragment.querySelectorAll?.('*').forEach(node => {
        [...node.attributes].forEach(attr => {
            const name = attr.name.toLowerCase();
            const value = String(attr.value || '').trim().toLowerCase();
            if (name.startsWith('on') || ((name === 'href' || name === 'src' || name === 'xlink:href') && value.startsWith('javascript:'))) node.removeAttribute(attr.name);
        });
    });
    return fragment;
}
function __4pSetHTML(element, html) {
    if (!element) return html;
    const parsed = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
    const fragment = document.createDocumentFragment();
    [...parsed.body.childNodes].forEach(node => fragment.appendChild(document.importNode(node, true)));
    __4pSanitizeFragment(fragment);
    element.replaceChildren(fragment);
    return html;
}
function setThemeAttr4Pulse(theme) {
    const value = theme || 'dark';
    document.documentElement.setAttribute('data-theme', value);
    document.body.setAttribute('data-theme', value);
    document.documentElement.classList.toggle('theme-aurora-glass', value === 'aurora-glass');
    document.body.classList.toggle('theme-aurora-glass', value === 'aurora-glass');
}

/* ═══════════════════════════════════════════════════════════
   sidebar.js  —  4Pulse Sidebar
   Базируется на popup.js + override для sidebar-окружения:
   1. Никогда не закрывает окно
   2. adjustPopupHeight отключён (CSS управляет высотой)
   3. Polling работает независимо от close_on_open
   4. Счётчики видны в шапке sidebar
   ═══════════════════════════════════════════════════════════ */

// ── Константы (идентично popup.js) ─────────────────────────
const CLASS_HIDDEN = 'hidden';
const CLASS_ACTIVE = 'active';
const CLASS_READ   = 'read';
const CLASS_UNREAD = 'unread';
const CLASS_PINNED = 'pinned';

// Shared language cache for sidebar bootstrap + final i18n sweep.
let _cachedLang = document.documentElement.lang || 'ru';
function _getI18nStrings() {
    return typeof window.__sidebarGetI18nStrings === 'function'
        ? window.__sidebarGetI18nStrings()
        : {};
}

// ── Focus / Mute state (mirrors popup.js) ───────────────────

// 👥 User avatars visible on the current 4PDA page, keyed by username.
let _visibleUserAvatarMap = {};
let _authorAvatarLookupRequested = new Set();
let _authorAvatarLookupCount = 0;
const _AUTHOR_AVATAR_LOOKUP_LIMIT = 6;
function _normUserName(name) { return String(name || '').replace(/\s+/g, ' ').replace(/^@/, '').trim(); }
async function loadVisibleUserAvatars() {
    try {
        const cached = await chrome.storage.local.get(['visible_user_avatar_map']);
        if (cached.visible_user_avatar_map && typeof cached.visible_user_avatar_map === 'object') _visibleUserAvatarMap = cached.visible_user_avatar_map;
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs && tabs[0];
        if (!tab?.id || !/^https?:\/\/4pda\.to\//i.test(tab.url || '')) return;
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'user_avatars_from_page' }).catch(() => null);
        if (res?.ok && res.avatars && typeof res.avatars === 'object') {
            _visibleUserAvatarMap = { ..._visibleUserAvatarMap, ...res.avatars };
            await safeStorageSet({ visible_user_avatar_map: _visibleUserAvatarMap });
        }
    } catch (_) {}
}
function renderAuthorWithAvatar(authorEl, name, meta = {}) {
    return window.UICommon?.renderAuthorWithAvatar(authorEl, name, meta, {
        decodeHtmlEntities,
        normUserName: _normUserName,
        avatarMap: _visibleUserAvatarMap,
        requested: _authorAvatarLookupRequested,
        lookupCount: _authorAvatarLookupCount,
        maxLookups: _AUTHOR_AVATAR_LOOKUP_LIMIT,
        onLookupStart: () => { _authorAvatarLookupCount++; }
    });
}

async function safeStorageSet(data, callback) {
    if (window.UICommon?.storageSet) return window.UICommon.storageSet(data, callback);
    try {
        await chrome.storage.local.set(data);
        if (typeof callback === 'function') callback();
        return true;
    } catch (e) {
        const msg = String(e?.message || e || '');
        const quota = e?.name === 'QuotaExceededError' || /quota|QUOTA_BYTES|exceeded/i.test(msg);
        if (quota) {
            console.warn('[Sidebar] storage quota exceeded; evicting curator/radio caches and retrying:', e);
            try {
                await chrome.storage.local.remove(['curator_cache', 'radio_history', 'radio_play_counts', 'radio_last_played']);
                await chrome.storage.local.set(data);
                if (typeof callback === 'function') callback();
                return true;
            } catch (retryError) {
                console.warn('[Sidebar] storage.set retry failed:', retryError);
                if (typeof callback === 'function') callback(retryError);
                return false;
            }
        }
        console.warn('[Sidebar] storage.set failed:', e);
        if (typeof callback === 'function') callback(e);
        return false;
    }
}

let sidebarFocusedTopics = new Set();
let sidebarMutedTopics   = new Set();

async function loadSidebarFocusMuteState() {
    try {
        const stored = window.__sidebarInitData || await chrome.storage.local.get(['focused_topics', 'muted_topics']);
        sidebarFocusedTopics = new Set((stored.focused_topics || []).map(String));
        sidebarMutedTopics   = new Set((stored.muted_topics   || []).map(String));
    } catch(e) { console.warn('loadSidebarFocusMuteState:', e); }
}

// ══════════════════════════════════════════════════════════════
// 🎨 ICON PACKS — кастомные иконки для тем (sidebar-порт из popup.js)
// ══════════════════════════════════════════════════════════════

// ── Global UI icons: element id → emoji ─────────────────────
const UI_ICONS_EMOJI = {
    'stat-qms':            '💬',
    'stat-favorites':      '⭐',
    'stat-mentions':       '📣',
    'stat-bookmarks':      '🔖',
    'stat-tickets':        '🎫',
    'stat-history':        '🧭',
    'themes-open-all':     '📂',
    'themes-open-all-pin': '📌',
    'themes-read-all':     '✅',
};

// Built-in 4Pulse Lucent icon pack: element id → bundled SVG file.
const UI_ICONS_NEON = {
    'stat-qms':            '../img/icons/neon/stat-qms.svg',
    'stat-favorites':      '../img/icons/neon/stat-favorites.svg',
    'stat-mentions':       '../img/icons/neon/stat-mentions.svg',
    'stat-bookmarks':      '../img/icons/neon/stat-bookmarks.svg',
    'stat-tickets':        '../img/icons/neon/stat-tickets.svg',
    'stat-history':        '../img/icons/neon/stat-history.svg',
    'themes-open-all':     '../img/icons/neon/themes-open-all.svg',
    'themes-open-all-pin': '../img/icons/neon/themes-pinned.svg',
    'themes-read-all':     '../img/icons/neon/themes-read-all.svg',
};


let _customIconMap = null;

async function _loadCustomIcons() {
    try {
        const r = await chrome.storage.local.get('custom_icon_pack');
        _customIconMap = r.custom_icon_pack || {};
    } catch(_) {
        _customIconMap = {};
    }
}

function applyGlobalIconPack() {
    const pack = settings.icon_pack || 'default';
    const active = pack !== 'default';
    document.body.classList.toggle('icon-pack-active', active);

    for (const [id, emoji] of Object.entries(UI_ICONS_EMOJI)) {
        const el = document.getElementById(id);
        if (!el) continue;
        delete el.dataset.emoji;
        delete el.dataset.emojiImg;
        el.style.removeProperty('--icon-img');

        if (active) {
            let icon = emoji;
            if (pack === 'neon' && UI_ICONS_NEON[id]) {
                icon = UI_ICONS_NEON[id];
            } else if (pack === 'custom' && _customIconMap && _customIconMap[id]) {
                icon = _customIconMap[id];
            }
            const isUrl = /^(https?:|data:|moz-extension:|\/|\.\.?\/)/.test(icon) || /\.(svg|png|webp|jpg|jpeg|gif)$/i.test(icon);
            if (isUrl) {
                el.dataset.emojiImg = '1';
                el.style.setProperty('--icon-img', `url('${icon}')`);
            } else {
                el.dataset.emoji = icon;
            }
        }
    }
}

// Built-in emoji icon pack
const ICON_PACK_EMOJI = [
    { keys: ['iphone','ipad','apple','ios ','ipod','airpods','apple watch','macbook','macos','mac os','homepod','apple tv','vision pro','siri'], icon: '🍎' },
    { keys: ['android','aosp','lineageos','grapheneos','calyxos'], icon: '🤖' },
    { keys: ['samsung','galaxy','one ui','oneui','good lock','tizen','dex '], icon: '📱' },
    { keys: ['xiaomi','redmi','poco','miui','hyperos','mi band','mi pad','mi tv','roborock'], icon: '📱' },
    { keys: ['huawei','honor','harmonyos','emui','hms','hisilicon','kirin'], icon: '📱' },
    { keys: ['google','pixel','chromecast','nest','tensor','wear os'], icon: '🔍' },
    { keys: ['oneplus','oxygen','nothing phone','nothing ear','cmf phone','cmf buds'], icon: '📱' },
    { keys: ['realme','oppo','vivo','motorola','moto ','nokia','zte','meizu','asus zenfone','asus rog phone','sony xperia','lg ','htc','lenovo','tecno','infinix','itel','iqoo','nubia','red magic','black shark','fairphone','cat phone'], icon: '📱' },
    { keys: ['doogee','ulefone','oukitel','blackview','agm ','umidigi','cubot','hotwav','oscal','fossibot','unihertz'], icon: '📱' },
    { keys: ['windows','microsoft','surface','directx','wsl ','powershell','реестр','bios','uefi'], icon: '🖥️' },
    { keys: ['linux','ubuntu','debian','arch ','fedora','mint','manjaro','kde','gnome','xfce','wayland','x11','grub','kernel'], icon: '🐧' },
    { keys: ['macos','mac os','imac','mac mini','mac pro','mac studio','hackintosh'], icon: '🍏' },
    { keys: ['игр','game','gaming','steam','epic games','gog ','battlenet','battle.net','xbox','playstation','ps5','ps4','nintendo switch','retro','эмулят'], icon: '🎮' },
    { keys: ['кино','фильм','сериал','movie','film','netflix','кинопоиск','imdb','megogo','ivi ','okko','amediateka'], icon: '🎬' },
    { keys: ['музык','music','spotify','яндекс музык','vk music','apple music','last.fm','аудио','плейлист'], icon: '🎵' },
    { keys: ['книг','book','читалк','epub','pdf reader','fb2','litres','флибуст'], icon: '📚' },
    { keys: ['фото','photo','camera','камер','lightroom','photoshop','darktable','rawtherapee','instagram','flickr'], icon: '📷' },
    { keys: ['видео','video','youtube','vlc','mpv','kodi','plex','jellyfin','tiktok'], icon: '🎥' },
    { keys: ['vpn','proxy','тор ','tor ','wireguard','openvpn','shadowsocks','v2ray','xray','анонимн'], icon: '🔒' },
    { keys: ['безопасност','security','антивирус','antivirus','firewall','брандмауэр','пароль','password','2fa','двухфактор'], icon: '🛡️' },
    { keys: ['браузер','browser','firefox','chrome','chromium','edge','safari','opera','vivaldi','brave'], icon: '🌐' },
    { keys: ['мессенджер','messenger','telegram','whatsapp','signal','viber','vk ','discord','slack','skype'], icon: '💬' },
    { keys: ['навигац','gps','карт','maps','яндекс карт','google maps','osmand','waze'], icon: '🗺️' },
    { keys: ['погод','weather','gismeteo','яндекс погод'], icon: '⛅' },
    { keys: ['здоровь','health','фитнес','fitness','медицин','medical','mi fit','samsung health','apple health','garmin'], icon: '❤️' },
    { keys: ['финанс','finance','банк','bank','крипто','crypto','bitcoin','blockchain','акци','stocks','тинькофф','сбер'], icon: '💰' },
    { keys: ['умный дом','smart home','home assistant','homekit','google home','алиса','alexa','zigbee','z-wave','mqtt','tuya','tasmota','esphome'], icon: '🏠' },
    { keys: ['wi-fi','wifi','роутер','router','mesh','tp-link','asus router','keenetic','mikrotik','openwrt'], icon: '📡' },
    { keys: ['bluetooth','наушник','headphone','airpod','tws ','колонк','speaker'], icon: '🎧' },
    { keys: ['smartwatch','смарт.*часы','часы.*смарт','fitbit','amazfit','band ','galaxy watch','wear os','watchos'], icon: '⌚' },
    { keys: ['авто','auto','машин','автомобил','tesla','car ','ev ','электрокар','бортовой','obd','android auto','carplay'], icon: '🚗' },
    { keys: ['дрон','drone','квадрокоптер','fpv','dji ','betaflight','inav'], icon: '🚁' },
    { keys: ['faq','база знаний','wiki','справк','инструкц','guide','howto','how to','шапка темы','мануал','туториал','tutorial'], icon: '📚' },
    { keys: ['купить','продать','продаж','цена','скидк','aliexpress','купон','промокод','халява','распродаж','ozon','wildberries'], icon: '🛒' },
    { keys: ['ремонт','repair','разбор','teardown','замена экран','замена батаре','пайк','soldering','запчаст'], icon: '🔨' },
    { keys: ['3d принт','3d печат','3d print','ender','creality','prusa','filament','слайсер','slicer'], icon: '🖨️' },
    { keys: ['сервер','server','хостинг','hosting','vps','vds','выделенн','dedicated','домен','domain','ssl','nginx','apache','cloudflare'], icon: '🖧' },
    { keys: ['бэкап','бекап','backup','резервн.*копи','синхрониз','sync','облак','cloud','google drive','яндекс диск','dropbox','onedrive','icloud'], icon: '☁️' },
    { keys: ['новост','news','rss','лента','feed','агрегатор'], icon: '📰' },
];

function getTopicIcon(title) {
    if (!title) return null;
    const pack = settings.icon_pack || 'default';
    if (pack === 'default') return null;

    const lower = title.toLowerCase();

    if (pack === 'custom' && _customIconMap) {
        for (const [keyword, icon] of Object.entries(_customIconMap)) {
            if (lower.includes(keyword.toLowerCase())) {
                if (icon.startsWith('data:') || icon.startsWith('http') || icon.startsWith('/')) {
                    return { type: 'img', value: icon };
                }
                return { type: 'emoji', value: icon };
            }
        }
    }

    // 4Pulse Lucent topic icons: use bundled SVGs instead of emoji.
    if (pack === 'neon') {
        if (/qms|лс|личн|сообщ/i.test(lower)) return { type: 'img', value: '../img/icons/neon/stat-qms.svg' };
        if (/упомин|mention|@/i.test(lower)) return { type: 'img', value: '../img/icons/neon/stat-mentions.svg' };
        if (/ticket|тикет|жалоб/i.test(lower)) return { type: 'img', value: '../img/icons/neon/stat-tickets.svg' };
        if (/заклад|bookmark/i.test(lower)) return { type: 'img', value: '../img/icons/neon/stat-bookmarks.svg' };
        return { type: 'img', value: '../img/icons/neon/folder.svg' };
    }

    if (pack === 'emoji' || pack === 'custom') {
        for (const rule of ICON_PACK_EMOJI) {
            if (rule.keys.some(k => lower.includes(k))) {
                return { type: 'emoji', value: rule.icon };
            }
        }
        const emojiMatch = title.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
        if (emojiMatch) return { type: 'emoji', value: emojiMatch[1] };
        return { type: 'emoji', value: '📄' };
    }

    return null;
}

function applyTopicIcon(card, title) {
    const iconEl = card.querySelector('.topic-type-icon');
    if (!iconEl) return;

    const resolved = getTopicIcon(title);
    if (!resolved) {
        const defaultUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        defaultUse.setAttribute('href', '#icon-file-text');
        iconEl.replaceChildren(defaultUse);
        return;
    }

    if (resolved.type === 'emoji') {
        const span = document.createElement('span');
        span.className = 'topic-type-emoji';
        span.textContent = resolved.value;
        iconEl.replaceWith(span);
    } else if (resolved.type === 'img') {
        const img = document.createElement('img');
        img.className = 'topic-type-img';
        img.src = resolved.value;
        img.alt = '';
        img.loading = 'lazy';
        iconEl.replaceWith(img);
    }
}

// ── Состояние ───────────────────────────────────────────────
let elements    = {};
let settings    = {
    simple_list:       false,
    close_on_open:     false,   // ← sidebar НИКОГДА не закрывается
    default_view:      'favorites',
    show_all_favorites: false,
    show_all_qms:       false,
    show_all_mentions:  false,
    bw_icons:          false,
    mirror_mode:       false,
    accent_color:      'blue',
    compact_mode:      false,
    compact_stats:          false,
    compact_hide_qms:       false,
    compact_hide_favorites: false,
    compact_hide_mentions:  false,
    compact_only_stats:     false,
    compact_show_topics:    false,
    show_bookmarks_tab:     false,
    show_history_tab:       false,
    show_fav_toolbar:       true,
    show_topic_action_buttons: true,
    primary_click_action:   'forum',
    toolbar_button_open_all:  true,
    toolbar_button_pinned:    true,
    toolbar_button_read_all:  true,
    max_visible_topics:      0,
    icon_pack:               'default', // 'default' | 'emoji' | 'neon' | 'custom'
    toolbar_pin_themes_level: 0,
    productivity_panel_enabled: false,
    user_profile_mode:       'standard',
};
function applyTopicActionButtonsVisibility() {
    const hidden = settings.user_profile_mode === 'minimal' || settings.show_topic_action_buttons === false;
    document.body.dataset.userProfile = settings.user_profile_mode || 'standard';
    document.body.classList.toggle('hide-topic-action-buttons', hidden);
    document.querySelectorAll('#topic-list .card-actions').forEach(actions => {
        if (hidden) actions.style.setProperty('display', 'none', 'important');
        else actions.style.removeProperty('display');
    });
}

let currentData   = null;
let currentFilter = null;
let pollInterval  = null;

// ── Sidebar: polling каждые 30 секунд (активно всегда) ──────
const SIDEBAR_POLL_MS = 30_000;

// ── Инициализация ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // ★ OPT: один батчевый prefetch вместо множества отдельных storage.get при старте
        const _initData = await chrome.storage.local.get([
            'theme_mode','accent_color','font_family','font_size','line_height',
            'focused_topics','muted_topics','topic_tags','bm_collapsed_folders',
            'ui_language','radio_enabled','radio_station','radio_station_name',
            'tiles_row_config','tiles_order','priority_blinking','bw_icons',
            'disable_topic_animations','custom_icon_pack','show_history_tab',
        ]).catch(() => ({}));
        window.__sidebarInitData = _initData; // функции читают отсюда при первом вызове

        // Применяем язык сразу из prefetch (без лишнего IPC)
        if (_initData.ui_language) _cachedLang = _initData.ui_language;

        setupRealtimeUpdates();
        initializeClock();
        await applyThemeAndColors();
        await Promise.all([
            loadSidebarFocusMuteState(),
            _loadTopicTags(),
            _loadCollapsedFolders(),
        ]);
        await initializeSidebar();
        await applyFontSettings();
        window.__sidebarInitData = null; // сбрасываем prefetch — дальше читаем напрямую
    } catch (err) {
        console.error('Sidebar init error:', err);
    }
});

function showErrorState(msg) {
    const box = document.createElement('div');
    box.style.cssText = 'padding:20px;color:#ff6b6b;text-align:center';
    const title = document.createElement('b');
    title.textContent = 'Ошибка загрузки';
    const detail = document.createElement('div');
    detail.textContent = String(msg || '');
    detail.style.marginTop = '4px';
    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.textContent = 'Перезагрузить';
    reloadBtn.style.cssText = 'margin-top:10px;padding:6px 14px;cursor:pointer';
    reloadBtn.addEventListener('click', () => location.reload());
    box.append(title, detail, reloadBtn);
    document.body.replaceChildren(box);
}

// ── Priority Blink Driver (sidebar UI context — reliable setInterval) ──
let _sidebarBlinkTimer = null;
let _sidebarBlinkPhase = false;

function startSidebarBlink() {
    if (_sidebarBlinkTimer) return;
    _sidebarBlinkPhase = false;
    _sidebarBlinkTimer = setInterval(() => {
        _sidebarBlinkPhase = !_sidebarBlinkPhase;
        if (_sidebarBlinkPhase) {
            chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
            chrome.action.setBadgeText({ text: '!!' }).catch(() => {});
        } else {
            chrome.action.setBadgeBackgroundColor({ color: '#1A8FFF' }).catch(() => {});
            const count = (currentData?.favorites?.count || 0) + (currentData?.qms?.count || 0);
            chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' }).catch(() => {});
        }
    }, 600);
}

function stopSidebarBlink() {
    if (_sidebarBlinkTimer) { clearInterval(_sidebarBlinkTimer); _sidebarBlinkTimer = null; }
}

// ── Real-time updates (push от background) ──────────────────
function setupRealtimeUpdates() {
    function applyLiveCountsPayload(msg) {
        if (!msg || msg.action !== 'counts_updated' || !msg.counts) return;
        const c = msg.counts || {};
        updateCountersFromCounts(c);
        if (!currentData) currentData = msg.snapshot || currentData;
        if (currentData) {
            if (msg.snapshot) currentData = Object.assign(currentData, msg.snapshot);
            currentData.favorites = currentData.favorites || { list: [], count: 0 };
            currentData.qms       = currentData.qms       || { list: [], count: 0 };
            currentData.mentions  = currentData.mentions  || { list: [], count: 0 };
            currentData.tickets   = currentData.tickets   || { list: [], count: 0 };
            currentData.favorites.count = c.favorites ?? currentData.favorites.count ?? 0;
            currentData.qms.count       = c.qms       ?? currentData.qms.count       ?? 0;
            currentData.mentions.count  = c.mentions  ?? currentData.mentions.count  ?? 0;
            currentData.tickets.count   = c.tickets   ?? currentData.tickets.count   ?? 0;
            if (msg.favorites_list) currentData.favorites.list = msg.favorites_list;
            if (msg.qms_list)       currentData.qms.list       = msg.qms_list;
            if (msg.mentions_list)  currentData.mentions.list  = msg.mentions_list;
            if (msg.tickets_list)   currentData.tickets.list   = msg.tickets_list;
            if (msg.bookmarks_list) {
                currentData.bookmarks = currentData.bookmarks || {};
                currentData.bookmarks.list = msg.bookmarks_list;
            }
            updateStats(currentData);

            // Не перерисовываем все разделы на каждое push-событие.
            // Sidebar живёт долго, поэтому обновляем только открытую вкладку,
            // а currentData храним свежим для мгновенного переключения.
            if (currentFilter === 'favorites') renderTopics(currentData.favorites);
            else if (currentFilter === 'qms') {
                const openQmsInlineChat = elements.qmsList?.querySelector?.('.qms-inline-chat:not(.hidden)');
                const focusedQmsInlineChat = document.activeElement?.closest?.('.qms-inline-chat');
                if (!openQmsInlineChat && !focusedQmsInlineChat) renderQMS(currentData.qms);
            }
            else if (currentFilter === 'mentions') renderMentions(currentData.mentions);
            else if (currentFilter === 'tickets' && currentData.tickets?.list) renderTickets(currentData.tickets.list);
            else if (currentFilter === 'bookmarks' && currentData.bookmarks?.list) renderBookmarks(currentData.bookmarks.list);

            if (currentFilter) filterTopics(currentFilter);
        }
    }


    chrome.runtime.onMessage.addListener((msg) => {
        applyLiveCountsPayload(msg);

        // ★ OPT: централизованный роутинг — бывшие отдельные addListener
        if (msg.action === 'radio_state') {
            window.__sidebarRadioStateCallback?.(msg.state);
            window.__sidebarRspSleepCallback?.(msg.state);
        }

        // 📖 Мгновенное обновление Истории из background
        if (msg.action === 'ui_update_history' && msg.data) {
            if (!currentData) currentData = {};
            if (!currentData.history) currentData.history = {};
            currentData.history.list = msg.data;
            updateStats(currentData);
            if (currentFilter === 'history') renderHistory(msg.data);
        }

        // 🔖 Мгновенное обновление закладок после rename/delete через HTTP+WS
        if (msg.action === 'ui_update_bookmarks' && msg.data) {
            const bookmarks = msg.data;
            if (currentData) {
                if (!currentData.bookmarks) currentData.bookmarks = {};
                currentData.bookmarks.list = bookmarks;
            }
            // Обновляем счётчик в плитке
            const bmCount = bookmarks.filter(b => !b.deleted).length;
            const bmNum = elements.statBookmarks?.querySelector('.stat-number');
            if (bmNum) {
                bmNum.textContent = bmCount;
                bmNum.style.visibility = bmCount > 0 ? 'visible' : 'hidden';
            }
            // Снимаем is-loading
            document.querySelectorAll('li.is-loading').forEach(el => el.classList.remove('is-loading'));
            // Перерисовываем только если вкладка открыта и нет активного редактирования
            if (currentFilter === 'bookmarks') {
                const hasActiveEdit = elements.bookmarksList?.querySelector('input')
                                   || elements.bookmarksList?.querySelector('.bm-inline-confirm');
                if (!hasActiveEdit) renderBookmarks(bookmarks);
            }
        }
    });

    // Watch priority_blinking flag
    chrome.storage.local.get(['priority_blinking']).then(s => {
        if (s.priority_blinking) startSidebarBlink();
    }).catch(() => {});
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.priority_blinking !== undefined) {
            changes.priority_blinking.newValue ? startSidebarBlink() : stopSidebarBlink();
        }
    });
}

// Обновить списки без сброса текущего фильтра/скролла
async function refreshListsFromBackground() {
    try {
        await loadVisibleUserAvatars();
    const response = await sendMessage({ action: 'popup_loaded' });
        if (!response) return;
        currentData = response;
        renderTopics(response.favorites);
        renderQMS(response.qms);
        renderMentions(response.mentions);
        if (response.tickets?.list) renderTickets(response.tickets.list);
        updateStats(response);
    renderProductivityPanel(response);
        // Обновляем текущий фильтр чтобы показать новые элементы
        if (currentFilter) filterTopics(currentFilter);
        updateLastUpdateTime();
    } catch (e) { console.warn('refreshListsFromBackground error:', e); }
}

function updateCountersFromCounts(counts) {
    if (currentData) {
        currentData.favorites.count = counts.favorites;
        currentData.qms.count       = counts.qms;
        currentData.mentions.count  = counts.mentions;
        if (counts.tickets !== undefined && currentData.tickets)
            currentData.tickets.count = counts.tickets;
    }
    const favN = elements.statFavorites?.querySelector('.stat-number');
    if (favN) favN.textContent = counts.favorites;
    const qmsN = elements.statQms?.querySelector('.stat-number');
    if (qmsN) qmsN.textContent = counts.qms;
    const menN = elements.statMentions?.querySelector('.stat-number');
    if (menN) menN.textContent = counts.mentions;
    if (counts.tickets !== undefined && elements.statTickets) {
        const tikN = elements.statTickets.querySelector('.stat-number');
        if (tikN) tikN.textContent = counts.tickets;
    }
}

// ── Clock ────────────────────────────────────────────────────
function initializeClock() {
    const timeEl = document.getElementById('current-time');
    const dateEl = document.getElementById('current-date');
    if (!timeEl || !dateEl) return;
    const MONTHS = {
        ru: ['янв','фев','мар','апр','мая','июн','июл','авг','сен','окт','ноя','дек'],
        en: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
        de: ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'],
        uk: ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'],
    };
    let _lang = 'ru'; // cached language — only update via storage change
    chrome.storage.local.get(['ui_language']).then(r => { _lang = r.ui_language || 'ru'; }).catch(() => {});
    function tick() {
        const now = new Date();
        timeEl.textContent = String(now.getHours()).padStart(2,'0') + ':' +
                             String(now.getMinutes()).padStart(2,'0');
        const months = MONTHS[_lang] || MONTHS['ru'];
        dateEl.textContent = `${now.getDate()} ${months[now.getMonth()]}`;
    }
    tick();
    setInterval(tick, 60000);
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.ui_language) { _lang = changes.ui_language.newValue || 'ru'; tick(); }
    });
}

// ── Theme ─────────────────────────────────────────────────────
async function applyThemeAndColors() {
    // ★ OPT: берём из prefetch если доступен
    const data  = window.__sidebarInitData || await chrome.storage.local.get(['theme_mode','accent_color']);
    const theme = data.theme_mode || 'dark';
    if (theme === 'auto') {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        setThemeAttr4Pulse(dark ? 'dark' : 'light');
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            chrome.storage.local.get(['theme_mode'], d => {
                if (d.theme_mode === 'auto')
                    setThemeAttr4Pulse(e.matches ? 'dark' : 'light');
            });
        });
    } else {
        setThemeAttr4Pulse(theme);
    }
    let _accent = data.accent_color || 'blue';
    if (_accent === 'green') _accent = 'teal';
    if (_accent === 'pink' || _accent === 'red') _accent = 'blue';
    document.body.setAttribute('data-accent', _accent);
}

// ── Font settings ────────────────────────────────────────────
const GOOGLE_FONTS = {
    'inter':        'https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'roboto':       'https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,300;0,400;0,500;0,700;1,300;1,400&display=swap',
    'open-sans':    'https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'pt-sans':      'https://fonts.googleapis.com/css2?family=PT+Sans:ital,wght@0,400;0,700;1,400;1,700&display=swap',
    'ubuntu':       'https://fonts.googleapis.com/css2?family=Ubuntu:ital,wght@0,300;0,400;0,500;0,700;1,300;1,400&display=swap',
    'noto-sans':    'https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'source-sans':  'https://fonts.googleapis.com/css2?family=Source+Sans+3:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400&display=swap',
    'comfortaa':    'https://fonts.googleapis.com/css2?family=Comfortaa:wght@300;400;700&display=swap',
    'nunito':       'https://fonts.googleapis.com/css2?family=Nunito:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'manrope':      'https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&display=swap',
    'rubik':        'https://fonts.googleapis.com/css2?family=Rubik:ital,wght@0,300;0,400;0,500;0,700;1,300;1,400&display=swap',
    'montserrat':   'https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400&display=swap',
    'jetbrains-mono':'https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,700;1,300;1,400&display=swap',
    'golos-text':     'https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap',
    'wix-madefor':    'https://fonts.googleapis.com/css2?family=Wix+Madefor+Text:wght@400;500;600;700&display=swap',
    'commissioner':   'https://fonts.googleapis.com/css2?family=Commissioner:wght@400;500;600;700&display=swap',
    'ibm-plex-sans':  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap',
    'golos-text':     'https://fonts.googleapis.com/css2?family=Golos+Text:wght@400;500;600;700&display=swap',
    'wix-madefor':    'https://fonts.googleapis.com/css2?family=Wix+Madefor+Text:wght@400;500;600;700&display=swap',
    'commissioner':   'https://fonts.googleapis.com/css2?family=Commissioner:wght@400;500;600;700&display=swap',
    'ibm-plex-sans':  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap',
    'bricolage':    'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,600;12..96,700&display=swap',
    'onest':        'https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600;700&display=swap',
    'geologica':    'https://fonts.googleapis.com/css2?family=Geologica:slnt,wght@0,300;0,400;0,500;0,600;0,700&display=swap',
};

let _loadedFontUrl = null;
function _loadGoogleFont(family) {
    const url = GOOGLE_FONTS[family];
    if (!url || _loadedFontUrl === url) return;
    const existing = document.getElementById('dynamic-gfont');
    if (existing) existing.remove();
    const link = document.createElement('link');
    link.id    = 'dynamic-gfont';
    link.rel   = 'stylesheet';
    link.href  = url;
    link.onload = () => {
        const fontVal = FONT_FAMILIES[family];
        if (fontVal) document.body.style.setProperty('font-family', fontVal, 'important');
    };
    document.head.appendChild(link);
    _loadedFontUrl = url;
}

const FONT_FAMILIES = {
    'system':        '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'inter':         '"Inter", -apple-system, sans-serif',
    'roboto':        '"Roboto", -apple-system, sans-serif',
    'open-sans':     '"Open Sans", -apple-system, sans-serif',
    'pt-sans':       '"PT Sans", -apple-system, sans-serif',
    'ubuntu':        'Ubuntu, -apple-system, sans-serif',
    'noto-sans':     '"Noto Sans", -apple-system, sans-serif',
    'source-sans':   '"Source Sans Pro", -apple-system, sans-serif',
    'verdana':       'Verdana, Geneva, sans-serif',
    'comfortaa':     '"Comfortaa", cursive, -apple-system, sans-serif',
    'nunito':        '"Nunito", -apple-system, sans-serif',
    'manrope':       '"Manrope", -apple-system, sans-serif',
    'rubik':         '"Rubik", -apple-system, sans-serif',
    'montserrat':    '"Montserrat", -apple-system, sans-serif',
    'jetbrains-mono':'"JetBrains Mono", "Courier New", monospace, -apple-system, sans-serif',
    'golos-text':     '"Golos Text", -apple-system, sans-serif',
    'wix-madefor':    '"Wix Madefor Text", -apple-system, sans-serif',
    'commissioner':   '"Commissioner", -apple-system, sans-serif',
    'ibm-plex-sans':  '"IBM Plex Sans", -apple-system, sans-serif',
    'golos-text':     '"Golos Text", -apple-system, sans-serif',
    'wix-madefor':    '"Wix Madefor Text", -apple-system, sans-serif',
    'commissioner':   '"Commissioner", -apple-system, sans-serif',
    'ibm-plex-sans':  '"IBM Plex Sans", -apple-system, sans-serif',
    'bricolage':     '"Bricolage Grotesque", -apple-system, sans-serif',
    'onest':         '"Onest", -apple-system, sans-serif',
    'geologica':     '"Geologica", -apple-system, sans-serif',
};
const FONT_SIZES = { xs:'12px', small:'14px', medium:'16px', large:'18px', xl:'20px', xxl:'22px' };

async function applyFontSettings() {
    const data = window.__sidebarInitData || await chrome.storage.local.get(['font_family','font_size','line_height']);

    if (data.font_family && FONT_FAMILIES[data.font_family]) {
        _loadGoogleFont(data.font_family);
        const fontVal = FONT_FAMILIES[data.font_family];
        // !important чтобы перебить body { font-family: ... } из CSS
        document.body.style.setProperty('font-family', fontVal, 'important');
        document.querySelectorAll(
            '.time-clock, .time-date, .user-name-text, .topic-title, .topic-meta, ' +
            '.stat-number, .stat-label, .action-btn, header, main'
        ).forEach(el => el.style.setProperty('font-family', fontVal, 'important'));
    }

    if (data.font_size && FONT_SIZES[data.font_size]) {
        const base = parseInt(FONT_SIZES[data.font_size]);
        const root = document.documentElement;
        root.style.setProperty('--font-xs', `${base-6}px`);
        root.style.setProperty('--font-sm', `${base-4}px`);
        root.style.setProperty('--font-md', `${base-3}px`);
        root.style.setProperty('--font-lg', `${base-2}px`);
        root.style.setProperty('--font-xl', `${base}px`);
    }

    if (data.line_height) document.body.style.lineHeight = data.line_height;
}

// ── DOM Cache ────────────────────────────────────────────────
function cacheElements() {
    elements = {
        main:           document.querySelector('main'),
        username:       document.getElementById('user-name'),
        refresh:        document.getElementById('refresh'),
        options:        document.getElementById('options'),
        statQms:        document.getElementById('stat-qms'),
        statFavorites:  document.getElementById('stat-favorites'),
        statMentions:   document.getElementById('stat-mentions'),
        themeActions:   document.getElementById('theme-actions'),
        openAll:        document.getElementById('themes-open-all'),
        openPinned:     document.getElementById('themes-open-all-pin'),
        readAll:        document.getElementById('themes-read-all'),
        loadingSkeleton: document.getElementById('loading-skeleton'),
        emptyState:     document.getElementById('empty-state'),
        emptyTitle:     document.getElementById('empty-title'),
        topicsList:     document.getElementById('topic-list'),
        qmsList:        document.getElementById('qms-list'),
        mentionsList:   document.getElementById('mentions-list'),
        ticketsList:    document.getElementById('tickets-list'),
        bookmarksList:  document.getElementById('bookmarks-list'),
        historyList:    document.getElementById('history-list'),
        bmAddForm:       document.getElementById('bm-add-form'),
        bmAddTitle:      document.getElementById('bm-add-title'),
        bmAddUrl:        document.getElementById('bm-add-url'),
        bmAddSubmit:     document.getElementById('bm-add-submit'),
        bmAddCancel:     document.getElementById('bm-add-cancel'),
        bmGetNewpost:    document.getElementById('bm-getnewpost'),
        bmGetNewpostRow: document.getElementById('bm-getnewpost-row'),
        statTickets:    document.getElementById('stat-tickets'),
        statBookmarks:  document.getElementById('stat-bookmarks'),
        statHistory:    document.getElementById('stat-history'),
        lastUpdateTime: document.getElementById('last-update-time'),
        refreshBtn:     document.getElementById('refresh-btn'),
        settingsBtn:    document.getElementById('settings-btn'),
        topicTemplate:  document.getElementById('tpl-topic-card'),
        topicTemplateSimple: document.getElementById('tpl-topic-card-simple'),
    };
}

// ── Sidebar section routing ───────────────────────────────────
function openSidebarStatSection(type, event = null) {
    try {
        event?.preventDefault?.();
        event?.stopPropagation?.();

        const isModified = !!(event && (event.shiftKey || event.ctrlKey || event.metaKey));

        // Sidebar is an internal workspace: normal click always opens the local panel,
        // modifier click opens the corresponding 4PDA page. This mirrors the practical
        // popup behaviour expected by users and prevents accidental navigation from sidebar.
        if (type === 'radio') return;
        if (type === 'history') { toggleFilter('history'); return; }
        if (type === 'bookmarks') {
            if (isModified) openTab('bookmarks'); else toggleFilter('bookmarks');
            return;
        }

        const routeMap = { qms: 'qms', favorites: 'favorites', mentions: 'mentions', tickets: 'ticket' };
        if (isModified) openTab(routeMap[type] || type);
        else toggleFilter(type);
    } catch (e) {
        console.warn('[Sidebar] section click failed:', e);
    }
}

function syncSidebarView(type) {
    showLoading(false);
    showEmptyState(false);
    if (currentData) {
        if (type === 'favorites' && currentData.favorites) renderTopics(currentData.favorites);
        else if (type === 'qms' && currentData.qms) renderQMS(currentData.qms);
        else if (type === 'mentions' && currentData.mentions) renderMentions(currentData.mentions);
        else if (type === 'tickets' && currentData.tickets?.list) renderTickets(currentData.tickets.list);
        else if (type === 'bookmarks' && currentData.bookmarks?.list) renderBookmarks(currentData.bookmarks.list);
        else if (type === 'history' && currentData.history?.list) renderHistory(currentData.history.list);
    }
    filterTopics(type);
    requestAnimationFrame(() => {
        showLoading(false);
        showElement(elements.main);
        if (currentFilter === type) {
            const map = { favorites: elements.topicsList, qms: elements.qmsList, mentions: elements.mentionsList, tickets: elements.ticketsList, bookmarks: elements.bookmarksList, history: elements.historyList };
            const target = map[type];
            if (target) showElement(target);
        }
    });
}

// ── Event listeners ──────────────────────────────────────────
function setupEventListeners() {
    elements.username.addEventListener('click', () => openTab('user'));
    elements.refresh.addEventListener('click', handleRefreshClick);
    elements.options.addEventListener('click', () => openTab('options'));

    const mirrorBtn = document.getElementById('mirror-toggle');
    if (mirrorBtn) mirrorBtn.addEventListener('click', () => {
        settings.mirror_mode = !settings.mirror_mode;
        document.body.classList.toggle('mirror-mode', settings.mirror_mode);
        mirrorBtn.classList.toggle('active', settings.mirror_mode);
        safeStorageSet({ mirror_mode: settings.mirror_mode });
    });

    const compactBtn = document.getElementById('compact-toggle');
    if (compactBtn) compactBtn.addEventListener('click', toggleCompactMode);

    elements.statQms?.addEventListener('click', (e) => openSidebarStatSection('qms', e));
    elements.statFavorites?.addEventListener('click', (e) => openSidebarStatSection('favorites', e));
    elements.statMentions?.addEventListener('click', (e) => openSidebarStatSection('mentions', e));

    elements.refreshBtn?.addEventListener('click', () => refreshData());
    elements.settingsBtn?.addEventListener('click', () => openTab('options'));

    elements.statTickets?.addEventListener('click', (e) => openSidebarStatSection('tickets', e));
    elements.statBookmarks?.addEventListener('click', (e) => openSidebarStatSection('bookmarks', e));
    elements.statHistory?.addEventListener('click', (e) => openSidebarStatSection('history', e));

    // Safety net for Firefox Sidebar: delegated handler catches clicks even when
    // tiles are reordered/reinserted by the Scene Builder.
    document.querySelector('.stats-cards')?.addEventListener('click', (e) => {
        const card = e.target.closest('.stat-card[data-type]');
        if (!card || card.id === 'stat-radio-inline') return;
        if (e.target.closest('button, input, textarea, select, a')) return;
        openSidebarStatSection(card.dataset.type, e);
    });
}

// ── Compact mode ─────────────────────────────────────────────
function toggleCompactMode() {
    settings.compact_mode = !settings.compact_mode;
    document.body.classList.toggle('compact-mode', settings.compact_mode);
    document.getElementById('compact-toggle')?.classList.toggle('active', settings.compact_mode);
    safeStorageSet({ compact_mode: settings.compact_mode });
    applyFontSettings();
}

// ── adjustPopupHeight — ОТКЛЮЧЁН в sidebar ───────────────────
// CSS flex управляет высотой. main всегда flex:1 и скроллируется сам.
function adjustPopupHeight() { /* no-op in sidebar */ }

// ── Инициализация sidebar ────────────────────────────────────
async function initializeSidebar() {
    cacheElements();
    setupEventListeners();
    initBmAddForm();
    showLoading(true);
    await loadVisibleUserAvatars();

    const response = await sendMessage({ action: 'popup_loaded' });
    if (!response) {
        // Не авторизован — показать сообщение
        showErrorState('Войдите на 4PDA, чтобы использовать расширение.');
        return;
    }

    currentData = response;
    settings.simple_list        = response.settings.toolbar_simple_list;
    settings.default_view       = response.settings.toolbar_default_view || 'favorites';
    settings.show_all_favorites = response.settings.show_all_favorites || false;
    settings.show_all_qms       = response.settings.show_all_qms       || false;
    settings.show_all_mentions  = response.settings.show_all_mentions  || false;
    settings.bw_icons           = response.settings.bw_icons           || false;
    settings.accent_color       = response.settings.accent_color       || 'blue';
    settings.compact_mode       = response.settings.compact_mode       || false;
    settings.compact_stats      = response.settings.compact_stats      || false;
    settings.compact_hide_qms       = response.settings.compact_hide_qms       || false;
    settings.compact_hide_favorites = response.settings.compact_hide_favorites || false;
    settings.compact_hide_mentions  = response.settings.compact_hide_mentions  || false;
    settings.compact_only_stats     = response.settings.compact_only_stats     || false;
    settings.compact_show_topics    = response.settings.compact_show_topics    || false;
    settings.user_profile_mode       = response.settings.user_profile_mode || 'standard';
    settings.show_topic_action_buttons = response.settings.show_topic_action_buttons ?? true;
    applyTopicActionButtonsVisibility();
    settings.toolbar_pin_themes_level = response.settings.toolbar_pin_themes_level ?? 0;
    settings.show_bookmarks_tab         = response.settings.show_bookmarks_tab || false;
    settings.show_history_tab           = response.settings.show_history_tab || false;
    settings.toolbar_button_open_all    = response.settings.toolbar_button_open_all  ?? true;
    settings.toolbar_button_pinned      = response.settings.toolbar_button_pinned    ?? true;
    settings.toolbar_button_read_all    = response.settings.toolbar_button_read_all  ?? true;
    settings.primary_click_action       = response.settings.primary_click_action || 'forum';
    settings.mirror_mode                = response.settings.mirror_mode            || false;
    settings.icon_pack                  = response.settings.icon_pack              || 'default';
    settings.disable_topic_animations   = response.settings.disable_topic_animations || false;
    settings.productivity_panel_enabled = response.settings.productivity_panel_enabled === true;

    if (settings.bw_icons) document.body.classList.add('bw-icons');
    document.body.classList.toggle('no-topic-animations', !!settings.disable_topic_animations);
    document.body.setAttribute('data-accent', settings.accent_color);
    document.body.classList.toggle('mirror-mode', !!settings.mirror_mode);
    document.getElementById('mirror-toggle')?.classList.toggle('active', !!settings.mirror_mode);
    if (settings.compact_mode) {
        document.body.classList.add('compact-mode');
        document.getElementById('compact-toggle')?.classList.add('active');
    }
    if (settings.compact_stats) {
        document.body.classList.add('compact-stats-mode');
        applySidebarCompactTiles();
        applyCompactOnlyStats();
    }

    // 🔖 Bookmarks tile + tab visibility
    applySidebarBookmarksVisibility(settings.show_bookmarks_tab);
    applySidebarHistoryVisibility(settings.show_history_tab);
    if (settings.show_history_tab) chrome.runtime.sendMessage({ action: 'request_history' }).catch(() => {});

    // Пользователь
    const usernameText = elements.username.querySelector('.user-name-text');
    if (usernameText) usernameText.textContent = response.user_name;

    const userAvatar = document.getElementById('user-avatar');
    const userIconFallback = document.querySelector('.user-icon-fallback');
    function applyUserAvatar(url) {
        if (!userAvatar || !url) return false;
        const clean = String(url || '').trim();
        const isDataImage = /^data:image\//i.test(clean);
        const bad = !isDataImage && /(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon)/i.test(clean);
        if (!(isDataImage || /^https?:\/\//i.test(clean)) || bad) return false;

        userAvatar.onload = function() {
            if (this.naturalWidth < 16 || this.naturalHeight < 16) {
                this.style.display = 'none';
                this.classList.remove('loaded');
                if (userIconFallback) userIconFallback.style.display = 'inline-block';
                return;
            }
            this.style.display = 'block';
            this.classList.add('loaded');
            if (userIconFallback) userIconFallback.style.display = 'none';
        };
        userAvatar.onerror = function() {
            this.removeAttribute('src');
            this.style.display = 'none';
            this.classList.remove('loaded');
            if (userIconFallback) userIconFallback.style.display = 'inline-block';
        };
        userAvatar.src = clean;
        // Шапка пользователя — единый блок: либо реальный аватар + ник, либо fallback-иконка + ник.
        userAvatar.style.display = 'block';
        if (userIconFallback) userIconFallback.style.display = 'none';
        return true;
    }
    if (!applyUserAvatar(response.user_avatar_url)) {
        chrome.runtime.sendMessage({ action: 'user_avatar_refresh', force: true })
            .then(res => { if (res?.user_avatar_url) applyUserAvatar(res.user_avatar_url); })
            .catch(() => {});

    // 4Pulse 2.2.12: берём аватар прямо из открытой страницы профиля 4PDA.
    (async function tryApplyAvatarFromOpenProfile() {
        try {
            if (!chrome?.tabs || !chrome?.scripting) return;
            const tabs = await chrome.tabs.query({ url: ['https://4pda.to/forum/index.php*'] });
            if (!tabs || !tabs.length) return;
            const userId = String(response?.user_id || '');
            const userName = String(response?.user_name || '');
            tabs.sort((a, b) => {
                const au = a.url || '', bu = b.url || '';
                const ap = userId && au.includes('showuser=' + userId) ? 2 : (au.includes('showuser=') ? 1 : 0);
                const bp = userId && bu.includes('showuser=' + userId) ? 2 : (bu.includes('showuser=') ? 1 : 0);
                return bp - ap;
            });
            for (const tab of tabs.slice(0, 5)) {
                try {
                    const injected = await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        args: [userId, userName],
                        func: async (uid, uname) => {
                            const abs = (u) => {
                                if (!u) return '';
                                u = String(u).trim().replace(/&amp;/g, '&');
                                if (u.startsWith('//')) return 'https:' + u;
                                if (u.startsWith('/')) return 'https://4pda.to' + u;
                                return /^https?:\/\//i.test(u) ? u : '';
                            };
                            const bad = (u) => /(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon|logo|sprite|icon|button)/i.test(String(u || ''));
                            const selectors = ['.user-box .photo img','.photo img[alt*="Аватар" i]','.photo img','img[alt*="Аватар" i]', uname ? `img[title="${CSS.escape(uname)}"]` : '', uname ? `img[alt="${CSS.escape(uname)}"]` : ''].filter(Boolean);
                            let url = '';
                            for (const sel of selectors) {
                                const img = document.querySelector(sel);
                                const u = abs(img?.currentSrc || img?.src || img?.getAttribute('data-src') || img?.getAttribute('data-original') || '');
                                if (u && !bad(u)) { url = u; break; }
                            }
                            if (!url) return { ok:false };
                            try {
                                const r = await fetch(url, { credentials:'include', cache:'reload' });
                                const ct = (r.headers.get('content-type') || '').toLowerCase();
                                const blob = await r.blob();
                                if (r.ok && ct.startsWith('image/') && blob.size > 0 && blob.size < 512 * 1024) {
                                    const dataUrl = await new Promise((resolve) => {
                                        const fr = new FileReader();
                                        fr.onload = () => resolve(String(fr.result || ''));
                                        fr.onerror = () => resolve('');
                                        fr.readAsDataURL(blob);
                                    });
                                    return { ok:true, url, dataUrl };
                                }
                            } catch (_) {}
                            return { ok:true, url, dataUrl:'' };
                        }
                    });
                    const res = injected?.[0]?.result;
                    const avatar = res?.dataUrl || res?.url || '';
                    if (avatar && applyUserAvatar(avatar)) {
                        safeStorageSet({ cached_user_avatar: avatar, cached_user_avatar_source: res.url || avatar });
                        break;
                    }
                } catch (_) {}
            }
        } catch (_) {}
    })();
    }

    renderTopics(response.favorites);
    renderQMS(response.qms);
    renderMentions(response.mentions);
    if (response.tickets?.list) renderTickets(response.tickets.list);
    setupActionButtons();
    updateStats(response);

    // 🖼️ Icon pack
    await _loadCustomIcons();
    applyGlobalIconPack();

    // Sidebar по умолчанию показывает тот же раздел, что popup.
    const defaultView = settings.default_view === 'collapsed' ? 'favorites' : (settings.default_view || 'favorites');
    syncSidebarView(defaultView);
    setTimeout(() => syncSidebarView(currentFilter || defaultView), 120);

    updateLastUpdateTime();
    showLoading(false);

    // ── Порядок плиток + drag & drop (зеркало popup.js) ──
    await loadTilesRowConfig();
    await loadTilesOrder();
    applyTilesOrder();
    initTileDragDrop();

    // ── Запуск polling (работает всегда, независимо от close_on_open) ──
    startSidebarPolling();
}

// ── Sidebar polling — каждые 30 секунд ───────────────────────
function startSidebarPolling() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    pollInterval = setInterval(async () => {
        try {
            const counts = await sendMessage({ action: 'get_counts' });
            if (counts) updateCountersFromCounts(counts);
        } catch (e) { /* ignore */ }
    }, SIDEBAR_POLL_MS);
}

window.addEventListener('beforeunload', () => {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
});

// ── Storage changes ──────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, ns) => {
    if (ns !== 'local') return;
    if (changes.accent_color) document.body.setAttribute('data-accent', changes.accent_color.newValue);
    if (changes.bw_icons) document.body.classList.toggle('bw-icons', changes.bw_icons.newValue);
    if (changes.disable_topic_animations !== undefined) {
        settings.disable_topic_animations = changes.disable_topic_animations.newValue;
        document.body.classList.toggle('no-topic-animations', !!settings.disable_topic_animations);
    }
    if (changes.productivity_panel_enabled !== undefined) {
        settings.productivity_panel_enabled = changes.productivity_panel_enabled.newValue === true;
        if (settings.productivity_panel_enabled) _prodPanelHiddenForThisView = false;
        if (currentData) renderProductivityPanel(currentData);
    }
    if (changes.theme_mode) applyThemeAndColors();
    if (changes.font_family || changes.font_size || changes.line_height) applyFontSettings();
    if (changes.primary_click_action !== undefined) settings.primary_click_action = changes.primary_click_action.newValue;
    // 🪞 Mirror mode
    if (changes.mirror_mode !== undefined) {
        settings.mirror_mode = changes.mirror_mode.newValue;
        document.body.classList.toggle('mirror-mode', !!settings.mirror_mode);
        document.getElementById('mirror-toggle')?.classList.toggle('active', !!settings.mirror_mode);
    }
    // 🔀 Compact mode (кнопка в хедере)
    if (changes.compact_mode !== undefined) {
        settings.compact_mode = changes.compact_mode.newValue;
        document.body.classList.toggle('compact-mode', !!settings.compact_mode);
        document.getElementById('compact-toggle')?.classList.toggle('active', !!settings.compact_mode);
        applyFontSettings();
    }
    // 🔧 Тулбар сортировки
    if (changes.show_topic_action_buttons !== undefined) {
        settings.show_topic_action_buttons = changes.show_topic_action_buttons.newValue;
        applyTopicActionButtonsVisibility();
    }
    if (changes.user_profile_mode !== undefined) {
        settings.user_profile_mode = changes.user_profile_mode.newValue || 'standard';
        applyTopicActionButtonsVisibility();
    }

    if (changes.show_fav_toolbar !== undefined) {
        settings.show_fav_toolbar = changes.show_fav_toolbar.newValue;
        if (currentData?.favorites) renderTopics(currentData.favorites);
    }
    if (changes.compact_stats !== undefined) {
        settings.compact_stats = changes.compact_stats.newValue;
        document.body.classList.toggle('compact-stats-mode', !!settings.compact_stats);
        if (!settings.compact_stats) {
            const sc = document.querySelector('.stats-cards');
            if (sc) {
                sc.style.removeProperty('grid-template-columns');
                sc.style.removeProperty('grid-template-rows');
                sc.style.removeProperty('grid-auto-flow');
            }
            ['stat-qms','stat-favorites','stat-mentions',
             'stat-tickets','stat-bookmarks','stat-radio-inline','stat-history'].forEach(id => {
                const el = document.getElementById(id);
                if (el) { el.style.removeProperty('grid-column'); el.style.removeProperty('grid-row'); }
            });
            recalcRow2Layout();
            applyTilesOrder(); // восстанавливаем порядок плиток после выхода из compact
        }
        applyCompactOnlyStats();
    }
    // 🎛 compact_only_stats / compact_show_topics
    if (changes.compact_only_stats !== undefined || changes.compact_show_topics !== undefined) {
        if (changes.compact_only_stats !== undefined) settings.compact_only_stats = changes.compact_only_stats.newValue;
        if (changes.compact_show_topics !== undefined) settings.compact_show_topics = changes.compact_show_topics.newValue;
        applyCompactOnlyStats();
    }
    if (changes.show_bookmarks_tab !== undefined) {
        settings.show_bookmarks_tab = changes.show_bookmarks_tab.newValue;
        applySidebarBookmarksVisibility(settings.show_bookmarks_tab);
        if (currentFilter === 'bookmarks' && settings.show_bookmarks_tab) syncSidebarView('bookmarks');
    }
    if (changes.compact_hide_qms !== undefined || changes.compact_hide_favorites !== undefined ||
        changes.compact_hide_mentions !== undefined) {
        if (changes.compact_hide_qms       !== undefined) settings.compact_hide_qms       = changes.compact_hide_qms.newValue;
        if (changes.compact_hide_favorites !== undefined) settings.compact_hide_favorites = changes.compact_hide_favorites.newValue;
        if (changes.compact_hide_mentions  !== undefined) settings.compact_hide_mentions  = changes.compact_hide_mentions.newValue;
        applySidebarCompactTiles();
    }
    if (changes.toolbar_pin_themes_level !== undefined) {
        settings.toolbar_pin_themes_level = changes.toolbar_pin_themes_level.newValue;
        if (currentData?.favorites) renderTopics(currentData.favorites);
    }
    if (changes.toolbar_button_open_all !== undefined || changes.toolbar_button_pinned !== undefined || changes.toolbar_button_read_all !== undefined) {
        if (changes.toolbar_button_open_all !== undefined)
            settings.toolbar_button_open_all = changes.toolbar_button_open_all.newValue;
        if (changes.toolbar_button_pinned !== undefined)
            settings.toolbar_button_pinned = changes.toolbar_button_pinned.newValue;
        if (changes.toolbar_button_read_all !== undefined)
            settings.toolbar_button_read_all = changes.toolbar_button_read_all.newValue;
        setupActionButtons();
    }
    // 🔄 Обновляем отображение при изменении настроек показа всех элементов
    let needRerender = false;
    if (changes.show_all_favorites !== undefined) { settings.show_all_favorites = changes.show_all_favorites.newValue; needRerender = true; }
    if (changes.show_all_qms       !== undefined) { settings.show_all_qms       = changes.show_all_qms.newValue;       needRerender = true; }
    if (changes.show_all_mentions  !== undefined) { settings.show_all_mentions  = changes.show_all_mentions.newValue;  needRerender = true; }
    if (needRerender && currentData) {
        renderTopics(currentData.favorites);
        renderQMS(currentData.qms);
        renderMentions(currentData.mentions);
    }
    // 🔀 Синхронизация порядка плиток (если изменили в попапе)
    if (changes.show_history_tab !== undefined) {
        settings.show_history_tab = !!changes.show_history_tab.newValue;
        applySidebarHistoryVisibility(settings.show_history_tab);
        if (!settings.show_history_tab && currentFilter === 'history') expandAll();
    }
    if (changes.tiles_row_config) {
            _tilesRowConfig = changes.tiles_row_config.newValue?.row1 ? changes.tiles_row_config.newValue : null;
            applyTilesOrder();
            if (currentFilter) syncSidebarView(currentFilter);
        }
    if (changes.tiles_order) {
        loadTilesOrder().then(() => { applyTilesOrder(); if (currentFilter) syncSidebarView(currentFilter); });
    }
    // 🖼️ Icon pack — синхронизируем с попапом
    if (changes.icon_pack !== undefined || changes.custom_icon_pack !== undefined) {
        if (changes.icon_pack !== undefined) settings.icon_pack = changes.icon_pack.newValue || 'default';
        const doRerender = () => {
            if (currentData) {
                renderTopics(currentData.favorites);
                renderQMS(currentData.qms);
                renderMentions(currentData.mentions);
            }
            applyGlobalIconPack();
        };
        if (changes.custom_icon_pack !== undefined) {
            _loadCustomIcons().then(doRerender);
        } else {
            doRerender();
        }
    }
});

// ── Compact stats: скрываем/показываем плитки QMS/Избранное/Упоминания ──
// ── Compact only-stats: скрываем/показываем список тем ──────
function applyCompactOnlyStats() {
    if (!settings.compact_stats) return;
    const hideMain = settings.compact_only_stats && !settings.compact_show_topics;
    if (elements.main) elements.main.style.display = hideMain ? 'none' : '';
    document.body.classList.toggle('compact-only-stats-mode', !!hideMain);
}

function applySidebarCompactTiles() {
    const inCompact = settings.compact_stats;
    const hideQms = inCompact && settings.compact_hide_qms;
    const hideFav = inCompact && settings.compact_hide_favorites;
    const hideMen = inCompact && settings.compact_hide_mentions;
    const qms = document.getElementById('stat-qms');
    const fav = document.getElementById('stat-favorites');
    const men = document.getElementById('stat-mentions');
    if (qms) qms.style.display = hideQms ? 'none' : '';
    if (fav) fav.style.display = hideFav ? 'none' : '';
    if (men) men.style.display = hideMen ? 'none' : '';
    // CSS flex автоматически перестраивает ряд — JS ничего дополнительно не делает
}

function applySidebarBookmarksVisibility(show) {
    const tile = elements.statBookmarks;
    const tab  = elements.bookmarksList;
    const d    = show ? '' : 'none';
    if (tile) tile.style.display = d;
    if (tab)  tab.style.display  = d;
    // If bookmarks is active and we hide it — switch to favorites
    if (!show && currentFilter === 'bookmarks') {
        filterTopics('favorites');
    }
    // 🔧 FIX: Recalc row-2 layout after bookmarks visibility change
    recalcRow2Layout();
}

// ── Filter / Collapse ────────────────────────────────────────
function toggleFilter(type) {
    try {
        if (currentFilter === type) { expandAll(); return; }

        // Keep sidebar in sync with popup/background before switching sections.
        // Without this the sidebar can keep stale/skeleton state after Scene Builder
        // changes or after live counter updates.
        sendMessage({ action: 'popup_loaded' })
            .then(fresh => {
                if (fresh) {
                    currentData = fresh;
                    if (fresh.settings) {
                        settings.show_all_favorites = fresh.settings.show_all_favorites || false;
                        settings.show_all_qms       = fresh.settings.show_all_qms || false;
                        settings.show_all_mentions  = fresh.settings.show_all_mentions || false;
                        settings.show_bookmarks_tab = fresh.settings.show_bookmarks_tab || false;
                        settings.show_history_tab   = fresh.settings.show_history_tab || false;
                    }
                    updateStats(currentData);
                    applySidebarBookmarksVisibility(settings.show_bookmarks_tab);
                    applySidebarHistoryVisibility(settings.show_history_tab);
                }
                filterTopics(type);
            })
            .catch(() => filterTopics(type));
    } catch (error) {
        console.error('[Sidebar] toggleFilter error:', error);
        filterTopics(type);
    }
}

function expandAll() {
    // В sidebar нет collapsed — при повторном клике разворачиваем все
    currentFilter = null;
    showElement(elements.main);
    showElement(elements.themeActions);
    if (currentData) updateStats(currentData);
}

const filterTopics = (type) => {
    showLoading(false);
    showEmptyState(false);
    [elements.topicsList, elements.qmsList, elements.mentionsList, elements.ticketsList, elements.bookmarksList, elements.historyList]
        .forEach(el => hideElement(el));
    if (currentData) {
        if (type === 'favorites' && currentData.favorites) renderTopics(currentData.favorites);
        else if (type === 'qms' && currentData.qms) renderQMS(currentData.qms);
        else if (type === 'mentions' && currentData.mentions) renderMentions(currentData.mentions);
        else if (type === 'tickets' && currentData.tickets?.list) renderTickets(currentData.tickets.list);
        else if (type === 'bookmarks' && currentData.bookmarks?.list) renderBookmarks(currentData.bookmarks.list);
        else if (type === 'history' && currentData.history?.list) renderHistory(currentData.history.list);
    }
    return window.UICommon.filterTopics(type, {
        strings: _getI18nStrings(),
        elements,
        settings,
        getCurrentData: () => currentData,
        setCurrentFilter: (v) => { currentFilter = v; },
        show: showElement,
        hide: hideElement,
        showEmptyState,
        updateStats,
        renderBookmarks,
        renderHistory,
        renderTickets,
        afterFilter: () => showLoading(false),
        renderHistoryWhenEmpty: true,
        emptyMentionsText: 'Нет упоминаний'
    });
};

// ── Update stats ─────────────────────────────────────────────
function updateStats(data) {
    if (!data) return;
    const favN = elements.statFavorites?.querySelector('.stat-number');
    if (favN) favN.textContent = data.favorites.count;
    const qmsN = elements.statQms?.querySelector('.stat-number');
    if (qmsN) qmsN.textContent = data.qms.count;
    const menN = elements.statMentions?.querySelector('.stat-number');
    if (menN) menN.textContent = data.mentions.count;

    // 🔖 Bookmarks counter
    if (elements.statBookmarks && data.bookmarks?.list) {
        const bmCount = data.bookmarks.list.filter(b => !b.deleted).length;
        const bmNum = elements.statBookmarks.querySelector('.stat-number');
        if (bmNum) { bmNum.textContent = bmCount; bmNum.style.visibility = bmCount > 0 ? 'visible' : 'hidden'; }
    }

    // 📖 History counter
    if (elements.statHistory && data.history?.list) {
        _updateHistoryCounter(data.history.list);
    }

    // 🎫 Tickets stat card visibility + count
    if (data.tickets?.enabled && elements.statTickets) {
        elements.statTickets.style.display = '';
        const tikN = elements.statTickets.querySelector('.stat-number');
        if (tikN) tikN.textContent = data.tickets.count;
    } else if (elements.statTickets) {
        elements.statTickets.style.display = 'none';
    }
    // 🔧 FIX: Recalculate row-2 layout after any tile visibility change
    recalcRow2Layout();

    // Breathing icon when QMS has unread
    if (elements.statQms) {
        elements.statQms.dataset.hasUnread = data.qms.count > 0 ? 'true' : 'false';
    }

    // 🔖 Bookmarks: re-render if active
    if (currentFilter === 'bookmarks' && data.bookmarks?.list) {
        renderBookmarks(data.bookmarks.list);
    }

    [elements.statFavorites, elements.statQms, elements.statMentions, elements.statTickets, elements.statBookmarks, elements.statHistory].forEach(el => el?.classList.remove('active'));
    if (currentFilter === 'favorites') elements.statFavorites?.classList.add('active');
    else if (currentFilter === 'qms')       elements.statQms?.classList.add('active');
    else if (currentFilter === 'mentions')  elements.statMentions?.classList.add('active');
    else if (currentFilter === 'tickets')   elements.statTickets?.classList.add('active');
    else if (currentFilter === 'bookmarks') elements.statBookmarks?.classList.add('active');
    else if (currentFilter === 'history')   elements.statHistory?.classList.add('active');
}


// ── History visibility / rendering ─────────────────────────
function applySidebarHistoryVisibility(show) {
    if (elements.statHistory) elements.statHistory.style.display = show ? '' : 'none';
    if (!show && currentFilter === 'history') expandAll();
    fillLastTileRow();
}

const HISTORY_HIDDEN_KEY = '4pulse_hidden_history_topics_v1';

function _historyHiddenSet() {
    try { return new Set(JSON.parse(localStorage.getItem(HISTORY_HIDDEN_KEY) || '[]').map(String)); }
    catch (_) { return new Set(); }
}
function _saveHistoryHiddenSet(set) {
    localStorage.setItem(HISTORY_HIDDEN_KEY, JSON.stringify([...set]));
}
function _historyTopicKey(topic) {
    return String(topic?.topic_id || topic?.id || topic?.url || topic?.title || '');
}
function _visibleHistory(topics) {
    const hidden = _historyHiddenSet();
    return (topics || []).filter(t => !hidden.has(_historyTopicKey(t)));
}
function _updateHistoryCounter(topics) {
    const num = elements.statHistory?.querySelector('.stat-number');
    if (!num) return;
    const count = _visibleHistory(topics || currentData?.history?.list || []).length;
    num.textContent = count ? String(count) : '';
    num.style.visibility = count > 0 ? 'visible' : 'hidden';
}
function _esc(s) {
    return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function openUrl(url) {
    chrome.runtime.sendMessage({ action: 'open_url', what: 'external', url, sidebar: true }).catch(() => {});
}
function _historyUrl(topic) {
    const raw = topic?.url || topic?.topic_url || topic?.link || '';
    if (raw) return String(raw).startsWith('http') ? raw : 'https://4pda.to' + raw;
    const id = topic?.topic_id || topic?.id;
    return id ? `https://4pda.to/forum/index.php?showtopic=${id}` : 'https://4pda.to/forum/';
}
const HISTORY_PINNED_KEY = '4pulse_pinned_work_topics_v1';
function _historyLoadPinned() {
    try { const arr = JSON.parse(localStorage.getItem(HISTORY_PINNED_KEY) || '[]'); return Array.isArray(arr) ? arr : []; }
    catch (_) { return []; }
}
function _historySavePinned(items) {
    const clean = [], seen = new Set();
    (items || []).forEach(t => {
        const key = _historyTopicKey(t); if (!key || seen.has(key)) return;
        seen.add(key);
        clean.push({ id:t.id||t.topic_id||key, topic_id:t.topic_id||t.id||'', title:t.title||t.name||`Тема #${t.id||t.topic_id||''}`, url:_historyUrl(t), snippet:t.snippet||t.last_user||t.forum_title||t.section||'', last_post_ts:t.last_post_ts||t.time||t.ts||Math.floor(Date.now()/1000) });
    });
    localStorage.setItem(HISTORY_PINNED_KEY, JSON.stringify(clean.slice(0, 30)));
}
function _historyIsPinned(topic) {
    const key = _historyTopicKey(topic);
    return _historyLoadPinned().some(t => _historyTopicKey(t) === key || _historyUrl(t) === _historyUrl(topic));
}
function _historyTogglePinned(topic) {
    const key = _historyTopicKey(topic);
    let pins = _historyLoadPinned();
    if (_historyIsPinned(topic)) pins = pins.filter(t => _historyTopicKey(t) !== key && _historyUrl(t) !== _historyUrl(topic));
    else pins.unshift(topic);
    _historySavePinned(pins);
}
function _lastTicketInfo() {
    const list = currentData?.tickets?.list || [];
    const t = Array.isArray(list) && list.length ? list[0] : null;
    return t ? { title: t.title || `Тикет #${t.id || ''}`, sub: [t.section || t.forum || '', t.status || ''].filter(Boolean).join(' · '), id: t.id } : null;
}
const renderHistory = (topics) => window.UICommon.renderHistory(topics, {
    strings: _getI18nStrings(),
    elements,
    esc: _esc,
    beforeRender: (allTopics) => {
        if (currentData) {
            if (!currentData.history) currentData.history = {};
            currentData.history.list = allTopics;
        }
    },
    visibleHistory: _visibleHistory,
    hiddenSet: _historyHiddenSet,
    saveHidden: _saveHistoryHiddenSet,
    loadPinned: _historyLoadPinned,
    savePinned: _historySavePinned,
    isPinned: _historyIsPinned,
    togglePinned: _historyTogglePinned,
    historyTopicKey: _historyTopicKey,
    historyUrl: _historyUrl,
    timeAgo: _historyTimeAgo,
    lastTicketInfo: _lastTicketInfo,
    updateCounter: _updateHistoryCounter,
    toggleFilter,
    openUrl,
    hideKey: _historyTopicKey,
    pinLimit: 10,
    refreshSpinnerMs: 900
});
function _historyTimeAgo(ts) {
    if (!ts) return '';
    const n = Number(ts);
    const ms = n > 1e12 ? n : n * 1000;
    const diff = Math.max(0, Date.now() - ms);
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return `${min} мин`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} ч`;
    const d = Math.floor(h / 24);
    return `${d} д`;
}

// ── Render Topics ────────────────────────────────────────────
// ── Favorites state ───────────────────────────────────────────────────────
let _favSort      = 'date';   // 'date' | 'title' | 'unread'
let _favGroup     = false;    // group by section prefix?
let _favTagFilter = null;     // string | null — фильтр по тегу
let _topicTags    = {};       // {topicId: [tag, ...]}

async function _loadTopicTags() {
    try { const r = await chrome.storage.local.get('topic_tags'); _topicTags = r.topic_tags || {}; }
    catch(_) { _topicTags = {}; }
}
async function _saveTopicTags() {
    await safeStorageSet({ topic_tags: _topicTags });
}

// Detect section prefix from topic title: "Samsung Galaxy S22 / ..." → "Samsung"
function _topicSection(title) {
    if (!title) return '—';
    const known = ['Samsung','Xiaomi','Redmi','POCO','Apple','iPhone','iPad','Huawei','Honor',
                   'OnePlus','Realme','OPPO','Vivo','Google','Motorola','Sony','LG','Asus',
                   'Lenovo','HTC','Nokia','ZTE','Meizu','Флай','Doogee','Ulefone','Oukitel'];
    for (const k of known) {
        if (title.toLowerCase().startsWith(k.toLowerCase())) return k;
    }
    // Try first word
    const first = title.split(/[\s\/\-]/)[0];
    return first && first.length > 2 ? first : '—';
}

// ── Persistent curator cache (survives popup close/open) ─────────────────
const CURATOR_CACHE_KEY = 'ticket_curator_cache';
let _curatorCache = null; // {ticketId: {curator, responsible, topicTitle, topicUrl, ts}}

// ── QMS lazy-loading state (mirrors popup.js) ─────────────────
let qmsObserver = null;
const loadingQmsSubjects = new Set();

async function _loadCuratorCache() {
    if (_curatorCache) return;
    try {
        const r = await chrome.storage.local.get(CURATOR_CACHE_KEY);
        _curatorCache = r[CURATOR_CACHE_KEY] || {};
        // Чистим записи старше 24 часов
        const now = Date.now();
        let changed = false;
        for (const k of Object.keys(_curatorCache)) {
            if (now - (_curatorCache[k].ts || 0) > 86400000) { delete _curatorCache[k]; changed = true; }
        }
        if (changed) safeStorageSet({ [CURATOR_CACHE_KEY]: _curatorCache });
    } catch(_) { _curatorCache = {}; }
}

async function _saveCuratorCache() {
    await safeStorageSet({ [CURATOR_CACHE_KEY]: _curatorCache });
}

// ── Request queue (max 2 parallel) ────────────────────────────────────────
const _curatorQueue = [];
let _curatorRunning = 0;
const CURATOR_CONCURRENCY = 2;

function _enqueueCurator(ticketId, card, cached) {
    _curatorQueue.push({ ticketId, card, cached });
    _drainCuratorQueue();
}

function _drainCuratorQueue() {
    while (_curatorRunning < CURATOR_CONCURRENCY && _curatorQueue.length > 0) {
        const { ticketId, card, cached } = _curatorQueue.shift();
        _curatorRunning++;
        chrome.runtime.sendMessage({ action: 'ticket_fetch_curator', id: ticketId })
            .then(resp => {
                _curatorRunning--;
                _drainCuratorQueue();
                if (!resp?.ok) return;
                const entry = {
                    curator:     resp.curator     || '',
                    responsible: resp.responsible || '',
                    topicTitle:  resp.topicTitle  || '',
                    topicUrl:    resp.topicUrl    || '',
                    ts:          Date.now(),
                };
                if (_curatorCache) {
                    _curatorCache[String(ticketId)] = entry;
                    _saveCuratorCache();
                }
                if (cached) Object.assign(cached, entry, { curatorFetched: true });
                if (card && document.contains(card)) _applyTicketThreadData(card, entry);
            })
            .catch(() => { _curatorRunning--; _drainCuratorQueue(); });
    }
}

// Показывает мини-редактор тегов прямо в карточке
function _showTagEditor(card, topicId) {
    const existing = card.querySelector('.fav-tag-editor');
    if (existing) { existing.remove(); return; }

    const idStr = String(topicId);
    const tags  = [...(_topicTags[idStr] || [])];

    const editor = document.createElement('div');
    editor.className = 'fav-tag-editor';
    const editorInner = document.createElement('div');
    editorInner.className = 'fav-tag-editor-inner';
    const editorTags = document.createElement('div');
    editorTags.className = 'fav-tag-editor-tags';
    const editorInput = document.createElement('input');
    editorInput.className = 'fav-tag-input';
    editorInput.placeholder = 'Новый тег... Enter';
    editorInput.maxLength = 20;
    editorInput.type = 'text';
    editorInner.append(editorTags, editorInput);
    editor.appendChild(editorInner);
    editor.addEventListener('click', e => e.stopPropagation());

    const tagsDiv = editor.querySelector('.fav-tag-editor-tags');
    const input   = editor.querySelector('.fav-tag-input');

    const refresh = () => {
        tagsDiv.replaceChildren();
        tags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'fav-tag fav-tag-removable';
            chip.textContent = tag + ' ×';
            chip.addEventListener('click', async (e) => {
                e.stopPropagation();
                tags.splice(tags.indexOf(tag), 1);
                _topicTags[idStr] = tags;
                if (tags.length === 0) delete _topicTags[idStr];
                await _saveTopicTags();
                refresh();
                renderTopics(currentData?.favorites);
            });
            tagsDiv.appendChild(chip);
        });
    };
    refresh();

    input.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const val = input.value.trim();
        if (!val || tags.includes(val)) { input.value = ''; return; }
        tags.push(val);
        _topicTags[idStr] = tags;
        await _saveTopicTags();
        input.value = '';
        refresh();
        renderTopics(currentData?.favorites);
    });

    const cardBody = card.querySelector('.card-body');
    if (cardBody) cardBody.appendChild(editor);
    input.focus();
    setTimeout(() => adjustPopupHeight(), 30);
}

function _applyTicketThreadData(card, data) {
    if (!card || !data) return;

    let meta = card.querySelector('.ticket-row-meta');
    if (!meta) {
        const inner  = card.querySelector('.ticket-card-inner');
        const rowTop = card.querySelector('.ticket-row-top');
        meta = document.createElement('div');
        meta.className = 'ticket-row-meta';
        if (rowTop && inner) inner.insertBefore(meta, rowTop.nextSibling);
        else if (inner) inner.prepend(meta);
    }

    // Куратор темы — оранжевый акцент
    if (data.curator) {
        let tag = meta.querySelector('.ticket-curator-tag');
        if (!tag) {
            tag = document.createElement('span');
            tag.className = 'ticket-curator-tag';
            meta.appendChild(tag);
        }
        tag.title = 'Куратор темы: ' + data.curator;
        tag.textContent = '👁 ' + data.curator;
    }

    // Ответственный (кто взял в работу) — серый тег
    if (data.responsible) {
        let tag = meta.querySelector('.ticket-responsible-tag');
        if (!tag) {
            tag = document.createElement('span');
            tag.className = 'ticket-responsible-tag';
            meta.appendChild(tag);
        }
        tag.title = 'Взял в работу: ' + data.responsible;
        tag.textContent = '👤 ' + data.responsible;
    }

    // Тема форума — кликабельная ссылка под заголовком
    if (data.topicTitle) {
        let topicEl = card.querySelector('.ticket-topic-ref');
        if (!topicEl) {
            const inner   = card.querySelector('.ticket-card-inner');
            const titleEl = card.querySelector('.ticket-title');
            topicEl = document.createElement('a');
            topicEl.className = 'ticket-topic-ref interactive';
            topicEl.target    = '_blank';
            topicEl.rel       = 'noopener';
            topicEl.addEventListener('click', e => {
                e.stopPropagation();
                if (topicEl.dataset.url) {
                    chrome.runtime.sendMessage({ action: 'open_url', what: 'external', url: topicEl.dataset.url });
                    // sidebar никогда не закрывается
                }
            });
            if (titleEl && inner) inner.insertBefore(topicEl, titleEl.nextSibling);
        }
        topicEl.title          = data.topicTitle;
        topicEl.textContent    = '📌 ' + data.topicTitle;
        topicEl.dataset.url    = data.topicUrl || '';
    }
}

// Обратная совместимость
function _showCuratorTag(card, curatorName) {
    _applyTicketThreadData(card, { curator: curatorName });
}





// ============================================================
// MESSAGE PREVIEW — favorites / QMS / mentions
// Inspired by 4pdaScript snapback preview: fetch target page,
// extract the post/message body and show it inline without opening a tab.
// ============================================================
function ensureMessagePreviewBox(card) {
    if (!card) return null;
    let box = card.querySelector('.message-preview-box');
    if (!box) {
        box = document.createElement('div');
        box.className = 'message-preview-box hidden';
        const body = card.querySelector('.card-body') || card;
        body.appendChild(box);
    }
    return box;
}

function normalizeForumUrl(url) {
    if (!url) return '';
    url = String(url).trim().replace(/&amp;/g, '&');
    if (url.startsWith('//')) return 'https:' + url;
    if (url.startsWith('/')) return 'https://4pda.to' + url;
    if (/^https?:\/\//i.test(url)) return url;
    return 'https://4pda.to/forum/' + url.replace(/^\.\//, '');
}

function stripPreviewNode(node) {
    if (!node) return '';
    const clone = node.cloneNode(true);
    clone.querySelectorAll('script, style, iframe, object, embed, form, input, textarea, button, select, .edit, .signature, .post-footer, .post-edit-reason, .moderator-actions, .pinlink, .karma, .rep').forEach(el => el.remove());
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    clone.querySelectorAll('img').forEach(img => {
        const alt = img.getAttribute('alt') || img.getAttribute('title') || '';
        img.replaceWith(alt ? ` ${alt} ` : ' [изображение] ');
    });
    clone.querySelectorAll('a').forEach(a => {
        const txt = (a.textContent || '').trim();
        a.replaceWith(txt || a.getAttribute('href') || 'ссылка');
    });
    let text = clone.textContent || '';
    text = text.replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .replace(/\s+$/g, '')
        .trim();
    if (text.length > 900) text = text.slice(0, 900).trim() + '…';
    return text;
}

function extractForumPostPreview(html, postId = '') {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');

    if (postId) {
        const id = String(postId);
        const selectors = [
            `table[data-post="${CSS.escape(id)}"] .postcolor`,
            `#post-main-${CSS.escape(id)} .postcolor`,
            `td#post-main-${CSS.escape(id)} .postcolor`,
            `#post-${CSS.escape(id)} .postcolor`,
            `#post-${CSS.escape(id)}`,
            `a[name="entry${CSS.escape(id)}"]`,
        ];
        for (const sel of selectors) {
            try {
                const found = doc.querySelector(sel);
                if (!found) continue;
                const node = sel.startsWith('a[name=')
                    ? (found.closest('tr')?.querySelector('.postcolor') ||
                       found.closest('td')?.querySelector('.postcolor') ||
                       found.parentElement)
                    : found;
                const text = stripPreviewNode(node);
                if (text) return text;
            } catch (_) {}
        }
    }

    const posts = [...doc.querySelectorAll(
        '[id^="post-main-"] .postcolor, table[data-post] .postcolor, ' +
        'td.post1 .postcolor, td.post2 .postcolor, .postcolor'
    )];
    for (let i = posts.length - 1; i >= 0; i--) {
        const text = stripPreviewNode(posts[i]);
        if (text) return text;
    }
    return 'Текст сообщения не найден.';
}


function extractForumSearchPreview(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    // Search results are sorted by date desc (sort=dd), so the first post block is the newest.
    const selectors = [
        'table[data-post] .postcolor',
        '[id^="post-main-"] .postcolor',
        'td.post1 .postcolor',
        'td.post2 .postcolor',
        '.postcolor'
    ];
    for (const sel of selectors) {
        const nodes = [...doc.querySelectorAll(sel)];
        for (const node of nodes) {
            const text = stripPreviewNode(node);
            if (text) return text;
        }
    }
    return '';
}

function extractQmsPreview(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    // 4PDA QMS thread: messages have [data-message-id], text is in .msg-content
    // (confirmed by 4pdaScript using querySelectorAll('[data-message-id]'))
    const selectors = [
        '[data-message-id] .msg-content',
        '.msg-content',
        '.qms-message',
        '.message-content',
        '.message-text',
        '[id^="msg"]',
        '[data-message-id]',
        '.list-group-item',
        '.postcolor'
    ];
    let nodes = [];
    for (const sel of selectors) {
        nodes = [...doc.querySelectorAll(sel)].filter(n => stripPreviewNode(n).length > 0);
        if (nodes.length) break;
    }
    if (nodes.length) {
        return nodes.slice(-3).map(n => stripPreviewNode(n)).filter(Boolean).join('\n\n') || 'Сообщения не найдены.';
    }
    const bodyText = stripPreviewNode(doc.body);
    return bodyText ? bodyText.slice(0, 900) : 'История QMS не найдена.';
}

async function fetchPreviewHtml(url) {
    const res = await chrome.runtime.sendMessage({ action: 'fetch_page', url });
    if (!res?.ok) throw new Error(res?.error || 'fetch failed');
    return res.html || '';
}

async function toggleMessagePreview(card, type, payload = {}) {
    const box = ensureMessagePreviewBox(card);
    if (!box) return;
    if (!box.classList.contains('hidden') && box.dataset.loaded === '1') {
        box.classList.add('hidden');
        card.classList.remove('preview-open');
        if (typeof adjustPopupHeight === 'function') setTimeout(adjustPopupHeight, 30);
        return;
    }
    box.classList.remove('hidden');
    card.classList.add('preview-open');
    box.classList.add('loading');
    box.textContent = 'Загрузка предпросмотра…';
    if (typeof adjustPopupHeight === 'function') setTimeout(adjustPopupHeight, 30);
    try {
        let text = '';
        if (type === 'favorite') {
            // IMPORTANT: do not use view=getnewpost for preview — 4PDA marks the topic as read.
            // Direct findpost/pid is best. If there is no direct pid, use safe topic search and take the newest result.
            if (!payload.post_id && !payload.post_url) {
                if (payload.topic_id) {
                    const searchUrl = `https://4pda.to/forum/index.php?act=search&source=pst&noform=1&sort=dd&result=posts&topics=${encodeURIComponent(payload.topic_id)}`;
                    text = extractForumSearchPreview(await fetchPreviewHtml(searchUrl));
                }
                if (!text) {
                    box.classList.remove('loading');
                    box.classList.add('info-only');
                    box.dataset.loaded = '0';
                    box.textContent = 'Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.';
                    card.classList.remove('preview-open');
                    if (typeof adjustPopupHeight === 'function') setTimeout(adjustPopupHeight, 50);
                    return;
                }
            } else {
                const url = payload.post_url
                    ? normalizeForumUrl(payload.post_url)
                    : `https://4pda.to/forum/index.php?act=findpost&pid=${encodeURIComponent(payload.post_id)}`;
                text = extractForumPostPreview(await fetchPreviewHtml(url), payload.post_id || '');
            }
        } else if (type === 'mention') {
            const url = payload.article_url
                ? normalizeForumUrl(payload.article_url)
                : `https://4pda.to/forum/index.php?act=findpost&pid=${encodeURIComponent(payload.post_id)}`;
            text = extractForumPostPreview(await fetchPreviewHtml(url), payload.post_id);
        } else if (type === 'qms') {
            const url = `https://4pda.to/forum/index.php?act=qms&mid=${encodeURIComponent(payload.opponent_id || '')}&t=${encodeURIComponent(payload.dialog_id || '')}`;
            text = extractQmsPreview(await fetchPreviewHtml(url));
        }
        box.classList.remove('loading');
        box.dataset.loaded = '1';
        box.textContent = text || 'Предпросмотр пуст.';
    } catch (e) {
        box.classList.remove('loading');
        box.textContent = (card.querySelector('.topic-title, .qms-title, .card-title')?.textContent || 'Не удалось загрузить предпросмотр.');
        console.warn('[4Pulse] preview error:', e);
    }
    if (typeof adjustPopupHeight === 'function') setTimeout(adjustPopupHeight, 50);
}

function addMessagePreviewButton(card, type, payload = {}) {
    if (!card?.querySelector) return;

    // Предпросмотр: избранные и упоминания. QMS — через inline-чат.
    let actions = card.querySelector('.card-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.className = 'card-actions';
        card.appendChild(actions);
    } else {
        actions.classList.remove('preview-actions');
    }
    if (actions.querySelector('.message-preview-btn')) return;

    const btn = document.createElement('button');
    btn.className = 'action-icon message-preview-btn interactive';
    btn.type = 'button';
    btn.title = 'Предпросмотр сообщения';
    btn.setAttribute('aria-label', 'Предпросмотр сообщения');
    const previewSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    previewSvg.setAttribute('class', 'icon');
    previewSvg.setAttribute('viewBox', '0 0 24 24');
    previewSvg.setAttribute('fill', 'none');
    previewSvg.setAttribute('stroke', 'currentColor');
    previewSvg.setAttribute('stroke-width', '2');
    previewSvg.setAttribute('stroke-linecap', 'round');
    previewSvg.setAttribute('stroke-linejoin', 'round');
    const previewPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    previewPath.setAttribute('d', 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z');
    previewSvg.appendChild(previewPath);
    btn.appendChild(previewSvg);
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleMessagePreview(card, type, payload);
    });
    actions.insertBefore(btn, actions.firstChild);
}

function renderTopics(favoritesData) {
    return UICommon.renderTopics(favoritesData, {
        elements,
        settings,
        createTopicCard,
        adjustPopupHeight,
        getFavoritesData: () => favoritesData,
        getFavSort: () => _favSort,
        setFavSort: v => { _favSort = v; },
        getFavGroup: () => _favGroup,
        setFavGroup: v => { _favGroup = v; },
        getFavTagFilter: () => _favTagFilter,
        setFavTagFilter: v => { _favTagFilter = v; },
        topicTags: _topicTags,
        topicSection: _topicSection,
        focusedTopics: sidebarFocusedTopics,
        afterTopicsRendered: () => applyTopicActionButtonsVisibility()
    });
}


function createTopicCard(topic, template, index, isRead) {
    const clone = template.content.cloneNode(true);
    const card  = clone.querySelector('.topic-card');
    const topicIdStr = String(topic.id);
    card.id = `topic_${topic.id}`;
    card.style.animationDelay = `${index * 0.04}s`;
    card.classList.add(isRead ? CLASS_READ : CLASS_UNREAD);
    if (topic.pin) { card.classList.add(CLASS_PINNED); card.querySelector('.topic-pin-icon')?.classList.remove(CLASS_HIDDEN); }

    const titleEl = card.querySelector('.topic-title');
    if (titleEl) { titleEl.textContent = decodeHtmlEntities(topic.title); card.title = titleEl.textContent; }

    // 🖼️ Apply icon pack
    applyTopicIcon(card, topic.title);

    if (!settings.simple_list) {
        const authorEl = card.querySelector('.topic-author');
        const timeEl   = card.querySelector('.topic-time');
        if (authorEl && topic.last_user_name) renderAuthorWithAvatar(authorEl, topic.last_user_name, { user_id: topic.last_user_id, profile_url: topic.last_user_profile_url });
        if (timeEl && topic.last_post_ts) timeEl.textContent = `• ${formatRelativeTime(topic.last_post_ts)}`;
    }

    addMessagePreviewButton(card, 'favorite', {
        topic_id: topic.id,
        post_id: topic.last_post_id || topic.lastPostId || 0,
        post_url: topic.last_post_url || topic.lastPostUrl || ''
    });

    const markReadBtn = card.querySelector('.mark-read');
    if (isRead && markReadBtn) { markReadBtn.remove(); }
    else if (markReadBtn) {
        markReadBtn.addEventListener('click', e => { e.stopPropagation(); markTopicAsRead(topic.id); });
    }

    // ── Focus button ──────────────────────────────────────────
    const focusBtn = card.querySelector('.topic-focus-btn');
    if (focusBtn) {
        const isFocused = sidebarFocusedTopics.has(topicIdStr);
        if (isFocused) {
            card.classList.add('focused');
            const focusIcon = card.querySelector('.topic-focus-icon');
            if (focusIcon) focusIcon.classList.remove('hidden');
        }
        focusBtn.title = isFocused ? 'Снять приоритет' : 'Режим концентрации: следить за темой';
        focusBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = String(topic.id);
            if (sidebarFocusedTopics.has(id)) {
                sidebarFocusedTopics.delete(id);
            } else {
                sidebarFocusedTopics.add(id);
                sidebarMutedTopics.delete(id);
                await safeStorageSet({ muted_topics: [...sidebarMutedTopics] });
                card.classList.remove('muted');
                const muteIcon = card.querySelector('.topic-mute-icon');
                if (muteIcon) muteIcon.classList.add('hidden');
            }
            await safeStorageSet({ focused_topics: [...sidebarFocusedTopics] });
            const nowFocused = sidebarFocusedTopics.has(id);
            card.classList.toggle('focused', nowFocused);
            const focusIcon = card.querySelector('.topic-focus-icon');
            if (focusIcon) focusIcon.classList.toggle('hidden', !nowFocused);
            focusBtn.title = nowFocused ? 'Снять приоритет' : 'Режим концентрации: следить за темой';
            // Start/stop blink immediately
            const anyFocusedUnread = currentData?.favorites?.list?.some(
                t => !t.viewed && sidebarFocusedTopics.has(String(t.id))
            );
            if (anyFocusedUnread) {
                await safeStorageSet({ priority_blinking: true });
                chrome.runtime.sendMessage({ action: 'start_priority_blink' }).catch(() => {});
            } else {
                await safeStorageSet({ priority_blinking: false });
                chrome.runtime.sendMessage({ action: 'stop_priority_blink' }).catch(() => {});
            }
        });
    }

    // ── Mute button ───────────────────────────────────────────
    const muteBtn = card.querySelector('.topic-mute-btn');
    if (muteBtn) {
        const isMuted = sidebarMutedTopics.has(topicIdStr);
        if (isMuted) {
            card.classList.add('muted');
            const muteIcon = card.querySelector('.topic-mute-icon');
            if (muteIcon) muteIcon.classList.remove('hidden');
        }
        muteBtn.title = isMuted ? 'Включить уведомления' : 'Тихий режим: заглушить уведомления';
        muteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = String(topic.id);
            if (sidebarMutedTopics.has(id)) {
                sidebarMutedTopics.delete(id);
            } else {
                sidebarMutedTopics.add(id);
                sidebarFocusedTopics.delete(id);
                await safeStorageSet({ focused_topics: [...sidebarFocusedTopics] });
                card.classList.remove('focused');
                const focusIcon = card.querySelector('.topic-focus-icon');
                if (focusIcon) focusIcon.classList.add('hidden');
            }
            await safeStorageSet({ muted_topics: [...sidebarMutedTopics] });
            const nowMuted = sidebarMutedTopics.has(id);
            card.classList.toggle('muted', nowMuted);
            const muteIcon = card.querySelector('.topic-mute-icon');
            if (muteIcon) muteIcon.classList.toggle('hidden', !nowMuted);
            muteBtn.title = nowMuted ? 'Включить уведомления' : 'Тихий режим: заглушить уведомления';
        });
    }

    // ── Кнопка тега ───────────────────────────────────────────
    const actionsEl = card.querySelector('.card-actions');
    if (actionsEl) {
        const tagBtn = document.createElement('button');
        tagBtn.className = 'action-icon fav-tag-btn interactive';
        tagBtn.title = 'Добавить/управлять тегами';
        const tagSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        tagSvg.setAttribute('class', 'icon-sm');
        tagSvg.setAttribute('viewBox', '0 0 24 24');
        tagSvg.setAttribute('fill', 'none');
        tagSvg.setAttribute('stroke', 'currentColor');
        tagSvg.setAttribute('stroke-width', '2');
        const tagPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tagPath.setAttribute('d', 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z');
        const tagLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        tagLine.setAttribute('x1', '7'); tagLine.setAttribute('y1', '7'); tagLine.setAttribute('x2', '7.01'); tagLine.setAttribute('y2', '7');
        tagSvg.append(tagPath, tagLine);
        tagBtn.appendChild(tagSvg);
        tagBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _showTagEditor(card, topic.id);
        });
        actionsEl.appendChild(tagBtn);
    }

    card.addEventListener('click', (e) => {
        if (currentData?.favorites?.list) {
            const t = currentData.favorites.list.find(x => x.id === topic.id);
            if (t) t.viewed = true;
            currentData.favorites.count = Math.max(0, currentData.favorites.list.filter(x => !x.viewed).length);
        }
        openTab('favorites', { id: topic.id, view: 'getnewpost' });
        _animateCardRemoval(card, () => filterTopics(currentFilter || 'favorites'));
        setTimeout(updateCountersFromBackground, 600);
    });
    card.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); openTab('favorites', { id: topic.id, view: 'getnewpost' }, true); }
    });
    return clone;
}

// 🆕 Setup Intersection Observer for lazy loading QMS subjects (port from popup.js)
function setupQMSLazyLoading() {
    // 2.2.25: automatic QMS subject fetching disabled to avoid 429 rate-limit storms.
    return;
}

// 🆕 Fetch QMS subject for a specific dialog (port from popup.js)
async function fetchQMSSubject(dialogId) {
    if (loadingQmsSubjects.has(dialogId)) return;
    loadingQmsSubjects.add(dialogId);
    try {
        const card = document.getElementById(`qms_${dialogId}`);
        if (!card) { console.warn(`⚠️ Card not found for dialog: ${dialogId}`); return; }

        const opponentName = card.getAttribute('data-opponent-name');
        const opponentId   = card.getAttribute('data-opponent-id');
        if (!opponentId) { console.warn(`⚠️ No opponent ID for dialog: ${dialogId}`); return; }

        const result = await sendMessage({ action: 'fetch_qms_subject', opponent_id: opponentId });

        const cardNow = document.getElementById(`qms_${dialogId}`);
        if (!cardNow) { console.warn(`⚠️ Card disappeared during fetch for dialog: ${dialogId}`); return; }

        if (result && result.subject) {
            const titleEl = cardNow.querySelector('.topic-title');
            const metaEl  = cardNow.querySelector('.topic-meta');
            if (titleEl && metaEl) {
                titleEl.textContent = decodeHtmlEntities(result.subject);
                cardNow.title = decodeHtmlEntities(result.subject);
                cardNow.setAttribute('data-subject-loaded', '1');
                let metaText = decodeHtmlEntities(opponentName);
                if (result.last_msg_ts) metaText += ` • ${formatRelativeTime(result.last_msg_ts)}`;
                metaEl.textContent = metaText;
            }
            if (currentData?.qms?.list && result.dialogId) {
                const dialog = currentData.qms.list.find(d => d.opponent_id == opponentId);
                if (dialog) {
                    dialog.id = result.dialogId;
                    dialog.subject = result.subject;
                    dialog.subject_loaded = true;
                    if (result.last_msg_ts) dialog.last_msg_ts = result.last_msg_ts;
                }
            }
        }
    } catch(error) {
        console.error(`Failed to fetch QMS subject for ${dialogId}:`, error);
    } finally {
        loadingQmsSubjects.delete(dialogId);
    }
}

// ── Render QMS ───────────────────────────────────────────────

function renderQMS(qmsData) {
    return UICommon.renderQMS(qmsData, {
        strings: _getI18nStrings(),
        elements,
        settings,
        loadingQmsSubjects,
        createQMSCard,
        setupQMSLazyLoading,
        adjustPopupHeight
    });
}


function createQMSCard(dialog, template, index) {
    const clone = template.content.cloneNode(true);
    const card  = clone.querySelector('.topic-card');
    card.id = `qms_${dialog.id}`;
    card.classList.add(CLASS_UNREAD);
    card.setAttribute('data-opponent-name', dialog.opponent_name || '');
    card.setAttribute('data-opponent-id', dialog.opponent_id || '');
    card.setAttribute('data-dialog-id', dialog.id || '');

    const typeIcon = card.querySelector('.topic-type-icon');
    if (typeIcon) {
        const mailUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        mailUse.setAttribute('href', '#icon-mail');
        typeIcon.replaceChildren(mailUse);
    }
    const pinIcon = card.querySelector('.topic-pin-icon');
    if (pinIcon) pinIcon.classList.add('hidden');

    // Title: subject if available, else opponent_name
    const titleEl = card.querySelector('.topic-title');
    const metaEl  = card.querySelector('.topic-meta');
    if (titleEl) titleEl.textContent = decodeHtmlEntities(dialog.subject || dialog.title || dialog.opponent_name || '');
    if (metaEl) {
        while (metaEl.firstChild) metaEl.removeChild(metaEl.firstChild);

        // QMS: собеседник — полноценный пользователь. Показываем кликабельный
        // профиль и аватар по opponent_id, если профиль/аватар доступен.
        if (dialog.opponent_name) {
            renderAuthorWithAvatar(metaEl, dialog.opponent_name, {
                user_id: dialog.opponent_id,
                profile_url: dialog.opponent_id ? `https://4pda.to/forum/index.php?showuser=${dialog.opponent_id}` : ''
            });
        }

        if (dialog.last_msg_ts) {
            const time = document.createElement('span');
            time.className = 'topic-time qms-time';
            time.textContent = (dialog.opponent_name ? ' • ' : '') + formatRelativeTime(dialog.last_msg_ts);
            metaEl.appendChild(time);
        }
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) markReadBtn.remove();

    // QMS cards don't use focus/mute — remove those template buttons
    card.querySelector('.topic-focus-btn')?.remove();
    card.querySelector('.topic-mute-btn')?.remove();
    card.querySelector('.topic-focus-icon')?.remove();
    card.querySelector('.topic-mute-icon')?.remove();

    // QMS уже имеет встроенный inline-чат; отдельный предпросмотр здесь не нужен.

    // Open-in-tab button
    const actionsContainer = card.querySelector('.card-actions');
    if (actionsContainer) {
        const openTabBtn = document.createElement('button');
        openTabBtn.className = 'action-icon open-tab interactive';
        openTabBtn.title = 'Открыть диалог';
        const openSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        openSvg.setAttribute('class', 'icon');
        const openUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        openUse.setAttribute('href', '#icon-external-link');
        openSvg.appendChild(openUse);
        openTabBtn.appendChild(openSvg);
        openTabBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id }, isBackgroundClick(e));
        });
        openTabBtn.addEventListener('auxclick', (e) => {
            if (e.button === 1) { e.preventDefault(); e.stopPropagation(); openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id }, true); }
        });
        actionsContainer.appendChild(openTabBtn);
    }

    // ── Inline chat ────────────────────────────────────────
    const cardBody = card.querySelector('.card-body');
    const inlineChat = document.createElement('div');
    inlineChat.className = 'qms-inline-chat hidden';
    const historyEl = document.createElement('div');
    historyEl.className = 'qms-history';
    const pickerEl = document.createElement('div');
    pickerEl.className = 'qms-emoji-picker hidden';
    const replyFormEl = document.createElement('div');
    replyFormEl.className = 'qms-reply-form';
    const textareaEl = document.createElement('textarea');
    textareaEl.className = 'qms-textarea';
    textareaEl.placeholder = 'Сообщение...';
    const replyActionsEl = document.createElement('div');
    replyActionsEl.className = 'qms-reply-actions';
    const emojiBtnEl = document.createElement('button');
    emojiBtnEl.className = 'qms-btn qms-btn-emoji';
    emojiBtnEl.title = 'Смайлы 4PDA';
    const smileSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    smileSvg.setAttribute('class', 'icon-sm');
    const smileUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    smileUse.setAttribute('href', '#icon-smile');
    smileSvg.appendChild(smileUse);
    emojiBtnEl.appendChild(smileSvg);
    const sendBtnEl = document.createElement('button');
    sendBtnEl.className = 'qms-btn qms-btn-send';
    sendBtnEl.title = 'Отправить (Ctrl+Enter)';
    sendBtnEl.textContent = 'Отправить';
    const cancelBtnEl = document.createElement('button');
    cancelBtnEl.className = 'qms-btn qms-btn-cancel';
    cancelBtnEl.title = 'Свернуть';
    cancelBtnEl.textContent = 'Свернуть';
    replyActionsEl.append(emojiBtnEl, sendBtnEl, cancelBtnEl);
    replyFormEl.append(textareaEl, replyActionsEl);
    inlineChat.append(historyEl, pickerEl, replyFormEl);
    cardBody.appendChild(inlineChat);
    inlineChat.addEventListener('click', e => e.stopPropagation());

    const emojiPicker = inlineChat.querySelector('.qms-emoji-picker');
    const textarea    = inlineChat.querySelector('.qms-textarea');
    window.PdaSmileys?.initPicker(emojiPicker, textarea);

    let isExpanded = false;
    let lastMessageId = '0';

    card.addEventListener('click', async (e) => {
        if (e.target.closest('.card-actions')) return;
        // Shift/Ctrl/Cmd/MiddleClick → фоновая вкладка, не раскрываем чат
        if (isBackgroundClick(e)) {
            openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id }, true);
            return;
        }
        if (isExpanded) { isExpanded = false; inlineChat.classList.add('hidden'); return; }
        isExpanded = true;
        inlineChat.classList.remove('hidden');
        const historyContainer = inlineChat.querySelector('.qms-history');
        const loadingText = document.createElement('div');
        loadingText.className = 'qms-loading-text';
        loadingText.textContent = 'Загрузка...';
        historyContainer.replaceChildren(loadingText);
        try {
            // Если dialog.id === dialog.opponent_id, это временный placeholder —
            // сначала резолвим реальный thread ID через фоновый скрипт
            if (String(dialog.id) === String(dialog.opponent_id)) {
                const subjectRes = await sendMessage({ action: 'fetch_qms_subject', opponent_id: String(dialog.opponent_id) });
                if (subjectRes?.dialogId) {
                    dialog.id = subjectRes.dialogId;
                    // Обновляем в currentData тоже
                    if (currentData?.qms?.list) {
                        const d = currentData.qms.list.find(x => String(x.opponent_id) === String(dialog.opponent_id));
                        if (d) d.id = subjectRes.dialogId;
                    }
                }
            }

            const threadUrl = dialog.id !== dialog.opponent_id
                ? `https://4pda.to/forum/index.php?act=qms&mid=${dialog.opponent_id}&t=${dialog.id}`
                : `https://4pda.to/forum/index.php?act=qms&mid=${dialog.opponent_id}`;

            const res = await sendMessage({ action: 'fetch_page', url: threadUrl });
            if (!res?.ok) throw new Error(res?.error || 'fetch failed');
            const html = res.html;
            window.PdaSmileys?.primeFromHtml?.(html);
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const messages = doc.querySelectorAll('#scroll-thread .list-group-item[data-message-id]');
            const fallbackMsgs = messages.length === 0
                ? doc.querySelectorAll('.list-group-item[data-message-id]')
                : messages;
            historyContainer.replaceChildren();
            if (!fallbackMsgs.length) {
                const noMessages = document.createElement('div');
                noMessages.className = 'qms-loading-text';
                noMessages.textContent = 'Нет сообщений';
                historyContainer.replaceChildren(noMessages);
            }
            fallbackMsgs.forEach(msg => {
                const msgId = msg.getAttribute('data-message-id');
                if (msgId) lastMessageId = msgId;
                const content = msg.querySelector('.msg-content');
                if (content) {
                    const div = document.createElement('div');
                    div.className = msg.classList.contains('our-message') ? 'qms-msg out' : 'qms-msg in';
                    const imported = document.importNode(content, true);
                    imported.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(node => node.remove());
                    imported.querySelectorAll('*').forEach(node => {
                        [...node.attributes].forEach(attr => {
                            const name = attr.name.toLowerCase();
                            const value = String(attr.value || '').trim();
                            if (name.startsWith('on') || ((name === 'href' || name === 'src') && /^javascript:/i.test(value))) node.removeAttribute(attr.name);
                        });
                    });
                    div.append(...imported.childNodes);
                    window.PdaSmileys?.renderInlineSmileys?.(div);
                    historyContainer.appendChild(div);
                }
            });
            setTimeout(() => historyContainer.scrollTop = historyContainer.scrollHeight, 50);
        } catch(err) {
            console.error('[QMS sidebar] ошибка загрузки:', err);
            const loadError = document.createElement('div');
            loadError.className = 'qms-loading-text';
            loadError.textContent = 'Ошибка загрузки';
            historyContainer.replaceChildren(loadError);
        }
    });

    inlineChat.querySelector('.qms-btn-cancel').addEventListener('click', (e) => {
        e.stopPropagation(); isExpanded = false; inlineChat.classList.add('hidden');
    });
    inlineChat.querySelector('.qms-btn-emoji').addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.PdaSmileys?.togglePicker) await window.PdaSmileys.togglePicker(emojiPicker, textarea);
        else emojiPicker.classList.toggle('hidden');
    });

    const sendHandler = async (e) => {
        if (e) e.stopPropagation();
        const text = textarea.value.trim();
        if (!text) return;
        const btnSend = inlineChat.querySelector('.qms-btn-send');
        btnSend.disabled = true; btnSend.textContent = '...';
        try {
            await sidebarQmsApiRequest('send-message', dialog.opponent_id, dialog.id, {
                'message': text, 'forward-messages-username': '',
                'forward-thread-username': '', 'attaches': '', 'after-message': lastMessageId
            });
            textarea.value = '';
            if (currentData?.qms?.list) {
                const d = currentData.qms.list.find(x => x.id === dialog.id);
                if (d) d.viewed = true;
                currentData.qms.count = Math.max(0, currentData.qms.count - 1);
            }
            const qmsN = elements.statQms?.querySelector('.stat-number');
            if (qmsN && currentData) qmsN.textContent = currentData.qms.count;
            if (!settings.show_all_qms) {
                _animateCardRemoval(card, () => filterTopics(currentFilter || 'qms'));
            } else {
                isExpanded = false; inlineChat.classList.add('hidden');
                card.classList.remove(CLASS_UNREAD); card.classList.add(CLASS_READ);
            }
            setTimeout(updateCountersFromBackground, 600);
        } catch(err) {
            btnSend.disabled = false; btnSend.textContent = 'Ошибка!';
            setTimeout(() => { btnSend.textContent = 'Отправить'; }, 2000);
        }
    };

    inlineChat.querySelector('.qms-btn-send').addEventListener('click', sendHandler);
    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendHandler(); }
    });

    // 🆕 Средняя кнопка → фоновая вкладка
    card.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id }, true); }
    });

    return clone;
}

async function sidebarQmsApiRequest(action, mid, t, additionalData = {}) {
    const url = 'https://4pda.to/forum/index.php?act=qms-xhr';
    const formData = new FormData();
    formData.append('action', action);
    formData.append('mid', mid);
    formData.append('t', t);
    for (const [k, v] of Object.entries(additionalData)) formData.append(k, v);
    const response = await fetch(url, { method: 'POST', body: formData, headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try { return JSON.parse(text); } catch { return { html: text }; }
}

// ── Render Mentions ──────────────────────────────────────────
function renderMentions(mentionsData) {
    return UICommon.renderMentions(mentionsData, {
        elements,
        settings,
        createMentionCard,
        adjustPopupHeight,
        showUnreadHeader: true
    });
}

function createMentionCard(mention, template, index) {
    const clone = template.content.cloneNode(true);
    const card  = clone.querySelector('.topic-card');
    card.id = `mention_${mention.id}`;
    card.classList.add(CLASS_UNREAD);
    const titleEl = card.querySelector('.topic-title');
    if (titleEl) titleEl.textContent = decodeHtmlEntities(mention.title || '');
    if (!settings.simple_list) {
        const authorEl = card.querySelector('.topic-author');
        const timeEl   = card.querySelector('.topic-time');
        if (authorEl && mention.poster_name) renderAuthorWithAvatar(authorEl, mention.poster_name, { user_id: mention.poster_id, profile_url: mention.poster_profile_url });
        if (timeEl && mention.timestamp) timeEl.textContent = `• ${formatRelativeTime(mention.timestamp)}`;
    }
    addMessagePreviewButton(card, 'mention', { topic_id: mention.topic_id, post_id: mention.post_id, article_url: mention.article_url });

    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) markReadBtn.remove();
    card.addEventListener('click', (e) => {
        card.classList.add(CLASS_READ); card.classList.remove(CLASS_UNREAD);
        openTab('mentions', { topic_id: mention.topic_id, post_id: mention.post_id });
        setTimeout(updateCountersFromBackground, 500);
    });
    card.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); openTab('mentions', { topic_id: mention.topic_id, post_id: mention.post_id }, true); }
    });
    return clone;
}

// ── 🎫 Ticket helpers ────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getTicketSectionIcon(section) {
    if (!section) return '';
    const s = section.toLowerCase();
    if (s.includes('ios') || s.includes('iphone') || s.includes('ipad') ||
        s.includes('apple') || s.includes('macos'))                         return '🍎';
    if (s.includes('android'))                                               return '🤖';
    if (s.includes('windows') || s.includes('pc ') || s === 'pc')           return '🖥️';
    if (s.includes('samsung'))                                               return '📱';
    if (s.includes('xiaomi') || s.includes('miui') || s.includes('redmi') ||
        s.includes('poco'))                                                  return '📱';
    if (s.includes('huawei') || s.includes('honor'))                        return '📱';
    if (s.includes('игр') || s.includes('game'))                            return '🎮';
    if (s.includes('программ') || s.includes('приложен') || s.includes('app')) return '📦';
    if (s.includes('прошив') || s.includes('rom') || s.includes('firmware')) return '⚡';
    if (s.includes('база знаний') || s.includes('wiki'))                    return '📚';
    if (s.includes('офтоп') || s.includes('оффтоп') || s.includes('чат'))   return '💬';
    if (s.includes('устройств') || s.includes('device'))                    return '📟';
    return '🏷️';
}



async function sendTicketAction(action, payload = {}) {
    try {
        return await chrome.runtime.sendMessage({ action, ...payload });
    } catch (e) {
        console.warn('[Sidebar] sendTicketAction failed:', action, e);
        return { ok: false, error: String(e && e.message || e) };
    }
}

function renderTickets(tickets) {
    return window.UICommon?.renderTickets(tickets, {
        elements,
        escapeHtml,
        getTicketSectionIcon,
        sendTicketAction,
        changeTicketStatus: sidebarChangeTicketStatus,
        adjustPopupHeight,
        loadCuratorCache: _loadCuratorCache,
        getCuratorCache: () => _curatorCache,
        applyTicketThreadData: _applyTicketThreadData,
        enqueueCurator: _enqueueCurator,
    });
}


function sidebarChangeTicketStatus(ticketId, newStatus, liEl) {
    const STATUS_LABEL = {
        'не обработан': { text: 'Не обработан', cls: 'ticket-status-new' },
        'в работе':     { text: 'В работе',      cls: 'ticket-status-wip' },
        'обработан':    { text: 'Обработан',      cls: 'ticket-status-done' },
    };
    if (liEl) {
        const info  = STATUS_LABEL[newStatus];
        const badge = liEl.querySelector('.ticket-status');
        if (badge && info) { badge.className = 'ticket-status ' + info.cls; badge.textContent = info.text; }
        const actionsDiv = liEl.querySelector('.ticket-actions');
        if (actionsDiv) {
            if (newStatus === 'в работе')  actionsDiv.querySelector('.ticket-btn-wip')?.remove();
            if (newStatus === 'обработан') {
                actionsDiv.querySelector('.ticket-btn-wip')?.remove();
                actionsDiv.querySelector('.ticket-btn-done')?.remove();
            }
        }
    }
    chrome.runtime.sendMessage({ action: 'ticket_change_status', id: ticketId, status: newStatus })
        .then(resp => {
            if (resp?.count !== undefined && elements.statTickets) {
                const numEl = elements.statTickets.querySelector('.stat-number');
                if (numEl) numEl.textContent = resp.count;
            }
            if (currentData?.tickets?.list) {
                const t = currentData.tickets.list.find(x => x.id === ticketId);
                if (t) { t.status = newStatus; t.viewed = true; }
            }
        })
        .catch(e => console.warn('sidebarChangeTicketStatus error:', e));
}

// ── Action buttons ───────────────────────────────────────────
function setupActionButtons() {
    // 🔧 FIX: Apply visibility from settings
    const showOpenAll = settings.toolbar_button_open_all ?? true;
    const showReadAll = settings.toolbar_button_read_all ?? true;
    const showPinned = settings.toolbar_button_pinned ?? true;
    if (elements.openAll)    elements.openAll.style.display    = showOpenAll ? '' : 'none';
    if (elements.openPinned) elements.openPinned.style.display = showPinned  ? '' : 'none';
    if (elements.readAll)    elements.readAll.style.display    = showReadAll ? '' : 'none';
    if (elements.themeActions) {
        elements.themeActions.style.display = (showOpenAll || showPinned || showReadAll) ? '' : 'none';
    }
    if (elements.openAll) elements.openAll.onclick = () => createPort('themes-open-all');
    if (elements.openPinned) elements.openPinned.onclick = () => createPort('themes-open-all-pin');
    if (elements.readAll) elements.readAll.onclick = () => createPort('themes-read-all');
}

// ── Mark as read ─────────────────────────────────────────────
function _animateCardRemoval(card, onDone) {
    if (!card) { onDone?.(); return; }
    const h = card.offsetHeight;
    card.style.transition = 'opacity 0.16s ease, transform 0.16s ease, max-height 0.20s ease, margin 0.20s ease, padding 0.20s ease';
    card.style.overflow   = 'hidden';
    card.style.maxHeight  = h + 'px';
    card.style.opacity    = '0';
    card.style.transform  = 'translateX(14px)';
    setTimeout(() => {
        card.style.maxHeight    = '0px';
        card.style.marginBottom = '0px';
        card.style.paddingTop   = '0px';
        card.style.paddingBottom= '0px';
    }, 160);
    setTimeout(() => { card.remove(); onDone?.(); }, 390);
}

async function markTopicAsRead(topicId) {
    try {
        const result = await sendMessage({ action: 'mark_as_read', id: topicId });
        if (result) {
            // Помечаем в данных сразу
            if (currentData?.favorites?.list) {
                const t = currentData.favorites.list.find(x => x.id === topicId);
                if (t) t.viewed = true;
                currentData.favorites.count = Math.max(0, currentData.favorites.list.filter(x => !x.viewed).length);
                updateStats(currentData);
            }
            const card = document.getElementById(`topic_${topicId}`);
            _animateCardRemoval(card, () => filterTopics(currentFilter || 'favorites'));
        }
    } catch (e) { console.error('markTopicAsRead error:', e); }
}

// ── Refresh ──────────────────────────────────────────────────
async function refreshData() {
    const prevFilter = currentFilter;
    showLoading(true);
    try {
        await sendMessage({ action: 'force_update' });
        const response = await sendMessage({ action: 'popup_loaded' });
        if (response) {
            currentData = response;
            renderTopics(response.favorites);
            renderQMS(response.qms);
            renderMentions(response.mentions);
            setupActionButtons();
            const usernameText = elements.username.querySelector('.user-name-text');
            if (usernameText) usernameText.textContent = response.user_name;
            updateStats(response);
            if (prevFilter) filterTopics(prevFilter);
            else filterTopics('favorites');
            updateLastUpdateTime();
        }
    } catch (e) { console.error('refreshData error:', e); }
    finally { showLoading(false); }
}

async function handleRefreshClick() {
    elements.refresh.classList.add('spinning');
    try { await refreshData(); }
    finally { setTimeout(() => elements.refresh.classList.remove('spinning'), 600); }
}

// ── openTab (sidebar: НЕ закрывает окно, всегда открывает вкладку активной) ─────────────────────
/**
 * В сайдбаре обычный клик → активная вкладка (sidebar: true).
 * Shift/Ctrl/Cmd/MiddleClick → фоновая вкладка (active: false через background: true).
 */
function openTab(what, options = {}, background = false) {
    chrome.runtime.sendMessage({
        action: 'open_url',
        what,
        sidebar: !background,   // sidebar:true = активная; при bg — не sidebar
        background,
        ...options
    });
}

/**
 * Определяет фоновый клик: Shift+ЛКМ, Ctrl+ЛКМ, Cmd+ЛКМ, средняя кнопка.
 * @param {MouseEvent} e
 * @returns {boolean}
 */
function isBackgroundClick(e) {
    return e.shiftKey || e.ctrlKey || e.metaKey || e.button === 1;
}

// ── Counters from background ─────────────────────────────────
async function updateCountersFromBackground() {
    try {
        const counts = await sendMessage({ action: 'get_counts' });
        if (counts) updateCountersFromCounts(counts);
    } catch(e) {}
}

// ── Port (batch operations) ──────────────────────────────────
function createPort(name) {
    const port = chrome.runtime.connect({ name });
    port.onMessage.addListener(msg => {
        const card = document.getElementById(`topic_${msg.id}`);
        if (card) card.classList.add(CLASS_READ);
        if (currentData) { currentData.favorites.count = msg.count; updateStats(currentData); }
    });
    return port;
}

// ── Loading / Empty state ────────────────────────────────────
function showLoading(show) {
    if (show) {
        showElement(elements.loadingSkeleton);
        hideElement(elements.emptyState);
        [elements.topicsList, elements.qmsList, elements.mentionsList, elements.ticketsList, elements.bookmarksList, elements.historyList]
            .forEach(el => hideElement(el));
    } else {
        hideElement(elements.loadingSkeleton);
    }
}

function showEmptyState(show, msg = null) {
    if (show) {
        if (msg && elements.emptyTitle) elements.emptyTitle.textContent = msg;
        showElement(elements.emptyState);
    } else {
        hideElement(elements.emptyState);
    }
}

function updateLastUpdateTime() {
    const now = new Date();
    if (elements.lastUpdateTime)
        elements.lastUpdateTime.textContent = now.toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
}

// ── Helpers ──────────────────────────────────────────────────
function showElement(el) { el?.classList.remove(CLASS_HIDDEN); }
function hideElement(el) { el?.classList.add(CLASS_HIDDEN); }

function decodeHtmlEntities(text) {
    if (!text) return '';
    const doc = new DOMParser().parseFromString(String(text), 'text/html');
    return doc.documentElement.textContent || '';
}

function formatRelativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now()/1000 - ts;
    if (diff < 60)     return 'только что';
    if (diff < 3600)   return `${Math.floor(diff/60)} мин. назад`;
    if (diff < 86400)  return `${Math.floor(diff/3600)} ч. назад`;
    if (diff < 604800) return `${Math.floor(diff/86400)} дн. назад`;
    return `${Math.floor(diff/604800)} нед. назад`;
}

function sendMessage(message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(response);
            });
        } catch (e) { reject(e); }
    });
}

// ══════════════════════════════════════════════
// 4Pulse i18n — sidebar translations
// ══════════════════════════════════════════════
const SIDEBAR_TRANSLATIONS = {
    ru: { popup_stats:'Статистика', popup_topics:'Темы', popup_mentions:'Ответы', popup_open_all:'Открыть все', popup_pinned:'Закреплённые', popup_read_all:'Прочитать все', popup_empty:'Непрочитанных тем нет', popup_last_update:'Последнее обновление:', radio_mini_radio:'🎵 Радио', productivity_title:'🚀 Продуктивность', prod_add_note:'+ заметка', prod_add_reminder:'+ напомнить', prod_subtitle_popup:'Локальные заметки и напоминания с привязкой к теме', prod_subtitle_sidebar:'Рабочее место: заметки и напоминания с привязкой к теме/QMS/тикету', prod_placeholder:'Например: проверить шапку темы или ответить позже', sidebar_refresh:'Обновить', sidebar_settings:'Настройки' },
    en: { popup_stats:'Stats', popup_topics:'Topics', popup_mentions:'Mentions', popup_open_all:'Open all', popup_pinned:'Pinned', popup_read_all:'Read all', popup_empty:'No unread topics', popup_last_update:'Last update:', radio_mini_radio:'🎵 Radio', productivity_title:'🚀 Productivity', prod_add_note:'+ note', prod_add_reminder:'+ remind', prod_subtitle_popup:'Local notes and reminders linked to a topic', prod_subtitle_sidebar:'Workspace: notes and reminders linked to a topic/QMS/ticket', prod_placeholder:'For example: check the header or reply later', sidebar_refresh:'Refresh', sidebar_settings:'Settings' },
    de: { popup_stats:'Statistik', popup_topics:'Themen', popup_mentions:'Erwähnungen', popup_open_all:'Alle öffnen', popup_pinned:'Angeheftet', popup_read_all:'Alle gelesen', popup_empty:'Keine ungelesenen Themen', popup_last_update:'Letzte Aktualisierung:', radio_mini_radio:'🎵 Radio', productivity_title:'🚀 Produktivität', prod_add_note:'+ Notiz', prod_add_reminder:'+ erinnern', prod_subtitle_popup:'Lokale Notizen und Erinnerungen mit Themenbezug', prod_subtitle_sidebar:'Arbeitsbereich: Notizen und Erinnerungen zu Thema/QMS/Ticket', prod_placeholder:'Zum Beispiel: Kopfbeitrag prüfen oder später antworten', sidebar_refresh:'Aktualisieren', sidebar_settings:'Einstellungen' },
    uk: { popup_stats:'Статистика', popup_topics:'Теми', popup_mentions:'Відповіді', popup_open_all:'Відкрити всі', popup_pinned:'Закріплені', popup_read_all:'Прочитати всі', popup_empty:'Непрочитаних тем немає', popup_last_update:'Останнє оновлення:', radio_mini_radio:'🎵 Радіо', productivity_title:'🚀 Продуктивність', prod_add_note:'+ нотатка', prod_add_reminder:'+ нагадати', prod_subtitle_popup:'Локальні нотатки та нагадування з прив’язкою до теми', prod_subtitle_sidebar:'Робоче місце: нотатки й нагадування з прив’язкою до теми/QMS/тікета', prod_placeholder:'Наприклад: перевірити шапку теми або відповісти пізніше', sidebar_refresh:'Оновити', sidebar_settings:'Налаштування' },
};


function applyPanelStaticLanguagePolish(lang) {
    const map = {
        ru: { profile:'Открыть профиль', mirror:'Зеркальное отображение плиток', cmd:'Командная панель (Ctrl/⌘+K)', compact:'Компактный режим', refresh:'Обновить данные', settings:'Настройки', qms:'Открыть страницу QMS (Shift+клик для списка в попапе)', fav:'Открыть страницу избранного (Shift+клик для списка в попапе)', mentions:'Открыть страницу упоминаний (Shift+клик для списка в попапе)', bookmarks:'Закладки (Shift+клик открывает на сайте)', tickets:'Открыть страницу тикетов (Shift+клик для списка в попапе)', openAll:'Открыть все непрочитанные темы', pinned:'Открыть закреплённые темы', readAll:'Пометить все прочитанными', sleep:'Таймер сна', history:'История прослушивания', close:'Закрыть', priority:'Приоритет', quiet:'Тихий режим', focus:'Режим концентрации: следить за темой', mute:'Тихий режим: заглушить уведомления', markRead:'Отметить прочитанным', bmTitle:'Название', bmFolder:'Новая папка', cmdTitle:'Командная панель 4Pulse', cmdSub:'Быстрый запуск действий без поиска по меню', cmdHint:'↑↓ выбор · Enter выполнить · Esc закрыть', cmdInput:'Напиши: qms, fav, ticket, diag, radio, silence...' },
        en: { profile:'Open profile', mirror:'Mirror tile layout', cmd:'Command Palette (Ctrl/⌘+K)', compact:'Compact mode', refresh:'Refresh data', settings:'Settings', qms:'Open QMS page (Shift+click shows the list in popup)', fav:'Open favorites page (Shift+click shows the list in popup)', mentions:'Open mentions page (Shift+click shows the list in popup)', bookmarks:'Bookmarks (Shift+click opens on site)', tickets:'Open tickets page (Shift+click shows the list in popup)', openAll:'Open all unread topics', pinned:'Open pinned topics', readAll:'Mark all as read', sleep:'Sleep timer', history:'Listening history', close:'Close', priority:'Priority', quiet:'Quiet mode', focus:'Focus mode: watch this topic', mute:'Quiet mode: mute notifications', markRead:'Mark as read', bmTitle:'Title', bmFolder:'New folder', cmdTitle:'4Pulse Command Palette', cmdSub:'Quickly launch actions without searching menus', cmdHint:'↑↓ select · Enter run · Esc close', cmdInput:'Type: qms, fav, ticket, diag, radio, silence...' },
        de: { profile:'Profil öffnen', mirror:'Kachelansicht spiegeln', cmd:'Befehlspalette (Ctrl/⌘+K)', compact:'Kompaktmodus', refresh:'Daten aktualisieren', settings:'Einstellungen', qms:'QMS-Seite öffnen (Shift+Klick zeigt die Liste im Popup)', fav:'Favoriten-Seite öffnen (Shift+Klick zeigt die Liste im Popup)', mentions:'Erwähnungen öffnen (Shift+Klick zeigt die Liste im Popup)', bookmarks:'Lesezeichen (Shift+Klick öffnet auf der Website)', tickets:'Ticket-Seite öffnen (Shift+Klick zeigt die Liste im Popup)', openAll:'Alle ungelesenen Themen öffnen', pinned:'Angeheftete Themen öffnen', readAll:'Alle als gelesen markieren', sleep:'Sleep-Timer', history:'Hörverlauf', close:'Schließen', priority:'Priorität', quiet:'Ruhemodus', focus:'Fokusmodus: Thema beobachten', mute:'Ruhemodus: Benachrichtigungen stummschalten', markRead:'Als gelesen markieren', bmTitle:'Titel', bmFolder:'Neuer Ordner', cmdTitle:'4Pulse-Befehlspalette', cmdSub:'Aktionen schnell starten, ohne Menüs zu durchsuchen', cmdHint:'↑↓ auswählen · Enter ausführen · Esc schließen', cmdInput:'Eingeben: qms, fav, ticket, diag, radio, silence...' },
        uk: { profile:'Відкрити профіль', mirror:'Дзеркальне відображення плиток', cmd:'Командна панель (Ctrl/⌘+K)', compact:'Компактний режим', refresh:'Оновити дані', settings:'Налаштування', qms:'Відкрити сторінку QMS (Shift+клік показує список у попапі)', fav:'Відкрити сторінку обраного (Shift+клік показує список у попапі)', mentions:'Відкрити сторінку згадок (Shift+клік показує список у попапі)', bookmarks:'Закладки (Shift+клік відкриває на сайті)', tickets:'Відкрити сторінку тікетів (Shift+клік показує список у попапі)', openAll:'Відкрити всі непрочитані теми', pinned:'Відкрити закріплені теми', readAll:'Позначити всі прочитаними', sleep:'Таймер сну', history:'Історія прослуховування', close:'Закрити', priority:'Пріоритет', quiet:'Тихий режим', focus:'Режим концентрації: стежити за темою', mute:'Тихий режим: заглушити сповіщення', markRead:'Позначити прочитаним', bmTitle:'Назва', bmFolder:'Нова папка', cmdTitle:'Командна панель 4Pulse', cmdSub:'Швидкий запуск дій без пошуку в меню', cmdHint:'↑↓ вибір · Enter виконати · Esc закрити', cmdInput:'Напишіть: qms, fav, ticket, diag, radio, silence...' }
    };
    const p = map[lang] || map.ru;
    const setTitle = (sel, val) => document.querySelectorAll(sel).forEach(el => el.title = val);
    setTitle('#user-name', p.profile); setTitle('#mirror-toggle', p.mirror); setTitle('#command-palette-toggle', p.cmd); setTitle('#compact-toggle', p.compact); setTitle('#refresh', p.refresh); setTitle('#options', p.settings);
    setTitle('#stat-qms', p.qms); setTitle('#stat-favorites', p.fav); setTitle('#stat-mentions', p.mentions); setTitle('#stat-bookmarks', p.bookmarks); setTitle('#stat-tickets', p.tickets); setTitle('#stat-history', 'Недавно просмотренные темы');
    setTitle('#themes-open-all', p.openAll); setTitle('#themes-open-all-pin', p.pinned); setTitle('#themes-read-all', p.readAll); setTitle('#rsp-sleep-btn', p.sleep); setTitle('#rsp-history-btn', p.history); setTitle('#rsp-close,#cmd-close', p.close);
    setTitle('.topic-focus-icon', p.priority); setTitle('.topic-mute-icon', p.quiet); setTitle('.topic-focus-btn', p.focus); setTitle('.topic-mute-btn', p.mute); setTitle('.mark-read', p.markRead);
    const bt = document.getElementById('bm-add-title'); if (bt) bt.placeholder = p.bmTitle; const bf = document.getElementById('bm-folder-name'); if (bf) bf.placeholder = p.bmFolder;
    const ct = document.querySelector('.cmd-title'); if (ct) ct.textContent = p.cmdTitle; const cs = document.querySelector('.cmd-subtitle'); if (cs) cs.textContent = p.cmdSub; const ch = document.querySelector('.cmd-hint'); if (ch) ch.textContent = p.cmdHint; const ci = document.getElementById('cmd-input'); if (ci) ci.placeholder = p.cmdInput;
}


function applySidebarDeepI18n(lang) {
    const map = {
        ru: {bookmarks:'Закладки', tickets:'Тикеты', history:'История', save:'Сохранить', cancel:'Отмена', notePlaceholder:'Заметка: что нужно не забыть?', emptyProd:'Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.', remind30:'через 30 минут', remind60:'через 1 час', remind180:'через 3 часа', tomorrow:'завтра'},
        en: {bookmarks:'Bookmarks', tickets:'Tickets', history:'History', save:'Save', cancel:'Cancel', notePlaceholder:'Note: what should not be forgotten?', emptyProd:'Nothing here yet. Add a note or reminder with + note / + remind, or via ⌘K → note/snooze.', remind30:'in 30 minutes', remind60:'in 1 hour', remind180:'in 3 hours', tomorrow:'tomorrow'},
        de: {bookmarks:'Lesezeichen', tickets:'Tickets', history:'Verlauf', save:'Speichern', cancel:'Abbrechen', notePlaceholder:'Notiz: Was darf nicht vergessen werden?', emptyProd:'Noch leer. Füge eine Notiz oder Erinnerung über + Notiz / + erinnern hinzu oder über ⌘K → note/snooze.', remind30:'in 30 Minuten', remind60:'in 1 Stunde', remind180:'in 3 Stunden', tomorrow:'morgen'},
        uk: {bookmarks:'Закладки', tickets:'Тікети', history:'Історія', save:'Зберегти', cancel:'Скасувати', notePlaceholder:'Нотатка: що потрібно не забути?', emptyProd:'Поки порожньо. Додайте нотатку або нагадування через + нотатка / + нагадати або через ⌘K → note/snooze.', remind30:'через 30 хвилин', remind60:'через 1 годину', remind180:'через 3 години', tomorrow:'завтра'}
    };
    const p = map[lang] || map.ru;
    const txt = (sel, val) => document.querySelectorAll(sel).forEach(el => { el.textContent = val; });
    const ph = (sel, val) => document.querySelectorAll(sel).forEach(el => { el.placeholder = val; });
    txt('#stat-bookmarks .stat-label', p.bookmarks); txt('#stat-tickets .stat-label', p.tickets); txt('#stat-history .stat-label', p.history); ph('#prod-text', p.notePlaceholder); txt('#prod-save', p.save); txt('#prod-cancel', p.cancel); txt('#prod-empty', p.emptyProd); txt('#prod-remind-in option[value="30"]', p.remind30); txt('#prod-remind-in option[value="60"]', p.remind60); txt('#prod-remind-in option[value="180"]', p.remind180); txt('#prod-remind-in option[value="1440"]', p.tomorrow);
}


// Runtime i18n sweep for dynamic popup/sidebar content.
function applyPanelRuntimeI18nPatch(lang, baseDict) {
  if ((lang || 'ru') === 'ru') return;
  const extra = {
    en: {'Заметка: что нужно не забыть?':'Note: what should not be forgotten?','Сохранить':'Save','Отмена':'Cancel','Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.':'Nothing here yet. Add a note or reminder with + note / + remind, or via ⌘K → note/snooze.','Закладки':'Bookmarks','Тикеты':'Tickets','Радиостанции':'Radio stations','Выключить через:':'Turn off in:','История прослушивания':'Listening history','Очистить':'Clear','Название':'Title','Новая папка':'New folder','Переименовать':'Rename','Удалить':'Delete','Создать':'Create','Тему в закладки':'Bookmark topic','Переходить к непрочитанным':'Go to unread','через 30 минут':'in 30 minutes','через 1 час':'in 1 hour','через 3 часа':'in 3 hours','завтра':'tomorrow','Описание':'Description','Напоминание':'Reminder','Заметка':'Note',' • пора':' • due','Открыть источник':'Open source'},
    de: {'Заметка: что нужно не забыть?':'Notiz: Was darf nicht vergessen werden?','Сохранить':'Speichern','Отмена':'Abbrechen','Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.':'Noch leer. Füge eine Notiz oder Erinnerung über + Notiz / + erinnern hinzu oder über ⌘K → note/snooze.','Закладки':'Lesezeichen','Тикеты':'Tickets','Радиостанции':'Radiostationen','Выключить через:':'Ausschalten in:','История прослушивания':'Hörverlauf','Очистить':'Leeren','Название':'Titel','Новая папка':'Neuer Ordner','Переименовать':'Umbenennen','Удалить':'Löschen','Создать':'Erstellen','Тему в закладки':'Thema als Lesezeichen','Переходить к непрочитанным':'Zu ungelesenen springen','через 30 минут':'in 30 Minuten','через 1 час':'in 1 Stunde','через 3 часа':'in 3 Stunden','завтра':'morgen','Описание':'Beschreibung','Напоминание':'Erinnerung','Заметка':'Notiz',' • пора':' • fällig','Открыть источник':'Quelle öffnen','Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.':'Noch leer. Füge eine Notiz oder Erinnerung über + Notiz / + erinnern hinzu oder über ⌘K → note/snooze.'},
    uk: {'Заметка: что нужно не забыть?':'Нотатка: що потрібно не забути?','Сохранить':'Зберегти','Отмена':'Скасувати','Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.':'Поки порожньо. Додайте нотатку або нагадування через + нотатка / + нагадати або через ⌘K → note/snooze.','Закладки':'Закладки','Тикеты':'Тікети','Радиостанции':'Радіостанції','Выключить через:':'Вимкнути через:','История прослушивания':'Історія прослуховування','Очистить':'Очистити','Название':'Назва','Новая папка':'Нова папка','Переименовать':'Перейменувати','Удалить':'Видалити','Создать':'Створити','Тему в закладки':'Тему в закладки','Переходить к непрочитанным':'Переходити до непрочитаних','через 30 минут':'через 30 хвилин','через 1 час':'через 1 годину','через 3 часа':'через 3 години','завтра':'завтра','Описание':'Опис','Напоминание':'Нагадування','Заметка':'Нотатка',' • пора':' • час','Открыть источник':'Відкрити джерело'}
  };
  const dict = Object.assign({}, extra[lang] || {});
  if (baseDict && baseDict.ru && baseDict[lang]) Object.keys(baseDict.ru).forEach(k => { if (baseDict.ru[k] && baseDict[lang][k]) dict[baseDict.ru[k]] = baseDict[lang][k]; });
  const apply = s => { const raw=String(s||''); const t=raw.trim(); return dict[t] ? raw.replace(t, dict[t]) : s; };
  const skip = new Set(['SCRIPT','STYLE','SVG','PATH','USE']);
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {acceptNode(n){return n.parentElement && !skip.has(n.parentElement.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;}});
  const nodes=[]; while(walker.nextNode()) nodes.push(walker.currentNode); nodes.forEach(n=>{const v=apply(n.nodeValue); if(v!==n.nodeValue)n.nodeValue=v;});
  document.querySelectorAll('*').forEach(el => ['placeholder','title','aria-label'].forEach(a => { if(el.hasAttribute(a)){ const v=apply(el.getAttribute(a)); if(v!==el.getAttribute(a)) el.setAttribute(a,v); }}));
}
function installPanelRuntimeI18nObserver(lang, baseDict) {
  if (window.__4pulsePanelI18nObserver) return;
  window.__4pulsePanelI18nObserver = new MutationObserver(() => { clearTimeout(window.__4pulsePanelI18nTimer); window.__4pulsePanelI18nTimer = setTimeout(() => applyPanelRuntimeI18nPatch(lang, baseDict), 40); });
  window.__4pulsePanelI18nObserver.observe(document.documentElement, {childList:true, subtree:true, characterData:true, attributes:true, attributeFilter:['placeholder','title','aria-label']});
}

async function applySidebarLanguage() {
    try {
        const result = await chrome.storage.local.get(['ui_language']);
        const lang = result.ui_language || 'ru';
        const t = SIDEBAR_TRANSLATIONS[lang] || SIDEBAR_TRANSLATIONS['ru'];
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            if (t[key]) el.textContent = t[key];
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.dataset.i18nPlaceholder;
            if (t[key]) el.setAttribute('placeholder', t[key]);
        });
        applyPanelStaticLanguagePolish(lang);
        applySidebarDeepI18n(lang);
        applyPanelRuntimeI18nPatch(lang, SIDEBAR_TRANSLATIONS);
        setTimeout(() => applyPanelRuntimeI18nPatch(lang, SIDEBAR_TRANSLATIONS), 80);
        installPanelRuntimeI18nObserver(lang, SIDEBAR_TRANSLATIONS);
    } catch(e) {}
}

document.addEventListener('DOMContentLoaded', () => setTimeout(applySidebarLanguage, 50));

// ════════════════════════════════════════════════════════
// 🎵 MINI RADIO PLAYER — sidebar
// ════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────
// 🔧 FIX: Unified row-2 grid layout recalculation
// Tiles in DOM order (row 2): tickets → bookmarks → radio
// Rules:
//   1 visible  → spans full row (1 / -1)
//   2 visible  → first: 1 col (auto), second: stretches to fill rest (2 / -1)
//   3 visible  → each 1 col (fills 3-col grid perfectly)
// ─────────────────────────────────────────────────────────────
// ── Compact grid: ЯВНО ставит инлайн-стили для одной строки ──
// ── Compact grid: layout управляется CSS flexbox (compact-stats-mode) ──
// display:none плитки автоматически выпадают из flex-ряда.
function _applyCompactGrid() {
    // No-op: CSS flexbox в body.compact-stats-mode .stats-cards делает всё сам.
}

// ══════════════════════════════════════════════
// 🔀 DRAG & DROP — порядок плиток статистики (sidebar, зеркало popup.js)
// ══════════════════════════════════════════════
const DRAGGABLE_TILE_IDS = [
    'stat-qms','stat-favorites','stat-mentions',
    'stat-bookmarks','stat-tickets','stat-radio-inline','stat-history'
];
let _tilesOrder = [...DRAGGABLE_TILE_IDS];

// ★ Row config (shared with popup via storage)
let _tilesRowConfig = null;
const DEFAULT_ROW_CONFIG = {
    row1: ['stat-qms','stat-favorites','stat-mentions'],
    row2: ['stat-bookmarks','stat-tickets','stat-radio-inline','stat-history']
};
const SPAN_MAP = {1:[60],2:[30,30],3:[20,20,20],4:[15,15,15,15],5:[12,12,12,12,12],6:[10,10,10,10,10,10]};

async function loadTilesRowConfig() {
    try {
        const r = await chrome.storage.local.get('tiles_row_config');
        _tilesRowConfig = r.tiles_row_config?.row1 ? r.tiles_row_config : null;
    } catch(_) {}
}

async function loadTilesOrder() {
    try {
        const r = await chrome.storage.local.get('tiles_order');
        if (Array.isArray(r.tiles_order) && r.tiles_order.length > 0) {
            const saved   = r.tiles_order.filter(id => DRAGGABLE_TILE_IDS.includes(id));
            const missing = DRAGGABLE_TILE_IDS.filter(id => !saved.includes(id));
            _tilesOrder = [...saved, ...missing];
        }
    } catch(_) {}
}

function applyTilesOrder() {
    const container = document.querySelector('.stats-cards');
    if (!container) return;
    _tilesOrder.forEach(id => {
        const el = document.getElementById(id);
        if (el) container.appendChild(el);
    });
    fillLastTileRow();
}

function fillLastTileRow() {
    if (settings.compact_stats) return;
    const container = document.querySelector('.stats-cards');
    if (!container) return;

    container.style.gridTemplateColumns = 'repeat(60, minmax(0, 1fr))' /* 60=LCM(1..5) — равные плитки для любого N */;

    const allTiles = Array.from(container.querySelectorAll('.stat-card'));
    allTiles.forEach(el => {
        el.style.removeProperty('height');
        el.style.removeProperty('grid-column');
        el.style.removeProperty('order');
    });

    const visible = allTiles.filter(el => el.style.display !== 'none');
    if (visible.length === 0) return;

    const cfg = _tilesRowConfig || DEFAULT_ROW_CONFIG;
    const row1ids = cfg.row1 || [];
    const row2ids = cfg.row2 || [];

    const setSpan = (ids, baseOrder) => {
        const visInRow = ids.filter(id => {
            const el = document.getElementById(id);
            return el && el.style.display !== 'none';
        });
        const count = Math.min(visInRow.length, 6);
        if (count === 0) return;
        const spans = SPAN_MAP[count] || [2];
        visInRow.forEach((id, i) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.order = String(baseOrder + i);
            el.style.gridColumn = `span ${spans[i] ?? 2}`;
        });
    };
    setSpan(row1ids, 0);
    setSpan(row2ids, 10);

    // Плитки не в конфиге — в конец
    const placed = [...row1ids, ...row2ids];
    visible.filter(el => !placed.includes(el.id)).forEach((el, i) => {
        el.style.order = String(20 + i);
        el.style.gridColumn = 'span 2';
    });

    // Выравниваем высоту строк по эталону — обычной плитке (не радио).
    requestAnimationFrame(() => {
        if (!container.isConnected) return;
        const vis = allTiles.filter(el => el.style.display !== 'none');
        vis.forEach(el => el.style.removeProperty('height'));
        const refTile = vis.find(el => el.id !== 'stat-radio-inline') || vis[0];
        if (!refTile) return;
        const refH = refTile.getBoundingClientRect().height;
        if (refH > 0) {
            container.style.setProperty('--stat-tile-ref-h', refH + 'px');
            vis.forEach(el => { el.style.height = refH + 'px'; });
        }
    });
}

function saveTilesOrder() {
    safeStorageSet({ tiles_order: [..._tilesOrder] });
}

function initTileDragDrop() {
    const container = document.querySelector('.stats-cards');
    window.UICommon?.initTileDragDrop({
        container,
        ids: DRAGGABLE_TILE_IDS,
        getOrder: () => _tilesOrder,
        setOrder: order => { _tilesOrder = order; },
        applyOrder: applyTilesOrder,
        saveOrder: saveTilesOrder,
    });
}

function recalcRow2Layout() {
    if (settings.compact_stats) {
        // flex-режим — JS ничего не делает, CSS всё контролирует
        return;
    }
    const statsCards = document.querySelector('.stats-cards');
    if (statsCards) {
        statsCards.style.removeProperty('grid-template-rows');
        statsCards.style.removeProperty('grid-auto-flow');
    }
    ['stat-tickets', 'stat-bookmarks', 'stat-radio-inline', 'stat-history'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.removeProperty('grid-column'); el.style.removeProperty('grid-row'); }
    });
    fillLastTileRow();
}

let _sidebarRadioInitialized = false;
async function initSidebarRadio() {
    try {
        // Панель станций должна открываться по клику даже до первого старта радио.
        initSidebarRadioPanel();
        const bar        = document.getElementById('mini-radio-bar');
        const inlineCard = document.getElementById('stat-radio-inline');
        if (!inlineCard) return;
        const r = await chrome.storage.local.get(['radio_enabled', 'user_profile_mode']);
        if (!r.radio_enabled || r.user_profile_mode === 'minimal') {
            // Радио не должно появляться в сайдбаре, пока пользователь
            // явно не включил его в настройках.
            if (bar) bar.style.display = 'none';
            inlineCard.style.display = 'none';
            recalcRow2Layout();
            return;
        }

        const nameEl        = document.getElementById('radio-inline-name');
        const trackEl       = document.getElementById('radio-inline-track');
        const artEl         = document.getElementById('radio-inline-art');
        const iconEl        = document.getElementById('radio-inline-icon');
        const volEl         = document.getElementById('radio-inline-vol');
        const btn           = document.getElementById('radio-inline-btn');
        // ── Применяем состояние к UI ─────────────────────────
        function applyRadioState(state) {
            if (!state) return;
            setSidebarRadioBtn(btn, state.isPlaying);
            if (volEl) volEl.value = state.volume ?? 70;

            // Ошибка / станция
            const errMsg = state.lastError;
            if (errMsg && nameEl) {
                nameEl.textContent = '⚠ ' + errMsg;
                nameEl.style.color = 'var(--danger, #e74c3c)';
            } else if (nameEl) {
                nameEl.textContent = state.stationName || 'Радио';
                nameEl.style.color = '';
            }

            // Название трека
            if (trackEl) {
                if (state.currentTrack) {
                    trackEl.textContent = state.currentTrack;
                    trackEl.style.display = '';
                } else {
                    trackEl.style.display = 'none';
                }
            }

            // Обложка
            if (artEl && iconEl) {
                if (state.trackArt) {
                    artEl.src = state.trackArt;
                    artEl.style.display = '';
                    iconEl.style.display = 'none';
                } else {
                    artEl.style.display = 'none';
                    iconEl.style.display = '';
                }
            }

        }


        const state = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
        if (state) {
            if (bar) bar.style.display = 'none';
            inlineCard.style.display = '';
            recalcRow2Layout();
            applyRadioState(state);
        }

        if (_sidebarRadioInitialized) return;
        _sidebarRadioInitialized = true;

        // ── Play / Pause ──────────────────────────────────────
        btn?.addEventListener('click', async () => {
            const st = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
            if (st?.isPlaying) {
                await chrome.runtime.sendMessage({ action: 'radio_pause' });
            } else {
                const r2 = await chrome.storage.local.get(['radio_station','radio_station_name']);
                if (r2.radio_station) {
                    await chrome.runtime.sendMessage({ action: 'radio_play', station: r2.radio_station, stationName: r2.radio_station_name });
                }
            }
        });

        // ── Громкость ─────────────────────────────────────────
        volEl?.addEventListener('input', () => {
            chrome.runtime.sendMessage({ action: 'radio_set_volume', volume: parseInt(volEl.value) });
        });

        // 🖱 Колесо мыши на слайдере громкости — ±2% за шаг
        volEl?.addEventListener('wheel', function(e) {
            e.preventDefault();
            const step = e.shiftKey ? 5 : 2;
            const val = Math.min(100, Math.max(0, parseInt(this.value) + (e.deltaY < 0 ? step : -step)));
            this.value = val;
            chrome.runtime.sendMessage({ action: 'radio_set_volume', volume: val });
        }, { passive: false });

        // ── История: тайл → открыть список станций ────────────
        // (тап на плитке открывает панель станций — история доступна через кнопку в панели)

        // ── Broadcast handler ─────────────────────────────────
        // ★ OPT: radio_state обрабатывается в главном onMessage.addListener (см. L410)
        window.__sidebarRadioStateCallback = (state) => applyRadioState(state);

        chrome.storage.onChanged.addListener((changes) => {
            if (changes.radio_enabled) {
                if (changes.radio_enabled.newValue) {
                    _sidebarRadioInitialized = false;
                    initSidebarRadio();
                } else {
                    if (bar) bar.style.display = 'none';
                    inlineCard.style.display = 'none';
                    recalcRow2Layout();
                }
            }
        });

        // ── История: закрыть / очистить ───────────────────────
        document.getElementById('rhp-close')?.addEventListener('click', () => {
            document.getElementById('radio-history-panel').style.display = 'none';
        });
        document.getElementById('rhp-clear')?.addEventListener('click', async () => {
            await chrome.runtime.sendMessage({ action: 'radio_clear_history' });
            renderRadioHistory([]);
        });

        initSidebarRadioPanel();
    } catch(e) { console.warn('Sidebar radio init:', e); }
}

// ── История прослушивания ─────────────────────────────────────
async function openRadioHistory() {
    const panel = document.getElementById('radio-history-panel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
    if (panel.style.display === 'none') return;
    const history = await chrome.runtime.sendMessage({ action: 'radio_get_history' });
    renderRadioHistory(history || []);
}

function renderRadioHistory(history) {
    const list = document.getElementById('rhp-list');
    if (!list) return;
    if (!history.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:12px;text-align:center;font-size:12px;color:var(--text-3);';
        empty.textContent = 'История пуста';
        list.replaceChildren(empty);
        return;
    }
    const fragment = document.createDocumentFragment();
    history.forEach(item => {
        const d = new Date(item.ts);
        const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
        const date = d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px 12px;border-bottom:1px solid var(--border-md);display:flex;flex-direction:column;gap:1px;';
        const track = document.createElement('span');
        track.style.cssText = 'font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        track.textContent = item.track || '';
        const meta = document.createElement('span');
        meta.style.cssText = 'font-size:10px;color:var(--text-3);';
        meta.textContent = `${item.station || ''} · ${date} ${time}`;
        row.append(track, meta);
        fragment.appendChild(row);
    });
    list.replaceChildren(fragment);
}


function setSidebarRadioBtn(btn, isPlaying) {
    if (!btn) return;
    btn.textContent = isPlaying ? '⏸' : '▶';
    btn.title = isPlaying ? 'Пауза' : 'Играть';
}

document.addEventListener('DOMContentLoaded', () => initSidebarRadio());

// ──────────────────────────────────────────────────────────────
// 🎵 SIDEBAR RADIO — station panel (click tile → pick station)
// ──────────────────────────────────────────────────────────────

const RADIO_BUILT_IN = {
    '🇷🇺 Русское Радио':     'https://rusradio.hostingradio.ru/rusradio128.mp3',
    '🇷🇺 Радио Рекорд':      'https://radiorecord.hostingradio.ru/rr_main96.aacp',
    '🇷🇺 DFM':               'https://dfm.hostingradio.ru/dfm96.aacp',
    '🇷🇺 DFM Russian Dance': 'https://dfm-dfmrusdance.hostingradio.ru/dfmrusdance96.aacp',
    '🇷🇺 Маяк':              'https://icecast-vgtrk.cdnvideo.ru/mayakfm_aac_64kbps',
    '🇷🇺 Вести FM':          'https://icecast-vgtrk.cdnvideo.ru/vestifm_aac_64kbps',
    '🇷🇺 Радио России':      'https://icecast-vgtrk.cdnvideo.ru/rrzonam_mp3_192kbps',
    '🇷🇺 Наше Радио':        'https://nashe1.hostingradio.ru/nashe-128.mp3',
    '🇷🇺 Maximum':           'https://maximum.hostingradio.ru/maximum96.aacp',
    '🇩🇪 Радио Картина':     'https://rs.kartina.tv/kartina_320kb',
    '🇰🇿 LuxFM':             'https://icecast.luxfm.kz/luxfm',
    '🇰🇿 Radio NS':          'https://icecast.ns.kz/radions',
    '🇰🇿 NRJ Kazakhstan':    'https://nrj-nrjkaz.hostingradio.ru/nrjkaz96.aacp',
    '🇺🇦 Хіт FM':            'https://online.hitfm.ua/HitFM',
    '🇺🇦 Kiss FM UA':        'https://online.kissfm.ua/KissFM',
    '🇺🇦 Radio ROKS':        'https://online.radioroks.ua/RadioROKS',
};

let _sidebarRspOpen = false;

async function buildSidebarRadioPanel() {
    const listEl = document.getElementById('rsp-list');
    if (!listEl) return;

    const [r, state] = await Promise.all([
        chrome.storage.local.get(['radio_custom_stations', 'radio_play_counts', 'radio_last_played', 'radio_hidden_stations']),
        chrome.runtime.sendMessage({ action: 'radio_get_state' }).catch(() => null),
    ]);
    const custom     = r.radio_custom_stations || {};
    const playCounts = r.radio_play_counts     || {};
    const lastPlayed = r.radio_last_played     || {};
    const hiddenUrls = r.radio_hidden_stations  || [];
    const currentUrl = state?.station || '';

    listEl.replaceChildren();
    const hiddenSet  = new Set(hiddenUrls);

    function makeStation(name, url) {
        const btn = document.createElement('button');
        btn.className = 'rsp-station interactive' + (url === currentUrl ? ' rsp-playing' : '');
        btn.dataset.url = url;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'rsp-station-name';
        nameSpan.textContent = name;
        btn.appendChild(nameSpan);

        const count = playCounts[url];
        if (count) {
            const countSpan = document.createElement('span');
            countSpan.className = 'rsp-play-count';
            countSpan.textContent = `×${count}`;
            btn.appendChild(countSpan);
        }

        btn.addEventListener('click', async () => {
            // ★ Закрываем панель ДО await, чтобы избежать гонки с onChanged
            const nameEl = document.getElementById('radio-inline-name');
            if (nameEl) nameEl.textContent = name;
            setSidebarRadioBtn(document.getElementById('radio-inline-btn'), true);
            // ★ FIX: сразу сбрасываем метаданные старой станции, не ждём ответа фона
            const trackEl = document.getElementById('radio-inline-track');
            const artEl   = document.getElementById('radio-inline-art');
            const iconEl  = document.getElementById('radio-inline-icon');
            if (trackEl) { trackEl.style.display = 'none'; trackEl.setAttribute('data-hidden', '1'); }
            if (artEl)   artEl.style.display = 'none';
            if (iconEl)  iconEl.style.removeProperty('display');
            closeSidebarRadioPanel();

            const fresh = await chrome.storage.local.get(['radio_play_counts', 'radio_last_played']);
            const counts = fresh.radio_play_counts || {};
            const lp     = fresh.radio_last_played || {};
            counts[url] = (counts[url] || 0) + 1;
            lp[url]     = Date.now();
            await safeStorageSet({ radio_play_counts: counts, radio_last_played: lp });
            await safeStorageSet({ radio_station: url, radio_station_name: name });
            await chrome.runtime.sendMessage({ action: 'radio_play', station: url, stationName: name });
        });

        return btn;
    }

    const sortByLastPlayed = (entries) =>
        entries.slice().sort((a, b) => (lastPlayed[b[1]] || 0) - (lastPlayed[a[1]] || 0));

    const customEntries = sortByLastPlayed(Object.entries(custom));
    if (customEntries.length > 0) {
        const label = document.createElement('div');
        label.className = 'rsp-section-label';
        label.textContent = 'Мои станции';
        listEl.appendChild(label);
        customEntries.forEach(([name, url]) => listEl.appendChild(makeStation(name, url)));
    }

    const builtInEntries = sortByLastPlayed(
        Object.entries(RADIO_BUILT_IN).filter(([, url]) => !hiddenSet.has(url))
    );
    if (builtInEntries.length > 0) {
        const label2 = document.createElement('div');
        label2.className = 'rsp-section-label';
        label2.textContent = customEntries.length > 0 ? 'Встроенные' : 'Станции';
        listEl.appendChild(label2);
        builtInEntries.forEach(([name, url]) => listEl.appendChild(makeStation(name, url)));
    }
}

function openSidebarRadioPanel() {
    const panel = document.getElementById('radio-station-panel');
    const tile  = document.getElementById('stat-radio-inline');
    if (!panel) return;
    _sidebarRspOpen = true;
    tile?.classList.add('active');
    buildSidebarRadioPanel();
    panel.style.display = '';
}

function closeSidebarRadioPanel() {
    const panel = document.getElementById('radio-station-panel');
    const tile  = document.getElementById('stat-radio-inline');
    if (!panel) return;
    _sidebarRspOpen = false;
    tile?.classList.remove('active');
    panel.style.display = 'none';
}

let _sidebarRadioPanelInited = false;
function initSidebarRadioPanel() {
    if (_sidebarRadioPanelInited) return;
    _sidebarRadioPanelInited = true;
    const tile    = document.getElementById('stat-radio-inline');
    const slider  = document.getElementById('radio-inline-vol');
    const playBtn = document.getElementById('radio-inline-btn');
    const closeBtn = document.getElementById('rsp-close');

    if (tile) {
        let _pdX = 0, _pdY = 0, _pdT = 0;
        tile.addEventListener('pointerdown', (e) => {
            _pdX = e.clientX; _pdY = e.clientY; _pdT = Date.now();
        });
        tile.addEventListener('pointerup', (e) => {
            const dx = Math.abs(e.clientX - _pdX);
            const dy = Math.abs(e.clientY - _pdY);
            const dt = Date.now() - _pdT;
            if (dt > 500 || dx > 15 || dy > 15) return;
            if (e.target === slider || slider?.contains(e.target)) return;
            if (e.target === playBtn || playBtn?.contains(e.target)) return;
            e.stopPropagation();
            _sidebarRspOpen ? closeSidebarRadioPanel() : openSidebarRadioPanel();
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeSidebarRadioPanel(); });
    }

    // Close when clicking outside
    document.addEventListener('pointerdown', (e) => {
        if (!_sidebarRspOpen) return;
        const panel = document.getElementById('radio-station-panel');
        const tile2 = document.getElementById('stat-radio-inline');
        if (panel && !panel.contains(e.target) && tile2 && !tile2.contains(e.target)) {
            closeSidebarRadioPanel();
        }
    });

    // Rebuild if custom stations change from outside
    chrome.storage.onChanged.addListener((changes) => {
        if (_sidebarRspOpen && changes.radio_custom_stations) {
            buildSidebarRadioPanel();
        }
    });

    // ── Таймер сна: кнопка в панели ──────────────────────────
    let _sbPanelSleepTick = null;
    function updateSbPanelSleepStatus(endsAt) {
        if (_sbPanelSleepTick) { clearInterval(_sbPanelSleepTick); _sbPanelSleepTick = null; }
        const statusEl = document.getElementById('rsp-sleep-status');
        const sleepBtnEl = document.getElementById('rsp-sleep-btn');
        if (!endsAt || endsAt <= Date.now()) {
            if (statusEl) statusEl.style.display = 'none';
            if (sleepBtnEl) sleepBtnEl.style.color = 'var(--text-3)';
            return;
        }
        if (sleepBtnEl) sleepBtnEl.style.color = 'var(--accent)';
        function tick() {
            const rem = Math.max(0, endsAt - Date.now());
            if (statusEl) {
                const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
                statusEl.textContent = `⏱ ${m}:${String(s).padStart(2,'0')}`;
                statusEl.style.display = '';
            }
            if (rem <= 0) { clearInterval(_sbPanelSleepTick); _sbPanelSleepTick = null; }
        }
        tick();
        _sbPanelSleepTick = setInterval(tick, 1000);
    }
    document.getElementById('rsp-sleep-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const area = document.getElementById('rsp-sleep-area');
        if (area) area.style.display = area.style.display === 'none' ? '' : 'none';
    });
    document.querySelectorAll('#rsp-sleep-area .rsp-sleep-opt').forEach(b => {
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const min = parseInt(b.dataset.min);
            await chrome.runtime.sendMessage({ action: 'radio_set_sleep_timer', minutes: min });
            const area = document.getElementById('rsp-sleep-area');
            if (area) area.style.display = 'none';
            if (min > 0) {
                updateSbPanelSleepStatus(Date.now() + min * 60000);
            } else {
                updateSbPanelSleepStatus(null);
            }
        });
    });
    // ★ OPT: sleep status обрабатывается в главном onMessage.addListener (см. L410)
    window.__sidebarRspSleepCallback = (state) => {
        if (_sidebarRspOpen) updateSbPanelSleepStatus(state?.sleepEndsAt);
    };

    // ── История: кнопка в панели ─────────────────────────────
    document.getElementById('rsp-history-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const area = document.getElementById('rsp-history-area');
        if (!area) return;
        const isOpen = area.style.display !== 'none';
        area.style.display = isOpen ? 'none' : '';
        if (!isOpen) {
            const history = await chrome.runtime.sendMessage({ action: 'radio_get_history' });
            renderSbPanelHistory(history || []);
        }
    });
    document.getElementById('rsp-history-clear')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await chrome.runtime.sendMessage({ action: 'radio_clear_history' });
        renderSbPanelHistory([]);
    });
}

function renderSbPanelHistory(history) {
    const list = document.getElementById('rsp-history-list');
    if (!list) return;
    if (!history.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:10px 12px;text-align:center;font-size:11px;color:var(--text-3);';
        empty.textContent = 'История пуста';
        list.replaceChildren(empty);
        return;
    }
    const fragment = document.createDocumentFragment();
    history.forEach(item => {
        const d = new Date(item.ts);
        const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
        const date = d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
        const row = document.createElement('div');
        row.style.cssText = 'padding:5px 12px;border-bottom:1px solid var(--border-md);display:flex;flex-direction:column;gap:1px;';
        const track = document.createElement('span');
        track.style.cssText = 'font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        track.textContent = item.track || '—';
        const meta = document.createElement('span');
        meta.style.cssText = 'font-size:10px;color:var(--text-3);';
        meta.textContent = `${item.station || ''} · ${date} ${time}`;
        row.append(track, meta);
        fragment.appendChild(row);
    });
    list.replaceChildren(fragment);
}

// placeholder — real closing removed

// ══════════════════════════════════════════════════════════════
// 🔖 BOOKMARKS
// ══════════════════════════════════════════════════════════════



// ── Форма создания папки ─────────────────────────────────────
let _folderParentId = 0; // 0 = корень, >0 = подпапка

function openFolderForm(parentId = 0, parentTitle = '') {
    _folderParentId = parentId;
    const titleEl = document.getElementById('bm-folder-form-title');
    if (titleEl) titleEl.textContent = parentId ? `Подпапка в «${parentTitle.slice(0,25)}»` : 'Создание папки';
    const nameEl = document.getElementById('bm-folder-name');
    if (nameEl) { nameEl.value = ''; }
    const form = document.getElementById('bm-folder-form');
    form?.classList.remove('hidden');
    nameEl?.focus();
}

function initFolderForm() {
    const form   = document.getElementById('bm-folder-form');
    const nameEl = document.getElementById('bm-folder-name');
    if (!form) return;

    document.getElementById('bm-folder-cancel')?.addEventListener('click', () => {
        form.classList.add('hidden');
        if (nameEl) nameEl.value = '';
    });

    async function submitFolder() {
        const title = nameEl?.value.trim();
        if (!title) { showBmToast('Введите название папки'); return; }
        const btn = document.getElementById('bm-folder-submit');
        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = '…';
        try {
            const resp = await sendMessage({ action: 'folder_add', title, parentId: _folderParentId });
            if (resp?.ok) {
                form.classList.add('hidden');
                if (nameEl) nameEl.value = '';
                showBmToast('✓ Папка создана');
            } else {
                showBmToast('Не удалось создать папку');
            }
        } catch (err) {
            showBmToast('Ошибка: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    }

    document.getElementById('bm-folder-submit')?.addEventListener('click', submitFolder);
    nameEl?.addEventListener('keydown', e => {
        if (e.key === 'Enter') submitFolder();
        if (e.key === 'Escape') document.getElementById('bm-folder-cancel')?.click();
    });
}

// ── Форма добавления закладки ──────────────────────────────────
function initBmAddForm() {
    const form    = elements.bmAddForm;
    const titleEl = elements.bmAddTitle;
    const urlEl   = elements.bmAddUrl;
    if (!form) return;

    elements.bmAddCancel?.addEventListener('click', () => {
        form.classList.add('hidden');
        if (titleEl) titleEl.value = '';
        if (urlEl)   { urlEl.value = ''; urlEl._baseUrl = ''; }
        if (elements.bmGetNewpost) elements.bmGetNewpost.checked = false;
    });

    elements.bmGetNewpost?.addEventListener('change', () => {
        if (!urlEl?._baseUrl) return;
        urlEl.value = elements.bmGetNewpost.checked
            ? urlEl._baseUrl.replace(/[&?]view=[^&]*/g, '') + '&view=getnewpost'
            : urlEl._baseUrl;
    });

    async function submitAdd() {
        const title = titleEl?.value.trim();
        const url   = urlEl?.value.trim();
        if (!title || !url) { showBmToast('Введите название'); return; }

        const btn = elements.bmAddSubmit;
        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = '…';
        try {
            const resp = await sendMessage({ action: 'bookmark_add', title, url });
            if (resp?.ok) {
                form.classList.add('hidden');
                titleEl.value = '';
                if (urlEl) { urlEl.value = ''; urlEl._baseUrl = ''; }
                if (elements.bmGetNewpost) elements.bmGetNewpost.checked = false;
                showBmToast('✓ Закладка добавлена');
            } else {
                showBmToast('Не удалось добавить. Открой страницу 4PDA.');
            }
        } catch (err) {
            showBmToast('Ошибка: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    }

    elements.bmAddSubmit?.addEventListener('click', submitAdd);
    [titleEl].forEach(el => el?.addEventListener('keydown', e => {
        if (e.key === 'Enter')  submitAdd();
        if (e.key === 'Escape') elements.bmAddCancel?.click();
    }));
}

// ── Состояние свёрнутых папок закладок ──────────────────────
let _collapsedFolders = new Set();

async function _loadCollapsedFolders() {
    try {
        const r = await chrome.storage.local.get('bm_collapsed_folders');
        _collapsedFolders = new Set(r.bm_collapsed_folders || []);
    } catch(_) { _collapsedFolders = new Set(); }
}

function _saveCollapsedFolders() {
    safeStorageSet({ bm_collapsed_folders: [..._collapsedFolders] });
}

function renderBookmarks(bookmarks) {
    const list = elements.bookmarksList;
    if (!list) return;
    list.replaceChildren();

    // ── Кнопка «+ Добавить» ─────────────────────────────────
    const addLi = document.createElement('li');
    addLi.style.cssText = 'display:flex;justify-content:flex-end;padding:2px 4px 4px;';
    const addBtn = document.createElement('button');
    addBtn.textContent = '＋ Добавить';
    addBtn.title = 'Добавить закладку';
    addBtn.style.cssText = 'padding:4px 12px;border-radius:8px;border:1px dashed var(--border-md);background:transparent;color:var(--text-2);font-size:11px;cursor:pointer;';
    addBtn.addEventListener('click', async () => {
        // Пробуем получить активную вкладку — в сайдбаре currentWindow может быть другим
        try {
            const tabs = await chrome.tabs.query({ active: true });
            const tab = tabs.find(t => t.url?.includes('4pda')) || tabs[0];
            if (tab?.url?.includes('4pda')) {
                const baseUrl = tab.url
                    .replace('https://4pda.to/', '')
                    .replace('https://4pda.ru/', '')
                    .replace('http://4pda.to/', '');
                if (elements.bmAddUrl) {
                    elements.bmAddUrl._baseUrl = baseUrl;
                    elements.bmAddUrl.value = baseUrl;
                }
                if (elements.bmAddTitle && !elements.bmAddTitle.value)
                    elements.bmAddTitle.value = (tab.title || '')
                        .replace(' / 4PDA', '').replace(' — 4PDA', '').replace(' - 4PDA', '').trim();
            }
        } catch(_) {}
        const isTopic = elements.bmAddUrl?._baseUrl?.includes('showtopic=');
        if (elements.bmGetNewpostRow)
            elements.bmGetNewpostRow.style.display = isTopic ? 'flex' : 'none';
        elements.bmAddForm?.classList.remove('hidden');
        elements.bmAddTitle?.focus();
        elements.bmAddTitle?.select();
    });
    // Кнопка «Папка» — создание корневой папки
    const folderBtn = document.createElement('button');
    folderBtn.textContent = '📁 Папка';
    folderBtn.title = 'Создать папку';
    folderBtn.style.cssText = 'padding:4px 10px;border-radius:8px;border:1px dashed var(--border-md);background:transparent;color:var(--text-2);font-size:11px;cursor:pointer;';
    folderBtn.addEventListener('click', () => openFolderForm(0));
    addLi.appendChild(addBtn);
    addLi.appendChild(folderBtn);
    list.appendChild(addLi);

    if (!bookmarks || bookmarks.length === 0) {
        const emptyBookmark = document.createElement('li');
        emptyBookmark.className = 'bookmarks-empty';
        emptyBookmark.style.cssText = 'text-align:center;padding:32px 16px;color:var(--text-3);font-size:13px;';
        emptyBookmark.textContent = 'Закладки не загружены';
        list.replaceChildren(emptyBookmark);
        return;
    }

    const active = bookmarks.filter(b => !b.deleted);
    const byId = {};
    active.forEach(b => { byId[b.id] = b; });

    function buildItem(bm) {
        if (bm.isFolder) {
            const tpl = document.getElementById('tpl-bookmark-folder');
            const node = tpl.content.cloneNode(true);
            const li = node.querySelector('.bookmark-folder');
            li.dataset.bmId = bm.id;
            li.querySelector('.bookmark-folder-title').textContent = bm.title;

            // Кнопка создания подпапки
            const subBtn = document.createElement('button');
            subBtn.title = 'Создать подпапку';
            subBtn.textContent = '📁+';
            subBtn.style.cssText = 'margin-left:auto;background:transparent;border:none;color:var(--text-3);font-size:11px;cursor:pointer;padding:0 4px;opacity:0.6;';
            subBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openFolderForm(bm.id, bm.title);
            });
            const folderHeader = li.querySelector('.bookmark-folder-header');
            if (folderHeader) folderHeader.appendChild(subBtn);
            const children = active.filter(b => b.parentId === bm.id).sort((a,b) => a.sortOrder - b.sortOrder);
            const childUl = li.querySelector('.bookmark-folder-children');
            children.forEach(child => { const n = buildItem(child); if (n) childUl.appendChild(n); });
            if (children.length === 0) childUl.style.display = 'none';
            li.querySelector('.bookmark-folder-header').addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-actions')) return;
                li.classList.toggle('collapsed');
                const folderId = String(bm.id);
                if (li.classList.contains('collapsed')) {
                    _collapsedFolders.add(folderId);
                } else {
                    _collapsedFolders.delete(folderId);
                }
                _saveCollapsedFolders();
            });

            // Восстанавливаем сохранённое состояние
            if (_collapsedFolders.has(String(bm.id))) {
                li.classList.add('collapsed');
            }
            wireBookmarkActions(li, bm);
            return li;
        } else {
            const tpl = document.getElementById('tpl-bookmark-item');
            const node = tpl.content.cloneNode(true);
            const li = node.querySelector('.bookmark-item');
            li.dataset.bmId = bm.id;
            li.querySelector('.bookmark-item-title').textContent = bm.title;
            li.addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-actions')) return;
                if (bm.url) chrome.runtime.sendMessage({ action: 'open_url', what: 'external', url: bm.url, sidebar: true });
            });
            wireBookmarkActions(li, bm);
            return li;
        }
    }

    const roots = active.filter(b => !b.parentId || !byId[b.parentId]).sort((a,b) => a.sortOrder - b.sortOrder);
    roots.forEach(bm => { const n = buildItem(bm); if (n) list.appendChild(n); });
}

function wireBookmarkActions(li, bm) {
    const renameBtn = li.querySelector('.bm-rename-btn');
    const deleteBtn = li.querySelector('.bm-delete-btn');
    const titleEl   = li.querySelector('.bookmark-folder-title, .bookmark-item-title');

    renameBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (li.querySelector('.bm-rename-input')) return;

        const oldTitle = bm.title;
        const input = document.createElement('input');
        input.className = 'bm-rename-input';
        input.type      = 'text';
        input.value     = oldTitle;
        input.maxLength = 200;
        input.style.cssText = 'flex:1;font-size:13px;font-weight:600;padding:2px 6px;border:1px solid var(--accent);border-radius:4px;background:var(--bg-3);color:var(--text);outline:none;min-width:0;';
        titleEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        async function commit() {
            if (committed) return;
            const newTitle = input.value.trim();
            if (!newTitle || newTitle === oldTitle) { committed = true; input.replaceWith(titleEl); return; }
            committed = true;
            input.disabled = true;
            try {
                const resp = await sendMessage({ action: 'bookmark_rename', id: bm.id, title: newTitle });
                console.log('[BM sidebar] rename resp:', resp);
                if (resp?.ok) {
                    bm.title = newTitle;
                    titleEl.textContent = newTitle;
                    if (currentData?.bookmarks?.list) {
                        const entry = currentData.bookmarks.list.find(b => b.id === bm.id);
                        if (entry) entry.title = newTitle;
                    }
                } else {
                    showBmToast('Не удалось переименовать');
                }
            } catch (err) { console.error('[BM sidebar] rename error:', err); showBmToast('Ошибка: ' + err.message); }
            input.replaceWith(titleEl);
        }

        input.addEventListener('blur', () => commit());
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { committed = true; input.replaceWith(titleEl); }
        });
    });

    deleteBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (li.querySelector('.bm-inline-confirm')) return;

        const confirmRow = document.createElement('div');
        confirmRow.className = 'bm-inline-confirm';
        confirmRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 12px 6px;font-size:12px;color:var(--text-2);';
        const confirmText = document.createElement('span');
        confirmText.style.flex = '1';
        confirmText.textContent = `Удалить «${String(bm.title || '').slice(0,30)}»?`;
        const confirmYes = document.createElement('button');
        confirmYes.className = 'bm-confirm-yes';
        confirmYes.type = 'button';
        confirmYes.textContent = 'Да';
        confirmYes.style.cssText = 'padding:3px 10px;border-radius:6px;border:none;background:#e74c3c;color:#fff;font-size:11px;cursor:pointer;';
        const confirmNo = document.createElement('button');
        confirmNo.className = 'bm-confirm-no';
        confirmNo.type = 'button';
        confirmNo.textContent = 'Нет';
        confirmNo.style.cssText = 'padding:3px 10px;border-radius:6px;border:1px solid var(--border-md);background:var(--bg-4);color:var(--text-2);font-size:11px;cursor:pointer;';
        confirmRow.append(confirmText, confirmYes, confirmNo);
        li.appendChild(confirmRow);

        confirmRow.querySelector('.bm-confirm-no').addEventListener('click', (ev) => { ev.stopPropagation(); confirmRow.remove(); });
        confirmRow.querySelector('.bm-confirm-yes').addEventListener('click', async (ev) => {
            ev.stopPropagation();
            confirmRow.remove();
            try {
                const resp = await sendMessage({ action: 'bookmark_delete', id: bm.id });
                console.log('[BM sidebar] delete resp:', resp);
                if (resp?.ok) {
                    li.remove();
                    if (currentData?.bookmarks?.list) {
                        currentData.bookmarks.list = currentData.bookmarks.list.filter(b => b.id !== bm.id);
                    }
                } else {
                    showBmToast('Не удалось удалить');
                }
            } catch (err) { console.error('[BM sidebar] delete error:', err); showBmToast('Ошибка: ' + err.message); }
        });
    });
}

function showBmToast(msg) {
    let t = document.getElementById('bm-toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'bm-toast';
        t.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--bg-4);color:var(--text);font-size:12px;padding:8px 14px;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.4);z-index:9999;pointer-events:none;transition:opacity 0.3s;white-space:nowrap;';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._hide);
    t._hide = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}


// 🚀 4Pulse 2.1 Productivity — локальные заметки и напоминания
// ══════════════════════════════════════════════════════════════════
let _prodMode = 'note';
const PROD_KEY = 'productivity_items';

function prodNow(){ return Date.now(); }
function prodUid(){ return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function prodFormatTime(ts){
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
    if (d.toDateString() === today.toDateString()) return `сегодня ${hh}:${mm}`;
    return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${hh}:${mm}`;
}
function prodNormalizeUrl(url){
    const u = String(url || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^4pda\.to\//i.test(u)) return 'https://' + u;
    return u;
}
function prodIsSafeUrl(url){
    try { const u = new URL(prodNormalizeUrl(url)); return ['http:', 'https:'].includes(u.protocol); } catch(_) { return false; }
}
function prodLinkifyText(text){
    const raw = String(text || '');
    const re = /(https?:\/\/[^\s<>()]+|4pda\.to\/[^\s<>()]+)/gi;
    let out = '', last = 0, m;
    while ((m = re.exec(raw))) {
        out += escapeHtml(raw.slice(last, m.index));
        let label = m[0];
        let href = prodNormalizeUrl(label).replace(/[.,;:!?]+$/,'');
        let trail = prodNormalizeUrl(label).slice(href.length);
        if (prodIsSafeUrl(href)) out += `<a class="prod-link" href="${escapeHtml(href)}" title="Открыть ссылку">${escapeHtml(label.replace(/[.,;:!?]+$/,''))}</a>${escapeHtml(trail)}`;
        else out += escapeHtml(label);
        last = re.lastIndex;
    }
    out += escapeHtml(raw.slice(last));
    return out;
}
function prodCleanTitle(t){
    return String(t || '')
        .replace(/\s*[—\-]\s*4PDA.*$/i,'')
        .replace(/\s*\/\s*4PDA.*$/i,'')
        .replace(/^Просмотр темы\s*[—:-]\s*/i,'')
        .replace(/\s+/g,' ')
        .trim();
}
function prodContextKindFromUrl(url){
    try {
        const u = new URL(prodNormalizeUrl(url));
        const act = (u.searchParams.get('act') || '').toLowerCase();
        if (act === 'qms') return 'qms';
        if (act === 'ticket') return 'ticket';
        if (u.searchParams.get('showtopic')) return 'topic';
        return 'page';
    } catch(_) { return 'page'; }
}
function prodContextLabel(kind){
    return kind === 'qms' ? 'QMS' : kind === 'ticket' ? 'Тикет' : kind === 'topic' ? 'Тема' : '4PDA';
}
function prodExtractFirstUrl(text){
    const m = String(text || '').match(/(https?:\/\/[^\s<>()]+|4pda\.to\/[^\s<>()]+)/i);
    return m ? prodNormalizeUrl(m[1].replace(/[.,;:!?]+$/,'')) : '';
}

function prodExtractUrls(text){
    const raw = String(text || '');
    const re = /(https?:\/\/[^\s<>()]+|4pda\.to\/[^\s<>()]+)/gi;
    const urls = [];
    let m;
    while ((m = re.exec(raw))) {
        const url = prodNormalizeUrl(m[1].replace(/[.,;:!?]+$/,''));
        if (prodIsSafeUrl(url) && !urls.includes(url)) urls.push(url);
    }
    return urls;
}
function prodTextWithoutUrls(text){
    let cleaned = String(text || '').replace(/(https?:\/\/[^\s<>()]+|4pda\.to\/[^\s<>()]+)/gi, ' ');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned;
}
function prodPrimaryText(text, type){
    const cleaned = prodTextWithoutUrls(text);
    if (cleaned) return cleaned;
    return type === 'reminder' ? 'Напоминание без описания' : 'Заметка без описания';
}
function prodUrlShortLabel(url, idx=0){
    try {
        const u = new URL(prodNormalizeUrl(url));
        const act = u.searchParams.get('act');
        if ((act || '').toLowerCase() === 'qms') return 'QMS';
        if ((act || '').toLowerCase() === 'ticket') return 'Тикет';
        if (u.searchParams.get('showtopic')) return idx ? `Тема ${idx+1}` : 'Тема';
        return u.hostname.replace(/^www\./,'');
    } catch(_) { return idx ? `Ссылка ${idx+1}` : 'Ссылка'; }
}
function prodBuildInlineLinks(text, source){
    const srcUrl = source?.url ? prodNormalizeUrl(source.url) : '';
    const urls = prodExtractUrls(text).filter(u => !srcUrl || prodNormalizeUrl(u) !== srcUrl);
    if (!urls.length) return '';
    const links = urls.slice(0,4).map((u,i)=>`<a class="prod-extra-link" href="${escapeHtml(u)}" title="${escapeHtml(u)}">${escapeHtml(prodUrlShortLabel(u, i))}</a>`).join('');
    const more = urls.length > 4 ? `<span class="prod-extra-more">+${urls.length-4}</span>` : '';
    return `<div class="prod-links-row"><span class="prod-links-label">Ссылки:</span>${links}${more}</div>`;
}

async function prodFindActive4pdaTab(){
    const queries = [
        { active: true, currentWindow: true },
        { active: true, lastFocusedWindow: true }
    ];
    for (const q of queries) {
        try {
            const tabs = await chrome.tabs.query(q);
            const tab = tabs && tabs[0];
            if (tab?.url && /https?:\/\/(?:[^/]+\.)?4pda\.to\/forum\//i.test(tab.url)) return tab;
        } catch(_) {}
    }
    return null;
}
async function prodGetCurrentContext(){
    try {
        const tab = await prodFindActive4pdaTab();
        if (!tab) return null;
        let ctx = null;
        try {
            ctx = await chrome.tabs.sendMessage(tab.id, { action: 'productivity_get_page_context' });
        } catch(_) {}
        const url = ctx?.url || tab.url;
        const u = new URL(url);
        const kind = ctx?.kind || prodContextKindFromUrl(url);
        const topicId = ctx?.topic_id || u.searchParams.get('showtopic') || '';
        const postId = ctx?.post_id || u.searchParams.get('p') || u.searchParams.get('entry') || '';
        const qmsId = ctx?.qms_id || u.searchParams.get('t') || '';
        const ticketId = ctx?.ticket_id || u.searchParams.get('id') || u.searchParams.get('t_id') || '';
        let title = prodCleanTitle(ctx?.title || tab.title || '');
        if (!title) {
            if (kind === 'qms') title = 'QMS диалог';
            else if (kind === 'ticket') title = 'Тикет 4PDA';
            else title = 'Тема 4PDA';
        }
        return {
            url,
            title,
            kind,
            label: prodContextLabel(kind),
            topic_id: topicId,
            post_id: postId,
            qms_id: qmsId,
            ticket_id: ticketId,
            forum: '4PDA',
            captured_at: prodNow()
        };
    } catch(_) { return null; }
}
function prodBuildSourceMeta(src, noteText=''){
    let source = src;
    if ((!source || !source.url) && noteText) {
        const url = prodExtractFirstUrl(noteText);
        if (url) {
            const kind = prodContextKindFromUrl(url);
            source = { url, title: kind === 'topic' ? 'Открыть тему из заметки' : kind === 'qms' ? 'Открыть QMS из заметки' : kind === 'ticket' ? 'Открыть тикет из заметки' : 'Открыть ссылку из заметки', kind, label: prodContextLabel(kind) };
        }
    }
    if (!source || !source.url) return '';
    const kind = source.kind || prodContextKindFromUrl(source.url);
    const label = source.label || prodContextLabel(kind);
    const title = source.title || (kind === 'qms' ? 'QMS диалог' : kind === 'ticket' ? 'Тикет 4PDA' : 'Открыть источник');
    let details = '';
    if (source.topic_id) details = `topic ${source.topic_id}${source.post_id ? ' / post ' + source.post_id : ''}`;
    else if (source.qms_id) details = `dialog ${source.qms_id}`;
    else if (source.ticket_id) details = `ticket ${source.ticket_id}`;
    return `<div class="prod-source-card" data-prod-source="${escapeHtml(source.url)}"><span class="prod-source-badge">${escapeHtml(label)}</span><a class="prod-source" href="${escapeHtml(source.url)}" title="Открыть источник">${escapeHtml(title)}</a>${details ? `<span class="prod-source-id">${escapeHtml(details)}</span>` : ''}</div>`;
}
async function prodOpenUrl(url){
    if (!prodIsSafeUrl(url)) return;
    try { await chrome.tabs.create({ url: prodNormalizeUrl(url), active: true }); } catch(_) {}
}
async function prodLoad(){
    const r = await chrome.storage.local.get([PROD_KEY]);
    return Array.isArray(r[PROD_KEY]) ? r[PROD_KEY] : [];
}
async function prodSave(items){
    await safeStorageSet({ [PROD_KEY]: items });
}
let _prodPanelHiddenForThisView = false;
function prodShowPanel(){
    const panel = document.getElementById('productivity-panel');
    if (!panel) return;
    _prodPanelHiddenForThisView = false;
    panel.classList.remove('hidden');
    settings.productivity_panel_enabled = true;
    prodRenderList();
}
function prodHidePanel(){
    const panel = document.getElementById('productivity-panel');
    _prodPanelHiddenForThisView = true;
    panel?.classList.add('hidden');
    prodCancelInput();
}
function prodStartInput(mode='note'){
    prodShowPanel();
    _prodMode = mode;
    const row = document.getElementById('prod-input-row');
    const input = document.getElementById('prod-text');
    const sel = document.getElementById('prod-remind-select');
    if (!row || !input || !sel) return;
    row.classList.remove('hidden');
    sel.classList.toggle('hidden', mode !== 'reminder');
    input.placeholder = mode === 'reminder' ? 'Что напомнить?' : 'Заметка: что нужно не забыть?';
    input.value = '';
    setTimeout(()=>input.focus(), 30);
}
function prodCancelInput(){ document.getElementById('prod-input-row')?.classList.add('hidden'); }
async function prodAdd(){
    const input = document.getElementById('prod-text');
    const sel = document.getElementById('prod-remind-select');
    const text = (input?.value || '').trim();
    if (!text) { input?.focus(); return; }
    const items = await prodLoad();
    const minutes = parseInt(sel?.value || '30', 10);
    const source = await prodGetCurrentContext();
    items.unshift({
        id: prodUid(),
        type:_prodMode,
        text,
        source,
        created_at: prodNow(),
        due_at: _prodMode==='reminder' ? prodNow() + minutes*60000 : null,
        done:false
    });
    await prodSave(items.slice(0,80));
    prodCancelInput();
    prodRenderList();
    showBmToast(_prodMode === 'reminder' ? 'Напоминание создано' : 'Заметка создана');
}
async function prodToggleDone(id){
    const items = await prodLoad();
    const it = items.find(x=>x.id===id); if (it) it.done = !it.done;
    await prodSave(items); prodRenderList();
}
async function prodDelete(id){
    const items = (await prodLoad()).filter(x=>x.id!==id);
    await prodSave(items); prodRenderList();
}
async function prodRenderList(){
    const list = document.getElementById('prod-list');
    if (!list) return;
    let items = await prodLoad();
    const now = prodNow();
    items.sort((a,b)=>{
        const ad = a.done ? 1 : 0, bd = b.done ? 1 : 0;
        if (ad !== bd) return ad-bd;
        const ar = a.due_at || a.created_at || 0, br = b.due_at || b.created_at || 0;
        return ar-br;
    });
    if (!items.length) {
        const emptyProd = document.createElement('div');
        emptyProd.className = 'prod-empty';
        emptyProd.textContent = 'Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.';
        list.replaceChildren(emptyProd);
        return;
    }
    __4pSetHTML(list,items.slice(0,12).map(it=>{
        const due = it.due_at ? (it.due_at <= now && !it.done ? ' • пора' : ' • ' + prodFormatTime(it.due_at)) : '';
        const kind = it.type === 'reminder' ? '⏰' : '📝';
        const cls = it.done ? ' done' : '';
        const sourceHtml = prodBuildSourceMeta(it.source, it.text);
        const sourceBtn = it.source?.url || prodExtractFirstUrl(it.text) ? '<button class="prod-mini" data-prod-act="open" title="Открыть источник">↗</button>' : '';
        const mainText = prodPrimaryText(it.text, it.type);
        const linksHtml = prodBuildInlineLinks(it.text, it.source);
        return `<div class="prod-item${cls}" data-prod-id="${escapeHtml(it.id)}"><div class="prod-kind">${kind}</div><div class="prod-body"><div class="prod-desc-label">Описание</div><div class="prod-text">${escapeHtml(mainText)}</div><div class="prod-meta">${it.type==='reminder'?'Напоминание':'Заметка'}${escapeHtml(due)}</div>${linksHtml}${sourceHtml ? `<div class="prod-source-row">${sourceHtml}</div>` : ''}</div><div class="prod-row-actions">${sourceBtn}<button class="prod-mini" data-prod-act="done">${it.done?'↩':'✓'}</button><button class="prod-mini" data-prod-act="del">×</button></div></div>`;
    }).join(''));
    list.querySelectorAll('[data-prod-act="done"]').forEach(btn=>btn.addEventListener('click',(e)=>{ e.stopPropagation(); prodToggleDone(btn.closest('.prod-item')?.dataset.prodId); }));
    list.querySelectorAll('[data-prod-act="del"]').forEach(btn=>btn.addEventListener('click',(e)=>{ e.stopPropagation(); prodDelete(btn.closest('.prod-item')?.dataset.prodId); }));
    list.querySelectorAll('[data-prod-act="open"]').forEach(btn=>btn.addEventListener('click', async (e)=>{
        e.stopPropagation();
        const id = btn.closest('.prod-item')?.dataset.prodId;
        const item = (await prodLoad()).find(x=>x.id===id);
        const url = item?.source?.url || prodExtractFirstUrl(item?.text || '');
        if (url) prodOpenUrl(url);
    }));
    list.querySelectorAll('a.prod-link,a.prod-source,a.prod-extra-link').forEach(a=>a.addEventListener('click', e=>{ e.preventDefault(); e.stopPropagation(); prodOpenUrl(a.getAttribute('href')); }));
}
function prodBind(){
    document.getElementById('prod-add-note')?.addEventListener('click', ()=>prodStartInput('note'));
    document.getElementById('prod-add-reminder')?.addEventListener('click', ()=>prodStartInput('reminder'));
    document.getElementById('prod-close')?.addEventListener('click', prodHidePanel);
    document.getElementById('prod-save')?.addEventListener('click', prodAdd);
    document.getElementById('prod-cancel')?.addEventListener('click', prodCancelInput);
    document.getElementById('prod-text')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); prodAdd(); } if(e.key==='Escape'){ prodCancelInput(); } });
}
function renderProductivityPanel(data){
    const enabled = (data?.settings?.productivity_panel_enabled ?? settings.productivity_panel_enabled) === true;
    const panel = document.getElementById('productivity-panel');
    if (!panel) return;
    settings.productivity_panel_enabled = enabled;
    if (enabled && !_prodPanelHiddenForThisView) {
        panel.classList.remove('hidden');
        prodRenderList();
    } else {
        panel.classList.add('hidden');
    }
}
prodBind();

// ── Command palette (sidebar) ─────────────────────────────────────────────
let _cmdOpen = false;
let _cmdSelected = 0;
let _cmdItems = [];

function cmdCount(path, fallback = 0) {
    try {
        return path.split('.').reduce((obj, key) => obj?.[key], currentData) ?? fallback;
    } catch (_) { return fallback; }
}



function renderAuthStatusBar(data = currentData) {
    const bar = document.getElementById('auth-status-bar');
    if (!bar) return;
    const logged = !!(data && (data.user_id || data.user_name));
    const name = data?.user_name || '4PDA';
    bar.className = 'auth-status-bar ' + (logged ? 'ok' : 'warn');
    const statusText = document.createElement('span');
    statusText.textContent = logged ? `✅ Вход выполнен · ${name}` : '⚠️ Нужен вход на 4PDA';
    const actions = document.createElement('span');
    actions.className = 'auth-actions';
    if (logged) {
        const checkBtn = document.createElement('button');
        checkBtn.type = 'button';
        checkBtn.dataset.authAction = 'check';
        checkBtn.textContent = 'Проверить';
        actions.appendChild(checkBtn);
    } else {
        const loginBtn = document.createElement('button');
        loginBtn.type = 'button';
        loginBtn.dataset.authAction = 'login';
        loginBtn.textContent = 'Войти';
        actions.appendChild(loginBtn);
    }
    const diagBtn = document.createElement('button');
    diagBtn.type = 'button';
    diagBtn.dataset.authAction = 'diag';
    diagBtn.textContent = 'Диагностика';
    actions.appendChild(diagBtn);
    bar.replaceChildren(statusText, actions);
    bar.querySelector('[data-auth-action="login"]')?.addEventListener('click', (e)=>{ e.stopPropagation(); chrome.tabs.create({url:'https://4pda.to/forum/index.php?act=auth', active:true}); });
    bar.querySelector('[data-auth-action="diag"]')?.addEventListener('click', (e)=>{ e.stopPropagation(); chrome.tabs.create({url:chrome.runtime.getURL('/html/options.html?section=diagnostics#diagnostics'), active:true}); });
    bar.querySelector('[data-auth-action="check"]')?.addEventListener('click', (e)=>{ e.stopPropagation(); handleRefreshClick(); });
}

function cmdGetCounts() {
    return {
        qms: Number(cmdCount('qms.count', 0) || 0),
        fav: Number(cmdCount('favorites.count', 0) || 0),
        mentions: Number(cmdCount('mentions.count', 0) || 0),
        tickets: Number(cmdCount('tickets.count', 0) || 0),
        bookmarks: Number((currentData?.bookmarks?.items || currentData?.bookmarks?.list || []).length || 0)
    };
}

function cmdOpenOptionsSection(section = 'fourpulse') {
    const map = {
        fourpulse: 'fourpulse',
        diagnostics: 'diagnostics',
        appearance: 'appearance',
        notifications: 'notifications'
    };
    const sec = map[section] || 'fourpulse';
    chrome.tabs.create({ url: chrome.runtime.getURL('/html/options.html?section=' + encodeURIComponent(sec)), active: true });
}

function cmdBuildItems() {
    const c = cmdGetCounts();
    const items = [
        { icon:'💬', name:'Открыть QMS', desc:`Личные сообщения · новых: ${c.qms}`, keys:'qms лс личные сообщения', kbd:'qms', run:()=>openTab('qms') },
        { icon:'⭐', name:'Открыть избранное', desc:`Избранные темы · новых: ${c.fav}`, keys:'fav избранное темы favorites', kbd:'fav', run:()=>openTab('favorites') },
        { icon:'@', name:'Открыть ответы', desc:`Упоминания и ответы · новых: ${c.mentions}`, keys:'mentions ответы упоминания reply ответ', kbd:'ans', run:()=>openTab('mentions') },
        { icon:'🔖', name:'Показать закладки', desc:`Закладки в сайдбаре · записей: ${c.bookmarks}`, keys:'bookmarks закладки bm', kbd:'bm', run:()=>toggleFilter('bookmarks') },
        { icon:'🚀', name:'Открыть продуктивность', desc:'Заметки и отложенные напоминания', keys:'productivity tasks задачи заметки напоминания', kbd:'tasks', run:()=>prodShowPanel() },
        { icon:'📝', name:'Новая заметка', desc:'Быстро создать локальную заметку', keys:'note заметка записать memo', kbd:'note', run:()=>prodStartInput('note') },
        { icon:'⏰', name:'Напомнить позже', desc:'Создать локальное напоминание', keys:'snooze reminder напомнить позже отложить', kbd:'snooze', run:()=>prodStartInput('reminder') },
        { icon:'🔄', name:'Обновить данные', desc:'Принудительно обновить QMS, темы, ответы и тикеты', keys:'refresh reload update обновить', kbd:'r', run:()=>handleRefreshClick() },
        { icon:'🩺', name:'Открыть диагностику', desc:'Состояние WebSocket, polling, журнал и отчёт', keys:'diag диагностика health здоровье лог журнал', kbd:'diag', run:()=>cmdOpenOptionsSection('diagnostics') },
        { icon:'⚙️', name:'Настройки', desc:'Открыть настройки 4Pulse', keys:'settings options настройки параметры', kbd:'set', run:()=>cmdOpenOptionsSection('fourpulse') },
        { icon:'🎨', name:'Внешний вид', desc:'Тема, акцент, шрифт и оформление', keys:'appearance внешний вид тема color theme', kbd:'ui', run:()=>cmdOpenOptionsSection('appearance') },
        { icon:'🎵', name:'Радио: play/pause', desc:'Быстро переключить радио, если станция выбрана', keys:'radio радио музыка play pause', kbd:'radio', run:()=>cmdToggleRadio() },
        { icon:'🔕', name:'Тишина на 30 минут', desc:'Временный DND-режим на полчаса', keys:'silence тишина dnd mute quiet 30', kbd:'mute', run:()=>cmdSmartSilence(30) },
        { icon:'🌙', name:'Тишина на 60 минут', desc:'Временный DND-режим на один час', keys:'silence тишина dnd mute quiet 60 час', kbd:'60', run:()=>cmdSmartSilence(60) },
        { icon:'✅', name:'Выключить тишину', desc:'Отключить временную умную тишину', keys:'clear silence выключить тишину dnd unmute', kbd:'unmute', run:()=>sendMessage({action:'smart_silence_clear'}) },
        { icon:'📋', name:'Скопировать короткий отчёт', desc:'QMS / темы / ответы / тикеты одной строкой', keys:'copy отчет report status stats статистика', kbd:'copy', run:()=>cmdCopyShortReport() }
    ];
    if (currentData?.tickets?.enabled || c.tickets > 0) {
        items.splice(3, 0, { icon:'🎫', name:'Открыть тикеты', desc:`Модераторские тикеты · новых: ${c.tickets}`, keys:'ticket tickets тикеты модерация', kbd:'ticket', run:()=>openTab('ticket') });
    }
    return items;
}

function cmdFilterItems(q) {
    const query = (q || '').trim().toLowerCase();
    const items = cmdBuildItems();
    if (!query) return items;
    return items.filter(i => (i.name + ' ' + i.desc + ' ' + i.keys + ' ' + i.kbd).toLowerCase().includes(query));
}

function cmdRender() {
    const input = document.getElementById('cmd-input');
    const box = document.getElementById('cmd-results');
    if (!box) return;
    _cmdItems = cmdFilterItems(input?.value || '');
    if (_cmdSelected >= _cmdItems.length) _cmdSelected = Math.max(0, _cmdItems.length - 1);
    if (!_cmdItems.length) {
        const emptyCmd = document.createElement('div');
        emptyCmd.className = 'cmd-empty';
        emptyCmd.textContent = 'Команда не найдена. Попробуй: qms, fav, ticket, radio, diag, mute.';
        box.replaceChildren(emptyCmd);
        return;
    }
    const fragment = document.createDocumentFragment();
    _cmdItems.forEach((it, idx) => {
        const row = document.createElement('div');
        row.className = `cmd-row${idx === _cmdSelected ? ' selected' : ''}`;
        row.dataset.cmdIndex = String(idx);
        const icon = document.createElement('div');
        icon.className = 'cmd-icon';
        icon.textContent = it.icon || '';
        const textWrap = document.createElement('div');
        const nameEl = document.createElement('div');
        nameEl.className = 'cmd-name';
        nameEl.textContent = it.name || '';
        const descEl = document.createElement('div');
        descEl.className = 'cmd-desc';
        descEl.textContent = it.desc || '';
        textWrap.append(nameEl, descEl);
        const kbd = document.createElement('div');
        kbd.className = 'cmd-kbd';
        kbd.textContent = it.kbd || '';
        row.append(icon, textWrap, kbd);
        fragment.appendChild(row);
    });
    box.replaceChildren(fragment);
    box.querySelectorAll('.cmd-row').forEach(row => {
        row.addEventListener('mouseenter', () => {
            _cmdSelected = parseInt(row.dataset.cmdIndex || '0', 10);
            box.querySelectorAll('.cmd-row').forEach((r, i) => r.classList.toggle('selected', i === _cmdSelected));
        });
        row.addEventListener('mousedown', (e) => {
            e.preventDefault();
            _cmdSelected = parseInt(row.dataset.cmdIndex || '0', 10);
            cmdRunSelected();
        });
    });
}

function cmdOpen(initial='') {
    const overlay = document.getElementById('command-palette-overlay');
    const input = document.getElementById('cmd-input');
    if (!overlay || !input) return;
    _cmdOpen = true;
    _cmdSelected = 0;
    overlay.hidden = false;
    input.value = initial;
    cmdRender();
    setTimeout(() => { input.focus(); input.select(); }, 20);
}

function cmdClose() {
    const overlay = document.getElementById('command-palette-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    _cmdOpen = false;
}

async function cmdRunSelected() {
    const item = _cmdItems[_cmdSelected];
    if (!item) return;
    try {
        await item.run();
        cmdClose();
    } catch (e) {
        console.warn('command failed:', e);
        showBmToast('Команда не выполнена');
    }
}

async function cmdToggleRadio() {
    const st = await sendMessage({ action:'radio_get_state' });
    if (st?.isPlaying) return sendMessage({ action:'radio_pause' });
    const r = await chrome.storage.local.get(['radio_station','radio_station_name']);
    if (r.radio_station) return sendMessage({ action:'radio_play', station:r.radio_station, stationName:r.radio_station_name });
    cmdOpenOptionsSection('fourpulse');
}

function cmdFormatShortTime(ts) {
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }); }
    catch (_) { return ''; }
}

async function cmdSmartSilence(minutes) {
    const r = await sendMessage({ action:'smart_silence_set', minutes, mode:'focus' });
    showBmToast(r?.ok ? ('Тишина до ' + cmdFormatShortTime(r.until)) : 'Не удалось включить тишину');
}

async function cmdCopyShortReport() {
    const c = cmdGetCounts();
    const text = `4Pulse: QMS ${c.qms}, темы ${c.fav}, ответы ${c.mentions}, тикеты ${c.tickets}, закладки ${c.bookmarks}.`;
    await navigator.clipboard.writeText(text);
    showBmToast('Отчёт скопирован');
}

function cmdInit() {
    document.getElementById('command-palette-toggle')?.addEventListener('click', () => cmdOpen());
    document.getElementById('cmd-close')?.addEventListener('click', cmdClose);
    document.getElementById('command-palette-overlay')?.addEventListener('click', (e) => { if (e.target?.id === 'command-palette-overlay') cmdClose(); });
    document.getElementById('cmd-input')?.addEventListener('input', () => { _cmdSelected = 0; cmdRender(); });
    document.getElementById('cmd-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { _cmdSelected = Math.min(_cmdSelected + 1, Math.max(0, _cmdItems.length - 1)); cmdRender(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { _cmdSelected = Math.max(_cmdSelected - 1, 0); cmdRender(); e.preventDefault(); }
        else if (e.key === 'Enter') { e.preventDefault(); cmdRunSelected(); }
        else if (e.key === 'Escape') { e.preventDefault(); cmdClose(); }
    });
    document.addEventListener('keydown', (e) => {
        const isK = (e.key || '').toLowerCase() === 'k';
        if ((e.ctrlKey || e.metaKey) && isK) { e.preventDefault(); _cmdOpen ? cmdClose() : cmdOpen(); }
        if (_cmdOpen && e.key === 'Escape') { e.preventDefault(); cmdClose(); }
    }, true);
}

cmdInit();


// 4Pulse 2.2.38 — final visible i18n QA sweep for popup/sidebar
(function(){
  const DICT={
    en:{'Не обработан':'Unprocessed','В работе':'In progress','Обработан':'Processed','Все':'All','Новая тема:':'New topic:','Новая тема':'New topic','В шапку темы':'To topic header','битая ссылка':'Broken link','Открыть':'Open','В работу':'In progress','Обработать':'Process','Ответить':'Reply','Открыть все':'Open all','Закреплённые':'Pinned','Прочитать все':'Mark all read','Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.':'Nothing here yet. Add a note or reminder with + note / + remind, or via ⌘K → note/snooze.','Добавить закладку':'Add bookmark','Добавить':'Add','Папка':'Folder','Закладки':'Bookmarks','Тикеты':'Tickets','Радио':'Radio','выкл':'off'},
    de:{'Не обработан':'Unbearbeitet','В работе':'In Bearbeitung','Обработан':'Bearbeitet','Все':'Alle','Новая тема:':'Neues Thema:','Новая тема':'Neues Thema','В шапку темы':'In den Themenkopf','битая ссылка':'Defekter Link','Открыть':'Öffnen','В работу':'In Bearbeitung','Обработать':'Bearbeiten','Ответить':'Antworten','Открыть все':'Alle öffnen','Закреплённые':'Angeheftet','Прочитать все':'Alle gelesen','Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.':'Noch leer. Füge eine Notiz oder Erinnerung über + Notiz / + erinnern hinzu oder über ⌘K → note/snooze.','Добавить закладку':'Lesezeichen hinzufügen','Добавить':'Hinzufügen','Папка':'Ordner','Закладки':'Lesezeichen','Тикеты':'Tickets','Радио':'Radio','выкл':'aus'},
    uk:{'Не обработан':'Не оброблено','В работе':'У роботі','Обработан':'Оброблено','Все':'Усі','Новая тема:':'Нова тема:','Новая тема':'Нова тема','В шапку темы':'У шапку теми','битая ссылка':'бите посилання','Открыть':'Відкрити','В работу':'У роботу','Обработать':'Обробити','Ответить':'Відповісти','Открыть все':'Відкрити всі','Закреплённые':'Закріплені','Прочитать все':'Прочитати всі','Пока пусто. Добавь заметку или напоминание через + заметка / + напомнить или через ⌘K → note/snooze.':'Поки порожньо. Додайте нотатку або нагадування через + нотатка / + нагадати або через ⌘K → note/snooze.','Добавить закладку':'Додати закладку','Добавить':'Додати','Папка':'Папка','Закладки':'Закладки','Тикеты':'Тікети','Радио':'Радіо','выкл':'вимк.'}
  };
  // ★ OPT: единый кеш языка — исключает повторные IPC-вызовы
// _cachedLang is shared with the sidebar bootstrap scope.
// ★ i18n: строки UI для передачи в UICommon.renderHistory/renderQMS/filterTopics
const _i18nStrings = {
    ru: {
        refreshTitle:'Обновить навигацию', refreshText:'↻ Обновить',
        openLastTitle:'Открыть последнюю тему', openLastText:'▶ Последняя',
        openAllTitle:'Открыть до 10 видимых тем', openAllText:'⇱ Открыть все',
        restoreTitle:'Вернуть скрытые темы', hiddenCount:n=>`↺ Скрытые: ${n}`,
        continueTitle:'Продолжить', noRecentTopics:'Нет недавних тем',
        openTopicHint:'Откройте тему на форуме', openBtn:'Открыть',
        lastTicketTitle:'Последний тикет', noTicketData:'Нет данных по тикетам',
        openTicketsHint:'Откройте вкладку тикетов', openTicketsBtn:'Открыть тикеты',
        pinnedTitle:'Закреплённые рабочие темы',
        pinHint:'Закрепляйте темы кнопкой 📌 в списке ниже',
        pinRemoveTitle:'Убрать', topicFallback:'Тема',
        searchPlaceholder:'Быстрый поиск: тема, раздел, автор...',
        searchAriaLabel:'Быстрый поиск по навигации',
        allHiddenMsg:'Все темы навигации скрыты локально. Нажмите «Скрытые», чтобы вернуть их.',
        notLoadedMsg:'Навигация пока не загружена.',
        emptyNavMsg:'Навигация пуста — откройте несколько тем на форуме',
        actionsLabel:'Управление навигацией',
        unpinTitle:'Убрать из рабочих тем', pinAsWorkTitle:'Закрепить как рабочую тему',
        openFromStartTitle:'Открыть тему с начала', copyLinkTitle:'Скопировать ссылку',
        hideTitle:'Скрыть из навигации 4Pulse',
        qmsSearchPlaceholder:'🔍 Поиск по имени или теме...',
        noTickets:'Нет тикетов', loadingHistory:'Загружаем историю…',
        allRead:'Все темы прочитаны', noNewQms:'Нет новых сообщений',
        noNewMentions:'Нет упоминаний', bookmarksNotLoaded:'Закладки не загружены',
    },
    de: {
        refreshTitle:'Navigation aktualisieren', refreshText:'↻ Aktualisieren',
        openLastTitle:'Letztes Thema öffnen', openLastText:'▶ Letzte',
        openAllTitle:'Bis zu 10 sichtbare Themen öffnen', openAllText:'⇱ Alle öffnen',
        restoreTitle:'Ausgeblendete Themen wiederherstellen', hiddenCount:n=>`↺ Ausgeblendet: ${n}`,
        continueTitle:'Fortfahren', noRecentTopics:'Keine aktuellen Themen',
        openTopicHint:'Öffne ein Thema im Forum', openBtn:'Öffnen',
        lastTicketTitle:'Letztes Ticket', noTicketData:'Keine Ticket-Daten',
        openTicketsHint:'Öffne den Tickets-Tab', openTicketsBtn:'Tickets öffnen',
        pinnedTitle:'Angeheftete Arbeitsthemen',
        pinHint:'Themen mit 📌 in der Liste unten anheften',
        pinRemoveTitle:'Entfernen', topicFallback:'Thema',
        searchPlaceholder:'Schnellsuche: Thema, Bereich, Autor...',
        searchAriaLabel:'Schnellsuche in der Navigation',
        allHiddenMsg:'Alle Navigationsthemen lokal ausgeblendet. Klicke auf „Ausgeblendet", um sie zurückzuholen.',
        notLoadedMsg:'Navigation noch nicht geladen.',
        emptyNavMsg:'Navigation leer — öffne einige Themen im Forum',
        actionsLabel:'Navigation verwalten',
        unpinTitle:'Aus Arbeitsthemen entfernen', pinAsWorkTitle:'Als Arbeitsthema anheften',
        openFromStartTitle:'Thema vom Anfang öffnen', copyLinkTitle:'Link kopieren',
        hideTitle:'Aus 4Pulse-Navigation ausblenden',
        qmsSearchPlaceholder:'🔍 Suche nach Name oder Thema...',
        noTickets:'Keine Tickets', loadingHistory:'Navigation wird geladen…',
        allRead:'Alle Themen gelesen', noNewQms:'Keine neuen Nachrichten',
        noNewMentions:'Keine Erwähnungen', bookmarksNotLoaded:'Lesezeichen nicht geladen',
    },
    en: {
        refreshTitle:'Refresh navigation', refreshText:'↻ Refresh',
        openLastTitle:'Open last topic', openLastText:'▶ Latest',
        openAllTitle:'Open up to 10 visible topics', openAllText:'⇱ Open all',
        restoreTitle:'Restore hidden topics', hiddenCount:n=>`↺ Hidden: ${n}`,
        continueTitle:'Continue', noRecentTopics:'No recent topics',
        openTopicHint:'Open a topic on the forum', openBtn:'Open',
        lastTicketTitle:'Last ticket', noTicketData:'No ticket data',
        openTicketsHint:'Open the tickets tab', openTicketsBtn:'Open tickets',
        pinnedTitle:'Pinned work topics',
        pinHint:'Pin topics using 📌 in the list below',
        pinRemoveTitle:'Remove', topicFallback:'Topic',
        searchPlaceholder:'Quick search: topic, section, author...',
        searchAriaLabel:'Quick search in navigation',
        allHiddenMsg:'All navigation topics hidden locally. Click "Hidden" to restore them.',
        notLoadedMsg:'Navigation not loaded yet.',
        emptyNavMsg:'Navigation empty — open some topics on the forum',
        actionsLabel:'Manage navigation',
        unpinTitle:'Remove from work topics', pinAsWorkTitle:'Pin as work topic',
        openFromStartTitle:'Open topic from start', copyLinkTitle:'Copy link',
        hideTitle:'Hide from 4Pulse navigation',
        qmsSearchPlaceholder:'🔍 Search by name or topic...',
        noTickets:'No tickets', loadingHistory:'Loading navigation…',
        allRead:'All topics read', noNewQms:'No new messages',
        noNewMentions:'No mentions', bookmarksNotLoaded:'Bookmarks not loaded',
    },
    uk: {
        refreshTitle:'Оновити навігацію', refreshText:'↻ Оновити',
        openLastTitle:'Відкрити останню тему', openLastText:'▶ Остання',
        openAllTitle:'Відкрити до 10 видимих тем', openAllText:'⇱ Відкрити всі',
        restoreTitle:'Відновити приховані теми', hiddenCount:n=>`↺ Приховані: ${n}`,
        continueTitle:'Продовжити', noRecentTopics:'Немає нещодавніх тем',
        openTopicHint:'Відкрийте тему на форумі', openBtn:'Відкрити',
        lastTicketTitle:'Останній тікет', noTicketData:'Немає даних по тікетах',
        openTicketsHint:'Відкрийте вкладку тікетів', openTicketsBtn:'Відкрити тікети',
        pinnedTitle:'Закріплені робочі теми',
        pinHint:'Закріпляйте теми кнопкою 📌 у списку нижче',
        pinRemoveTitle:'Прибрати', topicFallback:'Тема',
        searchPlaceholder:'Швидкий пошук: тема, розділ, автор...',
        searchAriaLabel:'Швидкий пошук у навігації',
        allHiddenMsg:'Усі теми навігації приховані локально. Натисніть «Приховані», щоб повернути їх.',
        notLoadedMsg:'Навігація ще не завантажена.',
        emptyNavMsg:'Навігація порожня — відкрийте кілька тем на форумі',
        actionsLabel:'Керування навігацією',
        unpinTitle:'Прибрати з робочих тем', pinAsWorkTitle:'Закріпити як робочу тему',
        openFromStartTitle:'Відкрити тему з початку', copyLinkTitle:'Скопіювати посилання',
        hideTitle:'Приховати з навігації 4Pulse',
        qmsSearchPlaceholder:'🔍 Пошук за іменем або темою...',
        noTickets:'Немає тікетів', loadingHistory:'Завантаження навігації…',
        allRead:'Всі теми прочитані', noNewQms:'Немає нових повідомлень',
        noNewMentions:'Немає згадок', bookmarksNotLoaded:'Закладки не завантажені',
    },
};
function _getI18nStrings() {
    const lang = _cachedLang.slice(0, 2);
    return _i18nStrings[lang] || _i18nStrings.ru;
}
window.__sidebarGetI18nStrings = _getI18nStrings;

chrome.storage.local.get(['ui_language']).then(r => { if (r.ui_language) _cachedLang = r.ui_language; }).catch(()=>{});
chrome.storage.onChanged.addListener(ch => { if (ch.ui_language?.newValue) _cachedLang = ch.ui_language.newValue; });
async function lang(){ return _cachedLang; }
  function replace(root,dict){ if(!root||!dict)return; const skip=new Set(['SCRIPT','STYLE','SVG','PATH','USE','TEXTAREA']); const tr=s=>{let out=String(s||''); for(const [a,b] of Object.entries(dict)){ if(out.trim()===a) return out.replace(a,b); } return out;}; const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(n){return n.parentElement&&!skip.has(n.parentElement.tagName)?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;}}); const ns=[]; while(w.nextNode()) ns.push(w.currentNode); ns.forEach(n=>{const v=tr(n.nodeValue); if(v!==n.nodeValue)n.nodeValue=v;}); root.querySelectorAll&&root.querySelectorAll('*').forEach(el=>['placeholder','title','aria-label','value'].forEach(a=>{if(el.hasAttribute(a)){const v=tr(el.getAttribute(a)); if(v!==el.getAttribute(a))el.setAttribute(a,v);}})); }
  async function run(){ const l=await lang(); if(l==='ru')return; replace(document.body||document.documentElement, DICT[l]); }
  document.addEventListener('DOMContentLoaded',()=>setTimeout(run,80)); setTimeout(run,250); setTimeout(run,900);
  if(!window.__fpPanelI18nFinalObserver){ window.__fpPanelI18nFinalObserver=new MutationObserver(()=>{clearTimeout(window.__fpPanelI18nFinalTimer); window.__fpPanelI18nFinalTimer=setTimeout(run,60);}); window.__fpPanelI18nFinalObserver.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['placeholder','title','aria-label','value']}); }
})();


/* 4Pulse 2.2.41 — hard i18n residue patch. */
(function(){
  if (window.__4pulseHardI18nResiduePatch) return;
  window.__4pulseHardI18nResiduePatch = true;
  const MAP = {
    de: {
      'Компактная статистика':'Kompakte Statistik','Превращает сетку плиток в узкую горизонтальную полосу — освобождает больше места для списка тем':'Wandelt das Kachelraster in eine schmale horizontale Leiste um — schafft mehr Platz für die Themenliste','Компактна статистика':'Kompakte Statistik','Плитки перестраиваются из сетки в горизонтальный ряд (иконка + цифра)':'Kacheln werden vom Raster in eine horizontale Reihe umgestellt (Icon + Zahl)','Свернуто (только статистика)':'Eingeklappt (nur Statistik)','Скрыть все списки — показывать только строку со счётчиками':'Alle Listen ausblenden — nur die Zählerzeile anzeigen','Показывать список тем':'Themenliste anzeigen','Показывать список тем под строкой статистики':'Themenliste unter der Statistikzeile anzeigen','Скрыть плитку QMS':'QMS-Kachel ausblenden','Не показывать счётчик QMS в строке статистики':'QMS-Zähler in der Statistikzeile nicht anzeigen','Скрыть плитку «Избранные»':'Favoriten-Kachel ausblenden','Не показывать счётчик избранных тем в строке статистики':'Favoritenzähler in der Statistikzeile nicht anzeigen','Скрыть плитку «Упоминания»':'Erwähnungen-Kachel ausblenden','Не показывать счётчик упоминаний в строке статистики':'Erwähnungszähler in der Statistikzeile nicht anzeigen','Показывать тулбар сортировки тем':'Sortierleiste für Themen anzeigen','Кнопки сортировки, группировки и фильтрации по тегам над списком Избранных':'Schaltflächen zum Sortieren, Gruppieren und Filtern nach Tags über der Favoritenliste','Отключить анимацию новых тем':'Animation neuer Themen deaktivieren','Убирает мерцание и анимацию появления карточек тем — панель больше не мигает при обновлении':'Blinken und Einblendanimation neuer Themenkarten deaktivieren — die Leiste flackert bei Updates nicht mehr','Расположение плиток':'Kachel-Anordnung','Перетащите плитки между рядами. До 5 плиток в ряду, незаполненный ряд растягивается автоматически':'Ziehe Kacheln zwischen den Reihen. Bis zu 5 Kacheln pro Reihe; eine nicht gefüllte Reihe wird automatisch gestreckt','РЯД 1':'REIHE 1','РЯД 2':'REIHE 2','СКРЫТЫЕ':'AUSGEBLENDET','Скрытые':'Ausgeblendet','ПРИХОВАНІ':'AUSGEBLENDET','Сбросить':'Zurücksetzen','Скинути':'Zurücksetzen','Строк в списке тем':'Zeilen in der Themenliste','Сколько тем показывать без прокрутки. 0 = без ограничения':'Anzahl der Themen ohne Scrollen. 0 = unbegrenzt','Ширина окна':'Fensterbreite','Изменяет ширину попапа 4Pulse (320–600 px)':'Ändert die Breite des 4Pulse-Popups (320–600 px)','Экспорт / Импорт настроек':'Einstellungen exportieren / importieren','Сохранить или восстановить все настройки 4Pulse':'Alle 4Pulse-Einstellungen sichern oder wiederherstellen','Экспорт':'Export','Импорт':'Import','Тикеты':'Tickets','Только для модераторов':'Nur für Moderatoren','Мониторинг и обработка тикетов прямо из расширения':'Tickets direkt in der Erweiterung überwachen und bearbeiten','Ticket-раздел активировать':'Ticket-Bereich aktivieren','Добавляет вкладку „Tickets“ в Popup и показывает счётчик на иконке.':'Fügt den Tab „Tickets“ im Popup hinzu und zeigt einen Zähler am Icon.','Тема на форуме':'Forumsthema','Версия':'Version','4Pulse — твой личный пульс форума 4PDA. Компактный режим, динамичность и мгновенные уведомления.':'4Pulse — dein persönlicher Puls des 4PDA-Forums. Kompakter Modus, Dynamik und sofortige Benachrichtigungen.','Не обработан':'Nicht bearbeitet','Не обработан:':'Nicht bearbeitet:','В работе':'In Arbeit','В работе:':'In Arbeit:','Обработан':'Bearbeitet','Все':'Alle','Новая тема:':'Neues Thema:','В шапку темы':'In den Themenkopf','битая ссылка':'Defekter Link','Открыть':'Öffnen','Обработать':'Bearbeiten','Ответить':'Antworten','Прочитать все':'Alle gelesen','Открыть все':'Alle öffnen','Закреплённые':'Angeheftet','Добавить закладку':'Lesezeichen hinzufügen','Группировка по разделу':'Nach Bereich gruppieren','По названию А→Я':'Nach Titel A→Z','По дате':'Nach Datum','Расширение не может читать и изменять данные':'Die Erweiterung kann keine Daten lesen oder ändern','Управление расширением':'Erweiterung verwalten','Удалить расширение':'Erweiterung entfernen','Пожаловаться на расширение':'Erweiterung melden','Закрепить на панели инструментов':'An Symbolleiste anheften','Панель закладок':'Lesezeichen-Symbolleiste','4Pulse: обновить всё':'4Pulse: alles aktualisieren','Открыть QMS':'QMS öffnen','Открыть избранное':'Favoriten öffnen','Открыть упоминания':'Erwähnungen öffnen','Открыть тикеты':'Tickets öffnen','Настройки 4Pulse':'4Pulse-Einstellungen','Диагностика 4Pulse':'4Pulse-Diagnose','Локальные заметки и отложенные напоминания с привязкой к теме, QMS или Ticket.':'Lokale Notizen und verschobene Erinnerungen mit Bezug zu Thema, QMS oder Ticket.','Бефеле: note — neue Notiz, snooze — Erinnerung, tasks — Produktivitätspanel öffnen.':'Befehle: note — neue Notiz, snooze — Erinnerung, tasks — Produktivitätspanel öffnen.','Продолжить':'Fortfahren','Нет недавних тем':'Keine aktuellen Themen','Откройте тему на форуме':'Öffne ein Thema im Forum','Последний тикет':'Letztes Ticket','Нет данных по тикетам':'Keine Ticket-Daten','Откройте вкладку тикетов':'Öffne den Tickets-Tab','Открыть тикеты':'Tickets öffnen','Закреплённые рабочие темы':'Angeheftete Arbeitsthemen','Закрепляйте темы кнопкой 📌 в списке ниже':'Themen mit 📌 in der Liste unten anheften','Убрать':'Entfernen','Быстрый поиск: тема, раздел, автор...':'Schnellsuche: Thema, Bereich, Autor...','Быстрый поиск по навигации':'Schnellsuche in der Navigation','↻ Обновить':'↻ Aktualisieren','Обновить навигацию':'Navigation aktualisieren','▶ Последняя':'▶ Letzte','Открыть последнюю тему':'Letztes Thema öffnen','Открыть до 10 видимых тем':'Bis zu 10 sichtbare Themen öffnen','Вернуть скрытые темы':'Ausgeblendete Themen wiederherstellen','Обновить':'Aktualisieren','Настройки':'Einstellungen','Мои станции':'Meine Stationen','Встроенные':'Eingebaut','Показать скрытые':'Ausgeblendete anzeigen','💾 Резервная копия настроек':'💾 Einstellungssicherung','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Der Export speichert die Einstellungen als JSON-Datei. Der Import stellt sie aus einer Datei wieder her.','Скачать резервную копию':'Sicherungskopie herunterladen','Загрузить из файла':'Aus Datei laden','📖 Показывать вкладку «Навигация»':'📖 Tab „Navigation" anzeigen','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Zuletzt geöffnete Themen, Arbeitsthemen, letztes Ticket und Schnellsuche','Обновить данные':'Daten aktualisieren','Загрузка...':'Laden...','Нет сообщений':'Keine Nachrichten','Ошибка загрузки':'Ladefehler','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Sichere Vorschau nicht verfügbar: Keine direkte Beitrags-URL in den Favoriten.','Загрузка предпросмотра…':'Vorschau wird geladen…','Отправить':'Senden','＋ Добавить':'＋ Hinzufügen','📁 Папка':'📁 Ordner','Продолжить':'Fortfahren','Нет недавних тем':'Keine aktuellen Themen','Откройте тему на форуме':'Öffne ein Thema im Forum','Последний тикет':'Letztes Ticket','Нет данных по тикетам':'Keine Ticket-Daten','Откройте вкладку тикетов':'Öffne den Tickets-Tab','Открыть тикеты':'Tickets öffnen','Закреплённые рабочие темы':'Angeheftete Arbeitsthemen','Закрепляйте темы кнопкой 📌 в списке ниже':'Themen mit 📌 in der Liste unten anheften','Убрать':'Entfernen','Быстрый поиск: тема, раздел, автор...':'Schnellsuche: Thema, Bereich, Autor...','Быстрый поиск по навигации':'Schnellsuche in der Navigation','↻ Обновить':'↻ Aktualisieren','Обновить навигацию':'Navigation aktualisieren','▶ Последняя':'▶ Letzte','Открыть последнюю тему':'Letztes Thema öffnen','Открыть до 10 видимых тем':'Bis zu 10 sichtbare Themen öffnen','Вернуть скрытые темы':'Ausgeblendete Themen wiederherstellen','Обновить':'Aktualisieren','Настройки':'Einstellungen','Мои станции':'Meine Stationen','Встроенные':'Eingebaut','Показать скрытые':'Ausgeblendete anzeigen','💾 Резервная копия настроек':'💾 Einstellungssicherung','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Der Export speichert die Einstellungen als JSON-Datei. Der Import stellt sie aus einer Datei wieder her.','Скачать резервную копию':'Sicherungskopie herunterladen','Загрузить из файла':'Aus Datei laden','📖 Показывать вкладку «Навигация»':'📖 Tab „Navigation" anzeigen','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Zuletzt geöffnete Themen, Arbeitsthemen, letztes Ticket und Schnellsuche','Обновить данные':'Daten aktualisieren','Загрузка...':'Laden...','Нет сообщений':'Keine Nachrichten','Ошибка загрузки':'Ladefehler','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Sichere Vorschau nicht verfügbar: Keine direkte Beitrags-URL in den Favoriten.','Загрузка предпросмотра…':'Vorschau wird geladen…','Отправить':'Senden','＋ Добавить':'＋ Hinzufügen','📁 Папка':'📁 Ordner','Основное':'Hauptmenü','Продуктивность':'Produktivität','Сервис':'Dienste','Радио и тишина':'Radio & Ruhe','Личные сообщения · новых: ':'Privatnachrichten · neu: ','Избранные темы · новых: ':'Favoriten-Themen · neu: ','Упоминания и ответы · новых: ':'Erwähnungen & Antworten · neu: ','Модераторские тикеты · новых: ':'Moderator-Tickets · neu: ','Закладки в сайдбаре · записей: ':'Lesezeichen · Einträge: ','Закладки в попапе · записей: ':'Lesezeichen · Einträge: ','Заметки и отложенные напоминания':'Notizen und verschobene Erinnerungen','Временный DND-режим на полчаса':'Temporärer DND-Modus für eine halbe Stunde','Временный DND-режим на один час':'Temporärer DND-Modus für eine Stunde','Отключить временную умную тишину':'Temporäre Smart-Stille deaktivieren','QMS / темы / ответы / тикеты одной строкой':'QMS / Themen / Antworten / Tickets in einer Zeile','Быстро создать локальную заметку':'Schnell eine lokale Notiz erstellen','Создать локальное напоминание':'Lokale Erinnerung erstellen','Принудительно обновить QMS, темы, ответы и тикеты':'QMS, Themen, Antworten und Tickets erzwungen aktualisieren','Состояние WebSocket, polling, журнал и отчёт':'WebSocket-Status, Polling, Protokoll und Bericht','Открыть настройки 4Pulse':'4Pulse-Einstellungen öffnen','Сообщение...':'Nachricht...','Свернуть':'Einklappen','🔍 Поиск по имени или теме...':'🔍 Suche nach Name oder Thema...','Предпросмотр сообщения':'Nachrichtenvorschau','Навигация: недавно открытые, рабочие темы и быстрый поиск':'Navigation: zuletzt geöffnete Themen, Arbeitsthemen und Schnellsuche','Открыть тему с начала':'Thema vom Anfang öffnen','Скопировать ссылку':'Link kopieren','Скрыть из навигации 4Pulse':'Aus 4Pulse-Navigation ausblenden','Убрать из рабочих тем':'Aus Arbeitsthemen entfernen','Закрепить как рабочую тему':'Als Arbeitsthema anheften','Управление навигацией':'Navigation verwalten','Тема, акцент, шрифт и оформление':'Design, Akzent, Schrift und Aussehen','Быстро переключить радио, если станция выбрана':'Radio schnell umschalten, wenn eine Station ausgewählt ist','Скопировать короткий отчёт':'Kurzen Bericht kopieren','Продолжить':'Fortfahren','Нет недавних тем':'Keine aktuellen Themen','Откройте тему на форуме':'Öffne ein Thema im Forum','Последний тикет':'Letztes Ticket','Нет данных по тикетам':'Keine Ticket-Daten','Откройте вкладку тикетов':'Öffne den Tickets-Tab','Открыть тикеты':'Tickets öffnen','Закреплённые рабочие темы':'Angeheftete Arbeitsthemen','Закрепляйте темы кнопкой 📌 в списке ниже':'Themen mit 📌 in der Liste unten anheften','Убрать':'Entfernen','Быстрый поиск: тема, раздел, автор...':'Schnellsuche: Thema, Bereich, Autor...','Быстрый поиск по навигации':'Schnellsuche in der Navigation','↻ Обновить':'↻ Aktualisieren','Обновить навигацию':'Navigation aktualisieren','▶ Последняя':'▶ Letzte','Открыть последнюю тему':'Letztes Thema öffnen','Открыть до 10 видимых тем':'Bis zu 10 sichtbare Themen öffnen','Вернуть скрытые темы':'Ausgeblendete Themen wiederherstellen','Обновить':'Aktualisieren','Настройки':'Einstellungen','Мои станции':'Meine Stationen','Встроенные':'Eingebaut','Показать скрытые':'Ausgeblendete anzeigen','💾 Резервная копия настроек':'💾 Einstellungssicherung','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Der Export speichert die Einstellungen als JSON-Datei. Der Import stellt sie aus einer Datei wieder her.','Скачать резервную копию':'Sicherungskopie herunterladen','Загрузить из файла':'Aus Datei laden','📖 Показывать вкладку «Навигация»':'📖 Tab „Navigation" anzeigen','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Zuletzt geöffnete Themen, Arbeitsthemen, letztes Ticket und Schnellsuche','Обновить данные':'Daten aktualisieren','Загрузка...':'Laden...','Нет сообщений':'Keine Nachrichten','Ошибка загрузки':'Ladefehler','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Sichere Vorschau nicht verfügbar: Keine direkte Beitrags-URL in den Favoriten.','Загрузка предпросмотра…':'Vorschau wird geladen…','Отправить':'Senden','＋ Добавить':'＋ Hinzufügen','📁 Папка':'📁 Ordner','Основное':'Hauptmenü','Продуктивность':'Produktivität','Сервис':'Dienste','Радио и тишина':'Radio & Ruhe','Личные сообщения · новых: ':'Privatnachrichten · neu: ','Избранные темы · новых: ':'Favoriten-Themen · neu: ','Упоминания и ответы · новых: ':'Erwähnungen & Antworten · neu: ','Модераторские тикеты · новых: ':'Moderator-Tickets · neu: ','Закладки в сайдбаре · записей: ':'Lesezeichen · Einträge: ','Закладки в попапе · записей: ':'Lesezeichen · Einträge: ','Заметки и отложенные напоминания':'Notizen und verschobene Erinnerungen','Временный DND-режим на полчаса':'Temporärer DND-Modus für eine halbe Stunde','Временный DND-режим на один час':'Temporärer DND-Modus für eine Stunde','Отключить временную умную тишину':'Temporäre Smart-Stille deaktivieren','QMS / темы / ответы / тикеты одной строкой':'QMS / Themen / Antworten / Tickets in einer Zeile','Быстро создать локальную заметку':'Schnell eine lokale Notiz erstellen','Создать локальное напоминание':'Lokale Erinnerung erstellen','Принудительно обновить QMS, темы, ответы и тикеты':'QMS, Themen, Antworten und Tickets erzwungen aktualisieren','Состояние WebSocket, polling, журнал и отчёт':'WebSocket-Status, Polling, Protokoll und Bericht','Открыть настройки 4Pulse':'4Pulse-Einstellungen öffnen','Сообщение...':'Nachricht...','Свернуть':'Einklappen','🔍 Поиск по имени или теме...':'🔍 Suche nach Name oder Thema...','Предпросмотр сообщения':'Nachrichtenvorschau','Навигация: недавно открытые, рабочие темы и быстрый поиск':'Navigation: zuletzt geöffnete Themen, Arbeitsthemen und Schnellsuche','Открыть тему с начала':'Thema vom Anfang öffnen','Скопировать ссылку':'Link kopieren','Скрыть из навигации 4Pulse':'Aus 4Pulse-Navigation ausblenden','Убрать из рабочих тем':'Aus Arbeitsthemen entfernen','Закрепить как рабочую тему':'Als Arbeitsthema anheften','Управление навигацией':'Navigation verwalten','Тема, акцент, шрифт и оформление':'Design, Akzent, Schrift und Aussehen','Быстро переключить радио, если станция выбрана':'Radio schnell umschalten, wenn eine Station ausgewählt ist','Скопировать короткий отчёт':'Kurzen Bericht kopieren','Открыть ответы':'Antworten öffnen','Показать закладки':'Lesezeichen anzeigen','Открыть продуктивность':'Produktivität öffnen','Новая заметка':'Neue Notiz','Напомнить позже':'Später erinnern','Открыть диагностику':'Diagnose öffnen','Радио: play/pause':'Radio: Play/Pause','Тишина на 30 минут':'Stille für 30 Minuten','Тишина на 60 минут':'Stille für 60 Minuten','Выключить тишину':'Stille deaktivieren','Тема: светлая':'Design: Hell','Тема: тёмная':'Design: Dunkel','Тема: Liquid Glass':'Design: Liquid Glass','Тема: Cosmic Pulse':'Design: Cosmic Pulse','Тема':'Thema','Обычные события молчат, важное остаётся доступным':'Normale Ereignisse verstummen, Wichtiges bleibt zugänglich','Быстрый DND-режим на один час':'Schneller DND-Modus für eine Stunde','Переключить оформление на светлое':'Erscheinungsbild auf Hell umschalten','Переключить оформление на тёмное':'Erscheinungsbild auf Dunkel umschalten','Стеклянная тема':'Gläsernes Design','Космический стиль':'Kosmischer Stil','Закладки в popup · записей: ':'Lesezeichen · Einträge: ','Режим концентрации: следить за темой':'Fokusmodus: Thema beobachten','Снять приоритет':'Priorität aufheben','Тихий режим: заглушить уведомления':'Ruhemodus: Benachrichtigungen stummschalten','Включить уведомления':'Benachrichtigungen aktivieren','Добавить/управлять тегами':'Tags hinzufügen / verwalten','Отметить прочитанным':'Als gelesen markieren','Внешний вид':'Erscheinungsbild'
    },
    en: {
      'Компактная статистика':'Compact statistics','Превращает сетку плиток в узкую горизонтальную полосу — освобождает больше места для списка тем':'Turns the tile grid into a narrow horizontal strip — frees more space for the topic list','Компактна статистика':'Compact statistics','Плитки перестраиваются из сетки в горизонтальный ряд (иконка + цифра)':'Tiles are rearranged from a grid into a horizontal row (icon + number)','Свернуто (только статистика)':'Collapsed (statistics only)','Скрыть все списки — показывать только строку со счётчиками':'Hide all lists — show only the counter row','Показывать список тем':'Show topic list','Показывать список тем под строкой статистики':'Show the topic list under the statistics row','Скрыть плитку QMS':'Hide QMS tile','Не показывать счётчик QMS в строке статистики':'Do not show the QMS counter in the statistics row','Скрыть плитку «Избранные»':'Hide Favorites tile','Не показывать счётчик избранных тем в строке статистики':'Do not show the favorite topics counter in the statistics row','Скрыть плитку «Упоминания»':'Hide Mentions tile','Не показывать счётчик упоминаний в строке статистики':'Do not show the mentions counter in the statistics row','Показывать тулбар сортировки тем':'Show topic sorting toolbar','Кнопки сортировки, группировки и фильтрации по тегам над списком Избранных':'Sorting, grouping and tag-filter buttons above the Favorites list','Отключить анимацию новых тем':'Disable new-topic animation','Убирает мерцание и анимацию появления карточек тем — панель больше не мигает при обновлении':'Removes blinking and topic-card appearance animations — the panel no longer flashes on updates','Расположение плиток':'Tile layout','Перетащите плитки между рядами. До 5 плиток в ряду, незаполненный ряд растягивается автоматически':'Drag tiles between rows. Up to 5 tiles per row; an incomplete row stretches automatically','РЯД 1':'ROW 1','РЯД 2':'ROW 2','СКРЫТЫЕ':'HIDDEN','Скрытые':'Hidden','ПРИХОВАНІ':'HIDDEN','Сбросить':'Reset','Скинути':'Reset','Строк в списке тем':'Rows in topic list','Сколько тем показывать без прокрутки. 0 = без ограничения':'How many topics to show without scrolling. 0 = unlimited','Ширина окна':'Window width','Изменяет ширину попапа 4Pulse (320–600 px)':'Changes the 4Pulse popup width (320–600 px)','Экспорт / Импорт настроек':'Export / Import settings','Сохранить или восстановить все настройки 4Pulse':'Save or restore all 4Pulse settings','Экспорт':'Export','Импорт':'Import','Тикеты':'Tickets','Только для модераторов':'Moderators only','Мониторинг и обработка тикетов прямо из расширения':'Monitor and process tickets directly from the extension','Ticket-раздел активировать':'Enable ticket section','Добавляет вкладку „Tickets“ в Popup и показывает счётчик на иконке.':'Adds the Tickets tab to the popup and shows a counter on the icon.','Тема на форуме':'Forum topic','Версия':'Version','4Pulse — твой личный пульс форума 4PDA. Компактный режим, динамичность и мгновенные уведомления.':'4Pulse — your personal pulse of the 4PDA forum. Compact mode, dynamic behavior and instant notifications.','Не обработан':'Unprocessed','Не обработан:':'Unprocessed:','В работе':'In progress','В работе:':'In progress:','Обработан':'Processed','Все':'All','Новая тема:':'New topic:','В шапку темы':'To topic header','битая ссылка':'broken link','Открыть':'Open','Обработать':'Process','Ответить':'Reply','Прочитать все':'Mark all read','Открыть все':'Open all','Закреплённые':'Pinned','Добавить закладку':'Add bookmark','Группировка по разделу':'Group by section','По названию А→Я':'By title A→Z','По дате':'By date','Расширение не может читать и изменять данные':'The extension cannot read or change data','Управление расширением':'Manage extension','Удалить расширение':'Remove extension','Пожаловаться на расширение':'Report extension','Закрепить на панели инструментов':'Pin to toolbar','Панель закладок':'Bookmarks toolbar','4Pulse: обновить всё':'4Pulse: refresh everything','Открыть QMS':'Open QMS','Открыть избранное':'Open favorites','Открыть упоминания':'Open mentions','Открыть тикеты':'Open tickets','Настройки 4Pulse':'4Pulse settings','Диагностика 4Pulse':'4Pulse diagnostics','Продолжить':'Continue','Нет недавних тем':'No recent topics','Откройте тему на форуме':'Open a topic on the forum','Последний тикет':'Last ticket','Нет данных по тикетам':'No ticket data','Откройте вкладку тикетов':'Open the tickets tab','Открыть тикеты':'Open tickets','Закреплённые рабочие темы':'Pinned work topics','Закрепляйте темы кнопкой 📌 в списке ниже':'Pin topics using 📌 in the list below','Убрать':'Remove','Быстрый поиск: тема, раздел, автор...':'Quick search: topic, section, author...','Быстрый поиск по навигации':'Quick search in navigation','↻ Обновить':'↻ Refresh','Обновить навигацию':'Refresh navigation','▶ Последняя':'▶ Latest','Открыть последнюю тему':'Open last topic','Открыть до 10 видимых тем':'Open up to 10 visible topics','Вернуть скрытые темы':'Restore hidden topics','Обновить':'Refresh','Настройки':'Settings','Мои станции':'My stations','Встроенные':'Built-in','Показать скрытые':'Show hidden','💾 Резервная копия настроек':'💾 Settings backup','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Export saves settings to a JSON file on your computer. Import restores them from a file.','Скачать резервную копию':'Download backup','Загрузить из файла':'Load from file','📖 Показывать вкладку «Навигация»':'📖 Show Navigation tab','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Recently opened topics, work topics, last ticket and quick search','Обновить данные':'Refresh data','Загрузка...':'Loading...','Нет сообщений':'No messages','Ошибка загрузки':'Loading error','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Safe preview unavailable: no direct post URL in the favorites data.','Загрузка предпросмотра…':'Loading preview…','Отправить':'Send','＋ Добавить':'＋ Add','📁 Папка':'📁 Folder','Продолжить':'Continue','Нет недавних тем':'No recent topics','Откройте тему на форуме':'Open a topic on the forum','Последний тикет':'Last ticket','Нет данных по тикетам':'No ticket data','Откройте вкладку тикетов':'Open the tickets tab','Открыть тикеты':'Open tickets','Закреплённые рабочие темы':'Pinned work topics','Закрепляйте темы кнопкой 📌 в списке ниже':'Pin topics using 📌 in the list below','Убрать':'Remove','Быстрый поиск: тема, раздел, автор...':'Quick search: topic, section, author...','Быстрый поиск по навигации':'Quick search in navigation','↻ Обновить':'↻ Refresh','Обновить навигацию':'Refresh navigation','▶ Последняя':'▶ Latest','Открыть последнюю тему':'Open last topic','Открыть до 10 видимых тем':'Open up to 10 visible topics','Вернуть скрытые темы':'Restore hidden topics','Обновить':'Refresh','Настройки':'Settings','Мои станции':'My stations','Встроенные':'Built-in','Показать скрытые':'Show hidden','💾 Резервная копия настроек':'💾 Settings backup','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Export saves settings to a JSON file on your computer. Import restores them from a file.','Скачать резервную копию':'Download backup','Загрузить из файла':'Load from file','📖 Показывать вкладку «Навигация»':'📖 Show Navigation tab','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Recently opened topics, work topics, last ticket and quick search','Обновить данные':'Refresh data','Загрузка...':'Loading...','Нет сообщений':'No messages','Ошибка загрузки':'Loading error','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Safe preview unavailable: no direct post URL in the favorites data.','Загрузка предпросмотра…':'Loading preview…','Отправить':'Send','＋ Добавить':'＋ Add','📁 Папка':'📁 Folder','Основное':'Main','Продуктивность':'Productivity','Сервис':'Services','Радио и тишина':'Radio & Silence','Личные сообщения · новых: ':'Private messages · new: ','Избранные темы · новых: ':'Favorite topics · new: ','Упоминания и ответы · новых: ':'Mentions & replies · new: ','Модераторские тикеты · новых: ':'Moderator tickets · new: ','Закладки в сайдбаре · записей: ':'Bookmarks · entries: ','Закладки в попапе · записей: ':'Bookmarks · entries: ','Заметки и отложенные напоминания':'Notes and deferred reminders','Временный DND-режим на полчаса':'Temporary DND mode for 30 minutes','Временный DND-режим на один час':'Temporary DND mode for one hour','Отключить временную умную тишину':'Disable temporary smart silence','QMS / темы / ответы / тикеты одной строкой':'QMS / topics / replies / tickets in one line','Быстро создать локальную заметку':'Quickly create a local note','Создать локальное напоминание':'Create a local reminder','Принудительно обновить QMS, темы, ответы и тикеты':'Force update QMS, topics, replies and tickets','Состояние WebSocket, polling, журнал и отчёт':'WebSocket status, polling, log and report','Открыть настройки 4Pulse':'Open 4Pulse settings','Сообщение...':'Message...','Свернуть':'Collapse','🔍 Поиск по имени или теме...':'🔍 Search by name or topic...','Предпросмотр сообщения':'Message preview','Навигация: недавно открытые, рабочие темы и быстрый поиск':'Navigation: recently opened topics, work topics and quick search','Открыть тему с начала':'Open topic from start','Скопировать ссылку':'Copy link','Скрыть из навигации 4Pulse':'Hide from 4Pulse navigation','Убрать из рабочих тем':'Remove from work topics','Закрепить как рабочую тему':'Pin as work topic','Управление навигацией':'Manage navigation','Тема, акцент, шрифт и оформление':'Theme, accent, font and appearance','Быстро переключить радио, если станция выбрана':'Quickly toggle radio if a station is selected','Скопировать короткий отчёт':'Copy short report','Продолжить':'Continue','Нет недавних тем':'No recent topics','Откройте тему на форуме':'Open a topic on the forum','Последний тикет':'Last ticket','Нет данных по тикетам':'No ticket data','Откройте вкладку тикетов':'Open the tickets tab','Открыть тикеты':'Open tickets','Закреплённые рабочие темы':'Pinned work topics','Закрепляйте темы кнопкой 📌 в списке ниже':'Pin topics using 📌 in the list below','Убрать':'Remove','Быстрый поиск: тема, раздел, автор...':'Quick search: topic, section, author...','Быстрый поиск по навигации':'Quick search in navigation','↻ Обновить':'↻ Refresh','Обновить навигацию':'Refresh navigation','▶ Последняя':'▶ Latest','Открыть последнюю тему':'Open last topic','Открыть до 10 видимых тем':'Open up to 10 visible topics','Вернуть скрытые темы':'Restore hidden topics','Обновить':'Refresh','Настройки':'Settings','Мои станции':'My stations','Встроенные':'Built-in','Показать скрытые':'Show hidden','💾 Резервная копия настроек':'💾 Settings backup','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Export saves settings to a JSON file on your computer. Import restores them from a file.','Скачать резервную копию':'Download backup','Загрузить из файла':'Load from file','📖 Показывать вкладку «Навигация»':'📖 Show Navigation tab','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Recently opened topics, work topics, last ticket and quick search','Обновить данные':'Refresh data','Загрузка...':'Loading...','Нет сообщений':'No messages','Ошибка загрузки':'Loading error','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Safe preview unavailable: no direct post URL in the favorites data.','Загрузка предпросмотра…':'Loading preview…','Отправить':'Send','＋ Добавить':'＋ Add','📁 Папка':'📁 Folder','Основное':'Main','Продуктивность':'Productivity','Сервис':'Services','Радио и тишина':'Radio & Silence','Личные сообщения · новых: ':'Private messages · new: ','Избранные темы · новых: ':'Favorite topics · new: ','Упоминания и ответы · новых: ':'Mentions & replies · new: ','Модераторские тикеты · новых: ':'Moderator tickets · new: ','Закладки в сайдбаре · записей: ':'Bookmarks · entries: ','Закладки в попапе · записей: ':'Bookmarks · entries: ','Заметки и отложенные напоминания':'Notes and deferred reminders','Временный DND-режим на полчаса':'Temporary DND mode for 30 minutes','Временный DND-режим на один час':'Temporary DND mode for one hour','Отключить временную умную тишину':'Disable temporary smart silence','QMS / темы / ответы / тикеты одной строкой':'QMS / topics / replies / tickets in one line','Быстро создать локальную заметку':'Quickly create a local note','Создать локальное напоминание':'Create a local reminder','Принудительно обновить QMS, темы, ответы и тикеты':'Force update QMS, topics, replies and tickets','Состояние WebSocket, polling, журнал и отчёт':'WebSocket status, polling, log and report','Открыть настройки 4Pulse':'Open 4Pulse settings','Сообщение...':'Message...','Свернуть':'Collapse','🔍 Поиск по имени или теме...':'🔍 Search by name or topic...','Предпросмотр сообщения':'Message preview','Навигация: недавно открытые, рабочие темы и быстрый поиск':'Navigation: recently opened topics, work topics and quick search','Открыть тему с начала':'Open topic from start','Скопировать ссылку':'Copy link','Скрыть из навигации 4Pulse':'Hide from 4Pulse navigation','Убрать из рабочих тем':'Remove from work topics','Закрепить как рабочую тему':'Pin as work topic','Управление навигацией':'Manage navigation','Тема, акцент, шрифт и оформление':'Theme, accent, font and appearance','Быстро переключить радио, если станция выбрана':'Quickly toggle radio if a station is selected','Скопировать короткий отчёт':'Copy short report','Открыть ответы':'Open replies','Показать закладки':'Show bookmarks','Открыть продуктивность':'Open productivity','Новая заметка':'New note','Напомнить позже':'Remind later','Открыть диагностику':'Open diagnostics','Радио: play/pause':'Radio: play/pause','Тишина на 30 минут':'Silence for 30 minutes','Тишина на 60 минут':'Silence for 60 minutes','Выключить тишину':'Disable silence','Тема: светлая':'Theme: Light','Тема: тёмная':'Theme: Dark','Тема: Liquid Glass':'Theme: Liquid Glass','Тема: Cosmic Pulse':'Theme: Cosmic Pulse','Обычные события молчат, важное остаётся доступным':'Normal events are silenced, important ones remain accessible','Быстрый DND-режим на один час':'Quick DND mode for one hour','Переключить оформление на светлое':'Switch appearance to light','Переключить оформление на тёмное':'Switch appearance to dark','Стеклянная тема':'Glass theme','Космический стиль':'Cosmic style','Закладки в popup · записей: ':'Bookmarks · entries: ','Режим концентрации: следить за темой':'Focus mode: watch this topic','Снять приоритет':'Remove priority','Тихий режим: заглушить уведомления':'Quiet mode: mute notifications','Включить уведомления':'Enable notifications','Добавить/управлять тегами':'Add/manage tags','Отметить прочитанным':'Mark as read','Внешний вид':'Appearance'
    },
    uk: {
      'Компактная статистика':'Компактна статистика','Превращает сетку плиток в узкую горизонтальную полосу — освобождает больше места для списка тем':'Перетворює сітку плиток на вузьку горизонтальну смугу — звільняє більше місця для списку тем','Плитки перестраиваются из сетки в горизонтальный ряд (иконка + цифра)':'Плитки перебудовуються із сітки в горизонтальний ряд (іконка + число)','Свернуто (только статистика)':'Згорнуто (тільки статистика)','Скрыть все списки — показывать только строку со счётчиками':'Приховати всі списки — показувати лише рядок із лічильниками','Показывать список тем':'Показувати список тем','Показывать список тем под строкой статистики':'Показувати список тем під рядком статистики','Скрыть плитку QMS':'Приховати плитку QMS','Не показывать счётчик QMS в строке статистики':'Не показувати лічильник QMS у рядку статистики','Скрыть плитку «Избранные»':'Приховати плитку «Обране»','Не показывать счётчик избранных тем в строке статистики':'Не показувати лічильник обраних тем у рядку статистики','Скрыть плитку «Упоминания»':'Приховати плитку «Згадки»','Не показывать счётчик упоминаний в строке статистики':'Не показувати лічильник згадок у рядку статистики','Показывать тулбар сортировки тем':'Показувати панель сортування тем','Кнопки сортировки, группировки и фильтрации по тегам над списком Избранных':'Кнопки сортування, групування й фільтрації за тегами над списком Обраного','Отключить анимацию новых тем':'Вимкнути анімацію нових тем','Убирает мерцание и анимацию появления карточек тем — панель больше не мигает при обновлении':'Прибирає мерехтіння й анімацію появи карток тем — панель більше не блимає під час оновлення','Расположение плиток':'Розташування плиток','Перетащите плитки между рядами. До 5 плиток в ряду, незаполненный ряд растягивается автоматически':'Перетягуйте плитки між рядами. До 5 плиток у ряду, незаповнений ряд розтягується автоматично','РЯД 1':'РЯД 1','РЯД 2':'РЯД 2','СКРЫТЫЕ':'ПРИХОВАНІ','Скрытые':'Приховані','Сбросить':'Скинути','Строк в списке тем':'Рядків у списку тем','Сколько тем показывать без прокрутки. 0 = без ограничения':'Скільки тем показувати без прокручування. 0 = без обмеження','Ширина окна':'Ширина вікна','Изменяет ширину попапа 4Pulse (320–600 px)':'Змінює ширину попапа 4Pulse (320–600 px)','Экспорт / Импорт настроек':'Експорт / Імпорт налаштувань','Сохранить или восстановить все настройки 4Pulse':'Зберегти або відновити всі налаштування 4Pulse','Экспорт':'Експорт','Импорт':'Імпорт','Тикеты':'Тікети','Только для модераторов':'Тільки для модераторів','Мониторинг и обработка тикетов прямо из расширения':'Моніторинг і обробка тікетів прямо з розширення','Ticket-раздел активировать':'Активувати розділ тікетів','Добавляет вкладку „Tickets“ в Popup и показывает счётчик на иконке.':'Додає вкладку «Тікети» в Popup і показує лічильник на іконці.','Тема на форуме':'Тема на форумі','Версия':'Версія','4Pulse — твой личный пульс форума 4PDA. Компактный режим, динамичность и мгновенные уведомления.':'4Pulse — твій особистий пульс форуму 4PDA. Компактний режим, динаміка та миттєві сповіщення.','Не обработан':'Не оброблено','Не обработан:':'Не оброблено:','В работе':'У роботі','В работе:':'У роботі:','Обработан':'Оброблено','Все':'Усі','Новая тема:':'Нова тема:','В шапку темы':'У шапку теми','битая ссылка':'бите посилання','Открыть':'Відкрити','Обработать':'Обробити','Ответить':'Відповісти','Прочитать все':'Прочитати всі','Открыть все':'Відкрити всі','Закреплённые':'Закріплені','Добавить закладку':'Додати закладку','Группировка по разделу':'Групування за розділом','По названию А→Я':'За назвою А→Я','По дате':'За датою','Расширение не может читать и изменять данные':'Розширення не може читати й змінювати дані','Управление расширением':'Керування розширенням','Удалить расширение':'Видалити розширення','Пожаловаться на расширение':'Поскаржитися на розширення','Закрепить на панели инструментов':'Закріпити на панелі інструментів','Панель закладок':'Панель закладок','4Pulse: обновить всё':'4Pulse: оновити все','Открыть QMS':'Відкрити QMS','Открыть избранное':'Відкрити обране','Открыть упоминания':'Відкрити згадки','Открыть тикеты':'Відкрити тікети','Настройки 4Pulse':'Налаштування 4Pulse','Диагностика 4Pulse':'Діагностика 4Pulse','Продолжить':'Продовжити','Нет недавних тем':'Немає нещодавніх тем','Откройте тему на форуме':'Відкрийте тему на форумі','Последний тикет':'Останній тікет','Нет данных по тикетам':'Немає даних по тікетах','Откройте вкладку тикетов':'Відкрийте вкладку тікетів','Открыть тикеты':'Відкрити тікети','Закреплённые рабочие темы':'Закріплені робочі теми','Закрепляйте темы кнопкой 📌 в списке ниже':'Закріпляйте теми кнопкою 📌 у списку нижче','Убрать':'Прибрати','Быстрый поиск: тема, раздел, автор...':'Швидкий пошук: тема, розділ, автор...','Быстрый поиск по навигации':'Швидкий пошук у навігації','↻ Обновить':'↻ Оновити','Обновить навигацию':'Оновити навігацію','▶ Последняя':'▶ Остання','Открыть последнюю тему':'Відкрити останню тему','Открыть до 10 видимых тем':'Відкрити до 10 видимих тем','Вернуть скрытые темы':'Відновити приховані теми','Обновить':'Оновити','Настройки':'Налаштування','Мои станции':'Мої станції','Встроенные':'Вбудовані','Показать скрытые':'Показати приховані','💾 Резервная копия настроек':'💾 Резервна копія налаштувань','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Експорт зберігає налаштування у JSON-файл на вашому комп\'ютері. Імпорт відновлює їх із файлу.','Скачать резервную копию':'Завантажити резервну копію','Загрузить из файла':'Завантажити з файлу','📖 Показывать вкладку «Навигация»':'📖 Показувати вкладку «Навігація»','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Нещодавно відкриті, робочі теми, останній тікет та швидкий пошук','Обновить данные':'Оновити дані','Загрузка...':'Завантаження...','Нет сообщений':'Немає повідомлень','Ошибка загрузки':'Помилка завантаження','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Безпечний попередній перегляд недоступний: у даних вибраного немає прямого посилання на пост.','Загрузка предпросмотра…':'Завантаження попереднього перегляду…','Отправить':'Надіслати','＋ Добавить':'＋ Додати','📁 Папка':'📁 Папка','Продолжить':'Продовжити','Нет недавних тем':'Немає нещодавніх тем','Откройте тему на форуме':'Відкрийте тему на форумі','Последний тикет':'Останній тікет','Нет данных по тикетам':'Немає даних по тікетах','Откройте вкладку тикетов':'Відкрийте вкладку тікетів','Открыть тикеты':'Відкрити тікети','Закреплённые рабочие темы':'Закріплені робочі теми','Закрепляйте темы кнопкой 📌 в списке ниже':'Закріпляйте теми кнопкою 📌 у списку нижче','Убрать':'Прибрати','Быстрый поиск: тема, раздел, автор...':'Швидкий пошук: тема, розділ, автор...','Быстрый поиск по навигации':'Швидкий пошук у навігації','↻ Обновить':'↻ Оновити','Обновить навигацию':'Оновити навігацію','▶ Последняя':'▶ Остання','Открыть последнюю тему':'Відкрити останню тему','Открыть до 10 видимых тем':'Відкрити до 10 видимих тем','Вернуть скрытые темы':'Відновити приховані теми','Обновить':'Оновити','Настройки':'Налаштування','Мои станции':'Мої станції','Встроенные':'Вбудовані','Показать скрытые':'Показати приховані','💾 Резервная копия настроек':'💾 Резервна копія налаштувань','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Експорт зберігає налаштування у JSON-файл на вашому комп\'ютері. Імпорт відновлює їх із файлу.','Скачать резервную копию':'Завантажити резервну копію','Загрузить из файла':'Завантажити з файлу','📖 Показывать вкладку «Навигация»':'📖 Показувати вкладку «Навігація»','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Нещодавно відкриті, робочі теми, останній тікет та швидкий пошук','Обновить данные':'Оновити дані','Загрузка...':'Завантаження...','Нет сообщений':'Немає повідомлень','Ошибка загрузки':'Помилка завантаження','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Безпечний попередній перегляд недоступний: у даних вибраного немає прямого посилання на пост.','Загрузка предпросмотра…':'Завантаження попереднього перегляду…','Отправить':'Надіслати','＋ Добавить':'＋ Додати','📁 Папка':'📁 Папка','Основное':'Основне','Продуктивность':'Продуктивність','Сервис':'Сервіс','Радио и тишина':'Радіо і тиша','Личные сообщения · новых: ':'Особисті повідомлення · нових: ','Избранные темы · новых: ':'Обрані теми · нових: ','Упоминания и ответы · новых: ':'Згадки та відповіді · нових: ','Модераторские тикеты · новых: ':'Модераторські тікети · нових: ','Закладки в сайдбаре · записей: ':'Закладки · записів: ','Закладки в попапе · записей: ':'Закладки · записів: ','Заметки и отложенные напоминания':'Нотатки та відкладені нагадування','Временный DND-режим на полчаса':'Тимчасовий DND-режим на пів години','Временный DND-режим на один час':'Тимчасовий DND-режим на одну годину','Отключить временную умную тишину':'Вимкнути тимчасову розумну тишу','QMS / темы / ответы / тикеты одной строкой':'QMS / теми / відповіді / тікети одним рядком','Быстро создать локальную заметку':'Швидко створити локальну нотатку','Создать локальное напоминание':'Створити локальне нагадування','Принудительно обновить QMS, темы, ответы и тикеты':'Примусово оновити QMS, теми, відповіді та тікети','Состояние WebSocket, polling, журнал и отчёт':'Стан WebSocket, polling, журнал та звіт','Открыть настройки 4Pulse':'Відкрити налаштування 4Pulse','Сообщение...':'Повідомлення...','Свернуть':'Згорнути','🔍 Поиск по имени или теме...':'🔍 Пошук за іменем або темою...','Предпросмотр сообщения':'Попередній перегляд повідомлення','Навигация: недавно открытые, рабочие темы и быстрый поиск':'Навігація: нещодавно відкриті теми, робочі теми та швидкий пошук','Открыть тему с начала':'Відкрити тему з початку','Скопировать ссылку':'Скопіювати посилання','Скрыть из навигации 4Pulse':'Приховати з навігації 4Pulse','Убрать из рабочих тем':'Прибрати з робочих тем','Закрепить как рабочую тему':'Закріпити як робочу тему','Управление навигацией':'Керування навігацією','Тема, акцент, шрифт и оформление':'Тема, акцент, шрифт та оформлення','Быстро переключить радио, если станция выбрана':'Швидко перемкнути радіо, якщо станцію вибрано','Скопировать короткий отчёт':'Скопіювати короткий звіт','Продолжить':'Продовжити','Нет недавних тем':'Немає нещодавніх тем','Откройте тему на форуме':'Відкрийте тему на форумі','Последний тикет':'Останній тікет','Нет данных по тикетам':'Немає даних по тікетах','Откройте вкладку тикетов':'Відкрийте вкладку тікетів','Открыть тикеты':'Відкрити тікети','Закреплённые рабочие темы':'Закріплені робочі теми','Закрепляйте темы кнопкой 📌 в списке ниже':'Закріпляйте теми кнопкою 📌 у списку нижче','Убрать':'Прибрати','Быстрый поиск: тема, раздел, автор...':'Швидкий пошук: тема, розділ, автор...','Быстрый поиск по навигации':'Швидкий пошук у навігації','↻ Обновить':'↻ Оновити','Обновить навигацию':'Оновити навігацію','▶ Последняя':'▶ Остання','Открыть последнюю тему':'Відкрити останню тему','Открыть до 10 видимых тем':'Відкрити до 10 видимих тем','Вернуть скрытые темы':'Відновити приховані теми','Обновить':'Оновити','Настройки':'Налаштування','Мои станции':'Мої станції','Встроенные':'Вбудовані','Показать скрытые':'Показати приховані','💾 Резервная копия настроек':'💾 Резервна копія налаштувань','Экспорт сохраняет настройки в JSON-файл на ваш компьютер. Импорт восстанавливает их из файла.':'Експорт зберігає налаштування у JSON-файл на вашому комп\'ютері. Імпорт відновлює їх із файлу.','Скачать резервную копию':'Завантажити резервну копію','Загрузить из файла':'Завантажити з файлу','📖 Показывать вкладку «Навигация»':'📖 Показувати вкладку «Навігація»','Недавно открытые, рабочие темы, последний тикет и быстрый поиск':'Нещодавно відкриті, робочі теми, останній тікет та швидкий пошук','Обновить данные':'Оновити дані','Загрузка...':'Завантаження...','Нет сообщений':'Немає повідомлень','Ошибка загрузки':'Помилка завантаження','Безопасный предпросмотр недоступен: в данных избранного нет прямой ссылки на пост.':'Безпечний попередній перегляд недоступний: у даних вибраного немає прямого посилання на пост.','Загрузка предпросмотра…':'Завантаження попереднього перегляду…','Отправить':'Надіслати','＋ Добавить':'＋ Додати','📁 Папка':'📁 Папка','Основное':'Основне','Продуктивность':'Продуктивність','Сервис':'Сервіс','Радио и тишина':'Радіо і тиша','Личные сообщения · новых: ':'Особисті повідомлення · нових: ','Избранные темы · новых: ':'Обрані теми · нових: ','Упоминания и ответы · новых: ':'Згадки та відповіді · нових: ','Модераторские тикеты · новых: ':'Модераторські тікети · нових: ','Закладки в сайдбаре · записей: ':'Закладки · записів: ','Закладки в попапе · записей: ':'Закладки · записів: ','Заметки и отложенные напоминания':'Нотатки та відкладені нагадування','Временный DND-режим на полчаса':'Тимчасовий DND-режим на пів години','Временный DND-режим на один час':'Тимчасовий DND-режим на одну годину','Отключить временную умную тишину':'Вимкнути тимчасову розумну тишу','QMS / темы / ответы / тикеты одной строкой':'QMS / теми / відповіді / тікети одним рядком','Быстро создать локальную заметку':'Швидко створити локальну нотатку','Создать локальное напоминание':'Створити локальне нагадування','Принудительно обновить QMS, темы, ответы и тикеты':'Примусово оновити QMS, теми, відповіді та тікети','Состояние WebSocket, polling, журнал и отчёт':'Стан WebSocket, polling, журнал та звіт','Открыть настройки 4Pulse':'Відкрити налаштування 4Pulse','Сообщение...':'Повідомлення...','Свернуть':'Згорнути','🔍 Поиск по имени или теме...':'🔍 Пошук за іменем або темою...','Предпросмотр сообщения':'Попередній перегляд повідомлення','Навигация: недавно открытые, рабочие темы и быстрый поиск':'Навігація: нещодавно відкриті теми, робочі теми та швидкий пошук','Открыть тему с начала':'Відкрити тему з початку','Скопировать ссылку':'Скопіювати посилання','Скрыть из навигации 4Pulse':'Приховати з навігації 4Pulse','Убрать из рабочих тем':'Прибрати з робочих тем','Закрепить как рабочую тему':'Закріпити як робочу тему','Управление навигацией':'Керування навігацією','Тема, акцент, шрифт и оформление':'Тема, акцент, шрифт та оформлення','Быстро переключить радио, если станция выбрана':'Швидко перемкнути радіо, якщо станцію вибрано','Скопировать короткий отчёт':'Скопіювати короткий звіт','Открыть ответы':'Відкрити відповіді','Показать закладки':'Показати закладки','Открыть продуктивность':'Відкрити продуктивність','Новая заметка':'Нова нотатка','Напомнить позже':'Нагадати пізніше','Открыть диагностику':'Відкрити діагностику','Радио: play/pause':'Радіо: play/pause','Тишина на 30 минут':'Тиша на 30 хвилин','Тишина на 60 минут':'Тиша на 60 хвилин','Выключить тишину':'Вимкнути тишу','Тема: светлая':'Тема: Світла','Тема: тёмная':'Тема: Темна','Тема: Liquid Glass':'Тема: Liquid Glass','Тема: Cosmic Pulse':'Тема: Cosmic Pulse','Обычные события молчат, важное остаётся доступным':'Звичайні події мовчать, важливе залишається доступним','Быстрый DND-режим на один час':'Швидкий DND-режим на одну годину','Переключить оформление на светлое':'Переключити оформлення на світле','Переключить оформление на тёмное':'Переключити оформлення на темне','Стеклянная тема':'Скляна тема','Космический стиль':'Космічний стиль','Закладки в popup · записей: ':'Закладки · записів: ','Режим концентрації: стежити за темою':'Режим концентрації: стежити за темою','Режим концентрации: следить за темой':'Режим концентрації: стежити за темою','Снять приоритет':'Зняти пріоритет','Тихий режим: заглушить уведомления':'Тихий режим: заглушити сповіщення','Включить уведомления':'Увімкнути сповіщення','Добавить/управлять тегами':'Додати / керувати тегами','Отметить прочитанным':'Позначити прочитаним','Внешний вид':'Зовнішній вигляд'
    }
  };
  function getLang(cb){ cb(_cachedLang); }
  function repl(s, dict){if(!s||typeof s!=='string')return s;let out=s;Object.keys(dict).sort((a,b)=>b.length-a.length).forEach(k=>{if(out.includes(k))out=out.split(k).join(dict[k]);});return out;}
  function apply(){getLang(lang=>{lang=(lang||'ru').toLowerCase().slice(0,2); if(lang==='ru')return; const dict=MAP[lang]||MAP.en; const root=document.body||document.documentElement; if(!root)return; const skip=new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','PATH','USE']); const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode(n){const p=n.parentElement;if(!p||skip.has(p.tagName))return NodeFilter.FILTER_REJECT;return /[А-Яа-яЁё]/.test(n.nodeValue||'')?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP;}}); const nodes=[]; while(walker.nextNode())nodes.push(walker.currentNode); nodes.forEach(n=>{const v=repl(n.nodeValue,dict); if(v!==n.nodeValue)n.nodeValue=v;}); document.querySelectorAll('*').forEach(el=>{['title','placeholder','aria-label','data-tooltip','data-title'].forEach(a=>{if(el.hasAttribute&&el.hasAttribute(a)){const old=el.getAttribute(a); const v=repl(old,dict); if(v!==old)el.setAttribute(a,v);}});});});}
  document.addEventListener('DOMContentLoaded',()=>{apply();[100,500,1500,3500,7000].forEach(t=>setTimeout(apply,t));}); if(document.readyState!=='loading'){apply();[100,500,1500].forEach(t=>setTimeout(apply,t));}
  try{new MutationObserver(()=>{clearTimeout(window.__4pulseHardI18nResidueTimer);window.__4pulseHardI18nResidueTimer=setTimeout(apply,25);}).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','placeholder','aria-label','data-tooltip','data-title']});}catch(e){}
  try{chrome.storage.onChanged.addListener((ch,area)=>{if(area==='local'&&ch.ui_language)setTimeout(apply,30);});}catch(e){}
})();


// ── 4Pulse 1.8.13: hard sidebar router/sync patch ─────────────────────────────
// The Firefox sidebar is long-lived and can keep stale state after tile layout/icon-pack
// changes. This router makes sidebar tiles behave exactly as local workspace buttons:
// normal click always opens the internal section; Shift/Ctrl/Cmd click opens the forum.
(function sidebarHardSyncPatch(){
  const TYPE_TO_URL = {
    qms: 'qms', favorites: 'favorites', mentions: 'mentions', tickets: 'ticket', bookmarks: 'bookmarks', history: 'history'
  };
  const LIST_BY_TYPE = {
    favorites: 'topicsList', qms: 'qmsList', mentions: 'mentionsList', tickets: 'ticketsList', bookmarks: 'bookmarksList', history: 'historyList'
  };
  let __sidebarOpenSeq = 0;

  function _allLists(){
    return [elements?.topicsList, elements?.qmsList, elements?.mentionsList, elements?.ticketsList, elements?.bookmarksList, elements?.historyList].filter(Boolean);
  }
  function _hideAllLists(){ _allLists().forEach(el => hideElement(el)); }
  function _activeTile(type){
    [elements?.statQms, elements?.statFavorites, elements?.statMentions, elements?.statTickets, elements?.statBookmarks, elements?.statHistory]
      .filter(Boolean).forEach(el => el.classList.remove(CLASS_ACTIVE));
    const map = { qms: elements?.statQms, favorites: elements?.statFavorites, mentions: elements?.statMentions, tickets: elements?.statTickets, bookmarks: elements?.statBookmarks, history: elements?.statHistory };
    map[type]?.classList.add(CLASS_ACTIVE);
  }
  function _applyFreshSettings(fresh){
    if (!fresh?.settings) return;
    settings.show_all_favorites = fresh.settings.show_all_favorites || false;
    settings.show_all_qms       = fresh.settings.show_all_qms || false;
    settings.show_all_mentions  = fresh.settings.show_all_mentions || false;
    settings.show_bookmarks_tab = fresh.settings.show_bookmarks_tab || false;
    settings.show_history_tab   = fresh.settings.show_history_tab || false;
    settings.icon_pack          = fresh.settings.icon_pack || settings.icon_pack || 'default';
    settings.bw_icons           = !!fresh.settings.bw_icons;
    settings.accent_color       = fresh.settings.accent_color || settings.accent_color || 'blue';
    document.body.classList.toggle('bw-icons', !!settings.bw_icons);
    document.body.setAttribute('data-accent', settings.accent_color);
  }
  function _renderSection(type){
    if (!currentData) return false;
    try {
      if (type === 'favorites') renderTopics(currentData.favorites || { list: [], count: 0 });
      else if (type === 'qms') renderQMS(currentData.qms || { list: [], count: 0 });
      else if (type === 'mentions') renderMentions(currentData.mentions || { list: [], count: 0 });
      else if (type === 'tickets') renderTickets(currentData.tickets?.list || []);
      else if (type === 'bookmarks') renderBookmarks(currentData.bookmarks?.list || []);
      else if (type === 'history') renderHistory(currentData.history?.list || []);
      return true;
    } catch (e) {
      console.warn('[Sidebar] hard render failed:', type, e);
      return false;
    }
  }
  function _showRenderedSection(type){
    showLoading(false);
    showEmptyState(false);
    showElement(elements?.main);
    _hideAllLists();
    if (type === 'bookmarks' || type === 'history') hideElement(elements?.themeActions);
    else showElement(elements?.themeActions);
    const key = LIST_BY_TYPE[type];
    const target = key && elements?.[key];
    if (target) {
      target.style.removeProperty('display');
      showElement(target);
    }
    currentFilter = type;
    _activeTile(type);
    updateStats(currentData);
    applyGlobalIconPack?.();
    requestAnimationFrame(() => {
      showLoading(false);
      if (target) showElement(target);
      applyGlobalIconPack?.();
    });
  }
  async function openSidebarLocalSection(type, opts = {}) {
    if (!type || type === 'radio') return;
    const seq = ++__sidebarOpenSeq;
    showLoading(false);
    // First paint immediately from currentData so the sidebar never looks dead.
    _renderSection(type);
    _showRenderedSection(type);
    try {
      const fresh = await sendMessage({ action: 'popup_loaded' });
      if (seq !== __sidebarOpenSeq) return;
      if (fresh) {
        currentData = fresh;
        _applyFreshSettings(fresh);
        applySidebarBookmarksVisibility?.(settings.show_bookmarks_tab);
        applySidebarHistoryVisibility?.(settings.show_history_tab);
        updateStats(currentData);
      }
      _renderSection(type);
      _showRenderedSection(type);
      // If we only have a counter but no list yet, run one force refresh and repaint.
      const emptyList = type === 'favorites' ? !(currentData?.favorites?.list || []).length && (currentData?.favorites?.count || 0) > 0
        : type === 'qms' ? !(currentData?.qms?.list || []).length && (currentData?.qms?.count || 0) > 0
        : type === 'mentions' ? !(currentData?.mentions?.list || []).length && (currentData?.mentions?.count || 0) > 0
        : type === 'tickets' ? !(currentData?.tickets?.list || []).length && (currentData?.tickets?.count || 0) > 0
        : false;
      if (emptyList && !opts.noRefresh) {
        await refreshData().catch(() => {});
        if (seq === __sidebarOpenSeq) { _renderSection(type); _showRenderedSection(type); }
      }
    } catch (e) {
      console.warn('[Sidebar] hard section sync failed:', type, e);
      _renderSection(type);
      _showRenderedSection(type);
    }
  }

  // Replace the old toggle semantics: repeated click must keep/open the local section,
  // not collapse it into an empty panel.
  try {
    toggleFilter = function(type) { openSidebarLocalSection(type); };
  } catch (_) {}

  document.addEventListener('click', function(e){
    const card = e.target?.closest?.('.stat-card[data-type]');
    if (!card || card.id === 'stat-radio-inline') return;
    const type = card.dataset.type;
    if (!type || type === 'radio') return;
    if (e.target.closest('button,input,textarea,select,a')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.shiftKey || e.ctrlKey || e.metaKey) openTab(TYPE_TO_URL[type] || type);
    else openSidebarLocalSection(type);
  }, true);

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      const type = currentFilter || settings?.default_view || 'favorites';
      if (type && type !== 'collapsed') openSidebarLocalSection(type, { noRefresh: true });
      applyGlobalIconPack?.();
    }, 250);
    setTimeout(() => applyGlobalIconPack?.(), 900);
  });
})();


// ── 4Pulse 1.8.14: final sidebar click/layout hardener ───────────────────────
// Firefox Sidebar can swallow/collapse normal click events after drag/drop layout
// changes. Use pointerup in capture phase as the primary sidebar router and repaint
// the selected local section explicitly, without relying on old toggle semantics.
(function sidebarFinalHardener(){
  const TYPE_TO_URL = { qms:'qms', favorites:'favorites', mentions:'mentions', tickets:'ticket', bookmarks:'bookmarks', history:'history' };
  const LIST_BY_TYPE = { favorites:'topicsList', qms:'qmsList', mentions:'mentionsList', tickets:'ticketsList', bookmarks:'bookmarksList', history:'historyList' };
  let seq = 0;
  let lastPointerAt = 0;

  function allLists(){
    return [elements?.topicsList, elements?.qmsList, elements?.mentionsList, elements?.ticketsList, elements?.bookmarksList, elements?.historyList].filter(Boolean);
  }
  function hardHide(el){ if (!el) return; el.classList.add(CLASS_HIDDEN); el.style.display = 'none'; }
  function hardShow(el){ if (!el) return; el.classList.remove(CLASS_HIDDEN); el.style.display = ''; }
  function clearLists(){ allLists().forEach(hardHide); }
  function setActive(type){
    const map = { qms:elements?.statQms, favorites:elements?.statFavorites, mentions:elements?.statMentions, tickets:elements?.statTickets, bookmarks:elements?.statBookmarks, history:elements?.statHistory };
    Object.values(map).filter(Boolean).forEach(el => el.classList.remove(CLASS_ACTIVE));
    map[type]?.classList.add(CLASS_ACTIVE);
  }
  function applyFreshSettings(fresh){
    if (!fresh?.settings) return;
    const st = fresh.settings;
    settings.show_all_favorites = !!st.show_all_favorites;
    settings.show_all_qms = !!st.show_all_qms;
    settings.show_all_mentions = !!st.show_all_mentions;
    settings.show_bookmarks_tab = !!st.show_bookmarks_tab;
    settings.show_history_tab = !!st.show_history_tab;
    settings.icon_pack = st.icon_pack || settings.icon_pack || 'default';
    settings.bw_icons = !!st.bw_icons;
    settings.accent_color = st.accent_color || settings.accent_color || 'blue';
    settings.compact_stats = !!st.compact_stats;
    document.body.classList.toggle('bw-icons', !!settings.bw_icons);
    document.body.classList.toggle('compact-stats-mode', !!settings.compact_stats);
    document.body.setAttribute('data-accent', settings.accent_color);
  }
  function renderLocal(type){
    if (!currentData) return;
    if (type === 'favorites') renderTopics(currentData.favorites || {list:[], count:0});
    else if (type === 'qms') renderQMS(currentData.qms || {list:[], count:0});
    else if (type === 'mentions') renderMentions(currentData.mentions || {list:[], count:0});
    else if (type === 'tickets') renderTickets(currentData.tickets?.list || []);
    else if (type === 'bookmarks') renderBookmarks(currentData.bookmarks?.list || []);
    else if (type === 'history') renderHistory(currentData.history?.list || []);
  }
  function showLocal(type){
    currentFilter = type;
    showLoading(false);
    showEmptyState(false);
    hardShow(elements?.main);
    clearLists();
    if (type === 'bookmarks' || type === 'history') hardHide(elements?.themeActions);
    else hardShow(elements?.themeActions);
    const target = elements?.[LIST_BY_TYPE[type]];
    hardShow(target);
    setActive(type);
    if (currentData) updateStats(currentData);
    requestAnimationFrame(() => {
      showLoading(false);
      hardShow(target);
      setActive(type);
      applyGlobalIconPack?.();
    });
  }
  function hasEmptyImportantList(type){
    if (!currentData) return false;
    if (type === 'tickets') return (currentData.tickets?.count || 0) > 0 && !(currentData.tickets?.list || []).length;
    if (type === 'favorites') return (currentData.favorites?.count || 0) > 0 && !(currentData.favorites?.list || []).length;
    if (type === 'qms') return (currentData.qms?.count || 0) > 0 && !(currentData.qms?.list || []).length;
    if (type === 'mentions') return (currentData.mentions?.count || 0) > 0 && !(currentData.mentions?.list || []).length;
    return false;
  }
  async function hardOpen(type, opts={}){
    if (!type || type === 'radio') return;
    const my = ++seq;
    try {
      renderLocal(type);
      showLocal(type);
      const fresh = await sendMessage({ action:'popup_loaded' }).catch(() => null);
      if (my !== seq) return;
      if (fresh) {
        currentData = fresh;
        applyFreshSettings(fresh);
        applySidebarBookmarksVisibility?.(settings.show_bookmarks_tab);
        applySidebarHistoryVisibility?.(settings.show_history_tab);
        updateStats(currentData);
      }
      renderLocal(type);
      showLocal(type);
      if (!opts.noRefresh && hasEmptyImportantList(type)) {
        await sendMessage({ action:'force_update' }).catch(() => null);
        const fresh2 = await sendMessage({ action:'popup_loaded' }).catch(() => null);
        if (my !== seq) return;
        if (fresh2) { currentData = fresh2; applyFreshSettings(fresh2); updateStats(currentData); }
        renderLocal(type);
        showLocal(type);
      }
    } catch (e) {
      console.warn('[Sidebar] hardOpen failed:', type, e);
      renderLocal(type);
      showLocal(type);
    }
  }
  window.__4PulseSidebarOpenSection = hardOpen;

  function handlePointer(e){
    const card = e.target?.closest?.('.stat-card[data-type]');
    if (!card || card.id === 'stat-radio-inline') return;
    if (e.target.closest('button,input,textarea,select,a')) return;
    const type = card.dataset.type;
    if (!type || type === 'radio') return;
    lastPointerAt = Date.now();
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.shiftKey || e.ctrlKey || e.metaKey) openTab(TYPE_TO_URL[type] || type);
    else hardOpen(type);
  }
  document.addEventListener('pointerup', handlePointer, true);
  document.addEventListener('click', function(e){
    const card = e.target?.closest?.('.stat-card[data-type]');
    if (!card || card.id === 'stat-radio-inline') return;
    if (Date.now() - lastPointerAt < 700) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    handlePointer(e);
  }, true);

  async function hardApplyTileLayout(){
    try {
      await loadTilesRowConfig?.();
      await loadTilesOrder?.();
      applyTilesOrder?.();
      recalcRow2Layout?.();
      applyGlobalIconPack?.();
    } catch (e) { console.warn('[Sidebar] hard layout failed:', e); }
  }
  window.__4PulseSidebarApplyLayout = hardApplyTileLayout;
  chrome.storage?.onChanged?.addListener?.((changes, ns) => {
    if (ns !== 'local') return;
    if (changes.tiles_row_config || changes.tiles_order || changes.icon_pack || changes.custom_icon_pack || changes.show_bookmarks_tab || changes.show_history_tab) {
      setTimeout(hardApplyTileLayout, 30);
      setTimeout(hardApplyTileLayout, 300);
      setTimeout(hardApplyTileLayout, 900);
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    [60, 250, 900, 1800].forEach(t => setTimeout(hardApplyTileLayout, t));
    setTimeout(() => {
      const type = currentFilter || settings?.default_view || 'favorites';
      hardOpen(type === 'collapsed' ? 'favorites' : type, { noRefresh:true });
    }, 650);
  });
  window.addEventListener('focus', () => setTimeout(hardApplyTileLayout, 80));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(hardApplyTileLayout, 80); });
})();
