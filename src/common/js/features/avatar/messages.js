import { createMessageRouter } from '../../core/messages/router.js';

export function createAvatarMessageRouter({
  lookupAuthorAvatar,
  refreshUserAvatar,
  getCurrentAvatar,
  getAvatarFromPage,
  cacheAvatarAsDataUrl,
  saveUserAvatar,
}) {
  return createMessageRouter({
    author_avatar_lookup: message => (
      lookupAuthorAvatar(message.user_id, message.user_name, message.profile_url)
    ),
    user_avatar_refresh: async message => {
      let result;
      try {
        result = await refreshUserAvatar(Boolean(message.force));
      } catch (error) {
        result = {
          ok: false,
          error: String(error?.message || error),
          user_avatar_url: getCurrentAvatar() || '',
        };
      }

      try {
        if (!result?.user_avatar_url) {
          const pageAvatar = await getAvatarFromPage();
          if (pageAvatar) {
            const dataAvatar = await cacheAvatarAsDataUrl(pageAvatar);
            const finalAvatar = dataAvatar || pageAvatar;
            await saveUserAvatar(finalAvatar, pageAvatar);
            result = { ok: true, user_avatar_url: finalAvatar, source: pageAvatar };
          }
        }
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message || error),
          user_avatar_url: getCurrentAvatar() || '',
        };
      }

      return result || { ok: false, user_avatar_url: getCurrentAvatar() || '' };
    },
  });
}
