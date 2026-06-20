import { describe, expect, it } from 'vitest';
import { createEventLogService } from '../src/common/js/features/diagnostics/event-log.js';

function createMemoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    async get(keys) {
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map(key => [key, data[key]]));
      }
      return { ...data };
    },
    async set(values) {
      Object.assign(data, values);
    },
    data,
  };
}

describe('event log service', () => {
  it('stores events newest-first and respects the limit', () => {
    let ts = 10;
    const storage = createMemoryStorage();
    const log = createEventLogService({ storage, limit: 2, now: () => ts++ });

    log.add('first', 'one');
    log.add('second', 'two');
    log.add('third', 'three');

    expect(log.get().map(item => item.type)).toEqual(['third', 'second']);
    expect(storage.data.event_log_cache.map(item => item.type)).toEqual(['third', 'second']);
  });

  it('loads persisted events after clear marker', async () => {
    const storage = createMemoryStorage({
      event_log_cleared_at: 20,
      event_log_cache: [
        { ts: 21, type: 'visible' },
        { ts: 10, type: 'hidden' },
      ],
    });
    const log = createEventLogService({ storage });

    await log.load();

    expect(log.getVisible().map(item => item.type)).toEqual(['visible']);
  });

  it('clears persisted events', async () => {
    const storage = createMemoryStorage({
      event_log_cache: [{ ts: 1, type: 'old' }],
    });
    const log = createEventLogService({ storage, now: () => 42 });

    const result = await log.clear();

    expect(result).toEqual({ ok: true, clearedAt: 42 });
    expect(storage.data.event_log_cache).toEqual([]);
    expect(storage.data.event_log_cleared_at).toBe(42);
  });
});
