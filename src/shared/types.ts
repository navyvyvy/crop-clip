export type RecordingFormat = "webm" | "mp4";
export type RecordingCodec = "auto" | "hevc";
export const SPLIT_COUNTS = { half: 2, thirds: 3, quarters: 4 } as const;
export type AutoSplitMode = keyof typeof SPLIT_COUNTS | "duration" | "size";
type RecordingStatus = "idle" | "recording" | "completed" | "error";
type RecordingMode = "region" | "full";
export type ShortcutAction = "selectRegion" | "clearRegion" | "clearAllRegions" | "regionRecord" | "cancelRecording" | "regionScreenshot" | "fullRecord" | "fullScreenshot";
export type ShortcutKeys = Record<ShortcutAction, string>;

export const RECORDING_FORMAT = {
  webm: "webm",
  mp4: "mp4",
} as const satisfies Record<RecordingFormat, RecordingFormat>;

export const RECORDING_MIME_CANDIDATES: Record<RecordingFormat, readonly string[]> = {
  mp4: ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs="avc1,mp4a.40.2"', 'video/mp4;codecs="avc1,opus"', "video/mp4"],
  webm: ["video/webm;codecs=avc1", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"],
};

export const HEVC_MP4_MIME_TYPES = [
  "video/mp4;codecs=hvc1.1.6.L153.B0,mp4a.40.2",
  "video/mp4;codecs=hvc1.1.6.L123.B0,mp4a.40.2",
  "video/mp4;codecs=hev1.1.6.L153.B0,mp4a.40.2",
  "video/mp4;codecs=hev1.1.6.L123.B0,mp4a.40.2",
  "video/mp4;codecs=hvc1,mp4a.40.2",
] as const;

export const RECORDING_STATUS = {
  idle: "idle",
  recording: "recording",
  completed: "completed",
  error: "error",
} as const satisfies Record<RecordingStatus, RecordingStatus>;

export const RECORDING_MODE = {
  region: "region",
  full: "full",
} as const satisfies Record<RecordingMode, RecordingMode>;

export interface Settings {
  outputFormat: RecordingFormat;
  recordingCodec: RecordingCodec;
  videoBitsPerSecond: number;
  enable60fps: boolean;
  allowMutedRecording: boolean;
  enableOriginalStreamRecording: boolean;
  showRecordingSize: boolean;
  enableMultiRegion: boolean;
  multiRegionMaxCount: number;
  enableFullRecordButton: boolean;
  enableFullScreenshotButton: boolean;
  enableSeek: boolean;
  seekSeconds: number;
  enableStreamerFilename: boolean;
  autoFocusResult: boolean;
  enableAutoDownloadRecording: boolean;
  enableAutoSplitRecording: boolean;
  autoSplitMode: AutoSplitMode;
  autoSplitAfterSeconds: number;
  autoSplitIntervalSeconds: number;
  autoSplitMaxMegabytes: number;
  autoSplitFormat: RecordingFormat;
  enableAutoDownloadSplit: boolean;
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
}

export interface RecordingState {
  status: RecordingStatus;
  recordingId?: string;
  tabId?: number;
  resultTabId?: number;
  startedAt?: number;
  mode?: RecordingMode;
}

export interface RecordingRecord {
  id: string;
  createdAt: number;
  endedAt: number;
  totalSize: number;
  actualExtension: RecordingFormat;
}

export interface RecordingPartRecord {
  id: string;
  recordingId: string;
  index: number;
  filename: string;
  mimeType: string;
  extension: RecordingFormat;
  size: number;
  blob?: Blob;
  originalBlob?: Blob;
  dataUrl?: string;
  objectUrl?: string;
  seekMetadataVersion?: number;
  frameRate?: number;
  videoBitsPerSecond?: number;
  startupTrimSeconds?: number;
  inspectStartup?: true;
  repairVideoGaps?: true;
  removedVideoGapSeconds?: number;
  originalStreamStart?: number;
  originalStreamEnd?: number;
  captureMethod?: "original" | "screen";
  createdAt: number;
}

export interface RecordingChunkRecord {
  id: string;
  recordingId: string;
  index: number;
  mimeType: string;
  extension: RecordingFormat;
  baseName: string;
  createdAt: number;
  capturedAt: number;
  completesBlob?: boolean;
  frameRate?: number;
  videoBitsPerSecond?: number;
  inspectStartup?: true;
  repairVideoGaps?: true;
  originalStreamStart?: number;
  originalStreamFallback?: true;
  blob: Blob;
}

export interface AppState {
  settings: Settings;
  region: RegionSelection | null;
  regions: RegionSelection[];
  recordingState: RecordingState;
}

export const MIN_VIDEO_BITS_PER_SECOND = 100_000;
export const MAX_VIDEO_BITS_PER_SECOND = 16_000_000;
const DEFAULT_VIDEO_BITS_PER_SECOND = 8_000_000;
export const FPS_WARNING_VIDEO_BITS_PER_SECOND = 6_000_000;
export const STANDARD_RECORDING_FRAME_RATE = 30;
export const HIGH_RECORDING_FRAME_RATE = 60;
export const STARTUP_TRIM_MIN_SECONDS = 0.15;
export const STARTUP_SHORT_STALL_SECONDS = 0.09;
export const STARTUP_SHORT_STALL_WINDOW_SECONDS = 1;
export const STARTUP_STALL_WINDOW_SECONDS = 2.5;
export const STARTUP_TRIM_MAX_SECONDS = 5;
export const WEBM_REPAIR_MIN_GAP_SECONDS = 0.18;
export const WEBM_REPAIR_MIN_OPENING_SECONDS = 0.75;
export const MIN_MULTI_REGION_COUNT = 2;
export const MAX_MULTI_REGION_COUNT = 4;
export const DEFAULT_MULTI_REGION_COUNT = 2;
export const MIN_SEEK_SECONDS = 1;
export const MAX_SEEK_SECONDS = 60;
export const DEFAULT_SEEK_SECONDS = 5;
export const DEFAULT_AUTO_SPLIT_AFTER_SECONDS = 35;
export const DEFAULT_AUTO_SPLIT_INTERVAL_SECONDS = 30;
export const DEFAULT_AUTO_SPLIT_MAX_MEGABYTES = 40;
export const DEFAULT_SHORTCUT_KEYS: ShortcutKeys = {
  selectRegion: "a",
  clearRegion: "x",
  clearAllRegions: "z",
  regionRecord: "r",
  cancelRecording: "c",
  regionScreenshot: "s",
  fullRecord: "e",
  fullScreenshot: "d",
};

export const DEFAULT_SETTINGS: Settings = {
  outputFormat: RECORDING_FORMAT.webm,
  recordingCodec: "auto",
  videoBitsPerSecond: DEFAULT_VIDEO_BITS_PER_SECOND,
  enable60fps: false,
  allowMutedRecording: false,
  enableOriginalStreamRecording: false,
  showRecordingSize: false,
  enableMultiRegion: false,
  multiRegionMaxCount: DEFAULT_MULTI_REGION_COUNT,
  enableFullRecordButton: false,
  enableFullScreenshotButton: false,
  enableSeek: false,
  seekSeconds: DEFAULT_SEEK_SECONDS,
  enableStreamerFilename: false,
  autoFocusResult: true,
  enableAutoDownloadRecording: false,
  enableAutoSplitRecording: false,
  autoSplitMode: "half",
  autoSplitAfterSeconds: DEFAULT_AUTO_SPLIT_AFTER_SECONDS,
  autoSplitIntervalSeconds: DEFAULT_AUTO_SPLIT_INTERVAL_SECONDS,
  autoSplitMaxMegabytes: DEFAULT_AUTO_SPLIT_MAX_MEGABYTES,
  autoSplitFormat: RECORDING_FORMAT.mp4,
  enableAutoDownloadSplit: false,
  enableShortcuts: false,
  shortcutKeys: DEFAULT_SHORTCUT_KEYS,
};

export const DEFAULT_RECORDING_STATE: RecordingState = {
  status: RECORDING_STATUS.idle,
};
