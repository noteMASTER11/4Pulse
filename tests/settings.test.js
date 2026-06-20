import { beforeEach, describe, expect, it } from 'vitest';
import { initializeSettingsDefaults, SETTINGS } from '../src/common/js/config/settings.js';

beforeEach(() => {
  for (const key of Object.keys(SETTINGS)) delete SETTINGS[key];
});

describe('runtime settings', () => {
  it('keeps existing persisted values when defaults are initialized', () => {
    SETTINGS.interval = 300;
    initializeSettingsDefaults({ interval: 900, compact_mode: false });

    expect(SETTINGS).toEqual({ interval: 300, compact_mode: false });
  });

  it('preserves a stable shared object identity', () => {
    const reference = SETTINGS;
    initializeSettingsDefaults({ theme_mode: 'light' });

    expect(SETTINGS).toBe(reference);
  });
});

