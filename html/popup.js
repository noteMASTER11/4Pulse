// Constants
const CLASS_HIDDEN = 'hidden';
const CLASS_ACTIVE = 'active';
const CLASS_READ = 'read';
const CLASS_UNREAD = 'unread';
const CLASS_PINNED = 'pinned';
const CLASS_LOADING = 'loading';

// ── Анимация смены числа в счётчике (flip-down) ──────────────────────────
function animateCounter(el, newValue) {
    if (!el) return;
    const newText = String(newValue);
    if (el.textContent === newText) return;   // уже такое значение — не анимируем

    // Снимаем предыдущую анимацию если ещё идёт
    el.classList.remove('animating-out', 'animating-in');

    // Фаза 1: старое число уезжает вверх
    el.classList.add('animating-out');

    const onOutEnd = () => {
        el.removeEventListener('animationend', onOutEnd);
        el.classList.remove('animating-out');

        // Ставим новое значение и анимируем въезд снизу
        el.textContent = newText;
        el.classList.add('animating-in');

        const onInEnd = () => {
            el.removeEventListener('animationend', onInEnd);
            el.classList.remove('animating-in');
        };
        el.addEventListener('animationend', onInEnd, { once: true });
    };
    el.addEventListener('animationend', onOutEnd, { once: true });
}



// State
let elements = {};
let settings = {
    simple_list: false,
    close_on_open: true,
    default_view: 'favorites',
    show_all_favorites: false,
    show_all_qms: false,
    show_all_mentions: false,
    bw_icons: false,
    mirror_mode: false,
    accent_color: 'purple',
    compact_mode: false,
    show_bookmarks_tab: false,
    primary_click_action: 'forum',   // 'forum' = LMB opens site | 'popup' = LMB opens list
    compact_stats: false,            // horizontal compact stats bar
    compact_hide_qms:       false,
    compact_hide_favorites: false,
    compact_hide_mentions:  false,
    compact_only_stats:     false,
    compact_show_topics:    false,
    max_visible_topics: 0,           // 0 = unlimited; N = limit topic list rows
    show_fav_toolbar:   true,        // показывать тулбар сортировки/группировки
    toolbar_button_open_all:  true,
    toolbar_button_pinned:    true,
    toolbar_button_read_all:  true,
    popup_width: 360,
    popup_width_auto: false,       // ★ auto: растягиваться под контент
    disable_topic_animations: false, // ★ отключить анимацию появления тем
    toolbar_pin_themes_level: 0,
    icon_pack: 'default',              // 'default' | 'emoji' | 'custom'
};
let currentData = null;
let _newTopicIds = new Set();
let _knownTopicIds = new Set();
let _prevTopicIds = new Set();
let currentFilter = null;
let pollInterval = null;   // единственный интервал авторежима
let qmsObserver = null;
let loadingQmsSubjects = new Set();

// 🎯 Focus & 🔕 Mute state (Set<string> of topic IDs)
let focusedTopics = new Set();
let mutedTopics = new Set();

// ── Priority Blink Driver (runs in UI context — reliable setInterval) ──
let _popupBlinkTimer = null;
let _popupBlinkPhase = false;

function startPopupBlink() {
    if (_popupBlinkTimer) return;
    _popupBlinkPhase = false;
    _popupBlinkTimer = setInterval(() => {
        _popupBlinkPhase = !_popupBlinkPhase;
        if (_popupBlinkPhase) {
            // RED — visible against ANY accent color (orange, blue, purple, teal)
            chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
            chrome.action.setBadgeText({ text: '!!' }).catch(() => {});
        } else {
            chrome.action.setBadgeBackgroundColor({ color: '#1A8FFF' }).catch(() => {});
            // Restore real count
            const count = (currentData?.favorites?.count || 0) + (currentData?.qms?.count || 0);
            chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' }).catch(() => {});
        }
    }, 600);
}

function stopPopupBlink() {
    if (_popupBlinkTimer) { clearInterval(_popupBlinkTimer); _popupBlinkTimer = null; }
}

async function checkAndStartBlink() {
    try {
        const s = await chrome.storage.local.get(['priority_blinking']);
        if (s.priority_blinking) startPopupBlink(); else stopPopupBlink();
    } catch(e) {}
}

// Load focus/mute state from storage
async function loadFocusMuteState() {
    try {
        const stored = await chrome.storage.local.get(['focused_topics', 'muted_topics']);
        focusedTopics = new Set((stored.focused_topics || []).map(String));
        mutedTopics   = new Set((stored.muted_topics   || []).map(String));
    } catch(e) { console.warn('loadFocusMuteState:', e); }
}

async function saveFocusedTopics() {
    await chrome.storage.local.set({ focused_topics: [...focusedTopics] });
}

async function saveMutedTopics() {
    await chrome.storage.local.set({ muted_topics: [...mutedTopics] });
}

// Toggle focus for a topic
async function toggleTopicFocus(topicId) {
    const id = String(topicId);
    if (focusedTopics.has(id)) {
        focusedTopics.delete(id);
    } else {
        focusedTopics.add(id);
        mutedTopics.delete(id);
        await saveMutedTopics();
    }
    await saveFocusedTopics();
    const anyFocusedUnread = currentData?.favorites?.list?.some(
        t => !t.viewed && focusedTopics.has(String(t.id))
    );
    if (anyFocusedUnread) {
        // Start blink immediately — don't wait for next poll
        await chrome.storage.local.set({ priority_blinking: true });
        chrome.runtime.sendMessage({ action: 'start_priority_blink' }).catch(() => {});
    } else {
        await chrome.storage.local.set({ priority_blinking: false });
        chrome.runtime.sendMessage({ action: 'stop_priority_blink' }).catch(() => {});
    }
}

// Toggle mute for a topic
async function toggleTopicMute(topicId) {
    const id = String(topicId);
    if (mutedTopics.has(id)) {
        mutedTopics.delete(id);
    } else {
        mutedTopics.add(id);
        focusedTopics.delete(id); // Can't be both focused and muted
        await saveFocusedTopics();
    }
    await saveMutedTopics();
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
    try {
        // 🚀 Setup real-time count updates listener
        setupRealtimeUpdates();

        // 🕐 Initialize clock
        initializeClock();

        // 🎨 Apply theme and colors
        await applyThemeAndColors();

        await initializePopup();

        // 🔤 Apply font settings (ПОСЛЕ initializePopup, когда compact-mode уже установлен)
        await applyFontSettings();
    } catch (error) {
        console.error('Critical error during initialization:', error);
        showErrorState(error.message);
    }
});

// Show error state
function showErrorState(errorMessage) {
    document.body.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #ff4444;">
            <h3>Ошибка загрузки</h3>
            <p>${errorMessage}</p>
            <button onclick="location.reload()" style="margin-top: 10px; padding: 8px 16px; cursor: pointer;">
                Перезагрузить
            </button>
        </div>
    `;
}

// 🔧 FIX: Show login screen when user is not authenticated
function showLoginState() {
    document.body.innerHTML = `
        <div style="padding:24px 20px; text-align:center; display:flex; flex-direction:column; align-items:center; gap:14px;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-3,#888)" stroke-width="1.5">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                <circle cx="12" cy="7" r="4"/>
            </svg>
            <p style="color:var(--text,#fff); font-size:14px; margin:0;">Войдите на 4PDA, чтобы использовать расширение</p>
            <button id="login-btn" style="padding:9px 22px; cursor:pointer; border-radius:8px; border:none; background:var(--accent,#3b82f6); color:#fff; font-size:13px; font-weight:600;">
                Войти на 4PDA
            </button>
        </div>
    `;
    document.getElementById('login-btn')?.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://4pda.to/forum/index.php?act=auth' });
        window.close();
    });
}

// 🚀 Setup real-time count updates from background
function setupRealtimeUpdates() {
    let prevTicketsCount = 0;

    // Отдельный слушатель для мгновенного обновления закладок
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action !== 'ui_update_bookmarks' || !message.data) return;
        const bookmarks = message.data;
        if (!currentData) return;
        if (!currentData.bookmarks) currentData.bookmarks = {};
        currentData.bookmarks.list = bookmarks;

        // Всегда обновляем счётчик в плитке
        const bmCount = bookmarks.filter(b => !b.deleted).length;
        const bmNum = elements.statBookmarks?.querySelector('.stat-number');
        if (bmNum) {
            bmNum.textContent = bmCount;
            bmNum.style.visibility = bmCount > 0 ? 'visible' : 'hidden';
        }

        // Снимаем is-loading со всех строк
        document.querySelectorAll('li.is-loading').forEach(el => el.classList.remove('is-loading'));

        // Перерисовываем список если вкладка закладок открыта,
        // но только если нет активного inline-редактирования или подтверждения удаления
        if (currentFilter === 'bookmarks') {
            const hasActiveEdit = elements.bookmarksList?.querySelector('input')
                               || elements.bookmarksList?.querySelector('.bm-inline-confirm');
            if (!hasActiveEdit) renderBookmarks(bookmarks);
        }
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'counts_updated' && message.counts) {
            const newTickets = message.counts.tickets ?? 0;
            updateCountersFromCounts(message.counts);

            // 🔖 Если фон прислал свежий список тем (WS-загрузка закладок) —
            // обновляем данные и перерисовываем вкладку Favorites если она открыта.
            if (message.favorites_list && currentData?.favorites) {
                currentData.favorites.list  = message.favorites_list;
                currentData.favorites.count = message.counts.favorites;
                if (currentFilter === 'favorites') {
                    renderTopics(currentData.favorites);
                }
            }

            // 🔖 Обновляем данные закладок если пришли в counts_updated.
            // Рендер делает ui_update_bookmarks (приходит одновременно из onBookmarks).
            if (message.bookmarks_list && currentData) {
                if (!currentData.bookmarks) currentData.bookmarks = {};
                currentData.bookmarks.list = message.bookmarks_list;
            }

            // If ticket count changed, refresh the full tickets list from background
            if (newTickets !== prevTicketsCount) {
                prevTicketsCount = newTickets;
                chrome.runtime.sendMessage({ action: 'tickets_refresh' })
                    .then(resp => {
                        if (resp?.list && currentData?.tickets) {
                            currentData.tickets.list  = resp.list;
                            currentData.tickets.count = resp.count;
                            if (currentFilter === 'tickets') renderTickets(resp.list);
                        }
                    }).catch(() => {});
            }
        }
    });

    // Watch priority_blinking flag — start/stop blink in UI context
    checkAndStartBlink();
    chrome.storage.onChanged.addListener((changes) => {
        if (changes.priority_blinking !== undefined) {
            changes.priority_blinking.newValue ? startPopupBlink() : stopPopupBlink();
        }
    });
}

// 🕐 Initialize and update clock
function initializeClock() {
    const timeEl = document.getElementById('current-time');
    const dateEl = document.getElementById('current-date');

    if (!timeEl || !dateEl) return;

    const MONTHS = {
        ru: ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'],
        en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
        de: ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],
        uk: ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'],
    };

    async function updateClock() {
        const now = new Date();

        // Time HH:MM
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        timeEl.textContent = `${hours}:${minutes}`;

        // Date with localized month
        let lang = 'ru';
        try { const r = await chrome.storage.local.get(['ui_language']); lang = r.ui_language || 'ru'; } catch(e){}
        const months = MONTHS[lang] || MONTHS['ru'];
        const day = now.getDate();
        const month = months[now.getMonth()];
        dateEl.textContent = lang === 'de' ? `${day}. ${month}` : `${day} ${month}`;
    }

    // Обновляем сразу
    updateClock();

    // Обновляем каждую минуту (60000 мс)
    setInterval(updateClock, 60000);
}

// 🚀 Update counters from provided counts object
function updateCountersFromCounts(counts) {
    if (currentData) {
        currentData.favorites.count = counts.favorites;
        currentData.qms.count = counts.qms;
        currentData.mentions.count = counts.mentions;
        if (counts.tickets !== undefined && currentData.tickets)
            currentData.tickets.count = counts.tickets;
    }

    const favNumber = elements.statFavorites?.querySelector('.stat-number');
    animateCounter(favNumber, counts.favorites);

    const qmsNumber = elements.statQms?.querySelector('.stat-number');
    animateCounter(qmsNumber, counts.qms);

    const mentNumber = elements.statMentions?.querySelector('.stat-number');
    animateCounter(mentNumber, counts.mentions);

    // 🎫 Tickets counter (only if card is visible)
    if (elements.statTickets && elements.statTickets.style.display !== 'none' && counts.tickets !== undefined) {
        const tikNumber = elements.statTickets.querySelector('.stat-number');
        animateCounter(tikNumber, counts.tickets);
    }
}

// Initialize popup
async function initializePopup() {
    try {
        cacheElements();
        setupEventListeners();
        initBmAddForm();
        initFolderForm();
        showLoading(true);

        // 🎯 Load focus/mute state before rendering
        await loadFocusMuteState();
        await _loadTopicTags();
        await _loadCustomIcons();
        await _loadCollapsedFolders();
        await loadTilesOrder();
    await loadTilesRowConfig();
        await _loadNewTopicIds();

        const response = await sendMessage({ action: 'popup_loaded' });

        if (!response) {
            // 🔧 FIX: Show proper login screen with button to open auth page
            showLoading(false);
            showLoginState();
            return;
        }

        currentData = response;
        settings.simple_list = response.settings.toolbar_simple_list;
        settings.close_on_open = response.settings.toolbar_open_theme_hide;
        settings.default_view = response.settings.toolbar_default_view || 'collapsed';
        settings.show_all_favorites = response.settings.show_all_favorites || false;
        settings.show_all_qms = response.settings.show_all_qms || false;
        settings.show_all_mentions = response.settings.show_all_mentions || false;
        settings.bw_icons = response.settings.bw_icons || false;
        settings.mirror_mode = response.settings.mirror_mode || false;
        settings.accent_color = response.settings.accent_color || 'purple';
        settings.compact_mode = response.settings.compact_mode || false;
        settings.show_bookmarks_tab = response.settings.show_bookmarks_tab || false;
        settings.primary_click_action = response.settings.primary_click_action || 'forum';
        settings.compact_stats          = response.settings.compact_stats          || false;
        settings.compact_hide_qms       = response.settings.compact_hide_qms       || false;
        settings.compact_hide_favorites = response.settings.compact_hide_favorites || false;
        settings.compact_hide_mentions  = response.settings.compact_hide_mentions  || false;
        settings.compact_only_stats     = response.settings.compact_only_stats     || false;
        settings.compact_show_topics    = response.settings.compact_show_topics    || false;
        settings.max_visible_topics        = response.settings.max_visible_topics || 0;
        settings.show_fav_toolbar          = response.settings.show_fav_toolbar ?? true;
        // 🔧 Применяем ширину попапа
        const popupWidth = response.settings.popup_width || 360;
        document.documentElement.style.setProperty('--popup-width', popupWidth + 'px');
        settings.popup_width_auto = response.settings.popup_width_auto || false;
        document.documentElement.classList.toggle('popup-width-auto', !!settings.popup_width_auto);
        settings.disable_topic_animations = response.settings.disable_topic_animations || false;
        document.body.classList.toggle('no-topic-animations', !!settings.disable_topic_animations);
        // 🔧 FIX: Read action-button visibility settings
        settings.toolbar_button_open_all   = response.settings.toolbar_button_open_all  ?? true;
        settings.toolbar_button_pinned     = response.settings.toolbar_button_pinned    ?? true;
        settings.toolbar_button_read_all   = response.settings.toolbar_button_read_all  ?? true;
        settings.toolbar_pin_themes_level  = response.settings.toolbar_pin_themes_level ?? 0;
        settings.icon_pack                 = response.settings.icon_pack || 'default';
        // Fallback: read icon_pack directly from storage if bg didn't include it
        if (!response.settings.icon_pack) {
            chrome.storage.local.get('icon_pack').then(r => {
                if (r.icon_pack) { settings.icon_pack = r.icon_pack; }
            });
        }

        // 🔖 Show/hide bookmarks tile + tab
        applyBookmarksVisibility(settings.show_bookmarks_tab);


        // 🎨 Apply B&W icons
        if (settings.bw_icons) {
            document.body.classList.add('bw-icons');
        } else {
            document.body.classList.remove('bw-icons');
        }

        // 🪞 Mirror mode
        document.body.classList.toggle('mirror-mode', !!settings.mirror_mode);
        if (settings.mirror_mode) document.getElementById('mirror-toggle')?.classList.add('active');

        // 🎨 Apply accent color via data attribute
        document.body.setAttribute('data-accent', settings.accent_color);

        // 🎨 Apply compact mode
        if (settings.compact_mode) {
            document.body.classList.add('compact-mode');
            document.getElementById('compact-toggle')?.classList.add('active');
        }

        // 📊 Apply compact stats
        document.body.classList.toggle('compact-stats-mode', !!settings.compact_stats);
        applyCompactStatsTiles();
        applyCompactOnlyStats();

        renderPopup(response);
        applyTilesOrder();
        initTileDragDrop();
        showLoading(false);
        applyGlobalIconPack(); // 🖼️ Apply icon pack to all UI elements
        startPolling();
        await restoreAutoModeIfNeeded();

        // 🔧 FIX: If SW just restarted, data may be stale (all zeros).
        // Trigger a background refresh immediately so counters update quickly.
        const allZero = response.favorites.count === 0 &&
                        response.qms.count === 0 &&
                        response.mentions.count === 0;
        if (allZero) {
            setTimeout(async () => {
                try {
                    await sendMessage({ action: 'force_update' });
                    const fresh = await sendMessage({ action: 'popup_loaded' });
                    if (fresh) {
                        currentData = fresh;
                        renderTopics(fresh.favorites);
                        renderQMS(fresh.qms);
                        renderMentions(fresh.mentions);
                        updateStats(fresh);
                        const usernameText = elements.username.querySelector('.user-name-text');
                        if (usernameText && fresh.user_name) usernameText.textContent = fresh.user_name;
                        const userAvatar = document.getElementById('user-avatar');
                        if (userAvatar && fresh.user_avatar_url) {
                            userAvatar.src = fresh.user_avatar_url;
                            userAvatar.onload = () => { userAvatar.style.display = 'block'; document.querySelector('.user-icon-fallback')?.style?.setProperty('display','none'); };
                        }
                        if (currentFilter) filterTopics(currentFilter); else collapsePopup();
                    }
                } catch (e) { /* silent — popup may already be closed */ }
            }, 300);
        }

    } catch (error) {
        console.error('❌ Failed to initialize popup:', error);
        showErrorState(`Не удалось загрузить данные: ${error.message}`);
    }
}

// 🎨 Listen for settings changes from storage
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local') {
        // 📐 Ширина окна — применяем динамически
        if (changes.popup_width !== undefined) {
            const w = changes.popup_width.newValue || 360;
            document.documentElement.style.setProperty('--popup-width', w + 'px');
        }
        if (changes.tiles_row_config !== undefined) {
            _tilesRowConfig = changes.tiles_row_config.newValue?.row1 ? changes.tiles_row_config.newValue : null;
            applyTilesOrder();
        }
        if (changes.popup_width_auto !== undefined) {
            settings.popup_width_auto = changes.popup_width_auto.newValue;
            document.documentElement.classList.toggle('popup-width-auto', !!settings.popup_width_auto);
        }
        if (changes.disable_topic_animations !== undefined) {
            settings.disable_topic_animations = changes.disable_topic_animations.newValue;
            document.body.classList.toggle('no-topic-animations', !!settings.disable_topic_animations);
        }

        // Update accent color dynamically
        if (changes.accent_color) {
            const newColor = changes.accent_color.newValue;
            document.body.setAttribute('data-accent', newColor);
            settings.accent_color = newColor;
        }

        // Update B&W icons dynamically
        if (changes.mirror_mode !== undefined) {
                settings.mirror_mode = changes.mirror_mode.newValue;
                document.body.classList.toggle('mirror-mode', !!settings.mirror_mode);
            }
        if (changes.bw_icons) {
            const bwEnabled = changes.bw_icons.newValue;

            if (bwEnabled) {
                document.body.classList.add('bw-icons');
            } else {
                document.body.classList.remove('bw-icons');
            }
            settings.bw_icons = bwEnabled;
        }

        // Update font settings dynamically
        if (changes.font_family || changes.font_size || changes.line_height) {
            applyFontSettings();
        }

        // Update theme dynamically
        if (changes.theme_mode) {
            applyThemeSettings();
        }

        // 🔖 Bookmarks tab visibility
        if (changes.show_bookmarks_tab !== undefined) {
            settings.show_bookmarks_tab = changes.show_bookmarks_tab.newValue;
            applyBookmarksVisibility(settings.show_bookmarks_tab);
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
        // 🔀 Compact mode toggle (кнопка в хедере попапа)
        if (changes.compact_mode !== undefined) {
            settings.compact_mode = changes.compact_mode.newValue;
            document.body.classList.toggle('compact-mode', !!settings.compact_mode);
            document.getElementById('compact-toggle')?.classList.toggle('active', !!settings.compact_mode);
            applyFontSettings();
        }
        // 🔧 Тулбар сортировки — перерисовываем список тем
        if (changes.show_fav_toolbar !== undefined) {
            settings.show_fav_toolbar = changes.show_fav_toolbar.newValue;
            if (currentData?.favorites) renderTopics(currentData.favorites);
        }
        // 📊 Compact stats tile visibility
        if (changes.compact_stats !== undefined || changes.compact_hide_qms !== undefined ||
            changes.compact_hide_favorites !== undefined || changes.compact_hide_mentions !== undefined ||
            changes.compact_only_stats !== undefined) {
            if (changes.compact_stats !== undefined) {
                settings.compact_stats = changes.compact_stats.newValue;
                document.body.classList.toggle('compact-stats-mode', !!settings.compact_stats);
                if (!settings.compact_stats) {
                    // Выходим из compact — сбрасываем возможные инлайн-стили
                    const statsCards = document.querySelector('.stats-cards');
                    if (statsCards) {
                        statsCards.style.removeProperty('grid-template-columns');
                        statsCards.style.removeProperty('grid-template-rows');
                        statsCards.style.removeProperty('grid-auto-flow');
                    }
                    ['stat-qms','stat-favorites','stat-mentions',
                     'stat-tickets','stat-bookmarks','stat-radio-inline'].forEach(id => {
                        const el = document.getElementById(id);
                        if (el) { el.style.removeProperty('grid-column'); el.style.removeProperty('grid-row'); }
                    });
                    recalcRow2Layout();
                    applyTilesOrder(); // восстанавливаем порядок плиток после выхода из compact
                }
            }
            if (changes.compact_hide_qms       !== undefined) settings.compact_hide_qms       = changes.compact_hide_qms.newValue;
            if (changes.compact_hide_favorites !== undefined) settings.compact_hide_favorites = changes.compact_hide_favorites.newValue;
            if (changes.compact_hide_mentions  !== undefined) settings.compact_hide_mentions  = changes.compact_hide_mentions.newValue;
            if (changes.compact_only_stats     !== undefined) settings.compact_only_stats     = changes.compact_only_stats.newValue;
            if (changes.compact_show_topics    !== undefined) settings.compact_show_topics    = changes.compact_show_topics.newValue;
            applyCompactStatsTiles();
            applyCompactOnlyStats();
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

        // 🖼️ Re-render ALL lists + UI icons when icon pack changes
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
    }
});

// Cache DOM elements
function cacheElements() {
    elements = {
        main: document.querySelector('main'),
        username: document.getElementById('user-name'),
        refresh: document.getElementById('refresh'),
        options: document.getElementById('options'),
        statQms: document.getElementById('stat-qms'),
        statFavorites: document.getElementById('stat-favorites'),
        statMentions: document.getElementById('stat-mentions'),
        statTickets: document.getElementById('stat-tickets'),
        statBookmarks: document.getElementById('stat-bookmarks'),
        themeActions: document.getElementById('theme-actions'),
        openAll: document.getElementById('themes-open-all'),
        openPinned: document.getElementById('themes-open-all-pin'),
        readAll: document.getElementById('themes-read-all'),
        loadingSkeleton: document.getElementById('loading-skeleton'),
        emptyState: document.getElementById('empty-state'),
        emptyTitle: document.getElementById('empty-title'),
        topicsList: document.getElementById('topic-list'),
        qmsList: document.getElementById('qms-list'),
        mentionsList: document.getElementById('mentions-list'),
        ticketsList: document.getElementById('tickets-list'),
        bookmarksList: document.getElementById('bookmarks-list'),
        bmAddForm:       document.getElementById('bm-add-form'),
        bmAddTitle:      document.getElementById('bm-add-title'),
        bmAddUrl:        document.getElementById('bm-add-url'),
        bmAddSubmit:     document.getElementById('bm-add-submit'),
        bmAddCancel:     document.getElementById('bm-add-cancel'),
        bmGetNewpost:    document.getElementById('bm-getnewpost'),
        bmGetNewpostRow: document.getElementById('bm-getnewpost-row'),
        lastUpdateTime: document.getElementById('last-update-time'),
        refreshBtn: document.getElementById('refresh-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        mirrorToggle:   document.getElementById('mirror-toggle'),
        topicTemplate: document.getElementById('tpl-topic-card'),
        topicTemplateSimple: document.getElementById('tpl-topic-card-simple')
    };
}

// Setup event listeners
function setupEventListeners() {
    elements.username.addEventListener('click', () => openTab('user'));
    elements.refresh.addEventListener('click', handleRefreshClick);
    elements.options.addEventListener('click', () => openTab('options'));

    // Compact mode toggle
    const compactToggle = document.getElementById('compact-toggle');
    if (compactToggle) {
        compactToggle.addEventListener('click', toggleCompactMode);
    }

    // 🪞 Mirror toggle — прямо в попапе
    document.getElementById('mirror-toggle')?.addEventListener('click', () => {
        settings.mirror_mode = !settings.mirror_mode;
        document.body.classList.toggle('mirror-mode', settings.mirror_mode);
        document.getElementById('mirror-toggle')?.classList.toggle('active', settings.mirror_mode);
        chrome.storage.local.set({ mirror_mode: settings.mirror_mode });
    });

    elements.statQms.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isForumMode = settings.primary_click_action !== 'popup';
        const isModified = e.shiftKey || e.ctrlKey || e.metaKey;

        if (isForumMode ? isModified : !isModified) {
            // Secondary action → show list in popup
            toggleFilter('qms');
        } else {
            // Primary action → open site
            openTab('qms');
        }
    });

    elements.statFavorites.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isForumMode = settings.primary_click_action !== 'popup';
        const isModified = e.shiftKey || e.ctrlKey || e.metaKey;

        if (isForumMode ? isModified : !isModified) {
            toggleFilter('favorites');
        } else {
            openTab('favorites');
        }
    });

    elements.statMentions.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isForumMode = settings.primary_click_action !== 'popup';
        const isModified = e.shiftKey || e.ctrlKey || e.metaKey;

        if (isForumMode ? isModified : !isModified) {
            toggleFilter('mentions');
        } else {
            openTab('mentions');
        }
    });

    // 🎫 Tickets stat card
    elements.statTickets?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const isForumMode = settings.primary_click_action !== 'popup';
        const isModified = e.shiftKey || e.ctrlKey || e.metaKey;

        if (isForumMode ? isModified : !isModified) {
            toggleFilter('tickets');
        } else {
            openTab('ticket');
        }
    });

    // 🔖 Bookmarks stat card — always opens list on LMB, forum on Shift
    elements.statBookmarks?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) {
            openTab('bookmarks');
        } else {
            toggleFilter('bookmarks');
        }
    });

    elements.refreshBtn?.addEventListener('click', () => refreshData());
    elements.settingsBtn?.addEventListener('click', () => openTab('options'));
}

// Setup action buttons (batch operations)
function setupActionButtons() {
    // 🔧 FIX: Apply visibility from settings
    const showOpenAll = settings.toolbar_button_open_all ?? true;
    const showPinned  = settings.toolbar_button_pinned   ?? true;
    const showReadAll = settings.toolbar_button_read_all ?? true;
    if (elements.openAll)    elements.openAll.style.display    = showOpenAll ? '' : 'none';
    if (elements.openPinned) elements.openPinned.style.display = showPinned  ? '' : 'none';
    if (elements.readAll)    elements.readAll.style.display    = showReadAll ? '' : 'none';
    if (elements.themeActions) {
        elements.themeActions.style.display = (showOpenAll || showPinned || showReadAll) ? '' : 'none';
    }

    if (elements.openAll) {
        elements.openAll.onclick = () => {
            const port = createPort('themes-open-all');
            if (settings.close_on_open) {
                window.close();
            }
        };
    }

    if (elements.openPinned) {
        elements.openPinned.onclick = () => {
            const port = createPort('themes-open-all-pin');
            if (settings.close_on_open) {
                window.close();
            }
        };
    }

    if (elements.readAll) {
        elements.readAll.onclick = () => {
            const port = createPort('themes-read-all');
        };
    }
}

// Toggle filter with collapse functionality
function toggleFilter(type) {
    try {
        if (currentFilter === type) {
            collapsePopup();
            return;
        }
        filterTopics(type);
    } catch (error) {
        console.error('Error in toggleFilter:', error);
    }
}

// Collapse popup (hide all lists, show only stats)
function collapsePopup() {
    currentFilter = null;
    hideElement(elements.main);

    // Close radio panel if open
    if (_rspOpen) {
        _rspOpen = false;
        const rPanel = document.getElementById('radio-station-panel');
        const rTile  = document.getElementById('stat-radio-inline');
        if (rPanel) rPanel.style.display = 'none';
        rTile?.classList.remove('active');
    }

    if (currentData) {
        updateStats(currentData);
    }

    // Уменьшаем высоту при коллапсе
    setTimeout(() => {
        const header   = document.querySelector('header');
        const radioBar = document.getElementById('mini-radio-bar');
        const radioBarH = (radioBar && radioBar.style.display !== 'none') ? radioBar.offsetHeight : 0;
        if (header) {
            const headerHeight = header.offsetHeight;
            document.body.style.height = `${headerHeight + radioBarH + 20}px`;
            document.body.style.minHeight = `${headerHeight + radioBarH + 20}px`;
        }
    }, 100);
}

// Filter topics
function filterTopics(type) {
    try {
        currentFilter = type;

        // Close radio station panel when switching to a regular filter
        if (_rspOpen) closeRadioPanel();

        if (type === 'favorites') {
            showElement(elements.topicsList);
            hideElement(elements.qmsList);
            hideElement(elements.mentionsList);
            hideElement(elements.ticketsList);
            hideElement(elements.bookmarksList);
            showElement(elements.themeActions);

            let hasVisibleItems = false;
            if (currentData.favorites.list && currentData.favorites.list.length > 0) {
                if (settings.show_all_favorites) {
                    hasVisibleItems = true;
                } else {
                    hasVisibleItems = currentData.favorites.list.some(f => !f.viewed);
                }
            }

            if (!hasVisibleItems) {
                showEmptyState(true, 'Все темы прочитаны');
                // FIX: keep themeActions visible even when all topics are read
            } else {
                showEmptyState(false);
            }
        } else if (type === 'qms') {
            hideElement(elements.topicsList);
            showElement(elements.qmsList);
            hideElement(elements.mentionsList);
            hideElement(elements.ticketsList);
            hideElement(elements.bookmarksList);
            // FIX: themeActions always visible

            let hasVisibleItems = false;
            if (currentData.qms.list && currentData.qms.list.length > 0) {
                if (settings.show_all_qms) {
                    hasVisibleItems = true;
                } else {
                    hasVisibleItems = currentData.qms.list.some(d => d.unread && !d.viewed);
                }
            } else {
            }

            if (!hasVisibleItems) {
                showEmptyState(true, 'Нет новых сообщений');
            } else {
                showEmptyState(false);
            }
        } else if (type === 'mentions') {
            hideElement(elements.topicsList);
            hideElement(elements.qmsList);
            showElement(elements.mentionsList);
            hideElement(elements.ticketsList);
            hideElement(elements.bookmarksList);
            // FIX: themeActions always visible

            let hasVisibleItems = false;
            if (currentData.mentions.list && currentData.mentions.list.length > 0) {
                if (settings.show_all_mentions) {
                    hasVisibleItems = true;
                } else {
                    hasVisibleItems = currentData.mentions.list.some(m => m.unread && !m.viewed);
                }
            }

            if (!hasVisibleItems) {
                showEmptyState(true, 'Нет новых ответов');
            } else {
                showEmptyState(false);
            }
        } else if (type === 'tickets') {
            hideElement(elements.topicsList);
            hideElement(elements.qmsList);
            hideElement(elements.mentionsList);
            showElement(elements.ticketsList);
            hideElement(elements.bookmarksList);

            const hasTickets = currentData.tickets?.list?.length > 0;
            if (!hasTickets) {
                showEmptyState(true, 'Нет тикетов');
            } else {
                showEmptyState(false);
                renderTickets(currentData.tickets.list);
            }
        } else if (type === 'bookmarks') {
            hideElement(elements.topicsList);
            hideElement(elements.qmsList);
            hideElement(elements.mentionsList);
            hideElement(elements.ticketsList);
            showElement(elements.bookmarksList);
            hideElement(elements.themeActions);

            const bmList = currentData?.bookmarks?.list;
            if (!bmList || bmList.length === 0) {
                showEmptyState(true, 'Закладки не загружены');
            } else {
                showEmptyState(false);
                renderBookmarks(bmList);
            }
        }

        updateStats(currentData);
        showElement(elements.main);

        // Применяем правило скролла к новому видимому списку
        const newVisibleList = elements.main.querySelector('.topics-list:not(.hidden)');
        if (newVisibleList) applyScrollRule(newVisibleList);

        // Пересчитываем высоту после смены фильтра
        setTimeout(() => adjustPopupHeight(), 100);
    } catch (error) {
        console.error('Error in filterTopics:', error);
    }
}

// Render popup
function renderPopup(data) {
    const usernameText = elements.username.querySelector('.user-name-text');
    if (usernameText) {
        usernameText.textContent = data.user_name;
    }

    const userAvatar = document.getElementById('user-avatar');
    const userIconFallback = elements.username.querySelector('.user-icon-fallback');

    if (userAvatar && data.user_avatar_url) {
        userAvatar.src = data.user_avatar_url;

        // Показываем аватар и скрываем иконку при успешной загрузке
        userAvatar.onload = function() {
            this.style.display = 'block';
            if (userIconFallback) {
                userIconFallback.style.display = 'none';
            }
        };

        // Показываем иконку если аватар не загрузился
        userAvatar.onerror = function() {
            this.style.display = 'none';
            if (userIconFallback) {
                userIconFallback.style.display = 'inline-block';
            }
        };
    }

    renderTopics(data.favorites);
    renderQMS(data.qms);
    renderMentions(data.mentions);

    setupActionButtons();
    updateStats(data);

    if (settings.default_view === 'collapsed') {
        collapsePopup();
    } else {
        filterTopics(settings.default_view);
    }

    updateLastUpdateTime();
}

// Update stats
function updateStats(data) {
    animateCounter(elements.statFavorites.querySelector('.stat-number'), data.favorites.count);
    updateSummaryBar();
    animateCounter(elements.statQms.querySelector('.stat-number'), data.qms.count);
    animateCounter(elements.statMentions.querySelector('.stat-number'), data.mentions.count);

    // 🔖 Bookmarks counter — количество активных (не удалённых) закладок
    if (elements.statBookmarks && data.bookmarks?.list) {
        const bmCount = data.bookmarks.list.filter(b => !b.deleted).length;
        const bmNum = elements.statBookmarks.querySelector('.stat-number');
        if (bmNum) { bmNum.textContent = bmCount; bmNum.style.visibility = bmCount > 0 ? 'visible' : 'hidden'; }
    }

    // 🎫 Tickets stat card visibility + count
    if (data.tickets?.enabled && elements.statTickets) {
        elements.statTickets.style.display = '';
        animateCounter(elements.statTickets.querySelector('.stat-number'), data.tickets.count);
    } else if (elements.statTickets) {
        elements.statTickets.style.display = 'none';
    }
    // 🔧 FIX: Always recalc row-2 grid after any visibility change
    recalcRow2Layout();
    // 🎵 Always (re-)sync radio state so tile shows in both modes
    // NOTE: do NOT reset _miniRadioInitialized — that causes duplicate
    // pointerup handlers which toggle the panel an even number of times → no-op.
    syncMiniRadioState();
    // Fluid Logic 2026: breathing icon when QMS has unread
    if (elements.statQms) {
        elements.statQms.dataset.hasUnread = data.qms.count > 0 ? 'true' : 'false';
    }

    elements.statFavorites.classList.remove(CLASS_ACTIVE);
    elements.statQms.classList.remove(CLASS_ACTIVE);
    elements.statMentions.classList.remove(CLASS_ACTIVE);
    elements.statTickets?.classList.remove(CLASS_ACTIVE);
    elements.statBookmarks?.classList.remove(CLASS_ACTIVE);
    // Radio active state is managed by openRadioPanel/closeRadioPanel,
    // but we clear it here when a non-radio filter is active
    if (currentFilter && currentFilter !== 'radio') {
        document.getElementById('stat-radio-inline')?.classList.remove(CLASS_ACTIVE);
    }

    if (currentFilter === 'favorites') {
        elements.statFavorites.classList.add(CLASS_ACTIVE);
    } else if (currentFilter === 'qms') {
        elements.statQms.classList.add(CLASS_ACTIVE);
    } else if (currentFilter === 'mentions') {
        elements.statMentions.classList.add(CLASS_ACTIVE);
    } else if (currentFilter === 'tickets') {
        elements.statTickets?.classList.add(CLASS_ACTIVE);
    } else if (currentFilter === 'bookmarks') {
        elements.statBookmarks?.classList.add(CLASS_ACTIVE);
    }
}

// Render Topics list
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

// ══════════════════════════════════════════════════════
// 🎨 ICON PACKS — keyword-based topic icons
// ══════════════════════════════════════════════════════

// ── Global UI icons: element id → emoji (applied when pack ≠ default) ──
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

/**
 * Apply or remove global icon pack to ALL UI elements.
 * Emoji → data-emoji attr + CSS ::before.
 * Image URLs → data-emoji-img attr + CSS background-image on ::before.
 */
function applyGlobalIconPack() {
    const pack = settings.icon_pack || 'default';
    const active = pack !== 'default';

    document.body.classList.toggle('icon-pack-active', active);

    for (const [id, emoji] of Object.entries(UI_ICONS_EMOJI)) {
        const el = document.getElementById(id);
        if (!el) continue;

        // Clean up previous state
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

// Built-in emoji icon pack: keyword patterns → emoji
const ICON_PACK_EMOJI = [
    // ── Apple ecosystem ──
    { keys: ['iphone','ipad','apple','ios ','ipod','airpods','apple watch','macbook','macos','mac os','homepod','apple tv','vision pro','siri'], icon: '🍎' },
    // ── Android ──
    { keys: ['android','aosp','lineageos','grapheneos','calyxos'], icon: '🤖' },
    // ── Samsung ──
    { keys: ['samsung','galaxy','one ui','oneui','good lock','tizen','dex '], icon: '📱' },
    // ── Xiaomi family ──
    { keys: ['xiaomi','redmi','poco','miui','hyperos','mi band','mi pad','mi tv','roborock'], icon: '📱' },
    // ── Huawei / Honor ──
    { keys: ['huawei','honor','harmonyos','emui','hms','hisilicon','kirin'], icon: '📱' },
    // ── Google ──
    { keys: ['google','pixel','chromecast','nest','tensor','wear os'], icon: '🔍' },
    // ── OnePlus / Nothing / CMF ──
    { keys: ['oneplus','oxygen','nothing phone','nothing ear','cmf phone','cmf buds'], icon: '📱' },
    // ── Other phone brands ──
    { keys: ['realme','oppo','vivo','motorola','moto ','nokia','zte','meizu','asus zenfone','asus rog phone','sony xperia','lg ','htc','lenovo','tecno','infinix','itel','iqoo','nubia','red magic','black shark','fairphone','cat phone'], icon: '📱' },
    // ── Rugged / China brands ──
    { keys: ['doogee','ulefone','oukitel','blackview','agm ','umidigi','cubot','hotwav','oscal','fossibot','unihertz'], icon: '📱' },
    // ── Windows / PC ──
    { keys: ['windows','microsoft','surface','directx','wsl ','powershell','реестр','bios','uefi'], icon: '🖥️' },
    // ── Linux ──
    { keys: ['linux','ubuntu','arch','fedora','debian','mint ','manjaro','opensuse','gentoo','docker','терминал'], icon: '🐧' },
    // ── Games ──
    { keys: ['игр','game','playstation','ps5','ps4','ps3','nintendo','switch','steam','steam deck','xbox','геймпад','gamepad','joystick','эмулятор','emulator','genshin','pubg','fortnite','call of duty','майнкрафт','minecraft','roblox','gta','valorant'], icon: '🎮' },
    // ── Apps / Software ──
    { keys: ['программ','приложен','app','soft','browser','браузер','антивирус','менеджер','launcher','лаунчер','клавиатур','keyboard','gboard','swiftkey'], icon: '📦' },
    // ── Telegram / Messengers ──
    { keys: ['telegram','телеграм','whatsapp','viber','signal','discord','ватсап','мессенджер','messenger'], icon: '💬' },
    // ── Social media ──
    { keys: ['instagram','tiktok','youtube','вконтакте','vk ','twitter',' x.com','reddit','facebook','одноклассн','дзен','rutube','twitch'], icon: '🌐' },
    // ── Firmware / ROM / Root ──
    { keys: ['прошивк','rom ','firmware','root','twrp','magisk','unlock','bootloader','кастом','recovery','модуль','xposed','lsposed','kernelsu','shizuku','adb '], icon: '⚡' },
    // ── Audio / Music ──
    { keys: ['наушник','колонк','headphone','speaker','audio','звук','музык','плеер','саундбар','soundbar','усилител','dac ','цап','hi-fi','hifi','equalizer','эквалайзер','spotify','яндекс музык','apple music','flac','bluetooth audio','airpods','buds','pods','tws','earbuds'], icon: '🎵' },
    // ── Camera / Photo / Video ──
    { keys: ['камер','фото','photo','camera','gopro','видео','video','gcam','объектив','штатив','стабилизат','gimbal','дрон','drone','квадрокоптер','dji','mavic','экшн-камер','action cam','insta360','видеомонтаж'], icon: '📷' },
    // ── Smart home / IoT ──
    { keys: ['умный дом','smart home','iot','датчик','робот-пылесос','пылесос','лампа','розетка','алиса','яндекс станц','home assistant','zigbee','z-wave','tuya','aqara','sonoff','термостат','увлажнител','очиститель воздух','кондиционер'], icon: '🏠' },
    // ── Watches / Wearables ──
    { keys: ['часы','watch','band','браслет','фитнес','garmin','amazfit','huawei watch','galaxy watch','mi band','трекер','шагомер','пульсометр','suunto','polar','coros','haylou','ticwatch'], icon: '⌚' },
    // ── Cars / Transport ──
    { keys: ['авто','car','tesla','навигат','видеорегистратор','dvr','obd','elm327','android auto','carplay','автозвук','магнитол','парктроник','антирадар','радар-детектор','зарядк.*авто','самокат','электросамокат','электровелосипед','моноколес','гироскутер','сигвей','ninebot'], icon: '🚗' },
    // ── Network / WiFi / Router ──
    { keys: ['роутер','router','wifi','wi-fi','сеть','network','dns','nas','mikrotik','keenetic','tp-link','asus router','mesh','openwrt','adguard','pihole','прокси','proxy','модем','modem','4g ','5g ','lte ','сим-карт','sim ','esim','мтс','билайн','мегафон','теле2','yota'], icon: '📡' },
    // ── Tablets ──
    { keys: ['планшет','tablet','pad ','galaxy tab','mi pad','matepad','lenovo tab','teclast','alldocube'], icon: '📟' },
    // ── TV / Streaming / Set-top boxes ──
    { keys: ['телевиз','tv ','smart tv','iptv','chromecast','fire stick','roku','kodi','приставк','tv box','mi box','apple tv','nvidia shield','проектор','projector','beamer','медиаплеер','plex','emby','jellyfin'], icon: '📺' },
    // ── Laptop / Notebook ──
    { keys: ['ноутбук','laptop','notebook','thinkpad','macbook','chromebook','ультрабук','ultrabook','ideapad','vivobook','zenbook','swift ','aspire','pavilion','legion','predator','omen','razer blade','framework'], icon: '💻' },
    // ── E-readers / E-books ──
    { keys: ['читалк','ebook','e-book','e-ink','kindle','pocketbook','onyx boox','электронная книг','kobo','remarkable'], icon: '📖' },
    // ── Storage / Memory ──
    { keys: ['ssd','hdd','накопител','флешк','flash drive','microsd','sd карт','карта памяти','жёсткий диск','жесткий диск','nvme','usb drive','внешний диск','raid ','nas '], icon: '💾' },
    // ── GPU / CPU / PC components ──
    { keys: ['видеокарт','gpu','nvidia','geforce','radeon','amd','rtx ','gtx ','процессор','cpu','intel','ryzen','материнск','motherboard','оперативн','ram ','блок питан','psu','корпус пк','кулер','cooler','вентилятор'], icon: '🔧' },
    // ── Peripherals / Accessories ──
    { keys: ['мышь','мышк','mouse','клавиатур','keyboard','монитор','monitor','дисплей','display','принтер','printer','сканер','scanner','вебкамер','webcam','микрофон','microphone','стилус','stylus','графическ планшет','wacom','док-станц','dock','hub','хаб','кабел','провод','адаптер','adapter','переходник','usb-c','type-c','hdmi','конвертер'], icon: '🖱️' },
    // ── Power / Batteries / Charging ──
    { keys: ['аккумулят','батаре','battery','powerbank','power bank','зарядк','charger','беспроводн.*заряд','wireless charg','qi ','magsafe','gan ','pd ','быстрая заряд'], icon: '🔋' },
    // ── Cases / Protection ──
    { keys: ['чехол','case','бампер','bumper','плёнк','пленк','screen protector','защитн.*стекл','tempered glass','кейс'], icon: '🛡️' },
    // ── VR / AR ──
    { keys: ['vr ','виртуальн.*реальн','quest','oculus','meta quest','psvr','htc vive','ar ','дополнен.*реальн','очки vr'], icon: '🥽' },
    // ── Cryptocurrency / Finance ──
    { keys: ['крипт','crypto','bitcoin','биткоин','ethereum','майнинг','mining','кошелёк.*крипт','nft','blockchain','блокчейн','трейдинг','trading','банк','сбербанк','тинькофф','альфа-банк'], icon: '💰' },
    // ── Security / Privacy ──
    { keys: ['безопасн','security','vpn','шифрован','encrypt','пароль','password','2fa','двухфактор','антивирус','firewall','приватн','privacy','tor ','wireguard'], icon: '🔒' },
    // ── Development / Programming ──
    { keys: ['програм.*разработ','developer','разработк','github','git ','python','java ','kotlin','swift ','flutter','react','node.js','api ','sdk','ide ','android studio','xcode','visual studio','vscode','код ','code ','скрипт','script'], icon: '👨‍💻' },
    // ── AI / Neural networks ──
    { keys: ['нейросет','нейронн','ai ','искусствен.*интеллект','chatgpt','gpt','midjourney','stable diffusion','llm','copilot','gemini','claude','машинн.*обучен'], icon: '🧠' },
    // ── Maps / Navigation ──
    { keys: ['карт.*навигац','навигатор','яндекс карт','google map','2gis','дубльгис','waze','maps','gps','глонасс','openstreetmap'], icon: '🗺️' },
    // ── Weather ──
    { keys: ['погод','weather','метео','барометр'], icon: '🌤️' },
    // ── Health / Medical ──
    { keys: ['здоровь','health','медицин','давлен.*крови','пульсоксиметр','глюкометр','термометр','лекарств','аптек','трекер здоровья','калори','диет'], icon: '❤️‍🩹' },
    // ── Sports / Fitness ──
    { keys: ['спорт','sport','тренировк','workout','фитнес.*приложен','strava','nike run','adidas','велокомпьютер','велосипед','бег ','running'], icon: '🏃' },
    // ── Education / Languages ──
    { keys: ['обучен','учёб','учеб','education','курс','язык.*изучен','duolingo','словар','переводчик','translator','english','репетитор'], icon: '🎓' },
    // ── Torrent / Download ──
    { keys: ['торрент','torrent','magnet','раздач','загрузчик','download manager','aria2','rutracker','rutor'], icon: '⬇️' },
    // ── Personalization / Themes ──
    { keys: ['обои','wallpaper','тем.*оформлен','лаунчер.*тем','icon pack','иконки.*пак','виджет','widget','kwgt','klwp','rainmeter','кастомизац','рингтон','ringtone','шрифт.*систем'], icon: '🎨' },
    // ── File managers / Utilities ──
    { keys: ['файловый менеджер','file manager','проводник','explorer','архиватор','zip ','rar ','7z ','total commander','solid explorer','mixplorer','fx файл'], icon: '📁' },
    // ── Discussions / Offtopic ──
    { keys: ['офтоп','оффтоп','обсужден','discuss','болтал','чат','chat','флудилк','курилк'], icon: '💬' },
    // ── Knowledge / FAQ ──
    { keys: ['faq','база знаний','wiki','справк','инструкц','guide','howto','how to','шапка темы','мануал','туториал','tutorial'], icon: '📚' },
    // ── Commerce / Deals ──
    { keys: ['купить','продать','продаж','цена','скидк','aliexpress','купон','промокод','халява','распродаж','чёрная пятниц','черная пятниц','ozon','wildberries','wb ','яндекс маркет','dns ','ситилинк','avito','авито'], icon: '🛒' },
    // ── Repair / DIY ──
    { keys: ['ремонт','repair','разбор','teardown','замена экран','замена батаре','замена аккумулят','пайк','soldering','запчаст','ifix','ifixit'], icon: '🔨' },
    // ── 3D Printing ──
    { keys: ['3d принт','3d печат','3d print','ender','creality','prusa','filament','пластик.*печат','stl ','слайсер','slicer','cura'], icon: '🖨️' },
    // ── Servers / Hosting ──
    { keys: ['сервер','server','хостинг','hosting','vps','vds','выделенн','dedicated','домен','domain','ssl','nginx','apache','cloudflare'], icon: '🖧' },
    // ── Backup / Sync ──
    { keys: ['бэкап','бекап','backup','резервн.*копи','синхрониз','sync','облак','cloud','google drive','яндекс диск','dropbox','onedrive','icloud','nextcloud'], icon: '☁️' },
    // ── Email ──
    { keys: ['почт.*электрон','email','e-mail','gmail','outlook','mail.ru','яндекс почт','thunderbird','smtp','imap'], icon: '📧' },
    // ── News / RSS ──
    { keys: ['новост','news','rss','лента','feed','агрегатор','flipboard'], icon: '📰' },
];

let _customIconMap = null; // loaded from storage: { keyword: iconUrlOrEmoji, ... }

async function _loadCustomIcons() {
    try {
        const r = await chrome.storage.local.get('custom_icon_pack');
        _customIconMap = r.custom_icon_pack || {};
    } catch(_) {
        _customIconMap = {};
    }
}

/**
 * Resolve topic title → icon (emoji string or image URL).
 * Returns { type: 'emoji'|'img'|'svg', value: string } or null for default SVG.
 */
function getTopicIcon(title) {
    if (!title) return null;
    const pack = settings.icon_pack || 'default';
    if (pack === 'default') return null;

    const lower = title.toLowerCase();

    // Custom pack has priority
    if (pack === 'custom' && _customIconMap) {
        for (const [keyword, icon] of Object.entries(_customIconMap)) {
            if (lower.includes(keyword.toLowerCase())) {
                if (icon.startsWith('data:') || icon.startsWith('http') || icon.startsWith('/')) {
                    return { type: 'img', value: icon };
                }
                return { type: 'emoji', value: icon };
            }
        }
        // Custom pack fallback → try emoji pack
    }

    // Emoji pack
    if (pack === 'emoji' || pack === 'custom') {
        for (const rule of ICON_PACK_EMOJI) {
            if (rule.keys.some(k => lower.includes(k))) {
                return { type: 'emoji', value: rule.icon };
            }
        }

        // ★ FIX: Fallback — если заголовок начинается с emoji, используем его
        const emojiMatch = title.match(/^(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
        if (emojiMatch) {
            return { type: 'emoji', value: emojiMatch[1] };
        }

        // ★ FIX: Generic fallback — чтобы все темы имели emoji вместо SVG
        return { type: 'emoji', value: '📄' };
    }

    return null; // keep default SVG
}

/**
 * Apply resolved icon to a topic card's .topic-type-icon element.
 */
function applyTopicIcon(card, title) {
    const iconEl = card.querySelector('.topic-type-icon');
    if (!iconEl) return;

    const resolved = getTopicIcon(title);
    if (!resolved) {
        // Default SVG
        iconEl.innerHTML = '<use href="#icon-file-text"></use>';
        return;
    }

    if (resolved.type === 'emoji') {
        // Replace SVG with emoji span
        const span = document.createElement('span');
        span.className = 'topic-type-emoji';
        span.textContent = resolved.value;
        iconEl.replaceWith(span);
    } else if (resolved.type === 'img') {
        // Replace SVG with image
        const img = document.createElement('img');
        img.className = 'topic-type-img';
        img.src = resolved.value;
        img.alt = '';
        img.loading = 'lazy';
        iconEl.replaceWith(img);
    }
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

        // Если "только закреплённые" — фильтруем
        let topicsFiltered = pinLevel === 20
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
            const fa = focusedTopics.has(String(a.id)) ? 1 : 0;
            const fb = focusedTopics.has(String(b.id)) ? 1 : 0;
            return fb - fa || b.last_post_ts - a.last_post_ts;
        });

        // ── Sort/Group/Tag toolbar (can be hidden in settings) ───────────
        if (settings.show_fav_toolbar !== false) {
        const allTagsSet = new Set();
        topicsFiltered.forEach(t => {
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
                // Кнопка «по непрочитанным» видна только в режиме «все темы»:
        // в режиме «только непрочитанные» все темы одинаково непрочитанны —
        // сортировка идентична «по дате», кнопка бессмысленна.
        if (settings.show_all_favorites) {
            sortRow.appendChild(makeTbBtn('unread', null, _favSort==='unread',
                'По непрочитанным',
                '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/><circle cx="19" cy="5" r="3" fill="currentColor" stroke="none"/>'));
        } else if (_favSort === 'unread') {
            _favSort = 'date'; // сбрасываем если был выбран этот режим
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
                renderTopics(currentData?.favorites);
            });
            toolbar.appendChild(tagRow);
        }

        toolbar.addEventListener('click', e => {
            e.stopPropagation();
            const btn = e.target.closest('.fav-tb-btn');
            if (!btn) return;
            if (btn.dataset.sort) { _favSort = btn.dataset.sort; }
            if (btn.dataset.group) { _favGroup = !_favGroup; }
            renderTopics(currentData?.favorites);
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

        // 🆕 Подсветка новых тем
        const currentIds = new Set(filtered.map(t => String(t.id)));
        if (_prevTopicIds.size > 0) {
            currentIds.forEach(id => { if (!_prevTopicIds.has(id)) _newTopicIds.add(id); });
        } else if (_knownTopicIds.size > 0) {
            currentIds.forEach(id => { if (!_knownTopicIds.has(id)) _newTopicIds.add(id); });
        }
        [..._newTopicIds].forEach(id => { if (!currentIds.has(id)) _newTopicIds.delete(id); });
        _knownTopicIds = new Set(currentIds);
        chrome.storage.local.set({ known_topic_ids: [..._knownTopicIds] });
        _saveNewTopicIds();
        _prevTopicIds = currentIds;
        _newTopicIds.forEach(id => {
            const card = document.getElementById(`topic_${id}`);
            if (card) card.classList.add('topic-card--new');
        });

        const anyFocused = [...topicsToShow].some(t => focusedTopics.has(String(t.id)));
        elements.topicsList.classList.toggle('has-focused', anyFocused);
        adjustPopupHeight();
    } catch (error) {
        console.error('Error rendering topics:', error);
    }
}

// Create Topic card
function createTopicCard(topic, template, index, isRead) {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.topic-card');

    card.id = `topic_${topic.id}`;
    card.dataset.id = topic.id; // Добавляем data-id для свайпов
    card.style.animationDelay = `${index * 0.05}s`;

    if (isRead) {
        card.classList.add(CLASS_READ);
    } else {
        card.classList.add(CLASS_UNREAD);
    }

    const typeIcon = card.querySelector('.topic-type-icon');
    if (typeIcon) {
        // Apply icon pack (emoji/custom/default)
        applyTopicIcon(card, topic.title);
    }

    if (topic.pin) {
        card.classList.add(CLASS_PINNED);
        const pinIcon = card.querySelector('.topic-pin-icon');
        if (pinIcon) {
            pinIcon.classList.remove(CLASS_HIDDEN);
        }
    }

    // 🎯 Focus state
    const topicIdStr = String(topic.id);
    if (focusedTopics.has(topicIdStr)) {
        card.classList.add('focused');
    }

    // 🔕 Mute state
    if (mutedTopics.has(topicIdStr)) {
        card.classList.add('muted');
    }

    // Focus button handler
    const focusBtn = card.querySelector('.topic-focus-btn');
    if (focusBtn) {
        focusBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleTopicFocus(topic.id);
            // Update this card visually
            const isFocused = focusedTopics.has(topicIdStr);
            card.classList.toggle('focused', isFocused);
            card.classList.remove('muted'); // unmute when focusing
            const focusIcon = card.querySelector('.topic-focus-icon');
            if (focusIcon) focusIcon.style.display = isFocused ? 'block' : '';
            const muteIcon = card.querySelector('.topic-mute-icon');
            if (muteIcon) muteIcon.style.display = '';
            // Re-sort list so focused card jumps to top
            renderTopics(currentData?.favorites);
        });
        focusBtn.title = focusedTopics.has(topicIdStr)
            ? 'Снять приоритет'
            : 'Режим концентрации: следить за темой';
    }

    // Mute button handler
    const muteBtn = card.querySelector('.topic-mute-btn');
    if (muteBtn) {
        muteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await toggleTopicMute(topic.id);
            const isMuted = mutedTopics.has(topicIdStr);
            card.classList.toggle('muted', isMuted);
            card.classList.remove('focused'); // unfocus when muting
            const focusIcon = card.querySelector('.topic-focus-icon');
            if (focusIcon) focusIcon.style.display = '';
        });
        muteBtn.title = mutedTopics.has(topicIdStr)
            ? 'Включить уведомления'
            : 'Тихий режим: заглушить уведомления';
    }

    const titleEl = card.querySelector('.topic-title');
    if (titleEl) {
        titleEl.textContent = decodeHtmlEntities(topic.title);
        card.title = decodeHtmlEntities(topic.title);
    }

    if (!settings.simple_list) {
        const authorEl = card.querySelector('.topic-author');
        const timeEl = card.querySelector('.topic-time');

        if (authorEl && topic.last_user_name) {
            authorEl.innerHTML = `<svg class="icon-sm"><use href="#icon-user"></use></svg> ${decodeHtmlEntities(topic.last_user_name)}`;
        }

        if (timeEl && topic.last_post_ts) {
            timeEl.textContent = `• ${formatRelativeTime(topic.last_post_ts)}`;
        }
    }

    const badge = card.querySelector('.unread-badge');
    if (badge && topic.unread_count > 0) {
        badge.textContent = topic.unread_count;
        badge.classList.remove(CLASS_HIDDEN);
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (isRead && markReadBtn) {
        markReadBtn.remove();
    } else if (markReadBtn) {
        markReadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            markTopicAsRead(topic.id);
        });
    }

    // ── Отображение тегов темы ──────────────────────────────────────────
    const existingTags = (_topicTags[topicIdStr] || []);
    if (existingTags.length > 0) {
        const cardBody = card.querySelector('.card-body');
        if (cardBody) {
            const tagsRow = document.createElement('div');
            tagsRow.className = 'fav-tags-row';
            existingTags.forEach(tag => {
                const t = document.createElement('span');
                t.className = 'fav-tag';
                t.textContent = tag;
                tagsRow.appendChild(t);
            });
            cardBody.appendChild(tagsRow);
        }
    }

    // ── Кнопка добавления тега (через card-actions) ─────────────────────
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
        _clearNewTopicId(topic.id);
        card.classList.remove('topic-card--new');
        // Помечаем в данных
        if (currentData?.favorites?.list) {
            const topicInData = currentData.favorites.list.find(t => t.id === topic.id);
            if (topicInData) topicInData.viewed = true;
            const unreadCount = currentData.favorites.list.filter(t => !t.viewed).length;
            currentData.favorites.count = unreadCount;
            const favNumber = elements.statFavorites?.querySelector('.stat-number');
            if (favNumber) animateCounter(favNumber, unreadCount);
        }

        // Открываем вкладку
        openTab('favorites', { id: topic.id, view: 'getnewpost' });

        // Анимированно убираем если show_all = off
        if (!settings.show_all_favorites) {
            _animateCardRemoval(card, () => {
                if (currentData?.favorites?.list) {
                    const t = currentData.favorites.list.find(x => x.id === topic.id);
                    if (t) t.viewed = true;
                }
                filterTopics(currentFilter || 'favorites');
            });
        }

        setTimeout(() => updateCountersFromBackground(), 600);
    });

    // Средняя кнопка мыши → фоновая вкладка
    card.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            openTab('favorites', { id: topic.id, view: 'getnewpost' }, true);
        }
    });

    return clone;
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

// Format relative time
function formatRelativeTime(timestamp) {
    if (!timestamp) return '';

    const now = Date.now() / 1000;
    const diff = now - timestamp;

    if (diff < 60) return 'только что';
    if (diff < 3600) return `${Math.floor(diff / 60)} мин. назад`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч. назад`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} дн. назад`;
    return `${Math.floor(diff / 604800)} нед. назад`;
}

// Общая функция анимированного удаления карточки
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
    setTimeout(() => {
        card.remove();
        onDone?.();
    }, 390);
}

// Mark topic as read
async function markTopicAsRead(topicId) {
    try {
        const result = await sendMessage({
            action: 'mark_as_read',
            id: topicId
        });

        if (result) {
            const card = document.getElementById(`topic_${topicId}`);
            // Помечаем в данных немедленно
            if (currentData?.favorites?.list) {
                const topicInData = currentData.favorites.list.find(t => t.id === topicId);
                if (topicInData) topicInData.viewed = true;
                const unreadCount = currentData.favorites.list.filter(t => !t.viewed).length;
                currentData.favorites.count = unreadCount;
                const favNumber = elements.statFavorites?.querySelector('.stat-number');
                if (favNumber) animateCounter(favNumber, unreadCount);
                if (unreadCount === 0) elements.statFavorites?.classList.remove(CLASS_ACTIVE);
            }

            if (card) {
                _animateCardRemoval(card, () => {
                    // После удаления — перезапускаем текущий фильтр (он сам покажет empty-state)
                    filterTopics(currentFilter || 'favorites');
                });
            }
        }
    } catch (error) {
        console.error('Failed to mark topic as read:', error);
    }
}

// Render QMS list
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

// Create QMS card with INLINE REPLY functionality
function createQMSCard(dialog, template, index, isRead) {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.topic-card');

    card.id = `qms_${dialog.id}`;
    card.style.animationDelay = `${index * 0.05}s`;

    card.setAttribute('data-opponent-name', dialog.opponent_name || '');
    card.setAttribute('data-opponent-id', dialog.opponent_id || '');
    card.setAttribute('data-dialog-id', dialog.id || '');

    if (isRead) {
        card.classList.add(CLASS_READ);
    } else {
        card.classList.add(CLASS_UNREAD);
    }

    const typeIcon = card.querySelector('.topic-type-icon');
    if (typeIcon) {
        const pack = settings.icon_pack || 'default';
        if (pack === 'default') {
            typeIcon.innerHTML = '<use href="#icon-mail"></use>';
        } else {
            // Try topic-title-based icon first, then QMS default emoji
            const dialogTitle = dialog.subject || dialog.title || dialog.opponent_name || '';
            const resolved = getTopicIcon(dialogTitle);
            if (resolved && resolved.type === 'emoji') {
                const span = document.createElement('span');
                span.className = 'topic-type-emoji';
                span.textContent = resolved.value;
                typeIcon.replaceWith(span);
            } else {
                const span = document.createElement('span');
                span.className = 'topic-type-emoji';
                span.textContent = '💌';
                typeIcon.replaceWith(span);
            }
        }
    }

    const pinIcon = card.querySelector('.topic-pin-icon');
    if (pinIcon) {
        pinIcon.classList.add(CLASS_HIDDEN);
    }

    const titleEl = card.querySelector('.topic-title');
    const metaEl = card.querySelector('.topic-meta');

    // Приоритет: subject > title > opponent_name
    const dialogTitle = dialog.subject || dialog.title || dialog.opponent_name;

    // Мета: имя + время + галочка прочтения
    let dialogMeta = decodeHtmlEntities(dialog.opponent_name || '');
    if (dialog.last_msg_ts) {
        dialogMeta += (dialogMeta ? ' • ' : '') + formatRelativeTime(dialog.last_msg_ts);
    }

    if (titleEl) {
        titleEl.textContent = decodeHtmlEntities(dialogTitle);
        card.title = decodeHtmlEntities(dialogTitle);
    }

    if (metaEl) {
        while (metaEl.firstChild) metaEl.removeChild(metaEl.firstChild);
        if (dialogMeta) metaEl.appendChild(document.createTextNode(dialogMeta));

        // ✓ Галочка прочтения: isRead = наш последний msg прочитан собеседником
        if (isRead) {
            const check = document.createElement('span');
            check.className = 'qms-read-check';
            check.title = 'Прочитано';
            check.textContent = ' ✓✓';
            metaEl.appendChild(check);
        }
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) {
        markReadBtn.remove();
    }

    // QMS cards don't use focus/mute — remove those template buttons
    card.querySelector('.topic-focus-btn')?.remove();
    card.querySelector('.topic-mute-btn')?.remove();
    card.querySelector('.topic-focus-icon')?.remove();
    card.querySelector('.topic-mute-icon')?.remove();

    // =======================================================
    // ИНТЕГРАЦИЯ INLINE-ЧАТА
    // =======================================================

    const cardBody = card.querySelector('.card-body');

    // 1. Создаем DOM элементы для инлайн-чата
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
        </div>
    `;

    // 2. Вставляем элементы в карточку
    cardBody.appendChild(inlineChat);

    // Блокируем всплытие клика, чтобы интерфейс чата не дергал саму карточку
    inlineChat.addEventListener('click', e => e.stopPropagation());

    // 3. Наполняем панель смайликов
    const EMOJIS = ['😀','😂','🤣','😊','😍','😒','😘','😁','😉','😎','😋','😜','🤔','🙄','😏','😔','😴','🤤','😷','🤢','🤮','🤧','😵','🤯','🤠','🥳','🤓','👍','👎','👏','🤝','🍻','🔥','❤️','💔','💯','🤷‍♂️','🤦‍♂️'];
    const emojiPicker = inlineChat.querySelector('.qms-emoji-picker');
    const textarea = inlineChat.querySelector('.qms-textarea');

    EMOJIS.forEach(emo => {
        const span = document.createElement('span');
        span.textContent = emo;
        span.className = 'qms-emoji-item';
        span.onclick = (e) => {
            e.stopPropagation();
            // Вставляем смайлик туда, где стоит курсор
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + emo + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + emo.length;
            textarea.focus();
        };
        emojiPicker.appendChild(span);
    });

    // 4. Добавляем кнопку "Открыть вкладку" в панель действий карточки
    const actionsContainer = card.querySelector('.card-actions');
    const openTabBtn = document.createElement('button');
    openTabBtn.className = 'action-icon open-tab interactive';
    openTabBtn.title = 'Открыть диалог в новой вкладке';
    openTabBtn.innerHTML = '<svg class="icon"><use href="#icon-external-link"></use></svg>';
    openTabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id });
    });
    // Средняя кнопка на кнопке открытия вкладки
    openTabBtn.addEventListener('auxclick', (e) => {
        if (e.button === 1) { e.preventDefault(); e.stopPropagation(); openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id }, true); }
    });
    actionsContainer.appendChild(openTabBtn);

    // 5. Логика раскрытия карточки по клику
    let isExpanded = false;
    let lastMessageId = '0';

    card.addEventListener('click', async (e) => {
        // Игнорируем клики по кнопкам действий
        if (e.target.closest('.card-actions')) return;

        // Если уже открыта — сворачиваем
        if (isExpanded) {
            isExpanded = false;
            inlineChat.classList.add('hidden');
            adjustPopupHeight();
            return;
        }

        // Открываем чат
        isExpanded = true;
        inlineChat.classList.remove('hidden');
        adjustPopupHeight();

        const historyContainer = inlineChat.querySelector('.qms-history');
        historyContainer.innerHTML = '<div class="qms-loading-text">Загрузка истории...</div>';

        try {
            // Route through background (has cookies, no CORS issues from popup)
            const threadUrl = `https://4pda.to/forum/index.php?act=qms&mid=${dialog.opponent_id}&t=${dialog.id}`;
            const res = await chrome.runtime.sendMessage({ action: 'fetch_page', url: threadUrl });
            if (!res?.ok) throw new Error(res?.error || 'fetch failed');
            const html = res.html;

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            // Ищем все сообщения в загруженном диалоге
            const messages = doc.querySelectorAll('#scroll-thread .list-group-item[data-message-id]');

            historyContainer.innerHTML = '';
            if (messages.length === 0) {
                 historyContainer.innerHTML = '<div class="qms-loading-text">Нет сообщений</div>';
            }

            messages.forEach(msg => {
                const msgId = msg.getAttribute('data-message-id');
                if (msgId) lastMessageId = msgId;

                const content = msg.querySelector('.msg-content');
                if (content) {
                    const msgDiv = document.createElement('div');
                    msgDiv.className = msg.classList.contains('our-message') ? 'qms-msg out' : 'qms-msg in';
                    msgDiv.innerHTML = content.innerHTML;
                    historyContainer.appendChild(msgDiv);
                }
            });

            // Прокрутка вниз И ПРИНУДИТЕЛЬНЫЙ ПЕРЕРАСЧЕТ ВЫСОТЫ ОКНА
            setTimeout(() => {
                historyContainer.scrollTop = historyContainer.scrollHeight;
                adjustPopupHeight();
            }, 50);

        } catch (err) {
            console.error("QMS History Error:", err);
            historyContainer.innerHTML = '<div class="qms-loading-text">Ошибка загрузки</div>';
            adjustPopupHeight(); // И здесь тоже на случай ошибки
        }
    });

    // 6. Кнопки внутри чата (Свернуть, Смайлики, Отправка)
    const btnCancel = inlineChat.querySelector('.qms-btn-cancel');
    const btnEmoji = inlineChat.querySelector('.qms-btn-emoji');
    const btnSend = inlineChat.querySelector('.qms-btn-send');

    btnCancel.addEventListener('click', (e) => {
        e.stopPropagation();
        isExpanded = false;
        inlineChat.classList.add('hidden');
        adjustPopupHeight();
    });

    btnEmoji.addEventListener('click', (e) => {
        e.stopPropagation();
        emojiPicker.classList.toggle('hidden');
        adjustPopupHeight();
        adjustPopupHeight(); // Пересчитываем высоту окна
    });

    const sendHandler = async (e) => {
        if (e) e.stopPropagation();
        const text = textarea.value.trim();
        if (!text) return;

        btnSend.disabled = true;
        btnSend.textContent = '...';

        try {
            await qmsApiRequest('send-message', dialog.opponent_id, dialog.id, {
                'message': text,
                'forward-messages-username': '',
                'forward-thread-username': '',
                'attaches': '',
                'after-message': lastMessageId
            });

            // Отправка успешна!
            // Помечаем диалог прочитанным и прячем карточку (или визуально меняем)
            if (currentData?.qms?.list) {
                const dialogInData = currentData.qms.list.find(d => d.id === dialog.id);
                if (dialogInData) dialogInData.viewed = true;
                currentData.qms.count = Math.max(0, currentData.qms.count - 1);
            }

            const qmsNumber = elements.statQms?.querySelector('.stat-number');
            if (qmsNumber && currentData) animateCounter(qmsNumber, currentData.qms.count);

            if (!settings.show_all_qms) {
                _animateCardRemoval(card, () => {
                    if (currentData?.qms?.list) {
                        const d = currentData.qms.list.find(x => x.id === dialog.id);
                        if (d) d.viewed = true;
                    }
                    filterTopics(currentFilter || 'qms');
                });
            } else {
                // Если режим "показывать все", просто сворачиваем и красим в прочитанное
                isExpanded = false;
                inlineChat.classList.add('hidden');
                card.classList.remove(CLASS_UNREAD);
                card.classList.add(CLASS_READ);
                adjustPopupHeight();
            }

            setTimeout(() => updateCountersFromBackground(), 600);

        } catch (err) {
            console.error(err);
            btnSend.disabled = false;
            btnSend.textContent = 'Ошибка!';
            setTimeout(() => btnSend.textContent = 'Отправить', 2000);
        }
    };

    btnSend.addEventListener('click', sendHandler);

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            sendHandler();
        }
    });

    // 🆕 Средняя кнопка мыши на карточке → фоновая вкладка
    card.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            openTab('qms', { opponent_id: dialog.opponent_id, dialog_id: dialog.id }, true);
        }
    });

    return clone;
}

// Decode HTML entities
function decodeHtmlEntities(text) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = text;
    return textarea.value;
}

// Render Mentions list
function renderMentions(mentionsData) {
    try {
        // Используем DocumentFragment
        const fragment = document.createDocumentFragment();

        if (!mentionsData || !mentionsData.list || mentionsData.list.length === 0) {
            elements.mentionsList.innerHTML = '';
            return;
        }

        const template = settings.simple_list ?
            elements.topicTemplateSimple :
            elements.topicTemplate;

        let mentionsToShow = mentionsData.list;
        if (!settings.show_all_mentions) {
            mentionsToShow = mentionsData.list.filter(m => m.unread && !m.viewed);
        }

        const unreadMentions = mentionsToShow.filter(m => m.unread && !m.viewed);
        const readMentions = mentionsToShow.filter(m => !m.unread || m.viewed);

        unreadMentions.forEach((mention, index) => {
            const card = createMentionCard(mention, template, index, false);
            fragment.appendChild(card);
        });

        readMentions.forEach((mention, index) => {
            const card = createMentionCard(mention, template, index + unreadMentions.length, true);
            fragment.appendChild(card);
        });

        // Одна операция DOM
        elements.mentionsList.innerHTML = '';
        elements.mentionsList.appendChild(fragment);

        // Динамически подстраиваем высоту попапа
        adjustPopupHeight();
    } catch (error) {
        console.error('Error rendering mentions:', error);
    }
}

// Create Mention card
function createMentionCard(mention, template, index, isRead) {
    const clone = template.content.cloneNode(true);
    const card = clone.querySelector('.topic-card');

    card.id = `mention_${mention.id}`;
    card.style.animationDelay = `${index * 0.05}s`;

    if (isRead) {
        card.classList.add(CLASS_READ);
    } else {
        card.classList.add(CLASS_UNREAD);
    }

    const typeIcon = card.querySelector('.topic-type-icon');
    if (typeIcon) {
        const pack = settings.icon_pack || 'default';
        if (pack === 'default') {
            typeIcon.innerHTML = '<use href="#icon-message"></use>';
        } else {
            const resolved = getTopicIcon(mention.title || '');
            if (resolved && resolved.type === 'emoji') {
                const span = document.createElement('span');
                span.className = 'topic-type-emoji';
                span.textContent = resolved.value;
                typeIcon.replaceWith(span);
            } else {
                const span = document.createElement('span');
                span.className = 'topic-type-emoji';
                span.textContent = '📢';
                typeIcon.replaceWith(span);
            }
        }
    }

    const pinIcon = card.querySelector('.topic-pin-icon');
    if (pinIcon) {
        pinIcon.classList.add(CLASS_HIDDEN);
    }

    const titleEl = card.querySelector('.topic-title');
    if (titleEl) {
        titleEl.textContent = decodeHtmlEntities(mention.title);
        card.title = decodeHtmlEntities(mention.title);
    }

    if (!settings.simple_list) {
        const authorEl = card.querySelector('.topic-author');
        const timeEl = card.querySelector('.topic-time');

        if (authorEl && mention.poster_name) {
            authorEl.innerHTML = `<svg class="icon-sm"><use href="#icon-user"></use></svg> ${decodeHtmlEntities(mention.poster_name)}`;
        }

        if (timeEl && mention.timestamp) {
            timeEl.textContent = `• ${formatRelativeTime(mention.timestamp)}`;
        }
    }

    const markReadBtn = card.querySelector('.mark-read');
    if (markReadBtn) {
        markReadBtn.remove();
    }

    card.addEventListener('click', (e) => {
        card.classList.add(CLASS_READ);
        card.classList.remove(CLASS_UNREAD);

        if (currentData && currentData.mentions && currentData.mentions.list) {
            const mentionInData = currentData.mentions.list.find(m => m.id === mention.id);
            if (mentionInData) {
                mentionInData.viewed = true;
                mentionInData.unread = false;
            }

            currentData.mentions.count = Math.max(0, currentData.mentions.count - 1);
        }

        const mentNumber = elements.statMentions?.querySelector('.stat-number');
        if (mentNumber && currentData) {
            animateCounter(mentNumber, currentData.mentions.count);
        }

        openTab('mentions', {
            topic_id: mention.topic_id,
            post_id: mention.post_id
        });

        setTimeout(() => {
            updateCountersFromBackground();
        }, 400);
    });

    // 🆕 Средняя кнопка мыши → фоновая вкладка
    card.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
            e.preventDefault();
            openTab('mentions', { topic_id: mention.topic_id, post_id: mention.post_id }, true);
        }
    });

    return clone;
}

// 🆕 Setup Intersection Observer for lazy loading QMS subjects
function setupQMSLazyLoading() {
    if (qmsObserver) {
        qmsObserver.disconnect();
    }

    qmsObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const card = entry.target;
                const dialogId = card.getAttribute('data-dialog-id');

                if (!dialogId) return;

                if (!loadingQmsSubjects.has(dialogId)) {
                    // Загружаем только если тема ещё не была загружена
                    const alreadyLoaded = card.hasAttribute('data-subject-loaded');
                    if (!alreadyLoaded) {
                        fetchQMSSubject(dialogId);
                    }
                }
            }
        });
    }, {
        root: elements.main,
        rootMargin: '50px',
        threshold: 0.1
    });

    const qmsCards = elements.qmsList.querySelectorAll('.topic-card');
    qmsCards.forEach(card => qmsObserver.observe(card));
}

// 🆕 Fetch QMS subject for a specific dialog
async function fetchQMSSubject(dialogId) {
    if (loadingQmsSubjects.has(dialogId)) {
        return;
    }

    loadingQmsSubjects.add(dialogId);

    try {

        const card = document.getElementById(`qms_${dialogId}`);
        if (!card) {
            console.warn(`⚠️ Card not found for dialog: ${dialogId}`);
            return;
        }

        const opponentName = card.getAttribute('data-opponent-name');
        const opponentId = card.getAttribute('data-opponent-id');

        if (!opponentId) {
            console.warn(`⚠️ No opponent ID for dialog: ${dialogId}`);
            return;
        }

        const result = await sendMessage({
            action: 'fetch_qms_subject',
            opponent_id: opponentId
        });

        const cardNow = document.getElementById(`qms_${dialogId}`);
        if (!cardNow) {
            console.warn(`⚠️ Card disappeared during fetch for dialog: ${dialogId}`);
            return;
        }

        if (result && result.subject) {
            const titleEl = cardNow.querySelector('.topic-title');
            const metaEl = cardNow.querySelector('.topic-meta');

            if (titleEl && metaEl) {
                // Обновляем заголовок на subject
                titleEl.textContent = decodeHtmlEntities(result.subject);
                cardNow.title = decodeHtmlEntities(result.subject);
                cardNow.setAttribute('data-subject-loaded', '1');

                // Обновляем мету: показываем автора и время
                let metaText = decodeHtmlEntities(opponentName);
                if (result.last_msg_ts) {
                    metaText += ` • ${formatRelativeTime(result.last_msg_ts)}`;
                }
                metaEl.textContent = metaText;

            }

            if (currentData && currentData.qms && currentData.qms.list && result.dialogId) {
                const dialog = currentData.qms.list.find(d => d.opponent_id == opponentId);
                if (dialog) {
                    dialog.id = result.dialogId;
                    dialog.subject = result.subject;
                    dialog.subject_loaded = true;
                    if (result.last_msg_ts) {
                        dialog.last_msg_ts = result.last_msg_ts;
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Failed to fetch QMS subject for ${dialogId}:`, error);
    } finally {
        loadingQmsSubjects.delete(dialogId);
    }
}

// Refresh data from background
async function refreshData() {
    const previousFilter = currentFilter;

    showLoading(true);

    try {
        await sendMessage({ action: 'force_update' });

        const response = await sendMessage({ action: 'popup_loaded' });
        if (response) {
            currentData = response;

            settings.simple_list = response.settings.toolbar_simple_list;
            settings.close_on_open = response.settings.toolbar_open_theme_hide;
            settings.default_view = response.settings.toolbar_default_view || 'collapsed';
            settings.show_all_favorites = response.settings.show_all_favorites || false;
            settings.show_all_qms = response.settings.show_all_qms || false;
            settings.show_all_mentions = response.settings.show_all_mentions || false;
            settings.bw_icons = response.settings.bw_icons || false;
            settings.accent_color = response.settings.accent_color || 'purple';
            settings.primary_click_action = response.settings.primary_click_action || 'forum';
            settings.compact_stats          = response.settings.compact_stats          || false;
            settings.compact_hide_qms       = response.settings.compact_hide_qms       || false;
            settings.compact_hide_favorites = response.settings.compact_hide_favorites || false;
            settings.compact_hide_mentions  = response.settings.compact_hide_mentions  || false;
            settings.compact_only_stats     = response.settings.compact_only_stats     || false;
            settings.compact_show_topics    = response.settings.compact_show_topics    || false;
            settings.max_visible_topics = response.settings.max_visible_topics || 0;
            // 🔧 Обновляем ширину попапа
            const refreshedWidth = response.settings.popup_width || 360;
            document.documentElement.style.setProperty('--popup-width', refreshedWidth + 'px');
            const refreshedAuto = response.settings.popup_width_auto || false;
            document.documentElement.classList.toggle('popup-width-auto', !!refreshedAuto);
            document.body.classList.toggle('compact-stats-mode', !!settings.compact_stats);
            applyCompactStatsTiles();
            applyCompactOnlyStats();

            if (settings.bw_icons) {
                document.body.classList.add('bw-icons');
            } else {
                document.body.classList.remove('bw-icons');
            }

            document.body.setAttribute('data-accent', settings.accent_color);

            renderTopics(response.favorites);
            renderQMS(response.qms);
            renderMentions(response.mentions);

            setupActionButtons();

            const usernameText = elements.username.querySelector('.user-name-text');
            if (usernameText) {
                usernameText.textContent = response.user_name;
            }

            updateStats(response);

            if (previousFilter) {
                filterTopics(previousFilter);
            } else {
                collapsePopup();
            }

            updateLastUpdateTime();
        }
    } catch (error) {
        console.error('Failed to refresh data:', error);
    } finally {
        showLoading(false);
    }
}

// Open tab helper
function openTab(what, options = {}, background = false) {
    const finalMessage = {
        action: 'open_url',
        what: what,
        background: background,
        ...options
    };


    try {
        chrome.runtime.sendMessage(finalMessage);

        // В фоновом режиме (Shift/Ctrl/Cmd/MiddleClick) — попап НЕ закрываем
        if (!background) {
            setTimeout(() => {
                if (settings.close_on_open) {
                    window.close();
                } else {
                }
            }, 100);
        }
    } catch (error) {
        console.error('Failed to send message:', error);
    }
}

/**
 * Определяет, должна ли ссылка открыться в фоновой вкладке.
 * Условия: Shift+ЛКМ, Ctrl+ЛКМ, Cmd+ЛКМ (Mac), средняя кнопка (button===1).
 * @param {MouseEvent} e
 * @returns {boolean}
 */
function isBackgroundClick(e) {
    return e.shiftKey || e.ctrlKey || e.metaKey || e.button === 1;
}

// Create port for batch operations
function createPort(name) {
    const port = chrome.runtime.connect({ name: name });

    port.onMessage.addListener((msg) => {
        const card = document.getElementById(`topic_${msg.id}`);
        if (card) {
            card.classList.add(CLASS_READ);
        }

        const favNumber = elements.statFavorites.querySelector('.stat-number');
        if (favNumber) {
            animateCounter(favNumber, msg.count);
        }

        if (msg.count === 0) {
            elements.statFavorites.classList.remove(CLASS_ACTIVE);
            showEmptyState(true);
        }
    });

    port.onDisconnect.addListener(() => {
        // Port disconnected - this is normal
    });

    return port;
}

// ✨ Update counters from background (polling)
async function updateCountersFromBackground() {
    try {
        const counts = await sendMessage({ action: 'get_counts' });
        if (counts && currentData) {
            currentData.favorites.count = counts.favorites;
            currentData.qms.count = counts.qms;
            currentData.mentions.count = counts.mentions;

            const favNumber = elements.statFavorites?.querySelector('.stat-number');
            if (favNumber) animateCounter(favNumber, counts.favorites);

            const qmsNumber = elements.statQms?.querySelector('.stat-number');
            if (qmsNumber) animateCounter(qmsNumber, counts.qms);

            const mentNumber = elements.statMentions?.querySelector('.stat-number');
            if (mentNumber) animateCounter(mentNumber, counts.mentions);


            // Если текущий фильтр показывает пустой список — сразу показываем empty state
            _checkAndShowEmptyState();
        }
    } catch (error) {
        console.error('Failed to update counters:', error);
    }
}

// Проверяет виден ли реальный список и показывает empty-state если пуст
function _checkAndShowEmptyState() {
    if (!currentData || !currentFilter) return;

    const visibleList = elements.main?.querySelector('.topics-list:not(.hidden)');
    const remainingCards = visibleList
        ? visibleList.querySelectorAll('.topic-card:not([style*="opacity: 0"])').length
        : 0;

    if (remainingCards > 0) return; // ещё есть карточки — ничего не делаем

    if (currentFilter === 'favorites') {
        const hasUnread = currentData.favorites.list?.some(t => !t.viewed);
        if (!hasUnread) {
            showEmptyState(true, 'Все темы прочитаны');
            elements.statFavorites?.classList.remove(CLASS_ACTIVE);
        }
    } else if (currentFilter === 'qms') {
        const hasUnread = currentData.qms.list?.some(d => d.unread && !d.viewed);
        if (!hasUnread) {
            showEmptyState(true, 'Нет новых сообщений');
            elements.statQms?.classList.remove(CLASS_ACTIVE);
        }
    } else if (currentFilter === 'mentions') {
        const hasUnread = currentData.mentions.list?.some(m => m.unread && !m.viewed);
        if (!hasUnread) {
            showEmptyState(true, 'Нет новых ответов');
            elements.statMentions?.classList.remove(CLASS_ACTIVE);
        }
    }
}

// ===================================
// AUTO-MODE POLLING
// Строгие правила:
//  - Один и только один активный интервал
//  - Интервал живёт независимо от UI
//  - Восстанавливается из storage при открытии popup
//  - clearInterval перед любым новым созданием
// ===================================

const AUTO_POLL_INTERVAL_MS = 60_000; // 60 секунд — строго фиксированный

/**
 * Запустить авторежим.
 * Защита от дублей: перед созданием нового интервала старый уничтожается.
 */
function startPolling() {
    // Уничтожаем старый интервал, если вдруг есть
    if (pollInterval) {
        console.warn('⚠️ startPolling: interval already exists, clearing first');
        clearInterval(pollInterval);
        pollInterval = null;
    }

    // Не запускаем polling, если popup закрывается сразу при открытии ссылок
    if (settings.close_on_open) {
        return;
    }


    // Сохраняем состояние авторежима в storage
    chrome.storage.local.set({ auto_mode_active: true });

    pollInterval = setInterval(() => {
        updateCountersFromBackground();
    }, AUTO_POLL_INTERVAL_MS);
}

/**
 * Остановить авторежим.
 * clearInterval — обязателен, таймер полностью уничтожается.
 */
function stopPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    chrome.storage.local.set({ auto_mode_active: false });
}

/**
 * Восстановить авторежим из storage (вызывается при открытии popup).
 * Если авторежим был включён до закрытия браузера — восстанавливаем.
 */
async function restoreAutoModeIfNeeded() {
    try {
        const stored = await chrome.storage.local.get(['auto_mode_active']);
        if (stored.auto_mode_active && !pollInterval) {
            startPolling();
        }
    } catch (err) {
        console.error('restoreAutoModeIfNeeded error:', err);
    }
}

// ✨ Cleanup on window unload — только уничтожаем интервал popup,
//    НЕ трогаем auto_mode_active в storage (фоновый цикл продолжает работать)
window.addEventListener('beforeunload', () => {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
});

// Handle refresh button click
async function handleRefreshClick() {
    elements.refresh.classList.add('spinning');

    try {
        await refreshData();
    } finally {
        setTimeout(() => {
            elements.refresh.classList.remove('spinning');
        }, 600);
    }
}

// Show/hide loading skeleton
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

// Show empty state
function showEmptyState(show, customMessage = null) {
    if (show) {
        if (customMessage) {
            elements.emptyTitle.textContent = customMessage;
        }
        showElement(elements.emptyState);
        hideElement(elements.topicsList);
        hideElement(elements.qmsList);
        hideElement(elements.mentionsList);
    } else {
        hideElement(elements.emptyState);
    }
}

// Update last update time
function updateLastUpdateTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
    });

    if (elements.lastUpdateTime) {
        elements.lastUpdateTime.textContent = timeString;
    }
}

// Helper functions
function showElement(element) {
    if (element) {
        element.classList.remove(CLASS_HIDDEN);
    }
}

function hideElement(element) {
    if (element) {
        element.classList.add(CLASS_HIDDEN);
    }
}

// Send message to background
function sendMessage(message, retries = 3, delay = 300) {
    return new Promise((resolve, reject) => {
        const attempt = (triesLeft) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        const err = chrome.runtime.lastError.message || '';
                        if (triesLeft > 0 && (
                            err.includes('Receiving end does not exist') ||
                            err.includes('Could not establish connection') ||
                            err.includes('Extension context invalidated')
                        )) {
                            setTimeout(() => attempt(triesLeft - 1), delay);
                        } else {
                            console.error('Runtime error:', err);
                            reject(new Error(err));
                        }
                    } else {
                        resolve(response);
                    }
                });
            } catch (error) {
                if (triesLeft > 0) {
                    setTimeout(() => attempt(triesLeft - 1), delay);
                } else {
                    console.error('Send message error:', error);
                    reject(error);
                }
            }
        };
        attempt(retries);
    });
}

/* ═══════════════════════════════════════════════════════════
   FONT SETTINGS APPLICATION
   ═══════════════════════════════════════════════════════════ */

// Карта шрифтов
// Шрифты загружаются динамически только если пользователь выбрал конкретный шрифт
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
    'bricolage':     'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,600;12..96,700&display=swap',
    'onest':         'https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600;700&display=swap',
    'geologica':     'https://fonts.googleapis.com/css2?family=Geologica:slnt,wght@0,300;0,400;0,500;0,600;0,700&display=swap',
};

let _loadedFontUrl = null;
function _loadGoogleFont(family) {
    const url = GOOGLE_FONTS[family];
    if (!url || _loadedFontUrl === url) return;
    const existing = document.getElementById('dynamic-gfont');
    if (existing) existing.remove();
    const link = document.createElement('link');
    link.id = 'dynamic-gfont';
    link.rel = 'stylesheet';
    link.href = url;
    // После загрузки CSS-файла шрифта — переприменяем font-family,
    // иначе браузер рисует фолбек пока файл не скачан.
    link.onload = () => {
        const fontVal = FONT_FAMILIES[family];
        if (fontVal) {
            document.body.style.setProperty('font-family', fontVal, 'important');
        }
    };
    document.head.appendChild(link);
    _loadedFontUrl = url;
}

const FONT_FAMILIES = {
    'system': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'inter': '"Inter", -apple-system, sans-serif',
    'roboto': '"Roboto", -apple-system, sans-serif',
    'open-sans': '"Open Sans", -apple-system, sans-serif',
    'pt-sans': '"PT Sans", -apple-system, sans-serif',
    'ubuntu': 'Ubuntu, -apple-system, sans-serif',
    'noto-sans': '"Noto Sans", -apple-system, sans-serif',
    'source-sans': '"Source Sans Pro", -apple-system, sans-serif',
    'verdana': 'Verdana, Geneva, sans-serif',
    'comfortaa': '"Comfortaa", cursive, -apple-system, sans-serif',
    'nunito': '"Nunito", -apple-system, sans-serif',
    'manrope': '"Manrope", -apple-system, sans-serif',
    'rubik': '"Rubik", -apple-system, sans-serif',
    'montserrat': '"Montserrat", -apple-system, sans-serif',
    'jetbrains-mono': '"JetBrains Mono", "Courier New", monospace, -apple-system, sans-serif',
    'bricolage':      '"Bricolage Grotesque", -apple-system, sans-serif',
    'onest':          '"Onest", -apple-system, sans-serif',
    'geologica':      '"Geologica", -apple-system, sans-serif'
};

const FONT_SIZES = {
    xs: '12px',
    small: '14px',
    medium: '16px',
    large: '18px',
    xl: '20px',
    xxl: '22px'
};

// Применение настроек шрифта
async function applyFontSettings() {
    const data = await chrome.storage.local.get(['font_family', 'font_size', 'line_height', 'compact_mode']);

    const root = document.documentElement;

    if (data.font_family && FONT_FAMILIES[data.font_family]) {
        _loadGoogleFont(data.font_family);
        const fontVal = FONT_FAMILIES[data.font_family];
        // Use !important so it overrides any CSS including Inter Tight default
        document.body.style.setProperty('font-family', fontVal, 'important');
        // Also force on elements that may resist inheritance
        document.querySelectorAll(
            '.time-clock, .time-date, #current-date, #current-time, ' +
            '.user-name-text, .topic-title, .topic-meta, .stat-number, .stat-label, ' +
            '.action-btn, header, main'
        ).forEach(el => {
            el.style.setProperty('font-family', fontVal, 'important');
        });
    }

    if (data.font_size && FONT_SIZES[data.font_size]) {
        let baseFontSize = parseInt(FONT_SIZES[data.font_size]);

        // В компактном режиме ограничиваем максимальный размер до 18px (L)
        const isCompactMode = document.body.classList.contains('compact-mode');
        if (isCompactMode && baseFontSize > 18) {
            baseFontSize = 18;
        }

        // Пересчитываем все размеры пропорционально базовому
        root.style.setProperty('--font-xs', `${baseFontSize - 6}px`);
        root.style.setProperty('--font-sm', `${baseFontSize - 4}px`);
        root.style.setProperty('--font-md', `${baseFontSize - 3}px`);
        root.style.setProperty('--font-lg', `${baseFontSize - 2}px`);
        root.style.setProperty('--font-xl', `${baseFontSize}px`);
        root.style.setProperty('--font-2xl', `${baseFontSize + 4}px`);
        root.style.setProperty('--font-3xl', `${baseFontSize + 6}px`);
    }

    if (data.line_height) {
        document.body.style.lineHeight = data.line_height;
    }
    // ★ FIX: пересчитываем высоту попапа после изменения font/line-height
    // (без этого попап прыгает вверх/вниз при смене интерлиньяжа)
    setTimeout(() => adjustPopupHeight(), 50);
}

/* ═══════════════════════════════════════════════════════════
   THEME AND ACCENT COLOR APPLICATION
   ═══════════════════════════════════════════════════════════ */

// Применение темы и цветов
async function applyThemeAndColors() {
    const data = await chrome.storage.local.get(['theme_mode', 'accent_color']);

    // Применяем тему
    const theme = data.theme_mode || 'liquid-glass';
    if (theme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.setAttribute('data-theme', prefersDark ? 'dark' : 'light');

        // Слушаем изменения системной темы
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            chrome.storage.local.get(['theme_mode'], (data) => {
                if (data.theme_mode === 'auto') {
                    document.body.setAttribute('data-theme', e.matches ? 'dark' : 'light');
                }
            });
        });
    } else {
        document.body.setAttribute('data-theme', theme);
    }

    // Применяем цвет акцента
    let accent = data.accent_color || 'purple';
    if (accent === 'green') accent = 'teal';
    if (accent === 'pink' || accent === 'red') accent = 'blue';
    document.body.setAttribute('data-accent', accent);

    // Re-apply fonts after theme change — inline styles may get reset
    setTimeout(() => applyFontSettings(), 50);
}

// Применение только настроек темы (для динамического обновления)
async function applyThemeSettings() {
    const data = await chrome.storage.local.get(['theme_mode']);
    const theme = data.theme_mode || 'liquid-glass';

    if (theme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
        document.body.setAttribute('data-theme', theme);
    }
}

// ===================================
// BOOKMARKS VISIBILITY
// ===================================
// ── Compact grid: layout теперь управляется CSS flexbox (compact-stats-mode) ──
// Все видимые плитки автоматически идут в один ряд через flex.
// Функция оставлена для обратной совместимости с вызовами.
function _applyCompactGrid() {
    // No-op: CSS flexbox в .compact-stats-mode .stats-cards делает всё сам.
    // display:none плитки автоматически выпадают из flex-ряда.
}

function applyCompactStatsTiles() {
    const inCompact = settings.compact_stats;
    const hideQms = inCompact && settings.compact_hide_qms;
    const hideFav = inCompact && settings.compact_hide_favorites;
    const hideMen = inCompact && settings.compact_hide_mentions;

    if (elements.statQms)       elements.statQms.style.display       = hideQms ? 'none' : '';
    if (elements.statFavorites) elements.statFavorites.style.display = hideFav ? 'none' : '';
    if (elements.statMentions)  elements.statMentions.style.display  = hideMen ? 'none' : '';

    // Summary bar — скрываем всегда: скрытые плитки просто исчезают из flex-ряда,
    // дублировать их иконками над рядом не нужно.
    const bar = document.getElementById('compact-summary-bar');
    if (bar) bar.style.display = 'none';

    // ── Compact-stats: layout управляется CSS flexbox, JS ничего не делает ──
    if (inCompact) {
        // ★ FIX: сбрасываем инлайн-высоты, выставленные fillLastTileRow(),
        // иначе они перебивают CSS и плитки остаются большими в compact-режиме
        const statsCards = document.querySelector('.stats-cards');
        if (statsCards) {
            statsCards.style.removeProperty('--stat-tile-ref-h');
            statsCards.querySelectorAll('.stat-card').forEach(el => {
                el.style.removeProperty('height');
                el.style.removeProperty('grid-column');
                el.style.removeProperty('grid-row');
            });
        }
    } else {
        // При выходе из compact-mode убираем возможные инлайн-стили плиток
        const statsCards = document.querySelector('.stats-cards');
        if (statsCards) {
            statsCards.style.removeProperty('grid-template-columns');
            statsCards.style.removeProperty('grid-template-rows');
            statsCards.style.removeProperty('grid-auto-flow');
        }
        ['stat-qms','stat-favorites','stat-mentions',
         'stat-tickets','stat-bookmarks','stat-radio-inline'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.style.removeProperty('grid-column'); el.style.removeProperty('grid-row'); }
        });
        fillLastTileRow(); // восстанавливаем 6-колоночную сетку
    }
}

function updateSummaryBar() {
    // No-op: compact-summary-bar удалён из интерфейса.
    // Скрытые плитки просто не отображаются в flex-ряду — дублирование не нужно.
}

function applyCompactOnlyStats() {
    if (!settings.compact_stats) return;
    const onlyStats = settings.compact_only_stats;
    const showTopics = settings.compact_show_topics;
    // Скрываем main только если onlyStats И не включён показ тем
    const hideMain = onlyStats && !showTopics;
    if (elements.main)         elements.main.style.display         = hideMain ? 'none' : '';
    if (elements.themeActions) elements.themeActions.style.display = hideMain ? 'none' : '';
    document.body.classList.toggle('compact-only-stats-mode', !!hideMain);
}

function applyBookmarksVisibility(show) {
    const tile = elements.statBookmarks;
    const tab  = document.getElementById('bookmarks-list');

    // В compact-stats-mode: плитка закладок всегда видна если show_bookmarks_tab = true
    // (она становится маленькой иконкой в общем ряду — не занимает лишнего места)
    const tileVisible = show; // true → показать, false → скрыть
    if (tile) tile.style.display = tileVisible ? '' : 'none';
    if (tab)  tab.style.display  = show ? '' : 'none';

    // If bookmarks tab is active and we hide it — fall back to favorites
    if (!show) {
        const active = document.querySelector('.stat-card.active');
        if (active && (active.id === 'stat-bookmarks' || active.closest('#stat-bookmarks'))) {
            filterTopics('favorites');
        }
    }
    // 🔧 FIX: unified recalc instead of per-case gridColumn overrides
    recalcRow2Layout();
}

// ===================================
// COMPACT MODE
// ===================================
function toggleCompactMode() {
    settings.compact_mode = !settings.compact_mode;

    document.body.classList.toggle('compact-mode', settings.compact_mode);
    document.getElementById('compact-toggle')?.classList.toggle('active', settings.compact_mode);

    // Сохраняем настройку
    chrome.storage.local.set({ compact_mode: settings.compact_mode }, () => {
    });

    // Пересчитываем шрифты с учетом ограничения в компактном режиме
    applyFontSettings();

    // Пересчитываем высоту и правило скролла после изменения режима
    setTimeout(() => {
        // Применяем правило скролла к видимому списку
        const visibleList = document.querySelector('main .topics-list:not(.hidden)');
        if (visibleList) applyScrollRule(visibleList);
        adjustPopupHeight();
    }, 250);
}

// ===================================
// DYNAMIC POPUP HEIGHT
// ===================================

// Порог: скролл появляется только когда тем СТРОГО больше этого числа
// При ≤ SCROLL_THRESHOLD тем — высота по контенту, скролла нет
const SCROLL_THRESHOLD  = 4;  // скролл при 5+
// MAX_CARDS_VISIBLE заменён на settings.max_visible_topics (динамически)
// Firefox и Chrome ограничивают высоту попапа расширения ~600px.
// Константа должна быть статической — window.innerHeight в момент загрузки скрипта
// ещё не отражает реальную высоту попапа (DOM не laid out).
const MAX_POPUP_HEIGHT = 600;

// Реальный лимит высоты — фиксированный.
// В попапах Firefox/Chrome window.innerHeight отражает *текущую* высоту body,
// а не максимально допустимую. После collapsePopup window.innerHeight мал,
// и adjustPopupHeight неправильно ограничивает контент.
function getMaxPopupHeight() {
    return MAX_POPUP_HEIGHT;
}

let adjustHeightTimeout = null;

/**
 * Применяет правило скролла к списку:
 * items > SCROLL_THRESHOLD → overflow-y: auto, фиксированная высота
 * items ≤ SCROLL_THRESHOLD → overflow-y: hidden, высота по контенту
 * Работает одинаково в compact и normal режиме.
 */
function applyScrollRule(listEl) {
    if (!listEl) return;
    // Списки никогда не скроллят сами — скролл только на main
    listEl.style.overflowY = 'hidden';
    listEl.style.maxHeight  = '';
}

function adjustPopupHeight() {
    if (adjustHeightTimeout) clearTimeout(adjustHeightTimeout);
    adjustHeightTimeout = setTimeout(() => {
        requestAnimationFrame(() => {
            const header = document.querySelector('header');
            const main   = document.querySelector('main');
            if (!header || !main) return;
            // Вычисляем реальный лимит здесь — window.innerHeight уже корректный
            const MAX_H = getMaxPopupHeight();

            const chatOpen = !!document.querySelector('.qms-inline-chat:not(.hidden)');

            // Include radio bar in header height calculation
            const radioBar  = document.getElementById('mini-radio-bar');
            const radioBarH = (radioBar && radioBar.style.display !== 'none') ? radioBar.offsetHeight : 0;
            const headerH   = header.offsetHeight + radioBarH;

            if (main.classList.contains('hidden')) {
                // Add extra space if radio station panel is open (it's inside header)
                const rspPanel = document.getElementById('radio-station-panel');
                const rspExtra = (rspPanel && rspPanel.style.display !== 'none') ? 4 : 0;
                document.body.style.height = `${headerH + rspExtra}px`;
                return;
            }

            if (chatOpen) {
                const chatH = Math.min(window.screen.height - headerH - 40, 520);
                main.style.maxHeight = `${chatH}px`;
                main.style.overflowY = 'auto';
                document.body.style.height = `${headerH + chatH}px`;
                return;
            }

            const visibleList = main.querySelector('.topics-list:not(.hidden)');
            const isBookmarksList = visibleList?.classList.contains('bookmarks-list');
            const allCards = visibleList
                ? (isBookmarksList
                    ? visibleList.querySelectorAll('.bookmark-item, .bookmark-folder')
                    : visibleList.querySelectorAll('.topic-card'))
                : main.querySelectorAll('.topic-card');
            const visibleCards = Array.from(allCards).filter(c => c.style.display !== 'none');
            const cardCount = visibleCards.length;

            if (cardCount === 0) {
                main.style.maxHeight = '';
                main.style.overflowY = 'hidden';
                const emptyEl = document.getElementById('empty-state');
                const emptyH = emptyEl && !emptyEl.classList.contains('hidden') ? emptyEl.offsetHeight : 160;
                document.body.style.height = `${Math.min(headerH + emptyH + 16, MAX_H)}px`;
                return;
            }

            if (visibleList) applyScrollRule(visibleList);

            const mainCS  = window.getComputedStyle(main);
            const mainPad = (parseInt(mainCS.paddingTop) || 8) + (parseInt(mainCS.paddingBottom) || 8);
            const effectiveMax = (settings.max_visible_topics > 0) ? settings.max_visible_topics : Infinity;

            // ── Сбрасываем все ограничения main И body ─────────────────────────
            // ВАЖНО: body.height нужно убрать ПЕРЕД чтением scrollHeight.
            // В popup расширения браузер рендерит контент в рамках текущей высоты body.
            // Если body.height ≤ реального контента, scrollHeight возвращает
            // усечённое значение → неправильный capH → не доскроллить до конца.
            main.style.maxHeight = 'none';
            main.style.overflowY = 'hidden';
            document.body.style.minHeight = '';   // сброс minHeight от collapsePopup
            document.body.style.height = `${MAX_H}px`; // временно максимум → корректный reflow

            // Теперь scrollHeight отдаёт реальную полную высоту ВСЕГО списка.
            // НО: main — flex-ребёнок, он растягивается на всю высоту body.
            // scrollHeight вернёт растянутую высоту, а не реальный контент.
            // Поэтому читаем высоту из самого списка + padding main.
            const mainFlex = main.style.flex;
            main.style.flex = 'none';             // временно отключаем flex-stretch
            const fullListH = main.scrollHeight;
            main.style.flex = mainFlex || '';      // возвращаем flex

            if (effectiveMax === Infinity || cardCount <= effectiveMax) {
                // Показываем весь список без ограничения по числу карточек.
                const bodyH = headerH + fullListH;
                if (bodyH > MAX_H) {
                    // Не влезает — скролл в main по всему списку
                    const capH = MAX_H - headerH;
                    main.style.maxHeight = `${capH}px`;
                    main.style.overflowY = 'auto';
                    document.body.style.height = `${MAX_H}px`;
                } else {
                    // Всё влезает — без скролла
                    main.style.maxHeight = `${fullListH}px`;
                    main.style.overflowY = 'hidden';
                    document.body.style.height = `${bodyH}px`;
                }
            } else {
                // Ограничиваем видимую область по N карточкам — скролл по всему списку.
                //
                // ВАЖНО: offsetTop у элемента отсчитывается от его offsetParent.
                // Если ни main, ни ul не имеют position != static, offsetParent = body.
                // Поэтому используем getBoundingClientRect() — всегда в координатах viewport,
                // что позволяет надёжно вычислить высоту N карточек внутри main.
                const nthCard = visibleCards[effectiveMax - 1];
                const mainRect = main.getBoundingClientRect();

                let capH;
                if (nthCard) {
                    const nthRect = nthCard.getBoundingClientRect();
                    // Расстояние от верха main до нижнего края N-й карточки
                    const gap = parseInt(window.getComputedStyle(visibleList || main).gap) || 6;
                    capH = (nthRect.bottom - mainRect.top) + gap + (parseInt(window.getComputedStyle(main).paddingBottom) || 8);
                } else {
                    // Fallback: суммируем offsetHeight первых N карточек
                    let h = 0;
                    const count = Math.min(effectiveMax, cardCount);
                    for (let i = 0; i < count; i++) h += visibleCards[i].offsetHeight;
                    const gap = parseInt(window.getComputedStyle(visibleList || main).gap) || 6;
                    capH = h + Math.max(0, count - 1) * gap + mainPad;
                }

                capH = Math.min(capH, MAX_H - headerH);
                main.style.maxHeight = `${capH}px`;
                main.style.overflowY = 'auto';
                document.body.style.height = `${Math.min(headerH + capH, MAX_H)}px`;
            }
        });
    }, 30);
}

// ══════════════════════════════════════════════
// 4Pulse i18n — popup translations
// ══════════════════════════════════════════════
const POPUP_TRANSLATIONS = {
    ru: { popup_stats:'Статистика', popup_topics:'Темы', popup_mentions:'Ответы', popup_open_all:'Открыть все', popup_pinned:'Закреплённые', popup_read_all:'Прочитать все', popup_empty:'Непрочитанных тем нет', popup_last_update:'Последнее обновление:', radio_mini_radio:'🎵 Радио' },
    en: { popup_stats:'Stats', popup_topics:'Topics', popup_mentions:'Mentions', popup_open_all:'Open all', popup_pinned:'Pinned', popup_read_all:'Read all', popup_empty:'No unread topics', popup_last_update:'Last update:', radio_mini_radio:'🎵 Radio' },
    de: { popup_stats:'Statistik', popup_topics:'Themen', popup_mentions:'Erwähnungen', popup_open_all:'Alle öffnen', popup_pinned:'Angeheftet', popup_read_all:'Alle gelesen', popup_empty:'Keine ungelesenen Themen', popup_last_update:'Letzte Aktualisierung:', radio_mini_radio:'🎵 Radio' },
    uk: { popup_stats:'Статистика', popup_topics:'Теми', popup_mentions:'Відповіді', popup_open_all:'Відкрити всі', popup_pinned:'Закріплені', popup_read_all:'Прочитати всі', popup_empty:'Непрочитаних тем немає', popup_last_update:'Останнє оновлення:', radio_mini_radio:'🎵 Радіо' },
};

async function applyPopupLanguage() {
    try {
        const result = await chrome.storage.local.get(['ui_language']);
        const lang = result.ui_language || 'ru';
        const t = POPUP_TRANSLATIONS[lang] || POPUP_TRANSLATIONS['ru'];

        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.dataset.i18n;
            if (t[key]) el.textContent = t[key];
        });

        // Last-update label has a <span> inside — preserve it
        const luEl = document.querySelector('[data-i18n-prefix="popup_last_update"]');
        if (luEl && t['popup_last_update']) {
            const span = luEl.querySelector('#last-update-time');
            if (span) {
                luEl.childNodes.forEach(n => { if (n.nodeType === 3) n.textContent = t['popup_last_update'] + ' '; });
            }
        }
    } catch(e) { console.warn('i18n:', e); }
}

document.addEventListener('DOMContentLoaded', () => setTimeout(applyPopupLanguage, 50));

// Re-run clock date when language changes (storage event from options page)
chrome.storage.onChanged.addListener((changes) => {
    if (changes.ui_language) {
        applyPopupLanguage();
        // Re-render date with new language
        const dateEl = document.getElementById('current-date');
        if (dateEl) {
            const MONTHS = {
                ru: ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'],
                en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
                de: ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],
                uk: ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'],
            };
            const lang = changes.ui_language.newValue || 'ru';
            const now = new Date();
            const months = MONTHS[lang] || MONTHS['ru'];
            dateEl.textContent = lang === 'de'
                ? `${now.getDate()}. ${months[now.getMonth()]}`
                : `${now.getDate()} ${months[now.getMonth()]}`;
        }
    }
    // 🎵 Radio enabled/disabled externally
    if (changes.radio_enabled) {
        if (changes.radio_enabled.newValue) {
            _miniRadioInitialized = false;
            initMiniRadio();
        } else {
            const inlineCard = document.getElementById('stat-radio-inline');
            if (inlineCard) inlineCard.style.display = 'none';
            const bar = document.getElementById('mini-radio-bar');
            if (bar) bar.style.display = 'none';
            recalcRow2Layout();
        }
    }
});


// =======================================================
// QMS API ЗАПРОСЫ (БЫСТРЫЙ ОТВЕТ)
// =======================================================
async function qmsApiRequest(action, mid, t, additionalData = {}) {
    const url = 'https://4pda.to/forum/index.php?act=qms-xhr';
    const formData = new FormData();
    formData.append('action', action);
    formData.append('mid', mid);
    formData.append('t', t);

    for (const [key, value] of Object.entries(additionalData)) {
        formData.append(key, value);
    }

    const response = await fetch(url, {
        method: 'POST',
        body: formData,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });

    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);

    const text = await response.text(); // Получаем ответ как текст

    try {
        return JSON.parse(text); // Пытаемся распарсить как JSON (для отправки)
    } catch (e) {
        return { html: text };   // Если сервер вернул голый HTML (для истории и предпросмотра)
    }
}

// ════════════════════════════════════════════════════════
// 🎵 MINI RADIO PLAYER — popup
// Radio lives in background.js; popup just controls it.
// Player stays active when popup closes or options open.
// ════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────
// 🔧 FIX: Unified row-2 grid layout recalculation
// Tiles in DOM order (row 2): tickets → bookmarks → radio
// Rules:
//   1 visible  → spans full row (1 / -1)
//   2 visible  → first: 1 col (auto), second: stretches to fill rest (2 / -1)
//   3 visible  → each 1 col (fills 3-col grid perfectly)
// ─────────────────────────────────────────────────────────────


// ══════════════════════════════════════════════
// 🆕 Подсветка новых тем
// ══════════════════════════════════════════════
async function _loadNewTopicIds() {
    try {
        const r = await chrome.storage.local.get(['new_topic_ids', 'known_topic_ids']);
        _newTopicIds   = new Set((r.new_topic_ids   || []).map(String));
        _knownTopicIds = new Set((r.known_topic_ids || []).map(String));
    } catch(_) {}
}
function _saveNewTopicIds() {
    chrome.storage.local.set({ new_topic_ids: [..._newTopicIds] });
}
function _clearNewTopicId(id) {
    if (_newTopicIds.delete(String(id))) _saveNewTopicIds();
}

// ══════════════════════════════════════════════
// 🔀 DRAG & DROP — порядок плиток статистики
// ══════════════════════════════════════════════
const DRAGGABLE_TILE_IDS = [
    'stat-qms','stat-favorites','stat-mentions',
    'stat-bookmarks','stat-tickets','stat-radio-inline'
];
let _tilesOrder = [...DRAGGABLE_TILE_IDS];

async function loadTilesOrder() {
    try {
        const r = await chrome.storage.local.get('tiles_order');
        if (Array.isArray(r.tiles_order) && r.tiles_order.length > 0) {
            const saved = r.tiles_order.filter(id => DRAGGABLE_TILE_IDS.includes(id));
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

// Текущий конфиг рядов (загружается из storage)
let _tilesRowConfig = null;
const DEFAULT_ROW_CONFIG = {
    row1: ['stat-qms','stat-favorites','stat-mentions'],
    row2: ['stat-bookmarks','stat-tickets','stat-radio-inline']
};

async function loadTilesRowConfig() {
    try {
        const r = await chrome.storage.local.get('tiles_row_config');
        _tilesRowConfig = r.tiles_row_config?.row1 ? r.tiles_row_config : null;
    } catch(_) {}
}

function fillLastTileRow() {
    if (settings.compact_stats) return;
    const container = document.querySelector('.stats-cards');
    if (!container) return;

    container.style.gridTemplateColumns = 'repeat(60, minmax(0, 1fr))' /* 60=LCM(1..5) — равные плитки для любого N */; // поддержка до 5 плиток в ряду

    const allTiles = Array.from(container.querySelectorAll('.stat-card'));
    allTiles.forEach(el => { el.style.removeProperty('height'); el.style.removeProperty('grid-column'); el.style.removeProperty('order'); });

    const visible = allTiles.filter(el => el.style.display !== 'none');
    if (visible.length === 0) return;

    const cfg = _tilesRowConfig || DEFAULT_ROW_CONFIG;
    const row1ids = (cfg.row1 || []);
    const row2ids = (cfg.row2 || []);
    const hiddenIds = Object.keys({
        'stat-qms':1,'stat-favorites':1,'stat-mentions':1,
        'stat-bookmarks':1,'stat-tickets':1,'stat-radio-inline':1
    }).filter(id => !row1ids.includes(id) && !row2ids.includes(id));

    // Назначаем CSS order для правильного порядка в grid
    // Сетка 10 колонок: span зависит от числа плиток в ряду (до 5)
    // 1→10, 2→5, 3→(3+3+4 last), 4→(2+2+3+3 last two), 5→2
    const SPAN_MAP = {
        1: [60],
        2: [30, 30],
        3: [20, 20, 20],
        4: [15, 15, 15, 15],
        5: [12, 12, 12, 12, 12],
    };
    const setSpan = (ids, baseOrder) => {
        const visInRow = ids.filter(id => {
            const el = document.getElementById(id);
            return el && el.style.display !== 'none';
        });
        const count = Math.min(visInRow.length, 5);
        const spans = SPAN_MAP[count] || [2];
        visInRow.forEach((id, i) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.order = String(baseOrder + i);
            el.style.gridColumn = `span ${spans[i] ?? 2}`;
        });
    };

    // Скрытые плитки (не в обоих рядах) — уже скрыты по display:none если tile disabled
    // Здесь просто выставляем span по конфигу
    setSpan(row1ids, 0);
    setSpan(row2ids, 10);

    // Плитки которых нет в конфиге — в конец, span 2
    hiddenIds.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el && el.style.display !== 'none') {
            el.style.order = String(20 + i);
            el.style.gridColumn = 'span 2';
        }
    });

    // Выравниваем высоту строк по эталону
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

// Drag-drop плиток в попапе убран — порядок управляется через
// конфигуратор в Настройках → Внешний вид → «Расположение плиток»
function initTileDragDrop() { /* no-op */ }

function recalcRow2Layout() {
    if (settings.compact_stats) {
        // Откладываем — чтобы выполниться ПОСЛЕ всех синхронных вызовов в этом тике
        setTimeout(_applyCompactGrid, 0);
        return;
    }

    // Стандартный режим — fillLastTileRow управляет всем через 6-колоночную сетку
    const statsCards = document.querySelector('.stats-cards');
    if (statsCards) {
        statsCards.style.removeProperty('grid-template-rows');
        statsCards.style.removeProperty('grid-auto-flow');
    }
    // Сброс ручных grid-column у вторичных плиток перед пересчётом
    ['stat-tickets', 'stat-bookmarks', 'stat-radio-inline'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.style.removeProperty('grid-column'); el.style.removeProperty('grid-row'); }
    });
    fillLastTileRow();
}

let _miniRadioInitialized = false;
let _popupSleepTick = null;

function applyMiniRadioState(state) {
    if (!state) return;
    const nameEl      = document.getElementById('radio-inline-name');
    const trackEl     = document.getElementById('radio-inline-track');
    const artEl       = document.getElementById('radio-inline-art');
    const iconEl      = document.getElementById('radio-inline-icon');
    const volEl       = document.getElementById('radio-inline-vol');
    const btn         = document.getElementById('radio-inline-btn');
    setMiniRadioBtn(btn, state.isPlaying);
    if (volEl) volEl.value = state.volume ?? 70;

    const errMsg = state.lastError;
    if (errMsg && nameEl) {
        nameEl.textContent = '⚠ ' + errMsg;
        nameEl.style.color = 'var(--danger, #e74c3c)';
    } else if (nameEl) {
        nameEl.textContent = state.stationName || 'Радио';
        nameEl.style.color = '';
    }

    if (trackEl) {
        if (state.currentTrack) {
            trackEl.textContent = state.currentTrack;
            trackEl.removeAttribute('data-hidden');
            trackEl.style.removeProperty('display'); // контролируется container query
        } else {
            trackEl.setAttribute('data-hidden', '1');
            trackEl.style.display = 'none';
        }
    }
    if (artEl && iconEl) {
        if (state.trackArt) { artEl.src = state.trackArt; artEl.style.display = ''; iconEl.style.display = 'none'; }
        else { artEl.style.display = 'none'; iconEl.style.display = ''; }
    }

}

async function syncMiniRadioState() {
    try {
        const r = await chrome.storage.local.get(['radio_enabled']);
        if (!r.radio_enabled) return;
        const inlineCard = document.getElementById('stat-radio-inline');
        if (!inlineCard) return;
        inlineCard.style.display = '';
        recalcRow2Layout();
        const state = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
        if (state) applyMiniRadioState(state);
        if (!_miniRadioInitialized) initMiniRadio();
    } catch(e) { console.warn('syncMiniRadioState:', e); }
}

async function initMiniRadio() {
    if (_miniRadioInitialized) return;
    _miniRadioInitialized = true;

    try {
        const r = await chrome.storage.local.get(['radio_enabled']);
        if (!r.radio_enabled) { _miniRadioInitialized = false; return; }

        const inlineCard = document.getElementById('stat-radio-inline');
        if (!inlineCard) return;
        const bar = document.getElementById('mini-radio-bar');
        if (bar) bar.style.display = 'none';
        inlineCard.style.display = '';
        recalcRow2Layout();

        const state = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
        if (state) applyMiniRadioState(state);

        initRadioPanel();

        // Play/Pause
        document.getElementById('radio-inline-btn')?.addEventListener('click', async (e) => {
            e.stopPropagation();
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

        // Volume
        document.getElementById('radio-inline-vol')?.addEventListener('input', function() {
            chrome.runtime.sendMessage({ action: 'radio_set_volume', volume: parseInt(this.value) });
        });
        // 🖱 Колесо мыши на слайдере громкости — ±2% за шаг
        document.getElementById('radio-inline-vol')?.addEventListener('wheel', function(e) {
            e.preventDefault(); // только для этого элемента, остальной скролл не трогаем
            const step = e.shiftKey ? 5 : 2; // Shift = крупный шаг
            const val = Math.min(100, Math.max(0, parseInt(this.value) + (e.deltaY < 0 ? step : -step)));
            this.value = val;
            chrome.runtime.sendMessage({ action: 'radio_set_volume', volume: val });
        }, { passive: false }); // passive:false нужен чтобы preventDefault() сработал

        // Broadcast handler
        chrome.runtime.onMessage.addListener((msg) => {
            if (msg.action === 'radio_state') applyMiniRadioState(msg.state);
        });
    } catch(e) {
        _miniRadioInitialized = false;
        console.warn('Mini radio init:', e);
    }
}


function setMiniRadioBtn(btn, isPlaying) {
    if (!btn) return;
    btn.textContent = isPlaying ? '⏸' : '▶';
    btn.title = isPlaying ? 'Пауза' : 'Играть';
}


// ══════════════════════════════════════════════════════════
// 🎵 RADIO STATION PANEL
// ══════════════════════════════════════════════════════════

const RADIO_BUILT_IN = {
    '🇷🇺 Европа Плюс':       'https://ep256.hostingradio.ru:8052/europaplus256.mp3',
    '🇷🇺 Русское Радио':     'https://rusradio.hostingradio.ru/rusradio128.mp3',
    '🇷🇺 Радио Рекорд':      'https://radiorecord.hostingradio.ru/rr_main96.aacp',
    '🇷🇺 Ретро FM':          'https://retro.hostingradio.ru:8014/retro320.mp3',
    '🇷🇺 Радио Шансон':      'https://chanson.hostingradio.ru:8041/chanson256.mp3',
    '🇷🇺 DFM':               'https://dfm.hostingradio.ru/dfm96.aacp',
    '🇷🇺 DFM Russian Dance': 'https://dfm-dfmrusdance.hostingradio.ru/dfmrusdance96.aacp',
    '🇷🇺 Дорожное Радио':    'https://dorognoe.hostingradio.ru:8000/dorognoe',
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

let _rspOpen = false;

async function buildRadioPanel() {
    const panel   = document.getElementById('radio-station-panel');
    const listEl  = document.getElementById('rsp-list');
    if (!panel || !listEl) return;

    const [r, state] = await Promise.all([
        chrome.storage.local.get(['radio_custom_stations', 'radio_play_counts', 'radio_last_played', 'radio_hidden_stations']),
        chrome.runtime.sendMessage({ action: 'radio_get_state' }).catch(() => null),
    ]);
    const custom        = r.radio_custom_stations || {};
    const playCounts    = r.radio_play_counts     || {};
    const lastPlayed    = r.radio_last_played     || {};
    const hiddenUrls    = r.radio_hidden_stations  || [];
    const currentUrl    = state?.station || '';

    listEl.innerHTML = '';

    const customUrls = new Set(Object.values(custom));
    const hiddenSet  = new Set(hiddenUrls);

    function makeStation(name, url, isCustom) {
        const btn = document.createElement('button');
        btn.className = 'rsp-station interactive' + (url === currentUrl ? ' rsp-playing' : '');
        btn.dataset.url = url;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'rsp-station-name';
        nameSpan.textContent = (isCustom ? '⭐ ' : '') + name;
        btn.appendChild(nameSpan);

        const count = playCounts[url];
        if (count) {
            const countSpan = document.createElement('span');
            countSpan.className = 'rsp-play-count';
            countSpan.textContent = count + '×';
            btn.appendChild(countSpan);
        }

        // ── Action buttons ──────────────────
        const actions = document.createElement('span');
        actions.className = 'rsp-actions';
        actions.style.cssText = 'display:flex;align-items:center;gap:2px;flex-shrink:0;margin-left:auto;';

        if (isCustom) {
            // ✕ Remove from custom
            const removeBtn = document.createElement('span');
            removeBtn.className = 'rsp-action-btn interactive';
            removeBtn.textContent = '✕';
            removeBtn.title = 'Убрать из моих станций';
            removeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const updated = { ...custom };
                delete updated[name];
                await chrome.storage.local.set({ radio_custom_stations: updated });
                buildRadioPanel();
            });
            actions.appendChild(removeBtn);
        } else {
            // ☆ / ★ Add to custom
            if (!customUrls.has(url)) {
                const favBtn = document.createElement('span');
                favBtn.className = 'rsp-action-btn interactive';
                favBtn.textContent = '☆';
                favBtn.title = 'Добавить в мои станции';
                favBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const updated = { ...custom, [name]: url };
                    await chrome.storage.local.set({ radio_custom_stations: updated });
                    buildRadioPanel();
                });
                actions.appendChild(favBtn);
            } else {
                const starEl = document.createElement('span');
                starEl.className = 'rsp-action-btn';
                starEl.textContent = '★';
                starEl.style.color = 'var(--accent)';
                starEl.style.cursor = 'default';
                starEl.title = 'Уже в моих станциях';
                actions.appendChild(starEl);
            }

            // ✕ Hide built-in station
            const hideBtn = document.createElement('span');
            hideBtn.className = 'rsp-action-btn interactive';
            hideBtn.textContent = '✕';
            hideBtn.title = 'Скрыть станцию';
            hideBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const updated = [...hiddenUrls, url];
                await chrome.storage.local.set({ radio_hidden_stations: updated });
                buildRadioPanel();
            });
            actions.appendChild(hideBtn);
        }

        btn.appendChild(actions);

        // ── Play on click ────
        btn.addEventListener('click', async (e) => {
            if (e.target.closest('.rsp-action-btn')) return;

            // ★ FIX: Закрываем панель ДО любых await/set, чтобы storage.onChanged
            // не успел вызвать buildRadioPanel() пока _rspOpen ещё true.
            // Иначе rebuild гонится с closeRadioPanel() и ломает повторное открытие.
            const nameEl = document.getElementById('radio-inline-name');
            if (nameEl) nameEl.textContent = name;
            setMiniRadioBtn(document.getElementById('radio-inline-btn'), true);
            closeRadioPanel();

            // Save play count + last played timestamp
            const fresh = await chrome.storage.local.get(['radio_play_counts', 'radio_last_played']);
            const counts = fresh.radio_play_counts || {};
            const lp     = fresh.radio_last_played || {};
            counts[url] = (counts[url] || 0) + 1;
            lp[url]     = Date.now();
            await chrome.storage.local.set({ radio_play_counts: counts, radio_last_played: lp });

            // Switch station
            await chrome.storage.local.set({ radio_station: url, radio_station_name: name });
            await chrome.runtime.sendMessage({ action: 'radio_play', station: url, stationName: name });
        });

        return btn;
    }

    // Sort helper: by last played timestamp (most recent first), unplayed at bottom
    const sortByLastPlayed = (entries) => {
        return entries.slice().sort((a, b) => {
            const ta = lastPlayed[a[1]] || 0;
            const tb = lastPlayed[b[1]] || 0;
            return tb - ta; // newest first
        });
    };

    // ── Custom stations (sorted by last played) ──
    const customEntries = sortByLastPlayed(Object.entries(custom));
    if (customEntries.length > 0) {
        const label = document.createElement('div');
        label.className = 'rsp-section-label';
        label.textContent = 'Мои станции';
        listEl.appendChild(label);
        customEntries.forEach(([name, url]) => listEl.appendChild(makeStation(name, url, true)));
    }

    // ── Built-in stations (sorted by last played, hidden removed) ──
    const builtInEntries = sortByLastPlayed(
        Object.entries(RADIO_BUILT_IN).filter(([, url]) => !hiddenSet.has(url))
    );
    if (builtInEntries.length > 0) {
        const label2 = document.createElement('div');
        label2.className = 'rsp-section-label';
        label2.textContent = customEntries.length > 0 ? 'Встроенные' : 'Станции';
        listEl.appendChild(label2);
        builtInEntries.forEach(([name, url]) => listEl.appendChild(makeStation(name, url, false)));
    }

    // ── Restore hidden stations link ──
    if (hiddenUrls.length > 0) {
        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'rsp-station interactive';
        restoreBtn.style.cssText = 'color:var(--text-3);font-size:11px;justify-content:center;opacity:0.7;';
        restoreBtn.textContent = `Показать скрытые (${hiddenUrls.length})`;
        restoreBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await chrome.storage.local.set({ radio_hidden_stations: [] });
            buildRadioPanel();
        });
        listEl.appendChild(restoreBtn);
    }
}

let _previousFilter = null; // ★ FIX: запоминаем фильтр до открытия радио-панели

function openRadioPanel() {
    const panel = document.getElementById('radio-station-panel');
    const tile  = document.getElementById('stat-radio-inline');
    if (!panel) return;

    // Запоминаем текущий фильтр чтобы восстановить при закрытии
    _previousFilter = currentFilter;

    // Collapse main topic list — radio panel replaces it visually
    if (elements.main && !elements.main.classList.contains('hidden')) {
        hideElement(elements.main);
    }
    // Clear current filter so other tiles lose their active state
    currentFilter = 'radio';
    if (currentData) updateStats(currentData);

    _rspOpen = true;
    tile?.classList.add('active');
    buildRadioPanel();
    panel.style.display = '';
    adjustPopupHeight();
}

function closeRadioPanel() {
    const panel = document.getElementById('radio-station-panel');
    const tile  = document.getElementById('stat-radio-inline');
    if (!panel) return;
    _rspOpen = false;
    tile?.classList.remove('active');
    panel.style.display = 'none';

    // ★ FIX: восстанавливаем фильтр который был до открытия радио-панели.
    // Без этого currentFilter=null и любой filterTopics(currentFilter||'favorites')
    // переключал на «Избранное» даже если пользователь был на другой вкладке.
    if (currentFilter === 'radio') {
        currentFilter = _previousFilter;
    }
    _previousFilter = null;

    if (elements.main) showElement(elements.main);
    adjustPopupHeight();
}

function toggleRadioPanel() {
    _rspOpen ? closeRadioPanel() : openRadioPanel();
}

// Wire radio tile click → toggle panel (click on icon area, not slider/btn)
function initRadioPanel() {
    const tile   = document.getElementById('stat-radio-inline');
    const slider = document.getElementById('radio-inline-vol');
    const playBtn = document.getElementById('radio-inline-btn');
    const closeBtn = document.getElementById('rsp-close');

    if (tile) {
        // pointerdown + pointerup: immune to drag-system interference.
        // Compare position delta only at up — no mousemove listener needed.
        let _pdX = 0, _pdY = 0, _pdT = 0;
        tile.addEventListener('pointerdown', (e) => {
            _pdX = e.clientX; _pdY = e.clientY; _pdT = Date.now();
        });
        tile.addEventListener('pointerup', (e) => {
            const dx = Math.abs(e.clientX - _pdX);
            const dy = Math.abs(e.clientY - _pdY);
            const dt = Date.now() - _pdT;
            // Only treat as tap if quick (<300ms) and barely moved (<10px)
            if (dt > 300 || dx > 10 || dy > 10) return;
            if (e.target === slider || slider?.contains(e.target)) return;
            if (e.target === playBtn || playBtn?.contains(e.target)) return;
            e.stopPropagation();
            toggleRadioPanel();
        });
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeRadioPanel(); });
    }

    // Close panel when pointer pressed outside tile and panel
    document.addEventListener('pointerdown', (e) => {
        if (!_rspOpen) return;
        const panel = document.getElementById('radio-station-panel');
        const tile  = document.getElementById('stat-radio-inline');
        if (panel && !panel.contains(e.target) && tile && !tile.contains(e.target)) {
            closeRadioPanel();
        }
    });

    // Refresh panel if custom stations change externally
    // ★ FIX: НЕ слушаем radio_station — его изменение происходит при выборе станции,
    // когда closeRadioPanel() уже вызван. Rebuild в этот момент ломал повторное открытие.
    chrome.storage.onChanged.addListener((changes) => {
        if (_rspOpen && changes.radio_custom_stations) {
            buildRadioPanel();
        }
    });

    // ── Таймер сна: кнопка в панели ──────────────────────────
    let _panelSleepTick = null;
    function updatePanelSleepStatus(endsAt) {
        if (_panelSleepTick) { clearInterval(_panelSleepTick); _panelSleepTick = null; }
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
            if (rem <= 0) { clearInterval(_panelSleepTick); _panelSleepTick = null; }
        }
        tick();
        _panelSleepTick = setInterval(tick, 1000);
    }
    // Sync sleep status when panel opens
    const origOpen = openRadioPanel;
    // Patch open to also refresh sleep state
    document.getElementById('rsp-sleep-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const area = document.getElementById('rsp-sleep-area');
        if (area) area.style.display = area.style.display === 'none' ? '' : 'none';
    });
    document.querySelectorAll('#rsp-sleep-area .rsp-sleep-opt').forEach(b => {
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const min = parseInt(b.dataset.min);
            const resp = await chrome.runtime.sendMessage({ action: 'radio_set_sleep_timer', minutes: min });
            const area = document.getElementById('rsp-sleep-area');
            if (area) area.style.display = 'none';
            if (min > 0) {
                const endsAt = Date.now() + min * 60000;
                updatePanelSleepStatus(endsAt);
            } else {
                updatePanelSleepStatus(null);
            }
        });
    });
    // Refresh sleep status whenever panel opens
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'radio_state' && _rspOpen) updatePanelSleepStatus(msg.state?.sleepEndsAt);
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
            renderRadioPanelHistory(history || []);
        }
    });
    document.getElementById('rsp-history-clear')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await chrome.runtime.sendMessage({ action: 'radio_clear_history' });
        renderRadioPanelHistory([]);
    });
}

function renderRadioPanelHistory(history) {
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

// placeholder closing brace removed — the real one was above

document.addEventListener('DOMContentLoaded', () => initMiniRadio());

// ─────────────────────────────────────────────────────────────
// 🎫 TICKETS rendering
// ─────────────────────────────────────────────────────────────
// 🎫 Section icon mapper — detects platform/category from section name
function getTicketSectionIcon(section) {
    if (!section) return '';
    const s = section.toLowerCase();
    // Apple / iOS ecosystem
    if (s.includes('ios')   || s.includes('iphone') || s.includes('ipad') ||
        s.includes('apple') || s.includes('macos')  || s.includes('mac os'))   return '🍎';
    // Android ecosystem
    if (s.includes('android'))                                                  return '🤖';
    // Windows / PC
    if (s.includes('windows') || s.includes('pc ') || s === 'pc' ||
        s.includes(' pc')     || s.includes('компьютер'))                       return '🖥️';
    // Samsung
    if (s.includes('samsung'))                                                  return '📱';
    // Xiaomi / MIUI / HyperOS
    if (s.includes('xiaomi') || s.includes('miui') || s.includes('hyperos') ||
        s.includes('redmi')  || s.includes('poco'))                             return '📱';
    // Huawei / Honor
    if (s.includes('huawei') || s.includes('honor'))                           return '📱';
    // Games
    if (s.includes('игр') || s.includes('game'))                               return '🎮';
    // Apps / programs
    if (s.includes('программ') || s.includes('приложен') || s.includes('app')) return '📦';
    // Firmware / flash / ROM
    if (s.includes('прошив') || s.includes('rom') || s.includes('firmware'))   return '⚡';
    // Base of knowledge / wiki
    if (s.includes('база знаний') || s.includes('wiki'))                       return '📚';
    // Offtopic / chat
    if (s.includes('офтоп') || s.includes('оффтоп') || s.includes('чат'))      return '💬';
    // Generic device / hardware
    if (s.includes('устройств') || s.includes('device') || s.includes('гаджет')) return '📟';
    return '🏷️';  // fallback generic tag
}

// ── Persistent curator cache (survives popup close/open) ─────────────────
const CURATOR_CACHE_KEY = 'ticket_curator_cache';
let _curatorCache = null; // {ticketId: {curator, responsible, topicTitle, topicUrl, ts}}

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
                changeTicketStatus(ticket.id, 'в работе', li);
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
                changeTicketStatus(ticket.id, 'обработан', li);
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

// Send ticket action via sendMessage (background handles via onMessage)
function sendTicketAction(action, extra = {}) {
    chrome.runtime.sendMessage({ action, ...extra })
        .catch(e => console.warn('sendTicketAction error:', action, e));
}

// Применяет данные с треда к карточке тикета: куратор, ответственный, тема
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
                    if (settings.close_on_open) window.close();
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

function changeTicketStatus(ticketId, newStatus, liEl) {
    // Optimistic UI: update badge immediately
    const STATUS_LABEL = {
        'не обработан': { text: 'Не обработан', cls: 'ticket-status-new' },
        'в работе':     { text: 'В работе',      cls: 'ticket-status-wip' },
        'обработан':    { text: 'Обработан',      cls: 'ticket-status-done' },
    };
    if (liEl) {
        const info  = STATUS_LABEL[newStatus];
        const badge = liEl.querySelector('.ticket-status');
        if (badge && info) {
            badge.className   = 'ticket-status ' + info.cls;
            badge.textContent = info.text;
        }
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
        .catch(e => console.warn('changeTicketStatus error:', e));
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ══════════════════════════════════════════════════════════════════
// 🔖 BOOKMARKS — render, rename, delete
// ══════════════════════════════════════════════════════════════════

/**
 * Строит дерево закладок в #bookmarks-list.
 * Папки раскрываемые, внутри могут быть другие элементы.
 * @param {Array} bookmarks — массив из WS (ws.js #processBookmarks)
 */


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

    // Чекбокс "Переходить к непрочитанным" — добавляет &view=getnewpost к URL
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
// Храним Set из ID папок которые свёрнуты. Персистится в storage.
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

    // ── Кнопка «+ Добавить» (сверху списка) ─────────────────
    const addLi = document.createElement('li');
    addLi.style.cssText = 'display:flex;justify-content:flex-end;padding:2px 4px 4px;';
    const addBtn = document.createElement('button');
    addBtn.innerHTML = '＋ Добавить';
    addBtn.style.cssText = 'padding:4px 12px;border-radius:8px;border:1px dashed var(--border-md);background:transparent;color:var(--text-2);font-size:11px;cursor:pointer;';
    addBtn.title = 'Добавить закладку';
    addBtn.addEventListener('click', async () => {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs[0];
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
        list.innerHTML = `
            <li class="bookmarks-empty">
                <svg class="icon-xl"><use href="#icon-bookmark"></use></svg>
                Закладки не загружены
            </li>`;
        return;
    }

    // Фильтруем удалённые
    const active = bookmarks.filter(b => !b.deleted);

    // Индекс: id → bookmark
    const byId = {};
    active.forEach(b => { byId[b.id] = b; });

    // Рендерим рекурсивно начиная с корня (parentId === 0)
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

            // Дочерние элементы
            const children = active
                .filter(b => b.parentId === bm.id)
                .sort((a, b) => a.sortOrder - b.sortOrder);

            const childUl = li.querySelector('.bookmark-folder-children');
            children.forEach(child => {
                const childNode = buildItem(child);
                if (childNode) childUl.appendChild(childNode);
            });

            if (children.length === 0) childUl.style.display = 'none';

            // Collapse/expand по клику на заголовок (не по кнопкам действий)
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

            // Открываем ссылку по клику (не по кнопкам действий)
            li.addEventListener('click', (e) => {
                if (e.target.closest('.bookmark-actions')) return;
                if (bm.url) {
                    chrome.runtime.sendMessage({ action: 'open_url', what: 'external', url: bm.url });
                }
            });

            wireBookmarkActions(li, bm);
            return li;
        }
    }

    // Корневые элементы (parentId === 0 или parentId не в списке)
    const roots = active
        .filter(b => !b.parentId || !byId[b.parentId])
        .sort((a, b) => a.sortOrder - b.sortOrder);

    roots.forEach(bm => {
        const node = buildItem(bm);
        if (node) list.appendChild(node);
    });
}

/**
 * Навешивает обработчики кнопок «переименовать» и «удалить» на элемент закладки.
 * @param {HTMLElement} li   — .bookmark-item или .bookmark-folder
 * @param {Object}      bm   — объект закладки
 */
function wireBookmarkActions(li, bm) {
    const renameBtn = li.querySelector('.bm-rename-btn');
    const deleteBtn = li.querySelector('.bm-delete-btn');
    const titleEl   = li.querySelector('.bookmark-folder-title, .bookmark-item-title');

    console.log(`[BM] wireBookmarkActions id=${bm.id} title="${bm.title}" renameBtn=${!!renameBtn} deleteBtn=${!!deleteBtn}`);

    // ── Rename ──
    renameBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log(`[BM] rename click id=${bm.id}`);

        if (li.querySelector('.bm-rename-input')) return;

        const oldTitle = bm.title;
        const input = document.createElement('input');
        input.className = 'bm-rename-input';
        input.type      = 'text';
        input.value     = oldTitle;
        input.maxLength = 200;

        titleEl.replaceWith(input);
        input.focus();
        input.select();

        let committed = false;
        async function commit() {
            if (committed) return;
            const newTitle = input.value.trim();
            console.log(`[BM] commit rename id=${bm.id} newTitle="${newTitle}" oldTitle="${oldTitle}"`);
            if (!newTitle || newTitle === oldTitle) {
                committed = true;
                input.replaceWith(titleEl);
                return;
            }
            committed = true;
            input.disabled = true;
            try {
                console.log(`[BM] sendMessage bookmark_rename id=${bm.id}`);
                const resp = await sendMessage({
                    action: 'bookmark_rename',
                    id: bm.id,
                    title: newTitle,
                });
                console.log(`[BM] bookmark_rename resp:`, resp);
                if (resp?.ok) {
                    bm.title = newTitle;
                    titleEl.textContent = newTitle;
                    if (currentData?.bookmarks?.list) {
                        const entry = currentData.bookmarks.list.find(b => b.id === bm.id);
                        if (entry) entry.title = newTitle;
                    }
                } else {
                    showBmToast('Не удалось переименовать. Проверь соединение.');
                }
            } catch (err) {
                console.error(`[BM] bookmark_rename error:`, err);
                showBmToast('Ошибка: ' + err.message);
            }
            input.replaceWith(titleEl);
        }

        input.addEventListener('blur',    () => commit());
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter')  { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { committed = true; input.replaceWith(titleEl); }
        });
    });

    // ── Delete ──
    deleteBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log(`[BM] delete click id=${bm.id}`);

        // Inline confirm — показываем прямо в li
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

        confirmRow.querySelector('.bm-confirm-no').addEventListener('click', (ev) => {
            ev.stopPropagation();
            confirmRow.remove();
        });

        confirmRow.querySelector('.bm-confirm-yes').addEventListener('click', async (ev) => {
            ev.stopPropagation();
            confirmRow.remove();
            li?.classList.add('is-loading');
            try {
                console.log(`[BM] sendMessage bookmark_delete id=${bm.id}`);
                const resp = await sendMessage({ action: 'bookmark_delete', id: bm.id });
                console.log(`[BM] bookmark_delete resp:`, resp);
                if (resp?.ok) {
                    li.remove();
                    if (currentData?.bookmarks?.list) {
                        currentData.bookmarks.list = currentData.bookmarks.list.filter(b => b.id !== bm.id);
                    }
                    // Чистим сохранённое collapsed-состояние удалённой папки
                    if (bm.isFolder) {
                        _collapsedFolders.delete(String(bm.id));
                        _saveCollapsedFolders();
                    }
                } else {
                    li?.classList.remove('is-loading');
                    showBmToast('Не удалось удалить. WS: ' + (resp?.error || 'нет ответа'));
                }
            } catch (err) {
                li?.classList.remove('is-loading');
                console.error(`[BM] bookmark_delete error:`, err);
                showBmToast('Ошибка: ' + err.message);
            }
        });
    });
}

function showBmConfirm(msg, onOk) {
    const dialog = document.getElementById('bm-confirm-dialog');
    if (!dialog) { if (onOk && confirm(msg)) onOk(); return; }
    document.getElementById('bm-confirm-msg').textContent = msg;
    dialog.style.display = 'flex';
    const ok     = document.getElementById('bm-confirm-ok');
    const cancel = document.getElementById('bm-confirm-cancel');
    const close  = () => { dialog.style.display = 'none'; ok.onclick = null; cancel.onclick = null; };
    ok.onclick     = () => { close(); onOk(); };
    cancel.onclick = () => close();
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

// ══════════════════════════════════════════════════════════════════
// ⌨️ KEYBOARD SHORTCUTS
// ══════════════════════════════════════════════════════════════════
document.addEventListener('keydown', (e) => {
    // Skip if typing in input/textarea
    if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
        case '1': toggleFilter('qms');       break;
        case '2': toggleFilter('favorites'); break;
        case '3': toggleFilter('mentions');  break;
        case '4': if (settings.show_bookmarks_tab) toggleFilter('bookmarks'); break;
        case '5': if (currentData?.tickets?.enabled) toggleFilter('tickets'); break;
        case 'r': case 'R': handleRefreshClick(); break;
        case 'Escape': collapsePopup(); break;
        case 'ArrowDown': {
            const cards = [...document.querySelectorAll('main .topic-card:not([style*="display: none"])')];
            const focused = document.querySelector('.topic-card:focus');
            const idx = focused ? cards.indexOf(focused) : -1;
            cards[Math.min(idx + 1, cards.length - 1)]?.focus();
            e.preventDefault(); break;
        }
        case 'ArrowUp': {
            const cards = [...document.querySelectorAll('main .topic-card:not([style*="display: none"])')];
            const focused = document.querySelector('.topic-card:focus');
            const idx = focused ? cards.indexOf(focused) : cards.length;
            cards[Math.max(idx - 1, 0)]?.focus();
            e.preventDefault(); break;
        }
        case 'Enter': {
            const focused = document.querySelector('.topic-card:focus');
            focused?.click();
            break;
        }
    }
});
