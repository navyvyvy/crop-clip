import {
  DEFAULT_RECORDING_STATE,
  DEFAULT_SETTINGS,
  MAX_VIDEO_BITS_PER_SECOND,
  MIN_VIDEO_BITS_PER_SECOND,
  type AppState,
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
  const rawSettings = raw as Partial<Settings> & { customVideoBitsPerSecond?: number };
  const videoBitsPerSecond = coerceNumber(rawSettings.customVideoBitsPerSecond ?? rawSettings.videoBitsPerSecond, DEFAULT_SETTINGS.videoBitsPerSecond);

  return {
    outputFormat,
    videoBitsPerSecond: clamp(Math.round(videoBitsPerSecond), MIN_VIDEO_BITS_PER_SECOND, MAX_VIDEO_BITS_PER_SECOND),
    enable60fps: Boolean(raw?.enable60fps),
    enableFullRecordButton: Boolean(raw?.enableFullRecordButton),
    enableFullScreenshotButton: Boolean(raw?.enableFullScreenshotButton),
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

  const relative = raw.videoRelative;
  const videoRelative =
    relative &&
    [relative.x, relative.y, relative.width, relative.height].every((value) => Number.isFinite(Number(value))) &&
    Number(relative.width) > 0 &&
    Number(relative.height) > 0
      ? {
          x: Number(relative.x),
          y: Number(relative.y),
          width: Number(relative.width),
          height: Number(relative.height),
        }
      : undefined;

  return {
    x: Number(raw.x),
    y: Number(raw.y),
    width: Number(raw.width),
    height: Number(raw.height),
    ...(videoRelative ? { videoRelative } : {}),
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
    mode: raw?.mode === "region" || raw?.mode === "full" ? raw.mode : undefined,
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

export async function patchRecordingState(partial: Partial<RecordingState>): Promise<RecordingState> {
  const current = await loadRecordingState();
  const next = normalizeRecordingState({ ...current, ...partial });
  await saveRecordingState(next);
  return next;
}
