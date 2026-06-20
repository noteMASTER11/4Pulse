import { describe, expect, it, vi } from 'vitest';
import {
  calculatePollingSchedule,
  createBackgroundAlarmHandler,
  createAlarmDispatcher,
  shouldEnableTicketQuickPoll,
} from '../src/common/js/features/alarms/service.js';

describe('alarm scheduling', () => {
  it('uses a stable fallback interval while WebSocket is connected', () => {
    expect(calculatePollingSchedule({
      state: {}, wsConnected: true, intervalSeconds: 300, random: () => 1,
    }).periodInMinutes).toBe(15);
  });

  it('applies 429 protection and deterministic jitter', () => {
    const schedule = calculatePollingSchedule({
      state: { is_429_active: true },
      wsConnected: false,
      intervalSeconds: 600,
      random: () => 0.5,
    });
    expect(schedule.multiplier).toBe(5);
    expect(schedule.periodInMinutes).toBe(50);
  });

  it('enables quick polling only for unlocked tickets', () => {
    expect(shouldEnableTicketQuickPoll({ tickets_enabled: true, tickets_unlocked: true })).toBe(true);
    expect(shouldEnableTicketQuickPoll({ tickets_enabled: true, tickets_unlocked: false })).toBe(false);
  });
});

describe('background alarm handler', () => {
  it('does not update while the browser is locked', async () => {
    const update = vi.fn();
    const handle = createBackgroundAlarmHandler({
      queryIdle: vi.fn().mockResolvedValue('locked'), update,
      applyBlinkPhase: vi.fn(), loadTicketState: vi.fn(), syncTicketQuickPoll: vi.fn(),
      updateTickets: vi.fn(), updateAction: vi.fn(), runDoctor: vi.fn(),
      isWsConnected: () => true, pollRadioMetadata: vi.fn(), keepRadioAlive: vi.fn(),
    });
    handle({ name: 'periodicUpdate' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(update).not.toHaveBeenCalled();
  });

  it('updates unlocked tickets and toolbar state', async () => {
    const updateTickets = vi.fn();
    const updateAction = vi.fn();
    const handle = createBackgroundAlarmHandler({
      queryIdle: vi.fn().mockResolvedValue('active'), update: vi.fn(),
      applyBlinkPhase: vi.fn(),
      loadTicketState: vi.fn().mockResolvedValue({ tickets_enabled: true, tickets_unlocked: true }),
      syncTicketQuickPoll: vi.fn(), updateTickets, updateAction, runDoctor: vi.fn(),
      isWsConnected: () => true, pollRadioMetadata: vi.fn(), keepRadioAlive: vi.fn(),
    });
    handle({ name: 'ticketQuickPoll' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(updateTickets).toHaveBeenCalledWith(false);
    expect(updateAction).toHaveBeenCalledOnce();
  });
});

describe('alarm dispatcher', () => {
  it('routes known alarms and ignores unknown ones', async () => {
    const periodic = vi.fn();
    const dispatch = createAlarmDispatcher({ periodic }, vi.fn());
    expect(dispatch({ name: 'missing' })).toBe(false);
    expect(dispatch({ name: 'periodic' })).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(periodic).toHaveBeenCalledOnce();
  });
});
