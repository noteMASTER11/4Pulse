import { open_url } from '../browser.js';
import { AbstractEntity } from './abstract.js';
import { SETTINGS } from '../cs.js';

export const TICKET_STATUS = {
    UNPROCESSED: 'не обработан',
    IN_PROGRESS:  'в работе',
    PROCESSED:    'обработан',
};

const CACHE_KEY_TICKETS    = 'tickets_cache_list';
const CACHE_KEY_TICKETS_TS = 'tickets_cache_timestamp';
const CACHE_DURATION       = 5 * 60 * 1000;

export class Tickets extends AbstractEntity {
    ACT_CODE_API   = '';
    ACT_CODE_FORUM = 'ticket';

    #full_list  = [];
    #viewed_ids = new Set();
    #live_count_override = null;

    constructor(cs) {
        super(cs);
        this.#loadViewedIds();
    }

    async #loadViewedIds() {
        try {
            const r = await chrome.storage.local.get('tickets_viewed_ids');
            if (Array.isArray(r.tickets_viewed_ids))
                this.#viewed_ids = new Set(r.tickets_viewed_ids);
        } catch (e) { console.error('Tickets: loadViewedIds', e); }
    }

    async #saveViewedIds() {
        try {
            await chrome.storage.local.set({ tickets_viewed_ids: [...this.#viewed_ids] });
        } catch (e) { console.error('Tickets: saveViewedIds', e); }
    }

    get list()  { return this.#full_list; }

    get count() {
        // Если активная страница тикетов прислала верхний счётчик "Всего: N",
        // используем его как источник истины. Это защищает от гонки, когда строка
        // тикета уже сменила статус, а список DOM/кэш ещё не полностью обновился.
        if (Number.isFinite(this.#live_count_override)) return this.#live_count_override;
        // Only count "не обработан" tickets — matches the badge number shown on 4PDA itself.
        // "в работе" tickets are already being handled, so they don't need to be counted.
        return this.#full_list.filter(t =>
            t.status === TICKET_STATUS.UNPROCESSED
        ).length;
    }

    async markAsViewed(ticketId) {
        this.#viewed_ids.add(String(ticketId));
        const t = this.#full_list.find(x => String(x.id) === String(ticketId));
        if (t) t.viewed = true;
        await this.#saveViewedIds();
    }

    reset() {
        super.reset();
        this.#full_list = [];
        this.#live_count_override = null;
    }

    async update(forceRefresh = false) {
        if (!SETTINGS.tickets_enabled) return;
        try {
            await this.#fetchTickets(forceRefresh);
            this.notify = true;
        } catch (e) { console.error('Tickets: update error', e); }
    }

    async #fetchTickets(forceRefresh = false) {
        if (!forceRefresh) {
            const cached = await this.#getCache();
            if (cached) { this.#buildList(cached); return; }
        }

        const response = await fetch('https://4pda.to/forum/index.php?act=ticket', {
            method: 'GET',
            credentials: 'include',
            referrer: 'https://4pda.to/forum/',
            referrerPolicy: 'no-referrer-when-downgrade',
        });

        if (!response.ok) {
            console.error('Tickets fetch failed:', response.status, response.statusText);
            return;
        }

        const buf  = await response.arrayBuffer();
        const html = new TextDecoder('windows-1251').decode(buf);

        const isLoginPage = html.includes('act=login') && !html.includes('act=ticket');
        if (isLoginPage) { return; }

        const raw = this.#parseHTML(html);

        await chrome.storage.local.set({
            [CACHE_KEY_TICKETS]:    raw,
            [CACHE_KEY_TICKETS_TS]: Date.now(),
        });
        this.#buildList(raw);
    }

    #buildList(rawTickets) {
        this.#live_count_override = null;
        rawTickets.forEach(raw => {
            const wasKnown = this.#full_list.find(t => t.id === raw.id);
            raw.viewed = this.#viewed_ids.has(String(raw.id));
            if (!wasKnown && this.notify &&
                raw.status === TICKET_STATUS.UNPROCESSED &&
                SETTINGS.notification_tickets_level > 0)
                this.#sendNotification(raw);
        });
        this.#full_list = rawTickets.sort((a, b) => b.ts - a.ts);
    }

    #sendNotification(ticket) {
        const fn = () => this.#createNotification(ticket);
        if (typeof globalThis.isDndActive === 'function')
            globalThis.isDndActive('tickets').then(a => { if (!a) fn(); });
        else fn();
    }

    async #createNotification(ticket) {
        if (typeof globalThis.playNotificationSound === 'function')
            globalThis.playNotificationSound('tickets');
        const iconUrl = typeof globalThis.getNotificationIcon === 'function'
            ? await globalThis.getNotificationIcon('img/icons/icon_48.png')
            : 'img/icons/icon_48.png';
        chrome.notifications.create(`${ticket.ts}/ticket/${ticket.id}`, {
            contextMessage: '🎫 Новый тикет',
            title:   ticket.title,
            message: ticket.section,
            iconUrl: iconUrl,
            type:    'basic',
        });
    }

    // ── HTML parser ─────────────────────────────────────────────
    //
    // Real 4PDA ticket page structure (confirmed from live HTML dump, 2026):
    //
    //   <div class="t-row row-1 row-status-0" t_id="3257885" id="t-row-3257885">
    //     <div class="t-mod" id="t-mod-3257885">&nbsp;–&nbsp;</div>
    //     <div class="t-status status-0">
    //       <div class="status-popup" id="t_row_sc_3257885"></div>
    //       <a href="?act=ticket&s=status&t_id=3257885" target="_self">не обработан</a>
    //     </div>
    //     <div class="t-date" id="t-date-3257885">
    //       <a href="?act=ticket&s=history&t_id=3257885">15:16 (07.03)</a>
    //     </div>
    //     <div class="t-commncntimg t-wd"></div>
    //     <a name="#3257885" href="?act=ticket&s=thread&t_id=3257885#addcomment_3257885">0</a>
    //     <div class="t-description">
    //       <a href="?act=ticket&s=thread&t_id=3257885" title="История изменений статуса">…</a>
    //       <a href="?showforum=554" class="t-wd" title="iOS – Игры (Архив)">iOS – Игры (Архив)</a>
    //     </div>
    //     <div class="t-title" id="t-title-3257885">
    //       <a href="?act=ticket&s=thread&t_id=3257885" class="t-wd">Title text…</a>
    //     </div>
    //   </div>
    //
    #parseHTML(html) {
        const tickets = [];
        const seen    = new Set();

        // Match each ticket row: <div ... t_id="NNNN" ...>
        // The t_id attribute is on the row div itself (not inside a link)
        const rowRe = /<div[^>]*\bt_id="(\d+)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*\bt_id="|<\/div>|$)/gi;

        // Simpler approach: find all t_id="NNN" on div.t-row elements
        // then extract the content until the matching close
        const rowStartRe = /<div[^>]*class="[^"]*\bt-row\b[^"]*"[^>]*\bt_id="(\d+)"[^>]*/gi;

        let rm;
        while ((rm = rowStartRe.exec(html)) !== null) {
            const id = parseInt(rm[1]);
            if (isNaN(id) || seen.has(id)) continue;
            seen.add(id);

            // Extract the content between this t-row's opening tag and the next t-row
            const rowStart    = rm.index;
            const tagEnd      = html.indexOf('>', rowStart) + 1;

            // Find next t-row div to bound our search
            const nextRowMatch = /<div[^>]*class="[^"]*\bt-row\b/gi;
            nextRowMatch.lastIndex = tagEnd;
            const nextRow  = nextRowMatch.exec(html);
            const rowEnd   = nextRow ? nextRow.index : tagEnd + 8000;
            const rowHtml  = html.slice(tagEnd, Math.min(rowEnd, tagEnd + 8000));

            // Helper to extract text from a div by id suffix or class
            const extractByClass = (cls) => {
                const re = new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)<\/div>`, 'i');
                const m  = rowHtml.match(re);
                return m ? m[1].replace(/<[^>]+>/g, '')
                               .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                               .replace(/\s+/g, ' ').trim() : '';
            };

            const extractById = (idSuffix) => {
                const re = new RegExp(`id="${idSuffix}${id}"[^>]*>([\\s\\S]*?)<\/div>`, 'i');
                const m  = rowHtml.match(re);
                return m ? m[1].replace(/<[^>]+>/g, '')
                               .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                               .replace(/\s+/g, ' ').trim() : '';
            };

            // ── Title: extract from <div class="t-title" id="t-title-NNN"> ──
            // Current 4PDA HTML structure (2026): the title text and its href
            // live inside <div id="t-title-NNN"><a href="...">Title</a></div>.
            // The old approach (matching s=thread anchors) was unreliable because
            // t-description also has a s=thread link (for the history icon).
            const cleanText = (h) => h.replace(/<[^>]+>/g, '')
                .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

            // Primary: <div id="t-title-NNN">...<a href="URL">text</a>...</div>
            const titleDivRe = new RegExp(`id="t-title-${id}"[^>]*>([\\s\\S]*?)<\\/div>`, 'i');
            const titleDivM  = rowHtml.match(titleDivRe);
            const titleInner = titleDivM ? titleDivM[1] : '';

            // Extract href from first <a> inside the title div
            const titleHrefM = titleInner.match(/href="([^"#][^"]*)"/i);
            const titleHref  = titleHrefM ? titleHrefM[1].replace(/&amp;/g, '&') : null;

            // Fallback: if no t-title div found, try last s=thread anchor (old structure)
            let title = titleInner
                ? cleanText(titleInner)
                : (() => {
                    const anchors = [...rowHtml.matchAll(/<a[^>]+href="([^"]*s=thread[^"]*t_id=\d+[^"#]*)"[^>]*>([\s\S]*?)<\/a>/gi)];
                    const last = anchors.length > 0 ? anchors[anchors.length - 1] : null;
                    return last ? cleanText(last[2]) : `#${id}`;
                })();

            // ── Status: use CSS class from the row (row-status-0/1/2) ──
            // This is MORE reliable than text matching because:
            // "обработан" is a substring of "не обработан" → text matching causes false positives
            // Classes: row-status-0 = не обработан, row-status-1 = в работе, row-status-2 = обработан
            const rowTag = html.slice(rm.index, html.indexOf('>', rm.index) + 1);
            let status = TICKET_STATUS.UNPROCESSED;
            if      (rowTag.includes('row-status-2')) status = TICKET_STATUS.PROCESSED;
            else if (rowTag.includes('row-status-1')) status = TICKET_STATUS.IN_PROGRESS;
            else if (rowTag.includes('row-status-0')) status = TICKET_STATUS.UNPROCESSED;

            // ── Date: t-date div ──
            const dateStr = extractById('t-date-');
            const ts      = this.#parseDate(dateStr);

            // ── Section/Forum ──
            // Current 4PDA HTML structure (2026): the section name is in an <a> tag
            // pointing to showforum=NNN inside <div class="t-description">.
            // There is NO <div class="t-forum"> or id="t-forum-NNN" in modern markup.
            //
            //   <div class="t-description">
            //     <a href="..."><!-- history icon --></a>
            //     <a href="...showforum=NNN..." class="t-wd" title="iOS – Игры">iOS – Игры</a>
            //   </div>
            let section = '';
            // Primary: showforum link (current structure)
            const showforumM = rowHtml.match(/href="[^"]*showforum[^"]*"[^>]*>([^<]+)/i);
            if (showforumM) section = showforumM[1].replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
            // Legacy fallbacks for older page structure
            if (!section) section = extractById('t-forum-');
            if (!section) section = extractByClass('t-forum');
            if (!section) {
                const forumRe = /class="[^"]*t-forum[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
                const fm = rowHtml.match(forumRe);
                if (fm) section = fm[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
            }
            // ── Responsible: t-mod div (may be "&nbsp;–&nbsp;" for unassigned) ──
            const modRaw      = extractById('t-mod-');
            const responsible = (modRaw === '–' || modRaw === '-' || modRaw === '') ? '' : modRaw;

            // ── Content block: t-row-content-NNN contains td-message with curator + author ──
            // Structure (after CP1251 decode):
            //   <strong>Тема:</strong> <a href="...">Topic</a>
            //   <strong>Куратор:</strong> <a href="...">CuratorName</a>, <small>был ...</small>
            //   <strong>Автор поста:</strong> <a href="...">Author</a>
            const contentBlockRe = new RegExp(`id="t-row-content-${id}"[^>]*>([\\s\\S]*?)<\\/div>\\s*<\\/div>`, 'i');
            const contentBlockM  = html.slice(rm.index).match(contentBlockRe);
            const contentBlock   = contentBlockM ? contentBlockM[1] : '';

            // Extract curator from <strong>Куратор:</strong> <a ...>Name</a>
            const curatorRe = /<strong>[^:]*уратор[^<]*<\/strong>\s*<a[^>]*>([^<]+)<\/a>/i;
            const curatorM  = contentBlock.match(curatorRe);
            const curator   = curatorM ? curatorM[1].replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim() : '';

            // Snippet: plain text of the entire td-message
            const snippet = contentBlock
                ? contentBlock.replace(/<[^>]+>/g, '')
                              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
                              .replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
                : '';

            tickets.push({ id, title, titleHref, section, snippet, ts, status, responsible, curator, viewed: false });
        }

        return tickets;
    }

    // Parses "15:07 (06.03)" or "15:07 (06.03.2026)"
    #parseDate(str) {
        try {
            const m = str.match(/(\d{1,2}):(\d{2})[^(]*\((\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\)/);
            if (m) {
                const now  = new Date();
                const year = m[5] ? parseInt(m[5]) : now.getFullYear();
                const d    = new Date(year, parseInt(m[4]) - 1, parseInt(m[3]),
                                     parseInt(m[1]), parseInt(m[2]), 0);
                if (!m[5] && d > now) d.setFullYear(year - 1);
                return Math.floor(d.getTime() / 1000);
            }
        } catch (_) {}
        return Math.floor(Date.now() / 1000);
    }

    async #getCache() {
        try {
            const r = await chrome.storage.local.get([CACHE_KEY_TICKETS, CACHE_KEY_TICKETS_TS]);
            if (r[CACHE_KEY_TICKETS] && r[CACHE_KEY_TICKETS_TS] &&
                Date.now() - r[CACHE_KEY_TICKETS_TS] < CACHE_DURATION) {
                // Инвалидируем кэш если данные старого формата (нет поля curator)
                const list = r[CACHE_KEY_TICKETS];
                if (Array.isArray(list) && list.length > 0 && !('curator' in list[0])) {
                    await this.clearCache();
                    return null;
                }
                return list;
            }
        } catch (_) {}
        return null;
    }


    async applyPageSnapshot(snapshot = {}) {
        const raw = Array.isArray(snapshot.tickets) ? snapshot.tickets : [];
        const total = Number(snapshot.totalUnprocessed);
        if (Number.isFinite(total) && total >= 0) {
            this.#live_count_override = total;
        }
        if (!raw.length) return Number.isFinite(this.#live_count_override);

        const normalized = raw.map(item => {
            const id = parseInt(item.id, 10);
            const status = String(item.status || '').trim();
            return {
                id,
                title: String(item.title || `#${id}`),
                titleHref: item.titleHref || `?act=ticket&s=thread&t_id=${id}`,
                section: String(item.section || ''),
                snippet: String(item.snippet || ''),
                ts: Number(item.ts || Math.floor(Date.now() / 1000)),
                status: Object.values(TICKET_STATUS).includes(status) ? status : TICKET_STATUS.UNPROCESSED,
                responsible: String(item.responsible || ''),
                curator: String(item.curator || ''),
                viewed: this.#viewed_ids.has(String(id)) || status !== TICKET_STATUS.UNPROCESSED,
            };
        }).filter(t => Number.isFinite(t.id) && t.id > 0);

        if (!normalized.length) return false;

        this.#full_list = normalized.sort((a, b) => b.ts - a.ts);
        await chrome.storage.local.set({
            [CACHE_KEY_TICKETS]: this.#full_list,
            [CACHE_KEY_TICKETS_TS]: Date.now(),
            tickets_live_count_override: this.#live_count_override,
        });
        return true;
    }

    async clearCache() {
        await chrome.storage.local.remove([CACHE_KEY_TICKETS, CACHE_KEY_TICKETS_TS]);
    }

    // Open a specific ticket — use the same URL format as clicking the title link
    async open(id, forceActive = false) {
        if (id) {
            const t = this.#full_list.find(x => x.id === id);
            if (t) {
                await this.markAsViewed(id);
                const url = t.titleHref
                    ? (t.titleHref.startsWith('http') ? t.titleHref
                       : `https://4pda.to/forum/${t.titleHref.replace(/^\//, '')}`)
                    : `https://4pda.to/forum/index.php?act=ticket&s=view&t_id=${id}`;
                const active = forceActive || SETTINGS.toolbar_open_theme_hide;
                return open_url(url, active, false)
                    .then(tab => [tab, t]);
            }
        }
        return open_url('https://4pda.to/forum/index.php?act=ticket', true, true);
    }

    // Open the original forum post that triggered this ticket.
    // Fetches the ticket thread page, finds the first showtopic/findpost link,
    // and navigates there. Falls back to the ticket page if nothing found.
    async openSource(id, forceActive = false) {
        if (!id) return open_url('https://4pda.to/forum/index.php?act=ticket', true, true);
        const t = this.#full_list.find(x => x.id === id);
        if (!t) return open_url('https://4pda.to/forum/index.php?act=ticket', true, true);

        await this.markAsViewed(id);
        const active = forceActive || SETTINGS.toolbar_open_theme_hide;

        const ticketUrl = t.titleHref
            ? (t.titleHref.startsWith('http') ? t.titleHref
               : `https://4pda.to/forum/${t.titleHref.replace(/^\//, '')}`)
            : `https://4pda.to/forum/index.php?act=ticket&s=thread&t_id=${id}`;

        try {
            const res = await fetch(ticketUrl, { credentials: 'include', referrerPolicy: 'no-referrer-when-downgrade' });
            if (res.ok) {
                const buf  = await res.arrayBuffer();
                const html = new TextDecoder('windows-1251').decode(buf);

                // Look for a link to the original forum post or thread.
                // 4PDA ticket pages contain a "go to topic" link, e.g.:
                //   <a href="index.php?showtopic=NNN...">  or
                //   <a href="index.php?act=findpost&pid=NNN">
                const postRe = /href="((?:https?:\/\/4pda\.to\/forum\/)?index\.php\?(?:showtopic=\d|act=findpost)[^"]*?)"/gi;
                const matches = [...html.matchAll(postRe)];
                if (matches.length > 0) {
                    let sourceUrl = matches[0][1];
                    if (!sourceUrl.startsWith('http')) sourceUrl = `https://4pda.to/forum/${sourceUrl}`;
                    return open_url(sourceUrl, active, false).then(tab => [tab, t]);
                }
            }
        } catch (_) {}

        // Fallback: open the ticket page itself
        return open_url(ticketUrl, active, false).then(tab => [tab, t]);
    }

    // Status change — URL seen in page bottom bar: ?act=ticket&s=status&t_id=NNN&status=N
    async changeStatus(ticketId, newStatus) {
        // Status codes match the CSS classes on the page: row-status-0 / row-status-1 / row-status-2
        // 0 = не обработан, 1 = в работе, 2 = обработан
        // The old mapping (1/2/3) was off by one — "в работе" was sending status=2 (обработан)!
        const statusMap = {
            [TICKET_STATUS.UNPROCESSED]: 0,
            [TICKET_STATUS.IN_PROGRESS]: 1,
            [TICKET_STATUS.PROCESSED]:   2,
        };
        const code = statusMap[newStatus];
        if (code === undefined) return false;
        try {
            const url = `https://4pda.to/forum/index.php?act=ticket&s=status&t_id=${ticketId}&status=${code}`;
            const r   = await fetch(url, { method: 'GET', credentials: 'include', referrer: 'https://4pda.to/forum/', referrerPolicy: 'no-referrer-when-downgrade' });
            if (r.ok) {
                const t = this.#full_list.find(x => x.id === ticketId);
                if (t) {
                    t.status = newStatus;
                    if (newStatus !== TICKET_STATUS.UNPROCESSED) {
                        t.viewed = true;
                        this.#viewed_ids.add(String(ticketId));
                        await this.#saveViewedIds();
                    }
                }
                await this.clearCache();
                return true;
            }
        } catch (e) { console.error('Tickets: changeStatus', e); }
        return false;
    }
}
