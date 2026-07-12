import { getPartsByRecordingId, getRecording, putPart, putRecording } from "../shared/idb.js";
import type { DeletionCancelRequest, DeletionScheduleRequest } from "../shared/messages.js";
import {
  estimateRangeSize,
  isFullTimeRange,
  normalizeTimeRange,
  parseTimeInput,
  snapTimeRangeValue,
  updateTimeRangeHandle,
  type TimeRange,
  type TimeRangeHandle,
} from "../shared/time_range.js";
import { RECORDING_FORMAT, type RecordingFormat, type RecordingPartRecord, type RecordingRecord } from "../shared/types.js";

const params = new URLSearchParams(location.search);
const recordingId = params.get("id") ?? "";
const sourceTabId = Number(params.get("sourceTabId") ?? "");
type OutputFormat = RecordingFormat;
type ConvertFormat = OutputFormat | "gif";

const elements = {
  resultLoading: document.getElementById("result-loading") as HTMLDivElement,
  resultLoadingMessage: document.getElementById("result-loading-message") as HTMLSpanElement,
  title: document.getElementById("title") as HTMLHeadingElement,
  formatChip: document.getElementById("format-chip") as HTMLDivElement,
  previewVideo: document.getElementById("preview-video") as HTMLVideoElement,
  trimTimeline: document.getElementById("trim-timeline") as HTMLDivElement,
  trimThumbnails: document.getElementById("trim-thumbnails") as HTMLDivElement,
  trimStartRange: document.getElementById("trim-start-range") as HTMLInputElement,
  trimEndRange: document.getElementById("trim-end-range") as HTMLInputElement,
  trimStartInput: document.getElementById("trim-start-input") as HTMLInputElement,
  trimEndInput: document.getElementById("trim-end-input") as HTMLInputElement,
  trimStartDecreaseButton: document.getElementById("trim-start-decrease-button") as HTMLButtonElement,
  trimStartIncreaseButton: document.getElementById("trim-start-increase-button") as HTMLButtonElement,
  trimEndDecreaseButton: document.getElementById("trim-end-decrease-button") as HTMLButtonElement,
  trimEndIncreaseButton: document.getElementById("trim-end-increase-button") as HTMLButtonElement,
  trimStartBubble: document.getElementById("trim-start-bubble") as HTMLOutputElement,
  trimEndBubble: document.getElementById("trim-end-bubble") as HTMLOutputElement,
  trimDurationValue: document.getElementById("trim-duration-value") as HTMLElement,
  captureFrameButton: document.getElementById("capture-frame-button") as HTMLButtonElement,
  trimResetButton: document.getElementById("trim-reset-button") as HTMLButtonElement,
  splitModeSelect: document.getElementById("split-mode-select") as HTMLSelectElement,
  splitFormatSelect: document.getElementById("split-format-select") as HTMLSelectElement,
  splitValueInput: document.getElementById("split-value-input") as HTMLInputElement,
  splitValueDecreaseButton: document.getElementById("split-value-decrease-button") as HTMLButtonElement,
  splitValueIncreaseButton: document.getElementById("split-value-increase-button") as HTMLButtonElement,
  splitUnitLabel: document.getElementById("split-unit-label") as HTMLSpanElement,
  splitPresetButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-split-value]")),
  splitButton: document.getElementById("split-button") as HTMLButtonElement,
  splitStatus: document.getElementById("split-status") as HTMLParagraphElement,
  splitProgress: document.getElementById("split-progress") as HTMLDivElement,
  splitProgressBar: document.getElementById("split-progress-bar") as HTMLDivElement,
  splitDownloads: document.getElementById("split-downloads") as HTMLDivElement,
  splitResultSummary: document.getElementById("split-result-summary") as HTMLElement,
  splitFilesList: document.getElementById("split-files-list") as HTMLDivElement,
  emptyMessage: document.getElementById("empty-message") as HTMLParagraphElement,
  downloadOriginalButton: document.getElementById("download-original-button") as HTMLButtonElement,
  downloadCurrentButton: document.getElementById("download-current-button") as HTMLButtonElement,
  downloadCurrentLabel: document.getElementById("download-current-label") as HTMLSpanElement,
  closeButton: document.getElementById("close-button") as HTMLButtonElement,
  convertButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-convert-format]")),
  speedSelect: document.getElementById("speed-select") as HTMLSelectElement,
  speedSaveControl: document.getElementById("speed-save-control") as HTMLSpanElement,
  speedConvertButton: document.getElementById("speed-convert-button") as HTMLButtonElement,
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
let ffmpegProgressBase = 0;
let trimStartSeconds = 0;
let trimEndSeconds = 0;
let workBusy = false;
let thumbnailRequestId = 0;
let thumbnailUrls: string[] = [];
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
const RESULT_LOAD_MAX_ATTEMPTS = 120;
const RESULT_LOAD_RETRY_MS = 500;
const DOWNLOAD_URL_REVOKE_DELAY_MS = 1_000;
const SEQUENTIAL_DOWNLOAD_DELAY_MS = 350;
const SEEK_METADATA_VERSION = 1;
const TRIM_STEP_SECONDS = 0.1;
const MEDIA_EVENT_TIMEOUT_MS = 15_000;
const FFMPEG_EXEC_PROGRESS_MAX = 92;
const MAX_TIMELINE_THUMBNAILS = 24;
const MIN_TIMELINE_THUMBNAILS = 6;
const TIMELINE_THUMBNAIL_INTERVAL_SECONDS = 3;
const TIMELINE_THUMBNAIL_DISPLAY_WIDTH = 72;
const TIMELINE_THUMBNAIL_WIDTH = 160;
const TIMELINE_THUMBNAIL_HEIGHT = 90;

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

function formatPreciseDuration(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalTenths = Math.round(safeSeconds * 10);
  const hours = Math.floor(totalTenths / 36_000);
  const minutes = Math.floor((totalTenths % 36_000) / 600);
  const remainder = (totalTenths % 600) / 10;
  const secondsText = remainder.toFixed(1).padStart(4, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secondsText}`
    : `${minutes}:${secondsText}`;
}

function formatTimeInput(seconds: number): string {
  const precise = formatPreciseDuration(seconds);
  return precise.endsWith(".0") ? precise.slice(0, -2) : precise;
}

function formatSecondsLabel(seconds: number): string {
  return seconds < 60 ? `${roundTrimTime(seconds).toFixed(1)}초` : formatTimeInput(seconds);
}

function roundTrimTime(seconds: number): number {
  return Number((Math.round(seconds / TRIM_STEP_SECONDS) * TRIM_STEP_SECONDS).toFixed(1));
}

function getFullSourceDuration(): number {
  return sourceDurationSeconds || recordingDurationSeconds || getRecordingDurationFallback();
}

function getSelectedTimeRange(duration = getFullSourceDuration()): TimeRange {
  const end = trimEndSeconds > 0 ? trimEndSeconds : duration;
  return normalizeTimeRange(trimStartSeconds, end, duration);
}

function getActiveTimeRange(duration = getFullSourceDuration()): TimeRange | undefined {
  const range = getSelectedTimeRange(duration);
  return isFullTimeRange(range, duration) ? undefined : range;
}

function getSelectedSourceSizeBytes(): number {
  const totalBytes = parts[0]?.size ?? recording?.totalSize ?? 0;
  const duration = getFullSourceDuration();
  return estimateRangeSize(totalBytes, getSelectedTimeRange(duration), duration);
}

function getRangeFilename(part: LoadedPart, extension: string, range?: TimeRange): string {
  const base = getFilenameBase(part.filename);
  if (!range) {
    return `${base}.${extension}`;
  }
  const start = String(roundTrimTime(range.start)).replace(".", "_");
  const end = String(roundTrimTime(range.end)).replace(".", "_");
  return `${base}_trim_${start}s-${end}s.${extension}`;
}

function getSpeedFilename(part: LoadedPart, speed: number, range?: TimeRange): string {
  const base = getRangeFilename(part, RECORDING_FORMAT.mp4, range).replace(/\.mp4$/i, "");
  return `${base}_speed_${String(speed).replace(".", "_")}x.mp4`;
}

function getStreamerNameFromFilename(): string {
  const filename = parts[0]?.filename ?? "";
  const match = filename.match(/^(.+)_\d{8}_\d{6}/);
  const name = match?.[1]?.replace(/_/g, " ").trim() ?? "";
  return name && name !== "cropClip" ? name : "";
}

function createObjectUrlSource(source: Blob | string): { url: string; revoke: boolean } {
  return typeof source === "string"
    ? { url: source, revoke: false }
    : { url: URL.createObjectURL(source), revoke: true };
}

function releaseVideoSource(video: HTMLVideoElement, url: string, revoke: boolean): void {
  video.remove();
  if (revoke) {
    URL.revokeObjectURL(url);
  }
}

function downloadSource(source: Blob | string, filename: string): void {
  const { url, revoke } = createObjectUrlSource(source);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.click();
  if (revoke) {
    window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
  }
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

function setProgressPercent(percent: number): void {
  elements.splitProgress.hidden = false;
  elements.splitProgressBar.style.width = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
}

function setFfmpegProgressBase(percent: number): void {
  ffmpegProgressBase = percent;
  elements.splitProgressBar.toggleAttribute("data-preparing", percent < 18);
  setProgressPercent(percent);
}

async function loadFfmpeg(): Promise<FfmpegLike> {
  if (!ffmpegLoadPromise) {
    ffmpegLoadPromise = (async () => {
      setWorkStatus("변환 엔진을 불러오는 중입니다.");
      setFfmpegProgressBase(3);
      const module = await import(chrome.runtime.getURL("vendor/ffmpeg/ffmpeg/index.js")) as { FFmpeg: new () => FfmpegLike };
      const ffmpeg = new module.FFmpeg();
      ffmpeg.on("progress", ({ progress }) => {
        if (typeof progress === "number" && Number.isFinite(progress)) {
          setProgressPercent(ffmpegProgressBase + progress * (FFMPEG_EXEC_PROGRESS_MAX - ffmpegProgressBase));
        }
      });
      await ffmpeg.load({
        coreURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.js"),
        wasmURL: chrome.runtime.getURL("vendor/ffmpeg/core/ffmpeg-core.wasm"),
      });
      setFfmpegProgressBase(8);
      return ffmpeg;
    })().catch((error) => {
      ffmpegLoadPromise = null;
      throw error;
    });
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

async function convertPartWithFfmpeg(part: LoadedPart, outputFormat: ConvertFormat, optimizeSeeking = false, range?: TimeRange): Promise<{ source: Blob; filename: string }> {
  const ffmpeg = await loadFfmpeg();
  const inputName = `input.${part.extension}`;
  const outputName = `output.${outputFormat}`;
  setFfmpegProgressBase(8);
  await clearFfmpegOutputs(ffmpeg);
  try {
    setWorkStatus("원본 파일을 준비하는 중입니다.");
    setFfmpegProgressBase(10);
    const sourceBytes = await getSourceBytes(getPartSource(part));
    setFfmpegProgressBase(14);
    await ffmpeg.writeFile(inputName, sourceBytes);
    setFfmpegProgressBase(18);
    const seekArgs = range ? ["-ss", String(range.start)] : [];
    const durationArgs = range ? ["-t", String(range.end - range.start)] : [];
    const args = outputFormat === "gif"
      ? [...seekArgs, "-i", inputName, ...durationArgs, "-an", outputName]
      : range
        ? [...seekArgs, "-i", inputName, ...durationArgs, outputName]
        : [
          "-i", inputName,
          "-map", "0",
          "-c", "copy",
          ...(optimizeSeeking && outputFormat === RECORDING_FORMAT.webm ? ["-cues_to_front", "1", "-f", "matroska"] : []),
          outputName,
        ];
    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      throw new Error("빠른 변환에 실패했습니다.");
    }
    setProgressPercent(94);
    const blob = await readFfmpegBlob(ffmpeg, outputName, getConvertedMimeType(outputFormat));
    setProgressPercent(98);
    return { source: blob, filename: getRangeFilename(part, outputFormat, range) };
  } finally {
    await clearFfmpegOutputs(ffmpeg);
  }
}

async function convertPartAtSpeed(part: LoadedPart, speed: number, range?: TimeRange): Promise<{ source: Blob; filename: string }> {
  const ffmpeg = await loadFfmpeg();
  const inputName = `input.${part.extension}`;
  const outputName = "output-speed.mp4";
  setFfmpegProgressBase(8);
  await clearFfmpegOutputs(ffmpeg);
  try {
    setWorkStatus("배속 파일을 준비하는 중입니다.");
    setFfmpegProgressBase(10);
    const sourceBytes = await getSourceBytes(getPartSource(part));
    setFfmpegProgressBase(14);
    await ffmpeg.writeFile(inputName, sourceBytes);
    setFfmpegProgressBase(18);
    const seekArgs = range ? ["-ss", String(range.start)] : [];
    const durationArgs = range ? ["-t", String(range.end - range.start)] : [];
    const speedText = String(speed);
    const code = await ffmpeg.exec([
      ...seekArgs,
      ...durationArgs,
      "-i", inputName,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-vf", `setpts=PTS/${speedText}`,
      "-af", `atempo=${speedText}`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "26",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputName,
    ]);
    if (code !== 0) {
      throw new Error("배속 변환에 실패했습니다.");
    }
    setProgressPercent(94);
    const blob = await readFfmpegBlob(ffmpeg, outputName, "video/mp4");
    setProgressPercent(98);
    return { source: blob, filename: getSpeedFilename(part, speed, range) };
  } finally {
    await clearFfmpegOutputs(ffmpeg);
  }
}

function getFilenameBase(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function pickRecorderMimeType(format: OutputFormat, preferred = ""): string {
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

function waitForMediaEvent(video: HTMLVideoElement, eventName: string): Promise<void> {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

async function makeWebmSeekable(part: LoadedPart): Promise<LoadedPart> {
  if (part.extension !== RECORDING_FORMAT.webm || part.seekMetadataVersion === SEEK_METADATA_VERSION) {
    return part;
  }

  const converted = await convertPartWithFfmpeg(part, RECORDING_FORMAT.webm, true);
  const normalized = {
    ...part,
    blob: converted.source,
    size: converted.source.size,
    seekMetadataVersion: SEEK_METADATA_VERSION,
  } satisfies LoadedPart;
  await putPart(normalized).catch(() => {});
  return normalized;
}

async function prepareSeekablePreview(): Promise<void> {
  if (!parts.some((part) => part.extension === RECORDING_FORMAT.webm && part.seekMetadataVersion !== SEEK_METADATA_VERSION)) {
    return;
  }

  setWorkStatus("미리보기 탐색 정보를 준비하는 중입니다.");
  const prepared: LoadedPart[] = [];
  for (const part of parts) {
    prepared.push(await makeWebmSeekable(part));
  }
  parts = prepared;

  if (recording) {
    recording = {
      ...recording,
      totalSize: parts.reduce((sum, part) => sum + part.size, 0),
    };
    await putRecording(recording).catch(() => {});
  }
  setWorkStatus("미리보기 탐색 준비가 완료되었습니다.");
}

function getSelectedSourcePart(): LoadedPart | undefined {
  return parts[0];
}

function updateTrimPlayhead(seconds = elements.previewVideo.currentTime): void {
  const duration = getFullSourceDuration();
  const percent = duration > 0 ? Math.max(0, Math.min(100, seconds / duration * 100)) : 0;
  elements.trimTimeline.style.setProperty("--trim-playhead", `${percent}%`);
  const thumbnails = Array.from(elements.trimThumbnails.children);
  const activeIndex = duration > 0 && thumbnails.length > 0
    ? Math.min(thumbnails.length - 1, Math.floor(seconds / duration * thumbnails.length))
    : -1;
  thumbnails.forEach((thumbnail, index) => thumbnail.classList.toggle("is-active", index === activeIndex));
}

function updateTrimControlState(): void {
  const duration = getFullSourceDuration();
  const range = getSelectedTimeRange(duration);
  const disabled = workBusy || parts.length === 0 || duration <= 0;
  elements.trimStartRange.disabled = disabled;
  elements.trimEndRange.disabled = disabled;
  elements.trimStartInput.disabled = disabled;
  elements.trimEndInput.disabled = disabled;
  elements.trimStartDecreaseButton.disabled = disabled || range.start <= 0;
  elements.trimStartIncreaseButton.disabled = disabled || range.start >= range.end - TRIM_STEP_SECONDS;
  elements.trimEndDecreaseButton.disabled = disabled || range.end <= range.start + TRIM_STEP_SECONDS;
  elements.trimEndIncreaseButton.disabled = disabled || range.end >= duration;
  elements.captureFrameButton.disabled = disabled || elements.previewVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA;
  elements.trimResetButton.disabled = disabled || isFullTimeRange(range, duration);
}

function renderTrimEditor(clearPreviousResults = false, seekHandle?: TimeRangeHandle): void {
  const duration = getFullSourceDuration();
  const range = getSelectedTimeRange(duration);
  trimStartSeconds = range.start;
  trimEndSeconds = range.end;

  const startPercent = duration > 0 ? range.start / duration * 100 : 0;
  const endPercent = duration > 0 ? range.end / duration * 100 : 100;
  elements.trimTimeline.style.setProperty("--trim-start", `${startPercent}%`);
  elements.trimTimeline.style.setProperty("--trim-end", `${endPercent}%`);
  elements.trimStartRange.max = String(duration);
  elements.trimEndRange.max = String(duration);
  elements.trimStartRange.value = String(range.start);
  elements.trimEndRange.value = String(range.end);
  elements.trimStartRange.setAttribute("aria-valuetext", formatPreciseDuration(range.start));
  elements.trimEndRange.setAttribute("aria-valuetext", formatPreciseDuration(range.end));
  elements.trimStartInput.value = formatTimeInput(range.start);
  elements.trimEndInput.value = formatTimeInput(range.end);
  elements.trimStartBubble.value = formatTimeInput(range.start);
  elements.trimEndBubble.value = formatTimeInput(range.end);
  elements.trimDurationValue.textContent = formatSecondsLabel(range.end - range.start);
  updateTrimControlState();

  if (clearPreviousResults) {
    clearSplitResults();
  }
  applySplitValueDefault();
  renderHeader();
  renderActions();

  if (seekHandle && elements.previewVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
    const target = seekHandle === "start" ? range.start : Math.max(range.start, range.end - 0.01);
    elements.previewVideo.currentTime = target;
    updateTrimPlayhead(target);
  } else {
    updateTrimPlayhead();
  }
}

function setTrimRange(start: number, end: number, changedHandle: TimeRangeHandle): void {
  const duration = getFullSourceDuration();
  const value = snapTimeRangeValue(changedHandle === "start" ? start : end, duration, TRIM_STEP_SECONDS);
  const range = updateTimeRangeHandle(getSelectedTimeRange(duration), changedHandle, value, duration);
  trimStartSeconds = range.start;
  trimEndSeconds = range.end;
  renderTrimEditor(true, changedHandle);
}

function setSourceDuration(duration: number): void {
  if (!Number.isFinite(duration) || duration <= 0) {
    return;
  }

  const previousDuration = getFullSourceDuration();
  const wasFullRange = trimEndSeconds <= 0
    || previousDuration <= 0
    || isFullTimeRange(getSelectedTimeRange(previousDuration), previousDuration);
  sourceDurationSeconds = duration;
  recordingDurationSeconds = duration;
  if (wasFullRange) {
    trimStartSeconds = 0;
    trimEndSeconds = duration;
  } else {
    const range = normalizeTimeRange(trimStartSeconds, trimEndSeconds, duration);
    trimStartSeconds = range.start;
    trimEndSeconds = range.end;
  }
  renderTrimEditor();
}

function getSelectedPlaybackSpeed(): number {
  const speed = Number(elements.speedSelect.value);
  return Number.isFinite(speed) && speed >= 0.5 && speed <= 2 ? speed : 1;
}

function updateSpeedControls(): void {
  const speed = getSelectedPlaybackSpeed();
  elements.previewVideo.playbackRate = speed;
  elements.speedSaveControl.title = speed === 1
    ? "1×에서는 기본 다운로드를 이용하세요."
    : `${speed}× 속도를 적용해 MP4로 저장합니다.`;
  elements.speedSelect.disabled = workBusy || parts.length === 0;
  elements.speedConvertButton.disabled = workBusy || parts.length === 0 || speed === 1;
}

function setSplitBusy(isBusy: boolean): void {
  workBusy = isBusy;
  elements.splitButton.disabled = isBusy || parts.length === 0;
  elements.splitModeSelect.disabled = isBusy || parts.length === 0;
  elements.splitFormatSelect.disabled = isBusy || parts.length === 0;
  elements.splitValueInput.disabled = isBusy;
  elements.splitValueDecreaseButton.disabled = isBusy || parts.length === 0;
  elements.splitValueIncreaseButton.disabled = isBusy || parts.length === 0;
  updateSplitPresetButtons();
  updateTrimControlState();
  for (const button of elements.convertButtons) {
    button.disabled = isBusy || parts.length === 0;
  }
  updateSpeedControls();
  elements.downloadAllButton.disabled = isBusy || splitSegments.length === 0;
  renderActions();
}

function clearSplitResults(): void {
  splitSegments = [];
  renderSplitDownloads();
}

function renderSplitMode(): void {
  const mode = elements.splitModeSelect.value;
  elements.splitUnitLabel.textContent = mode === "duration" ? "초" : "MB";
  elements.splitValueInput.min = mode === "duration" ? String(TRIM_STEP_SECONDS) : "1";
  elements.splitValueInput.step = mode === "duration" ? String(TRIM_STEP_SECONDS) : "1";
  elements.splitStatus.textContent = "";
  applySplitValueDefault();
}

function renderSplitResults(segments: SplitSegment[]): void {
  splitSegments = segments;
  renderSplitDownloads();
}

function setSplitProgress(done: number, total: number): void {
  elements.splitProgressBar.removeAttribute("data-preparing");
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  setProgressPercent(percent);
}

function hideSplitProgress(): void {
  elements.splitProgress.hidden = true;
  elements.splitProgressBar.removeAttribute("data-preparing");
  elements.splitProgressBar.style.width = "0";
}

function setWorkStatus(message: string): void {
  elements.splitStatus.textContent = message;
}

function applySplitValueDefault(): void {
  const duration = getFullSourceDuration();
  const range = getSelectedTimeRange(duration);
  const selectedDuration = range.end - range.start;
  const selectedSizeMegabytes = estimateRangeSize(sourceSizeMegabytes * 1024 * 1024, range, duration) / 1024 / 1024;
  const value = elements.splitModeSelect.value === "size"
    ? Math.max(1, Math.ceil(selectedSizeMegabytes))
    : Math.max(TRIM_STEP_SECONDS, roundTrimTime(selectedDuration));
  elements.splitValueInput.value = String(value);
  elements.splitValueInput.max = String(value);
  updateSplitPresetButtons();
}

function updateSplitPresetButtons(): void {
  const mode = elements.splitModeSelect.value;
  const maximum = Number(elements.splitValueInput.max);
  const currentValue = Number(elements.splitValueInput.value);
  for (const button of elements.splitPresetButtons) {
    const matchesMode = button.dataset.splitMode === mode;
    const value = Number(button.dataset.splitValue);
    button.hidden = !matchesMode;
    button.disabled = workBusy || parts.length === 0 || value >= maximum;
    button.setAttribute("aria-pressed", String(matchesMode && value === currentValue));
  }
}

async function updateSplitDefaultValues(part: LoadedPart | undefined = getSelectedSourcePart()): Promise<void> {
  if (!part) {
    return;
  }

  const requestId = ++splitDefaultRequestId;
  sourceSizeMegabytes = part.size / 1024 / 1024;
  applySplitValueDefault();

  let loaded: Awaited<ReturnType<typeof loadVideoForPart>> | null = null;
  try {
    loaded = await loadVideoForPart(part);
    if (requestId === splitDefaultRequestId) {
      setSourceDuration(loaded.duration);
    }
  } catch {
    const fallback = recordingDurationSeconds || getRecordingDurationFallback();
    if (requestId === splitDefaultRequestId && fallback > 0) {
      setSourceDuration(fallback);
    }
  } finally {
    if (loaded) {
      releaseVideoSource(loaded.video, loaded.url, loaded.revoke);
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

  try {
    await waitForVideoMetadata(video);
    const duration = await resolveVideoDuration(video) || getRecordingDurationFallback();
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("영상 길이를 확인할 수 없습니다.");
    }

    return { video, url, revoke, duration };
  } catch (error) {
    releaseVideoSource(video, url, revoke);
    throw error;
  }
}

async function seekVideo(video: HTMLVideoElement, seconds: number): Promise<void> {
  const target = Math.max(0, seconds);
  if (Math.abs(video.currentTime - target) < 0.05) {
    return;
  }

  video.currentTime = target;
  await waitForMediaEvent(video, "seeked");
}

function clearTimelineThumbnails(): void {
  thumbnailRequestId += 1;
  for (const url of thumbnailUrls) {
    URL.revokeObjectURL(url);
  }
  thumbnailUrls = [];
  elements.trimThumbnails.innerHTML = "";
  elements.trimThumbnails.removeAttribute("data-loading");
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("이미지를 만들지 못했습니다."));
      }
    }, type, quality);
  });
}

function drawThumbnailFrame(context: CanvasRenderingContext2D, video: HTMLVideoElement): void {
  const scale = Math.max(TIMELINE_THUMBNAIL_WIDTH / video.videoWidth, TIMELINE_THUMBNAIL_HEIGHT / video.videoHeight);
  const sourceWidth = TIMELINE_THUMBNAIL_WIDTH / scale;
  const sourceHeight = TIMELINE_THUMBNAIL_HEIGHT / scale;
  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;
  context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, TIMELINE_THUMBNAIL_WIDTH, TIMELINE_THUMBNAIL_HEIGHT);
}

async function renderTimelineThumbnails(part: LoadedPart | undefined): Promise<void> {
  clearTimelineThumbnails();
  if (!part) {
    return;
  }

  const requestId = thumbnailRequestId;
  elements.trimThumbnails.setAttribute("data-loading", "");
  let loaded: Awaited<ReturnType<typeof loadVideoForPart>> | null = null;
  try {
    loaded = await loadVideoForPart(part);
    const widthCount = Math.ceil((elements.trimThumbnails.clientWidth || 720) / TIMELINE_THUMBNAIL_DISPLAY_WIDTH);
    const durationCount = Math.ceil(loaded.duration / TIMELINE_THUMBNAIL_INTERVAL_SECONDS);
    const count = Math.min(MAX_TIMELINE_THUMBNAILS, Math.max(MIN_TIMELINE_THUMBNAILS, widthCount, durationCount));
    const canvas = document.createElement("canvas");
    canvas.width = TIMELINE_THUMBNAIL_WIDTH;
    canvas.height = TIMELINE_THUMBNAIL_HEIGHT;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      return;
    }

    for (let index = 0; index < count && requestId === thumbnailRequestId; index += 1) {
      const seconds = loaded.duration * (index + 0.5) / count;
      await seekVideo(loaded.video, seconds);
      drawThumbnailFrame(context, loaded.video);
      const url = URL.createObjectURL(await canvasToBlob(canvas, "image/jpeg", 0.72));
      if (requestId !== thumbnailRequestId) {
        URL.revokeObjectURL(url);
        break;
      }

      thumbnailUrls.push(url);
      const button = document.createElement("button");
      button.className = "trim-thumbnail";
      button.type = "button";
      button.title = `${formatTimeInput(seconds)}로 이동`;
      button.setAttribute("aria-label", `${formatTimeInput(seconds)} 장면으로 이동`);
      button.addEventListener("click", () => {
        elements.previewVideo.currentTime = seconds;
        updateTrimPlayhead(seconds);
      });
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      button.appendChild(image);
      elements.trimThumbnails.appendChild(button);
      updateTrimPlayhead();
    }
  } catch {
    // The timeline remains usable without thumbnail images.
  } finally {
    if (requestId === thumbnailRequestId) {
      elements.trimThumbnails.removeAttribute("data-loading");
    }
    if (loaded) {
      releaseVideoSource(loaded.video, loaded.url, loaded.revoke);
    }
  }
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
  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType || "video/webm" }));
    };
    recorder.onerror = () => {
      reject(new Error("영상 파일을 만드는 중 녹화 오류가 발생했습니다."));
    };
  });

  try {
    recorder.start(1_000);
    await video.play();
    await new Promise<void>((resolve, reject) => {
      let timeoutId = 0;
      const cleanup = () => {
        video.removeEventListener("timeupdate", check);
        video.removeEventListener("error", onError);
        window.clearTimeout(timeoutId);
      };
      const check = () => {
        if (video.currentTime >= endSeconds || video.ended) {
          cleanup();
          resolve();
        }
      };
      const onError = () => {
        cleanup();
        reject(new Error("영상 파일을 재생하지 못했습니다."));
      };
      video.addEventListener("timeupdate", check);
      video.addEventListener("error", onError, { once: true });
      timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("영상 구간 처리 시간이 초과되었습니다."));
      }, Math.max(MEDIA_EVENT_TIMEOUT_MS, (endSeconds - startSeconds) * 1000 + MEDIA_EVENT_TIMEOUT_MS));
    });
    video.pause();
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    const blob = await stopped;
    if (blob.size <= 0) {
      throw new Error("변환된 영상 데이터가 비어 있습니다.");
    }
    return blob;
  } finally {
    video.pause();
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    stream.getTracks().forEach((track) => track.stop());
  }
}

async function createDurationSplitWithRecorder(part: LoadedPart, segmentSeconds: number, outputFormat: OutputFormat, range?: TimeRange): Promise<SplitSegment[]> {
  const { video, url, revoke, duration } = await loadVideoForPart(part);
  const mimeType = pickRecorderMimeType(outputFormat, part.mimeType);
  const segments: SplitSegment[] = [];
  const selectedRange = range ? normalizeTimeRange(range.start, range.end, duration) : { start: 0, end: duration };
  const selectedDuration = selectedRange.end - selectedRange.start;

  try {
    if (segmentSeconds >= selectedDuration) {
      throw new Error("나누기 시간은 선택 구간보다 짧아야 합니다.");
    }

    const total = Math.ceil(selectedDuration / segmentSeconds);
    setSplitProgress(0, total);
    for (let index = 0; index < total; index += 1) {
      const start = selectedRange.start + index * segmentSeconds;
      const end = Math.min(selectedRange.end, start + segmentSeconds);
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
    releaseVideoSource(video, url, revoke);
  }

  return segments;
}

async function createDurationSplitWithFfmpeg(part: LoadedPart, segmentSeconds: number, outputFormat: OutputFormat, range?: TimeRange): Promise<SplitSegment[]> {
  const { video, url, revoke, duration } = await loadVideoForPart(part);
  releaseVideoSource(video, url, revoke);
  const selectedRange = range ? normalizeTimeRange(range.start, range.end, duration) : { start: 0, end: duration };
  const selectedDuration = selectedRange.end - selectedRange.start;
  if (segmentSeconds >= selectedDuration) {
    throw new Error("나누기 시간은 선택 구간보다 짧아야 합니다.");
  }

  const ffmpeg = await loadFfmpeg();
  const inputName = `input.${part.extension}`;
  setFfmpegProgressBase(8);
  await clearFfmpegOutputs(ffmpeg);
  try {
    setWorkStatus("원본 파일을 준비하는 중입니다.");
    setFfmpegProgressBase(10);
    const sourceBytes = await getSourceBytes(getPartSource(part));
    setFfmpegProgressBase(14);
    await ffmpeg.writeFile(inputName, sourceBytes);
    setFfmpegProgressBase(18);
    const pattern = `output%03d.${outputFormat}`;
    const code = await ffmpeg.exec([
      "-i", inputName,
      ...(range ? ["-ss", String(selectedRange.start), "-t", String(selectedDuration)] : []),
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
      const start = selectedRange.start + index * segmentSeconds;
      const end = Math.min(selectedRange.end, start + segmentSeconds);
      segments.push({
        blob: await readFfmpegBlob(ffmpeg, files[index].name, `video/${outputFormat}`),
        filename: `${getFilenameBase(part.filename)}_split_${String(index + 1).padStart(3, "0")}.${outputFormat}`,
        index: index + 1,
        startSeconds: start,
        endSeconds: end,
      });
      setProgressPercent(FFMPEG_EXEC_PROGRESS_MAX + (index + 1) / files.length * (100 - FFMPEG_EXEC_PROGRESS_MAX));
    }
    return segments;
  } finally {
    await clearFfmpegOutputs(ffmpeg);
  }
}

async function createDurationSplit(part: LoadedPart, segmentSeconds: number, outputFormat: OutputFormat, range?: TimeRange): Promise<SplitSegment[]> {
  try {
    return await createDurationSplitWithFfmpeg(part, segmentSeconds, outputFormat, range);
  } catch {
    return await createDurationSplitWithRecorder(part, segmentSeconds, outputFormat, range);
  }
}

async function createSizeSplit(part: LoadedPart, maxMegabytes: number, outputFormat: OutputFormat, range?: TimeRange): Promise<SplitSegment[]> {
  const { video, url, revoke, duration } = await loadVideoForPart(part);
  releaseVideoSource(video, url, revoke);

  const maxBytes = maxMegabytes * 1024 * 1024;
  const selectedRange = range ? normalizeTimeRange(range.start, range.end, duration) : { start: 0, end: duration };
  const selectedSize = estimateRangeSize(part.size, selectedRange, duration);
  if (maxBytes >= selectedSize) {
    throw new Error("나누기 용량은 선택 구간의 예상 용량보다 작아야 합니다.");
  }

  const averageBytesPerSecond = Math.max(1, part.size / duration);
  const segmentSeconds = Math.max(1, Math.floor(maxBytes / averageBytesPerSecond));
  return await createDurationSplit(part, segmentSeconds, outputFormat, selectedRange);
}

async function convertPartWithRecorder(part: LoadedPart, outputFormat: OutputFormat, range?: TimeRange): Promise<{ source: Blob | string; filename: string }> {
  if (part.extension === outputFormat && !range) {
    return { source: getPartSource(part), filename: part.filename };
  }

  const { video, url, revoke, duration } = await loadVideoForPart(part);
  try {
    const mimeType = pickRecorderMimeType(outputFormat, part.mimeType);
    const selectedRange = range ? normalizeTimeRange(range.start, range.end, duration) : { start: 0, end: duration };
    const blob = await recordVideoRange(video, selectedRange.start, selectedRange.end, mimeType);
    return { source: blob, filename: getRangeFilename(part, outputFormat, range) };
  } finally {
    releaseVideoSource(video, url, revoke);
  }
}

async function convertPart(part: LoadedPart, outputFormat: ConvertFormat, range?: TimeRange): Promise<{ source: Blob | string; filename: string }> {
  if (part.extension === outputFormat && !range) {
    return { source: getPartSource(part), filename: part.filename };
  }

  try {
    return await convertPartWithFfmpeg(part, outputFormat, false, range);
  } catch {
    if (outputFormat === "gif") {
      throw new Error(`${outputFormat.toUpperCase()} 변환에 실패했습니다.`);
    }
    return await convertPartWithRecorder(part, outputFormat, range);
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
  elements.previewVideo.preload = "auto";
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
    totalSize: loadedParts.reduce((sum, part) => sum + part.size, 0),
    actualExtension: firstPart.extension,
  };
}

function renderHeader(): void {
  if (!recording) {
    return;
  }

  elements.title.textContent = "녹화 결과";
  const range = getSelectedTimeRange();
  const duration = range.end - range.start;
  const streamer = getStreamerNameFromFilename();
  const size = `${getActiveTimeRange() ? "예상 " : ""}${formatBytes(getSelectedSourceSizeBytes())}`;
  const summary = [streamer, recording.actualExtension.toUpperCase(), size, formatTimeInput(duration)].filter(Boolean).join(" · ");
  elements.formatChip.textContent = summary;
}

function renderActions(): void {
  const hasSelectedRange = Boolean(getActiveTimeRange());
  elements.downloadOriginalButton.hidden = !hasSelectedRange;
  elements.downloadCurrentLabel.textContent = hasSelectedRange ? "구간 다운로드" : "다운로드";
  updateSpeedControls();
  if (!recording || parts.length === 0 || workBusy) {
    elements.downloadOriginalButton.disabled = true;
    elements.downloadCurrentButton.disabled = true;
    for (const button of elements.convertButtons) {
      button.disabled = true;
    }
    elements.downloadAllButton.disabled = true;
    return;
  }

  elements.downloadOriginalButton.disabled = false;
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
    meta.textContent = `${formatTimeInput(segment.startSeconds)} - ${formatTimeInput(segment.endSeconds)} · ${formatBytes(segment.blob.size)}`;

    const button = document.createElement("button");
    button.className = "button primary icon-button";
    button.type = "button";
    button.innerHTML = getDownloadIconSvg();
    button.title = "다운로드";
    button.setAttribute("aria-label", `${segment.index}번 파일 다운로드`);
    button.addEventListener("click", () => {
      downloadSource(segment.blob, segment.filename);
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
    clearTimelineThumbnails();
    elements.emptyMessage.textContent = "녹화 파일을 찾지 못했습니다.";
    renderActions();
    return;
  }

  elements.emptyMessage.textContent = "";
  elements.splitFormatSelect.value = RECORDING_FORMAT.mp4;
  const fallbackDuration = recordingDurationSeconds || getRecordingDurationFallback();
  if (fallbackDuration > 0) {
    setSourceDuration(fallbackDuration);
  }
  renderSplitMode();
  setPreviewFromPart(parts[0]);
  void renderTimelineThumbnails(parts[0]);
  void updateSplitDefaultValues(parts[0]);
  renderSplitDownloads();
  setSplitBusy(false);
}

async function downloadSourcesSequentially(items: Array<{ source: Blob | string; filename: string }>): Promise<void> {
  for (const item of [...items].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))) {
    downloadSource(item.source, item.filename);
    await delay(SEQUENTIAL_DOWNLOAD_DELAY_MS);
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

function restoreSourceTab(): void {
  if (Number.isFinite(sourceTabId) && sourceTabId > 0) {
    void chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
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

  for (let attempt = 0; attempt < RESULT_LOAD_MAX_ATTEMPTS; attempt += 1) {
    recording = await getRecording(recordingId) ?? null;
    parts = await Promise.all((await getPartsByRecordingId(recordingId)).map(hydratePart));
    recordingDurationSeconds = getRecordingDurationFallback();
    if (recording || parts.length > 0) {
      break;
    }
    elements.resultLoadingMessage.textContent = "녹화 파일을 저장하는 중입니다.";
    await delay(RESULT_LOAD_RETRY_MS);
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

  renderHeader();
  elements.resultLoadingMessage.textContent = "미리보기를 준비하는 중입니다.";
  try {
    await prepareSeekablePreview();
  } catch {
    setWorkStatus("탐색 정보를 만들지 못해 원본 미리보기를 사용합니다.");
  } finally {
    hideSplitProgress();
  }
  renderHeader();
  renderParts();
  await chrome.runtime.sendMessage({ type: "CANCEL_RECORDING_DELETION", recordingId: recording.id } satisfies DeletionCancelRequest).catch(() => {});
}

elements.downloadCurrentButton.addEventListener("click", () => {
  void (async () => {
    const range = getActiveTimeRange();
    if (!range) {
      await downloadSourcesSequentially(parts.map((part) => ({ source: getPartSource(part), filename: part.filename })));
      return;
    }

    const part = getSelectedSourcePart();
    if (!part) {
      return;
    }

    setSplitBusy(true);
    setSplitProgress(0, 1);
    try {
      setWorkStatus("선택 구간을 준비하는 중입니다.");
      const item = await convertPart(part, part.extension, range);
      setSplitProgress(1, 1);
      await downloadSourcesSequentially([item]);
      setWorkStatus("선택 구간 다운로드가 준비되었습니다.");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "선택 구간을 만들지 못했습니다.");
    } finally {
      hideSplitProgress();
      setSplitBusy(false);
    }
  })();
});

elements.downloadOriginalButton.addEventListener("click", () => {
  void downloadSourcesSequentially(parts.map((part) => ({ source: getPartSource(part), filename: part.filename })));
});

elements.closeButton.addEventListener("click", () => {
  restoreSourceTab();
  window.close();
});

for (const button of elements.convertButtons) {
  button.addEventListener("click", () => {
    void (async () => {
      setSplitBusy(true);
      try {
        const outputFormat = (button.dataset.convertFormat ?? RECORDING_FORMAT.mp4) as ConvertFormat;
        const range = getActiveTimeRange();
        const sourceParts = range ? [getSelectedSourcePart()].filter((part): part is LoadedPart => Boolean(part)) : parts;
        setSplitProgress(0, Math.max(1, sourceParts.length));
        setWorkStatus(`${outputFormat.toUpperCase()} 변환 중입니다.`);
        const items: Array<{ source: Blob | string; filename: string }> = [];
        for (const [index, part] of sourceParts.entries()) {
          items.push(await convertPart(part, outputFormat, range));
          setSplitProgress(index + 1, sourceParts.length);
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

elements.speedSelect.addEventListener("change", () => {
  updateSpeedControls();
});

elements.captureFrameButton.addEventListener("click", () => {
  void (async () => {
    const video = elements.previewVideo;
    const part = getSelectedSourcePart();
    if (!part || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) {
      window.alert("저장할 영상 장면이 아직 준비되지 않았습니다.");
      return;
    }

    try {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new Error();
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, "image/png");
      const seconds = video.currentTime.toFixed(1).replace(".", "_");
      downloadSource(blob, `${getFilenameBase(part.filename)}_frame_${seconds}s.png`);
    } catch {
      window.alert("현재 장면을 저장하지 못했습니다.");
    }
  })();
});

elements.speedConvertButton.addEventListener("click", () => {
  void (async () => {
    const speed = getSelectedPlaybackSpeed();
    if (speed === 1) {
      return;
    }

    setSplitBusy(true);
    try {
      const range = getActiveTimeRange();
      const sourceParts = range ? [getSelectedSourcePart()].filter((part): part is LoadedPart => Boolean(part)) : parts;
      setSplitProgress(0, Math.max(1, sourceParts.length));
      setWorkStatus(`${speed}배속 MP4를 만드는 중입니다.`);
      const items: Array<{ source: Blob; filename: string }> = [];
      for (const [index, part] of sourceParts.entries()) {
        items.push(await convertPartAtSpeed(part, speed, range));
        setSplitProgress(index + 1, sourceParts.length);
      }
      await downloadSourcesSequentially(items);
      setWorkStatus(`${speed}배속 MP4 다운로드가 준비되었습니다.`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "배속 MP4를 만들지 못했습니다.");
    } finally {
      hideSplitProgress();
      setSplitBusy(false);
    }
  })();
});

elements.downloadAllButton.addEventListener("click", () => {
  void downloadSourcesSequentially(splitSegments.map((segment) => ({ source: segment.blob, filename: segment.filename })));
});

elements.previewVideo.addEventListener("loadedmetadata", () => {
  updateSpeedControls();
  if (Number.isFinite(elements.previewVideo.duration) && elements.previewVideo.duration > 0) {
    setSourceDuration(elements.previewVideo.duration);
  }
});

elements.previewVideo.addEventListener("loadeddata", updateTrimControlState);

elements.previewVideo.addEventListener("play", () => {
  const range = getSelectedTimeRange();
  if (elements.previewVideo.currentTime < range.start || elements.previewVideo.currentTime >= range.end - 0.05) {
    elements.previewVideo.currentTime = range.start;
  }
});

elements.previewVideo.addEventListener("timeupdate", () => {
  const range = getSelectedTimeRange();
  const currentTime = elements.previewVideo.currentTime;
  if (currentTime < range.start - 0.05) {
    elements.previewVideo.currentTime = range.start;
    updateTrimPlayhead(range.start);
    return;
  }
  if (currentTime >= range.end - 0.02 && !elements.previewVideo.paused) {
    elements.previewVideo.pause();
    elements.previewVideo.currentTime = range.end;
    updateTrimPlayhead(range.end);
    return;
  }
  if (currentTime > range.end + 0.05) {
    elements.previewVideo.currentTime = range.end;
    updateTrimPlayhead(range.end);
    return;
  }
  updateTrimPlayhead(currentTime);
});

elements.trimStartRange.addEventListener("input", () => {
  setTrimRange(Number(elements.trimStartRange.value), trimEndSeconds, "start");
});

elements.trimEndRange.addEventListener("input", () => {
  setTrimRange(trimStartSeconds, Number(elements.trimEndRange.value), "end");
});

elements.trimStartInput.addEventListener("change", () => {
  const value = parseTimeInput(elements.trimStartInput.value);
  setTrimRange(Number.isFinite(value) ? value : trimStartSeconds, trimEndSeconds, "start");
});

elements.trimEndInput.addEventListener("change", () => {
  const value = parseTimeInput(elements.trimEndInput.value);
  setTrimRange(trimStartSeconds, Number.isFinite(value) ? value : trimEndSeconds, "end");
});

elements.trimStartDecreaseButton.addEventListener("click", () => {
  setTrimRange(trimStartSeconds - TRIM_STEP_SECONDS, trimEndSeconds, "start");
});

elements.trimStartIncreaseButton.addEventListener("click", () => {
  setTrimRange(trimStartSeconds + TRIM_STEP_SECONDS, trimEndSeconds, "start");
});

elements.trimEndDecreaseButton.addEventListener("click", () => {
  setTrimRange(trimStartSeconds, trimEndSeconds - TRIM_STEP_SECONDS, "end");
});

elements.trimEndIncreaseButton.addEventListener("click", () => {
  setTrimRange(trimStartSeconds, trimEndSeconds + TRIM_STEP_SECONDS, "end");
});

elements.trimResetButton.addEventListener("click", () => {
  const duration = getFullSourceDuration();
  trimStartSeconds = 0;
  trimEndSeconds = duration;
  renderTrimEditor(true, "start");
});

for (const [handle, input] of [["start", elements.trimStartRange], ["end", elements.trimEndRange]] as const) {
  const activate = () => {
    elements.trimTimeline.dataset.activeHandle = handle;
  };
  input.addEventListener("pointerdown", activate);
  input.addEventListener("focus", activate);
}

elements.splitModeSelect.addEventListener("change", () => {
  renderSplitMode();
});

for (const [button, direction] of [[elements.splitValueDecreaseButton, -1], [elements.splitValueIncreaseButton, 1]] as const) {
  button.addEventListener("click", () => {
    direction < 0 ? elements.splitValueInput.stepDown() : elements.splitValueInput.stepUp();
    updateSplitPresetButtons();
  });
}

elements.splitValueInput.addEventListener("input", () => updateSplitPresetButtons());

for (const button of elements.splitPresetButtons) {
  button.addEventListener("click", () => {
    elements.splitValueInput.value = button.dataset.splitValue ?? "45";
    updateSplitPresetButtons();
  });
}

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
      const outputFormat = elements.splitFormatSelect.value === RECORDING_FORMAT.mp4 ? RECORDING_FORMAT.mp4 : RECORDING_FORMAT.webm;
      const minimum = mode === "duration" ? TRIM_STEP_SECONDS : 1;
      const splitValue = Math.max(minimum, Number(elements.splitValueInput.value || minimum));
      const range = getActiveTimeRange();
      const selectedRange = getSelectedTimeRange();
      if (mode === "duration" && splitValue >= roundTrimTime(selectedRange.end - selectedRange.start)) {
        throw new Error("나누기 시간은 선택 구간보다 짧아야 합니다.");
      }
      const segments = mode === "size"
        ? await createSizeSplit(part, splitValue, outputFormat, range)
        : await createDurationSplit(part, splitValue, outputFormat, range);

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
  restoreSourceTab();
  void scheduleDeletionOnClose();
});

window.addEventListener("unload", () => {
  clearTimelineThumbnails();
  revokePreviewUrl();
});

void boot().catch((error: Error) => {
  elements.emptyMessage.textContent = error.message;
}).finally(() => {
  elements.resultLoading.hidden = true;
});
