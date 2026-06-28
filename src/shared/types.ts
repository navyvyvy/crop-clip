export type DownloadFormat = "auto" | "webm" | "mp4";
export type BitratePreset = "low" | "standard" | "high" | "veryHigh" | "custom";
export type TargetHeight = "source" | 480 | 720 | 1080;
export type RecordingStatus = "idle" | "recording" | "completed" | "error";

export interface Settings {
  outputFormat: DownloadFormat;
  bitratePreset: BitratePreset;
  videoBitsPerSecond: number;
  customVideoBitsPerSecond?: number;
  enable60fps: boolean;
  targetHeight: TargetHeight;
  includeAudio: boolean;
  autoSplit: boolean;
  audioGain: number;
  audioBitsPerSecond: number;
  splitSeconds: number;
}

export interface RegionSelection {
  x: number;
  y: number;
  width: number;
  height: number;
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
  requestedOutputFormat?: DownloadFormat;
  actualOutputFormat?: Exclude<DownloadFormat, "auto">;
  actualMimeType?: string;
  actualExtension?: "webm" | "mp4";
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
  actualExtension: "webm" | "mp4";
  requestedOutputFormat: DownloadFormat;
  actualOutputFormat: Exclude<DownloadFormat, "auto">;
}

export interface RecordingPartRecord {
  id: string;
  recordingId: string;
  index: number;
  filename: string;
  mimeType: string;
  extension: "webm" | "mp4";
  outputFormat: Exclude<DownloadFormat, "auto">;
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

export const BITRATE_PRESET_VALUES: Record<Exclude<BitratePreset, "custom">, number> = {
  low: 1_500_000,
  standard: 2_500_000,
  high: 4_000_000,
  veryHigh: 6_000_000,
};
export const MIN_VIDEO_BITS_PER_SECOND = 100_000;
export const MAX_VIDEO_BITS_PER_SECOND = 20_000_000;

export const DEFAULT_SETTINGS: Settings = {
  outputFormat: "webm",
  bitratePreset: "custom",
  videoBitsPerSecond: BITRATE_PRESET_VALUES.high,
  customVideoBitsPerSecond: BITRATE_PRESET_VALUES.high,
  enable60fps: false,
  targetHeight: "source",
  includeAudio: true,
  autoSplit: false,
  audioGain: 1,
  audioBitsPerSecond: 128_000,
  splitSeconds: 45,
};

export const DEFAULT_RECORDING_STATE: RecordingState = {
  status: "idle",
};
