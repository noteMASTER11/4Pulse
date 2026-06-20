import {
    buildAttentionCenter,
    buildFavoritesCleanup,
    buildMorningDigest,
    buildSmartInsights,
} from './insights.js';

const STORAGE_INTEGRITY_EXPECTED_KEYS = {
    bm_cache: 'array',
    bm_deleted_ids: 'array',
    bm_renamed_map: 'object',
    bm_collapsed_folders: 'array',
    qms_cache: 'array',
    mentions_cache: 'array',
    tickets_cache: 'array',
    radio_history: 'array',
    tiles_row_config: 'object',
    visible_user_avatar_map: 'object',
};

export async function collectStorageIntegrity({ storage }) {
    const result = { ok: true, issues: [], staleKeys: [], quotaWarning: false, keys: 0 };
    try {
        const all = await storage.get(null);
        result.keys = Object.keys(all || {}).length;
        for (const [key, type] of Object.entries(STORAGE_INTEGRITY_EXPECTED_KEYS)) {
            if (!(key in all)) continue;
            const value = all[key];
            const ok = type === 'array' ? Array.isArray(value) : value && typeof value === type && !Array.isArray(value);
            if (!ok) result.issues.push(`${key}: invalid ${type}`);
        }
        for (const key of Object.keys(all)) {
            if (/^(old_|legacy_|tmp_|debug_|backup_legacy)/i.test(key)) result.staleKeys.push(key);
        }
        if (storage.getBytesInUse) {
            const bytes = await storage.getBytesInUse(null).catch(() => 0);
            result.bytesInUse = bytes;
            result.quotaWarning = bytes > 4.5 * 1024 * 1024;
            if (result.quotaWarning) result.issues.push('storage quota warning');
        }
        result.ok = result.issues.length === 0;
    } catch (error) {
        result.ok = false;
        result.issues.push(String(error?.message || error));
    }
    return result;
}

export async function collectAlarmIntegrity({ alarms }, now = Date.now()) {
    const result = { ok: true, issues: [], total: 0, duplicates: [], expired: [] };
    try {
        const allAlarms = await alarms.getAll();
        result.total = allAlarms.length;
        const seen = new Set();
        for (const alarm of allAlarms) {
            if (seen.has(alarm.name)) result.duplicates.push(alarm.name);
            seen.add(alarm.name);
            if (alarm.scheduledTime && alarm.scheduledTime < now - 60_000) result.expired.push(alarm.name);
        }
        if (result.duplicates.length) result.issues.push('alarm duplicates: ' + result.duplicates.join(', '));
        if (result.expired.length) result.issues.push('expired alarms: ' + result.expired.join(', '));
        result.ok = result.issues.length === 0;
    } catch (error) {
        result.ok = false;
        result.issues.push(String(error?.message || error));
    }
    return result;
}

export function createDiagnosticsSnapshotService({
    api,
    settings,
    bg,
    eventLog,
    getRadioPublicState,
    getUpdateHealth,
    alarmName,
    debugWarn = () => {},
} = {}) {
    async function getDiagnosticsSnapshot() {
        let bmCache = [];
        let bmDeletedIds = [];
        let bmRenamedMap = {};
        let bmCollapsedFolders = [];

        try {
            const stored = await api.storage.local.get([
                'bm_cache',
                'bm_deleted_ids',
                'bm_renamed_map',
                'bm_collapsed_folders',
            ]);
            bmCache = Array.isArray(stored.bm_cache) ? stored.bm_cache : [];
            bmDeletedIds = Array.isArray(stored.bm_deleted_ids) ? stored.bm_deleted_ids : [];
            bmRenamedMap = stored.bm_renamed_map && typeof stored.bm_renamed_map === 'object' ? stored.bm_renamed_map : {};
            bmCollapsedFolders = Array.isArray(stored.bm_collapsed_folders) ? stored.bm_collapsed_folders : [];
        } catch (error) {
            debugWarn('[Diagnostics] bookmarks storage read failed:', error);
        }

        let alarmInfo = null;
        let backoffInfo = {};
        let httpHealth = {};
        const storageIntegrity = await collectStorageIntegrity({ storage: api.storage.local });
        const alarmIntegrity = await collectAlarmIntegrity({ alarms: api.alarms }, Date.now());
        try { alarmInfo = await api.alarms.get(alarmName); } catch (_) {}
        try {
            backoffInfo = await api.storage.local.get(['backoff_multiplier', 'backoff_until', 'is_429_active', 'last_429_time', 'auto_mode_active']);
            httpHealth = await api.storage.local.get(['fetcher_last_success_at', 'fetcher_last_error_at', 'fetcher_last_error']);
        } catch (_) {}

        const liveBookmarks = Array.isArray(bg.bookmarks) ? bg.bookmarks : [];
        const activeBookmarks = liveBookmarks.filter(bookmark => !bookmark.deleted);
        const folders = activeBookmarks.filter(bookmark => bookmark.isFolder);
        const links = activeBookmarks.filter(bookmark => !bookmark.isFolder);
        const countsForHealth = {
            qms: bg.qms?.count || 0,
            favorites: bg.favorites?.count || 0,
            mentions: bg.mentions?.count || 0,
            tickets: settings.tickets_enabled ? (bg.tickets?.count || 0) : 0,
        };
        const totalForHealth = countsForHealth.qms + countsForHealth.favorites + countsForHealth.mentions + countsForHealth.tickets;
        const now = Date.now();
        const updateHealth = getUpdateHealth();
        const healthIssues = [];
        if (!bg.user_id) healthIssues.push('Нет авторизации');
        if (!bg.wsConnected) healthIssues.push('WebSocket offline');
        if (backoffInfo.is_429_active) healthIssues.push('Активна защита 429');
        if (updateHealth.lastUpdateFinishedAt && !updateHealth.lastUpdateOk) healthIssues.push('Последнее обновление с ошибкой');
        if (!alarmInfo) healthIssues.push('Polling alarm не найден');
        if (!storageIntegrity.ok) healthIssues.push('Проблемы целостности storage');
        if (!alarmIntegrity.ok) healthIssues.push('Проблемы chrome.alarms');
        if (httpHealth.fetcher_last_success_at && now - Number(httpHealth.fetcher_last_success_at) > 60 * 60 * 1000) {
            healthIssues.push('HTTP давно не отвечал успешно');
        }

        const snapshot = {
            ok: true,
            version: api.runtime.getManifest()?.version || '',
            authorized: !!bg.user_id,
            user_id: bg.user_id || null,
            wsConnected: !!bg.wsConnected,
            health: {
                status: healthIssues.length ? 'warning' : 'ok',
                issues: healthIssues,
                lastUpdateStartedAt: updateHealth.lastUpdateStartedAt,
                lastUpdateFinishedAt: updateHealth.lastUpdateFinishedAt,
                lastUpdateAgeSec: updateHealth.lastUpdateFinishedAt ? Math.round((now - updateHealth.lastUpdateFinishedAt) / 1000) : null,
                lastUpdateOk: updateHealth.lastUpdateOk,
                lastUpdateError: updateHealth.lastUpdateError,
                totalEvents: totalForHealth,
                polling: {
                    exists: !!alarmInfo,
                    scheduledTime: alarmInfo?.scheduledTime || null,
                    scheduledInSec: alarmInfo?.scheduledTime ? Math.max(0, Math.round((alarmInfo.scheduledTime - now) / 1000)) : null,
                    periodMinutes: alarmInfo?.periodInMinutes || null,
                    backoffMultiplier: backoffInfo.backoff_multiplier || 1,
                    backoffUntil: backoffInfo.backoff_until || null,
                    is429Active: !!backoffInfo.is_429_active,
                    last429Time: backoffInfo.last_429_time || null,
                    autoModeActive: !!backoffInfo.auto_mode_active,
                },
                http: {
                    lastSuccessAt: httpHealth.fetcher_last_success_at || null,
                    lastSuccessAgeSec: httpHealth.fetcher_last_success_at ? Math.round((now - Number(httpHealth.fetcher_last_success_at)) / 1000) : null,
                    lastErrorAt: httpHealth.fetcher_last_error_at || null,
                    lastError: httpHealth.fetcher_last_error || '',
                },
                storageIntegrity,
                alarmIntegrity,
            },
            eventLog: eventLog.get(50),
            counts: countsForHealth,
            bookmarks: {
                enabled: !!settings.show_bookmarks_tab,
                loaded: liveBookmarks.length > 0,
                total: liveBookmarks.length,
                active: activeBookmarks.length,
                links: links.length,
                folders: folders.length,
                deletedLocal: bmDeletedIds.length,
                renamedLocal: Object.keys(bmRenamedMap).length,
                collapsedFolders: bmCollapsedFolders.length,
                cacheRows: bmCache.length,
                sample: activeBookmarks.slice(0, 5).map(bookmark => ({
                    id: bookmark.id,
                    title: bookmark.title,
                    isFolder: !!bookmark.isFolder,
                    parentId: bookmark.parentId,
                    url: bookmark.url || '',
                })),
            },
            radio: getRadioPublicState(),
            settings: {
                interval: settings.interval,
                tickets_enabled: !!settings.tickets_enabled,
                tickets_unlocked: !!settings.tickets_unlocked,
                bookmarks_enabled: !!settings.show_bookmarks_tab,
                dnd_enabled: !!settings.dnd_enabled,
                dnd_allow_qms: !!settings.dnd_allow_qms,
                dnd_allow_mentions: !!settings.dnd_allow_mentions,
                dnd_allow_tickets: !!settings.dnd_allow_tickets,
                dnd_mute_radio: !!settings.dnd_mute_radio,
                attention_center_enabled: !!settings.attention_center_enabled,
                attention_center_mode: settings.attention_center_mode || 'full',
                user_profile_mode: settings.user_profile_mode || 'standard',
                stable_mode: !!settings.stable_mode,
                silent_doctor_enabled: !!settings.silent_doctor_enabled,
                auto_backup_enabled: !!settings.auto_backup_enabled,
                theme_mode: settings.theme_mode,
            },
            ts: Date.now(),
        };
        snapshot.smartInsights = buildSmartInsights(snapshot);
        snapshot.eventLog = eventLog.getVisible(50);
        return snapshot;
    }

    function buildPopupEnvelope() {
        const data = bg.popup_data;
        const updateHealth = getUpdateHealth();
        data.attention = buildAttentionCenter(data);
        data.morning_digest = buildMorningDigest(data);
        data.favorites_cleanup = buildFavoritesCleanup(data);
        data.health_compact = {
            wsConnected: !!bg.wsConnected,
            lastUpdateOk: updateHealth.lastUpdateOk,
            lastUpdateFinishedAt: updateHealth.lastUpdateFinishedAt,
            issues: [
                !bg.wsConnected ? 'WebSocket offline' : '',
                updateHealth.lastUpdateFinishedAt && !updateHealth.lastUpdateOk ? 'Последнее обновление с ошибкой' : '',
            ].filter(Boolean),
        };
        return data;
    }

    return {
        getDiagnosticsSnapshot,
        buildPopupEnvelope,
    };
}
