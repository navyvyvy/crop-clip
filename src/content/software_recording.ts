import type { Settings } from "../shared/types.js";

declare const CROPCLIP_SOFTWARE_RECORDING_SOURCE: string;

export const softwareRecordingEnabled = typeof CROPCLIP_SOFTWARE_RECORDING_SOURCE !== "undefined" && Boolean(CROPCLIP_SOFTWARE_RECORDING_SOURCE);

type ProcessorConstructor = new <T extends VideoFrame | AudioData>(options: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<T> };

export interface SoftwareRecorder {
  state: RecordingState;
  mimeType: string;
  onstart: (() => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
  dispose(): void;
}

type WorkerReply = { type: "ready" } | { type: "started"; mimeType: string } | { type: "chunk"; blob: Blob }
  | { type: "error"; error: string } | { type: "stopped" };

export function canUseSoftwareRecording(video: HTMLVideoElement | null, settings: Settings): boolean {
  return softwareRecordingEnabled && "MediaStreamTrackProcessor" in globalThis && settings.recordingCodec !== "hevc" && !settings.enable60fps
    && video?.videoWidth === 1920 && video.videoHeight === 1080;
}

export async function prepareSoftwareRecorder(stream: MediaStream, width: number, height: number, format: "webm" | "mp4", bitrate: number, cancel: AbortSignal): Promise<SoftwareRecorder | null> {
  if (!softwareRecordingEnabled) return null;
  const Processor = (globalThis as typeof globalThis & { MediaStreamTrackProcessor?: ProcessorConstructor }).MediaStreamTrackProcessor;
  const [video] = stream.getVideoTracks();
  const [audio] = stream.getAudioTracks();
  if (!Processor || !video || cancel.aborted) return null;
  const url = URL.createObjectURL(new Blob([CROPCLIP_SOFTWARE_RECORDING_SOURCE], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(url);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }

  let recorder: SoftwareRecorder | undefined;
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(2_000)]);
  try {
    await new Promise<void>((resolve, reject) => {
      const prepareAborted = () => reject(signal.reason);
      signal.addEventListener("abort", prepareAborted, { once: true });
      worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
        if (data.type === "error" || data.type === "ready") signal.removeEventListener("abort", prepareAborted);
        if (data.type === "ready") resolve();
        else if (data.type === "error") reject(new Error(data.error));
      };
      worker.onerror = () => reject(new Error("녹화 인코더를 준비하지 못했습니다."));
      worker.postMessage({ type: "prepare", width, height, format, bitrate, hasAudio: Boolean(audio) });
    });
    if (cancel.aborted) return null;
    const prepared: SoftwareRecorder = {
      state: "inactive", mimeType: format === "mp4" ? "video/mp4" : "video/x-matroska",
      onstart: null, onstop: null, onerror: null, ondataavailable: null,
      start() {
        const videoStream = new Processor<VideoFrame>({ track: video, maxBufferSize: 2 }).readable;
        const audioStream = audio ? new Processor<AudioData>({ track: audio, maxBufferSize: 12 }).readable : undefined;
        worker.postMessage({ type: "start", tracks: { video: videoStream, audio: audioStream } }, audioStream ? [videoStream, audioStream] : [videoStream]);
        prepared.state = "recording";
      },
      stop() {
        prepared.state = "inactive";
        worker.postMessage({ type: "stop" });
      },
      dispose() {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      },
    };
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (data.type === "started") { prepared.mimeType = data.mimeType; prepared.onstart?.(); }
      else if (data.type === "chunk") prepared.ondataavailable?.({ data: data.blob });
      else if (data.type === "stopped") prepared.onstop?.();
      else if (data.type === "error") prepared.onerror?.();
    };
    worker.onerror = () => prepared.onerror?.();
    recorder = prepared;
    return prepared;
  } catch {
    return null;
  } finally {
    if (!recorder) worker.terminate();
  }
}
