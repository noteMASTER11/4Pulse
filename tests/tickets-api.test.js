import { describe, expect, it } from 'vitest';
import {
  buildTicketCommentBody,
  encodeWin1251FormField,
  parseTicketThreadDetails,
} from '../src/common/js/features/tickets/api.js';

describe('ticket API helpers', () => {
  it('encodes comments as Windows-1251 form bytes', () => {
    expect(encodeWin1251FormField('Тест')).toBe('%D2%E5%F1%F2');
    expect(buildTicketCommentBody(42, 'Ок')).toContain('t_id=42&m_comment=%CE%EA');
  });

  it('parses curator, topic and responsible moderator', () => {
    const html = `
      <strong>Куратор:</strong> <a> Alice &amp; Bob </a>
      <strong>Тема:</strong> <a href="/forum/topic&amp;x=1"> Test topic </a>
      <div id="t-mod-42"><b>– Moderator</b></div>`;
    expect(parseTicketThreadDetails(html, 42)).toEqual({
      curator: 'Alice & Bob',
      responsible: 'Moderator',
      topicTitle: 'Test topic',
      topicUrl: '/forum/topic&x=1',
    });
  });
});

