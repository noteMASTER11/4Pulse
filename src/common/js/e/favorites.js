import { open_url } from '../browser.js';
import { AbstractEntity } from './abstract.js';
import { SETTINGS } from '../config/settings.js';



const DEBUG = () => globalThis.__FOURPULSE_DEBUG__ === true;
function debugLog(...args) { if (DEBUG()) console.log(...args); }
function debugWarn(...args) { if (DEBUG()) console.warn(...args); }

function _sort_by_last_post(a, b) {
    return b.last_post_ts - a.last_post_ts;
}

function _sort_with_pin(a, b) {
    if (a.pin == b.pin) {
        return _sort_by_last_post(a, b);
    } else {
        return b.pin - a.pin;
    }
}

export class Favorites extends AbstractEntity {
    ACT_CODE_API = 'fav';
    ACT_CODE_FORUM = 'fav';

    get #list_filtered() {
        return super.list.filter(theme => !theme.viewed);
    }

    /**  @returns {FavoriteTheme[]} */
    get list_pin() {
        return super.list.filter(theme => !theme.viewed && theme.pin);
    }

    /**  @returns {FavoriteTheme[]} */
    get list() {
        // 🔧 FIX: Use Inspector API data only
        // If show_all_favorites is enabled, show all themes (including viewed)
        // If disabled, show only unread themes
        const sourceList = SETTINGS.show_all_favorites ? super.list : this.#list_filtered;
        
        return sourceList.sort(
            SETTINGS.toolbar_pin_themes_level == 10
                ? _sort_with_pin
                : _sort_by_last_post
        );
    }

    get count() {
        return this.#list_filtered.length;
    }

    filter_pin(only_pin) {
        if (only_pin) {
            this._list = Object.fromEntries(Object.entries(this._list).filter(([key, value]) => value.pin));
            this.cs.update_action();
        } else {
            this.notify = false;
            super.update()
                .then(() => {
                    this.cs.update_action();
                });
        }
    }

    // 🆕 NEW: Override update() to choose between WS, Inspector API and HTML parsing
    async update(forceRefresh = false) {
        if (SETTINGS.show_all_favorites) {
            // 🔌 WS подключён и не форсированное обновление →
            // запрашиваем список через сокет (чистый JSON, без риска 403).
            // Данные придут асинхронно: onBookmarks → updateFromWs() → update_action().
            if (this.cs.wsConnected && !forceRefresh) {
                this.cs.requestFavoritesFromWs();
                return;
            }
            // Fallback: парсим HTML-страницу как раньше
            return this.updateFull();
        } else {
            // show_all_favorites = false: Inspector API отдаёт только непрочитанные
            // с полными метаданными (last_user_name, last_post_ts, pin).
            // 🔌 Если WS подключён — Inspector API тоже может быть заблокирован Cloudflare.
            // Пробуем HTTP, при ошибке — fallback на WS-закладки.
            // WS-данные не несут unread-флага, поэтому помечаем всё viewed=false
            // (показываем все темы как «новые»). Лучше чем пустой список.
            try {
                return await super.update();
            } catch (e) {
                if (this.cs.wsConnected) {
                    debugWarn('[Favorites] Inspector API недоступен — запрашиваем WS-закладки как fallback');
                    this.cs.requestFavoritesFromWs();
                } else {
                    throw e;
                }
            }
        }
    }

    /**
     * Обновляет список закладок из данных, пришедших через WebSocket (команда "mb").
     *
     * Работает в обоих режимах:
     *   show_all_favorites = true  → показываем все темы, viewed берём из Inspector если есть
     *   show_all_favorites = false → WS не знает unread-статус; помечаем viewed=false
     *                                (тема появится в списке), при следующем push исправится
     *
     * @param {Array<{id, date, deleted, isFolder, parentId, sortOrder, title, url}>} rawBookmarks
     */
    updateFromWs(rawBookmarks) {
        // 🔔 FIX: Сохраняем старый список ДО замены, чтобы сравнить
        // и выявить новые/обновлённые темы для уведомлений.
        const oldList = { ...this._list };
        const new_list = {};

        for (const bm of rawBookmarks) {
            // Пропускаем удалённые и папки — в списке тем они не нужны
            if (bm.deleted || bm.isFolder) continue;

            // Извлекаем ID темы из URL вида "forum/index.php?showtopic=636743&st=480"
            const topicMatch = bm.url.match(/showtopic=(\d+)/);
            if (!topicMatch) continue;

            const topicId = parseInt(topicMatch[1], 10);

            // Берём актуальные метаданные из Inspector API если они есть
            const existing = this._list[topicId];

            const themeData = [
                topicId,
                bm.title,
                0,                                          // posts_num — не используется
                existing?.last_user_id ?? 0,                // last_user_id
                existing?.last_user_name ?? '',             // last_user_name
                existing?.last_post_ts   ?? bm.date,       // last_post_ts (оба — Unix секунды)
                0,                                          // last_read_ts — не используется
                existing?.pin ? 1 : 0,                     // pin
                existing?.last_user_profile_url ?? ''       // last_user_profile_url
            ];

            const theme = new FavoriteTheme(themeData, this.cs);

            // viewed-статус:
            // - show_all_favorites=true: если тема есть в Inspector (_list) — берём её статус,
            //   иначе она прочитана (Inspector показывает только непрочитанные).
            // - show_all_favorites=false (fallback, HTTP упал): WS не знает unread-статус.
            //   Помечаем viewed=false — тема появится в списке как «новая».
            //   Это лучше, чем пустой список. При следующем HTTP-успехе статус исправится.
            if (SETTINGS.show_all_favorites) {
                theme.viewed = existing ? existing.viewed : true;
            } else {
                theme.viewed = existing ? existing.viewed : false;
            }

            new_list[topicId] = theme;
        }

        this._list = new_list;

        // 🔔 FIX: Уведомляем о новых/изменённых темах (только не при первом запуске).
        // Сравниваем новый список со старым: если тема появилась впервые или её
        // last_post_ts стал больше — значит пришёл новый комментарий → уведомление.
        if (this.notify) {
            chrome.storage.local.get(['muted_topics', 'focused_topics']).then(stored => {
                const mutedTopics   = (stored.muted_topics   || []).map(String);
                const focusedTopics = (stored.focused_topics || []).map(String);

                for (const theme of Object.values(new_list)) {
                    if (theme.viewed) continue; // Прочитанные не уведомляем

                    const old = oldList[theme.id];
                    const isNew     = !old;
                    const isUpdated = old && (old.last_post_ts < theme.last_post_ts);

                    if (!isNew && !isUpdated) continue;

                    const n_level = theme.pin ? 5 : 10;
                    if (n_level > SETTINGS.notification_themes_level) continue;

                    if (mutedTopics.includes(String(theme.id))) continue;

                    theme.notification();

                    if (focusedTopics.includes(String(theme.id))) {
                        if (typeof globalThis.startPriorityBlink === 'function') {
                            globalThis.startPriorityBlink();
                        }
                    }
                }
            });
        }

        this.notify = true;

        debugLog(`[Favorites] WS: обновлено ${Object.keys(new_list).length} закладок`);
    }

    // 🆕 NEW: Parse favorites HTML page to get all topics (using REGEX, no DOMParser)
    async updateFull() {
        
        try {
            const response = await fetch('https://4pda.to/forum/index.php?act=fav', {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            // Decode Windows-1251
            const arrayBuffer = await response.arrayBuffer();
            const decoder = new TextDecoder('windows-1251');
            const html = decoder.decode(arrayBuffer);


            // Parse HTML using regex (like QMS and Mentions do)
            const themes = this.#parseFavoritesPage(html);
            
            // 🔔 FIX: Сохраняем старый список ДО замены для сравнения
            const oldList = { ...this._list };

            const new_list = {};
            themes.forEach(theme => {
                new_list[theme.id] = theme;
            });

            this._list = new_list;

            // 🔔 FIX: Уведомляем о новых/изменённых темах (только не при первом запуске)
            if (this.notify) {
                chrome.storage.local.get(['muted_topics', 'focused_topics']).then(stored => {
                    const mutedTopics   = (stored.muted_topics   || []).map(String);
                    const focusedTopics = (stored.focused_topics || []).map(String);

                    for (const theme of Object.values(new_list)) {
                        if (theme.viewed) continue;

                        const old = oldList[theme.id];
                        const isNew     = !old;
                        const isUpdated = old && (old.last_post_ts < theme.last_post_ts);

                        if (!isNew && !isUpdated) continue;

                        const n_level = theme.pin ? 5 : 10;
                        if (n_level > SETTINGS.notification_themes_level) continue;

                        if (mutedTopics.includes(String(theme.id))) continue;

                        theme.notification();

                        if (focusedTopics.includes(String(theme.id))) {
                            if (typeof globalThis.startPriorityBlink === 'function') {
                                globalThis.startPriorityBlink();
                            }
                        }
                    }
                });
            }

            this.notify = true;
            
            
        } catch (error) {
            console.error('Failed to fetch favorites HTML:', error);
            // Fallback to Inspector API
            return super.update();
        }
    }

    // 🆕 NEW: Parse favorites page using regex (matching actual 4PDA structure)
    #parseFavoritesPage(html) {
        const themes = [];
        const processedIds = new Set();
        
        // 4PDA favorites page uses IPB structure: rows marked with data-item-fid.
        // IMPORTANT: rows contain nested tables with their own </tr> tags, so we cannot
        // use lazy matching ([\s\S]*?). Instead we split on the data-item-fid marker
        // and treat each chunk between consecutive markers as one row.
        const rowSplitRegex = /<tr[^>]+data-item-fid=["'](\d+)["'][^>]*data-item-pin=["'](\d+)["'][^>]*>/gi;
        
        // Collect all row start positions and their attributes
        const rowStarts = [];
        let m;
        while ((m = rowSplitRegex.exec(html)) !== null) {
            rowStarts.push({ index: m.index, fid: m[1], pin: m[2], end: m.index + m[0].length });
        }
        
        // Build fake iterable to match old code pattern
        const rows = rowStarts.map((rs, i) => {
            const nextStart = rowStarts[i + 1] ? rowStarts[i + 1].index : html.length;
            const rowHtmlChunk = html.slice(rs.end, nextStart);
            return [null, rs.fid, rs.pin, rowHtmlChunk];
        });
        
        let rowCount = 0;
        
        for (const rowMatch of rows) {
            rowCount++;
            // rowMatch = [null, fid, pin, rowHtmlChunk]
            const isPinned = (rowMatch[2] === '1');
            const rowHtml = rowMatch[3];
            
            try {
                // Extract topic ID and title
                // Pattern for UNREAD: <a href="...showtopic=XXXXX&view=getnewpost">...<span><a href="...showtopic=XXXXX"><strong>TITLE</strong></a>
                // Pattern for READ: <span><a href="...showtopic=XXXXX">TITLE</a> (no <strong>)
                
                // First, find if this is unread (has view=getnewpost)
                const hasGetnewpost = rowHtml.includes('view=getnewpost');
                
                // Extract topic ID from the main topic link (in <span>)
                // Pattern: <span><a href="...showtopic=XXXXX" title="...">TITLE</a></span>
                const topicLinkRegex = /<span><a href=["'][^"']*showtopic=(\d+)["'][^>]*>([\s\S]*?)<\/a><\/span>/i;
                const linkMatch = rowHtml.match(topicLinkRegex);
                
                if (!linkMatch) {
                    continue;
                }
                
                const topicId = parseInt(linkMatch[1]);
                let rawTitle = linkMatch[2];
                
                // Check if title is wrapped in <strong> (unread indicator)
                const hasStrongTitle = /<strong>/.test(rawTitle);
                const isUnread = hasGetnewpost && hasStrongTitle;
                
                // Clean title from HTML tags
                rawTitle = rawTitle
                    .replace(/<strong>/g, '')
                    .replace(/<\/strong>/g, '')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&quot;/g, '"')
                    .replace(/&apos;/g, "'")
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/\s+/g, ' ')
                    .trim();
                
                if (rawTitle.length < 3) continue;
                if (processedIds.has(topicId)) continue;
                processedIds.add(topicId);
                
                // Extract last poster username + profile binding
                // Pattern: Послед.:</a> <b><a href="...showuser=XXXXX">USERNAME</a></b>
                let lastUserName = 'Unknown';
                let lastUserId = 0;
                let lastUserProfileUrl = '';
                const userRegex = /Послед\.:<\/a>\s*<b><a[^>]*href=["']([^"']*showuser=(\d+)[^"']*)["'][^>]*>([^<]+)<\/a><\/b>/i;
                const userMatch = rowHtml.match(userRegex);
                if (userMatch) {
                    lastUserProfileUrl = userMatch[1].replace(/&amp;/g, '&');
                    if (lastUserProfileUrl.startsWith('/')) lastUserProfileUrl = 'https://4pda.to' + lastUserProfileUrl;
                    else if (!/^https?:\/\//i.test(lastUserProfileUrl)) lastUserProfileUrl = 'https://4pda.to/forum/' + lastUserProfileUrl.replace(/^\.\//, '');
                    lastUserId = parseInt(userMatch[2], 10) || 0;
                    lastUserName = userMatch[3]
                        .replace(/&quot;/g, '"')
                        .replace(/&amp;/g, '&')
                        .trim();
                }

                // Extract timestamp from <span class="lastaction">
                // Pattern: <span class="lastaction">Сегодня, 10:30<br />
                let lastPostTs = Math.floor(Date.now() / 1000);
                
                const timestampRegex = /<span class=["']lastaction["'][^>]*>(Вчера|Сегодня|\d{1,2}\.\d{1,2}\.\d{2,4}),\s*(\d{1,2}:\d{2})/i;
                const timeMatch = rowHtml.match(timestampRegex);
                
                if (timeMatch) {
                    const dateStr = timeMatch[1];
                    const timeStr = timeMatch[2];
                    lastPostTs = this.#parseAbsoluteTime(dateStr, timeStr);
                }
                
                // Extract last post id — look for direct post link (findpost/pid/entry).
                // MUST NOT use view=getnewpost (marks topic as read).
                let lastPostId = 0;
                let lastPostUrl = '';
                // All known 4PDA direct-post URL formats:
                //   view=findpost&p=NNN  (IPB3 main format)
                //   act=findpost&pid=NNN
                //   showpost.php?p=NNN
                //   #entryNNN
                const postHrefMatch = rowHtml.match(/href=["']([^"']*(?:view=findpost|act=findpost|showpost(?:\.php)?|#entry)[^"']*)["']/i)
                    || rowHtml.match(/href=["']([^"']*[?&]p=(\d{5,})[^"']*)["']/i); // fallback: ?p= or &p= with long ID
                if (postHrefMatch) {
                    lastPostUrl = postHrefMatch[1].replace(/&amp;/g, '&');
                    if (lastPostUrl.startsWith('/')) lastPostUrl = 'https://4pda.to' + lastPostUrl;
                    else if (lastPostUrl.startsWith('//')) lastPostUrl = 'https:' + lastPostUrl;
                    else if (!/^https?:\/\//i.test(lastPostUrl)) lastPostUrl = 'https://4pda.to/forum/' + lastPostUrl.replace(/^\.\//, '');
                    const postIdMatch = lastPostUrl.match(/(?:[&?]p=|pid=|#entry)(\d+)/i);
                    if (postIdMatch) lastPostId = parseInt(postIdMatch[1], 10) || 0;
                }

                // Create theme object matching Inspector API format
                const themeData = [
                    topicId,              // [0] id
                    rawTitle,             // [1] title
                    0,                    // [2] posts_num (not needed)
                    lastUserId,           // [3] last_user_id
                    lastUserName,         // [4] last_user_name
                    lastPostTs,           // [5] last_post_ts
                    0,                    // [6] last_read_ts (not needed)
                    isPinned ? 1 : 0,     // [7] pin
                    lastUserProfileUrl,   // [8] last_user_profile_url
                    lastPostId,           // [9] last_post_id for safe preview
                    lastPostUrl           // [10] direct findpost/pid URL for safe preview
                ];
                
                const theme = new FavoriteTheme(themeData, this.cs);
                theme.viewed = !isUnread; // Mark as viewed if it's read
                
                themes.push(theme);
                
                
            } catch (error) {
                debugWarn(`  ⚠️ Error parsing row ${rowCount}:`, error);
            }
        }
        
        return themes;
    }

    // Parse absolute time like "Вчера, 14:30" or "Сегодня, 09:15"
    #parseAbsoluteTime(dateStr, timeStr) {
        const now = new Date();
        const [hours, minutes] = timeStr.split(':').map(Number);
        
        if (dateStr === 'Вчера') {
            // Yesterday
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            yesterday.setHours(hours, minutes, 0, 0);
            return Math.floor(yesterday.getTime() / 1000);
        } else if (dateStr === 'Сегодня') {
            // Today
            now.setHours(hours, minutes, 0, 0);
            return Math.floor(now.getTime() / 1000);
        } else {
            // Parse date like "15.01.2025"
            const dateMatch = dateStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
            if (dateMatch) {
                const day = parseInt(dateMatch[1]);
                const month = parseInt(dateMatch[2]) - 1; // JS months are 0-indexed
                let year = parseInt(dateMatch[3]);
                
                // Handle 2-digit years
                if (year < 100) {
                    year += 2000;
                }
                
                const date = new Date(year, month, day, hours, minutes, 0, 0);
                return Math.floor(date.getTime() / 1000);
            }
        }
        
        return Math.floor(Date.now() / 1000);
    }

    process_line(line) {
        let theme = new FavoriteTheme(line, this.cs),
            current_theme = this.get(theme.id),
            n_level = 100,
            // 🆕 track whether this is a "comment in already-unread" case for sound
            is_comment_in_unread = false;

        if (SETTINGS.toolbar_pin_themes_level == 20 && !theme.pin) return;

        if (current_theme) {
            if (current_theme.last_post_ts < theme.last_post_ts) {
                if (current_theme.viewed) {
                    // Theme was read, now has new post - notify!
                    n_level = theme.pin ? 5 : 10;
                } else {
                    // Theme already unread, another new post - notify based on level
                    // n_level 20/12 means only "Все комментарии" or "Новые темы + комментарии в закреплённых" will show
                    n_level = theme.pin ? 12 : 20;
                    is_comment_in_unread = true;
                }
            }
        } else {
            // New theme appeared - notify!
            n_level = theme.pin ? 5 : 10;
        }

        if (this.notify && n_level <= SETTINGS.notification_themes_level) {
            // 🔧 FIX: Skip if the last post was written by the current user themselves
            const myName = this.cs.user_name;
            if (myName && theme.last_user_name && theme.last_user_name === myName) {
                return theme;
            }

            // 🔕 Check if muted — skip notification if so
            chrome.storage.local.get(['muted_topics', 'focused_topics']).then(stored => {
                const mutedTopics   = (stored.muted_topics   || []).map(String);
                const focusedTopics = (stored.focused_topics || []).map(String);
                const topicIdStr    = String(theme.id);

                if (!mutedTopics.includes(topicIdStr)) {
                    theme.notification();
                }

                // 🎯 Priority blink if this is a focused topic
                if (focusedTopics.includes(topicIdStr)) {
                    if (typeof globalThis.startPriorityBlink === 'function') {
                        globalThis.startPriorityBlink();
                    }
                }
            });
        } else if (this.notify && is_comment_in_unread) {
            // 🆕 Попап не показываем (уровень не тот), но звук играем если включён sound_themes_all_comments
            // 🔕 Check muted for sound too
            chrome.storage.local.get(['muted_topics']).then(stored => {
                const mutedTopics = (stored.muted_topics || []).map(String);
                if (!mutedTopics.includes(String(theme.id))) {
                    theme.notificationSoundOnly();
                }
            });
        }
        return theme;
    }

    async do_read(theme_id) {
        let theme = this.get(theme_id);
        return theme ? theme.read() : false;
    }

}

export class FavoriteTheme {
    #cs;

    constructor(obj, cs) {
        this.id = obj[0];
        this.title = obj[1];
        // this.posts_num = obj[2];
        this.last_user_id = obj[3] || 0;
        this.last_user_name = obj[4];
        this.last_post_ts = obj[5];
        // this.last_read_ts = obj[6];
        this.pin = (obj[7] == 1);
        this.last_user_profile_url = obj[8] || (this.last_user_id ? `https://4pda.to/forum/index.php?showuser=${this.last_user_id}` : '');
        this.last_post_id = obj[9] || 0;
        this.last_post_url = obj[10] || '';
        this.viewed = false;

        this.#cs = cs;
    }

    notification(){
        // 🔊 Play notification sound
        if (typeof globalThis.playNotificationSound === 'function') {
            globalThis.playNotificationSound('themes');
        }
        const create = async () => {
            const iconUrl = typeof globalThis.getNotificationIcon === 'function'
                ? await globalThis.getNotificationIcon('img/icons/icon_80_favorite.png')
                : 'img/icons/icon_80_favorite.png';
            return chrome.notifications.create(
                `${this.last_post_ts}/theme/${this.id}`
            , {
                'contextMessage': 'Новый комментарий',
                'title': this.title,
                'message': this.last_user_name,
                'eventTime': this.last_post_ts*1000,
                'iconUrl': iconUrl,
                'type': 'basic'
            });
        };
        // 🌙 DND check
        if (typeof globalThis.isDndActive === 'function') {
            globalThis.isDndActive('themes').then(active => {
                if (!active) create();
            });
            return;
        }
        return create();
    }

    // 🆕 Только звук, без попапа — для случая "новый комментарий в уже непрочитанной теме"
    // Играет только если включён sound_themes_all_comments
    notificationSoundOnly() {
        if (typeof globalThis.playNotificationSound === 'function') {
            globalThis.playNotificationSound('themes_comment');
        }
    }

    async open(view, set_active = true) {
        view = view || 'getnewpost';
        return open_url(
            `https://4pda.to/forum/index.php?showtopic=${this.id}&view=${view}`,
            set_active,
            false
        ).then(async (tab) => {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    // check is last page
                    return document.querySelector('span.pagecurrent-wa') != null && document.querySelector('span.pagecurrent-wa + span.pagelink') == null;
                }
            }).then(([is_last_page]) => {
                this.viewed = is_last_page.result;
                if (is_last_page.result) {
                    this.#cs.update_action();
                }
            }).catch((error) => {
                console.error(error);
            });
            
            return [tab, this];
        });
    }

    async read() {
        return fetch(`https://4pda.to/forum/index.php?showtopic=${this.id}&view=getlastpost`)
            .then(response => {
                if (response.ok) {
                    this.viewed = true;
                    this.#cs.update_action();
                }
                return response.ok;
            });
    }
}
