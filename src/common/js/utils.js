const PARSE_STRING_REGEXP = /([^\s"']+|"([^"]*)"|'([^']*)')/g;
const PARSE_STRING_QUOTES = /"(.*)"/;

import { fetchText } from './fetcher.js';
const decoder = new TextDecoder('windows-1251');
// Таймаут запроса: 15с — 4PDA иногда отвечает медленно.
// 5000ms давало ложный N/A при временной нагрузке на сервер.
export const FETCH_TIMEOUT = 15000;

export function parse_response(str) {
    if (!str) return null;
    
    const matches = str.match(PARSE_STRING_REGEXP);
    if (!matches) {
        console.warn('parse_response: no matches found for string:', str);
        return null;
    }
    
    return matches.map(p => {
        let pq = p.match(PARSE_STRING_QUOTES);
        if (pq) return decode_special_chars(pq[1]);
        return parseInt(p, 10);
    });
}

/**
 * @param {string} string 
 * @returns {string} 
 */
function decode_special_chars(string) {
    return string.replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(x?)([0-9A-Fa-f]+);/g, function(match, isHex, num) {
            return String.fromCodePoint(
                parseInt(num, isHex ? 16 : 10)
            );
        });
}

/**
 * Кодирует строку в Windows-1251 percent-encoding для передачи в URL.
 * Стандартный encodeURIComponent использует UTF-8, а 4PDA ожидает Win1251.
 */
export function encodeWin1251(str) {
    const encoder = new TextEncoder(); // UTF-8
    // Таблица Win1251: позиции 128-255
    const win1251 = [
        0x82,0x83,0x84,0x85,0x86,0x87,0x00,0x89,0x8A,0x8B,0x8C,0x00,0x8E,0x00,
        0x00,0x91,0x92,0x93,0x94,0x95,0x96,0x97,0x00,0x99,0x9A,0x9B,0x9C,0x00,0x9E,0x9F,
        0xA0,0xA1,0xA2,0xA3,0xA4,0xA5,0xA6,0xA7,0xA8,0xA9,0xAA,0xAB,0xAC,0xAD,0xAE,0xAF,
        0xB0,0xB1,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7,0xB8,0xB9,0xBA,0xBB,0xBC,0xBD,0xBE,0xBF,
        0xC0,0xC1,0xC2,0xC3,0xC4,0xC5,0xC6,0xC7,0xC8,0xC9,0xCA,0xCB,0xCC,0xCD,0xCE,0xCF,
        0xD0,0xD1,0xD2,0xD3,0xD4,0xD5,0xD6,0xD7,0xD8,0xD9,0xDA,0xDB,0xDC,0xDD,0xDE,0xDF,
        0xE0,0xE1,0xE2,0xE3,0xE4,0xE5,0xE6,0xE7,0xE8,0xE9,0xEA,0xEB,0xEC,0xED,0xEE,0xEF,
        0xF0,0xF1,0xF2,0xF3,0xF4,0xF5,0xF6,0xF7,0xF8,0xF9,0xFA,0xFB,0xFC,0xFD,0xFE,0xFF,
    ];
    // Строим обратную таблицу: unicode codepoint → win1251 byte
    const toWin1251 = new Map();
    // ASCII 0-127: совпадают
    for (let i = 0; i < 128; i++) toWin1251.set(i, i);
    // Кириллица А-я (U+0410–U+044F) → 0xC0–0xFF
    for (let i = 0; i < 64; i++) toWin1251.set(0x0410 + i, 0xC0 + i);
    // Ё/ё
    toWin1251.set(0x0401, 0xA8); toWin1251.set(0x0451, 0xB8);

    let result = '';
    for (const ch of str) {
        const cp = ch.codePointAt(0);
        if (toWin1251.has(cp)) {
            const byte = toWin1251.get(cp);
            if (byte < 128) {
                result += encodeURIComponent(ch);
            } else {
                result += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
            }
        } else {
            result += encodeURIComponent(ch);
        }
    }
    return result;
}

export async function fetch4(url, options = {}) {
    return fetchText(url, {
        method: 'GET',
        credentials: 'include',   // отправляем куки сессии 4PDA (pass_hash, member_id)
        mode: 'cors',             // явно для Firefox MV3 service worker
        cache: 'reload',
        timeout: FETCH_TIMEOUT,
        retries: 3,
        headers: {
            'Content-Type': 'text/plain; charset=windows-1251',
            'Referer': 'https://4pda.to/forum/',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ...(options.headers || {}),
        },
        ...options,
    }, 'windows-1251');
}


const pad = (num, size = 2) => String(num).padStart(size, '0');
export function getLogDatetime() {
    // YYYY-MM-DDTHH:mm:ss.sssZ
    let date = new Date();
    return (
        pad(date.getHours()) + ':' +
        pad(date.getMinutes()) + ':' +
        pad(date.getSeconds()) + ',' +
        pad(date.getMilliseconds(), 3)
    );
}