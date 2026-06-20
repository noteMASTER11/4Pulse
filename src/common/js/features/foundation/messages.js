import { createMessageRouter } from '../../core/messages/router.js';

export function createFoundationMessageRouter({
  applyProfile,
  createBackup,
  restoreLatestBackup,
  runDoctor,
  clearEventLog,
  runSelfHeal,
  getDiagnosticsSnapshot,
  setSmartSilence,
  clearSmartSilence,
  getAttentionSnapshot,
}) {
  return createMessageRouter({
    foundation_apply_profile: message => applyProfile(message.profile),
    foundation_create_backup: message => createBackup(Boolean(message.manual)),
    foundation_restore_latest_backup: () => restoreLatestBackup(),
    foundation_run_doctor: () => runDoctor(false),
    diagnostics_clear_log: async () => (await clearEventLog()) || { ok: true },
    diagnostics_self_heal: () => runSelfHeal(),
    diagnostics_snapshot: () => getDiagnosticsSnapshot(),
    smart_silence_set: message => setSmartSilence(message.minutes || 30, message.mode || 'focus'),
    smart_silence_clear: () => clearSmartSilence(),
    attention_snapshot: () => ({ ok: true, ...getAttentionSnapshot() }),
  });
}

