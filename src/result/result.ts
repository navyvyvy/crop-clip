import { getPartsByRecordingId, getRecording } from "../shared/idb.js";
import type { DeletionCancelRequest, DeletionScheduleRequest } from "../shared/messages.js";
import { DEFAULT_SETTINGS, type RecordingPartRecord, type RecordingRecord } from "../shared/types.js";

const params = new URLSearchParams(location.search);
const recordingId = params.get("id") ?? "";
const sourceTabId = Number(params.get("sourceTabId") ?? "");
type OutputFormat = "webm" | "mp4";
type ConvertFormat = OutputFormat | "gif";

const elements = {
  title: document.getElementById("title") as HTMLHeadingElement,
  formatChip: document.getElementById("format-chip") as HTMLDivElement,
  previewVideo: document.getElementById("preview-video") as HTMLVideoElement,
  splitModeSelect: document.getElementById("split-mode-select") as HTMLSelectElement,
  splitFormatSelect: document.getElementById("split-format-select") as HTMLSelectElement,
  splitValueInput: document.getElementById("split-value-input") as HTMLInputElement,
  splitUnitLabel: document.getElementById("split-unit-label") as HTMLSpanElement,
  splitButton: document.getElementById("split-button") as HTMLButtonElement,
  splitStatus: document.getElementById("split-status") as HTMLParagraphElement,
  splitProgress: document.getElementById("split-progress") as HTMLDivElement,
  splitProgressBar: document.getElementById("split-progress-bar") as HTMLDivElement,
  splitDownloads: document.getElementById("split-downloads") as HTMLDivElement,
  splitResultSummary: document.getElementById("split-result-summary") as HTMLElement,
  splitFilesList: document.getElementById("split-files-list") as HTMLDivElement,
  emptyMessage: document.getElementById("empty-message") as HTMLParagraphElement,
  downloadCurrentButton: document.getElementById("download-current-button") as HTMLButtonElement,
  closeButton: document.getElementById("close-button") as HTMLButtonElement,
  convertButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-convert-format]")),
  downloadAllButton: document.getElementById("download-all-button") as HTMLButtonElement,
};

let recording: RecordingRecord | null = null;
type LoadedPart = RecordingPartRecord & ({ blob: Blob } | { objectUrl: string });

let parts: LoadedPart[] = [];
let splitSegments: SplitSegment[] = [];
let previewUrl: string | null = null;
let recordingDurationSeconds = 0;
let splitDefaultRequestId = 0;
let sourceDurationSeconds = 0;
let sourceSizeMegabytes = 0;
let ffmpegLoadPromise: Promise<FfmpegLike> | null = null;
interface SplitSegment {
  blob: Blob;
  filename: string;
  index: number;
  startSeconds: number;
  endSeconds: number;
}

interface FfmpegLike {
  on(event: "progress", callback: (event: { progress?: number; time?: number }) => void): void;
  load(options: { coreURL: string; wasmURL: string }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<unknown>;
  exec(args: string[]): Promise<number>;
  readFile(path: string): Promise<Uint8Array | string>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  deleteFile(path: string): Promise<unknown>;
}

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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  const paddedSeconds = String(remainder).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`
    : `${minutes}:${paddedSeconds}`;
}

function createObjectUrlSource(source: Blob | string): { url: string; revoke: boolean } {
  return typeof source === "string"
    ? { url: source, revoke: false }
    : { url: URL.createObjectURL(source), revoke: true };
}

function getPartSource(part: LoadedPart): Blob | string {
  if (part.blob instanceof Blob) {
    return part.blob;
  }
  if (!part.objectUrl) {
    throw new Error("녹화 파일 URL이 비어 있습니다.");
  }
  return part.objectUrl;
}

function getDownloadIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v10m0 0 4-4m-4 4-4-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5 17.5v1.2c0 .7.6 1.3 1.3 1.3h11.4c.7 0 1.3-.6 1.3-1.3v-1.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    </svg>
  `;
}

async function getSourceBytes(source: Blob | string): Promise<Uint8Array> {
  const data = source instanceof Blob
    ? await source.arrayBuffer()
    : await (await fetch(source)).arrayBuffer();
  return new Uint8Array(data);
}

async function loadFfmpeg(): Promise<FfmpegLike> {
  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      setWorkStatus("변환 엔진을 불러오는 중입니다.");
      const module = await import(chrome.runtime.getURL("vendor/ffmpeg/ffmpeg/index.js")) as { FFmpeg: new () => FfmpegLike };
      const ffmpeg = new module.FFmpeg();
      ffmpeg.on("progress", ({ progress }) => {
        if (typeof progress === "number" && Number.isFinite(progress)) {
          elements.splitProgress.hidden = false;
          elements.splitProgressBar.style.width = `${Math.max(0, Math.min(100, Math.round(progress * 100)))}%`;
        }
      });
      await ffmpeg.load({
        coreURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.js"),
        wasmURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.wasm"),
      });
      return ffmpeg;
    })();
  }

  return ffmpegLoadPromise;
}

async function deleteFfmpegFile(ffmpeg: FfmpegLike, name: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(name);
  } catch {
    // Missing temp files are fine.
  }
}

async function clearFfmpegOutputs(ffmpeg: FfmpegLike): Promise<void> {
  try {
    const files = await ffmpeg.listDir(".");
    await Promise.all(files
      .filter((file) => !file.isDir && (file.name === "input.webm" || file.name === "input.mp4" || file.name.startsWith("output")))
      .map((file) => deleteFfmpegFile(ffmpeg, file.name)));
  } catch {
    // Best-effort cleanup only.
  }
}

async function readFfmpegBlob(ffmpeg: FfmpegLike, filename: string, mimeType: string): Promise<Blob> {
  const data = await ffmpeg.readFile(filename);
  if (typeof data === "string") {
    return new Blob([data], { type: mimeType });
  }

  return new Blob([data.slice().buffer], { type: mimeType });
}

function getConvertedMimeType(format: ConvertFormat): string {
  return format === "gif" ? "image/gif" : `video/${format}`;
}

async function convertPartWithFfmpeg(part: LoadedPart, outputFormat: ConvertFormat): Promise<{ source: Blob; filename: string }> {
  const ffmpeg = await loadFfmpeg();
  const inputName = `input.${part.extension}`;
  const outputName = `output.${outputFormat}`;
  await clearFfmpegOutputs(ffmpeg);
  try {
    await ffmpeg.writeFile(inputName, await getSourceBytes(getPartSource(part)));
    const args = outputFormat === "gif"
      ? ["-i", inputName, "-an", outputName]
      : ["-i", inputName, "-c", "copy", outputName];
    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      throw new Error("빠른 변환에 실패했습니다.");
    }
    const blob = await readFfmpegBlob(ffmpeg, outputName, getConvertedMimeType(outputFormat));
    return { source: blob, filename: `${getFilenameBase(part.filename)}.${outputFormat}` };
  } finally {
    await clearFfmpegOutputs(ffmpeg);
  }
}

function getFilenameBase(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function pickRecorderMimeType(format: OutputFormat, preferred = ""): string {
  const preferredCandidates = preferred.includes(format) ? [preferred] : [];
  const candidates = format === "mp4"
    ? [...preferredCandidates, ...MP4_MIME_CANDIDATES]
    : [...preferredCandidates, ...WEBM_MIME_CANDIDATES];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  throw new Error(format === "mp4"
    ? "이 브라우저에서는 MP4 다운로드를 지원하지 않습니다."
    : "이 브라우저에서는 WebM 다운로드를 지원하지 않습니다.");
}

function waitForEvent(target: EventTarget, eventName: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(eventName, () => resolve(), { once: true });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }

  return waitForEvent(video, "loadedmetadata");
}

async function resolveVideoDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }

  try {
    video.currentTime = Number.MAX_SAFE_INTEGER;
    await delay(500);
    video.currentTime = 0;
  } catch {
    // Some recorded WebM files do not expose duration until after a seek attempt.
  }

  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function getRecordingDurationFallback(): number {
  if (!recording) {
    return 0;
  }

  const seconds = (recording.endedAt - recording.createdAt) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

async function hydratePart(part: RecordingPartRecord): Promise<LoadedPart> {
  if (part.blob instanceof Blob) {
    return part as LoadedPart;
  }

  if (part.objectUrl) {
    return part as LoadedPart;
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

  return {
    ...part,
    blob: new Blob([bytes], { type: mimeType }),
  };
}

function getSelectedSourcePart(): LoadedPart | undefined {
  return parts[0];
}

function setSplitBusy(isBusy: boolean): void {
  elements.splitButton.disabled = isBusy || parts.length === 0;
  elements.splitModeSelect.disabled = isBusy || parts.length === 0;
  elements.splitFormatSelect.disabled = isBusy || parts.length === 0;
  elements.splitValueInput.disabled = isBusy;
  for (const button of elements.convertButtons) {
    button.disabled = isBusy || parts.length === 0;
  }
  elements.downloadAllButton.disabled = isBusy || splitSegments.length === 0;
}

function clearSplitResults(): void {
  splitSegments = [];
  renderSplitDownloads();
}

function renderSplitMode(): void {
  const mode = elements.splitModeSelect.value;
  elements.splitUnitLabel.textContent = mode === "duration" ? "초" : "MB";
  elements.splitStatus.textContent = mode === "duration"
    ? "시간 기준으로 나눕니다."
    : "용량 기준으로 나눕니다.";
  applySplitValueDefault();
}

function renderSplitResults(segments: SplitSegment[]): void {
  splitSegments = segments;
  renderSplitDownloads();
}

function setSplitProgress(done: number, total: number): void {
  elements.splitProgress.hidden = false;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  elements.splitProgressBar.style.width = `${percent}%`;
}

function hideSplitProgress(): void {
  elements.splitProgress.hidden = true;
  elements.splitProgressBar.style.width = "0";
}

function setWorkStatus(message: string): void {
  elements.splitStatus.textContent = message;
}

function applySplitValueDefault(): void {
  const value = elements.splitModeSelect.value === "size"
    ? Math.max(1, Math.ceil(sourceSizeMegabytes))
    : Math.max(1, Math.ceil(sourceDurationSeconds || recordingDurationSeconds || getRecordingDurationFallback()));
  elements.splitValueInput.value = String(value);
  elements.splitValueInput.max = String(value);
}

async function updateSplitDefaultValues(part: LoadedPart | undefined = getSelectedSourcePart()): Promise<void> {
  if (!part) {
    return;
  }

  const requestId = ++splitDefaultRequestId;
  sourceSizeMegabytes = Math.max(1, Math.ceil(part.size / 1024 / 1024));
  applySplitValueDefault();

  let loaded: Awaited<ReturnType<typeof loadVideoForPart>> | null = null;
  try {
    loaded = await loadVideoForPart(part);
    if (requestId === splitDefaultRequestId) {
      const durationSeconds = Math.max(1, Math.ceil(loaded.duration));
      sourceDurationSeconds = durationSeconds;
      applySplitValueDefault();
    }
  } catch {
    const fallback = recordingDurationSeconds || getRecordingDurationFallback();
    if (requestId === splitDefaultRequestId && fallback > 0) {
      const durationSeconds = Math.max(1, Math.ceil(fallback));
      sourceDurationSeconds = durationSeconds;
      applySplitValueDefault();
    }
  } finally {
    loaded?.video.remove();
    if (loaded?.revoke) {
      URL.revokeObjectURL(loaded.url);
    }
  }
}

async function loadVideoForPart(part: LoadedPart): Promise<{ video: HTMLVideoElement; url: string; revoke: boolean; duration: number }> {
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

  await waitForVideoMetadata(video);
  const duration = await resolveVideoDuration(video) || getRecordingDurationFallback();
  if (!Number.isFinite(duration) || duration <= 0) {
    video.remove();
    if (revoke) {
      URL.revokeObjectURL(url);
    }
    throw new Error("영상 길이를 확인할 수 없습니다.");
  }

  return { video, url, revoke, duration };
}

async function seekVideo(video: HTMLVideoElement, seconds: number): Promise<void> {
  const target = Math.max(0, seconds);
  if (Math.abs(video.currentTime - target) < 0.05) {
    return;
  }

  video.currentTime = target;
  await waitForEvent(video, "seeked");
}

async function recordVideoRange(video: HTMLVideoElement, startSeconds: number, endSeconds: number, mimeType: string): Promise<Blob> {
  await seekVideo(video, startSeconds);
  const streamSource = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  const stream = streamSource.captureStream?.() ?? streamSource.mozCaptureStream?.();
  if (!stream) {
    throw new Error("브라우저가 결과 영상 분할을 지원하지 않습니다.");
  }

  const chunks: BlobPart[] = [];
  const options = mimeType ? { mimeType } : undefined;
  const recorder = new MediaRecorder(stream, options);
  const stopped = new Promise<Blob>((resolve) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    };
  });

  try {
    recorder.start(1_000);
    await video.play();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (video.currentTime >= endSeconds || video.ended) {
          video.removeEventListener("timeupdate", check);
          resolve();
        }
      };
      video.addEventListener("timeupdate", check);
      window.setTimeout(check, Math.max(250, (endSeconds - startSeconds) * 1000 + 500));
    });
    video.pause();
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    return await stopped;
  } finally {
    video.pause();
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    stream.getTracks().forEach((track) => track.stop());
  }
}

async function createDurationSplitWithRecorder(part: LoadedPart, segmentSeconds: number, outputFormat: OutputFormat): Promise<SplitSegment[]> {
  const { video, url, revoke, duration } = await loadVideoForPart(part);
  const mimeType = pickRecorderMimeType(outputFormat, part.mimeType);
  const segments: SplitSegment[] = [];

  try {
    if (segmentSeconds >= duration) {
      throw new Error("나누기 시간은 원본 영상 시간보다 짧아야 합니다.");
    }

    const total = Math.ceil(duration / segmentSeconds);
    setSplitProgress(0, total);
    for (let index = 0; index < total; index += 1) {
      const start = index * segmentSeconds;
      const end = Math.min(duration, start + segmentSeconds);
      elements.splitStatus.textContent = `${index + 1}/${total}번째 파일을 만드는 중입니다.`;
      const blob = await recordVideoRange(video, start, end, mimeType);
      segments.push({
        blob,
        filename: `${getFilenameBase(part.filename)}_split_${String(index + 1).padStart(3, "0")}.${outputFormat}`,
        index: index + 1,
        startSeconds: start,
        endSeconds: end,
      });
      setSplitProgress(index + 1, total);
    }
  } finally {
    video.remove();
    if (revoke) {
      URL.revokeObjectURL(url);
    }
  }

  return segments;
}

async function createDurationSplitWithFfmpeg(part: LoadedPart, segmentSeconds: number, outputFormat: OutputFormat): Promise<SplitSegment[]> {
  const { video, url, revoke, duration } = await loadVideoForPart(part);
  video.remove();
  if (revoke) {
    URL.revokeObjectURL(url);
  }
  if (segmentSeconds >= duration) {
    throw new Error("나누기 시간은 원본 영상 시간보다 짧아야 합니다.");
  }

  const ffmpeg = await loadFfmpeg();
  const inputName = `input.${part.extension}`;
  await clearFfmpegOutputs(ffmpeg);
  try {
    await ffmpeg.writeFile(inputName, await getSourceBytes(getPartSource(part)));
    const pattern = `output%03d.${outputFormat}`;
    const code = await ffmpeg.exec([
      "-i", inputName,
      "-map", "0",
      "-f", "segment",
      "-segment_time", String(segmentSeconds),
      "-c", "copy",
      "-reset_timestamps", "1",
      pattern,
    ]);
    if (code !== 0) {
      throw new Error("빠른 파일 나누기에 실패했습니다.");
    }

    const files = (await ffmpeg.listDir("."))
      .filter((file) => !file.isDir && file.name.startsWith("output") && file.name.endsWith(`.${outputFormat}`))
      .sort((a, b) => a.name.localeCompare(b.name));
    const segments: SplitSegment[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const start = index * segmentSeconds;
      const end = Math.min(duration, start + segmentSeconds);
      segments.push({
        blob: await readFfmpegBlob(ffmpeg, files[index].name, `video/${outputFormat}`),
        filename: `${getFilenameBase(part.filename)}_split_${String(index + 1).padStart(3, "0")}.${outputFormat}`,
        index: index + 1,
        startSeconds: start,
        endSeconds: end,
      });
      setSplitProgress(index + 1, files.length);
    }
    return segments;
  } finally {
    await clearFfmpegOutputs(ffmpeg);
  }
}

async function createDurationSplit(part: LoadedPart, segmentSeconds: number, outputFormat: OutputFormat): Promise<SplitSegment[]> {
  try {
    return await createDurationSplitWithFfmpeg(part, segmentSeconds, outputFormat);
  } catch {
    return await createDurationSplitWithRecorder(part, segmentSeconds, outputFormat);
  }
}

async function createSizeSplit(part: LoadedPart, maxMegabytes: number, outputFormat: OutputFormat): Promise<SplitSegment[]> {
  const { video, url, revoke, duration } = await loadVideoForPart(part);
  video.remove();
  if (revoke) {
    URL.revokeObjectURL(url);
  }

  const maxBytes = maxMegabytes * 1024 * 1024;
  if (maxBytes >= part.size) {
    throw new Error("나누기 용량은 원본 파일 용량보다 작아야 합니다.");
  }

  const averageBytesPerSecond = Math.max(1, part.size / duration);
  const segmentSeconds = Math.max(1, Math.floor(maxBytes / averageBytesPerSecond));
  return await createDurationSplit(part, segmentSeconds, outputFormat);
}

async function convertPartWithRecorder(part: LoadedPart, outputFormat: OutputFormat): Promise<{ source: Blob | string; filename: string }> {
  if (part.extension === outputFormat) {
    return { source: getPartSource(part), filename: part.filename };
  }

  const { video, url, revoke, duration } = await loadVideoForPart(part);
  try {
    const mimeType = pickRecorderMimeType(outputFormat, part.mimeType);
    const blob = await recordVideoRange(video, 0, duration, mimeType);
    return { source: blob, filename: `${getFilenameBase(part.filename)}.${outputFormat}` };
  } finally {
    video.remove();
    if (revoke) {
      URL.revokeObjectURL(url);
    }
  }
}

async function convertPart(part: LoadedPart, outputFormat: ConvertFormat): Promise<{ source: Blob | string; filename: string }> {
  if (part.extension === outputFormat) {
    return { source: getPartSource(part), filename: part.filename };
  }

  try {
    return await convertPartWithFfmpeg(part, outputFormat);
  } catch {
    if (outputFormat === "gif") {
      throw new Error(`${outputFormat.toUpperCase()} 변환에 실패했습니다.`);
    }
    return await convertPartWithRecorder(part, outputFormat);
  }
}

function revokePreviewUrl(): void {
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
}

function setPreviewFromPart(part: LoadedPart | undefined): void {
  revokePreviewUrl();
  if (!part) {
    elements.previewVideo.removeAttribute("src");
    elements.previewVideo.load();
    return;
  }

  const source = createObjectUrlSource(getPartSource(part));
  previewUrl = source.revoke ? source.url : null;
  elements.previewVideo.src = source.url;
  elements.previewVideo.load();
}

function buildRecordingFromParts(recordingId: string, loadedParts: LoadedPart[]): RecordingRecord | null {
  const firstPart = loadedParts[0];
  if (!firstPart) {
    return null;
  }

  return {
    id: recordingId,
    createdAt: firstPart.createdAt,
    endedAt: Date.now(),
    settings: DEFAULT_SETTINGS,
    region: {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      devicePixelRatio: 1,
      selectedAt: firstPart.createdAt,
    },
    partCount: loadedParts.length,
    totalSize: loadedParts.reduce((sum, part) => sum + part.size, 0),
    actualMimeType: firstPart.mimeType,
    actualExtension: firstPart.extension,
    requestedOutputFormat: firstPart.outputFormat,
    actualOutputFormat: firstPart.outputFormat,
  };
}

function renderHeader(): void {
  if (!recording) {
    return;
  }

  elements.title.textContent = "녹화 결과";
  const duration = recordingDurationSeconds || getRecordingDurationFallback();
  const summary = `${recording.actualExtension.toUpperCase()} · ${formatBytes(recording.totalSize)} · ${formatDuration(duration)}`;
  elements.formatChip.textContent = summary;
}

function renderActions(): void {
  if (!recording || parts.length === 0) {
    elements.downloadCurrentButton.disabled = true;
    for (const button of elements.convertButtons) {
      button.disabled = true;
    }
    elements.downloadAllButton.disabled = true;
    return;
  }

  elements.downloadCurrentButton.disabled = false;
  elements.downloadAllButton.disabled = splitSegments.length === 0;
}

function renderSplitDownloads(): void {
  elements.splitFilesList.innerHTML = "";
  elements.splitDownloads.hidden = splitSegments.length === 0;
  elements.splitResultSummary.textContent = `나눈 파일 (${splitSegments.length}개)`;

  for (const segment of splitSegments) {
    const chip = document.createElement("article");
    chip.className = "split-chip";

    const index = document.createElement("span");
    index.className = "split-chip-index";
    index.textContent = String(segment.index);

    const meta = document.createElement("span");
    meta.className = "split-chip-meta";
    meta.textContent = `${formatDuration(segment.startSeconds)} - ${formatDuration(segment.endSeconds)} · ${formatBytes(segment.blob.size)}`;

    const button = document.createElement("button");
    button.className = "button primary icon-button";
    button.type = "button";
    button.innerHTML = getDownloadIconSvg();
    button.title = "다운로드";
    button.setAttribute("aria-label", `${segment.index}번 파일 다운로드`);
    button.addEventListener("click", () => {
      const { url, revoke } = createObjectUrlSource(segment.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = segment.filename;
      anchor.rel = "noopener";
      anchor.click();
      if (revoke) {
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
    });

    chip.append(index, meta, button);
    elements.splitFilesList.appendChild(chip);
  }

  renderActions();
}

function renderParts(): void {
  if (!recording) {
    return;
  }

  if (parts.length === 0) {
    elements.emptyMessage.textContent = "녹화 파일을 찾지 못했습니다.";
    renderActions();
    return;
  }

  elements.emptyMessage.textContent = "";
  elements.splitFormatSelect.value = "mp4";
  renderSplitMode();
  setPreviewFromPart(parts[0]);
  void updateSplitDefaultValues(parts[0]);
  renderSplitDownloads();

  renderActions();
  setSplitBusy(false);
}

async function downloadSourcesSequentially(items: Array<{ source: Blob | string; filename: string }>): Promise<void> {
  for (const item of items) {
    const { url, revoke } = createObjectUrlSource(item.source);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = item.filename;
    anchor.rel = "noopener";
    anchor.click();
    if (revoke) {
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  }
}

async function scheduleDeletionOnClose(): Promise<void> {
  if (!recording) {
    return;
  }

  const message: DeletionScheduleRequest = {
    type: "SCHEDULE_RECORDING_DELETION",
    recordingId: recording.id,
  };

  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // The service worker may already be asleep.
  }
}

async function boot(): Promise<void> {
  if (!recordingId) {
    elements.emptyMessage.textContent = "녹화 ID가 없습니다.";
    elements.downloadCurrentButton.disabled = true;
    for (const button of elements.convertButtons) {
      button.disabled = true;
    }
    elements.downloadAllButton.disabled = true;
    return;
  }

  for (let attempt = 0; attempt < 120; attempt += 1) {
    recording = await getRecording(recordingId) ?? null;
    parts = await Promise.all((await getPartsByRecordingId(recordingId)).map(hydratePart));
    recordingDurationSeconds = getRecordingDurationFallback();
    if (recording) {
      break;
    }
    elements.emptyMessage.textContent = "녹화 파일을 저장 중입니다.";
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }

  recording = recording ?? buildRecordingFromParts(recordingId, parts);
  recordingDurationSeconds = getRecordingDurationFallback();

  if (!recording) {
    elements.emptyMessage.textContent = "녹화 데이터를 찾지 못했습니다.";
    setPreviewFromPart(undefined);
    elements.downloadCurrentButton.disabled = true;
    for (const button of elements.convertButtons) {
      button.disabled = true;
    }
    elements.downloadAllButton.disabled = true;
    return;
  }

  await chrome.runtime.sendMessage({ type: "CANCEL_RECORDING_DELETION", recordingId: recording.id } satisfies DeletionCancelRequest);
  renderHeader();
  renderParts();
}

elements.downloadCurrentButton.addEventListener("click", () => {
  void downloadSourcesSequentially(parts.map((part) => ({ source: getPartSource(part), filename: part.filename })));
});

elements.closeButton.addEventListener("click", () => {
  if (Number.isFinite(sourceTabId) && sourceTabId > 0) {
    void chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
  }
  window.close();
});

for (const button of elements.convertButtons) {
  button.addEventListener("click", () => {
    void (async () => {
      setSplitBusy(true);
      setSplitProgress(0, Math.max(1, parts.length));
      try {
        const outputFormat = (button.dataset.convertFormat ?? "mp4") as ConvertFormat;
        setWorkStatus(`${outputFormat.toUpperCase()} 변환 중입니다.`);
        const items: Array<{ source: Blob | string; filename: string }> = [];
        for (const [index, part] of parts.entries()) {
          items.push(await convertPart(part, outputFormat));
          setSplitProgress(index + 1, parts.length);
        }
        await downloadSourcesSequentially(items);
        setWorkStatus(`${outputFormat.toUpperCase()} 변환이 완료되었습니다.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "파일을 변환하지 못했습니다.";
        window.alert(message);
      } finally {
        hideSplitProgress();
        setSplitBusy(false);
      }
    })();
  });
}

elements.downloadAllButton.addEventListener("click", () => {
  void downloadSourcesSequentially(splitSegments.map((segment) => ({ source: segment.blob, filename: segment.filename })));
});

elements.previewVideo.addEventListener("loadedmetadata", () => {
  if (Number.isFinite(elements.previewVideo.duration) && elements.previewVideo.duration > 0) {
    recordingDurationSeconds = elements.previewVideo.duration;
    renderHeader();
  }
});

elements.splitModeSelect.addEventListener("change", () => {
  renderSplitMode();
});

elements.splitButton.addEventListener("click", () => {
  void (async () => {
    const part = getSelectedSourcePart();
    if (!part) {
      elements.splitStatus.textContent = "나눌 원본 파일이 없습니다.";
      return;
    }

    clearSplitResults();
    setSplitBusy(true);
    try {
      const mode = elements.splitModeSelect.value;
      const outputFormat = elements.splitFormatSelect.value === "mp4" ? "mp4" : "webm";
      const splitValue = Math.max(1, Number(elements.splitValueInput.value || 1));
      const segments = mode === "size"
        ? await createSizeSplit(part, splitValue, outputFormat)
        : await createDurationSplit(part, splitValue, outputFormat);

      renderSplitResults(segments);
      setWorkStatus("파일 나누기가 완료되었습니다.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "파일을 나누지 못했습니다.";
      elements.splitStatus.textContent = message;
      window.alert(message);
    } finally {
      hideSplitProgress();
      setSplitBusy(false);
    }
  })();
});

window.addEventListener("pagehide", () => {
  void scheduleDeletionOnClose();
});

window.addEventListener("beforeunload", () => {
  void scheduleDeletionOnClose();
});

window.addEventListener("unload", () => {
  revokePreviewUrl();
  clearSplitResults();
});

void boot().catch((error: Error) => {
  elements.emptyMessage.textContent = error.message;
});
