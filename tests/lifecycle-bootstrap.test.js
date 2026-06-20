import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INACTIVE_ICON_PATH,
  registerBackgroundLifecycle,
  setInactiveActionIcon,
} from '../src/common/js/features/lifecycle/bootstrap.js';

function createRuntimeEvents() {
  const listeners = { installed: null, startup: null };
  return {
    listeners,
    runtime: {
      onInstalled: { addListener: handler => { listeners.installed = handler; } },
      onStartup: { addListener: handler => { listeners.startup = handler; } },
    },
  };
}

function createLifecycleDeps(overrides = {}) {
  const calls = [];
  const { runtime, listeners } = createRuntimeEvents();
  return {
    calls,
    listeners,
    deps: {
      runtime,
      action: { setIcon: args => calls.push(['setIcon', args]) },
      storage: { get: async keys => { calls.push(['storage.get', keys]); return {}; } },
      loadRadioState: async () => calls.push(['loadRadioState']),
      getRadioState: () => ({ enabled: false, isPlaying: false, station: '' }),
      radioPlay: () => calls.push(['radioPlay']),
      restorePriorityBlink: () => calls.push(['restorePriorityBlink']),
      registerWsKeepAlive: () => calls.push(['registerWsKeepAlive']),
      createContextMenus: () => calls.push(['createContextMenus']),
      ensureSilentDoctorAlarm: async () => calls.push(['ensureSilentDoctorAlarm']),
      initializeAlarm: async () => calls.push(['initializeAlarm']),
      syncTicketQuickPollAlarm: () => calls.push(['syncTicketQuickPollAlarm']),
      foundationRunDoctor: async auto => calls.push(['foundationRunDoctor', auto]),
      syncSettingsFromStorage: async () => calls.push(['syncSettingsFromStorage']),
      ...overrides,
    },
  };
}

describe('background lifecycle bootstrap', () => {
  it('sets the inactive icon through the action API', () => {
    const calls = [];
    setInactiveActionIcon({ setIcon: args => calls.push(args) });
    expect(calls).toEqual([{ path: DEFAULT_INACTIVE_ICON_PATH }]);
  });

  it('wires install bootstrap actions', async () => {
    const { deps, listeners, calls } = createLifecycleDeps();
    registerBackgroundLifecycle(deps);

    await listeners.installed();

    expect(calls.map(call => call[0])).toEqual([
      'loadRadioState',
      'registerWsKeepAlive',
      'setIcon',
      'createContextMenus',
      'ensureSilentDoctorAlarm',
      'initializeAlarm',
      'syncTicketQuickPollAlarm',
      'foundationRunDoctor',
    ]);
  });

  it('restores radio and blink state on startup', async () => {
    const { deps, listeners, calls } = createLifecycleDeps({
      getRadioState: () => ({ enabled: true, isPlaying: true, station: 'https://radio.test/live' }),
    });
    registerBackgroundLifecycle(deps);

    await listeners.startup();

    expect(calls.map(call => call[0])).toEqual([
      'syncSettingsFromStorage',
      'loadRadioState',
      'radioPlay',
      'restorePriorityBlink',
      'registerWsKeepAlive',
      'setIcon',
      'createContextMenus',
      'storage.get',
      'ensureSilentDoctorAlarm',
      'initializeAlarm',
      'syncTicketQuickPollAlarm',
      'foundationRunDoctor',
    ]);
  });
});
