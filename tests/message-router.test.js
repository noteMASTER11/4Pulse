import { describe, expect, it, vi } from 'vitest';
import { createMessageRouter } from '../src/common/js/core/messages/router.js';
import { createRadioMessageRouter } from '../src/common/js/features/radio/messages.js';

async function flushPromises() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('message router', () => {
  it('ignores unknown commands', () => {
    const sendResponse = vi.fn();
    const route = createMessageRouter({ known: () => ({ ok: true }) });
    expect(route({ action: 'unknown' }, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('normalizes command errors', async () => {
    const sendResponse = vi.fn();
    const route = createMessageRouter({ broken: () => { throw new Error('boom'); } });
    expect(route({ action: 'broken' }, sendResponse)).toBe(true);
    await flushPromises();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'boom' });
  });
});

describe('radio message router', () => {
  it('plays a station and responds with current state', async () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const sendResponse = vi.fn();
    const route = createRadioMessageRouter({
      getState: () => ({ isPlaying: true }),
      play,
      pause: vi.fn(),
      setVolume: vi.fn(),
      setEnabled: vi.fn(),
      setSleepTimer: vi.fn(),
      getHistory: vi.fn(),
      clearHistory: vi.fn(),
    });

    expect(route({ action: 'radio_play', station: 'stream', stationName: 'Name' }, sendResponse)).toBe(true);
    await flushPromises();
    expect(play).toHaveBeenCalledWith('stream', 'Name');
    expect(sendResponse).toHaveBeenCalledWith({ isPlaying: true });
  });
});

