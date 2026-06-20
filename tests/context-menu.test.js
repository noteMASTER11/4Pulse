import { describe, expect, it, vi } from 'vitest';
import {
  buildContextMenuItems,
  createContextMenuService,
} from '../src/common/js/features/context-menu/service.js';

describe('context menu service', () => {
  it('shows tickets only for unlocked ticket mode', () => {
    expect(buildContextMenuItems({ showTickets: false }).some(item => item.id === 'open.tickets')).toBe(false);
    expect(buildContextMenuItems({ showTickets: true }).some(item => item.id === 'open.tickets')).toBe(true);
  });

  it('rebuilds localized menu items', async () => {
    const create = vi.fn();
    const service = createContextMenuService({
      api: { removeAll: callback => callback(), create },
      loadState: async () => ({ ui_language: 'en', tickets_enabled: true, tickets_unlocked: true }),
      actions: {},
    });
    await service.refresh();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'update.all', title: '4Pulse: refresh everything' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'open.tickets' }));
  });

  it('dispatches clicks through the action map', async () => {
    const update = vi.fn();
    const service = createContextMenuService({ api: {}, loadState: vi.fn(), actions: { 'update.all': update } });
    expect(service.handleClick('update.all')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(update).toHaveBeenCalledOnce();
  });
});

