import { describe, expect, it } from 'vitest';
import {
  FOUNDATION_BACKUP_KEYS,
  getFoundationProfile,
} from '../src/common/js/features/foundation/profiles.js';

describe('foundation profiles', () => {
  it('does not unlock moderator tickets by itself', () => {
    const locked = getFoundationProfile('moderator', false);
    expect(locked.values.tickets_enabled).toBe(false);
    expect(locked.values.notification_tickets_level).toBe(0);

    const unlocked = getFoundationProfile('moderator', true);
    expect(unlocked.values.tickets_enabled).toBe(true);
    expect(unlocked.values.notification_tickets_level).toBe(20);
  });

  it('falls back to the standard profile', () => {
    expect(getFoundationProfile('unknown')).toEqual(getFoundationProfile('standard'));
  });

  it('backs up unique setting keys', () => {
    expect(new Set(FOUNDATION_BACKUP_KEYS).size).toBe(FOUNDATION_BACKUP_KEYS.length);
    expect(FOUNDATION_BACKUP_KEYS).toContain('tickets_unlocked');
  });
});

