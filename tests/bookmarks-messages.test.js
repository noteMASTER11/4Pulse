import { describe, expect, it, vi } from 'vitest';
import { createBookmarkMessageRouter } from '../src/common/js/features/bookmarks/messages.js';

describe('bookmark message router', () => {
  it('passes normalized parent id to bookmark creation', async () => {
    const addBookmark = vi.fn().mockResolvedValue(true);
    const sendResponse = vi.fn();
    const route = createBookmarkMessageRouter({
      deleteBookmark: vi.fn(),
      renameBookmark: vi.fn(),
      addBookmark,
      addFolder: vi.fn(),
    });

    route({ action: 'bookmark_add', title: 'Topic', url: 'https://example.test' }, sendResponse);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(addBookmark).toHaveBeenCalledWith('Topic', 'https://example.test', 0);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});

