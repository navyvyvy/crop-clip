import type { DirectCropPlacement } from "./crop_layout.js";

// Chrome/Edge expose this API outside lib.dom; unsupported browsers use canvas.
type FrameTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> };
type FrameTrackConstructor = new (options: { kind: "video" }) => FrameTrack;

export function createVideoFrameCapture(video: HTMLVideoElement, width: number, height: number, onError: (error: Error) => void, allowDirectCrop = true) {
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
  let writing = false;
  return {
    stream: new MediaStream([track]),
    paint(placement: DirectCropPlacement, fallback: () => HTMLCanvasElement): void {
      if (closed || writing || !source) return;
      const timestamp = Math.round(performance.now() * 1000);
      let frame: VideoFrame | undefined;
      try {
        // Chroma alignment and letterboxing can require the existing canvas path.
        if (placement.dx !== 0 || placement.dy !== 0 || placement.dw !== width || placement.dh !== height) throw new Error("canvas layout");
        const original = new VideoFrame(source, { timestamp });
        try {
          const rect = original.visibleRect;
          const unchanged = rect?.x === placement.crop.x && rect.y === placement.crop.y
            && rect.width === placement.crop.width && rect.height === placement.crop.height
            && original.displayWidth === width && original.displayHeight === height;
          // Cropped native frames crash Chromium's Linux MP4 encoder; normalize their pixels through canvas.
          if (!allowDirectCrop && !unchanged) throw new Error("canvas crop");
          frame = unchanged ? original
            : new VideoFrame(original, { visibleRect: placement.crop, displayWidth: width, displayHeight: height });
        } finally {
          if (frame !== original) original.close();
        }
        const rect = frame.visibleRect;
        if (!rect || rect.x !== placement.crop.x || rect.y !== placement.crop.y || rect.width !== placement.crop.width || rect.height !== placement.crop.height) {
          throw new Error("unsupported crop");
        }
      } catch {
        frame?.close();
        frame = undefined;
      }
      const outputFrame = frame ?? new VideoFrame(fallback(), { timestamp });
      pendingFrame = outputFrame;
      writing = true;
      void writer.write(outputFrame).catch((error: unknown) => {
        if (!closed) onError(error instanceof Error ? error : new Error("녹화 프레임을 전달하지 못했습니다."));
      }).finally(() => {
        outputFrame.close();
        if (pendingFrame === outputFrame) pendingFrame = null;
        writing = false;
      });
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
