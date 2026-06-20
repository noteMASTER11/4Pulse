import { createMessageRouter } from '../../core/messages/router.js';

export function createRadioMessageRouter({
  getState,
  play,
  pause,
  setVolume,
  setEnabled,
  setSleepTimer,
  getHistory,
  clearHistory,
}) {
  return createMessageRouter({
    radio_get_state: () => getState(),
    radio_play: async message => {
      await play(message.station, message.stationName);
      return getState();
    },
    radio_pause: async () => {
      await pause();
      return getState();
    },
    radio_set_volume: async message => {
      await setVolume(message.volume);
      return { ok: true };
    },
    radio_set_enabled: async message => {
      await setEnabled(Boolean(message.enabled));
      return { ok: true };
    },
    radio_set_sleep_timer: message => {
      setSleepTimer(message.minutes);
      return getState();
    },
    radio_get_history: () => getHistory(),
    radio_clear_history: async () => {
      await clearHistory();
      return { ok: true };
    },
  });
}

