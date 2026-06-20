import { describe, expect, it } from 'vitest';
import {
  canFetchRadioMetadata,
  canPollIcyMetadata,
  isRadioRecordStream,
  matchRadioRecordStation,
  normalizeRadioRecordImage,
  normalizeRadioUrl,
} from '../src/common/js/features/radio/metadata.js';

const stations = [
  {
    id: 1,
    prefix: 'rock',
    title: 'Record Rock',
    stream_128: 'https://example.host/rr_rock_128.aacp?token=1',
  },
  {
    id: 2,
    prefix: 'chill',
    title: 'Record Chill-Out',
    stream_128: 'https://example.host/rr_chill_128.aacp',
  },
];

describe('radio metadata helpers', () => {
  it('normalizes stream URLs for matching', () => {
    expect(normalizeRadioUrl('HTTPS://WWW.Example.test/live/?token=1')).toBe('example.test/live');
  });

  it('recognizes Radio Record streams', () => {
    expect(isRadioRecordStream('https://hostingradio.ru/rr_rock128.aacp')).toBe(true);
    expect(isRadioRecordStream('https://example.test/live.mp3')).toBe(false);
  });

  it('keeps ICY polling opt-in by host', () => {
    expect(canPollIcyMetadata('https://radio.example/live')).toBe(false);
    expect(canPollIcyMetadata('https://radio.example/live', ['radio.example'])).toBe(true);
    expect(canFetchRadioMetadata('https://radio.example/live', ['radio.example'])).toBe(true);
  });

  it('normalizes Radio Record artwork URLs', () => {
    expect(normalizeRadioRecordImage('/images/track.jpg')).toBe(
      'https://www.radiorecord.ru/images/track.jpg',
    );
  });

  it('matches stations by URL, prefix and display name', () => {
    expect(matchRadioRecordStation(stations, stations[0].stream_128)?.id).toBe(1);
    expect(matchRadioRecordStation(stations, 'https://other.host/rr_chill128.aacp')?.id).toBe(2);
    expect(matchRadioRecordStation(stations, 'https://other.host/live', 'Радио Record Rock')?.id).toBe(1);
  });
});

