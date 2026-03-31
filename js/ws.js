/**
 * ws.js — WebSocket-клиент для неофициального API 4PDA
 *
 * Протокол: wss://appbk.4pda.to/ws/
 * Формат команд: JSON-массивы; данные могут приходить как UTF-8-строка
 * или бинарный фрейм в кодировке windows-1251.
 *
 * Используется в cs.js через createWsClient():
 *
 *   import { createWsClient, WsEventType } from './ws.js';
 *
 *   this.#ws = await createWsClient(this.#user_id, {
 *       onEvent:     (type, entityId, flag, msgId) => { ... },
 *       onBookmarks: (bookmarks) => { ... },
 *       onConnect:   () => { ... },
 *       onDisconnect:() => { ... },
 *   });
 *
 * Keep-alive для MV3 Service Worker:
 *   import { registerWsKeepAlive } from './js/ws.js';
 *   registerWsKeepAlive(); // вызвать один раз в background.js
 */

// ─────────────────────────────────────────────────────────────────
// Константы протокола
// ─────────────────────────────────────────────────────────────────

const WS_URL           = 'wss://appbk.4pda.to/ws/';
const APP_VERSION      = '1.9.35';

/** Константный идентификатор входящего push-события от сервера */
const PUSH_EVENT_ID    = 30309;

/**
 * Диапазон reqId для команд: [65536, 65536 + 8192).
 * Сервер различает команды по этому идентификатору в ответе.
 */
const REQ_ID_MIN       = 65536;
const REQ_ID_MAX       = REQ_ID_MIN + 8192;

/**
 * Интервал ping-пакета (мс).
 * MV3 Service Worker засыпает после ~30 с без активности;
 * держим его живым пингом каждые 25 с.
 */
const PING_INTERVAL_MS  = 25_000;

/** Таймаут ожидания ответа на отправленную команду (мс) */
const CMD_TIMEOUT_MS    = 5_000;

/** Базовая задержка переподключения; удваивается на каждой попытке */
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS  = 64_000;

/** Декодер windows-1251 для бинарных WebSocket-фреймов */
const WIN1251_DECODER   = new TextDecoder('windows-1251');

// ─────────────────────────────────────────────────────────────────
// Типы push-событий (первый символ eventString от сервера)
// ─────────────────────────────────────────────────────────────────

/** @enum {string} */
export const WsEventType = {
    QMS:   'q',   // новое/изменённое сообщение в личке (QMS)
    TOPIC: 't',   // упоминание в теме форума
    SITE:  's',   // ответ на комментарий в новости на сайте
    FORUM: 'f',   // новое в подписках форума
};

// ─────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────

/** Генерирует случайный reqId в допустимом диапазоне [REQ_ID_MIN, REQ_ID_MAX). */
function makeReqId() {
    return REQ_ID_MIN + Math.floor(Math.random() * 8192);
}

/**
 * Декодирует входящий WebSocket-фрейм в строку.
 * Сервер может слать UTF-8 строки или бинарные данные (windows-1251).
 * @param {string|ArrayBuffer|Blob} data
 * @returns {Promise<string>}
 */
async function decodeFrame(data) {
    if (typeof data === 'string') return data;
    // Firefox присылает Blob — конвертируем в ArrayBuffer
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        data = await data.arrayBuffer();
    }
    return WIN1251_DECODER.decode(data);
}

/**
 * Читает куку pass_hash с домена 4pda.to через chrome.cookies API.
 * @returns {Promise<string|null>}
 */
async function fetchPassHash() {
    try {
        const cookie = await chrome.cookies.get({ url: 'https://4pda.to', name: 'pass_hash' });
        return cookie ? cookie.value : null;
    } catch (e) {
        console.error('[WS] chrome.cookies.get(pass_hash) failed:', e);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────
// Основной класс
// ─────────────────────────────────────────────────────────────────

export class ForpdaWebSocket {

    // ── private fields ───────────────────────────────────────────

    /** @type {WebSocket|null} */
    #socket = null;

    /** Числовой ID авторизованного пользователя */
    #userId   = 0;

    /** Значение куки pass_hash */
    #passHash = '';

    /**
     * Колбэки-обработчики событий.
     * Устанавливаются через конструктор.
     */
    #callbacks = {
        /** Входящее push-событие: (type, entityId, flag, msgId) => void */
        onEvent:      null,
        /** Ответ на запрос закладок: (bookmarks: Array) => void */
        onBookmarks:  null,
        /** Соединение установлено и авторизовано */
        onConnect:    null,
        /** Соединение разорвано (до следующей попытки переподключения) */
        onDisconnect: null,
    };

    /** Счётчик неудачных попыток — для экспоненциального backoff */
    #reconnectAttempt = 0;
    #reconnectTimer   = null;

    /** Таймер пинга (keep-alive для MV3 SW) */
    #pingTimer = null;

    /**
     * Карта ожидающих ответа команд.
     * reqId → { resolve, reject, timeoutId }
     * @type {Map<number, {resolve: Function, reject: Function, timeoutId: number}>}
     */
    #pendingCmds = new Map();

    /** true — соединение закрыто намеренно, автопереподключение не нужно */
    #stopped = false;

    // ── constructor ───────────────────────────────────────────────

    /**
     * @param {number} userId
     * @param {string} passHash — значение куки pass_hash
     * @param {{onEvent?, onBookmarks?, onConnect?, onDisconnect?}} callbacks
     */
    constructor(userId, passHash, callbacks = {}) {
        this.#userId   = userId;
        this.#passHash = passHash;
        Object.assign(this.#callbacks, callbacks);
    }

    // ── public API ────────────────────────────────────────────────

    /**
     * Устанавливает WebSocket-соединение.
     * Если pass_hash не передан в конструктор — читает из куки.
     */
    async connect() {
        this.#stopped = false;

        if (!this.#passHash) {
            const hash = await fetchPassHash();
            if (!hash) {
                console.warn('[WS] pass_hash не найден — подключение отменено');
                return;
            }
            this.#passHash = hash;
        }

        this.#openSocket();
    }

    /**
     * Корректно закрывает соединение и отменяет все таймеры.
     * После вызова автоматическое переподключение не происходит.
     */
    stop() {
        this.#stopped = true;
        this.#clearPingTimer();
        this.#clearReconnectTimer();
        this.#rejectAllPending(new Error('WS stopped'));

        if (this.#socket) {
            this.#socket.onclose = null; // не триггерим reconnect
            this.#socket.close(1000, 'stopped');
            this.#socket = null;
        }

        console.log('[WS] Остановлен');
    }

    /**
     * Запрашивает у сервера список закладок пользователя (команда "mb").
     * Результат придёт в колбэк onBookmarks.
     * Защита: команда не уходит если сокет в процессе переподключения
     * (readyState !== OPEN), что гарантирует isConnected.
     */
    async requestBookmarks() {
        if (!this.isConnected) {
            console.warn('[WS] requestBookmarks: сокет не готов (переподключение?)');
            return;
        }
        const reqId = makeReqId();
        try {
            await this.#sendCmd(reqId, [reqId, 'mb', 0, []]);
        } catch (e) {
            console.error('[WS] requestBookmarks ошибка:', e);
        }
    }

    /**
     * Удаляет закладку через WS.
     * Команда "mb" с флагом записи (1) и deleted=1 в записи.
     * @param {number} id
     * @param {object} bm — оригинальный объект закладки из #rawBookmarks
     * @returns {Promise<boolean>}
     */
    async deleteBookmarkWs(id, bm) {
        if (!this.isConnected) return false;
        const urlPath = bm.url ? bm.url.replace('https://4pda.to/', '').replace('https://4pda.ru/', '') : '';
        const entry = [
            Number(id),
            Math.floor(Date.now() / 1000), // 🔑 dateNow — ключ для update
            1,                        // deleted = 1
            bm.isFolder ? 1 : 0,
            bm.parentId ?? 0,
            bm.sortOrder ?? 0,
            bm.title ?? '',
            urlPath,
        ];
        const reqId = makeReqId();
        try {
            // mb,1 c win1251-бинарным фреймом — сервер хранит строки в win1251
            const status = await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    this.#pendingCmds.delete(reqId);
                    reject(new Error(`[WS] deleteBookmarkWs reqId=${reqId} таймаут`));
                }, CMD_TIMEOUT_MS);
                this.#pendingCmds.set(reqId, { resolve, reject, timeoutId });
                this.#rawSendWin1251([reqId, 'mb', 1, [entry]]);
            });
            console.log('[WS] deleteBookmarkWs status=', status);
            return status === 0;
        } catch (e) {
            console.error('[WS] deleteBookmarkWs error:', e);
            return false;
        }
    }

    /**
     * Отправляет ПОЛНЫЙ список закладок на сервер через mb,1.
     * Использует СЫРЫЕ массивы от сервера — без трансформации, чтобы избежать
     * кракозябр и потери данных при round-trip конвертации.
     * @param {Array[]} rawEntries — сырые массивы [id, date, deleted, isFolder, parentId, sort, title, url]
     * @param {Map<number,string>} renames — id → новое название (опционально)
     * @param {Set<number>} deletedIds — ids для удаления (опционально)
     * @returns {Promise<boolean>}
     */

    /**
     * Создаёт новую папку закладок через WS.
     * @param {string} title — название папки
     * @param {number} parentId — 0 = корневая папка, иначе подпапка
     * @param {number} sortOrder — позиция в списке
     * @returns {Promise<boolean>}
     */
    async addFolderWs(title, parentId = 0, sortOrder = 0) {
        if (!this.isConnected) return false;
        const dateNow = Math.floor(Date.now() / 1000);
        const entry = [
            0,          // id=0 → сервер назначит сам
            dateNow,
            0,          // deleted = 0
            1,          // isFolder = 1 ← ключевое отличие от закладки
            Number(parentId),
            sortOrder,
            title,
            '',         // url пустой для папки
        ];
        const reqId = makeReqId();
        try {
            const status = await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    this.#pendingCmds.delete(reqId);
                    reject(new Error(`[WS] addFolderWs timeout`));
                }, CMD_TIMEOUT_MS);
                this.#pendingCmds.set(reqId, { resolve, reject, timeoutId });
                this.#rawSendWin1251([reqId, 'mb', 1, [entry]]);
            });
            console.log('[WS] addFolderWs status=', status);
            return status === 0;
        } catch (e) {
            console.error('[WS] addFolderWs error:', e);
            return false;
        }
    }

    async syncBookmarksWs(rawEntries, renames = new Map(), deletedIds = new Set()) {
        if (!this.isConnected) return false;
        // Берём сырые массивы и применяем только нужные изменения
        const entries = rawEntries
            .filter(item => Array.isArray(item) && (item[0] || item[0] === 0))
            .map(item => {
                const id = item[0];
                const entry = [...item]; // копируем, не мутируем оригинал
                if (deletedIds.has(Number(id))) {
                    entry[2] = 1; // deleted = 1
                } else if (renames.has(Number(id))) {
                    entry[6] = renames.get(Number(id)); // новый title
                }
                return entry;
            });
        const reqId = makeReqId();
        try {
            console.log(`[WS] syncBookmarksWs: отправляем ${entries.length} записей, renames=${renames.size}, deleted=${deletedIds.size}`);
            // ⚠️ Отправляем как бинарный win1251-фрейм — сервер хранит строки в win1251.
            // UTF-8 текстовый фрейм вызывает кракозябры для кириллицы при записи.
            const status = await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    this.#pendingCmds.delete(reqId);
                    reject(new Error(`[WS] syncBookmarksWs reqId=${reqId} таймаут`));
                }, CMD_TIMEOUT_MS);
                this.#pendingCmds.set(reqId, { resolve, reject, timeoutId });
                this.#rawSendWin1251([reqId, 'mb', 1, entries]);
            });
            console.log('[WS] syncBookmarksWs status=', status);
            return status === 0;
        } catch (e) {
            console.error('[WS] syncBookmarksWs error:', e);
            return false;
        }
    }

    /**
     * Переименовывает закладку через WS.
     * @param {number} id
     * @param {string} newTitle
     * @param {object} bm — оригинальный объект закладки
     * @returns {Promise<boolean>}
     */
    async renameBookmarkWs(id, newTitle, bm) {
        if (!this.isConnected) return false;
        const urlPath = bm.url ? bm.url.replace('https://4pda.to/', '').replace('https://4pda.ru/', '') : '';
        const dateNow = Math.floor(Date.now() / 1000);
        // Используем mb,1 — тот же механизм что и deleteBookmarkWs (подтверждённо работает).
        // deleted=0, новый title в entry[6]. dateNow = ключ для UPDATE вместо INSERT.
        const entry = [
            Number(id),
            dateNow,
            0,                        // deleted = 0
            bm.isFolder ? 1 : 0,
            bm.parentId ?? 0,
            bm.sortOrder ?? 0,
            newTitle,                 // 🔑 новое название
            urlPath,
        ];
        const reqId = makeReqId();
        try {
            const status = await new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    this.#pendingCmds.delete(reqId);
                    reject(new Error(`[WS] renameBookmarkWs reqId=${reqId} таймаут`));
                }, CMD_TIMEOUT_MS);
                this.#pendingCmds.set(reqId, { resolve, reject, timeoutId });
                this.#rawSendWin1251([reqId, 'mb', 1, [entry]]);
            });
            console.log('[WS] renameBookmarkWs status=', status);
            return status === 0;
        } catch (e) {
            console.error('[WS] renameBookmarkWs error:', e);
            return false;
        }
    }

    /** @returns {boolean} true — сокет открыт и авторизован */
    get isConnected() {
        return this.#socket?.readyState === WebSocket.OPEN;
    }

    // ── private: connection lifecycle ────────────────────────────

    #openSocket() {
        // Если старый сокет ещё жив — убираем обработчики и закрываем
        if (this.#socket) {
            this.#socket.onopen    = null;
            this.#socket.onclose   = null;
            this.#socket.onerror   = null;
            this.#socket.onmessage = null;
            this.#socket.close();
            this.#socket = null;
        }

        console.log(`[WS] Подключение (попытка #${this.#reconnectAttempt + 1})…`);

        const socket = new WebSocket(WS_URL);
        this.#socket = socket;

        // ── onopen ───────────────────────────────────────────────
        socket.onopen = async () => {
            console.log('[WS] Соединение установлено');
            this.#reconnectAttempt = 0;

            try {
                // 1. Handshake — отправляется сразу, без ожидания ответа
                this.#rawSend([1, 'ah', APP_VERSION, '', '', 0, 0]);

                // 2. Авторизация (ждём [reqId, 0])
                await this.#authorize();

                // 3. Подписка на push-события (ждём [reqId, 0])
                await this.#subscribeToEvents();

                // 4. Keep-alive ping каждые 25 с
                this.#startPingTimer();

                // 5. Сообщаем наружу об успешном подключении
                this.#callbacks.onConnect?.();

            } catch (e) {
                console.error('[WS] Ошибка инициализации:', e);
                socket.close(); // onclose запустит переподключение
            }
        };

        // ── onmessage ────────────────────────────────────────────
        socket.onmessage = async (event) => {
            try {
                const text = await decodeFrame(event.data);
                this.#handleMessage(text);
            } catch (e) {
                console.error('[WS] Ошибка декодирования фрейма:', e);
            }
        };

        // ── onclose ──────────────────────────────────────────────
        socket.onclose = (event) => {
            console.warn(`[WS] Закрыт: code=${event.code} reason="${event.reason}"`);
            this.#socket = null;
            this.#clearPingTimer();
            this.#rejectAllPending(new Error(`WS closed: ${event.code}`));
            this.#callbacks.onDisconnect?.();

            if (!this.#stopped) {
                this.#scheduleReconnect();
            }
        };

        // ── onerror ──────────────────────────────────────────────
        socket.onerror = () => {
            // После onerror всегда следует onclose — реакция там
            console.error('[WS] Ошибка сокета');
        };
    }

    // ── private: protocol commands ───────────────────────────────

    /** Авторизует пользователя: [reqId, "ma", userId, passHash, 1] */
    async #authorize() {
        const reqId  = makeReqId();
        const status = await this.#sendCmd(reqId, [
            reqId, 'ma', this.#userId, this.#passHash, 1,
        ]);
        if (status !== 0) throw new Error(`[WS] Авторизация провалена, status=${status}`);
        console.log('[WS] Авторизован');
    }

    /** Подписывается на push-события: [reqId, "ea", "u{userId}"] */
    async #subscribeToEvents() {
        const reqId  = makeReqId();
        const status = await this.#sendCmd(reqId, [
            reqId, 'ea', `u${this.#userId}`,
        ]);
        if (status !== 0) throw new Error(`[WS] Подписка на события провалена, status=${status}`);
        console.log('[WS] Подписка на события оформлена');
    }

    // ── private: message routing ─────────────────────────────────

    /**
     * Диспетчер входящих сообщений.
     * Ветвление:
     *   PUSH_EVENT_ID (30309) → #handlePushEvent()
     *   известный reqId       → #handleCommandReply()
     *   прочее                → debug-лог
     *
     * @param {string} text — декодированный JSON-массив
     */
    #handleMessage(text) {
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            console.warn('[WS] Не JSON:', text);
            return;
        }

        if (!Array.isArray(msg) || msg.length < 2) {
            console.warn('[WS] Неожиданный формат:', msg);
            return;
        }

        const id = msg[0];

        // Системный пинг (id=1) — игнорируем молча, не спамим в консоль
        if (id === 1) return;

        if (id === PUSH_EVENT_ID) {
            this.#handlePushEvent(msg);
        } else if (this.#pendingCmds.has(id)) {
            this.#handleCommandReply(id, msg);
        } else {
            console.debug('[WS] Неизвестный пакет id=%d:', id, msg);
        }
    }

    /**
     * Разбирает входящее push-событие.
     * Формат: [30309, status, eventString, flag, msgId]
     * Пример: [30309, 0, "q48796264", 1, 124545633]
     *
     * @param {Array} msg
     */
    #handlePushEvent(msg) {
        const [, status, eventString, flag, msgId] = msg;

        if (status !== 0) {
            console.warn('[WS] Push-событие с ненулевым статусом:', status);
            return;
        }
        if (typeof eventString !== 'string' || eventString.length < 2) {
            console.warn('[WS] Неверный eventString:', eventString);
            return;
        }

        const type     = eventString[0];                     // 'q'|'t'|'s'|'f'
        const entityId = parseInt(eventString.slice(1), 10); // числовой ID

        console.log(`[WS] 🔔 Событие type="${type}" entityId=${entityId} flag=${flag} msgId=${msgId}`);
        this.#callbacks.onEvent?.(type, entityId, flag ?? 0, msgId ?? 0);
    }

    /**
     * Резолвит Promise, ожидающий ответа на команду.
     * Если в ответе есть массив закладок [4], передаёт их в #processBookmarks.
     *
     * @param {number} reqId
     * @param {Array}  msg — полный входящий массив
     */
    #handleCommandReply(reqId, msg) {
        const pending = this.#pendingCmds.get(reqId);
        if (!pending) return;
        console.log('[WS] commandReply reqId=', reqId, 'status=', msg[1], 'full=', JSON.stringify(msg).slice(0, 150));
        clearTimeout(pending.timeoutId);
        this.#pendingCmds.delete(reqId);

        const status = msg[1];

        // Ответ на запрос закладок: [reqId, 0, timestamp, [], [[...]]]
        // msg[4] присутствует и для mb,0 (read) и для mb,1 (write) — сервер сразу возвращает список
        if (status === 0 && Array.isArray(msg[4])) {
            this.#processBookmarks(msg[4]);
            // НЕ вызываем requestBookmarks — актуальные данные уже в msg[4]
        }
        // Если msg[4] отсутствует — это другая команда (авторизация, подписка и т.д.), ничего не делаем

        pending.resolve(status);
    }

    /**
     * Преобразует сырой массив закладок в удобные объекты и вызывает onBookmarks.
     * Формат элемента: [id, date, is_deleted, is_folder, parent_id, sort, "Название", "url"]
     *
     * @param {Array[]} raw
     */
    #processBookmarks(raw) {
        const bookmarks = raw
            .filter(item => Array.isArray(item) && item[0])  // защита от пустых строк
            .map(item => ({
                id:        item[0],
                date:      item[1],
                deleted:   item[2] === 1,
                isFolder:  item[3] === 1,
                parentId:  item[4],
                sortOrder: item[5],
                title:     item[6] ?? '',
                url:       item[7] ? `https://4pda.to/${item[7]}` : '',
            }));

        console.log(`[WS] Получено закладок: ${bookmarks.length}`);
        // Логируем первые 3 для диагностики — видно изменились ли данные на сервере
        bookmarks.slice(0, 3).forEach(b => {
            console.log(`[WS] bk id=${b.id} title="${b.title}" deleted=${b.deleted}`);
        });
        this.#callbacks.onBookmarks?.(bookmarks, raw);

        // Принудительно обновляем попап после получения закладок
        try {
            chrome.runtime.sendMessage({ action: 'tickets_refresh' }).catch(() => {});
        } catch (_) {}
    }

    // ── private: sending ─────────────────────────────────────────

    /**
     * Отправляет команду и возвращает Promise, который резолвится
     * статусом ответа (0 = OK) или реджектится по таймауту.
     *
     * @param {number} reqId
     * @param {Array}  payload
     * @returns {Promise<number>}
     */
    #sendCmd(reqId, payload) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.#pendingCmds.delete(reqId);
                reject(new Error(`[WS] Команда reqId=${reqId} не получила ответа (таймаут)`));
            }, CMD_TIMEOUT_MS);

            this.#pendingCmds.set(reqId, { resolve, reject, timeoutId });
            this.#rawSend(payload);
        });
    }

    /**
     * Сериализует массив в JSON и отправляет через открытый сокет.
     * @param {Array} payload
     */
    #rawSend(payload) {
        if (this.#socket?.readyState !== WebSocket.OPEN) {
            console.warn('[WS] rawSend: сокет не открыт, пакет отброшен:', payload);
            return;
        }
        console.debug('[WS] rawSend:', JSON.stringify(payload).slice(0, 120));
        this.#socket.send(JSON.stringify(payload));
    }

    /**
     * Отправляет payload как бинарный фрейм в кодировке windows-1251.
     * Используется для mb,1 — сервер хранит строки в win1251 и ожидает их в том же виде.
     * ASCII-символы (JSON-синтаксис: [ ] " , : цифры) совпадают в обеих кодировках.
     * @param {Array} payload
     */
    #rawSendWin1251(payload) {
        if (this.#socket?.readyState !== WebSocket.OPEN) {
            console.warn('[WS] rawSendWin1251: сокет не открыт, пакет отброшен');
            return;
        }
        const json = JSON.stringify(payload);
        // Строим обратную таблицу unicode → win1251 byte
        const toWin1251 = new Map();
        for (let i = 0; i < 128; i++) toWin1251.set(i, i);
        // Кириллица А-я (U+0410–U+044F) → 0xC0–0xFF
        for (let i = 0; i < 64; i++) toWin1251.set(0x0410 + i, 0xC0 + i);
        toWin1251.set(0x0401, 0xA8); // Ё
        toWin1251.set(0x0451, 0xB8); // ё

        const bytes = new Uint8Array(json.length * 2); // с запасом
        let len = 0;
        for (const ch of json) {
            const cp = ch.codePointAt(0);
            if (toWin1251.has(cp)) {
                bytes[len++] = toWin1251.get(cp);
            } else if (cp < 0x80) {
                bytes[len++] = cp;
            } else {
                // Символ вне win1251 — пропускаем (не должно встречаться в bookmark titles)
                bytes[len++] = 0x3F; // '?'
            }
        }
        console.debug('[WS] rawSendWin1251:', json.slice(0, 120));
        this.#socket.send(bytes.buffer.slice(0, len));
    }

    // ── private: keep-alive ──────────────────────────────────────

    /**
     * Запускает периодический ping-пакет каждые PING_INTERVAL_MS мс.
     *
     * В MV3 Service Worker выгружается браузером через ~30 с без активности.
     * WebSocket сам по себе не удерживает SW — нужно периодически что-то делать.
     * Отправляем повторный handshake: сервер его игнорирует, зато SW остаётся живым.
     * Параллельно в background.js должен быть зарегистрирован chrome.alarms-будильник
     * (см. registerWsKeepAlive ниже).
     */
    #startPingTimer() {
        this.#clearPingTimer();
        this.#pingTimer = setInterval(() => {
            if (this.#socket?.readyState === WebSocket.OPEN) {
                this.#rawSend([1, 'ah', APP_VERSION, '', '', 0, 0]);
                console.debug('[WS] Ping отправлен');
            }
        }, PING_INTERVAL_MS);
    }

    #clearPingTimer() {
        if (this.#pingTimer !== null) {
            clearInterval(this.#pingTimer);
            this.#pingTimer = null;
        }
    }

    // ── private: reconnect ───────────────────────────────────────

    /**
     * Планирует следующую попытку подключения с экспоненциальным backoff.
     * Задержка: min(BASE * 2^attempt, MAX)
     *   попытка 1 → 2 с, 2 → 4 с, 3 → 8 с, …, 6+ → 64 с
     */
    #scheduleReconnect() {
        const delay = Math.min(
            RECONNECT_BASE_MS * Math.pow(2, this.#reconnectAttempt),
            RECONNECT_MAX_MS,
        );
        this.#reconnectAttempt++;

        console.log(`[WS] Переподключение через ${delay / 1000} с (попытка #${this.#reconnectAttempt})…`);

        this.#reconnectTimer = setTimeout(() => {
            if (!this.#stopped) this.#openSocket();
        }, delay);
    }

    #clearReconnectTimer() {
        if (this.#reconnectTimer !== null) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = null;
        }
    }

    // ── private: cleanup ─────────────────────────────────────────

    /**
     * Реджектит все команды, ожидающие ответа (например, при разрыве соединения).
     * @param {Error} reason
     */
    #rejectAllPending(reason) {
        for (const [, pending] of this.#pendingCmds) {
            clearTimeout(pending.timeoutId);
            pending.reject(reason);
        }
        this.#pendingCmds.clear();
    }
}

// ─────────────────────────────────────────────────────────────────
// Фабричная функция — создаёт и стартует клиент
// ─────────────────────────────────────────────────────────────────

/**
 * Создаёт ForpdaWebSocket, получает pass_hash из куки и вызывает connect().
 *
 * @param {number} userId
 * @param {{onEvent?, onBookmarks?, onConnect?, onDisconnect?}} callbacks
 * @returns {Promise<ForpdaWebSocket|null>}  null если pass_hash не найден
 */
export async function createWsClient(userId, callbacks = {}) {
    const passHash = await fetchPassHash();
    if (!passHash) {
        console.warn('[WS] createWsClient: pass_hash не найден, пропускаем');
        return null;
    }
    const client = new ForpdaWebSocket(userId, passHash, callbacks);
    await client.connect();
    return client;
}

// ─────────────────────────────────────────────────────────────────
// Keep-alive для MV3 Service Worker (через chrome.alarms)
// ─────────────────────────────────────────────────────────────────

const WS_KEEPALIVE_ALARM = '4pulse_ws_keepalive';

/**
 * Регистрирует chrome.alarms-будильник для удержания MV3 Service Worker в живых.
 *
 * Проблема: MV3 SW выгружается браузером после ~30 с без «внешних» событий.
 * WebSocket-активность (ping) является «внутренней» и не всегда удерживает SW.
 * chrome.alarms гарантированно будят SW и являются рекомендованным способом.
 *
 * Firefox поддерживает дробные periodInMinutes (< 1 мин).
 * В Chrome MV3 ≥ 122 минимум 1 мин — там setInterval в WS достаточен.
 *
 * Вызывать один раз при старте background.js:
 *   registerWsKeepAlive();
 */
export function registerWsKeepAlive() {
    // Очищаем старый будильник перед созданием нового (на случай перезапуска SW)
    chrome.alarms.clear(WS_KEEPALIVE_ALARM).catch(() => {});

    // 0.33 мин ≈ 20 с — работает в Firefox; в Chrome округляется до 1 мин
    chrome.alarms.create(WS_KEEPALIVE_ALARM, { periodInMinutes: 0.33 });

    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === WS_KEEPALIVE_ALARM) {
            // Факт срабатывания будильника уже «разбудил» SW.
            // Дополнительно можно проверить состояние WS — это делает cs.js.
            console.debug('[WS] Keep-alive alarm');
        }
    });

    console.log('[WS] Keep-alive alarm зарегистрирован');
}
