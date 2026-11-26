import { canvasToBlob } from "../shared/canvas.js";
import { MEDIA_SEEK_TOLERANCE_SECONDS, MediaEventTimeoutError, createObjectUrlSource, releaseVideoSource, getPartSource, pickRecorderMimeType, waitForMediaEvent, hydratePart, loadVideoForPart, seekVideo, recordVideoRange, type LoadedPart } from "./media.js";
import { downloadSource, downloadSourcesSequentially, downloadSourcesAndConfirm } from "./downloads.js";
import { capMp4PlaybackDuration } from "./mp4_duration.js";
import { readMp4VideoCodec } from "../shared/mp4_boxes.js";
import { loadFfmpeg, releaseFfmpeg, deleteFfmpegFile, clearFfmpegOutputs, readFfmpegBlob, type FfmpegLike } from "./ffmpeg.js";
import { getPart, getPartsByRecordingId, getRecording, putPart, putRecording } from "../shared/idb.js";
import { openEditOutputs } from "../shared/temporary_outputs.js";
import type { AutoDownloadHandledMessage, DeletionScheduleRequest, MessageResponse } from "../shared/messages.js";
import { loadSettings } from "../shared/storage.js";
import {
  bytesToMegabytes,
  estimateRangeSize,
  floorTimeToStep,
  formatRecordingSize,
  getExpectedSplitCount,
  getNextSizeSplitSeconds,
  getSplitIntervalForCount,
  isFullTimeRange,
  MAX_ORIGINAL_STREAM_SECONDS,
  MILLISECONDS_PER_SECOND,
  megabytesToBytes,
  normalizeTimeRange,
  parseSegmentTimeList,
  parseTimeInput,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
  snapTimeRangeValue,
  TIME_STEP_SECONDS,
  updateTimeRangeHandle,
  type TimeRange,
  type TimeRangeHandle,
} from "../shared/time_range.js";
import { MAX_VIDEO_BITS_PER_SECOND, MIN_VIDEO_BITS_PER_SECOND, RECORDING_FORMAT, SPLIT_COUNTS, STANDARD_RECORDING_FRAME_RATE, STARTUP_SHORT_STALL_SECONDS, STARTUP_SHORT_STALL_WINDOW_SECONDS, STARTUP_STALL_WINDOW_SECONDS, STARTUP_TRIM_MAX_SECONDS, type RecordingFormat, type RecordingRecord, type Settings } from "../shared/types.js";

const params = new URLSearchParams(location.search);
const recordingId = params.get("id") ?? "";
const sourceTabId = Number(params.get("sourceTabId") ?? "");
const autoDownloadRecording = params.get("autoDownload") === "1";
const autoSplitRecording = params.get("autoSplit") === "1";
let showResult = !autoDownloadRecording || params.get("keepOpen") === "1";
type OutputFormat = RecordingFormat;
type ConvertFormat = OutputFormat | "gif";
type SplitOptions = { mode: "duration" | "size"; value: number; format: OutputFormat };

let restoreSourceTabOnClose = showResult;
let allowRecordingDeletion = !autoDownloadRecording;
// During pagehide the tab may already be gone, so track activity before closing.
let resultTab: chrome.tabs.Tab | undefined;
void chrome.tabs.getCurrent().then(tab => { resultTab = tab; }).catch(() => {});
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (resultTab?.windowId === windowId) resultTab.active = resultTab.id === tabId;
});

const elements = {
  resultLoading: document.getElementById("result-loading") as HTMLDivElement,
  resultLoadingMessage: document.getElementById("result-loading-message") as HTMLSpanElement,
  previewWaiting: document.getElementById("preview-waiting") as HTMLDivElement,
  previewRecovery: document.getElementById("preview-recovery") as HTMLDivElement,
  title: document.getElementById("title") as HTMLHeadingElement,
  formatChip: document.getElementById("format-chip") as HTMLDivElement,
  formatSummary: document.getElementById("format-summary") as HTMLSpanElement,
  videoCodec: document.getElementById("video-codec") as HTMLSpanElement,
  captureFallback: document.getElementById("capture-fallback") as HTMLSpanElement,
  captureFallbackMessage: document.getElementById("capture-fallback-message") as HTMLSpanElement,
  previewVideo: document.getElementById("preview-video") as HTMLVideoElement,
  framePreviewCard: document.getElementById("frame-preview-card") as HTMLDivElement,
  framePreviewImage: document.getElementById("frame-preview-image") as HTMLImageElement,
  framePreviewDownloadButton: document.getElementById("frame-preview-download-button") as HTMLButtonElement,
  framePreviewCloseButton: document.getElementById("frame-preview-close-button") as HTMLButtonElement,
  trimTimeline: document.getElementById("trim-timeline") as HTMLDivElement,
  trimSelection: document.getElementById("trim-selection") as HTMLSpanElement,
  trimThumbnails: document.getElementById("trim-thumbnails") as HTMLDivElement,
  loadTimelineThumbnails: document.getElementById("load-timeline-thumbnails") as HTMLButtonElement,
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
  setTrimStartButton: document.getElementById("set-trim-start-button") as HTMLButtonElement,
  setTrimEndButton: document.getElementById("set-trim-end-button") as HTMLButtonElement,
  previousFrameButton: document.getElementById("previous-frame-button") as HTMLButtonElement,
  nextFrameButton: document.getElementById("next-frame-button") as HTMLButtonElement,
  captureFrameButton: document.getElementById("capture-frame-button") as HTMLButtonElement,
  trimResetButton: document.getElementById("trim-reset-button") as HTMLButtonElement,
  splitModeSelect: document.getElementById("split-mode-select") as HTMLSelectElement,
  splitFormatSelect: document.getElementById("split-format-select") as HTMLSelectElement,
  splitValueInput: document.getElementById("split-value-input") as HTMLInputElement,
  splitValueDecreaseButton: document.getElementById("split-value-decrease-button") as HTMLButtonElement,
  splitValueIncreaseButton: document.getElementById("split-value-increase-button") as HTMLButtonElement,
  splitUnitLabel: document.getElementById("split-unit-label") as HTMLSpanElement,
  splitPresetButtons: Array.from(document.querySelectorAll<HTMLButtonElement>("[data-split-mode]")),
  splitButton: document.getElementById("split-button") as HTMLButtonElement,
  splitEstimate: document.getElementById("split-estimate") as HTMLParagraphElement,
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

let parts: LoadedPart[] = [];
let splitSegments: SplitSegment[] = [];
let autoSplitSettings: Settings | undefined;
let removeSplitOutput: (() => Promise<void>) | undefined;
const resultLifetime = new AbortController();
let previewUrl: string | null = null;
let recordingDurationSeconds = 0;
let fullDownloadNameLocked = false;
let canQueueDownload = false;
let downloadWhenReady = false;
let sourceDurationSeconds = 0;
let sourceSizeBytes = 0;
let ffmpegProgressBase = 0;
let ffmpegProgressEnd = 0;
let trimStartSeconds = 0;
let trimEndSeconds = 0;
let workBusy = false;
let thumbnailController: AbortController | undefined;
let thumbnailUrls: string[] = [];
let framePreviewBlob: Blob | null = null;
let framePreviewFilename = "";
let framePreviewUrl: string | null = null;
let frameStepSeconds = 1 / STANDARD_RECORDING_FRAME_RATE;
let deletionKeepaliveId: number | null = null;
interface SplitSegment {
  blob: Blob;
  filename: string;
  index: number;
  startSeconds: number;
  endSeconds: number;
}
const RESULT_LOAD_MAX_ATTEMPTS = 120;
const RESULT_LOAD_RETRY_MS = 500;
const SEEK_METADATA_VERSION = 1;
const STARTUP_MIN_PLAYABLE_SECONDS = 0.5;
const DISK_OUTPUT_MIN_BYTES = 64 * 1024 * 1024;
const FFMPEG_LOAD_START_PERCENT = 3;
const FFMPEG_READY_PERCENT = 8;
const FFMPEG_SOURCE_READ_PERCENT = 10;
const FFMPEG_TRANSCODE_START_PERCENT = 18;
const FFMPEG_EXEC_PROGRESS_MAX = 92;
const FFMPEG_OUTPUT_READ_PERCENT = 94;
const PROGRESS_PREPARING_PERCENT = 6;
const PROGRESS_FINALIZING_PERCENT = 96;
const PERCENT_SCALE = 100;
const DISPLAY_SIZE_UNIT = 1_000;
const MEDIA_SEEK_EPSILON_SECONDS = 0.001;
const TRIM_PREVIEW_OFFSET_SECONDS = 0.01;
const DEFAULT_PLAYBACK_SPEED = 1;
const MP4_VIDEO_CODEC_LABELS = new Map([
  ["hvc1", "H.265"], ["hev1", "H.265"], ["avc1", "H.264"], ["avc3", "H.264"], ["vp09", "VP9"], ["av01", "AV1"],
]);
const TIME_DECIMAL_PLACES = 1;
const TIME_STEPS_PER_MINUTE = SECONDS_PER_MINUTE / TIME_STEP_SECONDS;
const TIME_STEPS_PER_HOUR = SECONDS_PER_HOUR / TIME_STEP_SECONDS;
const MAX_TIMELINE_THUMBNAILS = 24;
const MIN_TIMELINE_THUMBNAILS = 6;
const TIMELINE_THUMBNAIL_INTERVAL_SECONDS = 3;
const TIMELINE_THUMBNAIL_DISPLAY_WIDTH = 72;
const TIMELINE_THUMBNAIL_WIDTH = 160;
const TIMELINE_THUMBNAIL_HEIGHT = 90;
const TIMELINE_FALLBACK_WIDTH = 720;
const TIMELINE_THUMBNAIL_JPEG_QUALITY = 0.72;
const SPLIT_FILE_INDEX_DIGITS = 3;
const PLAYBACK_END_TOLERANCE_SECONDS = 0.02;
const TRIM_DRAG_THRESHOLD_PX = 3;
const MAX_SIZE_SPLIT_ATTEMPTS = 5;
const DELETION_KEEPALIVE_MS = 60_000;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= DISPLAY_SIZE_UNIT && index < units.length - 1) {
    value /= DISPLAY_SIZE_UNIT;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatPreciseDuration(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const totalTimeSteps = Math.round(safeSeconds / TIME_STEP_SECONDS);
  const hours = Math.floor(totalTimeSteps / TIME_STEPS_PER_HOUR);
  const minutes = Math.floor((totalTimeSteps % TIME_STEPS_PER_HOUR) / TIME_STEPS_PER_MINUTE);
  const remainder = totalTimeSteps % TIME_STEPS_PER_MINUTE * TIME_STEP_SECONDS;
  const secondsText = remainder.toFixed(TIME_DECIMAL_PLACES).padStart(4, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secondsText}`
    : `${minutes}:${secondsText}`;
}

function formatTimeInput(seconds: number): string {
  const precise = formatPreciseDuration(seconds);
  return precise.endsWith(".0") ? precise.slice(0, -2) : precise;
}

function formatSecondsLabel(seconds: number): string {
  return seconds < SECONDS_PER_MINUTE ? `${roundTrimTime(seconds).toFixed(TIME_DECIMAL_PLACES)}초` : formatTimeInput(seconds);
}

function roundTrimTime(seconds: number): number {
  return Number((Math.round(seconds / TIME_STEP_SECONDS) * TIME_STEP_SECONDS).toFixed(TIME_DECIMAL_PLACES));
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
  const base = getFilenameBase(getRecordingFilename(part.filename));
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

function clearFramePreview(): void {
  if (framePreviewUrl) {
    URL.revokeObjectURL(framePreviewUrl);
  }
  framePreviewBlob = null;
  framePreviewFilename = "";
  framePreviewUrl = null;
  elements.framePreviewImage.removeAttribute("src");
  elements.framePreviewCard.hidden = true;
}

function showFramePreview(blob: Blob, filename: string): void {
  clearFramePreview();
  framePreviewBlob = blob;
  framePreviewFilename = filename;
  framePreviewUrl = URL.createObjectURL(blob);
  elements.framePreviewImage.src = framePreviewUrl;
  elements.framePreviewCard.hidden = false;
}

function getDownloadIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 4v10m0 0 4-4m-4 4-4-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5 17.5v1.2c0 .7.6 1.3 1.3 1.3h11.4c.7 0 1.3-.6 1.3-1.3v-1.2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
    </svg>
  `;
}

function setProgressPercent(percent: number): void {
  elements.splitProgress.hidden = false;
  elements.splitProgressBar.style.width = `${Math.max(0, Math.min(PERCENT_SCALE, Math.round(percent)))}%`;
}

function setPreparingProgress(message: string): void {
  setWorkStatus(message);
  setProgressPercent(PROGRESS_PREPARING_PERCENT);
}

function setFfmpegProgressBase(percent: number, end = FFMPEG_EXEC_PROGRESS_MAX): void {
  ffmpegProgressBase = percent;
  ffmpegProgressEnd = end;
  elements.splitProgressBar.toggleAttribute("data-preparing", percent < FFMPEG_TRANSCODE_START_PERCENT);
  setProgressPercent(percent);
}

function getConvertedMimeType(format: ConvertFormat): string {
  return format === "gif" ? "image/gif" : `video/${format}`;
}

async function withFfmpegInput<T>(part: LoadedPart, operation: (ffmpeg: FfmpegLike, inputName: string) => Promise<T>, message = "원본 파일을 준비하는 중입니다."): Promise<T> {
  resultLifetime.signal.throwIfAborted();
  setWorkStatus("변환 엔진을 불러오는 중입니다.");
  setFfmpegProgressBase(FFMPEG_LOAD_START_PERCENT);
  const ffmpeg = await loadFfmpeg(progress => setProgressPercent(ffmpegProgressBase + progress * (ffmpegProgressEnd - ffmpegProgressBase)));
  const inputName = `input.${part.extension}`;
  let mounted = false;
  try {
    setFfmpegProgressBase(FFMPEG_READY_PERCENT);
    await clearFfmpegOutputs(ffmpeg);
    setWorkStatus(message);
    setFfmpegProgressBase(FFMPEG_SOURCE_READ_PERCENT);
    const source = getPartSource(part);
    const blob = typeof source === "string" ? await (await fetch(source)).blob() : source;
    mounted = await ffmpeg.mount("WORKERFS", { blobs: [{ name: inputName, data: blob }] }, "/source");
    if (!mounted) throw new ResultError("원본 파일을 변환 엔진에 연결하지 못했습니다.");
    setFfmpegProgressBase(FFMPEG_TRANSCODE_START_PERCENT);
    return await operation(ffmpeg, `/source/${inputName}`);
  } finally {
    if (mounted) await ffmpeg.unmount("/source").catch(() => {});
    await clearFfmpegOutputs(ffmpeg, true);
  }
}

class ResultError extends Error {}

class EditStorageError extends ResultError {
  constructor(cause: unknown) {
    super("편집 파일에 필요한 임시 저장 공간을 열거나 읽을 수 없습니다.", { cause });
  }
}

async function mountEditOutput(ffmpeg: FfmpegLike, disk: FileSystemDirectoryHandle, name: string, diskName = name): Promise<FileSystemFileHandle> {
  try {
    const file = await disk.getFileHandle(diskName, { create: true });
    if (!await ffmpeg.mount("CROPCLIP_OUTPUT", { file }, name)) throw new Error("Temporary output mount failed");
    return file;
  } catch (error) {
    throw new EditStorageError(error);
  }
}

async function readEditOutput(ffmpeg: FfmpegLike, name: string, mimeType: string, output?: FileSystemFileHandle): Promise<Blob> {
  if (!output) {
    const blob = await readFfmpegBlob(ffmpeg, name, mimeType);
    await deleteFfmpegFile(ffmpeg, name, true);
    return blob;
  }
  try {
    await deleteFfmpegFile(ffmpeg, name);
    const file = await output.getFile();
    return file.slice(0, file.size, mimeType);
  } catch (error) {
    throw new EditStorageError(error);
  }
}

async function finishConversion(
  ffmpeg: FfmpegLike,
  name: string,
  mimeType: string,
  output: FileSystemFileHandle | undefined,
  emptyFileMessage: string,
): Promise<Blob> {
  setWorkStatus("파일을 마무리하는 중입니다.");
  setProgressPercent(FFMPEG_OUTPUT_READ_PERCENT);
  const blob = await readEditOutput(ffmpeg, name, mimeType, output);
  if (!blob.size) throw new ResultError(emptyFileMessage);
  setProgressPercent(PROGRESS_FINALIZING_PERCENT);
  return blob;
}

async function createEditWorkspace(recordingId: string) {
  try {
    const root = await openEditOutputs(recordingId);
    const name = crypto.randomUUID();
    const disk = await root.getDirectoryHandle(name, { create: true });
    return { disk, remove: () => root.removeEntry(name, { recursive: true }) };
  } catch (error) {
    throw new EditStorageError(error);
  }
}

async function convertPartWithFfmpeg(part: LoadedPart, outputFormat: ConvertFormat, optimizeSeeking = false, range?: TimeRange, disk?: FileSystemDirectoryHandle): Promise<{ source: Blob; filename: string }> {
  return withFfmpegInput(part, async (ffmpeg, inputName) => {
    const outputName = `output.${outputFormat}`;
    const seekArgs = range ? ["-ss", String(range.start)] : [];
    const durationArgs = range ? ["-t", String(range.end - range.start)] : [];
    const args = outputFormat === "gif"
      ? [...seekArgs, "-i", inputName, ...durationArgs, "-fps_mode", "vfr", "-an", outputName]
      : range
        ? [...seekArgs, "-i", inputName, ...durationArgs, "-fps_mode", "vfr", outputName]
        : [
          "-i", inputName,
          "-map", "0",
          "-c", "copy",
          ...(optimizeSeeking && outputFormat === RECORDING_FORMAT.webm ? ["-cues_to_front", "1", "-f", "matroska"] : []),
          outputName,
        ];
    const output = disk && await mountEditOutput(ffmpeg, disk, outputName, crypto.randomUUID());
    const code = await ffmpeg.exec(args);
    if (code !== 0) {
      throw new ResultError("빠른 변환에 실패했습니다.");
    }
    const blob = await finishConversion(ffmpeg, outputName, getConvertedMimeType(outputFormat), output, "변환한 파일이 비어 있습니다.");
    return { source: blob, filename: getRangeFilename(part, outputFormat, range) };
  });
}

async function convertPartAtSpeed(part: LoadedPart, speed: number, range?: TimeRange, disk?: FileSystemDirectoryHandle): Promise<{ source: Blob; filename: string }> {
  return withFfmpegInput(part, async (ffmpeg, inputName) => {
    const outputName = "output-speed.mp4";
    const seekArgs = range ? ["-ss", String(range.start)] : [];
    const durationArgs = range ? ["-t", String(range.end - range.start)] : [];
    const speedText = String(speed);
    const output = disk && await mountEditOutput(ffmpeg, disk, outputName, crypto.randomUUID());
    const code = await ffmpeg.exec([
      ...seekArgs,
      ...durationArgs,
      "-i", inputName,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-vf", `setpts=PTS/${speedText}`,
      "-fps_mode", "vfr",
      "-af", `atempo=sqrt(${speedText}),atempo=sqrt(${speedText})`,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "26",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputName,
    ]);
    if (code !== 0) {
      throw new ResultError("배속 변환에 실패했습니다.");
    }
    const blob = await finishConversion(ffmpeg, outputName, "video/mp4", output, "배속 파일이 비어 있습니다.");
    return { source: blob, filename: getSpeedFilename(part, speed, range) };
  }, "배속 파일을 준비하는 중입니다.");
}

function getFilenameBase(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function getCaptureMethodLabel(part?: LoadedPart): string | undefined {
  if (part?.captureMethod === "original") return "방송 원본";
  if (part?.captureMethod === "screen") return "화면 녹화";
  return undefined;
}

function getRecordingDownload(part: LoadedPart): { source: Blob | string; filename: string } {
  return { source: getPartSource(part), filename: part.filename };
}

function getRecordingFilename(filename: string, duration = 0): string {
  const match = /^(.+_\d{8}_\d{6})(?:_(?:\d+h)?(?:\d+m)?\d+s)?(\.(?:webm|mp4))$/i.exec(filename);
  if (!match) return filename;
  const [, base, extension] = match;
  if (!Number.isFinite(duration) || duration <= 0) return `${base}${extension}`;
  const totalSeconds = Math.max(1, Math.round(duration));
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor(totalSeconds % SECONDS_PER_HOUR / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const label = hours > 0
    ? `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`
    : minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
  return `${base}_${label}${extension}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getRecordingDurationFallback(): number {
  if (!recording) {
    return 0;
  }

  const seconds = (recording.endedAt - recording.createdAt) / MILLISECONDS_PER_SECOND;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

async function savePreparedPart(part: LoadedPart, diskBacked: boolean): Promise<LoadedPart> {
  await putPart(part);
  if (!diskBacked) return part;
  // The temporary file snapshot becomes unreadable when the workspace is removed.
  const saved = await getPart(part.id);
  if (!saved?.blob) throw new ResultError("저장한 영상을 다시 읽지 못했습니다.");
  return { ...saved, blob: saved.blob };
}

async function makeWebmSeekable(part: LoadedPart): Promise<LoadedPart> {
  if (part.extension !== RECORDING_FORMAT.webm || part.seekMetadataVersion === SEEK_METADATA_VERSION) {
    return part;
  }

  const workspace = part.size >= DISK_OUTPUT_MIN_BYTES ? await createEditWorkspace(part.recordingId) : undefined;
  try {
    const converted = await convertPartWithFfmpeg(part, RECORDING_FORMAT.webm, true, undefined, workspace?.disk);
    const normalized = {
      ...part,
      blob: converted.source,
      size: converted.source.size,
      seekMetadataVersion: SEEK_METADATA_VERSION,
    } satisfies LoadedPart;
    if (!workspace) {
      await putPart(normalized).catch(() => {});
      return normalized;
    }
    await releaseFfmpeg();
    return await savePreparedPart(normalized, true);
  } finally {
    await workspace?.remove().catch(() => {});
  }
}

async function trimRecordingStartup(part: LoadedPart, trimSeconds: number, disk?: FileSystemDirectoryHandle): Promise<{ blob: Blob; cutSeconds: number } | null> {
  return withFfmpegInput(part, async (ffmpeg, inputName) => {
    const format = part.extension === RECORDING_FORMAT.webm ? "matroska" : "mp4";
    const list = "output-startup.csv";
    const name = `output-startup-1.${part.extension}`;
    const validStart = async (path: string) => await ffmpeg.exec([
      "-xerror", "-i", path, "-map", "0:v:0", "-frames:v", "1", "-abort_on", "empty_output", "-f", "null", "-",
    ]) === 0;
    const mimeType = getConvertedMimeType(part.extension);
    if (disk) await mountEditOutput(ffmpeg, disk, `output-startup-0.${part.extension}`);
    const output = disk && await mountEditOutput(ffmpeg, disk, name);
    const code = await ffmpeg.exec([
      "-i", inputName, "-map", "0", "-c", "copy", "-f", "segment",
      "-segment_format", format, "-segment_times", String(trimSeconds),
      ...(format === "matroska" ? ["-segment_format_options", "cues_to_front=1"] : []),
      "-segment_list", list, "-segment_list_type", "csv", "-reset_timestamps", "1",
      `output-startup-%d.${part.extension}`,
    ]);
    if (code === 0) {
      const data = await ffmpeg.readFile(list);
      const rows = (typeof data === "string" ? data : new TextDecoder().decode(data)).trim().split("\n");
      const [, start, end] = rows.find(row => row.startsWith(`${name},`))?.split(",") ?? [];
      const cutSeconds = Number(start);
      if (cutSeconds >= trimSeconds - 0.05 && cutSeconds <= trimSeconds + 1.25
        && Number(end) - cutSeconds >= STARTUP_MIN_PLAYABLE_SECONDS && await validStart(name)) {
        const blob = await readEditOutput(ffmpeg, name, mimeType, output);
        if (blob.size > 0) return { blob, cutSeconds };
      }
    }

    await clearFfmpegOutputs(ffmpeg, true);
    const preciseName = `output-startup-trimmed.${part.extension}`;
    const preciseFile = disk && await mountEditOutput(ffmpeg, disk, preciseName);
    const bitrate = part.videoBitsPerSecond;
    const webmRate = typeof bitrate === "number" && bitrate >= MIN_VIDEO_BITS_PER_SECOND && bitrate <= MAX_VIDEO_BITS_PER_SECOND
      ? ["-b:v", String(bitrate)] : ["-crf", "18"];
    const preciseCode = await ffmpeg.exec([
      "-ss", String(trimSeconds), "-i", inputName, "-map", "0:v:0", "-map", "0:a:0?",
      // MP4 can hide decoder preroll in its edit list. Matroska needs a new opening keyframe.
      ...(format === "mp4" ? ["-c", "copy", "-use_editlist", "1", "-avoid_negative_ts", "disabled", "-movflags", "+faststart"]
        : ["-c:v", "libx264", "-preset", "veryfast", ...webmRate, "-fps_mode", "vfr",
          "-c:a", "libvorbis", "-cues_to_front", "1", "-f", format]),
      preciseName,
    ]);
    if (preciseCode !== 0 || !await validStart(preciseName)) return null;
    const blob = await readEditOutput(ffmpeg, preciseName, mimeType, preciseFile);
    return blob.size > 0 ? { blob, cutSeconds: trimSeconds } : null;
  }, "녹화 초반의 끊긴 구간을 정리하는 중입니다.");
}

async function prepareOriginalStream(part: LoadedPart): Promise<LoadedPart> {
  const start = part.originalStreamStart!;
  const end = Math.min(part.originalStreamEnd ?? Infinity, start + MAX_ORIGINAL_STREAM_SECONDS);
  const storageError = () => new Error("대용량 원본을 저장할 임시 공간을 열 수 없습니다. 저장 공간을 확보한 뒤 다시 시도하거나 방송 조각을 백업하세요.");
  const useDisk = part.size >= DISK_OUTPUT_MIN_BYTES;
  if (useDisk && (!navigator.locks || !navigator.storage?.getDirectory)) throw storageError();
  const save = async (output: Blob): Promise<LoadedPart> => {
    const blob = await capMp4PlaybackDuration(output, end - start);
    const prepared = { ...part, blob, size: blob.size, originalStreamStart: undefined, originalStreamEnd: undefined } satisfies LoadedPart;
    return savePreparedPart(prepared, useDisk);
  };
  const prepared = await withFfmpegInput(part, async (ffmpeg, inputName) => {
    const name = "output-original.mp4";
    const convert = async () => {
      const code = await ffmpeg.exec([
        "-seek_timestamp", "1", "-ss", String(start), "-i", inputName,
        "-t", String(end - start),
        "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-use_editlist", "1",
        "-avoid_negative_ts", "disabled", "-movflags", "+faststart", name,
      ]);
      if (code !== 0 || await ffmpeg.exec(["-xerror", "-i", name, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"]) !== 0) {
        throw new ResultError("원본 방송을 MP4로 묶지 못했습니다.");
      }
    };
    if (!useDisk) {
      await convert();
      return save(await readEditOutput(ffmpeg, name, "video/mp4"));
    }
    // Reuse one staging file so an interrupted worker cannot leave a new file on every retry.
    return navigator.locks.request("cropclip-original-output", async () => {
      const root = await navigator.storage.getDirectory().catch(() => undefined);
      const file = await root?.getFileHandle(name, { create: true }).catch(() => undefined);
      if (!file) throw storageError();
      try {
        if (!await ffmpeg.mount("CROPCLIP_OUTPUT", { file }, name).catch(() => false)) throw storageError();
        try {
          await convert();
          return await save(await readEditOutput(ffmpeg, name, "video/mp4", file));
        } catch (error) {
          throw new ResultError("원본 MP4 저장을 마치지 못했습니다. 저장 공간을 확인한 뒤 다시 시도하거나 방송 조각을 백업하세요.", { cause: error });
        }
      } finally {
        await deleteFfmpegFile(ffmpeg, name, true);
        await root?.removeEntry(name).catch(() => {});
      }
    });
  }, "원본 방송 조각을 MP4로 묶는 중입니다.");
  await releaseFfmpeg();
  return prepared;
}

async function prepareRecordedFiles(includeSeekMetadata: boolean): Promise<string | undefined> {
  if (!parts.some(part => part.originalStreamStart !== undefined || part.startupTrimSeconds || part.inspectStartup
    || (includeSeekMetadata && part.extension === RECORDING_FORMAT.webm && part.seekMetadataVersion !== SEEK_METADATA_VERSION))) {
    return;
  }

  setWorkStatus("미리보기 탐색 정보를 준비하는 중입니다.");
  const prepared: LoadedPart[] = [];
  let cutSeconds = 0;
  let keptUntrimmed = false;
  for (const source of parts) {
    if (source.originalStreamStart !== undefined) {
      prepared.push(await prepareOriginalStream(source));
      continue;
    }
    const detected = source.inspectStartup ? await inspectRecordedStartup(source).catch(() => undefined) : undefined;
    const part = source.inspectStartup ? {
      ...source,
      inspectStartup: undefined,
      startupTrimSeconds: Math.max(source.startupTrimSeconds ?? 0, detected ?? 0) || undefined,
    } : source;
    const trimSeconds = part.startupTrimSeconds;
    if (trimSeconds && getRecordingDurationFallback() >= trimSeconds + STARTUP_MIN_PLAYABLE_SECONDS) {
      let workspace: Awaited<ReturnType<typeof createEditWorkspace>> | undefined;
      try {
        if (part.size >= DISK_OUTPUT_MIN_BYTES) workspace = await createEditWorkspace(part.recordingId);
        const cut = await trimRecordingStartup(part, trimSeconds, workspace?.disk);
        if (cut) {
          const trimmed = {
            ...part,
            blob: cut.blob,
            size: cut.blob.size,
            seekMetadataVersion: SEEK_METADATA_VERSION,
            startupTrimSeconds: undefined,
          } satisfies LoadedPart;
          if (workspace) await releaseFfmpeg();
          prepared.push(await savePreparedPart(trimmed, Boolean(workspace)));
          cutSeconds += cut.cutSeconds;
          continue;
        }
      } catch {
        // A failed startup trim must leave the saved recording available.
      } finally {
        await workspace?.remove().catch(() => {});
      }
    }
    keptUntrimmed ||= Boolean(trimSeconds);
    prepared.push(includeSeekMetadata ? await makeWebmSeekable(part) : part);
  }
  parts = prepared;

  if (recording) {
    recording = {
      ...recording,
      createdAt: Math.min(recording.endedAt, recording.createdAt + cutSeconds * MILLISECONDS_PER_SECOND),
      totalSize: parts.reduce((sum, part) => sum + part.size, 0),
    };
    await putRecording(recording).catch(() => {});
  }
  recordingDurationSeconds = getRecordingDurationFallback();
  if (keptUntrimmed) return "초반 구간을 정리할 수 없어 원본을 유지했습니다.";
  if (cutSeconds > 0) return "녹화 초반의 끊긴 구간을 제외했습니다.";
  return undefined;
}

async function inspectRecordedStartup(part: LoadedPart): Promise<number | undefined> {
  return withFfmpegInput(part, async (ffmpeg, inputName) => {
    const output = "output-startup-probe.json";
    await ffmpeg.ffprobe([
      "-v", "error", "-select_streams", "v:0", "-read_intervals", `%+${STARTUP_TRIM_MAX_SECONDS}`,
      "-show_packets", "-show_format", "-show_entries", "packet=pts_time:format=start_time",
      "-of", "json", "-o", output, inputName,
    ], 4_000);
    // The bundled core can return -1 even after writing complete probe JSON.
    const data = await ffmpeg.readFile(output);
    const probe = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as {
      format?: { start_time?: string }; packets?: { pts_time?: string }[];
    };
    const origin = Number(probe.format?.start_time) || 0;
    // Presentation order can differ from packet order for H.264 B-frames.
    const frames = [...new Set((probe.packets ?? []).map(packet => Number(packet.pts_time) - origin)
      .filter(time => Number.isFinite(time) && time >= 0 && time <= STARTUP_TRIM_MAX_SECONDS))].sort((a, b) => a - b);
    const gaps = frames.map((time, index) => time - (frames[index - 1] ?? 0));
    const stableFrameGapSeconds = 0.065;
    let waitingForOpeningRecovery = false;
    let recovery: number | undefined;
    for (const [index, time] of frames.entries()) {
      if ((frames[index - 1] ?? 0) > STARTUP_STALL_WINDOW_SECONDS) break;
      if (time <= STARTUP_SHORT_STALL_WINDOW_SECONDS
        && (index <= 1 || gaps[index - 1] <= stableFrameGapSeconds) && gaps[index] >= STARTUP_SHORT_STALL_SECONDS) {
        waitingForOpeningRecovery = true;
      }
      const following = gaps.slice(index + 1, index + 4);
      if (following.length < 3 || following.some(gap => gap > stableFrameGapSeconds)) continue;
      const preceding = gaps.slice(Math.max(0, index - 3), index + 1);
      if (waitingForOpeningRecovery || gaps[index] >= 0.18 || preceding.filter(gap => gap >= 0.075).length >= 3) {
        recovery = time;
        waitingForOpeningRecovery = false;
      }
    }
    return recovery;
  }, "첫 녹화 파일의 초반 프레임을 확인하는 중입니다.");
}

function getSelectedSourcePart(): LoadedPart | undefined {
  return parts[0];
}

function updateTrimPlayhead(seconds = elements.previewVideo.currentTime): void {
  const duration = getFullSourceDuration();
  const percent = duration > 0 ? Math.max(0, Math.min(PERCENT_SCALE, seconds / duration * PERCENT_SCALE)) : 0;
  elements.trimTimeline.style.setProperty("--trim-playhead", `${percent}%`);
  const range = getSelectedTimeRange(duration);
  const boundaryTolerance = Math.max(TRIM_PREVIEW_OFFSET_SECONDS, frameStepSeconds / 2);
  const atBoundary = Math.abs(seconds - range.start) <= boundaryTolerance || Math.abs(seconds - range.end) <= boundaryTolerance;
  elements.setTrimStartButton.hidden = atBoundary;
  elements.setTrimEndButton.hidden = atBoundary;
}

function getTimelineSecondsAt(clientX: number, duration = getFullSourceDuration()): number {
  const rect = elements.trimThumbnails.getBoundingClientRect();
  if (duration <= 0 || rect.width <= 0) {
    return 0;
  }
  return duration * Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

function seekPreviewTo(seconds: number): void {
  elements.previewVideo.currentTime = seconds;
  updateTrimPlayhead(seconds);
}

function stepPreviewFrame(direction: -1 | 1): void {
  const video = elements.previewVideo;
  const range = getSelectedTimeRange();
  const end = Math.max(range.start, range.end - MEDIA_SEEK_EPSILON_SECONDS);
  const target = Math.max(range.start, Math.min(end, video.currentTime + direction * frameStepSeconds));
  video.pause();
  video.currentTime = target;
  updateTrimPlayhead(target);
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
  elements.trimStartIncreaseButton.disabled = disabled || range.start >= range.end - TIME_STEP_SECONDS;
  elements.trimEndDecreaseButton.disabled = disabled || range.end <= range.start + TIME_STEP_SECONDS;
  elements.trimEndIncreaseButton.disabled = disabled || range.end >= duration;
  elements.setTrimStartButton.disabled = disabled;
  elements.setTrimEndButton.disabled = disabled;
  elements.previousFrameButton.disabled = disabled;
  elements.nextFrameButton.disabled = disabled;
  elements.captureFrameButton.disabled = parts.length === 0;
  elements.trimResetButton.disabled = disabled || isFullTimeRange(range, duration);
}

function renderTrimEditor(clearPreviousResults = false, seekHandle?: TimeRangeHandle): void {
  const duration = getFullSourceDuration();
  const range = getSelectedTimeRange(duration);
  trimStartSeconds = range.start;
  trimEndSeconds = range.end;

  const startPercent = duration > 0 ? range.start / duration * PERCENT_SCALE : 0;
  const endPercent = duration > 0 ? range.end / duration * PERCENT_SCALE : PERCENT_SCALE;
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
    const target = seekHandle === "start" ? range.start : Math.max(range.start, range.end - TRIM_PREVIEW_OFFSET_SECONDS);
    elements.previewVideo.currentTime = target;
    updateTrimPlayhead(target);
  } else {
    updateTrimPlayhead();
  }
}

function setTrimRange(start: number, end: number, changedHandle: TimeRangeHandle): void {
  const duration = getFullSourceDuration();
  const value = snapTimeRangeValue(changedHandle === "start" ? start : end, duration);
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
  return Number.isFinite(speed) && elements.speedSelect.selectedIndex >= 0 ? speed : DEFAULT_PLAYBACK_SPEED;
}

function updateSpeedControls(): void {
  const speed = getSelectedPlaybackSpeed();
  elements.previewVideo.playbackRate = speed;
  elements.speedSaveControl.title = speed === DEFAULT_PLAYBACK_SPEED
    ? "1×에서는 기본 다운로드를 이용하세요."
    : `${speed}× 속도를 적용해 MP4로 저장합니다.`;
  elements.speedSelect.disabled = workBusy || parts.length === 0;
  elements.speedConvertButton.disabled = workBusy || parts.length === 0 || speed === DEFAULT_PLAYBACK_SPEED;
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
  for (const button of elements.splitFilesList.querySelectorAll<HTMLButtonElement>("button")) {
    button.disabled = isBusy;
  }
  renderActions();
}

async function runResultJob(operation: () => Promise<void>, failureMessage: string): Promise<void> {
  if (workBusy || resultLifetime.signal.aborted) return;
  setSplitBusy(true);
  try {
    await operation();
  } catch (error) {
    if (resultLifetime.signal.aborted) return;
    if (error instanceof MediaEventTimeoutError) {
      setWorkStatus(failureMessage);
      return;
    }
    const message = error instanceof ResultError ? error.message : failureMessage;
    setWorkStatus(message);
    window.alert(message);
  } finally {
    await releaseFfmpeg();
    hideSplitProgress();
    setSplitBusy(false);
  }
}

function clearSplitResults(): void {
  if (splitSegments.length === 0) {
    return;
  }

  splitSegments = [];
  void removeSplitOutput?.().catch(() => {});
  removeSplitOutput = undefined;
  renderSplitDownloads();
}

function renderSplitMode(): void {
  const mode = elements.splitModeSelect.value;
  elements.splitUnitLabel.textContent = mode === "duration" ? "초" : "MB";
  elements.splitValueInput.min = mode === "duration" ? String(TIME_STEP_SECONDS) : "1";
  elements.splitValueInput.step = mode === "duration" ? String(TIME_STEP_SECONDS) : "1";
  elements.splitStatus.textContent = "";
  applySplitValueDefault();
}

function setSplitProgress(done: number, total: number): void {
  elements.splitProgressBar.removeAttribute("data-preparing");
  const percent = done <= 0
    ? PROGRESS_PREPARING_PERCENT
    : total > 0 && done >= total
      ? PROGRESS_FINALIZING_PERCENT
      : total > 0 ? Math.round((done / total) * PERCENT_SCALE) : PROGRESS_PREPARING_PERCENT;
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
  const selectedSizeMegabytes = bytesToMegabytes(estimateRangeSize(sourceSizeBytes, range, duration));
  const mode = elements.splitModeSelect.value;
  const maximum = mode === "size"
    ? Math.max(1, Math.ceil(selectedSizeMegabytes))
    : Math.max(TIME_STEP_SECONDS, roundTrimTime(selectedDuration));
  const configured = autoSplitSettings && getAutomaticSplitOptions(autoSplitSettings, selectedDuration);
  const value = configured?.mode === mode
    ? Math.min(maximum, Math.max(mode === "size" ? 1 : TIME_STEP_SECONDS, configured.value))
    : maximum;
  elements.splitValueInput.value = String(value);
  elements.splitValueInput.max = String(maximum);
  updateSplitPresetButtons();
}

function getSplitPresetValue(button: HTMLButtonElement): number {
  const count = Number(button.dataset.splitCount);
  if (count) {
    const range = getSelectedTimeRange();
    return getSplitIntervalForCount(range.end - range.start, count);
  }

  return Number(button.dataset.splitValue);
}

function updateSplitPresetButtons(): void {
  const mode = elements.splitModeSelect.value;
  const maximum = Number(elements.splitValueInput.max);
  const currentValue = Number(elements.splitValueInput.value);
  const range = getSelectedTimeRange();
  for (const button of elements.splitPresetButtons) {
    const matchesMode = button.dataset.splitMode === mode;
    const value = getSplitPresetValue(button);
    const count = Number(button.dataset.splitCount);
    const unavailableCount = Boolean(count) && getExpectedSplitCount(range.end - range.start, value) !== count;
    button.hidden = !matchesMode;
    button.disabled = workBusy || parts.length === 0 || value >= maximum || unavailableCount;
    button.setAttribute("aria-pressed", String(matchesMode && !unavailableCount && value === currentValue));
  }
  updateSplitEstimate();
}

function getSizeSplitInterval(bytes: number, duration: number, maxBytes: number): number {
  const averageBytesPerSecond = Math.max(1, bytes / duration);
  return Math.max(TIME_STEP_SECONDS, floorTimeToStep(maxBytes / averageBytesPerSecond));
}

function updateSplitEstimate(): void {
  const sourceDuration = getFullSourceDuration();
  const range = getSelectedTimeRange(sourceDuration);
  const duration = range.end - range.start;
  const bytes = parts[0]?.size ?? 0;
  const value = Number(elements.splitValueInput.value);
  const bySize = elements.splitModeSelect.value === "size";
  const maxBytes = megabytesToBytes(Math.max(1, value));
  const seconds = bySize ? getSizeSplitInterval(bytes, sourceDuration, maxBytes) : Math.max(TIME_STEP_SECONDS, value);
  const count = getExpectedSplitCount(duration, seconds);
  elements.splitEstimate.hidden = bytes <= 0 || sourceDuration <= 0
    || !elements.splitValueInput.value
    || !Number.isFinite(value)
    || count < 2
    || (bySize && maxBytes >= estimateRangeSize(bytes, range, sourceDuration));
  if (elements.splitEstimate.hidden) {
    elements.splitEstimate.textContent = "";
    return;
  }

  const formatSegmentEstimate = (length: number) =>
    `약 ${formatSecondsLabel(length)} / ${formatRecordingSize(estimateRangeSize(bytes, { start: 0, end: length }, sourceDuration))}`;
  const lastSeconds = duration - (count - 1) * seconds;
  const lastLabel = roundTrimTime(lastSeconds) < roundTrimTime(seconds)
    ? ` · 마지막 ${formatSegmentEstimate(lastSeconds)}`
    : "";
  elements.splitEstimate.textContent = `예상 ${count}개 · 파일당 ${formatSegmentEstimate(seconds)}${lastLabel}`;
}

function updateSplitDefaultValues(part: LoadedPart | undefined = getSelectedSourcePart()): void {
  if (!part) {
    return;
  }

  sourceSizeBytes = part.size;
  applySplitValueDefault();
}

function clearTimelineThumbnails(): void {
  thumbnailController?.abort();
  thumbnailController = undefined;
  for (const url of thumbnailUrls) {
    URL.revokeObjectURL(url);
  }
  thumbnailUrls = [];
  elements.trimThumbnails.innerHTML = "";
  elements.trimThumbnails.removeAttribute("data-loading");
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

  const controller = thumbnailController = new AbortController();
  const { signal } = controller;
  elements.loadTimelineThumbnails.disabled = true;
  elements.trimThumbnails.setAttribute("data-loading", "");
  let loaded: Awaited<ReturnType<typeof loadVideoForPart>> | null = null;
  const canvas = document.createElement("canvas");
  try {
    loaded = await loadVideoForPart(part, getRecordingDurationFallback(), signal);
    const { duration, video } = loaded;
    const widthCount = Math.ceil((elements.trimThumbnails.clientWidth || TIMELINE_FALLBACK_WIDTH) / TIMELINE_THUMBNAIL_DISPLAY_WIDTH);
    const durationCount = Math.ceil(duration / TIMELINE_THUMBNAIL_INTERVAL_SECONDS);
    const count = Math.min(MAX_TIMELINE_THUMBNAILS, Math.max(MIN_TIMELINE_THUMBNAILS, widthCount, durationCount));
    canvas.width = TIMELINE_THUMBNAIL_WIDTH;
    canvas.height = TIMELINE_THUMBNAIL_HEIGHT;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      return;
    }

    for (let index = 0; index < count && !signal.aborted; index += 1) {
      const seconds = duration * index / count;
      await seekVideo(video, Math.min(duration, seconds + MEDIA_SEEK_EPSILON_SECONDS), signal);
      signal.throwIfAborted();
      drawThumbnailFrame(context, video);
      const url = URL.createObjectURL(await canvasToBlob(canvas, "image/jpeg", TIMELINE_THUMBNAIL_JPEG_QUALITY));
      if (signal.aborted) {
        URL.revokeObjectURL(url);
        break;
      }

      thumbnailUrls.push(url);
      const button = document.createElement("button");
      button.className = "trim-thumbnail";
      button.type = "button";
      button.title = `${formatTimeInput(seconds)}로 이동`;
      button.setAttribute("aria-label", `${formatTimeInput(seconds)} 장면으로 이동`);
      button.addEventListener("click", (event) => {
        seekPreviewTo(event.detail > 0 ? getTimelineSecondsAt(event.clientX, duration) : seconds);
      });
      const image = document.createElement("img");
      image.src = url;
      image.alt = "";
      button.appendChild(image);
      elements.trimThumbnails.appendChild(button);
    }
    if (!signal.aborted) {
      updateTrimPlayhead();
    }
  } catch {
    // The timeline remains usable without thumbnail images.
  } finally {
    if (thumbnailController === controller) {
      thumbnailController = undefined;
      elements.trimThumbnails.removeAttribute("data-loading");
      elements.loadTimelineThumbnails.disabled = false;
      if (thumbnailUrls.length && !elements.loadTimelineThumbnails.hidden) {
        if (document.activeElement === elements.loadTimelineThumbnails) {
          elements.trimThumbnails.querySelector("button")?.focus();
        }
        elements.loadTimelineThumbnails.hidden = true;
      }
    }
    canvas.width = canvas.height = 0;
    if (loaded) {
      releaseVideoSource(loaded.video, loaded.url, loaded.revoke);
    }
  }
}

async function readSplitSourceDuration(part: LoadedPart, fallbackDuration = getRecordingDurationFallback()): Promise<number> {
  const video = elements.previewVideo;
  if (part === getSelectedSourcePart() && video.hasAttribute("src")) {
    if (!video.error && video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await waitForMediaEvent(video, "loadedmetadata", resultLifetime.signal);
    }
    if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  }
  const loaded = await loadVideoForPart(part, fallbackDuration, resultLifetime.signal);
  releaseVideoSource(loaded.video, loaded.url, loaded.revoke);
  return loaded.duration;
}

async function createDurationSplitWithFfmpeg(
  part: LoadedPart,
  duration: number,
  segmentSeconds: number,
  outputFormat: OutputFormat,
  range?: TimeRange,
  input?: { ffmpeg: FfmpegLike; inputName: string },
  disk?: FileSystemDirectoryHandle,
): Promise<SplitSegment[]> {
  const selectedRange = range ? normalizeTimeRange(range.start, range.end, duration) : { start: 0, end: duration };
  const selectedDuration = selectedRange.end - selectedRange.start;
  if (segmentSeconds >= selectedDuration) {
    throw new ResultError("나누기 시간은 선택 구간보다 짧아야 합니다.");
  }
  const expectedCount = getExpectedSplitCount(selectedDuration, segmentSeconds);

  const split = async (ffmpeg: FfmpegLike, inputName: string): Promise<SplitSegment[]> => {
    const pattern = `output%03d.${outputFormat}`;
    const segmentListName = "output.csv";
    const outputName = (index: number) => `output${String(index).padStart(3, "0")}.${outputFormat}`;
    const webmOutputs: FileSystemFileHandle[] = [];
    const mp4Ranges = outputFormat === RECORDING_FORMAT.mp4
      ? Array.from({ length: expectedCount }, (_, index) => ({
        start: selectedRange.start + index * segmentSeconds,
        end: index === expectedCount - 1 ? selectedRange.end : selectedRange.start + (index + 1) * segmentSeconds,
      })) : null;
    if (!mp4Ranges) {
      if (disk) {
        for (let index = 0; index < expectedCount; index++) {
          const name = outputName(index);
          webmOutputs.push(await mountEditOutput(ffmpeg, disk, name));
        }
      }
      const boundaries = Array.from({ length: expectedCount - 1 }, (_, index) => (index + 1) * segmentSeconds).join(",");
      const code = await ffmpeg.exec([
        ...(range ? ["-ss", String(selectedRange.start)] : []),
        "-i", inputName,
        ...(range ? ["-t", String(selectedDuration)] : []),
        "-map", "0:v:0", "-map", "0:a:0?",
        // MediaRecorder WebM can report 1000 fps; keep timestamps instead of duplicating frames.
        "-fps_mode", "vfr",
        "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "6", "-crf", "10", "-b:v", "0",
        // Bundled libopus crashes on stereo input; Vorbis preserves both channels.
        "-c:a", "libvorbis", "-b:a", "128k",
        ...(boundaries ? ["-force_key_frames", `expr:gte(t,n_forced*${segmentSeconds})`] : []),
        "-f", "segment",
        "-segment_format", "webm",
        ...(boundaries ? ["-segment_times", boundaries] : ["-segment_time", String(selectedDuration + TIME_STEP_SECONDS)]),
        "-segment_list", segmentListName,
        "-segment_list_type", "csv",
        "-reset_timestamps", "1",
        pattern,
      ]);
      if (code !== 0) {
        throw new ResultError("WebM 파일을 나누지 못했습니다.");
      }
    }

    const files = mp4Ranges ? mp4Ranges.map((_, index) => ({ name: outputName(index) }))
      : (await ffmpeg.listDir("."))
      .filter((file) => !file.isDir && file.name.startsWith("output") && file.name.endsWith(`.${outputFormat}`))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (files.length === 0) {
      throw new ResultError("나눈 파일이 생성되지 않았습니다.");
    }
    if (files.length !== expectedCount) {
      throw new ResultError(`파일 나누기 결과가 올바르지 않습니다. ${expectedCount}개가 필요하지만 ${files.length}개가 생성되었습니다.`);
    }
    let actualTimes = mp4Ranges;
    if (!actualTimes) {
      const segmentListData = await ffmpeg.readFile(segmentListName);
      actualTimes = parseSegmentTimeList(typeof segmentListData === "string" ? segmentListData : new TextDecoder().decode(segmentListData));
      await deleteFfmpegFile(ffmpeg, segmentListName, true);
      if (disk && actualTimes.length !== expectedCount) throw new ResultError("WebM 분할 구간 수가 올바르지 않습니다.");
    }
    const segments: SplitSegment[] = [];
    const progressStart = mp4Ranges ? FFMPEG_TRANSCODE_START_PERCENT : FFMPEG_EXEC_PROGRESS_MAX;
    const progressStep = (PERCENT_SCALE - progressStart) / files.length;
    for (let index = 0; index < files.length; index += 1) {
      const name = files[index].name;
      const output = disk && (mp4Ranges ? await mountEditOutput(ffmpeg, disk, name) : webmOutputs[index]);
      const actualTime = actualTimes[index];
      const offset = mp4Ranges ? 0 : selectedRange.start;
      const start = actualTime ? actualTime.start + offset : selectedRange.start + index * segmentSeconds;
      const end = Math.min(selectedRange.end, actualTime ? actualTime.end + offset : selectedRange.start + (index + 1) * segmentSeconds);
      if (mp4Ranges) {
        setFfmpegProgressBase(progressStart + index * progressStep, progressStart + (index + 1) * progressStep);
        // Input seeking retains decoding preroll; MP4 edit lists hide it from playback.
        const code = await ffmpeg.exec([
          "-ss", String(start), "-i", inputName, "-t", String(end - start),
          "-map", "0", "-c", "copy", "-use_editlist", "1", "-avoid_negative_ts", "disabled",
          "-movflags", "+faststart", name,
        ]);
        if (code !== 0) throw new ResultError("빠른 파일 나누기에 실패했습니다.");
      }
      const blob = await readEditOutput(ffmpeg, name, `video/${outputFormat}`, output);
      if (!blob.size) throw new ResultError("나눈 파일이 비어 있습니다.");
      segments.push({
        blob,
        filename: `${getFilenameBase(getRecordingFilename(part.filename))}_${String(index + 1).padStart(SPLIT_FILE_INDEX_DIGITS, "0")}.${outputFormat}`,
        index: index + 1,
        startSeconds: start,
        endSeconds: end,
      });
      setProgressPercent(progressStart + (index + 1) * progressStep);
    }
    return segments;
  };
  return input ? split(input.ffmpeg, input.inputName) : withFfmpegInput(part, split);
}

async function createSizeSplit(part: LoadedPart, duration: number, maxMegabytes: number, outputFormat: OutputFormat, range?: TimeRange, disk?: FileSystemDirectoryHandle): Promise<SplitSegment[]> {
  const maxBytes = megabytesToBytes(maxMegabytes);
  const selectedRange = range ? normalizeTimeRange(range.start, range.end, duration) : { start: 0, end: duration };
  const selectedSize = estimateRangeSize(part.size, selectedRange, duration);
  if (maxBytes >= selectedSize) {
    throw new ResultError("파일별 최대 용량은 선택 구간의 전체 용량보다 작아야 합니다.");
  }

  let segmentSeconds = getSizeSplitInterval(part.size, duration, maxBytes);
  return withFfmpegInput(part, async (ffmpeg, inputName) => {
    const input = { ffmpeg, inputName };
    for (let attempt = 0; attempt < MAX_SIZE_SPLIT_ATTEMPTS; attempt += 1) {
      setWorkStatus(attempt === 0
        ? `파일당 최대 ${maxMegabytes}MB로 나누는 중입니다.`
        : `파일 용량을 확인해 다시 나누는 중입니다. (${attempt + 1}/${MAX_SIZE_SPLIT_ATTEMPTS})`);
      const segments = await createDurationSplitWithFfmpeg(part, duration, segmentSeconds, outputFormat, selectedRange, input, disk);
      const largestBytes = Math.max(...segments.map((segment) => segment.blob.size));
      if (largestBytes <= maxBytes) {
        return segments;
      }

      const nextSeconds = getNextSizeSplitSeconds(segmentSeconds, maxBytes, largestBytes);
      segments.length = 0;
      if (disk) {
        for await (const name of disk.keys()) await disk.removeEntry(name);
      }
      if (nextSeconds >= segmentSeconds) {
        break;
      }
      segmentSeconds = nextSeconds;
    }

    throw new ResultError("각 파일을 설정한 최대 용량 이하로 만들지 못했습니다. 최대 용량을 높여 주세요.");
  });
}

async function convertPartWithRecorder(part: LoadedPart, outputFormat: OutputFormat, range?: TimeRange, disk?: FileSystemDirectoryHandle): Promise<{ source: Blob | string; filename: string }> {
  const { signal } = resultLifetime;
  const { video, url, revoke, duration } = await loadVideoForPart(part, getRecordingDurationFallback(), signal);
  const release = () => releaseVideoSource(video, url, revoke);
  if (signal.aborted) {
    release();
    signal.throwIfAborted();
  }
  signal.addEventListener("abort", release, { once: true });
  try {
    const mimeType = pickRecorderMimeType(outputFormat, part.mimeType);
    const selectedRange = range ? normalizeTimeRange(range.start, range.end, duration) : { start: 0, end: duration };
    const output = disk && await disk.getFileHandle(crypto.randomUUID(), { create: true });
    const blob = await recordVideoRange(video, selectedRange.start, selectedRange.end, mimeType, output, signal);
    return { source: blob, filename: getRangeFilename(part, outputFormat, range) };
  } finally {
    signal.removeEventListener("abort", release);
    if (!signal.aborted) release();
  }
}

async function convertPart(part: LoadedPart, outputFormat: ConvertFormat, range?: TimeRange, disk?: FileSystemDirectoryHandle): Promise<{ source: Blob | string; filename: string }> {
  if (part.extension === outputFormat && !range) {
    return getRecordingDownload(part);
  }

  try {
    return await convertPartWithFfmpeg(part, outputFormat, false, range, disk);
  } catch (error) {
    resultLifetime.signal.throwIfAborted();
    if (error instanceof EditStorageError) throw error;
    if (outputFormat === "gif") {
      throw new ResultError(`${outputFormat.toUpperCase()} 변환에 실패했습니다.`);
    }
    await releaseFfmpeg();
    setWorkStatus("빠른 변환을 지원하지 않아 실시간으로 처리 중입니다.");
    return await convertPartWithRecorder(part, outputFormat, range, disk);
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
  showPreviewError("");
  elements.previewWaiting.hidden = !part;
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

function showPreviewError(message: string): void {
  elements.emptyMessage.textContent = message;
  elements.previewRecovery.hidden = !message;
  if (message) elements.previewWaiting.hidden = true;
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
  const part = parts[0];
  const extension = part?.extension ?? recording.actualExtension;
  elements.formatSummary.textContent = [streamer, getCaptureMethodLabel(part), extension.toUpperCase(), size, formatTimeInput(duration)].filter(Boolean).join(" · ");
  elements.formatChip.hidden = false;
  elements.captureFallback.hidden = part?.captureMethod !== "screen";
  elements.captureFallbackMessage.textContent = elements.captureFallback.hidden ? ""
    : `방송 원본을 확보하지 못해 화면 녹화를 ${extension === RECORDING_FORMAT.webm ? "WebM으로" : "MP4로"} 저장했습니다.`;
}

function renderActions(): void {
  const hasSelectedRange = Boolean(getActiveTimeRange());
  elements.downloadOriginalButton.hidden = !hasSelectedRange;
  elements.downloadCurrentLabel.textContent = downloadWhenReady ? "다운로드 예약됨" : hasSelectedRange ? "구간 다운로드" : "다운로드";
  elements.downloadCurrentButton.title = downloadWhenReady ? "다운로드 예약됨" : canQueueDownload
    ? "파일 준비가 끝나면 다운로드" : hasSelectedRange ? "현재 선택 구간 다운로드" : "전체 결과 다운로드";
  updateSpeedControls();
  if (!recording || parts.length === 0 || workBusy) {
    elements.downloadOriginalButton.disabled = true;
    elements.downloadCurrentButton.disabled = !canQueueDownload || downloadWhenReady;
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
    meta.textContent = `${formatTimeInput(segment.startSeconds)} - ${formatTimeInput(segment.endSeconds)} · ${formatSecondsLabel(segment.endSeconds - segment.startSeconds)} · ${formatBytes(segment.blob.size)}`;

    const button = document.createElement("button");
    button.className = "button primary icon-button";
    button.type = "button";
    button.disabled = workBusy;
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
    showPreviewError("녹화 파일을 찾지 못했습니다.");
    renderActions();
    return;
  }

  elements.splitModeSelect.value = autoSplitSettings?.autoSplitMode === "size" ? "size" : "duration";
  elements.splitFormatSelect.value = autoSplitSettings?.autoSplitFormat ?? RECORDING_FORMAT.mp4;
  const fallbackDuration = recordingDurationSeconds || getRecordingDurationFallback();
  if (fallbackDuration > 0) {
    setSourceDuration(fallbackDuration);
  }
  renderSplitMode();
  const part = parts[0];
  elements.videoCodec.hidden = true;
  if (part.extension === RECORDING_FORMAT.mp4 && part.blob) {
    void readMp4VideoCodec(part.blob).then(codec => {
      if (resultLifetime.signal.aborted || parts[0] !== part || !codec) return;
      const label = MP4_VIDEO_CODEC_LABELS.get(codec);
      if (!label) return;
      elements.videoCodec.textContent = `· ${label}`;
      elements.videoCodec.hidden = false;
    }).catch(() => {});
  }
  setPreviewFromPart(part);
  updateSplitDefaultValues(part);
  renderSplitDownloads();
}

async function scheduleRecordingDeletion(): Promise<void> {
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
    // The extension may have been reloaded while this result tab was open.
  }
}

async function markAutoDownloadHandled(): Promise<void> {
  const message: AutoDownloadHandledMessage = {
    type: "AUTO_DOWNLOAD_HANDLED",
    recordingId,
  };
  const response = await chrome.runtime.sendMessage<AutoDownloadHandledMessage, MessageResponse>(message);
  if (!response.ok) {
    throw new Error(response.error);
  }
}

function stopDeletionKeepalive(): void {
  if (deletionKeepaliveId !== null) {
    window.clearInterval(deletionKeepaliveId);
    deletionKeepaliveId = null;
  }
}

function startDeletionKeepalive(): void {
  stopDeletionKeepalive();
  void scheduleRecordingDeletion();
  deletionKeepaliveId = window.setInterval(() => void scheduleRecordingDeletion(), DELETION_KEEPALIVE_MS);
}

function restoreSourceTab(): void {
  if (!restoreSourceTabOnClose || !resultTab?.active) {
    return;
  }
  if (Number.isFinite(sourceTabId) && sourceTabId > 0) {
    void chrome.tabs.update(sourceTabId, { active: true }).catch(() => {});
  }
}

async function activateResultTab(): Promise<void> {
  restoreSourceTabOnClose = true;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (typeof tab?.id === "number") {
      await chrome.tabs.update(tab.id, { active: true });
    }
  } catch {
    // The tab may already have been closed.
  }
}

async function revealAutoDownloadFailure(): Promise<void> {
  if (!autoDownloadRecording) return;
  await activateResultTab();
  try {
    await markAutoDownloadHandled();
    allowRecordingDeletion = true;
    startDeletionKeepalive();
  } catch {
    // Keep the completed state so the result can be recovered after an extension restart.
  }
}

function clearAutomaticResultActions(): void {
  const resultUrl = new URL(location.href);
  for (const key of ["autoDownload", "keepOpen", "autoSplit"]) resultUrl.searchParams.delete(key);
  history.replaceState(history.state, "", resultUrl);
}

async function splitRecordingPart(
  part: LoadedPart,
  duration: number,
  options: SplitOptions & { range?: TimeRange },
): Promise<void> {
  const { mode, value, format, range } = options;
  const workspace = part.size >= DISK_OUTPUT_MIN_BYTES ? await createEditWorkspace(part.recordingId) : undefined;
  try {
    splitSegments = mode === "size"
      ? await createSizeSplit(part, duration, value, format, range, workspace?.disk)
      : await createDurationSplitWithFfmpeg(part, duration, value, format, range, undefined, workspace?.disk);
  } catch (error) {
    await releaseFfmpeg();
    await workspace?.remove().catch(() => {});
    throw error;
  }
  removeSplitOutput = workspace?.remove;
  await releaseFfmpeg();
}

async function downloadSplitFiles(): Promise<void> {
  setWorkStatus("나눈 파일을 마지막 번호부터 차례대로 저장하는 중입니다.");
  await downloadSourcesAndConfirm(splitSegments.map(segment => ({ source: segment.blob, filename: segment.filename })), true);
}

function getAutomaticSplitOptions(settings: Settings, duration: number): SplitOptions {
  const { autoSplitMode, autoSplitFormat: format } = settings;
  if (autoSplitMode === "size") return { mode: "size", value: settings.autoSplitMaxMegabytes, format };
  const value = autoSplitMode === "duration" ? settings.autoSplitIntervalSeconds
    : getSplitIntervalForCount(duration, SPLIT_COUNTS[autoSplitMode]);
  return { mode: "duration", value, format };
}

async function tryAutomaticSplit(settings: Settings | undefined): Promise<boolean> {
  if (!autoSplitRecording || !settings || parts.length !== 1) return false;
  const [part] = parts;
  const splitBySize = settings.autoSplitMode === "size";
  if (splitBySize && part.size <= megabytesToBytes(settings.autoSplitMaxMegabytes)) return false;
  const duration = await readSplitSourceDuration(part, 0).catch(error => {
    resultLifetime.signal.throwIfAborted();
    throw new ResultError("영상 길이를 확인하지 못해 자동 분할을 완료하지 못했습니다. 녹화 파일은 다운로드할 수 있습니다.", { cause: error });
  });
  if (duration <= 0 || (!splitBySize && duration <= settings.autoSplitAfterSeconds)) return false;
  const options = getAutomaticSplitOptions(settings, duration);
  if (options.mode === "duration") {
    const expected = settings.autoSplitMode === "duration" || settings.autoSplitMode === "size"
      ? 2 : SPLIT_COUNTS[settings.autoSplitMode];
    if (getExpectedSplitCount(duration, options.value) < expected) return false;
  }

  elements.resultLoadingMessage.textContent = "녹화 파일을 자동으로 나누는 중입니다.";
  setPreparingProgress("녹화 파일을 자동으로 나누는 중입니다.");
  await splitRecordingPart(part, duration, options);
  if (showResult) renderSplitDownloads();
  if (autoDownloadRecording || settings.enableAutoDownloadSplit) {
    elements.resultLoadingMessage.textContent = "나눈 파일을 다운로드하는 중입니다.";
    await downloadSplitFiles();
  }
  hideSplitProgress();
  return true;
}

async function boot(): Promise<void> {
  const settings = await loadSettings().catch(() => undefined);
  showResult ||= settings?.autoFocusResult === true;
  restoreSourceTabOnClose = showResult;
  if (settings?.enableAutoSplitRecording) autoSplitSettings = settings;
  if (!recordingId) {
    throw new ResultError("녹화 ID가 없습니다.");
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
  const recordedFrameRate = parts[0]?.frameRate;
  if (recordedFrameRate && Number.isFinite(recordedFrameRate) && recordedFrameRate > 0) frameStepSeconds = 1 / recordedFrameRate;

  if (!recording) {
    throw new ResultError("녹화 데이터를 찾지 못했습니다.");
  }
  if (autoDownloadRecording && parts.length === 0) {
    throw new ResultError("자동 다운로드할 녹화 파일을 찾지 못했습니다.");
  }

  if (showResult) renderHeader();
  if (!autoDownloadRecording) {
    startDeletionKeepalive();
    canQueueDownload = parts.length > 0 && parts.every(part => part.originalStreamStart === undefined);
    renderActions();
  }
  elements.resultLoadingMessage.textContent = "미리보기를 준비하는 중입니다.";
  let preparationStatus: string | undefined;
  try {
    preparationStatus = await prepareRecordedFiles(showResult);
  } catch (error) {
    if (parts.some(part => part.originalStreamStart !== undefined)) throw error;
    preparationStatus = "파일을 정리하지 못해 원본을 사용합니다.";
  } finally {
    await releaseFfmpeg();
    hideSplitProgress();
  }

  for (const part of parts) part.filename = getRecordingFilename(part.filename);
  if (showResult) renderParts();
  if (autoDownloadRecording) {
    if (parts.some(part => part.originalStreamStart !== undefined)) {
      throw new ResultError("원본 조각을 정리하지 못했습니다. 결과창에서 녹화 데이터를 확인하세요.");
    }
    if (parts.some(part => part.startupTrimSeconds)) {
      throw new ResultError("초반 끊김을 정리하지 못했습니다. 결과창에서 원본을 확인하고 다운로드할 수 있습니다.");
    }
  }
  const automaticSplit = await tryAutomaticSplit(autoSplitSettings);
  if (autoDownloadRecording) {
    if (!automaticSplit) {
      for (const part of parts) {
        if (part.captureMethod !== "original" && part.extension === RECORDING_FORMAT.webm
          && part.seekMetadataVersion !== SEEK_METADATA_VERSION && recordingDurationSeconds > 0) {
          part.filename = getRecordingFilename(part.filename, parts.length === 1 ? recordingDurationSeconds : 0);
          continue;
        }
        const duration = await readSplitSourceDuration(part, 0).catch(() => 0);
        if (duration > 0) part.filename = getRecordingFilename(part.filename, duration);
      }
      resultLifetime.signal.throwIfAborted();
      fullDownloadNameLocked = true;
      elements.resultLoadingMessage.textContent = "녹화 파일을 다운로드하는 중입니다.";
      await downloadSourcesAndConfirm(parts.map(getRecordingDownload));
    }
    await markAutoDownloadHandled();
    allowRecordingDeletion = true;
    if (!showResult) {
      const latestSettings = await loadSettings().catch(() => undefined);
      if (resultLifetime.signal.aborted) return;
      if (latestSettings?.autoFocusResult === false) {
        window.close();
        return;
      }
      showResult = true;
      renderParts();
      await activateResultTab();
    }
    startDeletionKeepalive();
  }
  if (autoDownloadRecording || autoSplitRecording) clearAutomaticResultActions();
  if (automaticSplit) setWorkStatus(`자동 분할 완료 · ${splitSegments.length}개`);
  else if (preparationStatus) setWorkStatus(preparationStatus);
  else if (autoDownloadRecording) setWorkStatus("자동 다운로드가 완료되었습니다.");
  await finishQueuedDownload();
  setSplitBusy(false);
}

async function finishQueuedDownload(): Promise<void> {
  canQueueDownload = false;
  if (!downloadWhenReady) return;
  // A stalled preview must not keep a prepared file from downloading.
  const video = elements.previewVideo;
  if (!video.error && video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await waitForMediaEvent(video, "loadedmetadata", resultLifetime.signal).catch(() => {});
  }
  downloadWhenReady = false;
  if (resultLifetime.signal.aborted) return;
  syncPreviewDuration();
  if (video.readyState < HTMLMediaElement.HAVE_METADATA && parts.length === 1) {
    parts[0].filename = getRecordingFilename(parts[0].filename, recordingDurationSeconds);
  }
  fullDownloadNameLocked = true;
  downloadFullRecording();
}

function downloadFullRecording(): void {
  void downloadSourcesSequentially(parts.map(getRecordingDownload));
}

async function downloadEditedParts(
  sourceParts: LoadedPart[],
  convert: (part: LoadedPart, disk?: FileSystemDirectoryHandle) => Promise<{ source: Blob | string; filename: string }>,
): Promise<void> {
  const largePart = sourceParts.find(part => part.size >= DISK_OUTPUT_MIN_BYTES);
  const workspace = largePart && await createEditWorkspace(largePart.recordingId);
  try {
    const items = [];
    for (const [index, part] of sourceParts.entries()) {
      items.push(await convert(part, workspace?.disk));
      setSplitProgress(index + 1, sourceParts.length);
    }
    if (workspace) {
      await releaseFfmpeg();
      await downloadSourcesAndConfirm(items);
    } else {
      await downloadSourcesSequentially(items);
    }
  } finally {
    await workspace?.remove().catch(() => {});
  }
}

elements.downloadCurrentButton.addEventListener("click", () => {
  if (canQueueDownload) {
    downloadWhenReady = true;
    renderActions();
    return;
  }
  if (workBusy) return;
  const range = getActiveTimeRange();
  if (!range) {
    downloadFullRecording();
    return;
  }
  const part = getSelectedSourcePart();
  if (!part) return;
  void runResultJob(async () => {
    setSplitProgress(0, 1);
    setPreparingProgress("선택 구간을 준비하는 중입니다.");
    await downloadEditedParts([part], (source, disk) => convertPart(source, source.extension, range, disk));
    setWorkStatus("선택 구간 다운로드가 준비되었습니다.");
  }, "선택 구간을 만들지 못했습니다.");
});

elements.downloadOriginalButton.addEventListener("click", downloadFullRecording);

elements.closeButton.addEventListener("click", () => {
  restoreSourceTab();
  window.close();
});

for (const button of elements.convertButtons) {
  button.addEventListener("click", () => {
    void runResultJob(async () => {
      const outputFormat = (button.dataset.convertFormat ?? RECORDING_FORMAT.mp4) as ConvertFormat;
      const range = getActiveTimeRange();
      const sourceParts = range ? [getSelectedSourcePart()].filter((part): part is LoadedPart => Boolean(part)) : parts;
      setSplitProgress(0, Math.max(1, sourceParts.length));
      setPreparingProgress(`${outputFormat.toUpperCase()} 변환을 준비하는 중입니다.`);
      await downloadEditedParts(sourceParts, (part, disk) => convertPart(part, outputFormat, range, disk));
      setWorkStatus(`${outputFormat.toUpperCase()} 변환이 완료되었습니다.`);
    }, "파일을 변환하지 못했습니다.");
  });
}

elements.speedSelect.addEventListener("change", () => {
  updateSpeedControls();
});

elements.setTrimStartButton.addEventListener("click", () => {
  setTrimRange(elements.previewVideo.currentTime, trimEndSeconds, "start");
});

elements.setTrimEndButton.addEventListener("click", () => {
  setTrimRange(trimStartSeconds, elements.previewVideo.currentTime, "end");
});

elements.previousFrameButton.addEventListener("click", () => stepPreviewFrame(-1));
elements.nextFrameButton.addEventListener("click", () => stepPreviewFrame(1));

elements.framePreviewDownloadButton.addEventListener("click", () => {
  if (framePreviewBlob && framePreviewFilename) {
    downloadSource(framePreviewBlob, framePreviewFilename);
  }
});

elements.framePreviewCloseButton.addEventListener("click", clearFramePreview);

elements.captureFrameButton.addEventListener("click", () => {
  void (async () => {
    const video = elements.previewVideo;
    const part = getSelectedSourcePart();
    if (!part) {
      window.alert("저장할 영상 장면이 아직 준비되지 않았습니다.");
      return;
    }

    try {
      if (video.seeking) {
        await waitForMediaEvent(video, "seeked");
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) {
        throw new Error();
      }
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
      showFramePreview(blob, `${getFilenameBase(part.filename)}_frame_${seconds}s.png`);
    } catch {
      window.alert("현재 장면을 저장하지 못했습니다.");
    }
  })();
});

elements.speedConvertButton.addEventListener("click", () => {
  const speed = getSelectedPlaybackSpeed();
  if (speed === DEFAULT_PLAYBACK_SPEED) return;
  void runResultJob(async () => {
    const range = getActiveTimeRange();
    const sourceParts = range ? [getSelectedSourcePart()].filter((part): part is LoadedPart => Boolean(part)) : parts;
    setSplitProgress(0, Math.max(1, sourceParts.length));
    setPreparingProgress(`${speed}배속 MP4를 준비하는 중입니다.`);
    await downloadEditedParts(sourceParts, (part, disk) => convertPartAtSpeed(part, speed, range, disk));
    setWorkStatus(`${speed}배속 MP4 다운로드가 준비되었습니다.`);
  }, "배속 MP4를 만들지 못했습니다.");
});

elements.downloadAllButton.addEventListener("click", () => {
  if (workBusy || splitSegments.length === 0) {
    return;
  }
  void runResultJob(async () => {
    await downloadSplitFiles();
    setWorkStatus("나눈 파일 저장이 완료되었습니다.");
  }, "나눈 파일을 저장하지 못했습니다.");
});

function syncPreviewDuration(): void {
  const duration = elements.previewVideo.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const part = getSelectedSourcePart();
  if (part && !fullDownloadNameLocked) part.filename = getRecordingFilename(part.filename, duration);
  setSourceDuration(duration);
}

elements.previewVideo.addEventListener("durationchange", syncPreviewDuration);
for (const event of ["loadeddata", "canplay"]) {
  elements.previewVideo.addEventListener(event, () => { elements.previewWaiting.hidden = true; });
}
elements.previewVideo.addEventListener("error", () => {
  if (elements.previewVideo.hasAttribute("src") && !resultLifetime.signal.aborted) {
    showPreviewError("미리보기를 열지 못했습니다. 녹화 파일은 다운로드할 수 있습니다.");
  }
});
elements.previewVideo.addEventListener("waiting", () => {
  elements.previewWaiting.hidden = !elements.previewVideo.hasAttribute("src") || !elements.previewRecovery.hidden;
});
elements.loadTimelineThumbnails.addEventListener("click", () => void renderTimelineThumbnails(getSelectedSourcePart()));
function preparePreviewThumbnails(): void {
  if (!elements.resultLoading.hidden || elements.previewVideo.readyState < HTMLMediaElement.HAVE_METADATA
    || resultLifetime.signal.aborted || thumbnailController || thumbnailUrls.length > 0) return;
  const part = getSelectedSourcePart();
  if (!part || part.originalStreamStart !== undefined) return;
  // A second decoder is only needed if the user wants thumbnails for a heavy result.
  const deferThumbnails = part.captureMethod === "original" || part.size >= DISK_OUTPUT_MIN_BYTES;
  elements.loadTimelineThumbnails.hidden = !deferThumbnails;
  if (!deferThumbnails) void renderTimelineThumbnails(part);
}

elements.previewVideo.addEventListener("loadedmetadata", () => {
  updateSpeedControls();
  syncPreviewDuration();
  preparePreviewThumbnails();
});

elements.previewVideo.addEventListener("play", () => {
  const range = getSelectedTimeRange();
  if (elements.previewVideo.currentTime < range.start || elements.previewVideo.currentTime >= range.end - MEDIA_SEEK_TOLERANCE_SECONDS) {
    elements.previewVideo.currentTime = range.start;
  }
});

elements.previewVideo.addEventListener("timeupdate", () => {
  const range = getSelectedTimeRange();
  const currentTime = elements.previewVideo.currentTime;
  if (currentTime < range.start - MEDIA_SEEK_TOLERANCE_SECONDS) {
    elements.previewVideo.currentTime = range.start;
    updateTrimPlayhead(range.start);
    return;
  }
  if (currentTime >= range.end - PLAYBACK_END_TOLERANCE_SECONDS && !elements.previewVideo.paused) {
    elements.previewVideo.pause();
    elements.previewVideo.currentTime = range.end;
    updateTrimPlayhead(range.end);
    return;
  }
  if (currentTime > range.end + MEDIA_SEEK_TOLERANCE_SECONDS) {
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
  setTrimRange(trimStartSeconds - TIME_STEP_SECONDS, trimEndSeconds, "start");
});

elements.trimStartIncreaseButton.addEventListener("click", () => {
  setTrimRange(trimStartSeconds + TIME_STEP_SECONDS, trimEndSeconds, "start");
});

elements.trimEndDecreaseButton.addEventListener("click", () => {
  setTrimRange(trimStartSeconds, trimEndSeconds - TIME_STEP_SECONDS, "end");
});

elements.trimEndIncreaseButton.addEventListener("click", () => {
  setTrimRange(trimStartSeconds, trimEndSeconds + TIME_STEP_SECONDS, "end");
});

elements.trimResetButton.addEventListener("click", () => {
  const duration = getFullSourceDuration();
  trimStartSeconds = 0;
  trimEndSeconds = duration;
  renderTrimEditor(true, "start");
});

let trimDrag: { pointerId: number; startX: number; railWidth: number; range: TimeRange; dragged: boolean } | null = null;

elements.trimSelection.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || elements.trimStartRange.disabled) {
    return;
  }
  trimDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    railWidth: elements.trimThumbnails.getBoundingClientRect().width,
    range: getSelectedTimeRange(),
    dragged: false,
  };
  elements.trimSelection.setPointerCapture(event.pointerId);
  event.preventDefault();
});

elements.trimSelection.addEventListener("pointermove", (event) => {
  if (!trimDrag || event.pointerId !== trimDrag.pointerId) {
    return;
  }
  const totalDuration = getFullSourceDuration();
  const { railWidth } = trimDrag;
  const selectedDuration = trimDrag.range.end - trimDrag.range.start;
  if (totalDuration <= 0 || railWidth <= 0 || selectedDuration >= totalDuration) {
    return;
  }
  const movedPixels = event.clientX - trimDrag.startX;
  if (!trimDrag.dragged && Math.abs(movedPixels) < TRIM_DRAG_THRESHOLD_PX) {
    return;
  }
  trimDrag.dragged = true;
  const maxStart = Math.max(0, totalDuration - selectedDuration);
  const nextStart = Math.max(0, Math.min(maxStart, roundTrimTime(trimDrag.range.start + movedPixels / railWidth * totalDuration)));
  trimStartSeconds = nextStart;
  trimEndSeconds = Math.min(totalDuration, nextStart + selectedDuration);
  renderTrimEditor(true);
});

function finishTrimDrag(event: PointerEvent, cancelled = false): void {
  if (!trimDrag || event.pointerId !== trimDrag.pointerId) {
    return;
  }
  const { dragged, pointerId } = trimDrag;
  trimDrag = null;
  if (elements.trimSelection.hasPointerCapture(pointerId)) {
    elements.trimSelection.releasePointerCapture(pointerId);
  }
  if (!cancelled && !dragged) {
    seekPreviewTo(getTimelineSecondsAt(event.clientX));
  }
}

elements.trimSelection.addEventListener("pointerup", (event) => finishTrimDrag(event));
elements.trimSelection.addEventListener("pointercancel", (event) => finishTrimDrag(event, true));

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target instanceof HTMLElement && event.target.matches("select, input:not([type='range'])")) {
    event.target.blur();
    return;
  }
  if (event.code !== "Space" || event.repeat || elements.previewVideo.readyState < HTMLMediaElement.HAVE_METADATA) {
    return;
  }
  const target = event.target instanceof Element ? event.target : null;
  const input = target?.closest("input");
  if (input instanceof HTMLElement && input.getAttribute("type") !== "range") {
    input.blur();
  }
  const formControl = target?.closest("select, textarea, [contenteditable='true']");
  const unrelatedButton = target?.closest("button") && !target.closest(".trim-details, .trim-timeline");
  if (formControl || unrelatedButton) {
    return;
  }

  event.preventDefault();
  if (elements.previewVideo.paused) {
    void elements.previewVideo.play().catch(() => {});
  } else {
    elements.previewVideo.pause();
  }
});

document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLElement && event.target.matches("select, input:not([type='range'])")) {
    event.target.blur();
  }
});

document.addEventListener("pointerup", (event) => {
  const button = event.target instanceof Element
    ? event.target.closest(".trim-stepper button, .split-value button")
    : null;
  if (button instanceof HTMLButtonElement) {
    button.blur();
  }
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
    elements.splitValueInput.value = String(getSplitPresetValue(button));
    updateSplitPresetButtons();
  });
}

elements.splitButton.addEventListener("click", () => {
  const part = getSelectedSourcePart();
  if (!part) {
    elements.splitStatus.textContent = "나눌 원본 파일이 없습니다.";
    return;
  }
  void runResultJob(async () => {
    const { enableAutoDownloadSplit } = await loadSettings().catch(() => ({ enableAutoDownloadSplit: false }));
    clearSplitResults();
    setPreparingProgress("파일 나누기를 준비하는 중입니다.");
    const mode = elements.splitModeSelect.value === "size" ? "size" : "duration";
    const outputFormat = elements.splitFormatSelect.value === RECORDING_FORMAT.mp4 ? RECORDING_FORMAT.mp4 : RECORDING_FORMAT.webm;
    const minimum = mode === "duration" ? TIME_STEP_SECONDS : 1;
    const splitValue = Math.max(minimum, Number(elements.splitValueInput.value || minimum));
    const range = getActiveTimeRange();
    const selectedRange = getSelectedTimeRange();
    if (mode === "duration" && splitValue >= roundTrimTime(selectedRange.end - selectedRange.start)) {
      throw new ResultError("나누기 시간은 선택 구간보다 짧아야 합니다.");
    }
    const duration = await readSplitSourceDuration(part);
    await splitRecordingPart(part, duration, { mode, value: splitValue, format: outputFormat, range });
    renderSplitDownloads();
    if (enableAutoDownloadSplit) await downloadSplitFiles();
    setWorkStatus("파일 나누기가 완료되었습니다.");
  }, "파일을 나누지 못했습니다.");
});

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    resultLifetime.abort();
    void releaseFfmpeg();
    clearFramePreview();
    clearTimelineThumbnails();
    setPreviewFromPart(undefined);
    elements.splitFilesList.replaceChildren();
    splitSegments = [];
    removeSplitOutput = undefined;
    parts = [];
    const backup = document.getElementById("download-original-fragments");
    if (backup) backup.onclick = null;
  }
  restoreSourceTab();
  stopDeletionKeepalive();
  if (allowRecordingDeletion) {
    void scheduleRecordingDeletion();
  }
});

window.addEventListener("pageshow", () => {
  if (recording && allowRecordingDeletion) {
    startDeletionKeepalive();
  }
});

setSplitBusy(true);
void boot().catch(async (error: unknown) => {
  if (resultLifetime.signal.aborted) return;
  hideSplitProgress();
  const fragments = parts.filter(part => part.originalStreamStart !== undefined);
  if (fragments.length) {
    setSplitBusy(true);
    const retry = document.getElementById("retry-original-save") as HTMLButtonElement;
    retry.onclick = () => location.reload();
    retry.hidden = false;
    const backup = document.getElementById("download-original-fragments") as HTMLButtonElement;
    backup.onclick = () => {
      void downloadSourcesSequentially(fragments.map(part => ({
        source: getPartSource(part),
        filename: `${getFilenameBase(part.filename)}.fmp4`,
      })));
    };
    backup.hidden = false;
    showPreviewError("방송 원본을 MP4로 준비하지 못했습니다.");
  } else if ((autoDownloadRecording || autoSplitRecording) && recording && parts.length > 0) {
    if (autoSplitRecording) clearAutomaticResultActions();
    renderHeader();
    if (!elements.previewVideo.hasAttribute("src")) renderParts();
    setWorkStatus(error instanceof ResultError ? error.message : autoDownloadRecording
      ? "자동 다운로드를 완료하지 못했습니다. 결과창에서 다시 시도해 주세요."
      : "자동 분할을 완료하지 못했습니다. 결과창에서 다시 시도해 주세요.");
    await finishQueuedDownload();
    setSplitBusy(false);
  } else {
    canQueueDownload = false;
    downloadWhenReady = false;
    setSplitBusy(false);
    showPreviewError(error instanceof ResultError ? error.message : "녹화 파일을 준비하지 못했습니다. 다시 시도해 주세요.");
  }
  await revealAutoDownloadFailure();
}).finally(() => {
  elements.resultLoading.hidden = true;
  if (!elements.previewVideo.hasAttribute("src")) elements.previewWaiting.hidden = true;
  preparePreviewThumbnails();
});
