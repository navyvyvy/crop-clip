export type RecordingFormat = "webm" | "mp4";
export type DownloadFormat = RecordingFormat | "auto";
export type RecordingStatus = "idle" | "recording" | "completed" | "error";
export type RecordingMode = "region" | "full";
export type ShortcutAction = "selectRegion" | "clearRegion" | "regionRecord" | "regionScreenshot" | "fullRecord" | "fullScreenshot";
export type ShortcutKeys = Record<ShortcutAction, string>;

export interface Settings {
  outputFormat: RecordingFormat;
  videoBitsPerSecond: number;
  enable60fps: boolean;
  enableFullRecordButton: boolean;
  enableFullScreenshotButton: boolean;
  enableSeek: boolean;
  seekSeconds: number;
  enableStreamerFilename: boolean;
  enableShortcuts: boolean;
  shortcutKeys: ShortcutKeys;
}

export interface RegionSelection {
  x: number;
  y: number;
  width: number;
  height: number;
  videoRelative?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  selectedAt: number;
}

export interface RecordingState {
  status: RecordingStatus;
  recordingId?: string;
  tabId?: number;
  startedAt?: number;
  endedAt?: number;
  lastError?: string;
  mode?: RecordingMode;
  requestedOutputFormat?: DownloadFormat;
  actualOutputFormat?: RecordingFormat;
  actualMimeType?: string;
  actualExtension?: RecordingFormat;
}

export interface RecordingRecord {
  id: string;
  createdAt: number;
  endedAt: number;
  settings: Settings;
  region: RegionSelection;
  partCount: number;
  totalSize: number;
  actualMimeType: string;
  actualExtension: RecordingFormat;
  requestedOutputFormat: DownloadFormat;
  actualOutputFormat: RecordingFormat;
}

export interface RecordingPartRecord {
  id: string;
  recordingId: string;
  index: number;
  filename: string;
  mimeType: string;
  extension: RecordingFormat;
  outputFormat: RecordingFormat;
  size: number;
  blob?: Blob;
  dataUrl?: string;
  objectUrl?: string;
  createdAt: number;
}

export interface AppState {
  settings: Settings;
  region: RegionSelection | null;
  recordingState: RecordingState;
}

export const MIN_VIDEO_BITS_PER_SECOND = 100_000;
export const MAX_VIDEO_BITS_PER_SECOND = 12_000_000;
export const DEFAULT_VIDEO_BITS_PER_SECOND = 4_000_000;
export const FPS_WARNING_VIDEO_BITS_PER_SECOND = DEFAULT_VIDEO_BITS_PER_SECOND;
export const MIN_SEEK_SECONDS = 1;
export const MAX_SEEK_SECONDS = 60;
export const DEFAULT_SEEK_SECONDS = 5;
export const DEFAULT_SHORTCUT_KEYS: ShortcutKeys = {
  selectRegion: "a",
  clearRegion: "x",
  regionRecord: "r",
  regionScreenshot: "s",
  fullRecord: "e",
  fullScreenshot: "d",
};

export const DEFAULT_SETTINGS: Settings = {
  outputFormat: "webm",
  videoBitsPerSecond: DEFAULT_VIDEO_BITS_PER_SECOND,
  enable60fps: false,
  enableFullRecordButton: false,
  enableFullScreenshotButton: false,
  enableSeek: false,
  seekSeconds: DEFAULT_SEEK_SECONDS,
  enableStreamerFilename: false,
  enableShortcuts: false,
  shortcutKeys: DEFAULT_SHORTCUT_KEYS,
};

export const DEFAULT_RECORDING_STATE: RecordingState = {
  status: "idle",
};
