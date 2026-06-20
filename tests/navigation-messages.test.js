import { describe, expect, it, vi } from 'vitest';
import {
  createNavigationMessageRouter,
  shouldActivateTab,
} from '../src/common/js/features/navigation/messages.js';

describe('navigation messages', () => {
  it('applies background and sidebar activation precedence', () => {
    expect(shouldActivateTab({ background: true, sidebar: true }, true)).toBe(false);
    expect(shouldActivateTab({ sidebar: true }, false)).toBe(true);
    expect(shouldActivateTab({}, false)).toBe(false);
  });

  it('opens favorites and marks related mentions as viewed', async () => {
    const markTopicMentionsAsViewed = vi.fn().mockResolvedValue(undefined);
    const updateAction = vi.fn();
    const route = createNavigationMessageRouter({
      getUserId: () => 1,
      getDefaultActive: () => false,
      getOptionsUrl: () => 'extension://options',
      openUrl: vi.fn(),
      qms: { markAsViewed: vi.fn(), open: vi.fn() },
      favorites: { open: vi.fn().mockResolvedValue([{}, { id: 42, viewed: true }]) },
      mentions: { markTopicMentionsAsViewed, markAsViewed: vi.fn(), open: vi.fn() },
      updateAction,
    });
    await new Promise(resolve => route({ action: 'open_url', what: 'favorites', id: 42 }, resolve));
    expect(markTopicMentionsAsViewed).toHaveBeenCalledWith(42);
    expect(updateAction).toHaveBeenCalledOnce();
  });
});

