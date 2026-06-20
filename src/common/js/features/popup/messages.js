import { createMessageRouter } from '../../core/messages/router.js';

export async function waitForUserId(getUserId, {
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  maxWait = 4000,
  pollInterval = 250,
} = {}) {
  let waited = 0;
  while (!getUserId() && waited < maxWait) {
    await wait(pollInterval);
    waited += pollInterval;
  }
  return getUserId();
}

export function createPopupMessageRouter({
  settings,
  loadSettings,
  getUserId,
  buildEnvelope,
  openAuth,
  forceUpdate,
  startBlink,
  stopBlink,
  markFavoriteAsRead,
  getFocusedTopics,
  getFavorites,
  getFavoriteById,
  getCounts,
  updateAction,
  requestHistory,
  waitOptions,
}) {
  return createMessageRouter({
    popup_loaded: async () => {
      stopBlink();
      if (!getUserId()) await waitForUserId(getUserId, waitOptions);
      if (getUserId()) return buildEnvelope();
      await openAuth();
      return null;
    },
    reload_settings: async () => {
      try {
        const stored = await loadSettings(Object.keys(settings));
        for (const [key, value] of Object.entries(stored)) {
          if (key in settings) settings[key] = value;
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    force_update: async () => {
      try {
        await forceUpdate();
        return { success: true };
      } catch {
        return { success: false };
      }
    },
    start_priority_blink: () => {
      startBlink();
      return { ok: true };
    },
    stop_priority_blink: () => {
      stopBlink();
      return { ok: true };
    },
    mark_as_read: async message => {
      let result;
      try {
        result = await markFavoriteAsRead(message.id);
      } catch {
        return false;
      }

      try {
        const focused = (await getFocusedTopics()).map(String);
        const hasFocusedUnread = getFavorites().some(topic => (
          !topic.viewed && focused.includes(String(topic.id))
        ));
        if (!hasFocusedUnread) stopBlink();
      } catch {
        // Reading the topic succeeded; focus-state cleanup is best-effort.
      }
      return result;
    },
    get_counts: () => getCounts(),
    page_topic_opened: message => {
      if (message.topic_id && message.is_read) {
        const theme = getFavoriteById(String(message.topic_id));
        if (theme && !theme.viewed) {
          theme.viewed = true;
          updateAction();
        }
      }
      return { ok: true };
    },
    request: message => {
      const counts = getCounts();
      if (message.what === 'favorites.count') return counts.favorites;
      if (message.what === 'qms.count') return counts.qms;
      if (message.what === 'mentions.count') return counts.mentions;
      return undefined;
    },
    request_history: () => {
      requestHistory();
      return { ok: true };
    },
  });
}

