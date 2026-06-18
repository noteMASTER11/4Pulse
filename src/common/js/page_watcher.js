// page_watcher.js — Content Script
// Отслеживает открытие страниц тем 4pda и мгновенно уведомляет background
// об изменении счётчика непрочитанных.

(function () {
    'use strict';

    // Извлекаем ID темы из URL
    function getTopicId() {
        const match = location.search.match(/[?&]showtopic=(\d+)/);
        return match ? match[1] : null;
    }

    // Проверяем, является ли текущая страница последней страницей темы
    // (пользователь дочитал до конца → тема считается прочитанной)
    function isLastPage() {
        const pagers = Array.from(document.querySelectorAll('.pagination, .paged, .pages, .pagelinks'));
        if (!pagers.length) return true;
        const current = document.querySelector('span.pagecurrent-wa, span.pagecurrent, .pagecurrent-wa, .pagecurrent');
        if (!current) return false;
        const currentText = (current.textContent || '').trim();
        // Если после текущей страницы есть цифровая ссылка или стрелка вперёд — это не конец.
        for (const pager of pagers) {
            const nodes = Array.from(pager.querySelectorAll('a, span'));
            const idx = nodes.indexOf(current);
            if (idx < 0) continue;
            for (const node of nodes.slice(idx + 1)) {
                const text = (node.textContent || '').trim();
                const href = node.getAttribute?.('href') || '';
                if (/^\d+$/.test(text) && text !== currentText) return false;
                if (/[→»]/.test(text) || /st=\d+/i.test(href)) return false;
            }
            return true;
        }
        return true;
    }

    // Сообщаем в background, что тема была открыта/прочитана
    function notifyTopicOpened(topicId, isRead) {
        try {
            chrome.runtime.sendMessage({
                action: 'page_topic_opened',
                topic_id: topicId,
                is_read: isRead
            }).catch(() => {
                // Background может быть временно недоступен
            });
        } catch (e) {
            // Extension context invalidated
        }
    }

    // Основная функция — вызывается при загрузке страницы
    function checkPage() {
        const topicId = getTopicId();
        if (!topicId) return;

        const read = isLastPage();
notifyTopicOpened(topicId, read);
    }

    // Отвечаем на запросы из background
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {


        // Возвращает реальный аватар с открытой страницы профиля 4PDA.
        if (message.action === 'user_avatar_from_page') {
            try {
                function abs(u) {
                    if (!u) return '';
                    u = String(u).trim().replace(/&amp;/g, '&');
                    if (u.startsWith('//')) return 'https:' + u;
                    if (u.startsWith('/')) return 'https://4pda.to' + u;
                    return /^https?:\/\//i.test(u) ? u : '';
                }
                const selectors = [
                    '.user-box .photo img[alt*="Аватар" i]',
                    '.user-box .photo img',
                    '.photo img[alt*="Аватар" i]',
                    '.photo img',
                    'img[alt*="Аватар" i]',
                    'img[title="BrantX"]'
                ];
                let avatar = '';
                for (const sel of selectors) {
                    const img = document.querySelector(sel);
                    const u = abs(img?.currentSrc || img?.src || img?.getAttribute('data-src') || img?.getAttribute('data-original'));
                    if (u && !/(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon|logo|sprite|icon)/i.test(u)) {
                        avatar = u;
                        break;
                    }
                }
                sendResponse({ ok: !!avatar, user_avatar_url: avatar });
            } catch (e) {
                sendResponse({ ok: false, error: String(e && e.message || e) });
            }
            return true;
        }


        // Возвращает карту аватаров пользователей, видимых на текущей странице 4PDA.
        // Используется popup/sidebar для показа аватаров авторов последних сообщений.
        if (message.action === 'user_avatars_from_page') {
            try {
                function abs(u) {
                    if (!u) return '';
                    u = String(u).trim().replace(/&amp;/g, '&');
                    if (u.startsWith('//')) return 'https:' + u;
                    if (u.startsWith('/')) return 'https://4pda.to' + u;
                    return /^https?:\/\//i.test(u) ? u : '';
                }
                function cleanName(t) {
                    return String(t || '').replace(/\s+/g, ' ').replace(/^@/, '').trim();
                }
                function isBadImage(u) {
                    return !u || /(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon|logo|sprite|icon|button|rate|warn|reputation)/i.test(u);
                }
                const map = {};
                const put = (name, url, userId = '') => {
                    name = cleanName(name);
                    url = abs(url);
                    userId = String(userId || '').trim();
                    if (!url || isBadImage(url)) return;
                    if (userId) map['id:' + userId] = url;
                    if (!name) return;
                    if (name.length > 40) return;
                    map[name] = url;
                };
                document.querySelectorAll('.user-box, .post-author, .postprofile, [id^="entry"], .row1, .row2').forEach(box => {
                    const img = box.querySelector('.photo img, img[alt*="Аватар" i], img[src*="/s/"], img[src*="photo"], img[src*="avatar"]');
                    const url = abs(img?.currentSrc || img?.src || img?.getAttribute('data-src') || img?.getAttribute('data-original'));
                    if (!url || isBadImage(url)) return;
                    let name = '';
                    let userId = '';
                    const nameEl = box.querySelector('.nickname, .normalname, .post-author-name, .user-name, h1, h2, a[href*="showuser="]');
                    if (nameEl) {
                        name = cleanName(nameEl.textContent || nameEl.getAttribute('title'));
                        const href = nameEl.getAttribute && nameEl.getAttribute('href') || nameEl.closest?.('a[href*="showuser="]')?.getAttribute('href') || '';
                        userId = (href.match(/showuser=(\d+)/) || [])[1] || '';
                    }
                    const profileLink = box.querySelector('a[href*="showuser="]');
                    if (!userId && profileLink) userId = (profileLink.getAttribute('href').match(/showuser=(\d+)/) || [])[1] || '';
                    if (!name && profileLink) name = cleanName(profileLink.textContent || profileLink.getAttribute('title'));
                    if (!name && img) name = cleanName(img.getAttribute('title') || img.getAttribute('alt'));
                    if (name && /аватар/i.test(name)) name = cleanName(img.getAttribute('title'));
                    put(name, url, userId);
                });
                document.querySelectorAll('img[title], img[alt]').forEach(img => {
                    const ctx = (img.closest('.photo, .user-box, .post-author, [id^="entry"]')?.className || '') + ' ' + (img.closest('[id^="entry"]')?.id || '');
                    const url = abs(img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original'));
                    if (!/photo|user|entry|post/i.test(ctx) && !/\/s\//i.test(url)) return;
                    let name = cleanName(img.getAttribute('title') || img.getAttribute('alt'));
                    if (/аватар/i.test(name)) name = '';
                    const profileLink = img.closest('.user-box, .post-author, [id^="entry"]')?.querySelector('a[href*="showuser="]');
                    const userId = profileLink ? ((profileLink.getAttribute('href') || '').match(/showuser=(\d+)/) || [])[1] || '' : '';
                    if (!name && profileLink) name = cleanName(profileLink.textContent || profileLink.getAttribute('title'));
                    put(name, url, userId);
                });
                sendResponse({ ok: true, avatars: map, count: Object.keys(map).length });
            } catch (e) {
                sendResponse({ ok: false, error: String(e && e.message || e), avatars: {} });
            }
            return true;
        }
        // Возвращает контекст текущей страницы для заметок/напоминаний 4Pulse Productivity
        if (message.action === 'productivity_get_page_context') {
            try {
                const url = location.href;
                const params = new URLSearchParams(location.search || '');
                const act = (params.get('act') || '').toLowerCase();
                const topicId = params.get('showtopic') || null;
                const postId = params.get('p') || params.get('entry') || (location.hash.match(/(?:entry|p)(\d+)/)?.[1]) || null;
                const qmsId = act === 'qms' ? (params.get('t') || null) : null;
                const ticketId = act === 'ticket' ? (params.get('id') || params.get('t_id') || null) : null;
                let kind = 'page';
                if (act === 'qms') kind = 'qms';
                else if (act === 'ticket') kind = 'ticket';
                else if (topicId) kind = 'topic';

                function cleanTitle(t) {
                    return String(t || '')
                        .replace(/\s*[—\-]\s*4PDA.*$/i, '')
                        .replace(/\s*\/\s*4PDA.*$/i, '')
                        .replace(/^Просмотр темы\s*[—:-]\s*/i, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                }

                function bestTitleFromDom() {
                    const selectors = [
                        'h1',
                        '.maintitle',
                        '.topic_title',
                        '#topic-title',
                        '.ipsType_pagetitle',
                        '.nav a[href*="showtopic="]',
                        '#navstrip a[href*="showtopic="]',
                        '.breadcrumb a[href*="showtopic="]'
                    ];
                    let best = '';
                    for (const sel of selectors) {
                        const nodes = Array.from(document.querySelectorAll(sel));
                        for (const node of nodes) {
                            const t = cleanTitle(node.textContent);
                            if (t.length > best.length && !/^\d+$/.test(t) && !/^назад|впер[её]д|страница$/i.test(t)) best = t;
                        }
                    }
                    return best;
                }

                let title = bestTitleFromDom() || cleanTitle(document.title);
                if (!title) {
                    if (kind === 'qms') title = 'QMS диалог';
                    else if (kind === 'ticket') title = 'Тикет 4PDA';
                    else if (kind === 'topic') title = 'Тема 4PDA';
                    else title = 'Страница 4PDA';
                }

                sendResponse({
                    ok: true,
                    url,
                    title,
                    kind,
                    label: kind === 'qms' ? 'QMS' : kind === 'ticket' ? 'Тикет' : kind === 'topic' ? 'Тема' : '4PDA',
                    topic_id: topicId,
                    post_id: postId,
                    qms_id: qmsId,
                    ticket_id: ticketId,
                    is_topic: Boolean(topicId),
                    forum: '4PDA'
                });
            } catch (e) {
                sendResponse({ ok: false, error: String(e && e.message || e) });
            }
            return true;
        }

        // Возвращаем HTML страницы избранного для анализа форм и токенов
        if (message.action === 'fav_fetch_page') {
            fetch('https://4pda.to/forum/index.php?act=fav', {
                credentials: 'include',
            })
            .then(async r => {
                const buf = await r.arrayBuffer();
                const text = new TextDecoder('windows-1251').decode(buf);
                sendResponse({ ok: r.ok, html: text.slice(0, 8000) });
            })
            .catch(e => sendResponse({ ok: false, error: e.message }));
            return true;
        }

        // Выполняем POST-запрос к 4pda с нативными куками (HttpOnly доступны только здесь)
        if (message.action === 'fav_action') {
            fetch('https://4pda.to/forum/index.php', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: message.body,
            })
            .then(async r => {
                const buf = await r.arrayBuffer();
                const text = new TextDecoder('windows-1251').decode(buf);
                const ok = r.ok && !text.includes('class="error"');
                sendResponse({ ok, status: r.status, preview: text.slice(0, 200) });
            })
            .catch(e => sendResponse({ ok: false, error: e.message }));
            return true; // async
        }

        if (message.action !== 'get_secure_key') return;
        try {
            // IPB 3.x: ipb.vars['secure_hash'] или window.secure_hash
            const fromIpb = window.ipb?.vars?.secure_hash
                || window.ipb?.vars?.secure_key
                || window.secure_hash
                || window.secure_key
                || window.auth_key;
            if (fromIpb) { sendResponse({ key: fromIpb }); return true; }

            // Из hidden inputs в DOM
            const inp = document.querySelector(
                'input[name="secure_key"], input[name="auth_key"], input[name="secure_hash"]'
            );
            if (inp?.value) { sendResponse({ key: inp.value }); return true; }

            // Из meta тега
            const meta = document.querySelector('meta[name="secure_key"], meta[name="auth_key"]');
            if (meta?.content) { sendResponse({ key: meta.content }); return true; }

            sendResponse({ key: null });
        } catch (e) {
            sendResponse({ key: null });
        }
        return true;
    });



    function isTicketPage() {
        return /[?&]act=ticket(?:&|$)/i.test(location.search || '');
    }

    function ticketStatusFromText(text) {
        const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (/^в работе$/.test(t) || /\bв работе\b/.test(t)) return 'в работе';
        if (/^обработан$/.test(t) || /\bобработан\b/.test(t) && !/не\s+обработан/.test(t)) return 'обработан';
        return 'не обработан';
    }

    function normalizeTicketHref(href) {
        if (!href) return '';
        href = String(href).replace(/&amp;/g, '&');
        if (href.startsWith('//')) return 'https:' + href;
        if (href.startsWith('/')) return 'https://4pda.to' + href;
        if (/^https?:\/\//i.test(href)) return href;
        return 'https://4pda.to/forum/' + href.replace(/^\.\//, '');
    }

    function extractTicketNavCount() {
        // Источник истины для общего счётчика — верхняя навигация 4PDA:
        // «Тикеты (9)». Блок «Всего: N» ниже показывает количество строк
        // текущей выборки/страницы и может быть меньше реального счётчика.
        const links = Array.from(document.querySelectorAll('a[href*="act=ticket"]'));
        for (const a of links) {
            const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
            const m = text.match(/Тикеты\s*\((\d+)\)/i);
            if (m) return parseInt(m[1], 10);
        }
        const bodyText = (document.body?.textContent || '').replace(/\s+/g, ' ');
        const m = bodyText.match(/Тикеты\s*\((\d+)\)/i);
        return m ? parseInt(m[1], 10) : null;
    }

    let ticketNavCountTimer = null;
    let lastTicketNavCount = null;

    function notifyTicketNavCountSoon(delay = 250, force = false) {
        if (ticketNavCountTimer) clearTimeout(ticketNavCountTimer);
        ticketNavCountTimer = setTimeout(() => {
            ticketNavCountTimer = null;
            const count = extractTicketNavCount();
            if (!Number.isFinite(count) || count < 0) return;
            if (!force && count === lastTicketNavCount) return;
            lastTicketNavCount = count;
            try {
                chrome.runtime.sendMessage({
                    action: 'ticket_nav_count',
                    count,
                    url: location.href,
                    ts: Date.now(),
                }).catch(() => {});
            } catch (_) {}
        }, delay);
    }

    function installTicketNavObserver() {
        notifyTicketNavCountSoon(250, true);
        notifyTicketNavCountSoon(1500, true);
        const obs = new MutationObserver(() => notifyTicketNavCountSoon(350));
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    }

    function parseTicketPageSnapshot() {
        if (!isTicketPage()) return null;
        const tickets = [];
        const pageText = (document.body?.textContent || '').replace(/\s+/g, ' ');
        const navCount = extractTicketNavCount();
        const totalM = pageText.match(/Всего:\s*(\d+)/i);
        const pageTotal = totalM ? parseInt(totalM[1], 10) : null;
        // navCount — общий реальный счётчик, pageTotal — только строки текущей выборки.
        const totalUnprocessed = Number.isFinite(navCount) ? navCount : pageTotal;
        const seen = new Set();
        const rows = Array.from(document.querySelectorAll('tr, .t-row, div[id^="t-row-"]'));
        for (const row of rows) {
            const statusLink = row.querySelector('a[href*="act=ticket"][href*="s=status"][href*="t_id="]');
            const threadLink = row.querySelector('a[href*="act=ticket"][href*="s=thread"][href*="t_id="], a[href*="act=ticket"][href*="s=view"][href*="t_id="]');
            const anyTicketLink = statusLink || threadLink || row.querySelector('a[href*="act=ticket"][href*="t_id="]');
            const href = anyTicketLink?.getAttribute('href') || '';
            const id = (href.match(/[?&]t_id=(\d+)/i) || row.id?.match(/t-row-(\d+)/i) || [])[1];
            if (!id || seen.has(id)) continue;
            seen.add(id);

            const cells = Array.from(row.querySelectorAll('td, .t-title, .t-description, .t-status, .t-mod, .t-date'));
            const rowText = (row.textContent || '').replace(/\s+/g, ' ').trim();
            const statusText = statusLink?.textContent || row.querySelector('.t-status')?.textContent || rowText;
            const status = ticketStatusFromText(statusText);

            const titleEl = row.querySelector(`#t-title-${CSS.escape(id)} a, .t-title a, a[href*="s=thread"][href*="t_id="], a[href*="s=view"][href*="t_id="]`)
                || Array.from(row.querySelectorAll('a')).find(a => !/s=status|s=history|showforum=/i.test(a.getAttribute('href') || ''));
            const title = (titleEl?.textContent || cells[0]?.textContent || ('#' + id)).replace(/\s+/g, ' ').trim();
            const titleHref = normalizeTicketHref(titleEl?.getAttribute('href') || `index.php?act=ticket&s=thread&t_id=${id}`);

            const sectionEl = row.querySelector('a[href*="showforum="]');
            const section = (sectionEl?.textContent || cells[1]?.textContent || '').replace(/\s+/g, ' ').trim();
            const modEl = row.querySelector(`#t-mod-${CSS.escape(id)}, .t-mod`);
            const responsibleRaw = (modEl?.textContent || cells[cells.length - 1]?.textContent || '').replace(/\s+/g, ' ').trim();
            const responsible = /^[–\-]$/.test(responsibleRaw) ? '' : responsibleRaw;
            const dateText = row.querySelector(`#t-date-${CSS.escape(id)}, .t-date`)?.textContent || rowText;
            const dm = String(dateText).match(/(\d{1,2}):(\d{2})\s*\((\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\)/);
            let ts = Math.floor(Date.now() / 1000);
            if (dm) {
                const now = new Date();
                const d = new Date(dm[5] ? Number(dm[5]) : now.getFullYear(), Number(dm[4]) - 1, Number(dm[3]), Number(dm[1]), Number(dm[2]), 0);
                if (!dm[5] && d > now) d.setFullYear(d.getFullYear() - 1);
                ts = Math.floor(d.getTime() / 1000);
            }
            tickets.push({ id: Number(id), title, titleHref, section, status, responsible, ts, snippet: rowText });
        }
        return { ts: Date.now(), url: location.href, totalUnprocessed, tickets };
    }

    const ticketSnapshotTimers = new Set();
    let lastTicketSnapshotKey = '';
    function makeTicketSnapshotKey(snapshot) {
        const total = Number.isFinite(Number(snapshot?.totalUnprocessed)) ? Number(snapshot.totalUnprocessed) : 'x';
        const rows = Array.isArray(snapshot?.tickets) ? snapshot.tickets.map(t => `${t.id}:${t.status}:${t.responsible || ''}`).join('|') : '';
        return `${total}::${rows}`;
    }
    function notifyTicketSnapshotSoon(delay = 120, force = false) {
        if (!isTicketPage()) return;
        const timer = setTimeout(() => {
            ticketSnapshotTimers.delete(timer);
            const snapshot = parseTicketPageSnapshot();
            if (!snapshot || !snapshot.tickets.length) return;
            const key = makeTicketSnapshotKey(snapshot);
            if (!force && key === lastTicketSnapshotKey) return;
            lastTicketSnapshotKey = key;
            try {
                chrome.runtime.sendMessage({ action: 'ticket_page_snapshot', snapshot }).catch(() => {});
            } catch (_) {}
        }, delay);
        ticketSnapshotTimers.add(timer);
    }

    function installTicketObserver() {
        if (!isTicketPage()) return;
        notifyTicketSnapshotSoon(250, true);
        document.addEventListener('click', (ev) => {
            const a = ev.target?.closest?.('a[href*="act=ticket"][href*="s=status"][href*="t_id="]');
            if (a) {
                // Смена статуса на 4PDA проходит через ajax и DOM может обновиться
                // не сразу. Планируем НЕ один debounce-таймер, а серию независимых
                // снимков: иначе поздний вызов затирает ранний и ловит старую гонку.
                [120, 350, 800, 1600, 3000, 5000].forEach(delay => notifyTicketSnapshotSoon(delay, true));
            }
        }, true);
        const obs = new MutationObserver(() => notifyTicketSnapshotSoon(220));
        obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    }


    // Захват родного каталога смайлов 4PDA из реально отрисованного DOM.
    // В сыром HTML страниц форум этот каталог отсутствует; он появляется только
    // после клиентской инициализации редактора, поэтому fetch страницы бесполезен.
    const pdaSmileysCaptureState = {
        timer: null,
        lastKey: '',
        observer: null
    };

    function pdaSmileysSafeJson(value) {
        if (!value) return null;
        const raw = String(value)
            .replace(/&quot;/gi, '"')
            .replace(/&#34;/gi, '"')
            .replace(/&apos;/gi, "'")
            .replace(/&#39;/gi, "'")
            .replace(/&amp;/gi, '&');
        try { return JSON.parse(raw); } catch (_) { return null; }
    }

    function pdaSmileysAbs(src) {
        const clean = String(src || '').trim();
        if (!clean) return '';
        if (clean.startsWith('//')) return 'https:' + clean;
        if (clean.startsWith('/')) return 'https://4pda.to' + clean;
        return /^https?:\/\//i.test(clean) ? clean : '';
    }

    function pdaSmileysCode(img) {
        const options = pdaSmileysSafeJson(img.getAttribute('data-options'));
        const raw = (options && typeof options.after === 'string' ? options.after : '')
            || img.getAttribute('alt')
            || img.getAttribute('title')
            || '';
        return String(raw || '').trim();
    }

    function collectPdaSmileysFromDom() {
        const out = [];
        const seen = new Set();
        // В QMS 4PDA каталог может появляться не только как img.ed-emo-normal:
        // у разных редакторов/тем остаётся стабильным data-toggle="bb" + data-options,
        // а классы иногда отличаются. Берём оба признака.
        const nodes = document.querySelectorAll(
            [
                'img.ed-emo-normal',
                'img[data-toggle="bb"][data-options]',
                'img[src*="/s/"][data-options]',
                '#qms-smile-panel img[src*="/s/"]',
                'img[src*="/s/"][alt^=":"]',
                'img[src*="/s/"][title^=":"]'
            ].join(', ')
        );
        nodes.forEach((img) => {
            const code = pdaSmileysCode(img);
            const src = pdaSmileysAbs(img.currentSrc || img.src || img.getAttribute('src'));
            if (!/^:[^\s]{1,80}:$|^:\)|^;\)|^:P$|^:-D$/i.test(code) || !src || seen.has(code)) return;
            seen.add(code);
            out.push({
                code,
                src,
                title: String(img.getAttribute('title') || code).trim() || code,
                alt: String(img.getAttribute('alt') || code).trim() || code
            });
        });
        return out;
    }

    function publishPdaSmileysCapture(force = false) {
        const items = collectPdaSmileysFromDom();
        // Полный каталог 4PDA обычно большой; не сохраняем случайные одиночные img.
        if (items.length < 20) return;
        const key = items.map(item => item.code).join('|');
        if (!force && key === pdaSmileysCaptureState.lastKey) return;
        pdaSmileysCaptureState.lastKey = key;
        try {
            chrome.runtime.sendMessage({ action: 'pda_smileys_capture', items, source_url: location.href }).catch(() => {});
        } catch (_) {}
    }

    function schedulePdaSmileysCapture(delay = 180, force = false) {
        clearTimeout(pdaSmileysCaptureState.timer);
        pdaSmileysCaptureState.timer = setTimeout(() => publishPdaSmileysCapture(force), delay);
    }

    function schedulePdaSmileysCaptureBurst() {
        [180, 520, 1200, 2400].forEach((delay, idx) => {
            setTimeout(() => publishPdaSmileysCapture(idx === 3), delay);
        });
    }

    function installPdaSmileysObserver() {
        // Быстрые попытки на уже отрисованной странице.
        [120, 700, 1800, 4200, 9000].forEach((delay, idx) => {
            setTimeout(() => publishPdaSmileysCapture(idx === 4), delay);
        });

        // В QMS меню смайлов часто уже существует либо создаётся/показывается
        // после клика по кнопке «Смайлы». На практике это не всегда даёт addedNodes,
        // поэтому после кликов около редактора делаем короткую серию снимков DOM.
        document.addEventListener('click', (event) => {
            const target = event.target?.closest?.('button, a, [data-toggle], .editor, .bbcode, .form-thread, .form-toggle-visible');
            const text = String(target?.textContent || event.target?.textContent || '').trim();
            const title = String(target?.getAttribute?.('title') || '').trim();
            const cls = String(target?.className || '');
            if (/смайл|smile|emoji/i.test(`${text} ${title} ${cls}`)) {
                schedulePdaSmileysCaptureBurst();
            }
        }, true);

        // Если пользователь раскрыл панель смайлов позже, каталог тоже будет снят.
        if (pdaSmileysCaptureState.observer) return;
        pdaSmileysCaptureState.observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes') {
                    const el = mutation.target;
                    if (el?.querySelector?.('img.ed-emo-normal, img[data-toggle="bb"][data-options], #qms-smile-panel img[src*="/s/"], img[src*="/s/"][alt^=":"], img[src*="/s/"][title^=":"]') || el?.matches?.('img.ed-emo-normal, img[data-toggle="bb"][data-options], #qms-smile-panel img[src*="/s/"], img[src*="/s/"][alt^=":"], img[src*="/s/"][title^=":"]')) {
                        schedulePdaSmileysCapture(220);
                        return;
                    }
                }
                for (const node of mutation.addedNodes || []) {
                    if (node.nodeType !== 1) continue;
                    if (node.matches?.('img.ed-emo-normal, img[data-toggle="bb"][data-options], #qms-smile-panel img[src*="/s/"], img[src*="/s/"][alt^=":"], img[src*="/s/"][title^=":"]') || node.querySelector?.('img.ed-emo-normal, img[data-toggle="bb"][data-options], #qms-smile-panel img[src*="/s/"], img[src*="/s/"][alt^=":"], img[src*="/s/"][title^=":"]')) {
                        schedulePdaSmileysCapture(220);
                        return;
                    }
                }
            }
        });
        pdaSmileysCaptureState.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-expanded']
        });
    }

    // Запускаем при загрузке DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { checkPage(); installTicketNavObserver(); installTicketObserver(); installPdaSmileysObserver(); });
    } else {
        checkPage();
        installTicketNavObserver();
        installTicketObserver();
        installPdaSmileysObserver();
    }

})();
