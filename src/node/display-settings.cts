import type {SettingsStore} from './backup-types.cjs';

export interface DisplaySettings {petEnabled: boolean; showUsageAmount: boolean}

export function createDisplaySettings(store: SettingsStore, changed: () => void) {
  function read(): DisplaySettings {
    const saved = store.read();
    return {petEnabled: saved.petEnabled === true, showUsageAmount: saved.showUsageAmount !== false};
  }
  function set(patch: Partial<DisplaySettings>): DisplaySettings {
    store.update(patch);
    const result = read();
    changed();
    return result;
  }
  return {read, set};
}
