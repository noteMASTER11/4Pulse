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

// ── Focus / Mute state (mirrors popup.js) ───────────────────
let sidebarFocusedTopics = new Set();
let sidebarMutedTopics   = new Set();

async function loadSidebarFocusMuteState() {
    try {
        const stored = await chrome.storage.local.get(['focused_topics', 'muted_topics']);
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
    'themes-open-all':     '📂',
    'themes-open-all-pin': '📌',
    'themes-read-all':     '✅',
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
            if (pack === 'custom' && _customIconMap && _customIconMap[id]) {
                icon = _customIconMap[id];
            }
            const isUrl = icon.startsWith('http') || icon.startsWith('data:') || icon.startsWith('/');
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
        iconEl.innerHTML = '<use href="#icon-file-text"></use>';
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
    show_fav_toolbar:       true,
    primary_click_action:   'forum',
    toolbar_button_open_all:  true,
    toolbar_button_pinned:    true,
    toolbar_button_read_all:  true,
    max_visible_topics:      0,
    icon_pack:               'default', // 'default' | 'emoji' | 'custom'
    toolbar_pin_themes_level: 0,
};
let currentData   = null;
let currentFilter = null;
let pollInterval  = null;

// ── Sidebar: polling каждые 30 секунд (активно всегда) ──────
const SIDEBAR_POLL_MS = 30_000;

// ── Инициализация ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        setupRealtimeUpdates();
        initializeClock();
        await applyThemeAndColors();
        await loadSidebarFocusMuteState();
    await _loadTopicTags();
    await _loadCollapsedFolders();
        await initializeSidebar();
        await applyFontSettings();
    } catch (err) {
        console.error('Sidebar init error:', err);
    }
});

function showErrorState(msg) {
    document.body.innerHTML = `<div style="padding:20px;color:#ff6b6b;text-align:center">
        <b>Ошибка загрузки</b><br>${msg}
        <br><button onclick="location.reload()" style="margin-top:10px;padding:6px 14px;cursor:pointer">Перезагрузить</button>
    </div>`;
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
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'counts_updated' && msg.counts) {
            const prevQms     = currentData?.qms?.count       || 0;
            const prevFav     = currentData?.favorites?.count || 0;
            const prevMen     = currentData?.mentions?.count  || 0;
            const prevTickets = currentData?.tickets?.count   || 0;
            updateCountersFromCounts(msg.counts);

            // 🔖 Обновляем список закладок если фон прислал его в counts_updated
            if (msg.bookmarks_list && currentData) {
                if (!currentData.bookmarks) currentData.bookmarks = {};
                currentData.bookmarks.list = msg.bookmarks_list;
            }

            const newItems = msg.counts.qms      > prevQms
                          || msg.counts.favorites > prevFav
                          || msg.counts.mentions  > prevMen
                          || (msg.counts.tickets ?? 0) !== prevTickets;
            if (newItems) {
                refreshListsFromBackground();
            }
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
        const response = await sendMessage({ action: 'popup_loaded' });
        if (!response) return;
        currentData = response;
        renderTopics(response.favorites);
        renderQMS(response.qms);
        renderMentions(response.mentions);
        if (response.tickets?.list) renderTickets(response.tickets.list);
        updateStats(response);
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
    async function tick() {
        const now = new Date();
        timeEl.textContent = String(now.getHours()).padStart(2,'0') + ':' +
                             String(now.getMinutes()).padStart(2,'0');
        let lang = 'ru';
        try { const r = await chrome.storage.local.get(['ui_language']); lang = r.ui_language || 'ru'; } catch(e){}
        const months = MONTHS[lang] || MONTHS['ru'];
        dateEl.textContent = `${now.getDate()} ${months[now.getMonth()]}`;
    }
    tick();
    setInterval(tick, 60000);
    chrome.storage.onChanged.addListener((changes) => { if (changes.ui_language) tick(); });
}

// ── Theme ─────────────────────────────────────────────────────
async function applyThemeAndColors() {
    const data  = await chrome.storage.local.get(['theme_mode','accent_color']);
    const theme = data.theme_mode || 'dark';
    if (theme === 'auto') {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.setAttribute('data-theme', dark ? 'dark' : 'light');
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            chrome.storage.local.get(['theme_mode'], d => {
                if (d.theme_mode === 'auto')
                    document.body.setAttribute('data-theme', e.matches ? 'dark' : 'light');
            });
        });
    } else {
        document.body.setAttribute('data-theme', theme);
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
    'bricolage':     '"Bricolage Grotesque", -apple-system, sans-serif',
    'onest':         '"Onest", -apple-system, sans-serif',
    'geologica':     '"Geologica", -apple-system, sans-serif',
};
const FONT_SIZES = { xs:'12px', small:'14px', medium:'16px', large:'18px', xl:'20px', xxl:'22px' };

async function applyFontSettings() {
    const data = await chrome.storage.local.get(['font_family','font_size','line_height']);

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
        bmAddForm:       document.getElementById('bm-add-form'),
        bmAddTitle:      document.getElementById('bm-add-title'),
        bmAddUrl:        document.getElementById('bm-add-url'),
        bmAddSubmit:     document.getElementById('bm-add-submit'),
        bmAddCancel:     document.getElementById('bm-add-cancel'),
        bmGetNewpost:    document.getElementById('bm-getnewpost'),
        bmGetNewpostRow: document.getElementById('bm-getnewpost-row'),
        statTickets:    document.getElementById('stat-tickets'),
        statBookmarks:  document.getElementById('stat-bookmarks'),
        lastUpdateTime: document.getElementById('last-update-time'),
        refreshBtn:     document.getElementById('refresh-btn'),
        settingsBtn:    document.getElementById('settings-btn'),
        topicTemplate:  document.getElementById('tpl-topic-card'),
        topicTemplateSimple: document.getElementById('tpl-topic-card-simple'),
    };
}

// ── Event listeners ──────────────────────────────────────────
function setupEventListeners() {
    elements.username.addEventListener('click', () => openTab('user'));
    elements.refresh.addEventListener('click', handleRefreshClick);
    elements.options.addEventListener('click', () => openTab('options'));

    const compactBtn = document.getElementById('compact-toggle');
    if (compactBtn) compactBtn.addEventListener('click', toggleCompactMode);

    elements.statQms.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const isForumMode = settings.primary_click_action !== 'popup';
        const isModified  = e.shiftKey || e.ctrlKey || e.metaKey;
        if (isForumMode ? isModified : !isModified) {
            toggleFilter('qms');
        } else {
            openTab('qms');
        }
    });
    elements.statFavorites.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const isForumMode = settings.primary_click_action !== 'popup';
        const isModified  = e.shiftKey || e.ctrlKey || e.metaKey;
        if (isForumMode ? isModified : !isModified) {
            toggleFilter('favorites');
        } else {
            openTab('favorites');
        }
    });
    elements.statMentions.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const isForumMode = settings.primary_click_action !== 'popup';
        const isModified  = e.shiftKey || e.ctrlKey || e.metaKey;
        if (isForumMode ? isModified : !isModified) {
            toggleFilter('mentions');
        } else {
            openTab('mentions');
        }
    });

    elements.refreshBtn?.addEventListener('click', () => refreshData());
    elements.settingsBtn?.addEventListener('click', () => openTab('options'));

    // 🎫 Tickets stat card
    elements.statTickets?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const isForumMode = settings.primary_click_action !== 'popup';
        const isModified  = e.shiftKey || e.ctrlKey || e.metaKey;
        if (isForumMode ? isModified : !isModified) {
            toggleFilter('tickets');
        } else {
            openTab('ticket');
        }
    });

    // 🔖 Bookmarks — всегда список (нет отдельной страницы форума)
    elements.statBookmarks?.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) {
            openTab('bookmarks');
        } else {
            toggleFilter('bookmarks');
        }
    });
}

// ── Compact mode ─────────────────────────────────────────────
function toggleCompactMode() {
    settings.compact_mode = !settings.compact_mode;
    document.body.classList.toggle('compact-mode', settings.compact_mode);
    document.getElementById('compact-toggle')?.classList.toggle('active', settings.compact_mode);
    chrome.storage.local.set({ compact_mode: settings.compact_mode });
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
    settings.toolbar_pin_themes_level = response.settings.toolbar_pin_themes_level ?? 0;
    settings.show_bookmarks_tab         = response.settings.show_bookmarks_tab || false;
    settings.toolbar_button_open_all    = response.settings.toolbar_button_open_all  ?? true;
    settings.toolbar_button_pinned      = response.settings.toolbar_button_pinned    ?? true;
    settings.toolbar_button_read_all    = response.settings.toolbar_button_read_all  ?? true;
    settings.primary_click_action       = response.settings.primary_click_action || 'forum';
    settings.mirror_mode                = response.settings.mirror_mode            || false;
    settings.icon_pack                  = response.settings.icon_pack              || 'default';
    settings.disable_topic_animations   = response.settings.disable_topic_animations || false;

    if (settings.bw_icons) document.body.classList.add('bw-icons');
    document.body.classList.toggle('no-topic-animations', !!settings.disable_topic_animations);
    document.body.setAttribute('data-accent', settings.accent_color);
    if (settings.mirror_mode) document.body.classList.add('mirror-mode');
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

    // Пользователь
    const usernameText = elements.username.querySelector('.user-name-text');
    if (usernameText) usernameText.textContent = response.user_name;

    const userAvatar = document.getElementById('user-avatar');
    if (userAvatar && response.user_avatar_url) {
        userAvatar.src = response.user_avatar_url;
        userAvatar.onload  = () => { userAvatar.style.display = 'block'; document.querySelector('.user-icon-fallback').style.display = 'none'; };
        userAvatar.onerror = () => { userAvatar.style.display = 'none'; };
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

    // Sidebar по умолчанию показывает список тем (не collapsed)
    const defaultView = settings.default_view === 'collapsed' ? 'favorites' : settings.default_view;
    filterTopics(defaultView);

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
    if (changes.theme_mode) applyThemeAndColors();
    if (changes.font_family || changes.font_size || changes.line_height) applyFontSettings();
    if (changes.primary_click_action !== undefined) settings.primary_click_action = changes.primary_click_action.newValue;
    // 🪞 Mirror mode
    if (changes.mirror_mode !== undefined) {
        settings.mirror_mode = changes.mirror_mode.newValue;
        document.body.classList.toggle('mirror-mode', !!settings.mirror_mode);
    }
    // 🔀 Compact mode (кнопка в хедере)
    if (changes.compact_mode !== undefined) {
        settings.compact_mode = changes.compact_mode.newValue;
        document.body.classList.toggle('compact-mode', !!settings.compact_mode);
        document.getElementById('compact-toggle')?.classList.toggle('active', !!settings.compact_mode);
        applyFontSettings();
    }
    // 🔧 Тулбар сортировки
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
             'stat-tickets','stat-bookmarks','stat-radio-inline'].forEach(id => {
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
    if (changes.tiles_row_config) {
            _tilesRowConfig = changes.tiles_row_config.newValue?.row1 ? changes.tiles_row_config.newValue : null;
            applyTilesOrder();
        }
    if (changes.tiles_order) {
        loadTilesOrder().then(() => applyTilesOrder());
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
    if (currentFilter === type) { expandAll(); return; }
    filterTopics(type);
}

function expandAll() {
    // В sidebar нет collapsed — при повторном клике разворачиваем все
    currentFilter = null;
    showElement(elements.main);
    showElement(elements.themeActions);
    if (currentData) updateStats(currentData);
}

function filterTopics(type) {
    try {
        currentFilter = type;

        if (type === 'favorites') {
            showElement(elements.topicsList);
            hideElement(elements.qmsList);
            hideElement(elements.mentionsList);
            hideElement(elements.ticketsList);
            hideElement(elements.bookmarksList);
            showElement(elements.themeActions);
            const rendered = elements.topicsList.children.length > 0;
            if (!rendered) showEmptyState(true, 'Все темы прочитаны');
            else showEmptyState(false);
        } else if (type === 'qms') {
            hideElement(elements.topicsList);
            showElement(elements.qmsList);
            hideElement(elements.mentionsList);
            hideElement(elements.ticketsList);
            hideElement(elements.bookmarksList);
            const rendered = elements.qmsList.children.length > 0;
            if (!rendered) showEmptyState(true, 'Нет новых сообщений');
            else showEmptyState(false);
        } else if (type === 'mentions') {
            hideElement(elements.topicsList);
            hideElement(elements.qmsList);
            showElement(elements.mentionsList);
            hideElement(elements.ticketsList);
            hideElement(elements.bookmarksList);
            const rendered = elements.mentionsList.children.length > 0;
            if (!rendered) showEmptyState(true, 'Нет упоминаний');
            else showEmptyState(false);
        } else if (type === 'tickets') {
            hideElement(elements.topicsList);
            hideElement(elements.qmsList);
            hideElement(elements.mentionsList);
            showElement(elements.ticketsList);
            hideElement(elements.bookmarksList);
            const rendered = elements.ticketsList.children.length > 0;
            if (!rendered) showEmptyState(true, 'Нет тикетов');
            else showEmptyState(false);
        } else if (type === 'bookmarks') {
            hideElement(elements.topicsList);
            hideElement(elements.qmsList);
            hideElement(elements.mentionsList);
            hideElement(elements.ticketsList);
            showElement(elements.bookmarksList);
            hideElement(elements.themeActions);
            showEmptyState(false);
            const bmList = currentData?.bookmarks?.list;
            if (bmList) renderBookmarks(bmList);
            else showEmptyState(true, 'Закладки не загружены');
        }

        updateStats(currentData);
        showElement(elements.main);
    } catch (e) { console.error('filterTopics error:', e); }
}

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

    [elements.statFavorites, elements.statQms, elements.statMentions, elements.statTickets, elements.statBookmarks].forEach(el => el?.classList.remove('active'));
    if (currentFilter === 'favorites') elements.statFavorites?.classList.add('active');
    else if (currentFilter === 'qms')       elements.statQms?.classList.add('active');
    else if (currentFilter === 'mentions')  elements.statMentions?.classList.add('active');
    else if (currentFilter === 'tickets')   elements.statTickets?.classList.add('active');
    else if (currentFilter === 'bookmarks') elements.statBookmarks?.classList.add('active');
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
    try { await chrome.storage.local.set({ topic_tags: _topicTags }); } catch(_) {}
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
        if (changed) chrome.storage.local.set({ [CURATOR_CACHE_KEY]: _curatorCache });
    } catch(_) { _curatorCache = {}; }
}

async function _saveCuratorCache() {
    try { await chrome.storage.local.set({ [CURATOR_CACHE_KEY]: _curatorCache }); } catch(_) {}
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
    editor.innerHTML = `
        <div class="fav-tag-editor-inner">
            <div class="fav-tag-editor-tags"></div>
            <input class="fav-tag-input" placeholder="Новый тег... Enter" maxlength="20" type="text">
        </div>`;
    editor.addEventListener('click', e => e.stopPropagation());

    const tagsDiv = editor.querySelector('.fav-tag-editor-tags');
    const input   = editor.querySelector('.fav-tag-input');

    const refresh = () => {
        tagsDiv.innerHTML = '';
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




function renderTopics(favoritesData) {
    try {
        const fragment = document.createDocumentFragment();

        if (!favoritesData || !favoritesData.list || favoritesData.list.length === 0) {
            elements.topicsList.innerHTML = '';
            return;
        }

        const template = settings.simple_list ?
            elements.topicTemplateSimple :
            elements.topicTemplate;

        let topicsToShow = favoritesData.list;
        if (!settings.show_all_favorites) {
            topicsToShow = favoritesData.list.filter(t => !t.viewed);
        }

        // ── Sorting ──────────────────────────────────────────────────────
        const pinLevel = settings.toolbar_pin_themes_level ?? 0;

        const topicsFiltered = pinLevel === 20
            ? topicsToShow.filter(t => t.pin)
            : topicsToShow;

        const sorted = [...topicsFiltered].sort((a, b) => {
            if (_favSort === 'title')  return (a.title || '').localeCompare(b.title || '', 'ru');
            if (_favSort === 'unread') {
                const ua = a.viewed ? 0 : (a.unread_count || 1);
                const ub = b.viewed ? 0 : (b.unread_count || 1);
                return ub - ua || b.last_post_ts - a.last_post_ts;
            }
            // 'date' — pinned first, then focused, then by ts
            const pa = a.pin ? 1 : 0;
            const pb = b.pin ? 1 : 0;
            if (pa !== pb) return pb - pa;
            const fa = sidebarFocusedTopics.has(String(a.id)) ? 1 : 0;
            const fb = sidebarFocusedTopics.has(String(b.id)) ? 1 : 0;
            return fb - fa || b.last_post_ts - a.last_post_ts;
        });

        // ── Sort/Group/Tag toolbar (can be hidden in settings) ───────────
        if (settings.show_fav_toolbar !== false) {
        const allTagsSet = new Set();
        topicsToShow.forEach(t => {
            (_topicTags[String(t.id)] || []).forEach(tag => allTagsSet.add(tag));
        });
        const allTags = [...allTagsSet].sort();

        // ── Sort/Group/Tag toolbar ────────────────────────────────────────
        const toolbar = document.createElement('li');
        toolbar.className = 'fav-toolbar';

        // Sort + group buttons
        const sortRow = document.createElement('div');
        sortRow.className = 'fav-sort-btns';
        // Создаём кнопки через DOM — innerHTML не работает для SVG <use> в Firefox
        const makeTbBtn = (sortVal, groupVal, isActive, title, iconPath) => {
            const btn = document.createElement('button');
            btn.className = 'fav-tb-btn' + (isActive ? ' active' : '');
            if (sortVal)  btn.dataset.sort  = sortVal;
            if (groupVal) btn.dataset.group = groupVal;
            btn.title = title;
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'fav-tb-icon');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '2');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');
            svg.innerHTML = iconPath;
            btn.appendChild(svg);
            return btn;
        };
        sortRow.appendChild(makeTbBtn('date',  null, _favSort==='date',
            'По дате',
            '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 15"/>'));
        sortRow.appendChild(makeTbBtn('title', null, _favSort==='title',
            'По названию А→Я',
            '<line x1="4" y1="6" x2="11" y2="6"/><line x1="4" y1="12" x2="11" y2="12"/><line x1="4" y1="18" x2="13" y2="18"/><polyline points="15 9 18 4 21 9"/><polyline points="15 15 18 20 21 15"/>'));
                // «По непрочитанным» только в режиме «все темы»
        if (settings.show_all_favorites) {
            sortRow.appendChild(makeTbBtn('unread', null, _favSort==='unread',
                'По непрочитанным',
                '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><circle cx="19" cy="5" r="3" fill="currentColor" stroke="none"/>'));
        } else if (_favSort === 'unread') {
            _favSort = 'date';
        }
        sortRow.appendChild(makeTbBtn(null,  '1',   _favGroup,
            'Группировка по разделу',
            '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="8" y1="14" x2="16" y2="14"/><line x1="8" y1="17" x2="13" y2="17"/>'));
        toolbar.appendChild(sortRow);

        // Tag filter row — only if there are tags
        if (allTags.length > 0) {
            const tagRow = document.createElement('div');
            tagRow.className = 'fav-tag-filter-row';

            // "Все" chip
            const allChip = document.createElement('span');
            allChip.className = 'fav-filter-chip' + (_favTagFilter === null ? ' active' : '');
            allChip.textContent = 'Все';
            allChip.dataset.tag = '';
            tagRow.appendChild(allChip);

            allTags.forEach(tag => {
                const chip = document.createElement('span');
                chip.className = 'fav-filter-chip' + (_favTagFilter === tag ? ' active' : '');
                chip.textContent = '🏷️ ' + tag;
                chip.dataset.tag = tag;
                tagRow.appendChild(chip);
            });

            tagRow.addEventListener('click', e => {
                e.stopPropagation();
                const chip = e.target.closest('.fav-filter-chip');
                if (!chip) return;
                _favTagFilter = chip.dataset.tag || null;
                renderTopics(favoritesData);
            });
            toolbar.appendChild(tagRow);
        }

        toolbar.addEventListener('click', e => {
            e.stopPropagation();
            const btn = e.target.closest('.fav-tb-btn');
            if (!btn) return;
            if (btn.dataset.sort) { _favSort = btn.dataset.sort; }
            if (btn.dataset.group) { _favGroup = !_favGroup; }
            renderTopics(favoritesData);
        });
        fragment.appendChild(toolbar);
        } // end show_fav_toolbar

        // ── Apply tag filter ──────────────────────────────────────────────
        const filtered = _favTagFilter
            ? sorted.filter(t => (_topicTags[String(t.id)] || []).includes(_favTagFilter))
            : sorted;

        // ── Render cards ──────────────────────────────────────────────────
        if (_favGroup) {
            const groups = {};
            filtered.forEach(t => {
                const sec = _topicSection(t.title);
                if (!groups[sec]) groups[sec] = [];
                groups[sec].push(t);
            });
            let idx = 0;
            Object.entries(groups).sort(([a],[b]) => a.localeCompare(b,'ru')).forEach(([sec, topics]) => {
                const hdr = document.createElement('li');
                hdr.className = 'date-divider fav-group-header';
                hdr.innerHTML = `<span class="date-divider-label">${sec} (${topics.length})</span>`;
                fragment.appendChild(hdr);
                topics.forEach(t => {
                    fragment.appendChild(createTopicCard(t, template, idx++, !!t.viewed));
                });
            });
        } else {
            const unread = filtered.filter(t => !t.viewed);
            const read   = filtered.filter(t => t.viewed);
            unread.forEach((t, i) => fragment.appendChild(createTopicCard(t, template, i, false)));
            if (unread.length > 0 && read.length > 0) {
                const div = document.createElement('li');
                div.className = 'date-divider';
                div.innerHTML = '<span class="date-divider-label">Прочитанные</span>';
                fragment.appendChild(div);
            }
            read.forEach((t, i) => fragment.appendChild(createTopicCard(t, template, i + unread.length, true)));
        }

        // If tag filter active and nothing matches — show hint
        if (_favTagFilter && filtered.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'date-divider';
            empty.innerHTML = `<span class="date-divider-label">Нет тем с тегом «${_favTagFilter}»</span>`;
            fragment.appendChild(empty);
        }

        elements.topicsList.innerHTML = '';
        elements.topicsList.appendChild(fragment);

        const anyFocused = [...topicsToShow].some(t => sidebarFocusedTopics.has(String(t.id)));
        elements.topicsList.classList.toggle('has-focused', anyFocused);
        adjustPopupHeight();
    } catch (error) {
        console.error('Error rendering topics:', error);
    }
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
        if (authorEl && topic.last_user_name) authorEl.innerHTML = `<svg class="icon-sm"><use href="#icon-user"></use></svg> ${decodeHtmlEntities(topic.last_user_name)}`;
        if (timeEl && topic.last_post_ts) timeEl.textContent = `• ${formatRelativeTime(topic.last_post_ts)}`;
    }

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
                await chrome.storage.local.set({ muted_topics: [...sidebarMutedTopics] });
                card.classList.remove('muted');
                const muteIcon = card.querySelector('.topic-mute-icon');
                if (muteIcon) muteIcon.classList.add('hidden');
            }
            await chrome.storage.local.set({ focused_topics: [...sidebarFocusedTopics] });
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
                await chrome.storage.local.set({ priority_blinking: true });
                chrome.runtime.sendMessage({ action: 'start_priority_blink' }).catch(() => {});
            } else {
                await chrome.storage.local.set({ priority_blinking: false });
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
                await chrome.storage.local.set({ focused_topics: [...sidebarFocusedTopics] });
                card.classList.remove('focused');
                const focusIcon = card.querySelector('.topic-focus-icon');
                if (focusIcon) focusIcon.classList.add('hidden');
            }
            await chrome.storage.local.set({ muted_topics: [...sidebarMutedTopics] });
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
        tagBtn.innerHTML = '<svg class="icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>';
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
    if (qmsObserver) qmsObserver.disconnect();

    qmsObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const card = entry.target;
            const dialogId = card.getAttribute('data-dialog-id');
            if (!dialogId) return;
            if (!loadingQmsSubjects.has(dialogId) && !card.hasAttribute('data-subject-loaded')) {
                fetchQMSSubject(dialogId);
            }
        });
    }, { root: elements.main, rootMargin: '50px', threshold: 0.1 });

    elements.qmsList.querySelectorAll('.topic-card').forEach(card => qmsObserver.observe(card));
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
    try {
        loadingQmsSubjects.clear();
        const fragment = document.createDocumentFragment();

        if (!qmsData || !qmsData.list || qmsData.list.length === 0) {
            elements.qmsList.innerHTML = '';
            return;
        }

        const template = settings.simple_list ?
            elements.topicTemplateSimple :
            elements.topicTemplate;

        let dialogsToShow = qmsData.list;
        if (!settings.show_all_qms) {
            dialogsToShow = qmsData.list.filter(d => d.unread && !d.viewed);
        }

        const unreadDialogs = dialogsToShow.filter(d => d.unread && !d.viewed);
        const readDialogs   = dialogsToShow.filter(d => !d.unread || d.viewed);

        unreadDialogs.forEach((dialog, index) => {
            fragment.appendChild(createQMSCard(dialog, template, index, false));
        });
        readDialogs.forEach((dialog, index) => {
            fragment.appendChild(createQMSCard(dialog, template, index + unreadDialogs.length, true));
        });

        elements.qmsList.innerHTML = '';

        // ── Строка поиска ──────────────────────────────────────────────────
        const searchRow = document.createElement('li');
        searchRow.className = 'qms-search-row';
        searchRow.innerHTML = `<input type="text" class="qms-search-input" placeholder="🔍 Поиск по имени или теме...">`;
        searchRow.addEventListener('click', e => e.stopPropagation());
        searchRow.querySelector('input').addEventListener('input', function() {
            const q = this.value.toLowerCase().trim();
            elements.qmsList.querySelectorAll('.topic-card').forEach(card => {
                const title = (card.querySelector('.topic-title')?.textContent || '').toLowerCase();
                const meta  = (card.querySelector('.topic-meta')?.textContent  || '').toLowerCase();
                card.style.display = (!q || title.includes(q) || meta.includes(q)) ? '' : 'none';
            });
            setTimeout(() => adjustPopupHeight(), 40);
        });
        elements.qmsList.appendChild(searchRow);
        elements.qmsList.appendChild(fragment);

        setupQMSLazyLoading();
        adjustPopupHeight();
    } catch (error) {
        console.error('Error rendering QMS:', error);
    }
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
    if (typeIcon) typeIcon.innerHTML = '<use href="#icon-mail"></use>';
    const pinIcon = card.querySelector('.topic-pin-icon');
    if (pinIcon) pinIcon.classList.add('hidden');

    // Title: subject if available, else opponent_name
    const titleEl = card.querySelector('.topic-title');
    const metaEl  = card.querySelector('.topic-meta');
    if (titleEl) titleEl.textContent = decodeHtmlEntities(dialog.subject || dialog.title || dialog.opponent_name || '');
    if (metaEl) {
        let metaText = decodeHtmlEntities(dialog.opponent_name || '');
        if (dialog.last_msg_ts) metaText += (metaText ? ' • ' : '') + formatRelativeTime(dialog.last_msg_ts);
        metaEl.textContent = metaText;
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) markReadBtn.remove();

    // QMS cards don't use focus/mute — remove those template buttons
    card.querySelector('.topic-focus-btn')?.remove();
    card.querySelector('.topic-mute-btn')?.remove();
    card.querySelector('.topic-focus-icon')?.remove();
    card.querySelector('.topic-mute-icon')?.remove();

    // Open-in-tab button
    const actionsContainer = card.querySelector('.card-actions');
    if (actionsContainer) {
        const openTabBtn = document.createElement('button');
        openTabBtn.className = 'action-icon open-tab interactive';
        openTabBtn.title = 'Открыть диалог';
        openTabBtn.innerHTML = '<svg class="icon"><use href="#icon-external-link"></use></svg>';
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
    inlineChat.innerHTML = `
        <div class="qms-history"></div>
        <div class="qms-emoji-picker hidden"></div>
        <div class="qms-reply-form">
            <textarea class="qms-textarea" placeholder="Сообщение..."></textarea>
            <div class="qms-reply-actions">
                <button class="qms-btn qms-btn-emoji" title="Смайлики"><svg class="icon-sm"><use href="#icon-smile"></use></svg></button>
                <button class="qms-btn qms-btn-send" title="Отправить (Ctrl+Enter)">Отправить</button>
                <button class="qms-btn qms-btn-cancel" title="Свернуть">Свернуть</button>
            </div>
        </div>`;
    cardBody.appendChild(inlineChat);
    inlineChat.addEventListener('click', e => e.stopPropagation());

    const EMOJIS = ['😀','😂','🤣','😊','😍','😒','😘','😁','😉','😎','😋','😜','🤔','🙄','😏','😔','😴','🤤','😷','🤢','🤮','🤧','😵','🤯','🤠','🥳','🤓','👍','👎','👏','🤝','🍻','🔥','❤️','💔','💯','🤷‍♂️','🤦‍♂️'];
    const emojiPicker = inlineChat.querySelector('.qms-emoji-picker');
    const textarea    = inlineChat.querySelector('.qms-textarea');
    EMOJIS.forEach(emo => {
        const span = document.createElement('span');
        span.textContent = emo; span.className = 'qms-emoji-item';
        span.onclick = (e) => {
            e.stopPropagation();
            const s = textarea.selectionStart, en = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, s) + emo + textarea.value.substring(en);
            textarea.selectionStart = textarea.selectionEnd = s + emo.length;
            textarea.focus();
        };
        emojiPicker.appendChild(span);
    });

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
        historyContainer.innerHTML = '<div class="qms-loading-text">Загрузка...</div>';
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
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const messages = doc.querySelectorAll('#scroll-thread .list-group-item[data-message-id]');
            const fallbackMsgs = messages.length === 0
                ? doc.querySelectorAll('.list-group-item[data-message-id]')
                : messages;
            historyContainer.innerHTML = '';
            if (!fallbackMsgs.length) historyContainer.innerHTML = '<div class="qms-loading-text">Нет сообщений</div>';
            fallbackMsgs.forEach(msg => {
                const msgId = msg.getAttribute('data-message-id');
                if (msgId) lastMessageId = msgId;
                const content = msg.querySelector('.msg-content');
                if (content) {
                    const div = document.createElement('div');
                    div.className = msg.classList.contains('our-message') ? 'qms-msg out' : 'qms-msg in';
                    div.innerHTML = content.innerHTML;
                    historyContainer.appendChild(div);
                }
            });
            setTimeout(() => historyContainer.scrollTop = historyContainer.scrollHeight, 50);
        } catch(err) {
            console.error('[QMS sidebar] ошибка загрузки:', err);
            historyContainer.innerHTML = '<div class="qms-loading-text">Ошибка загрузки</div>';
        }
    });

    inlineChat.querySelector('.qms-btn-cancel').addEventListener('click', (e) => {
        e.stopPropagation(); isExpanded = false; inlineChat.classList.add('hidden');
    });
    inlineChat.querySelector('.qms-btn-emoji').addEventListener('click', (e) => {
        e.stopPropagation(); emojiPicker.classList.toggle('hidden');
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
    if (!mentionsData?.list?.length) { elements.mentionsList.innerHTML = ''; return; }
    const frag = document.createDocumentFragment();
    const tpl  = settings.simple_list ? elements.topicTemplateSimple : elements.topicTemplate;
    let list   = settings.show_all_mentions ? mentionsData.list : mentionsData.list.filter(m => m.unread && !m.viewed);
    // 🔧 Заголовок с числом непрочитанных
    const unreadCount = list.filter(m => m.unread && !m.viewed).length;
    if (unreadCount > 0) {
        const header = document.createElement('li');
        header.className = 'date-divider unread-count-divider';
        const label = unreadCount === 1 ? '1 непрочитанное' : `${unreadCount} непрочитанных`;
        header.innerHTML = `<span class="date-divider-label">${label}</span>`;
        frag.appendChild(header);
    }
    list.forEach((m, i) => frag.appendChild(createMentionCard(m, tpl, i)));
    elements.mentionsList.innerHTML = '';
    elements.mentionsList.appendChild(frag);
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
        if (authorEl && mention.poster_name) authorEl.innerHTML = `<svg class="icon-sm"><use href="#icon-user"></use></svg> ${decodeHtmlEntities(mention.poster_name)}`;
        if (timeEl && mention.timestamp) timeEl.textContent = `• ${formatRelativeTime(mention.timestamp)}`;
    }
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


function renderTickets(tickets) {
    const list = elements.ticketsList;
    if (!list) return;
    list.innerHTML = '';

    const STATUS_LABEL = {
        'не обработан': { text: 'Не обработан', cls: 'ticket-status-new' },
        'в работе':     { text: 'В работе',      cls: 'ticket-status-wip' },
        'обработан':    { text: 'Обработан',      cls: 'ticket-status-done' },
    };

    tickets.forEach(ticket => {
        const li = document.createElement('li');
        li.className = 'topic-card interactive' + (ticket.viewed ? ' ticket-viewed' : '');
        li.dataset.ticketId     = ticket.id;
        li.dataset.ticketStatus = (ticket.status || '').trim();

        // Normalize status to prevent whitespace issues
        const statusKey  = (ticket.status || '').trim();
        const statusInfo = STATUS_LABEL[statusKey] || STATUS_LABEL['не обработан'];

        // Format time only (HH:MM)
        const timeStr = ticket.ts
            ? new Date(ticket.ts * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            : '';

        const showWip  = statusKey !== 'в работе' && statusKey !== 'обработан';
        const showDone = statusKey !== 'обработан';

        // ── Unified card structure (always identical layout) ──
        //  Row 1: [StatusBadge]  ...  [Time]
        //  Row 2: [SectionTag]   ...  [· Responsible]
        //  Row 3: Title
        //  Row 4: Snippet (optional)
        //  Row 5: [Open] [WiP?] [Done?]

        const inner = document.createElement('div');
        inner.className = 'ticket-card-inner';

        // Row 1 — status (left) + time (right)
        const rowTop = document.createElement('div');
        rowTop.className = 'ticket-row-top';
        rowTop.innerHTML =
            `<span class="ticket-status ${statusInfo.cls}">${statusInfo.text}</span>` +
            `<span class="ticket-time">${timeStr}</span>`;

        // Row 2 — раздел + куратор (оба видимы, если есть)
        const rowMeta = document.createElement('div');
        rowMeta.className = 'ticket-row-meta';
        const sectionVal = (ticket.section || ticket.forum || '').trim();
        const hasResponsibleMeta = !!(ticket.responsible && ticket.responsible.trim());

        let metaHtml = '';
        if (sectionVal) {
            const icon = getTicketSectionIcon(sectionVal);
            metaHtml += `<span class="ticket-section-tag" title="${escapeHtml(sectionVal)}">${icon ? icon + ' ' : ''}${escapeHtml(sectionVal)}</span>`;
        }
        // Куратор — только из content-блока (not t-mod который = кто взял в работу)
        const curatorVal = (ticket.curator || '').trim();
        if (curatorVal) {
            metaHtml += `<span class="ticket-curator-tag" title="Куратор темы: ${escapeHtml(curatorVal)}">🎯 ${escapeHtml(curatorVal)}</span>`;
        }
        if (metaHtml) rowMeta.innerHTML = metaHtml;

        // Row 3 — заголовок (без дублирования в tooltip)
        const titleEl = document.createElement('div');
        titleEl.className = 'ticket-title';
        titleEl.title = ticket.title || '';
        titleEl.textContent = ticket.title || '—';

        // Row 4 — snippet убран, он содержит служебные метаданные
        // (Тема, Куратор, Автор поста) которые не нужно показывать

        // Row 4 — action buttons matching forum status controls
        // Clicking the card title or Открыть button opens the ticket
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'ticket-actions';

        // "Открыть" — opens original forum post (fetches ticket page to find showtopic link)
        const btnOpen = document.createElement('button');
        btnOpen.className = 'ticket-btn ticket-btn-open';
        btnOpen.innerHTML = '<svg style="width:11px;height:11px;display:inline;vertical-align:-1px;margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Открыть'; btnOpen.setAttribute("data-html", btnOpen.innerHTML);
        btnOpen.addEventListener('click', (e) => {
            e.stopPropagation();
            btnOpen.disabled = true; btnOpen.textContent = "…"; sendTicketAction("open_ticket_source", { id: ticket.id }).finally(() => { btnOpen.disabled = false; btnOpen.innerHTML = btnOpen.getAttribute("data-html"); });
        });
        actionsDiv.appendChild(btnOpen);

        // "В работе" — only if not already wip or done
        if (showWip) {
            const btnWip = document.createElement('button');
            btnWip.className = 'ticket-btn ticket-btn-wip';
            btnWip.innerHTML = '<svg style="width:11px;height:11px;display:inline;vertical-align:-1px;margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>В работу';
            btnWip.addEventListener('click', (e) => {
                e.stopPropagation();
                sidebarChangeTicketStatus(ticket.id, 'в работе', li);
            });
            actionsDiv.appendChild(btnWip);
        }

        // "Обработан" — only if not already done
        if (showDone) {
            const btnDone = document.createElement('button');
            btnDone.className = 'ticket-btn ticket-btn-done';
            btnDone.innerHTML = '<svg style="width:11px;height:11px;display:inline;vertical-align:-1px;margin-right:4px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>Обработать';
            btnDone.addEventListener('click', (e) => {
                e.stopPropagation();
                sidebarChangeTicketStatus(ticket.id, 'обработан', li);
            });
            actionsDiv.appendChild(btnDone);
        }

        // ── Быстрый ответ ─────────────────────────────────────────────────
        const replyWrap = document.createElement('div');
        replyWrap.className = 'ticket-reply-wrap hidden';
        replyWrap.innerHTML = `
            <textarea class="ticket-reply-ta" placeholder="Написать комментарий к тикету..." rows="2"></textarea>
            <div class="ticket-reply-actions">
                <button class="ticket-btn ticket-reply-send">Отправить</button>
                <button class="ticket-btn ticket-reply-cancel" style="background:transparent;color:var(--text-2);">Отмена</button>
            </div>`;
        replyWrap.addEventListener('click', e => e.stopPropagation());

        // Кнопка «Ответить» в строке действий
        const btnReply = document.createElement('button');
        btnReply.className = 'ticket-btn ticket-btn-reply';
        btnReply.innerHTML = '💬 Ответить';
        btnReply.addEventListener('click', e => {
            e.stopPropagation();
            replyWrap.classList.toggle('hidden');
            if (!replyWrap.classList.contains('hidden')) replyWrap.querySelector('textarea').focus();
            setTimeout(() => adjustPopupHeight(), 30);
        });
        actionsDiv.appendChild(btnReply);

        replyWrap.querySelector('.ticket-reply-cancel').addEventListener('click', () => {
            replyWrap.classList.add('hidden');
            setTimeout(() => adjustPopupHeight(), 30);
        });

        replyWrap.querySelector('.ticket-reply-send').addEventListener('click', async () => {
            const ta   = replyWrap.querySelector('textarea');
            const text = ta.value.trim();
            if (!text) return;
            const btn = replyWrap.querySelector('.ticket-reply-send');
            btn.disabled = true; btn.textContent = '…';
            try {
                const r = await chrome.runtime.sendMessage({
                    action: 'ticket_add_comment', id: ticket.id, comment: text
                });
                if (r?.ok) {
                    ta.value = '';
                    replyWrap.classList.add('hidden');
                    btn.textContent = '✓ Отправлено';
                    setTimeout(() => { btn.disabled = false; btn.textContent = 'Отправить'; }, 1500);
                } else { throw new Error('fail'); }
            } catch (_) {
                btn.disabled = false; btn.textContent = 'Ошибка — повтор?';
                setTimeout(() => { btn.textContent = 'Отправить'; }, 2000);
            }
            setTimeout(() => adjustPopupHeight(), 30);
        });

        inner.appendChild(rowTop);
        inner.appendChild(rowMeta);
        inner.appendChild(titleEl);
        inner.appendChild(actionsDiv);
        inner.appendChild(replyWrap);

        li.appendChild(inner);
        list.appendChild(li);
    });

    // ── Счётчик по статусам ────────────────────────────────────────────────
    const cntNew = tickets.filter(t => t.status === 'не обработан').length;
    const cntWip = tickets.filter(t => t.status === 'в работе').length;
    let statsBar = list.querySelector('.ticket-stats-bar');
    if (!statsBar) {
        statsBar = document.createElement('li');
        statsBar.className = 'ticket-stats-bar';
        list.insertBefore(statsBar, list.firstChild);
    }
    statsBar.innerHTML =
        `<span class="tsb-item tsb-new" data-filter="не обработан" title="Показать только необработанные">` +
        `<span class="tsb-dot"></span> Не обработан: <b>${cntNew}</b></span>` +
        `<span class="tsb-item tsb-wip" data-filter="в работе" title="Показать только в работе">` +
        `<span class="tsb-dot"></span> В работе: <b>${cntWip}</b></span>` +
        `<span class="tsb-item tsb-all" data-filter="" title="Показать все">Все</span>`;

    // Клики по счётчикам — фильтр карточек
    statsBar.querySelectorAll('.tsb-item').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const filterStatus = btn.dataset.filter;
            statsBar.querySelectorAll('.tsb-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            list.querySelectorAll('.topic-card[data-ticket-id]').forEach(card => {
                const status = card.dataset.ticketStatus || '';
                card.style.display = (!filterStatus || status === filterStatus) ? '' : 'none';
            });
            setTimeout(() => adjustPopupHeight(), 50);
        });
    });

    // ── Curator lazy-load: persistent cache + queue ────────────────────────
    _loadCuratorCache().then(() => {
        const curatorObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const card     = entry.target;
                const ticketId = parseInt(card.dataset.ticketId);
                if (!ticketId || card.dataset.curatorLoaded) return;
                card.dataset.curatorLoaded = '1';
                curatorObserver.unobserve(card);

                const cached     = tickets.find(t => t.id === ticketId);
                const persisted  = _curatorCache?.[String(ticketId)];

                // Persistent cache hit
                if (persisted) {
                    if (cached) Object.assign(cached, persisted, { curatorFetched: true });
                    _applyTicketThreadData(card, persisted);
                    return;
                }
                // In-memory cache hit
                if (cached?.curatorFetched) {
                    _applyTicketThreadData(card, cached);
                    return;
                }
                // Fetch via queue
                _enqueueCurator(ticketId, card, cached);
            });
        }, { root: elements.ticketsList, rootMargin: '80px', threshold: 0.1 });

        list.querySelectorAll('.topic-card[data-ticket-id]').forEach(card => {
            curatorObserver.observe(card);
        });
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
        hideElement(elements.topicsList);
        hideElement(elements.qmsList);
        hideElement(elements.mentionsList);
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
    const ta = document.createElement('textarea');
    ta.innerHTML = text;
    return ta.value;
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
    ru: { popup_stats:'Статистика', popup_topics:'Темы', popup_mentions:'Ответы', popup_open_all:'Открыть все', popup_pinned:'Закреп.', popup_read_all:'Прочитать', popup_empty:'Непрочитанных тем нет', radio_mini_radio:'🎵 Радио' },
    en: { popup_stats:'Stats', popup_topics:'Topics', popup_mentions:'Mentions', popup_open_all:'Open all', popup_pinned:'Pinned', popup_read_all:'Read all', popup_empty:'No unread topics', radio_mini_radio:'🎵 Radio' },
    de: { popup_stats:'Statistik', popup_topics:'Themen', popup_mentions:'Erwähnung', popup_open_all:'Alle öffnen', popup_pinned:'Angeh.', popup_read_all:'Alle gel.', popup_empty:'Keine ungelesenen Themen', radio_mini_radio:'🎵 Radio' },
    uk: { popup_stats:'Статистика', popup_topics:'Теми', popup_mentions:'Відповіді', popup_open_all:'Відкрити всі', popup_pinned:'Закріп.', popup_read_all:'Прочитати', popup_empty:'Непрочитаних тем немає', radio_mini_radio:'🎵 Радіо' },
};

async function applySidebarLanguage() {
    try {
        const result = await chrome.storage.local.get(['ui_language']);
        const lang = result.ui_language || 'ru';
        const t = SIDEBAR_TRANSLATIONS[lang] || SIDEBAR_TRANSLATIONS['ru'];
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            if (t[key]) el.textContent = t[key];
        });
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
    'stat-bookmarks','stat-tickets','stat-radio-inline'
];
let _tilesOrder = [...DRAGGABLE_TILE_IDS];

// ★ Row config (shared with popup via storage)
let _tilesRowConfig = null;
const DEFAULT_ROW_CONFIG = {
    row1: ['stat-qms','stat-favorites','stat-mentions'],
    row2: ['stat-bookmarks','stat-tickets','stat-radio-inline']
};
const SPAN_MAP = {1:[60],2:[30,30],3:[20,20,20],4:[15,15,15,15],5:[12,12,12,12,12]};

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
        const count = Math.min(visInRow.length, 5);
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
    chrome.storage.local.set({ tiles_order: [..._tilesOrder] });
}

function initTileDragDrop() {
    const container = document.querySelector('.stats-cards');
    if (!container) return;
    let dragSrc = null;
    DRAGGABLE_TILE_IDS.forEach(id => {
        const tile = document.getElementById(id);
        if (!tile) return;
        tile.draggable = true;
        tile.addEventListener('dragstart', (e) => {
            dragSrc = tile;
            tile.classList.add('drag-source');
            e.dataTransfer.effectAllowed = 'move';
        });
        tile.addEventListener('dragend', () => {
            tile.classList.remove('drag-source');
            container.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
            dragSrc = null;
        });
        tile.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (dragSrc && dragSrc !== tile) tile.classList.add('drag-over');
        });
        tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
        tile.addEventListener('drop', (e) => {
            e.preventDefault();
            tile.classList.remove('drag-over');
            if (!dragSrc || dragSrc === tile) return;
            const si = _tilesOrder.indexOf(dragSrc.id);
            const di = _tilesOrder.indexOf(tile.id);
            if (si !== -1 && di !== -1) {
                _tilesOrder.splice(si, 1);
                _tilesOrder.splice(di, 0, dragSrc.id);
            }
            applyTilesOrder();
            saveTilesOrder();
        });
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
    ['stat-tickets', 'stat-bookmarks', 'stat-radio-inline'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.removeProperty('grid-column'); el.style.removeProperty('grid-row'); }
    });
    fillLastTileRow();
}

let _sidebarRadioInitialized = false;
async function initSidebarRadio() {
    try {
        const r = await chrome.storage.local.get(['radio_enabled']);
        if (!r.radio_enabled) return;

        const bar        = document.getElementById('mini-radio-bar');
        const inlineCard = document.getElementById('stat-radio-inline');
        if (!inlineCard) return;

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
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.action === 'radio_state') applyRadioState(msg.state);
        });

        chrome.storage.onChanged.addListener((changes) => {
            if (changes.radio_enabled) {
                if (changes.radio_enabled.newValue) {
                    _sidebarRadioInitialized = false;
                    initSidebarRadio();
                } else {
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
        list.innerHTML = '<div style="padding:12px;text-align:center;font-size:12px;color:var(--text-3);">История пуста</div>';
        return;
    }
    list.innerHTML = history.map(item => {
        const d = new Date(item.ts);
        const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
        const date = d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
        return `<div style="padding:6px 12px;border-bottom:1px solid var(--border-md);display:flex;flex-direction:column;gap:1px;">
            <span style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.track)}</span>
            <span style="font-size:10px;color:var(--text-3);">${escapeHtml(item.station)} · ${date} ${time}</span>
        </div>`;
    }).join('');
}

function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

    listEl.innerHTML = '';
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
            closeSidebarRadioPanel();

            const fresh = await chrome.storage.local.get(['radio_play_counts', 'radio_last_played']);
            const counts = fresh.radio_play_counts || {};
            const lp     = fresh.radio_last_played || {};
            counts[url] = (counts[url] || 0) + 1;
            lp[url]     = Date.now();
            await chrome.storage.local.set({ radio_play_counts: counts, radio_last_played: lp });
            await chrome.storage.local.set({ radio_station: url, radio_station_name: name });
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
            if (dt > 300 || dx > 10 || dy > 10) return;
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
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'radio_state' && _sidebarRspOpen) updateSbPanelSleepStatus(msg.state?.sleepEndsAt);
    });

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
        list.innerHTML = '<div style="padding:10px 12px;text-align:center;font-size:11px;color:var(--text-3);">История пуста</div>';
        return;
    }
    list.innerHTML = history.map(item => {
        const d = new Date(item.ts);
        const time = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
        const date = d.toLocaleDateString('ru', { day: 'numeric', month: 'short' });
        return `<div style="padding:5px 12px;border-bottom:1px solid var(--border-md);display:flex;flex-direction:column;gap:1px;">
            <span style="font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.track || '—')}</span>
            <span style="font-size:10px;color:var(--text-3);">${escapeHtml(item.station || '')} · ${date} ${time}</span>
        </div>`;
    }).join('');
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
    chrome.storage.local.set({ bm_collapsed_folders: [..._collapsedFolders] });
}

function renderBookmarks(bookmarks) {
    const list = elements.bookmarksList;
    if (!list) return;
    list.innerHTML = '';

    // ── Кнопка «+ Добавить» ─────────────────────────────────
    const addLi = document.createElement('li');
    addLi.style.cssText = 'display:flex;justify-content:flex-end;padding:2px 4px 4px;';
    const addBtn = document.createElement('button');
    addBtn.innerHTML = '＋ Добавить';
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
    folderBtn.innerHTML = '📁 Папка';
    folderBtn.title = 'Создать папку';
    folderBtn.style.cssText = 'padding:4px 10px;border-radius:8px;border:1px dashed var(--border-md);background:transparent;color:var(--text-2);font-size:11px;cursor:pointer;';
    folderBtn.addEventListener('click', () => openFolderForm(0));
    addLi.appendChild(addBtn);
    addLi.appendChild(folderBtn);
    list.appendChild(addLi);

    if (!bookmarks || bookmarks.length === 0) {
        list.innerHTML = `<li class="bookmarks-empty" style="text-align:center;padding:32px 16px;color:var(--text-3);font-size:13px;">Закладки не загружены</li>`;
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
            subBtn.innerHTML = '📁+';
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
        confirmRow.innerHTML = `
            <span style="flex:1">Удалить «${bm.title.slice(0,30)}»?</span>
            <button class="bm-confirm-yes" style="padding:3px 10px;border-radius:6px;border:none;background:#e74c3c;color:#fff;font-size:11px;cursor:pointer;">Да</button>
            <button class="bm-confirm-no" style="padding:3px 10px;border-radius:6px;border:1px solid var(--border-md);background:var(--bg-4);color:var(--text-2);font-size:11px;cursor:pointer;">Нет</button>
        `;
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
