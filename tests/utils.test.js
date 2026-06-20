import { describe, expect, it, vi } from 'vitest';
import { encodeWin1251, getLogDatetime, parse_response } from '../src/common/js/utils.js';

describe('parse_response', () => {
  it('parses numbers and quoted values', () => {
    expect(parse_response('12 "hello world" 7')).toEqual([12, 'hello world', 7]);
  });

  it('decodes HTML entities in quoted values', () => {
    expect(parse_response('"A &amp; B &#x41;"')).toEqual(['A & B A']);
  });

  it('returns null for empty input', () => {
    expect(parse_response('')).toBeNull();
  });
});

describe('encodeWin1251', () => {
  it('encodes Cyrillic and preserves URL-safe ASCII', () => {
    expect(encodeWin1251('Тест 42')).toBe('%D2%E5%F1%F2%2042');
  });

  it('encodes ё and Ё using Windows-1251 bytes', () => {
    expect(encodeWin1251('Ёж ёж')).toBe('%A8%E6%20%B8%E6');
  });
});

describe('getLogDatetime', () => {
  it('formats local time with milliseconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5, 6));
    expect(getLogDatetime()).toBe('03:04:05,006');
    vi.useRealTimers();
  });
});

