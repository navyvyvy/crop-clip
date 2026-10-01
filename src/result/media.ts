import { putPart } from "../shared/idb.js";
import { RECORDING_FORMAT, type RecordingFormat, type RecordingPartRecord } from "../shared/types.js";
import { MILLISECONDS_PER_SECOND, TIME_STEP_SECONDS } from "../shared/time_range.js";

export type LoadedPart = RecordingPartRecord & ({ blob: Blob } | { objectUrl: string });

const MP4_MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  'video/mp4;codecs="avc1,mp4a.40.2"',
  "video/mp4",
];

const WEBM_MIME_CANDIDATES = [
  "video/webm;codecs=avc1",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
];

const MEDIA_EVENT_TIMEOUT_MS = 15_000;

export const MEDIA_SEEK_TOLERANCE_SECONDS = TIME_STEP_SECONDS / 2;

const DURATION_PROBE_DELAY_MS = 500;

export function createObjectUrlSource(source: Blob | string): { url: string; revoke: boolean } {
  return typeof source === "string"
    ? { url: source, revoke: false }
    : { url: URL.createObjectURL(source), revoke: true };
}

export function releaseVideoSource(video: HTMLVideoElement, url: string, revoke: boolean): void {
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.remove();
  if (revoke) {
    URL.revokeObjectURL(url);
  }
}

export function getPartSource(part: LoadedPart): Blob | string {
  if (part.blob instanceof Blob) {
    return part.blob;
  }
  if (!part.objectUrl) {
    throw new Error("녹화 파일 URL이 비어 있습니다.");
  }
  return part.objectUrl;
}

export async function getSourceBytes(source: Blob | string): Promise<Uint8Array> {
  const data = source instanceof Blob
    ? await source.arrayBuffer()
    : await (await fetch(source)).arrayBuffer();
  return new Uint8Array(data);
}

export function pickRecorderMimeType(format: RecordingFormat, preferred = ""): string {
  const preferredCandidates = preferred.includes(format) ? [preferred] : [];
  const candidates = format === RECORDING_FORMAT.mp4
    ? [...preferredCandidates, ...MP4_MIME_CANDIDATES]
    : [...preferredCandidates, ...WEBM_MIME_CANDIDATES];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  throw new Error(format === RECORDING_FORMAT.mp4
    ? "이 브라우저에서는 MP4 다운로드를 지원하지 않습니다."
    : "이 브라우저에서는 WebM 다운로드를 지원하지 않습니다.");
}

export function waitForMediaEvent(video: HTMLVideoElement, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("영상 파일 응답을 기다리는 시간이 초과되었습니다."));
    }, MEDIA_EVENT_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("영상 파일을 읽지 못했습니다."));
    };
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return waitForMediaEvent(video, "loadedmetadata");
}

async function resolveVideoDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }

  try {
    video.currentTime = Number.MAX_SAFE_INTEGER;
    await new Promise(resolve => window.setTimeout(resolve, DURATION_PROBE_DELAY_MS));
    video.currentTime = 0;
  } catch {
    // Some recorded WebM files do not expose duration until after a seek attempt.
  }

  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

export async function hydratePart(part: RecordingPartRecord): Promise<LoadedPart> {
  if (part.blob instanceof Blob) {
    return part as LoadedPart;
  }

  if (part.objectUrl) {
    const response = await fetch(part.objectUrl);
    if (!response.ok) {
      throw new Error("녹화 파일을 불러오지 못했습니다.");
    }

    const blob = await response.blob();
    const { objectUrl, ...storedPart } = part;
    const hydrated = { ...storedPart, blob } as LoadedPart;
    try {
      await putPart(hydrated);
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Keep the source URL alive if the durable Blob copy could not be stored.
    }
    return hydrated;
  }

  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(part.dataUrl ?? "");
  if (!match) {
    throw new Error("녹화 파일 데이터가 비어 있습니다.");
  }

  const mimeType = match[1] || part.mimeType;
  const body = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) {
    bytes[index] = body.charCodeAt(index);
  }

  const { dataUrl: _dataUrl, ...storedPart } = part;
  const hydrated = {
    ...storedPart,
    blob: new Blob([bytes], { type: mimeType }),
  } satisfies LoadedPart;
  await putPart(hydrated).catch(() => {});
  return hydrated;
}

export async function loadVideoForPart(part: LoadedPart, fallbackDuration = 0): Promise<{ video: HTMLVideoElement; url: string; revoke: boolean; duration: number }> {
  const { url, revoke } = createObjectUrlSource(getPartSource(part));
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  video.style.position = "fixed";
  video.style.left = "-9999px";
  video.style.top = "0";
  video.style.width = "1px";
  video.style.height = "1px";
  document.body.appendChild(video);

  try {
    await waitForVideoMetadata(video);
    const duration = await resolveVideoDuration(video) || fallbackDuration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("영상 길이를 확인할 수 없습니다.");
    }

    return { video, url, revoke, duration };
  } catch (error) {
    releaseVideoSource(video, url, revoke);
    throw error;
  }
}

export async function seekVideo(video: HTMLVideoElement, seconds: number): Promise<void> {
  const target = Math.max(0, seconds);
  if (Math.abs(video.currentTime - target) < MEDIA_SEEK_TOLERANCE_SECONDS) {
    return;
  }

  video.currentTime = target;
  await waitForMediaEvent(video, "seeked");
}

export async function recordVideoRange(video: HTMLVideoElement, startSeconds: number, endSeconds: number, mimeType: string): Promise<Blob> {
  if (mimeType.startsWith("video/mp4")) await prepareRecordingEncoder();
  await seekVideo(video, startSeconds);
  const streamSource = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  const stream = streamSource.captureStream?.() ?? streamSource.mozCaptureStream?.();
  if (!stream) {
    throw new Error("브라우저가 결과 영상 분할을 지원하지 않습니다.");
  }

  let recorder: MediaRecorder | undefined;
  let cleanupPlayback = () => {};
  try {
    const activeRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder = activeRecorder;
    const blob = await new Promise<Blob>((resolve, reject) => {
      const chunks: BlobPart[] = [];
      let timeoutId = 0;
      const check = () => {
        if (video.currentTime >= endSeconds || video.ended) {
          video.pause();
          if (activeRecorder.state !== "inactive") activeRecorder.stop();
        }
      };
      const onError = () => reject(new Error("영상 파일을 재생하지 못했습니다."));
      cleanupPlayback = () => {
        video.removeEventListener("timeupdate", check);
        video.removeEventListener("error", onError);
        window.clearTimeout(timeoutId);
      };
      activeRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      activeRecorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
      activeRecorder.onerror = () => reject(new Error("영상 파일을 만드는 중 녹화 오류가 발생했습니다."));
      video.addEventListener("timeupdate", check);
      video.addEventListener("error", onError, { once: true });
      activeRecorder.start(MILLISECONDS_PER_SECOND);
      timeoutId = window.setTimeout(() => {
        reject(new Error("영상 구간 처리 시간이 초과되었습니다."));
      }, Math.max(MEDIA_EVENT_TIMEOUT_MS, (endSeconds - startSeconds) * MILLISECONDS_PER_SECOND + MEDIA_EVENT_TIMEOUT_MS));
      void video.play().then(check, reject);
    });
    if (blob.size <= 0) {
      throw new Error("변환된 영상 데이터가 비어 있습니다.");
    }
    return blob;
  } finally {
    cleanupPlayback();
    video.pause();
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") recorder.stop();
    }
    stream.getTracks().forEach((track) => track.stop());
  }
}
