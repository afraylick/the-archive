import fs from 'fs';
import path from 'path';
import { ensureDir, getDataFilePath, getStorageRoot } from './storage';

const LEGACY_INSTRUMENTS = ['E. Guitar', 'Keys', 'Vocal', 'Synth', 'Acoustic', 'Bass', 'Drums', 'Drum Machine', 'Uku'];
const LEGACY_VIBES = ['ambient', 'rock', 'indie', 'acoustic', 'hard', 'soft', 'country', 'electronic', 'Chill', 'Gainy', 'Spacey', 'Beats', 'Group Jam'];
const CLEAN_INSTRUMENTS = ['Guitar', 'Vocals', 'Bass', 'Drums', 'Synth'];

export interface ArchiveSettings {
  version: 1;
  legacyDefaults: boolean;
  defaultInstruments: string[];
  defaultVibes: string[];
}

const getSettingsFile = () => path.join(getStorageRoot(), 'archive-settings.json');

const cleanStringArray = (value: unknown) => Array.isArray(value)
  ? Array.from(new Set(value.map(item => String(item).trim()).filter(Boolean)))
  : [];

const createInitialSettings = (): ArchiveSettings => {
  const legacyDefaults = fs.existsSync(getDataFilePath());
  return {
    version: 1,
    legacyDefaults,
    defaultInstruments: legacyDefaults ? LEGACY_INSTRUMENTS : CLEAN_INSTRUMENTS,
    defaultVibes: legacyDefaults ? LEGACY_VIBES : [],
  };
};

export const getArchiveSettings = (): ArchiveSettings => {
  const settingsFile = getSettingsFile();

  try {
    if (fs.existsSync(settingsFile)) {
      const stored = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Partial<ArchiveSettings>;
      return {
        version: 1,
        legacyDefaults: Boolean(stored.legacyDefaults),
        defaultInstruments: cleanStringArray(stored.defaultInstruments),
        defaultVibes: cleanStringArray(stored.defaultVibes),
      };
    }
  } catch {
    // Replace an unreadable settings file with safe defaults for this installation.
  }

  const settings = createInitialSettings();
  ensureDir(getStorageRoot());
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  return settings;
};
