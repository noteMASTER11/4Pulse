import { createMessageRouter } from '../../core/messages/router.js';

export function createBookmarkMessageRouter({
  deleteBookmark,
  renameBookmark,
  addBookmark,
  addFolder,
}) {
  return createMessageRouter({
    bookmark_delete: async message => ({ ok: Boolean(await deleteBookmark(message.id)) }),
    bookmark_rename: async message => ({ ok: Boolean(await renameBookmark(message.id, message.title)) }),
    bookmark_add: async message => ({
      ok: Boolean(await addBookmark(message.title, message.url, message.parentId ?? 0)),
    }),
    folder_add: async message => ({
      ok: Boolean(await addFolder(message.title, message.parentId ?? 0)),
    }),
  });
}

