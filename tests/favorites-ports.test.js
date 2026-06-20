import { describe, expect, it, vi } from 'vitest';
import { createFavoritesPortHandler } from '../src/common/js/features/favorites/ports.js';

describe('favorites port handler', () => {
  it('reports progress while marking themes read', async () => {
    const postMessage = vi.fn();
    const themes = [
      { id: 1, read: vi.fn().mockResolvedValue(true) },
      { id: 2, read: vi.fn().mockResolvedValue(false) },
    ];
    const handle = createFavoritesPortHandler({
      getFavorites: () => themes,
      getPinnedFavorites: () => [],
      getCount: () => 1,
      getOpenLimit: () => 5,
    });
    expect(await handle({ name: 'themes-read-all', postMessage })).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ id: 1, count: 1 });
  });

  it('respects the configured open limit', async () => {
    const first = { open: vi.fn().mockResolvedValue([{}, { id: 1, viewed: true }]) };
    const second = { open: vi.fn() };
    const handle = createFavoritesPortHandler({
      getFavorites: () => [first, second],
      getPinnedFavorites: () => [],
      getCount: () => 0,
      getOpenLimit: () => 1,
    });
    await handle({ name: 'themes-open-all', postMessage: vi.fn() });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(first.open).toHaveBeenCalledOnce();
    expect(second.open).not.toHaveBeenCalled();
  });
});

