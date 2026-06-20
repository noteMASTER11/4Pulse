import { describe, expect, it } from 'vitest';
import {
  directPostFromHref,
  normalize4pdaForumUrl,
  resolveFavoritePreviewFromFavHtml,
} from '../src/common/js/features/favorites/preview-links.js';

describe('favorite preview links', () => {
  it('normalizes relative 4PDA links', () => {
    expect(normalize4pdaForumUrl('/forum/index.php?showtopic=42')).toBe(
      'https://4pda.to/forum/index.php?showtopic=42',
    );
    expect(normalize4pdaForumUrl('index.php?showtopic=42')).toBe(
      'https://4pda.to/forum/index.php?showtopic=42',
    );
  });

  it('extracts a direct post id', () => {
    expect(directPostFromHref('/forum/index.php?act=findpost&pid=123456')).toEqual({
      post_id: '123456',
      post_url: 'https://4pda.to/forum/index.php?act=findpost&pid=123456',
    });
  });

  it('prefers direct post links and ignores getnewpost', () => {
    const html = `
      <tr>
        <a href="index.php?showtopic=42&view=getnewpost">new</a>
        <a href="index.php?act=findpost&amp;pid=654321">direct</a>
      </tr>`;

    expect(resolveFavoritePreviewFromFavHtml(html, 42)?.post_id).toBe('654321');
  });

  it('returns null when the topic is absent', () => {
    expect(resolveFavoritePreviewFromFavHtml('<tr>nothing</tr>', 42)).toBeNull();
  });
});

