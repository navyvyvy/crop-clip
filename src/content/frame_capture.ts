// Chrome/Edge expose this API outside lib.dom; unsupported browsers use canvas.
type FrameTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type FrameTrackConstructor = new (options: { kind: "video" }) => FrameTrack;

export function getNextRecordingFrameDeadline(frameTime: number, deadline: number, interval: number): number | undefined {
  const elapsed = frameTime - deadline + interval / 8;
  if (elapsed < 0) return undefined;
  // Keep the sampling phase when an input frame arrives between two deadlines.
  return deadline + (Math.floor(elapsed / interval) + 1) * interval;
}

export function createVideoFrameCapture(video: HTMLVideoElement, onError: (error: Error) => void) {
  const Generator = (globalThis as typeof globalThis & { MediaStreamTrackGenerator?: FrameTrackConstructor }).MediaStreamTrackGenerator;
  if (!Generator || typeof VideoFrame === "undefined") return null;
  let track: FrameTrack | undefined;
  let writer: WritableStreamDefaultWriter<VideoFrame>;
  try {
    track = new Generator({ kind: "video" });
    writer = track.writable.getWriter();
  } catch {
    track?.stop();
    return null;
  }
  let source: HTMLVideoElement | null = video;
  let closed = false;
  let pendingFrame: VideoFrame | null = null;
  let lastSourceTimestamp: number | undefined;
  let writing = false;
  return {
    stream: new MediaStream([track]),
    paint(drawFrame: () => HTMLCanvasElement, frameReported = true): boolean {
      if (closed || writing || !source) return false;
      const timestamp = Math.round(performance.now() * 1000);
      let sourceTimestamp: number | undefined;
      try {
        const original = new VideoFrame(source);
        sourceTimestamp = original.timestamp;
        original.close();
      } catch {
        // The playback callback can still report a fresh frame when this timestamp is unavailable.
      }
      if (!frameReported && (sourceTimestamp === undefined || sourceTimestamp === lastSourceTimestamp)) return false;
      // MediaRecorder can lose the source color matrix when fed decoded YUV frames directly.
      const outputFrame = new VideoFrame(drawFrame(), { timestamp });
      lastSourceTimestamp = sourceTimestamp;
      pendingFrame = outputFrame;
      writing = true;
      void writer.write(outputFrame).catch((error: unknown) => {
        if (!closed) onError(error instanceof Error ? error : new Error("녹화 프레임을 전달하지 못했습니다."));
      }).finally(() => {
        outputFrame.close();
        if (pendingFrame === outputFrame) pendingFrame = null;
        writing = false;
      });
      return true;
    },
    close(): void {
      if (closed) return;
      closed = true;
      source = null;
      pendingFrame?.close();
      pendingFrame = null;
      track.stop();
      void writer.abort().catch(() => {}).finally(() => writer.releaseLock());
    },
  };
}
