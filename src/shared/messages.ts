import type { RegionSelection, Settings, ShortcutKeys } from "./types.js";

export interface PlaybackSource {
  src: string;
}

export type RecordingControlMessage =
  | { type: "START_FULL_RECORDING"; playback?: PlaybackSource }
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING"; recordingId?: string }
  | { type: "CANCEL_RECORDING" };

export type PopupCommand =
  | RecordingControlMessage
  | { type: "SELECT_REGION" }
  | { type: "SAVE_REGIONS"; regions: RegionSelection[] }
  | { type: "CLEAR_REGION"; region?: RegionSelection }
  | { type: "CAPTURE_FULL_SCREENSHOT" };

export type SettingsPatch = Partial<Omit<Settings, "shortcutKeys">> & { shortcutKeys?: Partial<ShortcutKeys> };

export type ContentCommand =
  | { type: "PREPARE_DIRECT_RECORDING"; recordingId: string; settings: Settings; fullPlayer?: boolean }
  | { type: "START_SELECTION" }
  | { type: "GET_REGION_GEOMETRY" }
  | { type: "GET_REGION_GEOMETRIES" }
  | { type: "GET_PLAYER_REGION_GEOMETRY" }
  | { type: "CAPTURE_FULL_SCREENSHOT" }
  | {
      type: "START_DIRECT_RECORDING";
      recordingId: string;
      fullPlayer: boolean;
      playback?: PlaybackSource;
      region: RegionSelection;
      regions?: RegionSelection[];
      settings: Settings;
    }
  | { type: "STOP_DIRECT_RECORDING"; recordingId?: string }
  | { type: "HAS_DIRECT_RECORDING"; recordingId: string }
  | { type: "GET_RECORDING_SIZE"; recordingId: string }
  | { type: "CANCEL_DIRECT_RECORDING"; recordingId?: string };
export type DeletionScheduleRequest = { type: "SCHEDULE_RECORDING_DELETION"; recordingId: string };
export type AutoDownloadHandledMessage = { type: "AUTO_DOWNLOAD_HANDLED"; recordingId: string };
export type StreamOffsetRequest = { type: "READ_STREAM_OFFSET"; src: string; bufferedOnly?: true };
export type RecordingStartedMessage = { type: "RECORDING_STARTED"; recordingId: string; startedAt: number };

export type RecordingErrorMessage = {
  type: "RECORDING_ERROR";
  recordingId?: string;
  error: string;
};

export type StoreRecordingChunkMessage = {
  type: "STORE_RECORDING_CHUNK";
  chunk: Omit<import("./types.js").RecordingChunkRecord, "blob"> & { dataUrl: string };
};

export type FinalizeRecordingMessage = {
  type: "FINALIZE_RECORDING";
  recordingId: string;
  endedAt: number;
  startupTrimSeconds?: number;
  inspectStartup?: true;
  originalStreamEnd?: number;
};

export type RuntimeMessage =
  | PopupCommand
  | { type: "UPDATE_SETTINGS"; patch: SettingsPatch }
  | RecordingStartedMessage
  | RecordingErrorMessage
  | StoreRecordingChunkMessage
  | FinalizeRecordingMessage
  | StreamOffsetRequest
  | DeletionScheduleRequest
  | AutoDownloadHandledMessage;

type OkResponse<T = undefined> = { ok: true; data?: T };
type ErrorResponse = { ok: false; error: string };
export type MessageResponse<T = undefined> = OkResponse<T> | ErrorResponse;
export const UNSUPPORTED_RUNTIME_MESSAGE = "지원하지 않는 메시지입니다.";

export function ok<T = undefined>(data?: T): MessageResponse<T> {
  return data === undefined ? { ok: true } : { ok: true, data };
}

export function fail(error: string): MessageResponse {
  return { ok: false, error };
}
