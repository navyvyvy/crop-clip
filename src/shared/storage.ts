import {
  BITRATE_PRESET_VALUES,
  DEFAULT_RECORDING_STATE,
  DEFAULT_SETTINGS,
  type AppState,
  type BitratePreset,
  type RecordingState,
  type RegionSelection,
  type Settings,
} from "./types.js";

const STORAGE_KEYS = {
  settings: "settings",
  region: "region",
  recordingState: "recordingState",
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coerceNumber(value: unknown, fallback: number): number {
  return Number.isFinite(value as number) ? Number(value) : fallback;
}

export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const outputFormat = raw?.outputFormat === "webm" || raw?.outputFormat === "mp4" ? raw.outputFormat : DEFAULT_SETTINGS.outputFormat;
  const hasPreviousDefaultBitrate =
    raw?.bitratePreset === "standard" &&
    coerceNumber(raw.videoBitsPerSecond, BITRATE_PRESET_VALUES.standard) === BITRATE_PRESET_VALUES.standard &&
    coerceNumber(raw.customVideoBitsPerSecond, BITRATE_PRESET_VALUES.standard) === BITRATE_PRESET_VALUES.standard;
  const bitratePreset = hasPreviousDefaultBitrate
    ? DEFAULT_SETTINGS.bitratePreset
    : raw?.bitratePreset === "low" || raw?.bitratePreset === "standard" || raw?.bitratePreset === "high" || raw?.bitratePreset === "veryHigh" || raw?.bitratePreset === "custom"
    ? raw.bitratePreset
    : DEFAULT_SETTINGS.bitratePreset;
  const presetValue = hasPreviousDefaultBitrate
    ? DEFAULT_SETTINGS.videoBitsPerSecond
    : bitratePreset === "custom"
    ? coerceNumber(raw?.customVideoBitsPerSecond ?? raw?.videoBitsPerSecond, DEFAULT_SETTINGS.customVideoBitsPerSecond ?? DEFAULT_SETTINGS.videoBitsPerSecond)
    : BITRATE_PRESET_VALUES[bitratePreset as Exclude<BitratePreset, "custom">];
  const rawVideoBitsPerSecond = hasPreviousDefaultBitrate ? presetValue : raw?.videoBitsPerSecond;
  const rawCustomVideoBitsPerSecond = hasPreviousDefaultBitrate ? presetValue : raw?.customVideoBitsPerSecond;

  return {
    outputFormat,
    bitratePreset,
    videoBitsPerSecond: bitratePreset === "custom"
      ? clamp(Math.round(coerceNumber(rawVideoBitsPerSecond, presetValue)), 100_000, 20_000_000)
      : presetValue,
    customVideoBitsPerSecond: clamp(Math.round(coerceNumber(rawCustomVideoBitsPerSecond ?? presetValue, presetValue)), 100_000, 20_000_000),
    enable60fps: Boolean(raw?.enable60fps),
    targetHeight: DEFAULT_SETTINGS.targetHeight,
    includeAudio: raw?.includeAudio ?? DEFAULT_SETTINGS.includeAudio,
    autoSplit: raw?.autoSplit ?? DEFAULT_SETTINGS.autoSplit,
    audioGain: clamp(Number(raw?.audioGain ?? DEFAULT_SETTINGS.audioGain), 0, 2),
    audioBitsPerSecond: clamp(Math.round(coerceNumber(raw?.audioBitsPerSecond, DEFAULT_SETTINGS.audioBitsPerSecond)), 32_000, 512_000),
    splitSeconds: clamp(Math.round(coerceNumber(raw?.splitSeconds, DEFAULT_SETTINGS.splitSeconds)), 0, 45),
  };
}

export function normalizeRegion(raw: Partial<RegionSelection> | null | undefined): RegionSelection | null {
  if (!raw) {
    return null;
  }

  const values = [raw.x, raw.y, raw.width, raw.height, raw.viewportWidth, raw.viewportHeight, raw.devicePixelRatio, raw.selectedAt];
  if (values.some((value) => !Number.isFinite(Number(value)))) {
    return null;
  }

  return {
    x: Number(raw.x),
    y: Number(raw.y),
    width: Number(raw.width),
    height: Number(raw.height),
    viewportWidth: Math.max(1, Number(raw.viewportWidth)),
    viewportHeight: Math.max(1, Number(raw.viewportHeight)),
    devicePixelRatio: Math.max(0.1, Number(raw.devicePixelRatio)),
    selectedAt: Number(raw.selectedAt),
  };
}

export function normalizeRecordingState(raw: Partial<RecordingState> | undefined): RecordingState {
  const status = raw?.status === "recording" || raw?.status === "completed" || raw?.status === "error" ? raw.status : DEFAULT_RECORDING_STATE.status;

  return {
    status,
    recordingId: typeof raw?.recordingId === "string" ? raw.recordingId : undefined,
    tabId: Number.isFinite(raw?.tabId as number) ? Number(raw?.tabId) : undefined,
    startedAt: Number.isFinite(raw?.startedAt as number) ? Number(raw?.startedAt) : undefined,
    endedAt: Number.isFinite(raw?.endedAt as number) ? Number(raw?.endedAt) : undefined,
    lastError: typeof raw?.lastError === "string" ? raw.lastError : undefined,
    requestedOutputFormat: raw?.requestedOutputFormat === "auto" || raw?.requestedOutputFormat === "webm" || raw?.requestedOutputFormat === "mp4" ? raw.requestedOutputFormat : undefined,
    actualOutputFormat: raw?.actualOutputFormat === "webm" || raw?.actualOutputFormat === "mp4" ? raw.actualOutputFormat : undefined,
    actualMimeType: typeof raw?.actualMimeType === "string" ? raw.actualMimeType : undefined,
    actualExtension: raw?.actualExtension === "webm" || raw?.actualExtension === "mp4" ? raw.actualExtension : undefined,
  };
}

export async function loadAppState(): Promise<AppState> {
  const stored = await chrome.storage.local.get({
    [STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
    [STORAGE_KEYS.region]: null,
    [STORAGE_KEYS.recordingState]: DEFAULT_RECORDING_STATE,
  });

  return {
    settings: normalizeSettings(stored[STORAGE_KEYS.settings] as Partial<Settings> | undefined),
    region: normalizeRegion(stored[STORAGE_KEYS.region] as Partial<RegionSelection> | null | undefined),
    recordingState: normalizeRecordingState(stored[STORAGE_KEYS.recordingState] as Partial<RecordingState> | undefined),
  };
}

export async function loadSettings(): Promise<Settings> {
  const state = await loadAppState();
  return state.settings;
}

export async function loadRegion(): Promise<RegionSelection | null> {
  const state = await loadAppState();
  return state.region;
}

export async function loadRecordingState(): Promise<RecordingState> {
  const state = await loadAppState();
  return state.recordingState;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: normalizeSettings(settings) });
}

export async function saveRegion(region: RegionSelection | null): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.region]: normalizeRegion(region) });
}

export async function saveRecordingState(recordingState: RecordingState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.recordingState]: normalizeRecordingState(recordingState) });
}

export async function patchRecordingState(partial: Partial<RecordingState>): Promise<RecordingState> {
  const current = await loadRecordingState();
  const next = normalizeRecordingState({ ...current, ...partial });
  await saveRecordingState(next);
  return next;
}
