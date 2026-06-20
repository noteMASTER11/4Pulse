import { createMessageRouter } from '../../core/messages/router.js';
import { resolveFavoritePreviewFromFavHtml } from '../favorites/preview-links.js';

const FAVORITES_URL = 'https://4pda.to/forum/index.php?act=fav';

export function createContentMessageRouter({
  fetchQmsSubject,
  fetchPage,
  getForumTabs,
  sendTabMessage,
}) {
  return createMessageRouter({
    fetch_qms_subject: async message => {
      if (!message.opponent_id) return null;
      try {
        return await fetchQmsSubject(message.opponent_id);
      } catch {
        return null;
      }
    },
    resolve_favorite_preview: async message => {
      if (!message.topic_id) return { ok: false, error: 'no topic_id' };
      try {
        const html = await fetchPage(FAVORITES_URL);
        const found = resolveFavoritePreviewFromFavHtml(html, message.topic_id);
        return found
          ? { ok: true, ...found }
          : { ok: false, error: 'no direct post link' };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    fetch_page: async message => {
      if (!message.url) return undefined;
      try {
        return { ok: true, html: await fetchPage(message.url) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    fav_debug_page: async () => {
      const tabs = await getForumTabs();
      if (!tabs.length) return { ok: false, error: 'no 4pda tab' };
      return sendTabMessage(tabs[0].id, { action: 'fav_fetch_page' });
    },
  });
}

