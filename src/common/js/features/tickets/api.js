const WIN1251_EXTRA = [
  0x20AC, 0, 0x201A, 0x192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x2C6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17D, 0,
  0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x2DC, 0x2122, 0x161, 0x203A, 0x153, 0, 0x17E, 0x178,
  0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
  0xA8, 0xA9, 0xAA, 0xAB, 0xAC, 0xAD, 0xAE, 0xAF,
  0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7,
  0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF,
];

function createWin1251Map() {
  const map = new Map();
  for (let index = 0; index < 128; index++) map.set(index, index);
  for (let index = 0; index < 64; index++) map.set(0x0410 + index, 0xC0 + index);
  map.set(0x0401, 0xA8);
  map.set(0x0451, 0xB8);
  WIN1251_EXTRA.forEach((codePoint, index) => {
    if (codePoint) map.set(codePoint, 0x80 + index);
  });
  return map;
}

const WIN1251_MAP = createWin1251Map();

export function encodeWin1251FormField(value) {
  return Array.from(String(value || ''), character => {
    const byte = WIN1251_MAP.get(character.codePointAt(0)) ?? 0x3F;
    return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

export function buildTicketCommentBody(ticketId, comment) {
  return [
    'tact=add',
    `t_id=${encodeURIComponent(String(ticketId))}`,
    `m_comment=${encodeWin1251FormField(comment)}`,
    `confirm=${encodeWin1251FormField('Написал хорошо, можно публиковать')}`,
  ].join('&');
}

function cleanHtmlText(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

export function parseTicketThreadDetails(html, ticketId) {
  const source = String(html || '');
  const curatorMatch = source.match(/<strong>[^<]*Куратор[^<]*<\/strong>\s*<a[^>]*>([^<]+)<\/a>/i);
  const topicMatch = source.match(/<strong>[^<]*Тема[^<]*<\/strong>\s*<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
  const moderatorMatch = source.match(new RegExp(`id="t-mod-${ticketId}"[^>]*>([\\s\\S]*?)<\\/div>`, 'i'));

  return {
    curator: curatorMatch ? cleanHtmlText(curatorMatch[1]) : '',
    responsible: moderatorMatch
      ? moderatorMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/[–-]/g, '').trim()
      : '',
    topicTitle: topicMatch ? cleanHtmlText(topicMatch[2]) : '',
    topicUrl: topicMatch ? topicMatch[1].replace(/&amp;/g, '&') : '',
  };
}

