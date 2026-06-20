const SPECIAL_CODES = new Set([':)', ';)', ':P', ':-D']);

export function normalizeSmileyCatalog(input) {
  const incoming = Array.isArray(input) ? input : [];
  const seen = new Set();
  const result = [];

  for (const item of incoming) {
    const code = String(item?.code || '').trim();
    const src = String(item?.src || '').trim();
    const validCode = /^:[^\s]{1,80}:$/.test(code) || SPECIAL_CODES.has(code);
    if (!code || !src || seen.has(code) || !validCode || !/^https?:\/\//i.test(src)) continue;
    seen.add(code);
    result.push({
      code,
      src,
      title: String(item.title || item.code || '').trim(),
      alt: String(item.alt || item.code || '').trim(),
    });
  }

  return result;
}

