import {
  DEFAULT_RECORDING_STATE,
  DEFAULT_MULTI_REGION_COUNT,
  DEFAULT_SEEK_SECONDS,
  DEFAULT_SETTINGS,
  DEFAULT_SHORTCUT_KEYS,
  MAX_MULTI_REGION_COUNT,
  MAX_SEEK_SECONDS,
  MAX_VIDEO_BITS_PER_SECOND,
  MIN_MULTI_REGION_COUNT,
  MIN_SEEK_SECONDS,
  MIN_VIDEO_BITS_PER_SECOND,
  RECORDING_FORMAT,
  RECORDING_MODE,
  RECORDING_STATUS,
  type AppState,
  type RecordingState,
  type RegionSelection,
  type Settings,
  type ShortcutKeys,
} from "./types.js";

const STORAGE_KEYS = {
  settings: "settings",
  region: "region",
  regions: "regions",
  recordingState: "recordingState",
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coerceNumber(value: unknown, fallback: number): number {
  return Number.isFinite(value as number) ? Number(value) : fallback;
}

function normalizeShortcutKeys(raw: Partial<ShortcutKeys> | undefined): ShortcutKeys {
  const normalized = { ...DEFAULT_SHORTCUT_KEYS };
  for (const action of Object.keys(normalized) as Array<keyof ShortcutKeys>) {
    const key = raw?.[action]?.toLowerCase();
    if (key && /^[a-z0-9]$/.test(key)) {
      normalized[action] = key;
    }
  }
  return normalized;
}

export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const outputFormat = raw?.outputFormat === RECORDING_FORMAT.webm || raw?.outputFormat === RECORDING_FORMAT.mp4 ? raw.outputFormat : DEFAULT_SETTINGS.outputFormat;
  const rawSettings = raw as Partial<Settings> & { customVideoBitsPerSecond?: number };
  const videoBitsPerSecond = coerceNumber(rawSettings.customVideoBitsPerSecond ?? rawSettings.videoBitsPerSecond, DEFAULT_SETTINGS.videoBitsPerSecond);

  return {
    outputFormat,
    videoBitsPerSecond: clamp(Math.round(videoBitsPerSecond), MIN_VIDEO_BITS_PER_SECOND, MAX_VIDEO_BITS_PER_SECOND),
    enable60fps: Boolean(raw?.enable60fps),
    enableMultiRegion: Boolean(raw?.enableMultiRegion),
    multiRegionMaxCount: clamp(Math.round(coerceNumber(raw?.multiRegionMaxCount, DEFAULT_MULTI_REGION_COUNT)), MIN_MULTI_REGION_COUNT, MAX_MULTI_REGION_COUNT),
    enableFullRecordButton: Boolean(raw?.enableFullRecordButton),
    enableFullScreenshotButton: Boolean(raw?.enableFullScreenshotButton),
    enableSeek: Boolean(raw?.enableSeek ?? (raw as Partial<Settings> & { enableSeekButtons?: boolean } | undefined)?.enableSeekButtons),
    seekSeconds: clamp(Math.round(coerceNumber(raw?.seekSeconds, DEFAULT_SEEK_SECONDS)), MIN_SEEK_SECONDS, MAX_SEEK_SECONDS),
    enableStreamerFilename: Boolean(raw?.enableStreamerFilename),
    enableShortcuts: Boolean(raw?.enableShortcuts),
    shortcutKeys: normalizeShortcutKeys(raw?.shortcutKeys),
  };
}

export function normalizeRegions(raw: unknown, fallback?: RegionSelection | null): RegionSelection[] {
  const source = Array.isArray(raw) ? raw : fallback ? [fallback] : [];
  return source
    .map((item) => normalizeRegion(item as Partial<RegionSelection> | null | undefined))
    .filter((item): item is RegionSelection => item !== null)
    .slice(0, MAX_MULTI_REGION_COUNT);
}

export function normalizeRegion(raw: Partial<RegionSelection> | null | undefined): RegionSelection | null {
  if (!raw) {
    return null;
  }

  const values = [raw.x, raw.y, raw.width, raw.height, raw.viewportWidth, raw.viewportHeight, raw.devicePixelRatio, raw.selectedAt];
  if (values.some((value) => !Number.isFinite(Number(value))) || Number(raw.width) <= 0 || Number(raw.height) <= 0) {
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
  const status = raw?.status === RECORDING_STATUS.recording || raw?.status === RECORDING_STATUS.completed || raw?.status === RECORDING_STATUS.error ? raw.status : DEFAULT_RECORDING_STATE.status;

  return {
    status,
    recordingId: typeof raw?.recordingId === "string" ? raw.recordingId : undefined,
    tabId: Number.isFinite(raw?.tabId as number) ? Number(raw?.tabId) : undefined,
    startedAt: Number.isFinite(raw?.startedAt as number) ? Number(raw?.startedAt) : undefined,
    mode: raw?.mode === RECORDING_MODE.region || raw?.mode === RECORDING_MODE.full ? raw.mode : undefined,
  };
}

export async function loadAppState(): Promise<AppState> {
  const stored = await chrome.storage.local.get({
    [STORAGE_KEYS.settings]: DEFAULT_SETTINGS,
    [STORAGE_KEYS.region]: null,
    [STORAGE_KEYS.regions]: [],
    [STORAGE_KEYS.recordingState]: DEFAULT_RECORDING_STATE,
  });
  const region = normalizeRegion(stored[STORAGE_KEYS.region] as Partial<RegionSelection> | null | undefined);

  return {
    settings: normalizeSettings(stored[STORAGE_KEYS.settings] as Partial<Settings> | undefined),
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
