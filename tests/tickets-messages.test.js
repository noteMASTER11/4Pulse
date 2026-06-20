import { describe, expect, it, vi } from 'vitest';
import { createTicketMessageRouter } from '../src/common/js/features/tickets/messages.js';

function createFixture(overrides = {}) {
  const tickets = {
    count: 2,
    list: [{ id: 1 }],
    open: vi.fn().mockResolvedValue(undefined),
    openSource: vi.fn().mockResolvedValue(undefined),
    changeStatus: vi.fn().mockResolvedValue(true),
    markAsViewed: vi.fn().mockResolvedValue(undefined),
    applyPageSnapshot: vi.fn().mockResolvedValue(true),
    update: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const updateAction = vi.fn();
  const route = createTicketMessageRouter({
    tickets,
    updateAction,
    fetchWithRetry: vi.fn().mockResolvedValue({ ok: true }),
    fetchText: vi.fn().mockResolvedValue(''),
  });
  return { route, tickets, updateAction };
}

async function dispatch(route, message) {
  return new Promise(resolve => route(message, resolve));
}

describe('ticket message router', () => {
  it('changes status and updates the toolbar state', async () => {
    const { route, tickets, updateAction } = createFixture();
    await expect(dispatch(route, { action: 'ticket_change_status', id: 7, status: 'work' }))
      .resolves.toEqual({ ok: true, count: 2 });
    expect(tickets.changeStatus).toHaveBeenCalledWith(7, 'work');
    expect(updateAction).toHaveBeenCalledOnce();
  });

  it('returns the legacy empty refresh response after a failure', async () => {
    const { route } = createFixture({ update: vi.fn().mockRejectedValue(new Error('offline')) });
    await expect(dispatch(route, { action: 'tickets_refresh' }))
      .resolves.toEqual({ count: 0, list: [] });
  });

  it('rejects invalid navigation counts without touching the model', async () => {
    const { route, tickets } = createFixture();
    await expect(dispatch(route, { action: 'ticket_nav_count', count: -1 }))
      .resolves.toEqual({ ok: false });
    expect(tickets.applyPageSnapshot).not.toHaveBeenCalled();
  });
});

