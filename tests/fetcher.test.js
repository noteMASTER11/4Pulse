import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetcherError, fetchText, fetchWithRetry } from '../src/common/js/fetcher.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchWithRetry', () => {
  it('returns a successful response', async () => {
    const response = new Response('ok', { status: 200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(fetchWithRetry('https://example.test', { retries: 0 })).resolves.toBe(response);
  });

  it('wraps an HTTP error with useful metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', {
      status: 404,
      statusText: 'Not Found',
    })));

    const error = await fetchWithRetry('https://example.test/missing', { retries: 0 }).catch(value => value);
    expect(error).toBeInstanceOf(FetcherError);
    expect(error).toMatchObject({ status: 404, code: 'HTTP_ERROR', attempts: 1 });
  });

  it('detects Cloudflare challenge responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Just a moment', {
      status: 403,
      headers: { server: 'cloudflare' },
    })));

    const error = await fetchWithRetry('https://example.test/protected', { retries: 0 }).catch(value => value);
    expect(error).toMatchObject({ code: 'CLOUDFLARE_FORBIDDEN', cloudflare: true });
  });
});

describe('fetchText', () => {
  it('decodes Windows-1251 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
      { status: 200 },
    )));

    await expect(fetchText('https://example.test', { retries: 0 })).resolves.toBe('Привет');
  });
});

