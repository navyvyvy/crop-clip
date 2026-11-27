import { readMp4Tracks } from "../shared/mp4_boxes.js";
import type { OriginalPlaybackTiming } from "./original_stream.js";

(() => {
  if (typeof MediaSource === "undefined" || typeof SourceBuffer === "undefined") return;

  const MAX_TRACKED_SOURCES = 16;
  const sources = new Map<string, WeakRef<MediaSource>>();
  const codecs = new WeakMap<SourceBuffer, "hevc" | "other">();
  const mp4Buffers = new WeakSet<SourceBuffer>();
  const lastSeek = new WeakMap<HTMLVideoElement, { src: string; startedAt: number }>();
  const createObjectURL = URL.createObjectURL;
  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  const changeType = SourceBuffer.prototype.changeType;
  const appendBuffer = SourceBuffer.prototype.appendBuffer;

  function trackCodec(buffer: SourceBuffer, mimeType: string): void {
    if (/^(video|application)\/mp4\b/i.test(mimeType)) mp4Buffers.add(buffer);
    else mp4Buffers.delete(buffer);
    const name = /\b(hvc1|hev1|avc[13]|h264|vp0[89]|vp[89]|av01)\b/i.exec(mimeType)?.[1].toLowerCase();
    if (name) codecs.set(buffer, name === "hvc1" || name === "hev1" ? "hevc" : "other");
    else if (/^video\//i.test(mimeType) && !/\b(mp4a|opus|vorbis)\b/i.test(mimeType)) codecs.set(buffer, "other");
    else codecs.delete(buffer);
  }

  URL.createObjectURL = function (object): string {
    const url = createObjectURL.call(this, object);
    if (object instanceof MediaSource) {
      sources.set(url, new WeakRef(object));
      if (sources.size > MAX_TRACKED_SOURCES) {
        const oldest = sources.keys().next().value;
        if (oldest !== undefined) sources.delete(oldest);
      }
    }
    return url;
  };

  MediaSource.prototype.addSourceBuffer = function (mimeType): SourceBuffer {
    const buffer = addSourceBuffer.call(this, mimeType);
    trackCodec(buffer, mimeType);
    return buffer;
  };

  if (typeof changeType === "function") {
    SourceBuffer.prototype.changeType = function (mimeType): void {
      changeType.call(this, mimeType);
      trackCodec(this, mimeType);
    };
  }

  SourceBuffer.prototype.appendBuffer = function (input: BufferSource): void {
    appendBuffer.call(this, input);
    if (!mp4Buffers.has(this) || input.byteLength < 8) return;
    const data = ArrayBuffer.isView(input)
      ? new DataView(input.buffer, input.byteOffset, input.byteLength)
      : new DataView(input);
    const firstType = data.getUint32(4);
    // Only inspect MP4 initialization boxes. Media fragments do not carry a track description.
    if (firstType !== 0x66747970 && firstType !== 0x6d6f6f76) return;
    const tracks = readMp4Tracks(data).filter(track => track.kind === 0x76696465);
    if (tracks.length) codecs.set(this, tracks.every(({ codec }) => codec === "hvc1" || codec === "hev1") ? "hevc" : "other");
  };

  document.addEventListener("cropclip-check-playback-codec", event => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;
    const source = sources.get(video.currentSrc)?.deref();
    if (!source) return;
    const tracks = Array.from(source.activeSourceBuffers).map(buffer => codecs.get(buffer));
    if (tracks.includes("hevc") && !tracks.includes("other")) {
      video.dispatchEvent(new Event("cropclip-playback-hevc"));
    }
  });

  document.addEventListener("seeking", event => {
    const video = event.target;
    if (video instanceof HTMLVideoElement) lastSeek.set(video, { src: video.currentSrc, startedAt: performance.now() });
  }, true);

  document.addEventListener("cropclip-read-playback-offset", event => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || video.paused || !video.buffered.length) return;
    const seek = lastSeek.get(video);
    const timing: OriginalPlaybackTiming = { seekStartedAt: seek?.src === video.currentSrc ? seek.startedAt : undefined };
    const source = sources.get(video.currentSrc)?.deref();
    const end = video.buffered.end(video.buffered.length - 1);
    for (const buffer of source?.activeSourceBuffers ?? []) {
      if (buffer.mode !== "segments" || !buffer.buffered.length || !Number.isFinite(buffer.timestampOffset)) continue;
      if (Math.abs(buffer.buffered.end(buffer.buffered.length - 1) - end) < 0.15) {
        timing.offset = buffer.timestampOffset;
        break;
      }
    }
    video.dispatchEvent(new CustomEvent("cropclip-playback-offset", { detail: timing }));
  });
})();
