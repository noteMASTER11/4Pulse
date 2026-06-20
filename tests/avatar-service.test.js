import { describe, expect, it } from 'vitest';
import {
  createAvatarLookupService,
  extractAuthorAvatarUrl,
} from '../src/common/js/features/avatar/service.js';

function createStorage(initial = {}) {
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

function response({ ok = true, status = 200, contentType = 'text/html', body = '' } = {}) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return {
    ok,
    status,
    headers: { get: key => (key.toLowerCase() === 'content-type' ? contentType : '') },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

describe('avatar lookup service', () => {
  it('extracts the best profile avatar from HTML', () => {
    const html = `
      <div class="user-box">
        <div class="photo"><img src="/forum/uploads/s/user.png" alt="Alice"></div>
      </div>
      <img src="/forum/style/logo.png" alt="logo">
    `;

    expect(extractAuthorAvatarUrl(html, { userName: 'Alice' })).toBe('https://4pda.to/forum/uploads/s/user.png');
  });

  it('returns cached avatars without fetching profile', async () => {
    const storage = createStorage({ visible_user_avatar_map: { 'id:42': 'data:image/png;base64,cached' } });
    const service = createAvatarLookupService({
      api: {},
      storage,
      fetchImpl: async () => { throw new Error('should not fetch'); },
    });

    await expect(service.lookupAuthorAvatar('42', 'Alice')).resolves.toEqual({
      ok: true,
      avatar: 'data:image/png;base64,cached',
      cached: true,
    });
  });

  it('fetches profile and caches avatar data URL', async () => {
    const storage = createStorage();
    const service = createAvatarLookupService({
      api: {},
      storage,
      decodeHtml: buffer => new TextDecoder().decode(buffer),
      encodeBase64: () => 'AAAA',
      fetchImpl: async url => {
        if (String(url).includes('showuser=42')) {
          return response({
            body: '<div class="photo"><img src="https://4pda.to/forum/uploads/s/avatar.png"></div>',
          });
        }
        return response({
          contentType: 'image/png',
          body: new Uint8Array([0, 0, 0, 0]),
        });
      },
    });

    const result = await service.lookupAuthorAvatar('42', 'Alice');

    expect(result).toEqual({
      ok: true,
      avatar: 'data:image/png;base64,AAAA',
      source: 'https://4pda.to/forum/uploads/s/avatar.png',
    });
    expect(storage.data.visible_user_avatar_map['id:42']).toBe('data:image/png;base64,AAAA');
  });

  it('reads avatar from an already open tab before injecting fallback code', async () => {
    const service = createAvatarLookupService({
      storage: createStorage(),
      getCurrentUser: () => ({ userId: '42', userName: 'Alice' }),
      api: {
        permissions: { contains: async () => true },
        tabs: {
          query: async () => [{ id: 1, url: 'https://4pda.to/forum/index.php?showuser=42' }],
          sendMessage: async () => ({ user_avatar_url: 'https://4pda.to/avatar.png' }),
        },
        scripting: {
          executeScript: async () => { throw new Error('should not inject'); },
        },
      },
    });

    await expect(service.getAvatarFromOpen4pdaTabs()).resolves.toBe('https://4pda.to/avatar.png');
  });
});
