export function normalizeRadioUrl(url = '') {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function isRadioRecordStream(url = '') {
  const value = String(url || '').toLowerCase();
  return value.includes('radiorecord') || value.includes('hostingradio.ru/rr_') || value.includes('/rr_');
}

export function canPollIcyMetadata(url = '', safeHosts = []) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return new Set(safeHosts.map(value => String(value).toLowerCase())).has(host);
  } catch {
    return false;
  }
}

export function canFetchRadioMetadata(url = '', safeIcyHosts = []) {
  return isRadioRecordStream(url) || canPollIcyMetadata(url, safeIcyHosts);
}

export function normalizeRadioRecordImage(url = '') {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return `https://www.radiorecord.ru${value}`;
  return value;
}

export function matchRadioRecordStation(stations, stationUrl = '', stationName = '') {
  const target = normalizeRadioUrl(stationUrl);
  if (!target || !Array.isArray(stations)) return null;

  const byUrl = stations.find(station => [
    station.stream_64,
    station.stream_128,
    station.stream_320,
    station.stream_hls,
  ].filter(Boolean).some(url => {
    const normalized = normalizeRadioUrl(url);
    return normalized && (
      normalized === target || normalized.includes(target) || target.includes(normalized)
    );
  }));
  if (byUrl) return byUrl;

  const streamMatch = target.match(/rr_([a-z0-9_-]+?)(?:\d+)?\.(?:aacp?|mp3|ogg|m3u8)$/i);
  const prefix = streamMatch?.[1]?.replace(/_$/, '');
  if (prefix) {
    const byPrefix = stations.find(station => (
      String(station.prefix || '').toLowerCase() === prefix.toLowerCase()
    ));
    if (byPrefix) return byPrefix;
  }

  const name = String(stationName || '')
    .toLowerCase()
    .replace(/^.*?радио\s*/i, '')
    .replace(/^radio\s*/i, '')
    .trim();
  if (!name) return null;

  return stations.find(station => {
    const title = String(station.title || '').toLowerCase();
    return title.includes(name) || name.includes(title);
  }) || null;
}
