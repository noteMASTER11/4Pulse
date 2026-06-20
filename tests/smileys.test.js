import { describe, expect, it, vi } from 'vitest';
import { normalizeSmileyCatalog } from '../src/common/js/features/smileys/catalog.js';
import { createSmileyMessageRouter } from '../src/common/js/features/smileys/messages.js';

describe('smiley catalog', () => {
  it('filters invalid and duplicate entries', () => {
    expect(normalizeSmileyCatalog([
      { code: ':ok:', src: 'https://example.test/ok.png' },
      { code: ':ok:', src: 'https://example.test/duplicate.png' },
      { code: 'invalid', src: 'https://example.test/no.png' },
      { code: ':bad:', src: 'data:image/png;base64,xxx' },
    ])).toEqual([{ code: ':ok:', src: 'https://example.test/ok.png', title: ':ok:', alt: ':ok:' }]);
  });

  it('stores catalogs only after the minimum useful size', async () => {
    const saveCatalog = vi.fn();
    const route = createSmileyMessageRouter({ saveCatalog, now: () => 123 });
    const items = Array.from({ length: 20 }, (_, index) => ({
      code: `:s${index}:`, src: `https://example.test/${index}.png`,
    }));
    const response = await new Promise(resolve => route({ action: 'pda_smileys_capture', items }, resolve));
    expect(response).toEqual({ ok: true, captured: 20 });
    expect(saveCatalog).toHaveBeenCalledWith(expect.objectContaining({ ts: 123, captured_count: 20 }));
  });
});

