import { describe, expect, it } from 'vitest';
import { createPriorityBlinkService } from '../src/common/js/features/badge/priority-blink.js';

function createMemoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    async get(keys) {
      return Object.fromEntries(keys.map(key => [key, data[key]]));
    },
    async set(values) {
      Object.assign(data, values);
    },
    data,
  };
}

describe('priority blink service', () => {
  it('starts blinking and toggles badge phases', async () => {
    const storage = createMemoryStorage();
    const created = [];
    const badges = [];
    const service = createPriorityBlinkService({
      storage,
      alarmName: 'priorityBlink',
      alarms: {
        create: (...args) => created.push(args),
        clear: async () => {},
      },
      setBlinkBadge: value => badges.push(value),
      updateAction: () => {},
    });

    await service.start();
    service.applyBlinkPhase();

    expect(storage.data.priority_blinking).toBe(true);
    expect(created).toEqual([['priorityBlink', { periodInMinutes: 1 }]]);
    expect(badges).toEqual([true, false]);
  });

  it('stops blinking and restores regular badge drawing', () => {
    const cleared = [];
    const badges = [];
    let updated = 0;
    const service = createPriorityBlinkService({
      storage: createMemoryStorage({ priority_blinking: true }),
      alarmName: 'priorityBlink',
      alarms: {
        create: () => {},
        clear: async name => cleared.push(name),
      },
      setBlinkBadge: value => badges.push(value),
      updateAction: () => { updated += 1; },
    });

    service.stop();

    expect(cleared).toEqual(['priorityBlink']);
    expect(badges).toEqual([false]);
    expect(updated).toBe(1);
  });

  it('restores blink only when focused topics still exist', async () => {
    const storage = createMemoryStorage({ priority_blinking: true, focused_topics: ['10'] });
    const created = [];
    const badges = [];
    const service = createPriorityBlinkService({
      storage,
      alarmName: 'priorityBlink',
      alarms: {
        create: (...args) => created.push(args),
        clear: async () => {},
      },
      setBlinkBadge: value => badges.push(value),
      updateAction: () => {},
    });

    await expect(service.restoreIfNeeded()).resolves.toBe(true);

    expect(service.isBlinking()).toBe(true);
    expect(created).toEqual([['priorityBlink', { periodInMinutes: 1 }]]);
    expect(badges).toEqual([true]);
  });
});
