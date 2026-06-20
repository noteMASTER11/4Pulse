import { createMessageRouter } from '../../core/messages/router.js';
import { normalizeSmileyCatalog } from './catalog.js';

export function createSmileyMessageRouter({ saveCatalog, now = Date.now }) {
  return createMessageRouter({
    pda_smileys_capture: async message => {
      const items = normalizeSmileyCatalog(message.items);
      if (items.length < 20) return { ok: false, captured: items.length };

      await saveCatalog({
        ts: now(),
        items,
        source_url: String(message.source_url || ''),
        captured_count: items.length,
      });
      return { ok: true, captured: items.length };
    },
  });
}

