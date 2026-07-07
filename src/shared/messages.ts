import type { RecordingRecord, RegionSelection, Settings } from "./types.js";

export type PopupCommand =
  | { type: "SELECT_REGION" }
  | { type: "CLEAR_REGION" }
  | { type: "START_FULL_RECORDING" }
  | { type: "CAPTURE_FULL_SCREENSHOT" }
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING" };

export type ContentCommand =
  | { type: "START_SELECTION" }
  | { type: "CLEAR_REGION" }
  | { type: "GET_REGION_GEOMETRY" }
  | { type: "GET_PLAYER_REGION_GEOMETRY" }
  | { type: "CAPTURE_FULL_SCREENSHOT" }
  | {
      type: "START_DIRECT_RECORDING";
      recordingId: string;
      region: RegionSelection;
      settings: Settings;
    }
  | { type: "STOP_DIRECT_RECORDING" };
export type PlayerStatusRequest = { type: "GET_PLAYER_STATUS" };
export type DeletionScheduleRequest = { type: "SCHEDULE_RECORDING_DELETION"; recordingId: string };
export type DeletionCancelRequest = { type: "CANCEL_RECORDING_DELETION"; recordingId: string };

export type RecordingFinishedMessage = {
  type: "RECORDING_FINISHED";
  recording: RecordingRecord;
};

export type RecordingErrorMessage = {
  type: "RECORDING_ERROR";
  recordingId?: string;
  error: string;
};

export type StoreRecordingPartMessage = {
  type: "STORE_RECORDING_PART";
  part: import("./types.js").RecordingPartRecord;
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
