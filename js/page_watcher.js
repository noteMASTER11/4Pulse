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
        const current = document.querySelector('span.pagecurrent-wa');
        const next = current && current.nextElementSibling;
        // Если нет пагинации вообще или нет следующей страницы — это конец
        if (!document.querySelector('.pagination, .paged')) return true;
        if (current && !next) return true;
        return false;
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

    // Запускаем при загрузке DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkPage);
    } else {
        checkPage();
    }

})();
