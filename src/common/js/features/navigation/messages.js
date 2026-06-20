import { createMessageRouter } from '../../core/messages/router.js';

function shouldActivateTab(message, defaultValue) {
  if (message.background === true) return false;
  if (message.sidebar === true) return true;
  return defaultValue;
}

export function createNavigationMessageRouter({
  getUserId,
  getDefaultActive,
  getOptionsUrl,
  openUrl,
  qms,
  favorites,
  mentions,
  updateAction,
}) {
  return createMessageRouter({
    open_url: async message => {
      const active = shouldActivateTab(message, getDefaultActive());

      switch (message.what) {
        case 'user':
          await openUrl(`https://4pda.to/forum/index.php?showuser=${getUserId()}`, true, true);
          break;
        case 'options':
          await openUrl(getOptionsUrl(), true, true);
          break;
        case 'qms':
          if (message.dialog_id) {
            const marked = qms.markAsViewed(message.dialog_id);
            if (marked) updateAction();
          }
          if (message.opponent_id && message.dialog_id && message.dialog_id !== message.opponent_id) {
            await openUrl(`https://4pda.to/forum/index.php?act=qms&mid=${message.opponent_id}&t=${message.dialog_id}`, active, false);
          } else if (message.opponent_id) {
            await openUrl(`https://4pda.to/forum/index.php?act=qms&mid=${message.opponent_id}`, active, false);
          } else {
            await qms.open();
          }
          break;
        case 'favorites': {
          const result = await favorites.open(message.id, message.view, active);
          const theme = Array.isArray(result) ? result[1] : null;
          if (theme?.viewed) {
            await mentions.markTopicMentionsAsViewed(theme.id);
            updateAction();
          }
          break;
        }
        case 'bookmarks':
          await openUrl('https://4pda.to/forum/index.php?act=fav', true, false);
          break;
        case 'tickets':
          await openUrl('https://4pda.to/forum/index.php?act=ticket', true, false);
          break;
        case 'external':
          if (message.url) await openUrl(message.url, true, false);
          break;
        case 'mentions':
          if (message.topic_id && message.post_id) {
            const mentionId = `${message.topic_id}_${message.post_id}`;
            mentions.markAsViewed(mentionId).then(updateAction).catch(() => {});
            updateAction();
            await openUrl(`https://4pda.to/forum/index.php?showtopic=${message.topic_id}&view=findpost&p=${message.post_id}`, active, false);
          } else {
            await mentions.open();
          }
          break;
      }

      return { ok: true };
    },
  });
}

export { shouldActivateTab };

