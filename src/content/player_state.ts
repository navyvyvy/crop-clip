import { RECORDING_STATUS, type RecordingState } from "../shared/types.js";

export type PlayerRecordingState = Pick<RecordingState, "status" | "startedAt" | "mode"> & {
  recordingElsewhere?: boolean;
};

export function getPlayerRecordingState({ status, recordingId, startedAt, mode }: RecordingState, localRecordingId?: string): PlayerRecordingState {
  if (status === RECORDING_STATUS.idle) return { status };
  if (status === RECORDING_STATUS.recording && (!localRecordingId || recordingId !== localRecordingId)) {
    return { status: RECORDING_STATUS.idle, recordingElsewhere: true, mode };
  }
  return { status, startedAt, mode };
}
