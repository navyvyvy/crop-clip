import { DEFAULT_RECORDING_STATE, DEFAULT_SETTINGS, type AppState, type RecordingState, type Settings } from "./types.js";
import { normalizeSettings, normalizeRegion, normalizeRegions, normalizeRecordingState } from "./normalize.js";

const STORAGE_KEYS = {
  settings: "settings",
  region: "region",
  regions: "regions",
  recordingState: "recordingState",
} as const;

export async function loadAppState(): Promise<AppState> {
  const stored = await chrome.storage.local.get({
    [STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
    [STORAGE_KEYS.region]: null,
    [STORAGE_KEYS.regions]: [],
    [STORAGE_KEYS.recordingState]: DEFAULT_RECORDING_STATE,
  });
  const region = normalizeRegion(stored[STORAGE_KEYS.region]);

  return {
    settings: normalizeSettings(stored[STORAGE_KEYS.settings]),
    region,
    regions: normalizeRegions(stored[STORAGE_KEYS.regions], region),
    recordingState: normalizeRecordingState(stored[STORAGE_KEYS.recordingState] as Partial<RecordingState> | undefined),
  };
}

export async function loadRecordingState(): Promise<RecordingState> {
  const state = await loadAppState();
  return state.recordingState;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: normalizeSettings(settings) });
}

export async function saveRecordingState(recordingState: RecordingState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.recordingState]: normalizeRecordingState(recordingState) });
}
