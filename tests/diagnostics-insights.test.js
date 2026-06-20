import { describe, expect, it, vi } from 'vitest';
import {
  buildAttentionCenter,
  buildFavoritesCleanup,
  buildMorningDigest,
  buildSmartInsights,
  stripHtmlText,
} from '../src/common/js/features/diagnostics/insights.js';

describe('diagnostic insights', () => {
  it('reports a healthy idle state', () => {
    const insights = buildSmartInsights({
      authorized: true,
      wsConnected: true,
      counts: {},
      health: { issues: [] },
    });
    expect(insights).toContainEqual(expect.objectContaining({ level: 'ok' }));
  });

  it('reports authentication and realtime problems', () => {
    const insights = buildSmartInsights({ authorized: false, wsConnected: false, counts: {} });
    expect(insights.map(item => item.title)).toEqual(['Нет входа на 4PDA', 'WebSocket offline']);
  });
});

describe('attention center', () => {
  it('sanitizes text and orders tasks by priority', () => {
    vi.spyOn(Date, 'now').mockReturnValue(123);
    const result = buildAttentionCenter({
      qms: { list: [{ id: 1, unread: 1, title: '<b>QMS</b>' }] },
      mentions: { list: [{ id: 2, unread: 1, title: 'Mention' }] },
      favorites: { list: [{ id: 3, viewed: false, title: 'Topic', unread_count: 2 }] },
    });

    expect(result.ts).toBe(123);
    expect(result.tasks.map(task => task.type)).toEqual(['qms', 'mention', 'favorite']);
    expect(result.tasks[0].title).toBe('QMS');
    vi.restoreAllMocks();
  });

  it('strips HTML into plain compact text', () => {
    expect(stripHtmlText(' <b>Hello</b>   world ')).toBe('Hello world');
  });
});

describe('digest and cleanup', () => {
  it('counts visible events and active bookmarks', () => {
    const digest = buildMorningDigest({
      tickets: { enabled: false, count: 10 },
      qms: { count: 2 },
      mentions: { count: 1 },
      favorites: { count: 3 },
      bookmarks: { list: [{}, { deleted: true }] },
    });
    expect(digest.total).toBe(6);
    expect(digest.counts.bookmarks).toBe(1);
  });

  it('suggests noisy and stale favorites', () => {
    const now = Date.UTC(2026, 0, 1);
    const oldPost = Math.floor(now / 1000) - 50 * 86400;
    const cleanup = buildFavoritesCleanup({
      favorites: { list: [
        { id: 1, title: 'Noisy', unread_count: 20 },
        { id: 2, title: 'Stale', viewed: true, last_post_ts: oldPost },
      ] },
    }, now);
    expect(cleanup.suggestions.map(item => item.type)).toEqual(['noisy', 'stale']);
  });
});

