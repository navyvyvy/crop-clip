import { DEFAULT_RECORDING_STATE, DEFAULT_SETTINGS, RECORDING_STATUS, type AppState, type RecordingState, type Settings } from "./types.js";
import { normalizeSettings, normalizeRegion, normalizeRegions, normalizeRecordingState } from "./normalize.js";
import { fail, ok, type MessageResponse, type SettingsPatch } from "./messages.js";

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
    [STORAGE_KEYS.regions]: null,
    [STORAGE_KEYS.recordingState]: DEFAULT_RECORDING_STATE,
  });
  const region = normalizeRegion(stored[STORAGE_KEYS.region]);

  return {
    settings: normalizeSettings(stored[STORAGE_KEYS.settings]),
    region,
    regions: normalizeRegions(stored[STORAGE_KEYS.regions], region),
    recordingState: normalizeRecordingState(stored[STORAGE_KEYS.recordingState]),
  };
}

export async function loadRecordingState(): Promise<RecordingState> {
  const stored = await chrome.storage.local.get({ [STORAGE_KEYS.recordingState]: DEFAULT_RECORDING_STATE });
  return normalizeRecordingState(stored[STORAGE_KEYS.recordingState]);
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get({ [STORAGE_KEYS.settings]: DEFAULT_SETTINGS });
  return normalizeSettings(stored[STORAGE_KEYS.settings]);
}

let pendingSettingsWrite = Promise.resolve();

export function waitForSettingsWrites(): Promise<void> {
  return pendingSettingsWrite;
}

export function updateStoredSettings(patch: SettingsPatch): Promise<MessageResponse> {
  const write = pendingSettingsWrite.then(async () => {
    const [settings, state] = await Promise.all([loadSettings(), loadRecordingState()]);
    if (state.status === RECORDING_STATUS.recording && Object.keys(patch).some(key => key !== "showRecordingSize")) {
      return fail("녹화 중에는 녹화 용량 표시만 변경할 수 있습니다.");
    }
    const shortcutKeys = { ...settings.shortcutKeys, ...patch.shortcutKeys };
    if (patch.shortcutKeys && new Set(Object.values(shortcutKeys)).size !== Object.keys(shortcutKeys).length) {
      return fail("이미 사용 중인 단축키입니다.");
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: normalizeSettings({ ...settings, ...patch, shortcutKeys }) });
    return ok();
  });
  pendingSettingsWrite = write.then(() => {}, () => {});
  return write;
}

export async function saveRecordingState(recordingState: RecordingState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.recordingState]: normalizeRecordingState(recordingState) });
}
