import { describe, expect, it, vi } from 'vitest';
import {
  createPopupMessageRouter,
  waitForUserId,
} from '../src/common/js/features/popup/messages.js';

async function dispatch(route, message) {
  return new Promise(resolve => route(message, resolve));
}

function createFixture(overrides = {}) {
  const settings = { interval: 900, compact_mode: false };
  const dependencies = {
    settings,
    loadSettings: vi.fn().mockResolvedValue({ interval: 300, unknown: true }),
    getUserId: () => 1,
    buildEnvelope: () => ({ ready: true }),
    openAuth: vi.fn(),
    forceUpdate: vi.fn(),
    startBlink: vi.fn(),
    stopBlink: vi.fn(),
    markFavoriteAsRead: vi.fn().mockResolvedValue(true),
    getFocusedTopics: vi.fn().mockResolvedValue([]),
    getFavorites: () => [],
    getFavoriteById: vi.fn(),
    getCounts: () => ({ favorites: 3, qms: 2, mentions: 1 }),
    updateAction: vi.fn(),
    requestHistory: vi.fn(),
    ...overrides,
  };
  return {
    settings,
    dependencies,
    route: createPopupMessageRouter(dependencies),
  };
}

describe('popup lifecycle', () => {
  it('waits until the background user id is initialized', async () => {
    let attempts = 0;
    const wait = vi.fn().mockImplementation(() => { attempts += 1; });
    const id = await waitForUserId(() => attempts >= 2 ? 42 : 0, {
      wait,
      maxWait: 100,
      pollInterval: 10,
    });
    expect(id).toBe(42);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('opens authentication after initialization timeout', async () => {
    const openAuth = vi.fn();
    const { route } = createFixture({
      getUserId: () => 0,
      openAuth,
      waitOptions: { wait: vi.fn(), maxWait: 20, pollInterval: 10 },
    });
    await expect(dispatch(route, { action: 'popup_loaded' })).resolves.toBeNull();
    expect(openAuth).toHaveBeenCalledOnce();
  });

  it('reloads only known settings', async () => {
    const { route, settings } = createFixture();
    await expect(dispatch(route, { action: 'reload_settings' })).resolves.toEqual({ ok: true });
    expect(settings).toEqual({ interval: 300, compact_mode: false });
  });
});

describe('popup counters and read state', () => {
  it('supports current and legacy count messages', async () => {
    const { route } = createFixture();
    await expect(dispatch(route, { action: 'get_counts' })).resolves.toEqual({
      favorites: 3, qms: 2, mentions: 1,
    });
    await expect(dispatch(route, { action: 'request', what: 'qms.count' })).resolves.toBe(2);
  });

  it('marks a page topic read and refreshes toolbar state', async () => {
    const theme = { id: 7, viewed: false };
    const updateAction = vi.fn();
    const { route } = createFixture({ getFavoriteById: () => theme, updateAction });
    await dispatch(route, { action: 'page_topic_opened', topic_id: 7, is_read: true });
    expect(theme.viewed).toBe(true);
    expect(updateAction).toHaveBeenCalledOnce();
  });
});

