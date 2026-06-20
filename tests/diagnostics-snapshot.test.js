import { describe, expect, it } from 'vitest';
import {
  collectAlarmIntegrity,
  collectStorageIntegrity,
  createDiagnosticsSnapshotService,
} from '../src/common/js/features/diagnostics/snapshot.js';

describe('diagnostics snapshot service', () => {
  it('reports invalid storage shapes and stale keys', async () => {
    const storage = {
      async get() {
        return {
          bm_cache: {},
          qms_cache: [],
          old_debug_value: true,
        };
      },
      async getBytesInUse() {
        return 5 * 1024 * 1024;
      },
    };

    const result = await collectStorageIntegrity({ storage });

    expect(result.ok).toBe(false);
    expect(result.issues).toContain('bm_cache: invalid array');
    expect(result.issues).toContain('storage quota warning');
    expect(result.staleKeys).toEqual(['old_debug_value']);
  });

  it('reports expired alarms', async () => {
    const result = await collectAlarmIntegrity({
      alarms: {
        async getAll() {
          return [{ name: 'periodic', scheduledTime: 1_000 }];
        },
      },
    }, 120_000);

    expect(result.ok).toBe(false);
    expect(result.expired).toEqual(['periodic']);
  });

  it('builds popup envelope with compact health data', () => {
    const bg = {
      wsConnected: false,
      popup_data: {
        qms: { list: [] },
        mentions: { list: [] },
        favorites: { list: [] },
        bookmarks: { list: [] },
      },
    };
    const service = createDiagnosticsSnapshotService({
      bg,
      getUpdateHealth: () => ({
        lastUpdateOk: false,
        lastUpdateFinishedAt: 100,
      }),
    });

    const envelope = service.buildPopupEnvelope();

    expect(envelope.health_compact).toEqual({
      wsConnected: false,
      lastUpdateOk: false,
      lastUpdateFinishedAt: 100,
      issues: ['WebSocket offline', 'Последнее обновление с ошибкой'],
    });
    expect(envelope.attention).toBeTruthy();
    expect(envelope.morning_digest).toBeTruthy();
    expect(envelope.favorites_cleanup).toBeTruthy();
  });
});
