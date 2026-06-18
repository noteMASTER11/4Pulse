// js/fetcher.js — единая сетeвая обёртка 4Pulse
// Централизует retry/backoff, 429/5xx, сетевые ошибки и Cloudflare/403.

export class FetcherError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'FetcherError';
    this.url = meta.url || '';
    this.status = meta.status || 0;
    this.code = meta.code || 'FETCHER_ERROR';
    this.attempts = meta.attempts || 0;
    this.cloudflare = !!meta.cloudflare;
    this.cause = meta.cause;
  }
}

const DEFAULTS = {
  retries: 3,
  timeout: 15000,
  baseDelay: 700,
  maxDelay: 8000,
  credentials: 'include',
  cache: 'reload',
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const jitter = (ms) => Math.round(ms * (0.75 + Math.random() * 0.5));

function isRetryableStatus(status) {
  return status === 429 || status === 408 || status === 425 || status >= 500;
}

function isNetworkError(error) {
  return error?.name === 'AbortError' || /network|failed|fetch|timeout|abort/i.test(String(error?.message || error));
}

function looksLikeCloudflare(response, text = '') {
  const server = response?.headers?.get?.('server') || '';
  const cfRay = response?.headers?.get?.('cf-ray') || '';
  const body = String(text || '').slice(0, 5000);
  return /cloudflare/i.test(server) || !!cfRay || /cf-browser-verification|Attention Required|Just a moment|Checking your browser/i.test(body);
}

async function rememberHttpHealth(ok, meta = {}) {
  try {
    if (!globalThis.chrome?.storage?.local) return;
    const patch = ok
      ? { fetcher_last_success_at: Date.now(), fetcher_last_error: '' }
      : { fetcher_last_error_at: Date.now(), fetcher_last_error: meta.message || meta.code || 'fetch failed' };
    await chrome.storage.local.set(patch);
  } catch (_) {}
}

export async function fetchWithRetry(url, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const retries = Number.isFinite(cfg.retries) ? cfg.retries : DEFAULTS.retries;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), cfg.timeout);
    try {
      const response = await fetch(url, {
        ...cfg,
        signal: cfg.signal || controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.status === 403) {
        let probe = '';
        try { probe = await response.clone().text(); } catch (_) {}
        const cloudflare = looksLikeCloudflare(response, probe);
        const err = new FetcherError(cloudflare ? '403 Forbidden / Cloudflare protection' : '403 Forbidden', {
          url, status: 403, code: cloudflare ? 'CLOUDFLARE_FORBIDDEN' : 'HTTP_FORBIDDEN', attempts: attempt + 1, cloudflare,
        });
        await rememberHttpHealth(false, err);
        throw err;
      }

      if (!response.ok && isRetryableStatus(response.status) && attempt < retries) {
        lastError = new FetcherError(`HTTP ${response.status}`, { url, status: response.status, code: 'HTTP_RETRYABLE', attempts: attempt + 1 });
        const retryAfter = Number(response.headers?.get?.('retry-after') || 0) * 1000;
        const delay = retryAfter || Math.min(cfg.maxDelay, cfg.baseDelay * Math.pow(2, attempt));
        await sleep(jitter(delay));
        continue;
      }

      if (!response.ok) {
        const err = new FetcherError(`HTTP ${response.status} ${response.statusText || ''}`.trim(), {
          url, status: response.status, code: 'HTTP_ERROR', attempts: attempt + 1,
        });
        await rememberHttpHealth(false, err);
        throw err;
      }

      await rememberHttpHealth(true);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof FetcherError && error.code !== 'HTTP_RETRYABLE') throw error;
      lastError = error;
      if (attempt >= retries || !isNetworkError(error)) break;
      await sleep(jitter(Math.min(cfg.maxDelay, cfg.baseDelay * Math.pow(2, attempt))));
    }
  }

  const err = lastError instanceof FetcherError
    ? lastError
    : new FetcherError(String(lastError?.message || lastError || 'Network request failed'), {
        url, code: 'NETWORK_ERROR', attempts: retries + 1, cause: lastError,
      });
  await rememberHttpHealth(false, err);
  throw err;
}

export async function fetchText(url, options = {}, encoding = 'windows-1251') {
  const response = await fetchWithRetry(url, options);
  if (encoding) {
    const buffer = await response.arrayBuffer();
    return new TextDecoder(encoding).decode(buffer);
  }
  return response.text();
}

export const Fetcher = { fetchWithRetry, fetchText };
