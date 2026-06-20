// Strips cookies/authorization headers from known radio stream hosts.
// 4PDA cookies are intentionally left untouched; this guard is scoped only to
// radio/metadata hosts that do not need user credentials.
export const RADIO_COOKIE_GUARD_HOSTS = [
    'hostingradio.ru',
    'radiorecord.hostingradio.ru',
    'rusradio.hostingradio.ru',
    'dfm.hostingradio.ru',
    'dfm-dfmrusdance.hostingradio.ru',
    'maximum.hostingradio.ru',
    'nashe1.hostingradio.ru',
    'nrj-nrjkaz.hostingradio.ru',
    'chanson.hostingradio.ru',
    'ep256.hostingradio.ru',
    'retro.hostingradio.ru',
    'rs.kartina.tv',
    'kartina.tv',
    'icecast-vgtrk.cdnvideo.ru',
    'icecast.luxfm.kz',
    'icecast.ns.kz',
    'online.hitfm.ua',
    'online.kissfm.ua',
    'online.radioroks.ua',
];

export const RADIO_COOKIE_GUARD_URLS = [...new Set(
    RADIO_COOKIE_GUARD_HOSTS.flatMap(host => [`*://${host}/*`, `*://*.${host}/*`])
)];

export function isRadioCookieGuardUrl(url = '') {
    try {
        const host = new URL(String(url)).hostname.toLowerCase();
        return RADIO_COOKIE_GUARD_HOSTS.some(guardHost => host === guardHost || host.endsWith('.' + guardHost));
    } catch (_) {
        return false;
    }
}

export function stripRadioRequestHeaders(headers = []) {
    return (headers || []).filter(header => {
        const name = String(header.name || '').toLowerCase();
        return name !== 'cookie' && name !== 'authorization';
    });
}

export function stripRadioResponseHeaders(headers = []) {
    return (headers || []).filter(header => {
        const name = String(header.name || '').toLowerCase();
        return name !== 'set-cookie' && name !== 'set-cookie2';
    });
}

export function registerRadioCookieGuard({
    api = globalThis.chrome,
    skipDeclarativeNetRequest = false,
    logger = console,
    registryKey = '__4pulseRadioCookieGuardRegistered',
} = {}) {
    if (skipDeclarativeNetRequest && api?.declarativeNetRequest) return false;

    try {
        if (!api?.webRequest?.onBeforeSendHeaders || !api?.webRequest?.onHeadersReceived) return false;
        if (globalThis[registryKey]) return false;
        globalThis[registryKey] = true;

        api.webRequest.onBeforeSendHeaders.addListener(
            details => {
                if (!isRadioCookieGuardUrl(details.url)) return {};
                return { requestHeaders: stripRadioRequestHeaders(details.requestHeaders) };
            },
            { urls: RADIO_COOKIE_GUARD_URLS },
            ['blocking', 'requestHeaders']
        );

        api.webRequest.onHeadersReceived.addListener(
            details => {
                if (!isRadioCookieGuardUrl(details.url)) return {};
                return { responseHeaders: stripRadioResponseHeaders(details.responseHeaders) };
            },
            { urls: RADIO_COOKIE_GUARD_URLS },
            ['blocking', 'responseHeaders']
        );

        return true;
    } catch (error) {
        try { logger.warn('[Radio] cookie guard unavailable:', error?.message || error); } catch (_) {}
        return false;
    }
}
