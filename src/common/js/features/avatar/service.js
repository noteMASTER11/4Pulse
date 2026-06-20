const AUTHOR_AVATAR_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

function normalize4pdaUrl(url = '') {
    const value = String(url || '').trim().replace(/&amp;/g, '&');
    if (!value) return '';
    if (value.startsWith('//')) return 'https:' + value;
    if (value.startsWith('/')) return 'https://4pda.to' + value;
    return /^https?:\/\//i.test(value) ? value : '';
}

function isBadAvatarUrl(url = '') {
    return /(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon|sprite|button|rate|warn|reputation|logo|icon)/i.test(String(url || ''));
}

export function extractAuthorAvatarUrl(html = '', { userName = '' } = {}) {
    const candidates = [];
    const add = (raw, score) => {
        const url = normalize4pdaUrl(raw);
        if (url && !isBadAvatarUrl(url)) candidates.push({ url, score });
    };

    let match = html.match(/<div[^>]+class=["'][^"']*user-box[^"']*["'][\s\S]*?<div[^>]+class=["'][^"']*photo[^"']*["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i);
    if (match) add(match[1], 200);

    match = html.match(/<div[^>]+class=["'][^"']*photo[^"']*["'][\s\S]*?<img[^>]+src=["']([^"']+)["']/i);
    if (match) add(match[1], 160);

    const imageRe = /<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["'][^>]*(?:alt|title)=["']([^"']*)["'][^>]*>/ig;
    while ((match = imageRe.exec(html))) {
        const context = (match[0] + ' ' + (match[2] || '')).toLowerCase();
        let score = /аватар|avatar|photo|userpic/.test(context) ? 90 : 0;
        if (/\/s\/[^"']+\.(gif|png|jpe?g|webp)/i.test(match[1])) score += 60;
        if (userName && context.includes(userName.toLowerCase())) score += 40;
        if (score > 0) add(match[1], score);
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0]?.url || '';
}

function defaultEncodeBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
}

function pickAvatarFromPage(userId, userName) {
    const abs = url => normalize4pdaUrl(url);
    const badUrl = url => /(?:blank|spacer|transparent|pixel|default|no[_-]?avatar|empty|placeholder|favicon|sprite|button)/i.test(String(url || ''));
    const scoreImg = img => {
        if (!img) return null;
        const url = abs(img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '');
        if (!url || badUrl(url)) return null;
        const context = ((img.alt || '') + ' ' + (img.title || '') + ' ' + (img.className || '') + ' ' + (img.closest('.photo,.user-box,.profile,.avatar')?.className || '')).toLowerCase();
        let score = 0;
        if (img.closest('.user-box .photo')) score += 120;
        if (img.closest('.photo')) score += 80;
        if (/аватар|avatar|photo|userpic/.test(context)) score += 50;
        if (/\/s\/[^?#]+\.(gif|png|jpe?g|webp)(?:$|[?#])/i.test(url)) score += 45;
        if (userName && (img.alt === userName || img.title === userName)) score += 35;
        if (userId && location.href.includes('showuser=' + userId)) score += 25;
        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        if (width >= 48 && height >= 48) score += 20;
        if (width && height && (width < 24 || height < 24)) score -= 80;
        if (/emoji|smile|rank|group|warn|reputation|badge|logo|icon/i.test(context)) score -= 40;
        return score > 0 ? { url, score } : null;
    };
    const preferred = [
        '.user-box .photo img',
        '.photo img[alt*="Аватар" i]',
        '.photo img',
        'img[alt*="Аватар" i]',
        userName ? `img[title="${CSS.escape(userName)}"]` : '',
        userName ? `img[alt="${CSS.escape(userName)}"]` : '',
    ].filter(Boolean);
    const candidates = [];
    for (const selector of preferred) {
        try {
            document.querySelectorAll(selector).forEach(img => {
                const candidate = scoreImg(img);
                if (candidate) candidates.push(candidate);
            });
        } catch (_) {}
    }
    document.querySelectorAll('img').forEach(img => {
        const candidate = scoreImg(img);
        if (candidate) candidates.push(candidate);
    });
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0]?.url || '';
}

export function createAvatarLookupService({
    api,
    storage,
    fetchImpl = fetch,
    decodeHtml = buffer => new TextDecoder('windows-1251').decode(buffer),
    encodeBase64 = defaultEncodeBase64,
    now = () => Date.now(),
    getCurrentUser = () => ({}),
    failureCooldownMs = AUTHOR_AVATAR_FAILURE_COOLDOWN_MS,
} = {}) {
    const pending = new Map();
    const failedUntil = new Map();

    async function getAvatarFromOpen4pdaTabs() {
        try {
            const hasTabsPermission = await api.permissions?.contains?.({ permissions: ['tabs'] }).catch(() => false);
            if (!hasTabsPermission) return '';

            const tabs = await api.tabs.query({ url: ['https://4pda.to/forum/index.php*'] });
            const { userId = '', userName = '' } = getCurrentUser();
            const uid = String(userId || '');
            tabs.sort((left, right) => {
                const leftUrl = left.url || '';
                const rightUrl = right.url || '';
                return (rightUrl.includes('showuser=' + uid) ? 1 : 0) - (leftUrl.includes('showuser=' + uid) ? 1 : 0);
            });

            for (const tab of tabs) {
                try {
                    const result = await api.tabs.sendMessage(tab.id, { action: 'user_avatar_from_page' });
                    if (result?.user_avatar_url) return result.user_avatar_url;
                } catch (_) {}

                try {
                    const injected = await api.scripting.executeScript({
                        target: { tabId: tab.id },
                        args: [uid, String(userName || '')],
                        func: pickAvatarFromPage,
                    });
                    const url = injected?.[0]?.result || '';
                    if (url) return url;
                } catch (_) {}
            }
        } catch (_) {}
        return '';
    }

    async function cacheAvatarUrlAsDataUrl(url) {
        try {
            if (!url) return '';
            if (/^data:image\//i.test(url)) return url;
            const response = await fetchImpl(url, { credentials: 'include', cache: 'reload' });
            if (!response.ok) return '';
            const contentType = (response.headers.get('content-type') || '').toLowerCase();
            if (!contentType.startsWith('image/')) return '';
            const buffer = await response.arrayBuffer();
            if (!buffer || buffer.byteLength > 512 * 1024) return '';
            const bytes = new Uint8Array(buffer);
            return `data:${contentType.split(';')[0]};base64,${encodeBase64(bytes)}`;
        } catch (_) {
            return '';
        }
    }

    async function lookupAuthorAvatar(userId, userName = '', profileUrl = '') {
        userId = String(userId || '').trim();
        userName = String(userName || '').trim();
        profileUrl = String(profileUrl || '').trim();
        const idKey = userId ? `id:${userId}` : '';
        const lookupKey = idKey || (userName ? 'name:' + userName : profileUrl);
        const timestamp = now();

        if (!lookupKey) return { ok: false, error: 'no_profile_url' };

        const cooldownUntil = failedUntil.get(lookupKey) || 0;
        if (cooldownUntil > timestamp) return { ok: false, error: 'avatar_lookup_cooldown' };
        if (pending.has(lookupKey)) return pending.get(lookupKey);

        const promise = (async () => {
            const cache = await storage.get(['visible_user_avatar_map']).catch(() => ({}));
            const map = (cache.visible_user_avatar_map && typeof cache.visible_user_avatar_map === 'object') ? cache.visible_user_avatar_map : {};
            if (idKey && map[idKey]) return { ok: true, avatar: map[idKey], cached: true };
            if (userName && map[userName]) return { ok: true, avatar: map[userName], cached: true };

            const url = profileUrl || (userId ? `https://4pda.to/forum/index.php?showuser=${userId}` : '');
            if (!url) return { ok: false, error: 'no_profile_url' };

            try {
                const response = await fetchImpl(url, { credentials: 'include', cache: 'reload' });
                if (!response.ok) {
                    failedUntil.set(lookupKey, now() + failureCooldownMs);
                    return { ok: false, error: 'profile_http_' + response.status };
                }
                const buffer = await response.arrayBuffer();
                const avatarUrl = extractAuthorAvatarUrl(decodeHtml(buffer), { userName });
                if (!avatarUrl) {
                    failedUntil.set(lookupKey, now() + failureCooldownMs);
                    return { ok: false, error: 'avatar_not_found' };
                }

                const dataAvatar = await cacheAvatarUrlAsDataUrl(avatarUrl);
                const avatar = dataAvatar || avatarUrl;
                if (idKey) map[idKey] = avatar;
                if (userName) map[userName] = avatar;

                const mapKeys = Object.keys(map);
                if (mapKeys.length > 500) {
                    const pruned = {};
                    mapKeys.slice(-500).forEach(key => { pruned[key] = map[key]; });
                    Object.keys(map).forEach(key => { if (!pruned[key]) delete map[key]; });
                }

                await storage.set({ visible_user_avatar_map: map }).catch(() => {});
                failedUntil.delete(lookupKey);
                return { ok: true, avatar, source: avatarUrl };
            } catch (error) {
                failedUntil.set(lookupKey, now() + failureCooldownMs);
                return { ok: false, error: String(error?.message || error) };
            }
        })().finally(() => {
            pending.delete(lookupKey);
        });

        pending.set(lookupKey, promise);
        return promise;
    }

    return {
        getAvatarFromOpen4pdaTabs,
        cacheAvatarUrlAsDataUrl,
        lookupAuthorAvatar,
    };
}
