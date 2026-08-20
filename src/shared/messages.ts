import type { RegionSelection, Settings } from "./types.js";

export type PopupCommand =
  | { type: "SELECT_REGION" }
  | { type: "CLEAR_REGION" }
  | { type: "START_FULL_RECORDING" }
  | { type: "CAPTURE_FULL_SCREENSHOT" }
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING" }
  | { type: "CANCEL_RECORDING" };

export type ContentCommand =
  | { type: "START_SELECTION" }
  | { type: "CLEAR_REGION" }
  | { type: "GET_REGION_GEOMETRY" }
  | { type: "GET_REGION_GEOMETRIES" }
  | { type: "GET_PLAYER_REGION_GEOMETRY" }
  | { type: "CAPTURE_FULL_SCREENSHOT" }
  | {
      type: "START_DIRECT_RECORDING";
      recordingId: string;
      region: RegionSelection;
      regions?: RegionSelection[];
      settings: Settings;
    }
  | { type: "STOP_DIRECT_RECORDING" }
  | { type: "CANCEL_DIRECT_RECORDING"; recordingId?: string };
export type DeletionScheduleRequest = { type: "SCHEDULE_RECORDING_DELETION"; recordingId: string };

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
};

type OkResponse<T = undefined> = { ok: true; data?: T };
type ErrorResponse = { ok: false; error: string };
export type MessageResponse<T = undefined> = OkResponse<T> | ErrorResponse;

export function ok<T = undefined>(data?: T): MessageResponse<T> {
  return data === undefined ? { ok: true } : { ok: true, data };
}

export function fail(error: string): MessageResponse {
  return { ok: false, error };
}
