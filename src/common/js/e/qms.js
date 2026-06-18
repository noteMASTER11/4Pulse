import { open_url } from '../browser.js';
import { AbstractEntity } from "./abstract.js";
import { SETTINGS } from '../cs.js'

// 🆕 Cache configuration

const DEBUG = () => globalThis.__FOURPULSE_DEBUG__ === true;
function debugLog(...args) { if (DEBUG()) console.log(...args); }
function debugWarn(...args) { if (DEBUG()) console.warn(...args); }

const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes in milliseconds
const CACHE_KEY_QMS_LIST = 'qms_cache_list';
const CACHE_KEY_QMS_SUBJECTS = 'qms_cache_subjects';
const CACHE_KEY_QMS_TIMESTAMP = 'qms_cache_timestamp';
const CACHE_KEY_QMS_VIEWED_IDS = 'qms_viewed_ids';  // 🆕 NEW: Persistent viewed dialog IDs

// 🆕 NEW: Russian month names for timestamp parsing
const RUSSIAN_MONTHS = {
    'янв': 0, 'января': 0,
    'фев': 1, 'февраля': 1,
    'мар': 2, 'марта': 2,
    'апр': 3, 'апреля': 3,
    'май': 4, 'мая': 4,
    'июн': 5, 'июня': 5,
    'июл': 6, 'июля': 6,
    'авг': 7, 'августа': 7,
    'сен': 8, 'сентября': 8,
    'окт': 9, 'октября': 9,
    'ноя': 10, 'ноября': 10,
    'дек': 11, 'декабря': 11
};

export class QMS extends AbstractEntity {
    ACT_CODE_API = 'qms';
    ACT_CODE_FORUM = 'qms';
    
    #full_list = [];
    #subjects_cache = {}; // In-memory cache for subjects
    #viewed_ids = new Set();  // 🆕 NEW: Persistent Set of viewed dialog IDs

    constructor(cs) {
        super(cs);
        // 🆕 NEW: Load viewed IDs on startup
        this.#loadViewedIds();
    }
    
    // 🆕 NEW: Load viewed IDs from persistent storage
    async #loadViewedIds() {
        try {
            const result = await chrome.storage.local.get(CACHE_KEY_QMS_VIEWED_IDS);
            if (result[CACHE_KEY_QMS_VIEWED_IDS] && Array.isArray(result[CACHE_KEY_QMS_VIEWED_IDS])) {
                this.#viewed_ids = new Set(result[CACHE_KEY_QMS_VIEWED_IDS]);
            }
        } catch (error) {
            console.error('Error loading viewed QMS IDs:', error);
        }
    }
    
    // Keep the persisted viewed-ID cache bounded and reusable for batched writes.
    #getViewedIdsForStorage() {
        let idsArray = Array.from(this.#viewed_ids);
        if (idsArray.length > 200) {
            idsArray = idsArray.slice(-200);
            this.#viewed_ids = new Set(idsArray);
        }
        return idsArray;
    }

    // 🆕 NEW: Save viewed IDs to persistent storage
    async #saveViewedIds() {
        try {
            await chrome.storage.local.set({
                [CACHE_KEY_QMS_VIEWED_IDS]: this.#getViewedIdsForStorage()
            });
        } catch (error) {
            console.error('Error saving viewed QMS IDs:', error);
        }
    }

    process_line(line) {
        let dialog = new Dialog(line),
            current_dialog = this.get(dialog.id),
            n_level = 100;

        if (current_dialog) {
            if (current_dialog.last_msg_ts < dialog.last_msg_ts) {
                n_level = 20;
            }
        } else {
            n_level = 10;
        }
        if (this.notify && n_level <= SETTINGS.notification_qms_level) {
            dialog.notification();
        }
        return dialog;
    }
    
    get list() {
        return this.#full_list;
    }
    
    // 🆕 NEW: Override count to exclude viewed dialogs
    get count() {
        // Count only unread dialogs that haven't been viewed
        return this.#full_list.filter(d => d.unread && !d.viewed).length;
    }
    
    // 🆕 NEW: Helper method to mark dialog as viewed (called from background.js)
    async markAsViewed(dialogId) {
        
        // Add to persistent Set
        this.#viewed_ids.add(dialogId);
        
        // Update the dialog object in full_list if it exists
        const dialog = this.#full_list.find(d => d.id === dialogId);
        if (dialog) {
            dialog.viewed = true;
            dialog.unread = false;
        }
        
        // 🔥 CRITICAL: Save to persistent storage!
        await this.#saveViewedIds();
        
        return true;
    }
    
    /**
     * @param {boolean} forceRefresh — принудительно обновить без кэша
     * @param {number}  wsDialogId   — ID диалога из WS push-события (0 если нет)
     * @param {number}  wsMsgId      — ID нового сообщения из WS push-события (0 если нет)
     *
     * Если wsDialogId передан и WS подключён — пропускаем тяжёлый HTTP-парсинг страницы QMS.
     * Достаточно быстрого Inspector API для получения актуального счётчика непрочитанных.
     * Полный список диалогов загружается лениво при открытии вкладки QMS.
     */
    async update(forceRefresh = false, wsDialogId = 0, wsMsgId = 0) {
        // 🚀 Быстрый путь: WS push содержит entityId — обновляем только через Inspector API.
        // HTML-парсинг страницы act=qms пропускаем — он нужен только для полного списка диалогов.
        if (wsDialogId && this.cs.wsConnected && !forceRefresh) {
            debugLog(`[QMS] WS push: dialog=${wsDialogId} msg=${wsMsgId} — быстрое обновление через Inspector API`);
            try {
                await super.update(); // только Inspector API (быстро, без HTML)
                // Важно: count у QMS считается по #full_list, а не по _list.
                // Поэтому после WS-push обязательно сливаем свежий Inspector API
                // в полный список, иначе звук есть, а счётчик/попап остаются старыми
                // до ручной перезагрузки или полного HTTP-обновления.
                this.#full_list = await this.#buildFullList([]);
            } catch (e) {
                debugWarn('[QMS] Inspector API недоступен при WS push:', e.message ?? e);
            }
            return;
        }

        // Обычный путь: полное обновление с HTML-списком диалогов.
        // Cloudflare может блокировать HTTP из расширения (403/Network error).
        // Если WS подключён — сессия валидна, просто HTTP недоступен.
        // В этом случае: показываем кешированные данные из storage вместо пустого списка.
        try {
            await super.update();
            await this.#fetchFullList(forceRefresh);
        } catch (e) {
            if (this.cs.wsConnected) {
                debugWarn('[QMS] HTTP недоступен (Cloudflare?), WS активен — показываем кешированные данные');
                // Грузим из storage чтобы не показывать пустой список
                const cached = await this.#getCachedQMSList().catch(() => null);
                if (cached) {
                    this.#full_list = await this.#buildFullList(cached.users).catch(() => this.#full_list);
                }
            } else {
                throw e;
            }
        }
    }
    
    async #fetchFullList(forceRefresh = false) {
        try {
            // 🆕 NEW: Check cache first (unless force refresh)
            if (!forceRefresh) {
                const cachedData = await this.#getCachedQMSList();
                if (cachedData) {
                    this.#full_list = await this.#buildFullList(cachedData.users);
                    return;
                }
            } else {
                // 🔧 FIX: Also clear subjects cache on force refresh
                this.#subjects_cache = {};
            }
            
            const response = await fetch('https://4pda.to/forum/index.php?act=qms', {
                method: 'GET',
                credentials: 'include',
            });
            
            if (!response.ok) {
                console.error('❌ Failed to fetch QMS page:', response.status, response.statusText);
                this.#full_list = Object.values(this._list);
                return;
            }
            
            // Decode Windows-1251 encoding
            const arrayBuffer = await response.arrayBuffer();
            const decoder = new TextDecoder('windows-1251');
            const html = decoder.decode(arrayBuffer);
            
            const usersFromPage = this.#parseQMSPage(html);
            
            // 🆕 NEW: Cache the parsed users
            await this.#cacheQMSList(usersFromPage);
            
            // Build full list
            this.#full_list = await this.#buildFullList(usersFromPage);
            
            
        } catch (error) {
            console.error('❌ Error fetching full QMS list:', error);
            this.#full_list = Object.values(this._list);
        }
    }
    
    // 🆕 NEW: Build full list from users array
    async #buildFullList(usersFromPage) {
        // 🔥 CRITICAL FIX: Save previously unread dialog IDs BEFORE rebuilding
        // This allows us to detect dialogs that were read on other devices
        const previouslyUnreadIds = new Set(
            this.#full_list
                .filter(d => d.unread && !d.viewed)
                .map(d => d.id)
        );
        
        // Load cached subjects first
        await this.#loadCachedSubjects();
        
        const dialogsMap = new Map();
        
        // 🔥 CRITICAL FIX: First, preserve dialogs from the PREVIOUS full_list
        // This ensures dialogs that were read on other devices don't disappear!
        this.#full_list.forEach(d => {
            // Apply persistent viewed state
            if (this.#viewed_ids.has(d.id)) {
                d.viewed = true;
                d.unread = false;
            }
            dialogsMap.set(d.id, d);
        });
        
        // Add UNREAD dialogs from Inspector API (with correct IDs + subjects)
        const inspectorDialogs = Object.values(this._list);
        const inspectorIds = new Set(inspectorDialogs.map(d => d.id));
        
        
        let cacheUpdated = false;
        let viewedIdsChanged = false;

        inspectorDialogs.forEach(dialog => {
            dialog.unread = true;
            
            // 🔥 FIX: If Inspector API says dialog is unread, REMOVE from viewed_ids!
            // This handles the case when someone sends a NEW message to an existing dialog
            if (this.#viewed_ids.has(dialog.id)) {
                this.#viewed_ids.delete(dialog.id);
                viewedIdsChanged = true;
            }
            
            dialog.viewed = false; // Fresh from Inspector API = not viewed yet
            dialogsMap.set(dialog.id, dialog);
            
            // 🔥 CRITICAL FIX: Update the persistent cache with this fresh data!
            // This ensures that if the service worker dies, we reload the FRESH timestamp/subject
            if (dialog.opponent_id) {
                this.#subjects_cache[dialog.opponent_id] = {
                    dialogId: dialog.id,
                    subject: dialog.title,
                    timestamp: Date.now(),
                    last_msg_ts: dialog.last_msg_ts // 🆕 NEW: Save message timestamp too
                };
                cacheUpdated = true;
            }
        });

        // 🔥 CRITICAL FIX: Detect dialogs that were read on other devices
        // These are dialogs that WERE unread before, but are NOT in Inspector API now,
        // and were NOT clicked locally (not in viewed_ids)
        const readOnOtherDevice = [];
        for (const id of previouslyUnreadIds) {
            if (!inspectorIds.has(id) && !this.#viewed_ids.has(id)) {
                readOnOtherDevice.push(id);
            }
        }
        
        // Mark these dialogs as viewed and save to persistent storage
        if (readOnOtherDevice.length > 0) {
            for (const id of readOnOtherDevice) {
                this.#viewed_ids.add(id);
                viewedIdsChanged = true;
                // Also update the dialog object if it exists
                const dialog = dialogsMap.get(id);
                if (dialog) {
                    dialog.viewed = true;
                    dialog.unread = false;
                }
            }
        }

        // Persist subject-cache and viewed-ID changes together when both changed.
        if (cacheUpdated || viewedIdsChanged) {
            const storagePatch = {};
            if (cacheUpdated) {
                storagePatch[CACHE_KEY_QMS_SUBJECTS] = this.#subjects_cache;
            }
            if (viewedIdsChanged) {
                storagePatch[CACHE_KEY_QMS_VIEWED_IDS] = this.#getViewedIdsForStorage();
            }
            await chrome.storage.local.set(storagePatch);
        }
        
        // Add READ users from QMS page (or cache)
        usersFromPage.forEach(user => {
            // Check if already have dialog with this user (from Inspector or Prev list)
            const existingDialog = Array.from(dialogsMap.values()).find(
                d => d.opponent_id === user.opponent_id
            );
            
            if (!existingDialog) {
                // Create read dialog entry
                const dialog = new Dialog([
                    user.opponent_id,     // Use opponent_id as ID (temp)
                    user.opponent_name,   // Use name as title (default)
                    user.opponent_id,     // opponent_id
                    user.opponent_name,   // opponent_name
                    null                  // timestamp = null (initially)
                ]);
                dialog.unread = false;
                dialog.is_user_list = true;
                
                // 🔧 FIX: Check if we have a cached subject for this user
                const cachedSubject = this.#subjects_cache[user.opponent_id];
                if (cachedSubject && !cachedSubject.notFound) {
                    dialog.title = cachedSubject.subject;  // Restore subject (NOW CLEAN - no timestamp!)
                    dialog.id = cachedSubject.dialogId;
                    dialog.subject_loaded = true;
                    
                    // 🆕 NEW: Restore timestamp from cache if available!
                    // This fixes the "Old Date" bug on service worker restart
                    if (cachedSubject.last_msg_ts) {
                        dialog.last_msg_ts = cachedSubject.last_msg_ts;
                    }
                    
                } else {
                }
                
                // 🆕 FIX: Apply persistent viewed state
                if (this.#viewed_ids.has(dialog.id)) {
                    dialog.viewed = true;
                }
                
                dialogsMap.set(dialog.id, dialog);
            }
        });
        
        const fullList = Array.from(dialogsMap.values());
        
        // 🆕 NEW: Sort list by timestamp (descending)
        // This fixes the order mess
        fullList.sort((a, b) => (b.last_msg_ts || 0) - (a.last_msg_ts || 0));
        
        
        return fullList;
    }
    
    // 🆕 NEW: Get cached QMS list
    async #getCachedQMSList() {
        try {
            const result = await chrome.storage.local.get([
                CACHE_KEY_QMS_LIST,
                CACHE_KEY_QMS_TIMESTAMP
            ]);
            
            if (result[CACHE_KEY_QMS_LIST] && result[CACHE_KEY_QMS_TIMESTAMP]) {
                const age = Date.now() - result[CACHE_KEY_QMS_TIMESTAMP];
                
                if (age < CACHE_DURATION) {
                    return {
                        users: result[CACHE_KEY_QMS_LIST],
                        timestamp: result[CACHE_KEY_QMS_TIMESTAMP]
                    };
                } else {
                }
            }
        } catch (error) {
            console.error('Error reading cache:', error);
        }
        return null;
    }
    
    // 🆕 NEW: Cache QMS list
    async #cacheQMSList(users) {
        try {
            await chrome.storage.local.set({
                [CACHE_KEY_QMS_LIST]: users,
                [CACHE_KEY_QMS_TIMESTAMP]: Date.now()
            });
        } catch (error) {
            console.error('Error caching QMS list:', error);
        }
    }
    
    // 🆕 NEW: Load cached subjects
    async #loadCachedSubjects() {
        try {
            const result = await chrome.storage.local.get(CACHE_KEY_QMS_SUBJECTS);
            if (result[CACHE_KEY_QMS_SUBJECTS]) {
                const allSubjects = result[CACHE_KEY_QMS_SUBJECTS];
                const now = Date.now();
                let removedCount = 0;
                
                // Remove stale subjects (older than CACHE_DURATION)
                Object.keys(allSubjects).forEach(opponentId => {
                    const subject = allSubjects[opponentId];
                    const age = now - (subject.timestamp || 0);
                    if (age < CACHE_DURATION) {
                        this.#subjects_cache[opponentId] = subject;
                    } else {
                        removedCount++;
                    }
                });
                
            }
        } catch (error) {
            console.error('Error loading cached subjects:', error);
        }
    }
    
    // 🆕 NEW: Save subject to cache (now includes last_msg_ts!)
    async #cacheSubject(opponentId, dialogId, subject, lastMsgTs = null) {
        try {
            this.#subjects_cache[opponentId] = {
                dialogId: dialogId,
                subject: subject,  // 🔧 FIX: Now this is CLEAN (no timestamp prefix)
                timestamp: Date.now(),
                last_msg_ts: lastMsgTs  // 🆕 NEW: Store the parsed Unix timestamp
            };
            
            await chrome.storage.local.set({
                [CACHE_KEY_QMS_SUBJECTS]: this.#subjects_cache
            });
            
        } catch (error) {
            console.error('Error caching subject:', error);
        }
    }
    
    // 🆕 NEW: Clear cache (for manual refresh)
    async clearCache() {
        try {
            await chrome.storage.local.remove([
                CACHE_KEY_QMS_LIST,
                CACHE_KEY_QMS_TIMESTAMP,
                CACHE_KEY_QMS_SUBJECTS,
                CACHE_KEY_QMS_VIEWED_IDS  // 🆕 NEW: Also clear viewed IDs
            ]);
            this.#subjects_cache = {};
            this.#viewed_ids.clear();  // 🆕 NEW: Clear in-memory Set too
        } catch (error) {
            console.error('Error clearing cache:', error);
        }
    }
    
    #parseQMSPage(html) {
        const users = [];
        const processedIds = new Set();
        
        
        // Parse QMS user links with data-member-id
        // <a class="list-group-item" data-member-id="1131617" ...>
        const linkRegex = /<a[^>]*class=["'][^"']*list-group-item[^"']*["'][^>]*data-member-id=["'](\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        let matchCount = 0;
        
        while ((match = linkRegex.exec(html)) !== null) {
            matchCount++;
            try {
                const userId = parseInt(match[1]);
                const linkContent = match[2];
                
                // Strategy 1: Extract username from img title attribute
                let username = '';
                const imgTitleMatch = linkContent.match(/<img[^>]*title=["']([^"']+)["'][^>]*>/i);
                if (imgTitleMatch) {
                    username = imgTitleMatch[1].trim();
                }
                
                // Strategy 2: Extract from text-overflow span (plain text after avatar)
                if (!username) {
                    const textMatch = linkContent.match(/<span[^>]*class=["'][^"']*text-overflow[^"']*["'][^>]*>[\s\S]*?<\/div>\s*([^<]+)<\/span>/i);
                    if (textMatch) {
                        username = textMatch[1].trim();
                    }
                }
                
                // Clean HTML entities and whitespace
                if (username) {
                    username = username
                        .replace(/&quot;/g, '"')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/\s+/g, ' ')
                        .trim();
                }
                
                if (!username || username.length < 2) {
                    continue;
                }
                
                if (processedIds.has(userId)) continue;
                processedIds.add(userId);
                
                users.push({
                    opponent_id: userId,
                    opponent_name: username
                });
                
            } catch (error) {
                debugWarn('  ⚠️ Error parsing QMS link:', error);
            }
        }
        
        return users;
    }
    
    // Fetch dialog subject for a specific user
    async fetchDialogSubject(opponentId) {
        try {
            // 🆕 NEW: Check in-memory cache first
            if (this.#subjects_cache[opponentId]) {
                const cached = this.#subjects_cache[opponentId];
                if (cached.notFound && Date.now() - Number(cached.timestamp || 0) < CACHE_DURATION) return null;
                if (!cached.notFound) return cached;
            }
            
            
            const response = await fetch(`https://4pda.to/forum/index.php?act=qms&mid=${opponentId}`, {
                method: 'GET',
                credentials: 'include',
            });
            
            if (!response.ok) {
                debugWarn(`❌ Failed to fetch dialog list for user ${opponentId}:`, response.status);
                this.#subjects_cache[opponentId] = { notFound: true, timestamp: Date.now() };
                await chrome.storage.local.set({ [CACHE_KEY_QMS_SUBJECTS]: this.#subjects_cache }).catch(() => {});
                return null;
            }
            
            // Decode Windows-1251 encoding
            const arrayBuffer = await response.arrayBuffer();
            const decoder = new TextDecoder('windows-1251');
            const html = decoder.decode(arrayBuffer);
            
            // Parse the latest dialog from the list
            const latestDialog = this.#parseLatestDialog(html, opponentId);
            
            if (latestDialog) {
                
                // 🆕 NEW: Cache the subject WITH the parsed timestamp
                await this.#cacheSubject(opponentId, latestDialog.dialogId, latestDialog.subject, latestDialog.last_msg_ts);
                
                return latestDialog;
            } else {
                debugWarn(`⚠️ No dialog found for user ${opponentId}`);
                this.#subjects_cache[opponentId] = { notFound: true, timestamp: Date.now() };
                await chrome.storage.local.set({ [CACHE_KEY_QMS_SUBJECTS]: this.#subjects_cache }).catch(() => {});
                return null;
            }
            
        } catch (error) {
            console.error(`❌ Error fetching dialog subject for user ${opponentId}:`, error);
            return null;
        }
    }
    
    // 🆕 NEW: Parse Russian timestamp string into Unix timestamp (seconds)
    #parseRussianTimestamp(timeStr) {
        try {
            const now = new Date();
            const currentYear = now.getFullYear();
            
            // Normalize the string
            timeStr = timeStr.trim().replace(/,/g, '').replace(/\s+/g, ' ');
            
            // Pattern 1: "Сегодня HH:MM"
            const todayMatch = timeStr.match(/^Сегодня\s+(\d{1,2}):(\d{2})$/i);
            if (todayMatch) {
                const hours = parseInt(todayMatch[1]);
                const minutes = parseInt(todayMatch[2]);
                const date = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
                return Math.floor(date.getTime() / 1000);
            }
            
            // Pattern 2: "Вчера HH:MM"
            const yesterdayMatch = timeStr.match(/^Вчера\s+(\d{1,2}):(\d{2})$/i);
            if (yesterdayMatch) {
                const hours = parseInt(yesterdayMatch[1]);
                const minutes = parseInt(yesterdayMatch[2]);
                const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hours, minutes, 0);
                return Math.floor(date.getTime() / 1000);
            }
            
            // Pattern 3: "DD мес. HH:MM" (e.g., "08 апр. 11:54") - current year
            const shortDateMatch = timeStr.match(/^(\d{1,2})\s+([а-яА-Я.]+)\s+(\d{1,2}):(\d{2})$/i);
            if (shortDateMatch) {
                const day = parseInt(shortDateMatch[1]);
                const monthStr = shortDateMatch[2].replace('.', '').toLowerCase();
                const hours = parseInt(shortDateMatch[3]);
                const minutes = parseInt(shortDateMatch[4]);
                
                const month = RUSSIAN_MONTHS[monthStr];
                if (month !== undefined) {
                    const date = new Date(currentYear, month, day, hours, minutes, 0);
                    // If the date is in the future, it's probably from last year
                    if (date > now) {
                        date.setFullYear(currentYear - 1);
                    }
                    return Math.floor(date.getTime() / 1000);
                }
            }
            
            // Pattern 4: "DD мес. YYYY HH:MM" (e.g., "26 ноя. 2024 22:32")
            const fullDateMatch = timeStr.match(/^(\d{1,2})\s+([а-яА-Я.]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})$/i);
            if (fullDateMatch) {
                const day = parseInt(fullDateMatch[1]);
                const monthStr = fullDateMatch[2].replace('.', '').toLowerCase();
                const year = parseInt(fullDateMatch[3]);
                const hours = parseInt(fullDateMatch[4]);
                const minutes = parseInt(fullDateMatch[5]);
                
                const month = RUSSIAN_MONTHS[monthStr];
                if (month !== undefined) {
                    const date = new Date(year, month, day, hours, minutes, 0);
                    return Math.floor(date.getTime() / 1000);
                }
            }
            
            debugWarn(`⚠️ Could not parse Russian timestamp: "${timeStr}"`);
            return null;
            
        } catch (error) {
            console.error('Error parsing Russian timestamp:', error);
            return null;
        }
    }
    
    // 🆕 NEW: Strip timestamp prefix from subject and return both parts
    #stripTimestampFromSubject(fullSubject) {
        // Regex to find timestamps at the start of the subject
        // Handles: "Сегодня 10:49", "08 апр. 11:54", "26 ноя. 2024 22:32", "Вчера 15:58"
        const timeRegex = /^((?:Сегодня|Вчера|\d{1,2}\s+[а-яА-Я.]+\s*)(?:,?\s*)?(?:\d{4}\s+)?\d{1,2}:\d{2})\s*(.*)$/;
        const match = fullSubject.match(timeRegex);
        
        if (match) {
            const timestampStr = match[1].trim();
            const cleanSubject = match[2].trim();
            const parsedTimestamp = this.#parseRussianTimestamp(timestampStr);
            
            
            return {
                subject: cleanSubject || fullSubject,  // Fallback to full if clean is empty
                timestampStr: timestampStr,
                last_msg_ts: parsedTimestamp
            };
        }
        
        // No timestamp found - return original subject
        return {
            subject: fullSubject,
            timestampStr: null,
            last_msg_ts: null
        };
    }
    
    #parseLatestDialog(html, opponentId) {
        try {
            // Look for dialog links in format:
            // <a href="?act=qms&mid=OPPONENT_ID&t=DIALOG_ID">Dialog Subject</a>
            
            // Strategy 1: Find first dialog link with t= parameter
            const dialogLinkRegex = /<a[^>]*href=["'][^"']*act=qms[^"']*mid=(\d+)[^"']*t=(\d+)["'][^>]*>([\s\S]*?)<\/a>/i;
            const match = html.match(dialogLinkRegex);
            
            if (match) {
                const dialogId = parseInt(match[2]);
                let fullSubject = match[3].trim();
                
                // Clean HTML tags and entities
                fullSubject = fullSubject
                    .replace(/<[^>]+>/g, '')
                    .replace(/&quot;/g, '"')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/\s+/g, ' ')
                    .trim();
                
                if (fullSubject && fullSubject.length > 0) {
                    // 🆕 NEW: Strip timestamp from subject and parse it
                    const parsed = this.#stripTimestampFromSubject(fullSubject);
                    
                    return {
                        dialogId: dialogId,
                        subject: parsed.subject,  // 🔧 FIX: Clean subject without timestamp
                        opponentId: opponentId,
                        last_msg_ts: parsed.last_msg_ts  // 🆕 NEW: Parsed Unix timestamp
                    };
                }
            }
            
            // Strategy 2: Look for subject in list-group-item
            const subjectRegex = /<div[^>]*class=["'][^"']*list-group-item[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["'][^"']*t=(\d+)["'][^>]*>([^<]+)<\/a>/i;
            const subjectMatch = html.match(subjectRegex);
            
            if (subjectMatch) {
                const dialogId = parseInt(subjectMatch[1]);
                let fullSubject = subjectMatch[2].trim();
                
                // Clean entities
                fullSubject = fullSubject
                    .replace(/&quot;/g, '"')
                    .replace(/&amp;/g, '&')
                    .replace(/\s+/g, ' ')
                    .trim();
                
                if (fullSubject && fullSubject.length > 0) {
                    // 🆕 NEW: Strip timestamp from subject and parse it
                    const parsed = this.#stripTimestampFromSubject(fullSubject);
                    
                    return {
                        dialogId: dialogId,
                        subject: parsed.subject,  // 🔧 FIX: Clean subject without timestamp
                        opponentId: opponentId,
                        last_msg_ts: parsed.last_msg_ts  // 🆕 NEW: Parsed Unix timestamp
                    };
                }
            }
            
            return null;
            
        } catch (error) {
            console.error('Error parsing latest dialog:', error);
            return null;
        }
    }
}

class Dialog {

    constructor(obj) {
        this.id = obj[0];              // Dialog ID (t= parameter)
        this.title = obj[1];           // Dialog subject/title OR username
        this.opponent_id = obj[2];     // Opponent user ID (mid= parameter)
        this.opponent_name = obj[3];   // Opponent username
        this.last_msg_ts = obj[4];     // Last message timestamp (can be null)
        this.unread = false;           // Will be set by QMS.update()
        this.is_user_list = false;     // Flag for read dialogs from user list
        this.subject_loaded = false;   // Track if subject was lazy-loaded
        this.viewed = false;           // 🆕 NEW: Track if user clicked on this dialog
    }

    notification() {
        // 🔊 Play notification sound
        if (typeof globalThis.playNotificationSound === 'function') {
            globalThis.playNotificationSound('qms');
        }
        const create = async () => {
            const iconUrl = typeof globalThis.getNotificationIcon === 'function'
                ? await globalThis.getNotificationIcon('img/icons/icon_48_qms.png')
                : 'img/icons/icon_48_qms.png';
            return chrome.notifications.create(
                `${this.last_msg_ts}/dialog/${this.id}`
            , {
                'contextMessage': 'Новое сообщение',
                'title': this.title,
                'message': this.opponent_name,
                'eventTime': this.last_msg_ts*1000,
                'iconUrl': iconUrl,
                'type': 'basic'
            });
        };
        // 🌙 Не показывать уведомление в режиме DND
        if (typeof globalThis.isDndActive === 'function') {
            globalThis.isDndActive('qms').then(active => {
                if (!active) create();
            });
            return;
        }
        return create();
    }

    async open() {
        // If we have a specific dialog ID (different from opponent ID), use it
        // This works for both unread dialogs (from Inspector API) and lazy-loaded read dialogs
        if (this.id !== this.opponent_id) {
            // We have a real dialog ID - open the specific dialog
            return open_url(`https://4pda.to/forum/index.php?act=qms&mid=${this.opponent_id}&t=${this.id}`, true, false)
                .then(tab => {
                    return [tab, this];
                });
        } else {
            // No specific dialog ID - open user's dialog list
            return open_url(`https://4pda.to/forum/index.php?act=qms&mid=${this.opponent_id}`, true, false)
                .then(tab => {
                    return [tab, this];
                });
        }
    }
}
