export function createEventLogService({
    storage,
    limit = 80,
    now = () => Date.now(),
} = {}) {
    let buffer = [];
    let clearedAt = 0;

    function visibleLog() {
        return buffer.filter(event => !clearedAt || (event.ts || 0) > clearedAt);
    }

    function add(type, message, level = 'info', details = {}) {
        try {
            const item = {
                ts: now(),
                type: String(type || 'event'),
                level: String(level || 'info'),
                message: String(message || ''),
                details: details && typeof details === 'object' ? details : {},
            };
            if (clearedAt && item.ts <= clearedAt) return;

            buffer = visibleLog();
            buffer.unshift(item);
            if (buffer.length > limit) buffer.length = limit;
            storage?.set?.({
                event_log_cache: buffer,
                event_log_cleared_at: clearedAt,
            })?.catch?.(() => {});
        } catch (_) {}
    }

    async function load() {
        try {
            const stored = await storage.get(['event_log_cache', 'event_log_cleared_at']);
            clearedAt = Number(stored.event_log_cleared_at || 0);
            const rawLog = Array.isArray(stored.event_log_cache) ? stored.event_log_cache : [];
            buffer = rawLog.filter(event => !clearedAt || (event.ts || 0) > clearedAt).slice(0, limit);
        } catch (_) {
            buffer = [];
        }
    }

    async function clear() {
        clearedAt = now();
        buffer = [];
        await storage.set({ event_log_cache: [], event_log_cleared_at: clearedAt });
        return { ok: true, clearedAt };
    }

    function get(limitSize = 50) {
        return buffer.slice(0, limitSize);
    }

    function getVisible(limitSize = 50) {
        return visibleLog().slice(0, limitSize);
    }

    function getClearedAt() {
        return clearedAt;
    }

    return {
        add,
        load,
        clear,
        get,
        getVisible,
        getClearedAt,
    };
}
