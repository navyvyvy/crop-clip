import type { Settings } from "../shared/types.js";
import type { DirectCropPlacement } from "./crop_layout.js";
import type { createVideoFrameCapture } from "./frame_capture.js";

export interface DirectRecordingSession {
  recordingId: string;
  settings: Settings;
  video: HTMLVideoElement | null;
  sourceStream?: MediaStream;
  outputStream?: MediaStream;
  canvas: HTMLCanvasElement | null;
  recorder?: MediaRecorder;
  mimeType: string;
  stabilizeStartup?: boolean;
  startupTrimSeconds?: number;
  originalStreamStart?: number;
  originalStreamEnd?: number;
  originalStreamBytes?: number;
  originalStreamFallback?: true;
  stopOriginalStream?: () => void;
  extension: "webm" | "mp4";
  baseName: string;
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
  window.clearInterval(session.drawTimerId);
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
  if (!session.recorder) return;
  session.recorder.ondataavailable = null;
  session.recorder.onerror = null;
  session.recorder.onstop = null;
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
  } catch (error) {
    // Cancellation discards the result; still finish cleanup if the encoder failed.
    if (!session.cancelRequested) throw error;
  } finally {
    releaseDirectRecordingCapture(session);
  }
}
