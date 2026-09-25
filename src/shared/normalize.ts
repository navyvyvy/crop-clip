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
  type RecordingState,
  type RegionSelection,
  type Settings,
  type ShortcutKeys,
} from "./types.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coerceNumber(value: unknown, fallback: number): number {
  return Number.isFinite(value as number) ? Number(value) : fallback;
}

function normalizeShortcutKeys(raw: Partial<ShortcutKeys> | undefined): ShortcutKeys {
  const normalized = { ...DEFAULT_SHORTCUT_KEYS };
  for (const action of Object.keys(normalized) as Array<keyof ShortcutKeys>) {
    const key = (typeof raw?.[action] === "string" ? raw[action] : undefined)?.toLowerCase();
    if (key && /^[a-z0-9]$/.test(key)) {
      normalized[action] = key;
    }
  }
  return normalized;
}

export function normalizeSettings(value: unknown): Settings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<Settings> : {};
  const outputFormat = raw?.outputFormat === RECORDING_FORMAT.webm || raw?.outputFormat === RECORDING_FORMAT.mp4 ? raw.outputFormat : DEFAULT_SETTINGS.outputFormat;
  const rawSettings = raw as Partial<Settings> & { customVideoBitsPerSecond?: number };
  const videoBitsPerSecond = coerceNumber(rawSettings.customVideoBitsPerSecond ?? rawSettings.videoBitsPerSecond, DEFAULT_SETTINGS.videoBitsPerSecond);

  return {
    outputFormat,
    videoBitsPerSecond: clamp(Math.round(videoBitsPerSecond), MIN_VIDEO_BITS_PER_SECOND, MAX_VIDEO_BITS_PER_SECOND),
    enable60fps: raw?.enable60fps === true,
    allowMutedRecording: raw?.allowMutedRecording === true,
    enableMultiRegion: raw?.enableMultiRegion === true,
    multiRegionMaxCount: clamp(Math.round(coerceNumber(raw?.multiRegionMaxCount, DEFAULT_MULTI_REGION_COUNT)), MIN_MULTI_REGION_COUNT, MAX_MULTI_REGION_COUNT),
    enableFullRecordButton: raw?.enableFullRecordButton === true,
    enableFullScreenshotButton: raw?.enableFullScreenshotButton === true,
    enableSeek: (raw?.enableSeek ?? (raw as Partial<Settings> & { enableSeekButtons?: boolean }).enableSeekButtons) === true,
    seekSeconds: clamp(Math.round(coerceNumber(raw?.seekSeconds, DEFAULT_SEEK_SECONDS)), MIN_SEEK_SECONDS, MAX_SEEK_SECONDS),
    enableStreamerFilename: raw?.enableStreamerFilename === true,
    autoFocusResult: raw?.autoFocusResult !== false,
    enableAutoDownloadRecording: raw?.enableAutoDownloadRecording === true,
    enableAutoDownloadSplit: raw?.enableAutoDownloadSplit === true,
    enableShortcuts: raw?.enableShortcuts === true,
    shortcutKeys: normalizeShortcutKeys(raw?.shortcutKeys),
  };
}

export function normalizeRegions(raw: unknown, fallback?: RegionSelection | null): RegionSelection[] {
  const source = Array.isArray(raw) ? raw : fallback ? [fallback] : [];
  return source
    .map((item) => normalizeRegion(item))
    .filter((item): item is RegionSelection => item !== null)
    .slice(0, MAX_MULTI_REGION_COUNT);
}

function isFiniteCoordinate(value: unknown): boolean {
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
}

export function normalizeRegion(value: unknown): RegionSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Partial<RegionSelection>;
  const values = [raw.x, raw.y, raw.width, raw.height];
  if (!values.every(isFiniteCoordinate) || Number(raw.width) <= 0 || Number(raw.height) <= 0) {
    return null;
  }

  const relative = raw.videoRelative;
  const videoRelative =
    relative &&
    [relative.x, relative.y, relative.width, relative.height].every(isFiniteCoordinate) &&
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
  };
}

export function normalizeRecordingState(raw: Partial<RecordingState> | undefined): RecordingState {
  const status = raw?.status === RECORDING_STATUS.recording || raw?.status === RECORDING_STATUS.completed || raw?.status === RECORDING_STATUS.error ? raw.status : DEFAULT_RECORDING_STATE.status;

  return {
    status,
    recordingId: typeof raw?.recordingId === "string" ? raw.recordingId : undefined,
    tabId: Number.isFinite(raw?.tabId as number) ? Number(raw?.tabId) : undefined,
    resultTabId: Number.isFinite(raw?.resultTabId as number) ? Number(raw?.resultTabId) : undefined,
    startedAt: Number.isFinite(raw?.startedAt as number) ? Number(raw?.startedAt) : undefined,
    mode: raw?.mode === RECORDING_MODE.region || raw?.mode === RECORDING_MODE.full ? raw.mode : undefined,
  };
}
