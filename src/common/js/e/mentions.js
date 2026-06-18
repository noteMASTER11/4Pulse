import { open_url } from '../browser.js';
import { AbstractEntity } from "./abstract.js";
import { SETTINGS } from '../cs.js'

// 🆕 Cache configuration

const DEBUG = () => globalThis.__FOURPULSE_DEBUG__ === true;
function debugLog(...args) { if (DEBUG()) console.log(...args); }
function debugWarn(...args) { if (DEBUG()) console.warn(...args); }

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes - check for article mentions more frequently
const CACHE_KEY_MENTIONS_LIST = 'cached_mentions';
const CACHE_KEY_MENTIONS_TIMESTAMP = 'cached_mentions_timestamp';
const CACHE_KEY_VIEWED_IDS = 'viewed_mention_ids';  // 🆕 NEW: Persistent viewed IDs

export class Mentions extends AbstractEntity {
    ACT_CODE_API = 'mentions-list';
    ACT_CODE_FORUM = 'mentions';
    
    #full_list = [];
    #cached_mentions = [];
    #viewed_ids = new Set();  // 🆕 NEW: Persistent Set of viewed mention IDs
    #cacheLoadPromise = null; // 🆕 NEW: Promise to track cache loading
    
    constructor(cs) {
        super(cs);
        // Load cached mentions AND viewed IDs from storage
        // 🆕 Store the promise so we can await it later
        this.#cacheLoadPromise = this.#loadCachedData();
    }
    
    // 🆕 NEW: Ensure cache is loaded before proceeding
    async #ensureCacheLoaded() {
        if (this.#cacheLoadPromise) {
            await this.#cacheLoadPromise;
        }
    }
    
    // 🆕 RENAMED: Load both cached mentions AND viewed IDs
    async #loadCachedData() {
        try {
            const result = await chrome.storage.local.get([
                CACHE_KEY_MENTIONS_LIST,
                CACHE_KEY_VIEWED_IDS
            ]);
            
            // Load cached mentions
            if (result[CACHE_KEY_MENTIONS_LIST] && Array.isArray(result[CACHE_KEY_MENTIONS_LIST])) {
                this.#cached_mentions = result[CACHE_KEY_MENTIONS_LIST].map(data => {
                    const mention = new Mention([
                        data.from,
                        data.topic_id,
                        data.post_id,
                        data.title,
                        data.timestamp,
                        0,
                        data.poster_name
                    ]);
                    // 🆕 FIX: Restore article_url from cache
                    if (data.article_url) {
                        mention.article_url = data.article_url;
                    }
                    return mention;
                });
            }
            
            // 🆕 NEW: Load viewed IDs
            if (result[CACHE_KEY_VIEWED_IDS] && Array.isArray(result[CACHE_KEY_VIEWED_IDS])) {
                this.#viewed_ids = new Set(result[CACHE_KEY_VIEWED_IDS]);
            }
        } catch (error) {
            console.error('Error loading cached data:', error);
        }
    }
    
    async #saveCachedMentions() {
        try {
            // Save mentions as plain objects (not class instances)
            // 🆕 FIX: Include article_url in cache
            const dataToCache = this.#cached_mentions.map(m => ({
                from: m.from,
                topic_id: m.topic_id,
                post_id: m.post_id,
                title: m.title,
                timestamp: m.timestamp,
                poster_name: m.poster_name,
                article_url: m.article_url || null  // 🆕 NEW: Save article URL
            }));
            await chrome.storage.local.set({ 
                [CACHE_KEY_MENTIONS_LIST]: dataToCache,
                [CACHE_KEY_MENTIONS_TIMESTAMP]: Date.now()
            });
        } catch (error) {
            console.error('Error saving cached mentions:', error);
        }
    }
    
    // 🆕 NEW: Save viewed IDs to persistent storage
    async #saveViewedIds() {
        try {
            const idsArray = Array.from(this.#viewed_ids);
            await chrome.storage.local.set({ 
                [CACHE_KEY_VIEWED_IDS]: idsArray
            });
        } catch (error) {
            console.error('Error saving viewed IDs:', error);
        }
    }
    
    // 🆕 NEW: Mark a single mention as viewed (called from background.js)
    async markAsViewed(mentionId) {
        
        // Add to persistent Set
        this.#viewed_ids.add(mentionId);
        
        // Update the mention object in full_list if it exists
        const mention = this.#full_list.find(m => m.id === mentionId);
        if (mention) {
            mention.viewed = true;
            mention.unread = false;
        }
        
        // 🔥 CRITICAL: Save to persistent storage!
        await this.#saveViewedIds();
        
        return true;
    }

    // 🆕 NEW: Get cache age
    async #getCacheAge() {
        try {
            const result = await chrome.storage.local.get([CACHE_KEY_MENTIONS_TIMESTAMP]);
            if (result[CACHE_KEY_MENTIONS_TIMESTAMP]) {
                return Date.now() - result[CACHE_KEY_MENTIONS_TIMESTAMP];
            }
        } catch (error) {
            console.error('Error getting cache age:', error);
        }
        return Infinity; // Return very old age if no timestamp
    }

    // 🆕 NEW: Check if cache is stale
    async #isCacheStale() {
        const age = await this.#getCacheAge();
        return age >= CACHE_DURATION;
    }

    process_line(line) {
        let mention = new Mention(line),
            n_level = 100;
        
        // 🔥 FILTER: Only accept FORUM mentions (from === 0)
        // Article mentions (from === 1) are ignored - they cause too many problems
        // (broken URLs, marking as read on server, etc.)
        if (mention.from !== 0) {
            return null;
        }

        if (!this.exists(mention.id)) {
            n_level = 20;
        }
        if (this.notify && n_level <= SETTINGS.notification_mentions_level) {
            mention.notification();
        }
        return mention;
    }
    
    get list() {
        // 🔥 FILTER: Only return FORUM mentions (from === 0)
        return this.#full_list.filter(m => m.from === 0);
    }
    
    get count() {
        // 🔥 FILTER: Only count FORUM mentions (from === 0) that are unread AND not viewed
        return this.#full_list.filter(m => m.from === 0 && m.unread && !m.viewed).length;
    }
    
    // 🆕 NEW: Helper method to find any mention (viewed or unread) by ID
    getMention(id) {
        return this.#full_list.find(m => m.id === id);
    }
    
    // 🔧 FIX #1: Mark all mentions in a topic as viewed (for syncing with Favorites)
    async markTopicMentionsAsViewed(topicId) {
        let markedCount = 0;
        this.#full_list.forEach(mention => {
            if (mention.topic_id === topicId && !mention.viewed) {
                mention.viewed = true;
                this.#viewed_ids.add(mention.id);  // 🆕 NEW: Also add to persistent Set
                markedCount++;
            }
        });
        
        // 🆕 NEW: Save if any were marked
        if (markedCount > 0) {
            await this.#saveViewedIds();
        }
        
        return markedCount;
    }
    
    async clearCache() {
        this.#cached_mentions = [];
        this.#viewed_ids.clear();  // 🆕 NEW: Also clear viewed IDs
        await chrome.storage.local.remove([
            CACHE_KEY_MENTIONS_LIST, 
            CACHE_KEY_MENTIONS_TIMESTAMP,
            CACHE_KEY_VIEWED_IDS  // 🆕 NEW: Also remove viewed IDs
        ]);
    }
    
    getCacheStatus() {
        return {
            cached_count: this.#cached_mentions.length,
            full_list_count: this.#full_list.length,
            unread_count: this.count,
            viewed_ids_count: this.#viewed_ids.size,  // 🆕 NEW: Show viewed count
            viewed_ids: Array.from(this.#viewed_ids),  // 🆕 NEW: Show actual IDs
            cached_mentions: this.#cached_mentions.map(m => ({
                id: m.id,
                title: m.title,
                timestamp: new Date(m.timestamp * 1000).toLocaleString(),
                unread: m.unread,
                viewed: m.viewed,
                from: m.from,
                article_url: m.article_url || null  // 🆕 NEW: Show article URL
            }))
        };
    }
    
    // 🔧 FIX: Update method - fetches HTML only on force refresh OR when cache is stale
    async update(forceRefresh = false) {
        
        // Manual force refresh requested
        if (forceRefresh) {
            return await this.#refreshMentionsCache();
        }

        // Если Cloudflare блокирует HTTP — ловим ошибку, но показываем кеш.
        try {
            await this.#updateFromInspectorAPI();
        } catch (e) {
            if (this.cs.wsConnected) {
                debugWarn('[Mentions] HTTP недоступен (Cloudflare?), WS активен — показываем кешированные упоминания');
                // Восстанавливаем full_list из кеша чтобы не показывать пустой список
                await this.#ensureCacheLoaded();
                if (this.#cached_mentions.length > 0 && this.#full_list.length === 0) {
                    this.#full_list = this.#cached_mentions.filter(m => !this.#viewed_ids.has(String(m.post_id || m.id)));
                }
            } else {
                throw e;
            }
        }
    }
    
    // 🆕 NEW: Update only from Inspector API (unread mentions)
    async #updateFromInspectorAPI() {
        // 🆕 CRITICAL: Wait for cache to be loaded first!
        await this.#ensureCacheLoaded();
        
        // 🔥 CRITICAL FIX: Save previously unread mentions BEFORE fetching new data
        // This allows us to detect mentions that were read on other devices
        const previouslyUnreadIds = new Set(
            this.#full_list
                .filter(m => m.unread && !m.viewed)
                .map(m => m.id)
        );
        
        // Call parent to fetch from Inspector API
        await super.update();
        
        // ⚠️ NO AUTOMATIC HTML FETCHING!
        // Fetching https://4pda.to/forum/index.php?act=mentions marks ALL mentions as READ on server!
        // We only use Inspector API which is safe and doesn't have this side effect.
        if (this.#cached_mentions.length === 0) {
        }
        
        // Get fresh mentions from Inspector API (unread only)
        const inspectorMentions = Object.values(this._list);
        const inspectorIds = new Set(inspectorMentions.map(m => m.id));
        
        
        // 🔥 CRITICAL FIX: Detect mentions that were read on other devices
        // These are mentions that WERE unread before, but are NOT in Inspector API now,
        // and were NOT clicked locally (not in viewed_ids)
        const readOnOtherDevice = [];
        for (const id of previouslyUnreadIds) {
            if (!inspectorIds.has(id) && !this.#viewed_ids.has(id)) {
                readOnOtherDevice.push(id);
            }
        }
        
        // Mark these mentions as viewed and save to persistent storage
        if (readOnOtherDevice.length > 0) {
            for (const id of readOnOtherDevice) {
                this.#viewed_ids.add(id);
            }
            await this.#saveViewedIds();
        }
        
        // Combine with cached mentions, removing duplicates
        const mentionMap = new Map();
        
        // 🔥 CRITICAL FIX: First, preserve mentions from the PREVIOUS full_list
        // This ensures mentions that were read on other devices don't disappear!
        this.#full_list.forEach(m => {
            // Apply persistent viewed state
            if (this.#viewed_ids.has(m.id)) {
                m.viewed = true;
                m.unread = false;
            }
            mentionMap.set(m.id, m);
        });
        
        // Add cached mentions (these are read/old mentions from HTML page)
        this.#cached_mentions.forEach(m => {
            // 🆕 FIX: Apply persistent viewed state from viewed_ids
            if (this.#viewed_ids.has(m.id)) {
                m.viewed = true;
                m.unread = false;
            }
            // Don't overwrite if already in map (previous list takes priority)
            if (!mentionMap.has(m.id)) {
                mentionMap.set(m.id, m);
            }
        });
        
        // Add/update with Inspector API mentions (these are unread)
        let viewedIdsChanged = false;
        inspectorMentions.forEach(m => {
            // 🔥 FIX: If Inspector API says mention is unread, REMOVE from viewed_ids!
            // This handles the case when someone sends a NEW reply to an existing thread
            if (this.#viewed_ids.has(m.id)) {
                this.#viewed_ids.delete(m.id);
                viewedIdsChanged = true;
            }
            
            m.unread = true;  // Mark as unread (from Inspector API)
            m.viewed = false; // Fresh from Inspector API = not viewed yet
            mentionMap.set(m.id, m);
        });
        
        // Save viewed_ids if we removed any
        if (viewedIdsChanged) {
            await this.#saveViewedIds();
        }
        
        // Convert back to array and sort by timestamp
        this.#full_list = Array.from(mentionMap.values());
        this.#full_list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        
        
        // ⚠️ NO AUTO-REFRESH! We do NOT fetch HTML automatically.
        // This prevents the server from marking all mentions as read.
    }
    
    // 🆕 RENAMED: Manual refresh - fetches HTML page and updates cache
    async #refreshMentionsCache() {
        try {
            
            const response = await fetch('https://4pda.to/forum/index.php?act=mentions', {
                method: 'GET',
                credentials: 'include',
            });
            
            
            if (!response.ok) {
                debugWarn('❌ Failed to fetch Mentions page:', response.status);
                // Fallback to Inspector API
                await this.#updateFromInspectorAPI();
                return false;
            }
            
            // Decode Windows-1251 encoding
            const arrayBuffer = await response.arrayBuffer();
            const decoder = new TextDecoder('windows-1251');
            const html = decoder.decode(arrayBuffer);
            
            const parsedMentions = this.#parseMentionsPage(html);
            
            if (parsedMentions.length > 0) {
                // Update cache with all parsed mentions
                this.#cached_mentions = parsedMentions;
                await this.#saveCachedMentions();
                
                await this.#rebuildFullList();
                return true;
            } else {
                debugWarn('⚠️ No mentions found in HTML page');
                return false;
            }
        } catch (error) {
            console.error('❌ Error in #refreshMentionsCache:', error);
            // Fallback to Inspector API
            await this.#updateFromInspectorAPI();
            return false;
        }
    }
    
    // 🆕 NEW: Rebuild full_list from cached mentions + Inspector API
    async #rebuildFullList() {
        // Get current Inspector API mentions (unread only)
        const inspectorMentions = Object.values(this._list);
        
        // Create a map to avoid duplicates
        const mentionMap = new Map();
        
        // Add cached mentions (read + unread from HTML page)
        this.#cached_mentions.forEach(m => {
            // 🆕 FIX: Apply persistent viewed state
            if (this.#viewed_ids.has(m.id)) {
                m.viewed = true;
                m.unread = false;
            }
            mentionMap.set(m.id, m);
        });
        
        // Add/update with Inspector API mentions (these are definitely unread)
        inspectorMentions.forEach(m => {
            const existing = mentionMap.get(m.id);
            if (existing) {
                // Update existing mention - mark as unread UNLESS already viewed
                if (!this.#viewed_ids.has(m.id)) {
                    existing.unread = true;
                }
                // 🆕 FIX: Copy article_url from existing (cache) to Inspector API mention
                if (existing.article_url && !m.article_url) {
                    m.article_url = existing.article_url;
                }
                // 🆕 FIX: Preserve from=1 for article mentions
                if (existing.from === 1) {
                    m.from = 1;
                }
            } else {
                // New mention from Inspector API
                m.unread = !this.#viewed_ids.has(m.id);
                m.viewed = this.#viewed_ids.has(m.id);
                mentionMap.set(m.id, m);
            }
        });
        
        // Convert to array and sort by timestamp (newest first)
        this.#full_list = Array.from(mentionMap.values());
        this.#full_list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    }
    
    #cleanMentionTitle(title) {
        // Remove "Форум: " prefix if present
        title = title.replace(/^Форум:\s*/i, '');
        
        // Handle PIPE separator: "RuStore | Магазин приложений" -> "RuStore"
        const pipeIndex = title.indexOf(' | ');
        if (pipeIndex > 0) {
            const beforePipe = title.substring(0, pipeIndex);
            // Only use the part before pipe if it's substantial
            if (beforePipe.length > 5) {
                title = beforePipe;
            }
        }
        
        // Handle COMMA separator: "4PDA Инспектор, Расширение..." -> "4PDA Инспектор"
        const commaIndex = title.indexOf(', ');
        if (commaIndex > 0) {
            const beforeComma = title.substring(0, commaIndex);
            // Only use the part before comma if it's substantial
            if (beforeComma.length > 5) {
                title = beforeComma;
            }
        }
        
        return title.trim();
    }
    
    // 🔧 FIX: Parse Russian timestamps (Вчера, Сегодня, DD.MM.YYYY HH:MM)
    #parseRussianTimestamp(timeStr) {
        try {
            if (!timeStr) return null;
            
            // Try to find time pattern HH:MM
            const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
            if (timeMatch) {
                const hours = parseInt(timeMatch[1]);
                const minutes = parseInt(timeMatch[2]);
                
                // Create date object for today
                let dateObj = new Date();
                
                
                // Check if "Вчера" (Yesterday)
                if (timeStr.includes('Вчера')) {
                    dateObj.setDate(dateObj.getDate() - 1);
                    dateObj.setHours(hours, minutes, 0, 0);
                }
                // Check if "Сегодня" (Today)
                else if (timeStr.includes('Сегодня')) {
                    // Simply set today's time directly
                    dateObj.setHours(hours, minutes, 0, 0);
                }
                // Parse full date "DD.MM.YYYY" or "DD.MM.YY"
                else {
                    const dateMatch = timeStr.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
                    if (dateMatch) {
                        const day = parseInt(dateMatch[1]);
                        const month = parseInt(dateMatch[2]) - 1; // JS months are 0-indexed
                        let year = parseInt(dateMatch[3]);
                        
                        // Handle 2-digit years (e.g., 25 -> 2025)
                        if (year < 100) {
                            year += 2000;
                        }
                        
                        dateObj = new Date(year, month, day, hours, minutes, 0, 0);
                    } else {
                        // No valid date found - return null instead of "now"
                        debugWarn('⚠️ Time found but no date:', timeStr);
                        return null;
                    }
                }
                
                const unixTimestamp = Math.floor(dateObj.getTime() / 1000);
                const now = Math.floor(Date.now() / 1000);
                const diffMinutes = Math.floor((now - unixTimestamp) / 60);
                return unixTimestamp;
            }
        } catch (error) {
            debugWarn('Error parsing timestamp:', timeStr, error);
        }
        
        // Fallback: return null (no timestamp available)
        return null;
    }
    
    #parseMentionsPage(html) {
        const mentions = [];
        const processedIds = new Set();
        
        
        // 🔥 CRITICAL FIX: Match BOTH data-post (forum) AND data-comment (article) mentions!
        // Old regex only matched data-post, completely missing article mentions
        // New regex: data-(post|comment)="ID"
        const mentionBlocks = html.matchAll(/<div[^>]*class=["']([^"']*borderwrap[^"']*)["'][^>]*data-(post|comment)=["'](\d+)["'][^>]*>([\s\S]*?)<\/div>\s*<br\s*\/?>/gi);
        
        let blockCount = 0;
        let readCount = 0;
        let forumCount = 0;
        let articleCount = 0;
        
        for (const blockMatch of mentionBlocks) {
            blockCount++;
            const classAttr = blockMatch[1];      // Full class attribute (e.g. "borderwrap read")
            const dataType = blockMatch[2];       // "post" or "comment"
            const dataId = parseInt(blockMatch[3]); // The ID value
            const blockHtml = blockMatch[4];      // Inner HTML content
            
            // Check if this mention is already marked as "read" on server
            const isReadOnServer = classAttr.includes('read');
            if (isReadOnServer) {
                readCount++;
            }
            
            const isArticleMention = (dataType === 'comment');
            
            try {
                if (isArticleMention) {
                    // =====================================================
                    // 🌐 ARTICLE MENTION (data-comment)
                    // =====================================================
                    articleCount++;
                    const commentId = dataId;
                    
                    // Extract article URL and title from maintitle
                    // Pattern: <div class="maintitle">Сайт: <a href="URL#commentID">TITLE</a></div>
                    const articleMatch = blockHtml.match(/<div[^>]*class=["']maintitle["'][^>]*>[\s\S]*?Сайт:\s*<a[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/i);
                    
                    if (!articleMatch) {
                        continue;
                    }
                    
                    // The URL already contains #commentID from the HTML!
                    const fullArticleUrl = articleMatch[1].trim();
                    let rawTitle = articleMatch[2].trim();
                    
                    if (rawTitle.length < 3) continue;
                    
                    // Extract article_id from URL: https://4pda.to/2025/12/25/451082/slug/#comment10354604
                    const articleIdMatch = fullArticleUrl.match(/\/(\d{6,})(?:\/|#)/);
                    const articleId = articleIdMatch ? parseInt(articleIdMatch[1]) : commentId;
                    
                    const mentionId = `${articleId}_${commentId}`;
                    if (processedIds.has(mentionId)) continue;
                    processedIds.add(mentionId);
                    
                    // Clean HTML entities
                    rawTitle = rawTitle
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/\s+/g, ' ');
                    
                    const cleanTitle = this.#cleanMentionTitle(rawTitle);
                    if (cleanTitle.length < 3) continue;
                    
                    // Extract USERNAME + profile binding
                    let username = '';
                    let posterId = 0;
                    let posterProfileUrl = '';
                    const usernameMatch = blockHtml.match(/<span[^>]*class=["']normalname["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']*showuser=(\d+)[^"']*)["'][^>]*>([^<]+)<\/a>/i)
                        || blockHtml.match(/<span[^>]*class=["']normalname["'][^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
                    if (usernameMatch) {
                        if (usernameMatch.length >= 4) {
                            posterProfileUrl = usernameMatch[1].replace(/&amp;/g, '&');
                            if (posterProfileUrl.startsWith('/')) posterProfileUrl = 'https://4pda.to' + posterProfileUrl;
                            else if (!/^https?:\/\//i.test(posterProfileUrl)) posterProfileUrl = 'https://4pda.to/forum/' + posterProfileUrl.replace(/^\.\//, '');
                            posterId = parseInt(usernameMatch[2], 10) || 0;
                            username = usernameMatch[3].trim();
                        } else {
                            username = usernameMatch[1].trim();
                        }
                        username = username.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                    }
                    
                    // Extract TIMESTAMP
                    let timestamp = null;
                    // Pattern for article: look for Сегодня/Вчера/date + time in the row2 cell
                    const timestampMatch = blockHtml.match(/(Вчера|Сегодня|\d{1,2}\.\d{1,2}\.\d{2,4})[,\s]*(\d{1,2}:\d{2})/i);
                    if (timestampMatch) {
                        const fullTimeStr = `${timestampMatch[1]}, ${timestampMatch[2]}`;
                        timestamp = this.#parseRussianTimestamp(fullTimeStr);
                    }
                    
                    const mention = new Mention([
                        1,              // from: 1 = ARTICLE (site)
                        articleId,      // topic_id = article_id
                        commentId,      // post_id = comment_id
                        cleanTitle,     // Clean article title
                        timestamp,      // Unix timestamp
                        posterId,       // poster_id
                        username,       // Username
                        posterProfileUrl // poster_profile_url
                    ]);
                    
                    // Set the article_url for opening later (already complete from HTML!)
                    mention.article_url = fullArticleUrl;
                    
                    // Mark as viewed if already read on server OR in our persistent viewed_ids
                    if (isReadOnServer || this.#viewed_ids.has(mentionId)) {
                        mention.viewed = true;
                        mention.unread = false;
                    }
                    
                    mentions.push(mention);
                    
                    
                } else {
                    // =====================================================
                    // 💬 FORUM MENTION (data-post)
                    // =====================================================
                    forumCount++;
                    const postId = dataId;
                    
                    // Extract topic title from: <div class="maintitle">Форум: <a href="...showtopic=ID">TITLE</a></div>
                    const titleMatch = blockHtml.match(/<div[^>]*class=["']maintitle["'][^>]*>[\s\S]*?<a[^>]*href=["'][^"']*showtopic=(\d+)[^"']*["'][^>]*>([^<]+)<\/a>/i);
                    if (!titleMatch) {
                        continue;
                    }
                    
                    const topicId = parseInt(titleMatch[1]);
                    let rawTitle = titleMatch[2].trim();
                    
                    if (rawTitle.length < 5) continue;
                    
                    const mentionId = `${topicId}_${postId}`;
                    if (processedIds.has(mentionId)) continue;
                    processedIds.add(mentionId);
                    
                    // Clean HTML entities
                    rawTitle = rawTitle
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .replace(/\s+/g, ' ');
                    
                    const cleanTitle = this.#cleanMentionTitle(rawTitle);
                    if (cleanTitle.length < 3) continue;
                    
                    // Extract USERNAME + profile binding from: <span class="normalname"><a href="...showuser=ID">USERNAME</a></span>
                    let username = '';
                    let posterId = 0;
                    let posterProfileUrl = '';
                    const usernameMatch = blockHtml.match(/<span[^>]*class=["']normalname["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']*showuser=(\d+)[^"']*)["'][^>]*>([^<]+)<\/a>/i)
                        || blockHtml.match(/<span[^>]*class=["']normalname["'][^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);
                    if (usernameMatch) {
                        if (usernameMatch.length >= 4) {
                            posterProfileUrl = usernameMatch[1].replace(/&amp;/g, '&');
                            if (posterProfileUrl.startsWith('/')) posterProfileUrl = 'https://4pda.to' + posterProfileUrl;
                            else if (!/^https?:\/\//i.test(posterProfileUrl)) posterProfileUrl = 'https://4pda.to/forum/' + posterProfileUrl.replace(/^\.\//, '');
                            posterId = parseInt(usernameMatch[2], 10) || 0;
                            username = usernameMatch[3].trim();
                        } else {
                            username = usernameMatch[1].trim();
                        }
                        username = username.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                    }
                    
                    // Extract TIMESTAMP
                    let timestamp = null;
                    const timestampMatch = blockHtml.match(/(Вчера|Сегодня|\d{1,2}\.\d{1,2}\.\d{2,4})[,\s]*(\d{1,2}:\d{2})/i);
                    if (timestampMatch) {
                        const fullTimeStr = `${timestampMatch[1]}, ${timestampMatch[2]}`;
                        timestamp = this.#parseRussianTimestamp(fullTimeStr);
                    }
                    
                    const mention = new Mention([
                        0,              // from: 0 = forum
                        topicId,        // topic_id
                        postId,         // post_id
                        cleanTitle,     // Clean topic title
                        timestamp,      // Unix timestamp
                        posterId,       // poster_id
                        username,       // Username
                        posterProfileUrl // poster_profile_url
                    ]);
                    
                    // Mark as viewed if already read on server OR in our persistent viewed_ids
                    if (isReadOnServer || this.#viewed_ids.has(mentionId)) {
                        mention.viewed = true;
                        mention.unread = false;
                    }
                    
                    mentions.push(mention);
                    
                }
                
            } catch (error) {
                debugWarn(`  ⚠️ Error parsing mention block #${blockCount}:`, error);
            }
        }
        
        const unreadCount = mentions.filter(m => !m.viewed).length;
        
        return mentions;
    }
}

class Mention {
    constructor(obj) {
        this.from = obj[0];             // 0 = forum, 1 = article (site)
        this.topic_id = obj[1];         // topic_id (forum) or article_id (article)
        this.post_id = obj[2];          // post_id (forum) or comment_id (article)
        this.title = obj[3];
        this.timestamp = obj[4];        // Unix timestamp
        this.poster_id = obj[5] || 0;
        this.poster_name = obj[6] || ''; // Username
        this.poster_profile_url = obj[7] || (this.poster_id ? `https://4pda.to/forum/index.php?showuser=${this.poster_id}` : '');
        this.unread = false;
        this.viewed = false;            // 🆕 NEW: Add viewed property like Favorites has
        this.article_url = null;        // 🆕 NEW: Full URL for article comments
    }

    get id() {
        return `${this.topic_id}_${this.post_id}`;
    }

    notification() {
        // 🔊 Play notification sound
        if (typeof globalThis.playNotificationSound === 'function') {
            globalThis.playNotificationSound('mentions');
        }
        const create = async () => {
            const iconUrl = typeof globalThis.getNotificationIcon === 'function'
                ? await globalThis.getNotificationIcon('img/icons/icon_80_mention.png')
                : 'img/icons/icon_80_mention.png';
            return chrome.notifications.create(
                `${this.timestamp}/mention/${this.id}`
            , {
                'contextMessage': 'Новое упоминание',
                'title': this.title,
                'message': this.poster_name || 'Новое упоминание',
                'eventTime': this.timestamp*1000,
                'iconUrl': iconUrl,
                'type': 'basic'
            });
        };
        // 🌙 DND check (mentions могут пробивать DND через dnd_allow_mentions)
        if (typeof globalThis.isDndActive === 'function') {
            globalThis.isDndActive('mentions').then(active => {
                if (!active) create();
            });
            return;
        }
        return create();
    }

    async open() {
        // Simple forum mention URL
        return open_url(
            `https://4pda.to/forum/index.php?showtopic=${this.topic_id}&view=findpost&p=${this.post_id}`,
            SETTINGS.toolbar_open_theme_hide,
            false
        ).then(tab => [tab, this]);
    }
}
