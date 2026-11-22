import {
  DEFAULT_RECORDING_STATE,
  DEFAULT_AUTO_SPLIT_AFTER_SECONDS,
  DEFAULT_AUTO_SPLIT_INTERVAL_SECONDS,
  DEFAULT_AUTO_SPLIT_MAX_MEGABYTES,
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
  SPLIT_COUNTS,
  type AutoSplitMode,
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

function normalizeMultiRegionCount(value: unknown): number {
  return clamp(Math.round(coerceNumber(value, DEFAULT_MULTI_REGION_COUNT)), MIN_MULTI_REGION_COUNT, MAX_MULTI_REGION_COUNT);
}

export function getRegionLimit(settings: Pick<Settings, "enableMultiRegion" | "multiRegionMaxCount">): number {
  return settings.enableMultiRegion ? normalizeMultiRegionCount(settings.multiRegionMaxCount) : 1;
}

function normalizeShortcutKeys(raw: Partial<ShortcutKeys> | undefined): ShortcutKeys {
  const normalized = { ...DEFAULT_SHORTCUT_KEYS };
  const actions = Object.keys(normalized) as Array<keyof ShortcutKeys>;
  const remaining = new Set(actions);
  const used = new Set<string>();
  for (const action of actions) {
    const key = (typeof raw?.[action] === "string" ? raw[action] : undefined)?.toLowerCase();
    if (key && /^[a-z0-9]$/.test(key) && !used.has(key)) {
      normalized[action] = key;
      used.add(key);
      remaining.delete(action);
    }
  }
  for (const action of remaining) {
    const key = DEFAULT_SHORTCUT_KEYS[action];
    if (!used.has(key)) {
      used.add(key);
      remaining.delete(action);
    }
  }
  const unusedDefaults = Object.values(DEFAULT_SHORTCUT_KEYS).filter(key => !used.has(key));
  for (const [index, action] of [...remaining].entries()) normalized[action] = unusedDefaults[index];
  return normalized;
}

export function normalizeAutoSplitMode(mode: unknown): AutoSplitMode {
  if (mode === "duration" || mode === "size") return mode;
  return typeof mode === "string" && Object.hasOwn(SPLIT_COUNTS, mode)
    ? mode as keyof typeof SPLIT_COUNTS : DEFAULT_SETTINGS.autoSplitMode;
}

export function normalizeSettings(value: unknown): Settings {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<Settings> : {};
  const outputFormat = raw?.outputFormat === RECORDING_FORMAT.webm || raw?.outputFormat === RECORDING_FORMAT.mp4 ? raw.outputFormat : DEFAULT_SETTINGS.outputFormat;
  const rawSettings = raw as Partial<Settings> & { customVideoBitsPerSecond?: number };
  const videoBitsPerSecond = coerceNumber(rawSettings.videoBitsPerSecond, coerceNumber(rawSettings.customVideoBitsPerSecond, DEFAULT_SETTINGS.videoBitsPerSecond));

  return {
    outputFormat,
    recordingCodec: outputFormat === RECORDING_FORMAT.mp4 && raw.recordingCodec === "hevc" ? "hevc" : DEFAULT_SETTINGS.recordingCodec,
    videoBitsPerSecond: clamp(Math.round(videoBitsPerSecond), MIN_VIDEO_BITS_PER_SECOND, MAX_VIDEO_BITS_PER_SECOND),
    enable60fps: raw?.enable60fps === true,
    allowMutedRecording: raw?.allowMutedRecording === true,
    enableOriginalStreamRecording: raw?.enableOriginalStreamRecording === true,
    showRecordingSize: raw?.showRecordingSize === true,
    enableMultiRegion: raw?.enableMultiRegion === true,
    multiRegionMaxCount: normalizeMultiRegionCount(raw?.multiRegionMaxCount),
    enableFullRecordButton: raw?.enableFullRecordButton === true,
    enableFullScreenshotButton: raw?.enableFullScreenshotButton === true,
    enableSeek: typeof raw.enableSeek === "boolean" ? raw.enableSeek : (raw as { enableSeekButtons?: unknown }).enableSeekButtons === true,
    seekSeconds: clamp(Math.round(coerceNumber(raw?.seekSeconds, DEFAULT_SEEK_SECONDS)), MIN_SEEK_SECONDS, MAX_SEEK_SECONDS),
    enableStreamerFilename: raw?.enableStreamerFilename === true,
    autoFocusResult: raw?.autoFocusResult !== false,
    enableAutoDownloadRecording: raw?.enableAutoDownloadRecording === true,
    enableAutoSplitRecording: raw?.enableAutoSplitRecording === true,
    autoSplitMode: normalizeAutoSplitMode(raw?.autoSplitMode),
    autoSplitAfterSeconds: Math.max(1, Math.round(coerceNumber(raw?.autoSplitAfterSeconds, DEFAULT_AUTO_SPLIT_AFTER_SECONDS))),
    autoSplitIntervalSeconds: Math.max(1, Math.round(coerceNumber(raw?.autoSplitIntervalSeconds, DEFAULT_AUTO_SPLIT_INTERVAL_SECONDS))),
    autoSplitMaxMegabytes: Math.max(1, Math.round(coerceNumber(raw?.autoSplitMaxMegabytes, DEFAULT_AUTO_SPLIT_MAX_MEGABYTES))),
    autoSplitFormat: raw?.autoSplitFormat === RECORDING_FORMAT.webm ? RECORDING_FORMAT.webm : DEFAULT_SETTINGS.autoSplitFormat,
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

export function normalizeRecordingState(value: unknown): RecordingState {
  const raw = value as Partial<RecordingState> | null | undefined;
  const status = raw?.status === RECORDING_STATUS.recording || raw?.status === RECORDING_STATUS.completed || raw?.status === RECORDING_STATUS.error ? raw.status : DEFAULT_RECORDING_STATE.status;

  return {
    status,
    recordingId: typeof raw?.recordingId === "string" ? raw.recordingId : undefined,
    tabId: typeof raw?.tabId === "number" && Number.isFinite(raw.tabId) ? raw.tabId : undefined,
    resultTabId: typeof raw?.resultTabId === "number" && Number.isFinite(raw.resultTabId) ? raw.resultTabId : undefined,
    startedAt: typeof raw?.startedAt === "number" && Number.isFinite(raw.startedAt) ? raw.startedAt : undefined,
    mode: raw?.mode === RECORDING_MODE.region || raw?.mode === RECORDING_MODE.full ? raw.mode : undefined,
  };
}
