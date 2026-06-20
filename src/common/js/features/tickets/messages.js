import { createMessageRouter } from '../../core/messages/router.js';
import { buildTicketCommentBody, parseTicketThreadDetails } from './api.js';

const TICKET_THREAD_URL = 'https://4pda.to/forum/index.php?act=ticket&s=thread&';

export function createTicketMessageRouter({
  tickets,
  updateAction,
  fetchWithRetry,
  fetchText,
}) {
  const safely = async (command, fallback) => {
    try {
      return await command();
    } catch {
      return fallback;
    }
  };

  return createMessageRouter({
    open_ticket: message => safely(async () => {
      await tickets.open(message.id, Boolean(message.sidebar));
      return { ok: true, count: tickets.count };
    }, { ok: false }),
    open_ticket_source: message => safely(async () => {
      await tickets.openSource(message.id, Boolean(message.sidebar));
      return { ok: true, count: tickets.count };
    }, { ok: false }),
    ticket_change_status: message => safely(async () => {
      const ok = await tickets.changeStatus(message.id, message.status);
      if (ok) updateAction();
      return { ok, count: tickets.count };
    }, { ok: false }),
    ticket_mark_viewed: message => safely(async () => {
      await tickets.markAsViewed(message.id);
      updateAction();
      return { ok: true };
    }, { ok: false }),
    ticket_add_comment: message => safely(async () => {
      if (!message.id || !message.comment) return { ok: false };
      const response = await fetchWithRetry(TICKET_THREAD_URL, {
        method: 'POST',
        credentials: 'include',
        referrerPolicy: 'no-referrer-when-downgrade',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=windows-1251' },
        body: buildTicketCommentBody(message.id, message.comment),
      });
      return { ok: response.ok };
    }, { ok: false }),
    ticket_fetch_curator: message => safely(async () => {
      if (!message.id) return { ok: false };
      const html = await fetchText(`${TICKET_THREAD_URL}t_id=${message.id}`, {
        credentials: 'include',
        referrerPolicy: 'no-referrer-when-downgrade',
      }, 'windows-1251');
      return { ok: true, ...parseTicketThreadDetails(html, message.id) };
    }, { ok: false }),
    ticket_nav_count: message => safely(async () => {
      const count = Number(message.count);
      if (!Number.isFinite(count) || count < 0) return { ok: false };
      const ok = await tickets.applyPageSnapshot({ totalUnprocessed: count, tickets: [] });
      if (ok) updateAction();
      return { ok, count: tickets.count };
    }, { ok: false }),
    ticket_page_snapshot: message => safely(async () => {
      const ok = await tickets.applyPageSnapshot(message.snapshot || {});
      if (ok) updateAction();
      return { ok, count: tickets.count, list: tickets.list };
    }, { ok: false }),
    tickets_refresh: () => safely(async () => {
      await tickets.update(true);
      updateAction();
      return { count: tickets.count, list: tickets.list };
    }, { count: 0, list: [] }),
  });
}

