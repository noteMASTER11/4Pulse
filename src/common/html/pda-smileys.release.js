/* 4Pulse — native 4PDA smileys picker */
(() => {
  'use strict';

  const CACHE_KEY = '4pulse_pda_smileys_v4';
  const EXT_CACHE_KEY = 'pda_smileys_catalog_v1';
  const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
  const pickerState = new WeakMap();
  const activePickers = new Set();
  let loadPromise = null;

  function safeParseJson(value) {
    if (!value) return null;
    const raw = String(value)
      .replace(/&quot;/gi, '"')
      .replace(/&#34;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, '&');
    try { return JSON.parse(raw); } catch (_) { return null; }
  }

  function normalizeSrc(src) {
    if (!src) return '';
    try {
      const clean = String(src).trim();
      if (!clean) return '';
      if (clean.startsWith('//')) return `https:${clean}`;
      return new URL(clean, 'https://4pda.to').href;
    } catch (_) {
      return String(src || '');
    }
  }

  function normalizeCodeFromParts(optionsValue, altValue, titleValue) {
    const options = safeParseJson(optionsValue);
    const fromOptions = options && typeof options.after === 'string' ? options.after.trim() : '';
    const raw = fromOptions || String(altValue || '').trim() || String(titleValue || '').trim();
    return raw;
  }

  function normalizeCode(img) {
    return normalizeCodeFromParts(
      img.getAttribute('data-options'),
      img.getAttribute('alt'),
      img.getAttribute('title')
    );
  }

  function acceptCode(code) {
    // 4PDA uses both :named_tokens: and a few legacy ASCII smileys.
    const clean = String(code || '').trim();
    return !!clean && (/^:[^\s]{1,80}:$/.test(clean) || clean === ':)' || clean === ';)' || clean === ':P' || clean === ':-D');
  }

  function dedupeSmileys(items) {
    const seen = new Set();
    return (items || []).filter((item) => {
      const code = String(item?.code || '').trim();
      const src = normalizeSrc(item?.src);
      if (!acceptCode(code) || !src || seen.has(code)) return false;
      seen.add(code);
      item.code = code;
      item.src = src;
      item.title = String(item.title || code).trim() || code;
      item.alt = String(item.alt || code).trim() || code;
      return true;
    });
  }

  function extractSmileysFromDom(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const out = [];
    doc.querySelectorAll('img.ed-emo-normal, img[data-toggle="bb"][data-options]').forEach((img) => {
      const code = normalizeCode(img);
      const src = normalizeSrc(img.getAttribute('src'));
      if (!acceptCode(code) || !src) return;
      out.push({
        code,
        src,
        title: (img.getAttribute('title') || code).trim() || code,
        alt: (img.getAttribute('alt') || code).trim() || code
      });
    });
    return dedupeSmileys(out);
  }

  function getAttr(tag, name) {
    const rx = new RegExp(`${name}\\s*=\\s*(?:"([\\s\\S]*?)"|'([\\s\\S]*?)'|([^\\s>]+))`, 'i');
    const match = String(tag || '').match(rx);
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
  }

  function extractSmileysByRegex(html) {
    const out = [];
    const source = String(html || '');
    const imgRx = /<img\b[^>]*>/gi;
    let match;
    while ((match = imgRx.exec(source))) {
      const tag = match[0];
      const cls = getAttr(tag, 'class');
      const dataToggle = getAttr(tag, 'data-toggle');
      const dataOptions = getAttr(tag, 'data-options');
      if (!/\bed-emo-normal\b/i.test(cls) && !(dataToggle === 'bb' && dataOptions)) continue;
      const code = normalizeCodeFromParts(dataOptions, getAttr(tag, 'alt'), getAttr(tag, 'title'));
      const src = normalizeSrc(getAttr(tag, 'src'));
      if (!acceptCode(code) || !src) continue;
      out.push({
        code,
        src,
        title: String(getAttr(tag, 'title') || code).trim() || code,
        alt: String(getAttr(tag, 'alt') || code).trim() || code
      });
    }
    return dedupeSmileys(out);
  }

  function extractSmileys(html) {
    const domItems = extractSmileysFromDom(html);
    if (domItems.length) return domItems;
    return extractSmileysByRegex(html);
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) return null;
      if (!parsed.ts || Date.now() - parsed.ts > CACHE_TTL) return null;
      return dedupeSmileys(parsed.items);
    } catch (_) {
      return null;
    }
  }

  async function readExtensionCache() {
    try {
      const stored = await chrome.storage.local.get([EXT_CACHE_KEY]);
      const parsed = stored?.[EXT_CACHE_KEY];
      if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) return null;
      if (!parsed.ts || Date.now() - parsed.ts > CACHE_TTL) return null;
      return dedupeSmileys(parsed.items);
    } catch (_) {
      return null;
    }
  }

  async function writeExtensionCache(items) {
    const clean = dedupeSmileys(items);
    if (!clean.length) return;
    try {
      await chrome.storage.local.set({ [EXT_CACHE_KEY]: { ts: Date.now(), items: clean } });
    } catch (_) {}
  }

  function writeCache(items) {
    const clean = dedupeSmileys(items);
    if (!clean.length) return;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), items: clean }));
    } catch (_) {}
  }

  function primeFromHtml(html) {
    if (!html) return [];
    const items = extractSmileys(html);
    if (items.length) {
      writeCache(items);
      writeExtensionCache(items);
    }
    return items;
  }


  async function fetchSmileys() {
    // Native 4PDA smileys are rendered client-side on the live forum/QMS page.
    // Raw page fetches do not contain the catalogue and only slow the popup/sidebar down.
    const extCached = await readExtensionCache();
    if (extCached?.length) {
      writeCache(extCached);
      return extCached;
    }
    const cached = readCache();
    if (cached?.length) return cached;
    return [];
  }

  function insertAtCursor(textarea, text) {
    if (!textarea || !text) return;
    const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : textarea.value.length;
    const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    textarea.value = `${before}${text}${after}`;
    const nextPos = start + text.length;
    textarea.selectionStart = textarea.selectionEnd = nextPos;
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function renderMessage(picker, text, extraClass = '') {
    picker.replaceChildren();
    const note = document.createElement('div');
    note.className = `qms-pda-smileys-note ${extraClass}`.trim();
    note.textContent = text;
    picker.appendChild(note);
  }

  function renderSmileys(picker, textarea, items) {
    picker.replaceChildren();
    picker.classList.add('qms-pda-smileys-picker');
    if (!items.length) {
      renderMessage(picker, 'Каталог смайлов 4PDA ещё не захвачен. Откройте родной QMS/редактор 4PDA и разверните смайлы один раз.');
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'qms-emoji-item qms-pda-smiley-item';
      button.title = item.code;
      button.setAttribute('aria-label', item.code);

      const img = document.createElement('img');
      img.className = 'qms-pda-smiley-img';
      img.src = item.src;
      img.alt = item.alt || item.code;
      img.loading = 'lazy';
      img.decoding = 'async';

      button.appendChild(img);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        insertAtCursor(textarea, item.code);
      });
      fragment.appendChild(button);
    });
    picker.appendChild(fragment);
  }

  async function ensureRendered(picker, textarea) {
    const current = pickerState.get(picker);
    if (current && current.rendered && current.count > 0) return;

    renderMessage(picker, 'Загрузка смайлов 4PDA…', 'is-loading');
    const items = await fetchSmileys();
    renderSmileys(picker, textarea, items);
    const prevState = pickerState.get(picker) || {};
    pickerState.set(picker, { ...prevState, rendered: true, count: items.length, textarea });
  }

  function initPicker(picker, textarea) {
    if (!picker || !textarea) return;
    picker.classList.add('qms-pda-smileys-picker');
    pickerState.set(picker, { rendered: false, count: 0, textarea });
    activePickers.add(picker);
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildInlineSmileyMatcher(items) {
    const smileys = dedupeSmileys(items);
    if (!smileys.length) return null;
    const byCode = new Map(smileys.map((item) => [item.code, item]));
    const codes = [...byCode.keys()].sort((a, b) => b.length - a.length);
    if (!codes.length) return null;
    return {
      byCode,
      regex: new RegExp(codes.map(escapeRegExp).join('|'), 'g')
    };
  }

  function shouldSkipInlineNode(node) {
    const parent = node?.parentElement;
    if (!parent) return true;
    if (parent.closest('script, style, textarea, input, code, pre, .qms-inline-pda-smiley')) return true;
    return false;
  }

  function replaceSmileysInTextNode(node, matcher) {
    const value = String(node?.nodeValue || '');
    if (!value || !matcher?.regex) return 0;
    const regex = matcher.regex;
    regex.lastIndex = 0;
    if (!regex.test(value)) return 0;
    regex.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let replaced = 0;
    let match;
    while ((match = regex.exec(value))) {
      const code = match[0];
      const item = matcher.byCode.get(code);
      if (!item) continue;
      if (match.index > cursor) fragment.appendChild(document.createTextNode(value.slice(cursor, match.index)));
      const img = document.createElement('img');
      img.className = 'qms-inline-pda-smiley';
      img.src = item.src;
      img.alt = item.alt || code;
      img.title = item.title || code;
      img.loading = 'lazy';
      img.decoding = 'async';
      fragment.appendChild(img);
      cursor = match.index + code.length;
      replaced += 1;
    }
    if (!replaced) return 0;
    if (cursor < value.length) fragment.appendChild(document.createTextNode(value.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
    return replaced;
  }

  async function renderInlineSmileys(container) {
    // Message bubbles are rendered off-DOM first in popup/sidebar and appended only after
    // this formatter runs. TreeWalker works perfectly on detached nodes, so requiring
    // isConnected made every inline replacement a no-op.
    if (!container) return 0;
    const items = await fetchSmileys();
    const matcher = buildInlineSmileyMatcher(items);
    if (!matcher) return 0;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (shouldSkipInlineNode(node)) return NodeFilter.FILTER_REJECT;
        const value = String(node.nodeValue || '');
        matcher.regex.lastIndex = 0;
        return matcher.regex.test(value) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let total = 0;
    nodes.forEach((node) => { total += replaceSmileysInTextNode(node, matcher); });
    markSmileyOnlyMessageBubbles(container);
    return total;
  }

  function markSmileyOnlyMessageBubbles(container) {
    if (!container?.querySelectorAll) return;
    container.querySelectorAll('.qms-msg').forEach((bubble) => {
      const hasInlineSmileys = !!bubble.querySelector('.qms-inline-pda-smiley');
      if (!hasInlineSmileys) {
        bubble.classList.remove('qms-msg-smileys-only');
        return;
      }
      const plainText = String(bubble.textContent || '').replace(/ /g, ' ').trim();
      const hasForeignContent = [...bubble.querySelectorAll('*')].some((el) => {
        if (el.classList?.contains('qms-inline-pda-smiley')) return false;
        return !['BR'].includes(el.tagName);
      });
      bubble.classList.toggle('qms-msg-smileys-only', !plainText && !hasForeignContent);
    });
  }

  async function togglePicker(picker, textarea) {
    if (!picker || !textarea) return;
    const willOpen = picker.classList.contains('hidden');
    picker.classList.toggle('hidden');
    if (willOpen) await ensureRendered(picker, textarea);
  }


  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes?.[EXT_CACHE_KEY]?.newValue?.items?.length) return;
      const items = dedupeSmileys(changes[EXT_CACHE_KEY].newValue.items);
      if (!items.length) return;
      writeCache(items);
      activePickers.forEach((picker) => {
        if (!picker || !picker.isConnected || picker.classList.contains('hidden')) return;
        const state = pickerState.get(picker) || {};
        const textarea = state.textarea;
        if (!textarea) return;
        renderSmileys(picker, textarea, items);
        pickerState.set(picker, { ...state, rendered: true, count: items.length, textarea });
      });
    });
  } catch (_) {}

  window.PdaSmileys = {
    initPicker,
    togglePicker,
    insertAtCursor,
    primeFromHtml,
    extractSmileys,
    renderInlineSmileys,
    refresh: async () => {
      try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
      return fetchSmileys();
    }
  };
})();
