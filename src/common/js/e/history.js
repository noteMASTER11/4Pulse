
const DEBUG = () => globalThis.__FOURPULSE_DEBUG__ === true;
function debugLog(...args) { if (DEBUG()) console.log(...args); }
function debugWarn(...args) { if (DEBUG()) console.warn(...args); }

/**
 * history.js — «Недавно просмотренные темы» через WS-команду "mh"
 *
 * Данные приходят из processHistory() в ws.js уже в нормализованном виде.
 * Формат определяется автоматически в ws.js (bookmark-like или простой).
 */

export class History {
    #topics = [];
    #updatedAt = 0;

    constructor(cs) { this.cs = cs; }

    get list()      { return this.#topics; }
    get count()     { return this.#topics.length; }
    get updatedAt() { return this.#updatedAt; }

    reset() {
        this.#topics = [];
        this.#updatedAt = 0;
    }

    /**
     * Обновляет список из нормализованных объектов (приходят из ws.processHistory).
     * @param {Object[]} topics — [{id, title, last_post_ts, url, topic_url, ...}]
     */
    updateFromWs(topics) {
        this.#topics = topics.map(t => new HistoryTopic(t));
        this.#updatedAt = Date.now();
        debugLog(`[History] Обновлено: ${this.#topics.length} тем`);
    }
}

export class HistoryTopic {
    /**
     * @param {Object} data — нормализованный объект из ws.processHistory
     */
    constructor(data) {
        this.id           = data.id           ?? 0;
        this.title        = data.title        ?? '';
        this.last_post_ts = data.last_post_ts ?? 0;
        this.last_post_id = data.last_post_id ?? 0;
        this.section      = data.section      ?? '';
        this.snippet      = data.snippet      ?? '';
        this.reply_count  = data.reply_count  ?? 0;
        this.forum_id     = data.forum_id     ?? 0;
        this.last_user_id = data.last_user_id ?? 0;
        this.last_user    = data.last_user    ?? '';
        this.url          = data.url          ?? `https://4pda.to/forum/index.php?showtopic=${this.id}`;
        this.topic_url    = data.topic_url    ?? `https://4pda.to/forum/index.php?showtopic=${this.id}`;
    }

    get timeAgo() {
        if (!this.last_post_ts) return '';
        const diff = Math.floor(Date.now() / 1000) - this.last_post_ts;
        if (diff < 60)        return 'только что';
        if (diff < 3600)      return `${Math.floor(diff / 60)} мин назад`;
        if (diff < 86400)     return `${Math.floor(diff / 3600)} ч назад`;
        if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} дн назад`;
        const d = new Date(this.last_post_ts * 1000);
        return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    }
}
