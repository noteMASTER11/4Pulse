import { describe, expect, it, vi } from 'vitest';
import { createAvatarMessageRouter } from '../src/common/js/features/avatar/messages.js';

describe('avatar message router', () => {
  it('falls back to an avatar from an open forum page', async () => {
    const saveUserAvatar = vi.fn();
    const route = createAvatarMessageRouter({
      lookupAuthorAvatar: vi.fn(),
      refreshUserAvatar: vi.fn().mockResolvedValue({ ok: false }),
      getCurrentAvatar: () => '',
      getAvatarFromPage: vi.fn().mockResolvedValue('https://4pda.to/avatar.png'),
      cacheAvatarAsDataUrl: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
      saveUserAvatar,
    });
    const response = await new Promise(resolve => route({ action: 'user_avatar_refresh' }, resolve));
    expect(response.user_avatar_url).toBe('data:image/png;base64,abc');
    expect(saveUserAvatar).toHaveBeenCalledWith('data:image/png;base64,abc', 'https://4pda.to/avatar.png');
  });
});

