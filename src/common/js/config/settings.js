/**
 * Shared mutable runtime settings.
 *
 * Keep the object identity stable: storage synchronization mutates properties
 * and every feature module observes the same state without importing CS.
 */
export const SETTINGS = {};

export function initializeSettingsDefaults(defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in SETTINGS)) SETTINGS[key] = value;
  }
  return SETTINGS;
}

