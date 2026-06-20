import { describe, expect, it, vi } from 'vitest';
import { createContentMessageRouter } from '../src/common/js/features/content/messages.js';

function createFixture(overrides = {}) {
  const dependencies = {
    fetchQmsSubject: vi.fn().mockResolvedValue('Subject'),
    fetchPage: vi.fn().mockResolvedValue('<html></html>'),
    getForumTabs: vi.fn().mockResolvedValue([{ id: 7 }]),
    sendTabMessage: vi.fn().mockResolvedValue({ ok: true, html: 'tab html' }),
    ...overrides,
  };
  return { dependencies, route: createContentMessageRouter(dependencies) };
}

async function dispatch(route, message) {
  return new Promise(resolve => route(message, resolve));
}

describe('content message router', () => {
  it('loads a QMS subject and preserves null fallback', async () => {
    const { route } = createFixture();
    await expect(dispatch(route, { action: 'fetch_qms_subject', opponent_id: 42 }))
      .resolves.toBe('Subject');

    const failed = createFixture({ fetchQmsSubject: vi.fn().mockRejectedValue(new Error('offline')) });
    await expect(dispatch(failed.route, { action: 'fetch_qms_subject', opponent_id: 42 }))
      .resolves.toBeNull();
  });

  it('resolves a direct favorite post from fetched HTML', async () => {
    const html = '<tr><a href="index.php?showtopic=42">topic</a><a href="index.php?act=findpost&amp;pid=123456">post</a></tr>';
    const { route } = createFixture({ fetchPage: vi.fn().mockResolvedValue(html) });
    await expect(dispatch(route, { action: 'resolve_favorite_preview', topic_id: 42 }))
      .resolves.toEqual({
        ok: true,
        post_id: '123456',
        post_url: 'https://4pda.to/forum/index.php?act=findpost&pid=123456',
      });
  });

  it('returns fetched credentialed page content', async () => {
    const fetchPage = vi.fn().mockResolvedValue('<h1>page</h1>');
    const { route } = createFixture({ fetchPage });
    await expect(dispatch(route, { action: 'fetch_page', url: 'https://4pda.to/forum/' }))
      .resolves.toEqual({ ok: true, html: '<h1>page</h1>' });
  });

  it('uses an open forum tab for debug page capture', async () => {
    const { route, dependencies } = createFixture();
    await expect(dispatch(route, { action: 'fav_debug_page' }))
      .resolves.toEqual({ ok: true, html: 'tab html' });
    expect(dependencies.sendTabMessage).toHaveBeenCalledWith(7, { action: 'fav_fetch_page' });
  });
});

