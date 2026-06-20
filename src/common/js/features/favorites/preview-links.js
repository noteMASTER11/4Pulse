export function normalize4pdaForumUrl(url) {
  if (!url) return '';
  const value = String(url).trim().replace(/&amp;/g, '&');
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://4pda.to${value}`;
  if (/^https?:\/\//i.test(value)) return value;
  return `https://4pda.to/forum/${value.replace(/^\.\//, '')}`;
}

export function directPostFromHref(href) {
  const url = normalize4pdaForumUrl(href);
  if (!url) return null;
  const match = url.match(/(?:[?&](?:p|pid)=|#entry)(\d{5,})/i);
  if (!match) return null;
  const postId = match[1];
  return {
    post_id: postId,
    post_url: `https://4pda.to/forum/index.php?act=findpost&pid=${postId}`,
  };
}

export function resolveFavoritePreviewFromFavHtml(html, topicId) {
  const topic = String(topicId || '').replace(/\D+/g, '');
  if (!topic || !html) return null;

  const source = String(html);
  const rows = source.split(/<tr\b/i).map((part, index) => index ? `<tr${part}` : part);
  let row = rows.find(candidate => new RegExp(`showtopic=${topic}(?:\\D|$)`, 'i').test(candidate));

  if (!row) {
    const index = source.search(new RegExp(`showtopic=${topic}(?:\\D|$)`, 'i'));
    if (index < 0) return null;
    row = source.slice(Math.max(0, index - 5000), Math.min(source.length, index + 8000));
  }

  const hrefs = [];
  row.replace(/href=["']([^"']+)["']/gi, (_match, href) => {
    hrefs.push(href.replace(/&amp;/g, '&'));
    return '';
  });

  for (const href of hrefs) {
    if (/view=getnewpost/i.test(href)) continue;
    if (/(?:act=findpost|view=findpost|showpost(?:\.php)?|#entry|[?&]p=|[?&]pid=)/i.test(href)) {
      const direct = directPostFromHref(href);
      if (direct) return direct;
    }
  }

  const match = row.match(/(?:act=findpost[^"'<>]*?pid=|view=findpost[^"'<>]*?[?&]p=|#entry)(\d{5,})/i);
  if (!match) return null;
  return {
    post_id: match[1],
    post_url: `https://4pda.to/forum/index.php?act=findpost&pid=${match[1]}`,
  };
}

