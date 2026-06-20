export const ALARM_NAMES = Object.freeze({
  periodicUpdate: 'periodicUpdate',
  radioKeepalive: 'radioKeepalive',
  ticketQuickPoll: 'ticketQuickPoll',
  icyPoll: 'icyPoll',
  priorityBlink: 'priorityBlink',
  silentDoctor: '4pulse_silent_doctor',
  wsKeepalive: '4pulse_ws_keepalive',
});

export function calculatePollingSchedule({
  state,
  now = Date.now(),
  wsConnected,
  intervalSeconds,
  wsFallbackMinutes = 15,
  random = Math.random,
}) {
  let multiplier = state.backoff_multiplier || 1;
  const recentlyLimited = Boolean(
    state.is_429_active ||
    (state.last_429_time && now - state.last_429_time < 15 * 60 * 1000)
  );
  if (recentlyLimited) multiplier = Math.max(multiplier, 5);

  let periodInMinutes;
  if (wsConnected) {
    periodInMinutes = wsFallbackMinutes;
  } else {
    const baseInterval = Math.max(intervalSeconds / 60, 1);
    const backoffInterval = baseInterval * multiplier;
    const jitter = backoffInterval * 0.2 * (random() * 2 - 1);
    periodInMinutes = Math.max(backoffInterval + jitter, 1);
  }

  const delayInMinutes = state.backoff_until > now
    ? Math.max((state.backoff_until - now) / 60000, 1)
    : 0.17;

  return { delayInMinutes, periodInMinutes, multiplier, recentlyLimited };
}

export function shouldEnableTicketQuickPoll(state) {
  return Boolean(state.tickets_enabled && state.tickets_unlocked);
}

export function createAlarmDispatcher(routes, onError) {
  return function dispatchAlarm(alarm) {
    const handler = routes[alarm?.name];
    if (!handler) return false;
    Promise.resolve().then(() => handler(alarm)).catch(error => onError?.(error, alarm));
    return true;
  };
}

export function createBackgroundAlarmHandler({
  queryIdle,
  update,
  applyBlinkPhase,
  loadTicketState,
  syncTicketQuickPoll,
  updateTickets,
  updateAction,
  runDoctor,
  isWsConnected,
  pollRadioMetadata,
  keepRadioAlive,
  random = Math.random,
  onError,
}) {
  return createAlarmDispatcher({
    [ALARM_NAMES.periodicUpdate]: async () => {
      const state = await queryIdle(300);
      if (state === 'locked' || (state === 'idle' && random() > 0.33)) return;
      await update(false);
    },
    [ALARM_NAMES.priorityBlink]: () => applyBlinkPhase(),
    [ALARM_NAMES.ticketQuickPoll]: async () => {
      const state = await queryIdle(120);
      if (state === 'locked') return;
      const ticketState = await loadTicketState();
      if (!shouldEnableTicketQuickPoll(ticketState)) {
        await syncTicketQuickPoll();
        return;
      }
      await updateTickets(false);
      updateAction();
    },
    [ALARM_NAMES.silentDoctor]: () => runDoctor(true),
    [ALARM_NAMES.wsKeepalive]: () => {
      if (!isWsConnected()) return update(false);
      return undefined;
    },
    [ALARM_NAMES.icyPoll]: () => pollRadioMetadata(),
    [ALARM_NAMES.radioKeepalive]: () => keepRadioAlive(),
  }, onError);
}
