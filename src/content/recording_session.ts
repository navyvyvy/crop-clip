import type { Settings } from "../shared/types.js";
import type { DirectCropPlacement } from "./crop_layout.js";
import type { createVideoFrameCapture } from "./frame_capture.js";
import type { SoftwareRecorder } from "./software_recording.js";

const RECORDER_STOP_EVENT_TIMEOUT_MS = 5_000;

export interface DirectRecordingSession {
  recordingId: string;
  settings: Settings;
  video: HTMLVideoElement | null;
  sourceStream?: MediaStream;
  outputStream?: MediaStream;
  canvas: HTMLCanvasElement | null;
  recorder?: MediaRecorder | SoftwareRecorder;
  finishAfterStop?: (timedOut?: boolean) => void;
  stopEventTimer?: number;
  mimeType: string;
  stabilizeStartup?: boolean;
  inspectStartup?: true;
  repairVideoGaps?: true;
  startupTrimSeconds?: number;
  originalStreamStart?: number;
  originalStreamEnd?: number;
  recordedBytes: number;
  startedAt?: number;
  originalProbe?: AbortController;
  originalStreamFallback?: true;
  stopOriginalStream?: () => void;
  extension: "webm" | "mp4";
  baseName?: string;
  checkpointIndex: number;
  checkpointSaveChain: Promise<void>;
  pendingChunks: Array<{ blob: Blob; capturedAt: number }>;
  pendingBytes: number;
  checkpointSaving: boolean;
  checkpointAbort: AbortController;
  checkpointError?: Error;
  createdAt: number;
  endedAt?: number;
  drawTimerId?: number;
  drawFrameCallbackId?: number;
  stopRequested: boolean;
  cancelRequested: boolean;
  cleanedUp: boolean;
  closingPart: boolean;
  finishPromise: Promise<void>;
  resolveFinish: () => void;
  rejectFinish: (error: Error) => void;
  placements: DirectCropPlacement[];
  sourceChangeCleanup?: () => void;
  frameCapture?: NonNullable<ReturnType<typeof createVideoFrameCapture>>;
}

export function stopRecordingStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => {
    track.stop();
    stream.removeTrack(track);
  });
}

export function releaseDirectRecordingCapture(session: DirectRecordingSession): void {
  if (session.cleanedUp) {
    return;
  }

  session.cleanedUp = true;
  session.originalProbe?.abort();
  window.clearInterval(session.drawTimerId);
  session.drawTimerId = undefined;
  if (session.drawFrameCallbackId !== undefined) {
    session.video?.cancelVideoFrameCallback(session.drawFrameCallbackId);
    session.drawFrameCallbackId = undefined;
  }
  session.sourceChangeCleanup?.();
  session.sourceChangeCleanup = undefined;
  session.frameCapture?.close();
  session.frameCapture = undefined;
  session.stopOriginalStream = undefined;
  if (session.sourceStream) stopRecordingStream(session.sourceStream);
  if (session.outputStream) stopRecordingStream(session.outputStream);
  if (session.canvas) {
    session.canvas.width = 0;
    session.canvas.height = 0;
    session.canvas.remove();
  }
  session.canvas = null;
  session.video = null;
}

export function releaseDirectRecordingRecorder(session: DirectRecordingSession): void {
  window.clearTimeout(session.stopEventTimer);
  session.stopEventTimer = undefined;
  session.finishAfterStop = undefined;
  if (!session.recorder) return;
  session.recorder.ondataavailable = null;
  session.recorder.onstart = null;
  session.recorder.onerror = null;
  session.recorder.onstop = null;
  if ("dispose" in session.recorder) session.recorder.dispose();
  session.recorder = undefined;
}

export function requestDirectPartStop(session: DirectRecordingSession): void {
  if (session.stopOriginalStream) {
    session.endedAt ??= Date.now();
    session.stopOriginalStream();
    return;
  }
  if (!session.recorder || session.recorder.state === "inactive" || session.closingPart) {
    return;
  }

  session.closingPart = true;
  session.endedAt ??= Date.now();
  try {
    // stop() delivers the final data; keep its handlers until onstop finishes saving.
    session.recorder.stop();
    if (!session.cancelRequested && session.finishAfterStop) {
      session.stopEventTimer = window.setTimeout(() => session.finishAfterStop?.(true), RECORDER_STOP_EVENT_TIMEOUT_MS);
    }
  } catch (error) {
    // Cancellation discards the result; still finish cleanup if the encoder failed.
    if (!session.cancelRequested) throw error;
  } finally {
    releaseDirectRecordingCapture(session);
  }
}
