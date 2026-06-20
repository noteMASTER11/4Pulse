import { describe, expect, it } from 'vitest';
import {
  isRadioCookieGuardUrl,
  registerRadioCookieGuard,
  stripRadioRequestHeaders,
  stripRadioResponseHeaders,
} from '../src/common/js/features/radio/cookie-guard.js';

describe('radio cookie guard', () => {
  it('matches only known radio hosts', () => {
    expect(isRadioCookieGuardUrl('https://radiorecord.hostingradio.ru/live')).toBe(true);
    expect(isRadioCookieGuardUrl('https://sub.hostingradio.ru/live')).toBe(true);
    expect(isRadioCookieGuardUrl('https://4pda.to/forum/index.php')).toBe(false);
  });

  it('strips credentials from radio requests and responses', () => {
    expect(stripRadioRequestHeaders([
      { name: 'Cookie', value: 'sid=1' },
      { name: 'Authorization', value: 'Bearer token' },
      { name: 'Accept', value: '*/*' },
    ])).toEqual([{ name: 'Accept', value: '*/*' }]);

    expect(stripRadioResponseHeaders([
      { name: 'Set-Cookie', value: 'hssuid=1' },
      { name: 'Content-Type', value: 'audio/aac' },
    ])).toEqual([{ name: 'Content-Type', value: 'audio/aac' }]);
  });

  it('registers webRequest listeners when available', () => {
    const listeners = [];
    const api = {
      webRequest: {
        onBeforeSendHeaders: { addListener: (...args) => listeners.push(['request', args]) },
        onHeadersReceived: { addListener: (...args) => listeners.push(['response', args]) },
      },
    };

    const registryKey = '__testRadioCookieGuardRegistered';
    delete globalThis[registryKey];

    expect(registerRadioCookieGuard({ api, registryKey })).toBe(true);
    expect(listeners.map(([type]) => type)).toEqual(['request', 'response']);

    delete globalThis[registryKey];
  });

  it('lets Chrome MV3 builds rely on declarativeNetRequest rules', () => {
    const api = { declarativeNetRequest: {}, webRequest: {} };
    expect(registerRadioCookieGuard({ api, skipDeclarativeNetRequest: true })).toBe(false);
  });
});
