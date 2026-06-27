(() => {
  const CONTENT_SCRIPT_BOOT_KEY = "__cropClipRegionSelectorBooted";
  const contentScriptGlobal = globalThis as typeof globalThis & { [CONTENT_SCRIPT_BOOT_KEY]?: boolean };

  if (contentScriptGlobal[CONTENT_SCRIPT_BOOT_KEY]) {
    return;
  }
  contentScriptGlobal[CONTENT_SCRIPT_BOOT_KEY] = true;

const OVERLAY_ID = "cropClip-overlay";
const BORDER_ID = "cropClip-border";
const STYLE_ID = "cropClip-style";
const MIN_WIDTH = 50;
const MIN_HEIGHT = 50;
const BORDER_WIDTH = 2;
const RESIZE_HIT_SIZE = 22;
const CROP_ACCENT = "#5bd6bf";
const MAX_PART_BYTES = 40 * 1024 * 1024;
const MAX_PART_SECONDS = 45;
const CHZZK_TOOL_BUTTON_ID = "cropClip-chzzk-tool-button";
const CHZZK_TOOL_BUTTON_CLASS = "pzp-button pzp-pc-setting-button pzp-pc__setting-button pzp-pc-ui-button cropClip-pzp-button";

type DownloadFormat = "auto" | "webm" | "mp4";
type BitratePreset = "low" | "standard" | "high" | "veryHigh" | "custom";
type TargetHeight = "source" | 480 | 720 | 1080;

interface Settings {
  outputFormat: DownloadFormat;
  bitratePreset: BitratePreset;
  videoBitsPerSecond: number;
  customVideoBitsPerSecond?: number;
  enable60fps: boolean;
  targetHeight: TargetHeight;
  includeAudio: boolean;
  autoSplit: boolean;
  audioGain: number;
  audioBitsPerSecond: number;
  splitSeconds: number;
}

interface RegionSelection {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  selectedAt: number;
}

interface LocalRecordingState {
  status: "idle" | "recording" | "completed" | "error";
  startedAt?: number;
}

type ContentCommand =
  | { type: "START_SELECTION" }
  | { type: "CLEAR_REGION" }
  | { type: "GET_REGION_GEOMETRY" }
  | {
      type: "START_DIRECT_RECORDING";
      recordingId: string;
      region: RegionSelection;
      settings: Settings;
    }
  | { type: "STOP_DIRECT_RECORDING" };
type PlayerStatusRequest = { type: "GET_PLAYER_STATUS" };

type PlayerStatusResponse =
  | {
      ok: true;
      data: {
        available: boolean;
        muted: boolean;
        volume: number;
        paused: boolean;
        hasAudioTracks: boolean;
        label: string;
      };
    }
  | { ok: false; error: string };

type MessageResponse = { ok: true } | { ok: false; error: string };
type RegionGeometryResponse = { ok: true; data: RegionSelection } | { ok: false; error: string };

interface DirectRecordingSession {
  recordingId: string;
  region: RegionSelection;
  settings: Settings;
  video: HTMLVideoElement;
  sourceStream: MediaStream;
  outputStream: MediaStream;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  recorder?: MediaRecorder;
  mimeType: string;
  extension: "webm" | "mp4";
  outputFormat: "webm" | "mp4";
  baseName: string;
  partNumber: number;
  totalSize: number;
  currentChunks: BlobPart[];
  currentBytes: number;
  createdAt: number;
  partStartedAt: number;
  drawTimerId: number;
  splitTimerId: number | null;
  stopRequested: boolean;
  closingPart: boolean;
  continueAfterStop: boolean;
  finishPromise: Promise<void>;
  resolveFinish: () => void;
  rejectFinish: (error: Error) => void;
  crop: { x: number; y: number; width: number; height: number };
  output: { width: number; height: number };
}

let currentOverlay: HTMLDivElement | null = null;
let currentBorder: HTMLDivElement | null = null;
let currentRegion: RegionSelection | null = null;
let selectionActive = false;
let removeSelectionHandlers: (() => void) | null = null;
let removeBorderHandlers: (() => void) | null = null;
let currentRecordingState: LocalRecordingState = { status: "idle" };
let directSession: DirectRecordingSession | null = null;
let chzzkToolObserver: MutationObserver | null = null;
let chzzkToolSyncFrame: number | null = null;
let chzzkToolHandlersInstalled = false;

function ensureStyle(): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }

  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      cursor: crosshair;
      background: rgba(10, 15, 20, 0.32);
      backdrop-filter: saturate(110%);
      user-select: none;
    }

    #${OVERLAY_ID} .hint {
      position: absolute;
      top: 16px;
      left: 16px;
      max-width: min(92vw, 360px);
      padding: 10px 12px;
      border-radius: 12px;
      background: rgba(16, 22, 30, 0.92);
      color: #eef4fb;
      font: 600 13px/1.35 "Segoe UI Variable", "Noto Sans KR", system-ui, sans-serif;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.26);
    }

    #${OVERLAY_ID} .error {
      margin-top: 8px;
      color: #ffb0b0;
      font-weight: 500;
    }

    #${OVERLAY_ID} .selection {
      position: fixed;
      border: 2px solid ${CROP_ACCENT};
      background: rgba(91, 214, 191, 0.12);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2) inset;
      pointer-events: none;
      display: none;
    }

    #${BORDER_ID} {
      position: fixed;
      z-index: 2147483646;
      outline: ${BORDER_WIDTH}px solid rgba(91, 214, 191, 0.9);
      box-shadow: 0 0 0 1px rgba(8, 16, 24, 0.42);
      pointer-events: none;
      border-radius: 2px;
      box-sizing: border-box;
    }

    #${BORDER_ID} .resize-zone {
      position: absolute;
      z-index: 2;
      background: transparent;
      pointer-events: auto;
      box-sizing: border-box;
    }

    #${BORDER_ID} .resize-zone[data-edge="n"] {
      top: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      left: 0;
      right: 0;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: ns-resize;
    }

    #${BORDER_ID} .resize-zone[data-edge="s"] {
      bottom: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      left: 0;
      right: 0;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: ns-resize;
    }

    #${BORDER_ID} .resize-zone[data-edge="w"] {
      left: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      top: 0;
      bottom: 0;
      width: ${RESIZE_HIT_SIZE}px;
      cursor: ew-resize;
    }

    #${BORDER_ID} .resize-zone[data-edge="e"] {
      right: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      top: 0;
      bottom: 0;
      width: ${RESIZE_HIT_SIZE}px;
      cursor: ew-resize;
    }

    #${BORDER_ID} .resize-zone[data-edge="nw"] {
      left: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      top: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      width: ${RESIZE_HIT_SIZE}px;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: nwse-resize;
    }

    #${BORDER_ID} .resize-zone[data-edge="ne"] {
      right: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      top: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      width: ${RESIZE_HIT_SIZE}px;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: nesw-resize;
    }

    #${BORDER_ID} .resize-zone[data-edge="sw"] {
      left: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      bottom: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      width: ${RESIZE_HIT_SIZE}px;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: nesw-resize;
    }

    #${BORDER_ID} .resize-zone[data-edge="se"] {
      right: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      bottom: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      width: ${RESIZE_HIT_SIZE}px;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: nwse-resize;
    }

    #${BORDER_ID} .region-toolbar {
      position: absolute;
      right: -2px;
      top: -30px;
      z-index: 5;
      display: flex;
      gap: 4px;
      pointer-events: auto;
    }

    #${BORDER_ID} .region-tool {
      min-width: 24px;
      height: 22px;
      border: 1px solid rgba(238, 244, 251, 0.5);
      border-radius: 8px;
      background: rgba(6, 13, 20, 0.86);
      color: #f4fbff;
      cursor: pointer;
      font: 800 11px/20px "Segoe UI Variable", "Noto Sans KR", system-ui, sans-serif;
      padding: 0 6px;
      text-align: center;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.36);
    }

    #${BORDER_ID} .region-tool:hover {
      background: rgba(14, 24, 34, 0.9);
      border-color: rgba(238, 244, 251, 0.54);
    }

    #${BORDER_ID} .region-tool:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }

    #${BORDER_ID}[data-recording="true"] .resize-zone {
      pointer-events: none;
    }

    #${BORDER_ID} .record-time {
      min-width: 42px;
      height: 22px;
      padding: 0 7px;
      border: 1px solid rgba(238, 244, 251, 0.36);
      border-radius: 8px;
      background: rgba(6, 13, 20, 0.86);
      color: #f4fbff;
      font: 800 11px/20px "Segoe UI Variable", "Noto Sans KR", system-ui, sans-serif;
      text-align: center;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.36);
    }

    #${BORDER_ID} .record-time[hidden] {
      display: none;
    }

    #${BORDER_ID} .record-region {
      min-width: 26px;
      color: #f4fbff;
    }

    #${BORDER_ID} .record-region:hover {
      color: #ffffff;
    }

    #${BORDER_ID} .record-region[data-recording="true"] {
      color: #ff7474;
    }

    #${BORDER_ID} .record-region[data-recording="true"]:hover {
      color: #ff8a8a;
    }

    #${BORDER_ID} .move-region {
      cursor: move;
    }

    #${BORDER_ID} .clear-region {
      color: rgba(255, 215, 215, 0.96);
    }

    .cropClip-pzp-button {
      color: #ffffff;
    }

    .cropClip-pzp-button .pzp-ui-icon {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .cropClip-pzp-button svg {
      width: 22px;
      height: 22px;
      pointer-events: none;
    }
  `;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getRecordButtonLabel(): string {
  return "⏺";
}

function isExtensionContextAvailable(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function getVideoStream(video: HTMLVideoElement): MediaStream | null {
  const source = video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
  return source.captureStream?.() ?? source.mozCaptureStream?.() ?? null;
}

function getRenderedVideoRect(video: HTMLVideoElement): { rect: DOMRect; fit: "fill" | "uniform" } {
  const elementRect = video.getBoundingClientRect();
  const objectFit = getComputedStyle(video).objectFit || "fill";
  if (objectFit === "fill" || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return { rect: elementRect, fit: "fill" };
  }

  const videoRatio = video.videoWidth / video.videoHeight;
  const elementRatio = elementRect.width / elementRect.height;
  const useCover = objectFit === "cover";
  const useElementWidth = useCover ? elementRatio < videoRatio : elementRatio <= videoRatio;
  const width = useElementWidth ? elementRect.width : elementRect.height * videoRatio;
  const height = useElementWidth ? elementRect.width / videoRatio : elementRect.height;
  const left = elementRect.left + (elementRect.width - width) / 2;
  const top = elementRect.top + (elementRect.height - height) / 2;

  return {
    rect: new DOMRect(left, top, width, height),
    fit: "uniform",
  };
}

function getVideoSelectionRect(): DOMRect | null {
  const video = findPrimaryVideoElement();
  if (!video) {
    return null;
  }

  const rect = getRenderedVideoRect(video).rect;
  const left = clamp(rect.left, 0, window.innerWidth);
  const top = clamp(rect.top, 0, window.innerHeight);
  const right = clamp(rect.right, left, window.innerWidth);
  const bottom = clamp(rect.bottom, top, window.innerHeight);
  if (right - left <= 0 || bottom - top <= 0) {
    return null;
  }

  return new DOMRect(left, top, right - left, bottom - top);
}

function clampRegionToRect(region: RegionSelection, rect: DOMRect): RegionSelection {
  const width = Math.min(region.width, rect.width);
  const height = Math.min(region.height, rect.height);
  return {
    x: clamp(region.x, rect.left, rect.right - width),
    y: clamp(region.y, rect.top, rect.bottom - height),
    width,
    height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    selectedAt: Date.now(),
  };
}

function computeDirectCrop(region: RegionSelection, video: HTMLVideoElement): { x: number; y: number; width: number; height: number } | null {
  const rendered = getRenderedVideoRect(video);
  const regionLeft = region.x;
  const regionTop = region.y;
  const regionRight = region.x + region.width;
  const regionBottom = region.y + region.height;
  const cropLeft = clamp(regionLeft, rendered.rect.left, rendered.rect.right);
  const cropTop = clamp(regionTop, rendered.rect.top, rendered.rect.bottom);
  const cropRight = clamp(regionRight, rendered.rect.left, rendered.rect.right);
  const cropBottom = clamp(regionBottom, rendered.rect.top, rendered.rect.bottom);

  if (cropRight <= cropLeft || cropBottom <= cropTop) {
    return null;
  }

  if (rendered.fit === "fill") {
    const elementRect = rendered.rect;
    const scaleX = video.videoWidth / elementRect.width;
    const scaleY = video.videoHeight / elementRect.height;
    const x = clamp(Math.round((cropLeft - elementRect.left) * scaleX), 0, Math.max(0, video.videoWidth - 1));
    const y = clamp(Math.round((cropTop - elementRect.top) * scaleY), 0, Math.max(0, video.videoHeight - 1));
    const right = clamp(Math.round((cropRight - elementRect.left) * scaleX), x + 1, video.videoWidth);
    const bottom = clamp(Math.round((cropBottom - elementRect.top) * scaleY), y + 1, video.videoHeight);
    return { x, y, width: right - x, height: bottom - y };
  }

  const scale = video.videoWidth / rendered.rect.width;
  const x = clamp(Math.round((cropLeft - rendered.rect.left) * scale), 0, Math.max(0, video.videoWidth - 1));
  const y = clamp(Math.round((cropTop - rendered.rect.top) * scale), 0, Math.max(0, video.videoHeight - 1));
  const right = clamp(Math.round((cropRight - rendered.rect.left) * scale), x + 1, video.videoWidth);
  const bottom = clamp(Math.round((cropBottom - rendered.rect.top) * scale), y + 1, video.videoHeight);
  return { x, y, width: right - x, height: bottom - y };
}

function computeDirectOutput(crop: { width: number; height: number }, settings: Settings): { width: number; height: number } {
  if (settings.targetHeight === "source" || crop.height <= settings.targetHeight) {
    return {
      width: Math.max(1, Math.round(crop.width)),
      height: Math.max(1, Math.round(crop.height)),
    };
  }

  const height = settings.targetHeight;
  const width = Math.max(1, Math.round((crop.width / crop.height) * height));
  return { width, height };
}

function selectDirectMimeType(settings: Settings): { mimeType: string; extension: "webm" | "mp4"; outputFormat: "webm" | "mp4" } {
  const mp4Candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs="avc1,mp4a.40.2"',
    "video/mp4",
  ];
  const webmCandidates = [
    "video/webm;codecs=avc1",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
  ];
  const candidates = settings.outputFormat === "mp4" ? mp4Candidates : webmCandidates;

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return {
        mimeType,
        extension: settings.outputFormat === "mp4" ? "mp4" : "webm",
        outputFormat: settings.outputFormat === "mp4" ? "mp4" : "webm",
      };
    }
  }

  if (settings.outputFormat === "mp4") {
    throw new Error("이 브라우저에서는 MP4 녹화가 제대로 동작하지 않습니다. WebM으로 변경하세요.");
  }

  throw new Error("이 브라우저에서는 WebM 녹화가 제대로 동작하지 않습니다.");
}

function buildBaseName(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `cropClip_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function buildDirectFilename(session: DirectRecordingSession): string {
  const splitSeconds = session.settings.autoSplit ? session.settings.splitSeconds : 0;
  if (splitSeconds > 0) {
    return `${session.baseName}_part_${String(session.partNumber).padStart(3, "0")}.${session.extension}`;
  }

  return `${session.baseName}.${session.extension}`;
}

function sendRuntimeMessage<T = undefined>(message: Record<string, unknown>): Promise<MessageResponse & { data?: T }> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response?: MessageResponse & { data?: T }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(response ?? { ok: true });
    });
  });
}

async function saveDirectPart(session: DirectRecordingSession, blob: Blob): Promise<void> {
  if (blob.size <= 0) {
    throw new Error("녹화 데이터가 비어 있습니다.");
  }

  const response = await sendRuntimeMessage({
    type: "STORE_RECORDING_PART",
    part: {
      id: `${session.recordingId}:part:${String(session.partNumber).padStart(3, "0")}`,
      recordingId: session.recordingId,
      index: session.partNumber,
      filename: buildDirectFilename(session),
      mimeType: session.mimeType,
      extension: session.extension,
      outputFormat: session.outputFormat,
      size: blob.size,
      objectUrl: URL.createObjectURL(blob),
      createdAt: Date.now(),
    },
  });
  if (!response.ok) {
    throw new Error(response.error);
  }

  session.totalSize += blob.size;
}

function clearDirectTimers(session: DirectRecordingSession): void {
  window.clearInterval(session.drawTimerId);
  if (session.splitTimerId !== null) {
    window.clearTimeout(session.splitTimerId);
    session.splitTimerId = null;
  }
}

async function finalizeDirectRecording(session: DirectRecordingSession): Promise<void> {
  clearDirectTimers(session);
  session.sourceStream.getTracks().forEach((track) => track.stop());
  session.outputStream.getTracks().forEach((track) => track.stop());
  session.canvas.remove();
  directSession = null;

  try {
    await sendRuntimeMessage({
      type: "RECORDING_FINISHED",
      recording: {
        id: session.recordingId,
        createdAt: session.createdAt,
        endedAt: Date.now(),
        settings: session.settings,
        region: session.region,
        partCount: session.partNumber,
        totalSize: session.totalSize,
        actualMimeType: session.mimeType,
        actualExtension: session.extension,
        requestedOutputFormat: session.settings.outputFormat,
        actualOutputFormat: session.outputFormat,
      },
    });
    session.resolveFinish();
  } catch (error) {
    session.rejectFinish(error instanceof Error ? error : new Error("녹화 결과를 저장하지 못했습니다."));
  }
}

function requestDirectPartStop(session: DirectRecordingSession, continueAfterStop: boolean): void {
  if (!session.recorder || session.recorder.state === "inactive" || session.closingPart) {
    return;
  }

  session.closingPart = true;
  session.continueAfterStop = continueAfterStop;
  try {
    session.recorder.requestData();
  } catch {
    // Some browsers throw if data is not ready yet.
  }
  session.recorder.stop();
}

function scheduleDirectSplit(session: DirectRecordingSession): void {
  if (!session.settings.autoSplit) {
    return;
  }

  const splitSeconds = Math.min(session.settings.splitSeconds, MAX_PART_SECONDS);
  if (splitSeconds <= 0) {
    return;
  }

  session.splitTimerId = window.setTimeout(() => {
    requestDirectPartStop(session, true);
  }, splitSeconds * 1000);
}

async function startDirectPart(session: DirectRecordingSession): Promise<void> {
  session.currentChunks = [];
  session.currentBytes = 0;
  session.partStartedAt = Date.now();
  session.closingPart = false;
  session.continueAfterStop = false;

  const recorder = new MediaRecorder(session.outputStream, {
    mimeType: session.mimeType,
    videoBitsPerSecond: session.settings.videoBitsPerSecond,
    audioBitsPerSecond: session.settings.audioBitsPerSecond,
  });
  session.recorder = recorder;

  recorder.ondataavailable = (event) => {
    if (event.data.size <= 0) {
      return;
    }

    session.currentChunks.push(event.data);
    session.currentBytes += event.data.size;
    if (session.settings.autoSplit && session.currentBytes >= MAX_PART_BYTES) {
      requestDirectPartStop(session, true);
    }
  };

  recorder.onerror = () => {
    const error = new Error("녹화 중 오류가 발생했습니다.");
    session.rejectFinish(error);
    void sendRuntimeMessage({
      type: "RECORDING_ERROR",
      recordingId: session.recordingId,
      error: error.message,
    });
  };

  recorder.onstop = () => {
    void (async () => {
      const blob = new Blob(session.currentChunks, { type: session.mimeType });
      await saveDirectPart(session, blob);

      if (session.continueAfterStop && !session.stopRequested) {
        session.partNumber += 1;
        await startDirectPart(session);
        return;
      }

      await finalizeDirectRecording(session);
    })().catch((error: Error) => {
      session.rejectFinish(error);
      void sendRuntimeMessage({
        type: "RECORDING_ERROR",
        recordingId: session.recordingId,
        error: error.message,
      });
      clearDirectTimers(session);
      directSession = null;
    });
  };

  recorder.start(1000);
  scheduleDirectSplit(session);
}

async function startDirectRecording(command: Extract<ContentCommand, { type: "START_DIRECT_RECORDING" }>): Promise<MessageResponse> {
  if (directSession) {
    return { ok: false, error: "이미 녹화가 진행 중입니다." };
  }

  const video = findPrimaryVideoElement();
  if (!video) {
    return { ok: false, error: "재생 가능한 비디오 요소를 찾지 못했습니다." };
  }

  if (video.muted || video.volume === 0) {
    return { ok: false, error: "현재 탭의 영상이 음소거되어 있어 녹화할 수 없습니다." };
  }

  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    return { ok: false, error: "비디오 크기를 확인할 수 없습니다." };
  }

  const crop = computeDirectCrop(command.region, video);
  if (!crop) {
    return { ok: false, error: "선택 영역이 비디오 화면과 겹치지 않습니다." };
  }

  const output = computeDirectOutput(crop, command.settings);
  const sourceStream = getVideoStream(video);
  if (!sourceStream) {
    return { ok: false, error: "이 브라우저에서는 비디오 스트림 직접 녹화를 지원하지 않습니다." };
  }

  const canvas = document.createElement("canvas");
  canvas.width = output.width;
  canvas.height = output.height;
  canvas.style.position = "fixed";
  canvas.style.left = "-9999px";
  canvas.style.top = "0";
  document.documentElement.appendChild(canvas);

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    canvas.remove();
    sourceStream.getTracks().forEach((track) => track.stop());
    return { ok: false, error: "캔버스 렌더링을 초기화할 수 없습니다." };
  }

  const frameRate = command.settings.enable60fps ? 60 : 30;
  const canvasStream = canvas.captureStream(frameRate);
  const tracks = [
    ...canvasStream.getVideoTracks(),
    ...(command.settings.includeAudio ? sourceStream.getAudioTracks() : []),
  ];
  const outputStream = new MediaStream(tracks);
  const mime = selectDirectMimeType(command.settings);

  const drawFrame = () => {
    context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, output.width, output.height);
  };
  drawFrame();

  let resolveFinish: () => void = () => {};
  let rejectFinish: (error: Error) => void = () => {};
  const finishPromise = new Promise<void>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });

  const session: DirectRecordingSession = {
    recordingId: command.recordingId,
    region: command.region,
    settings: command.settings,
    video,
    sourceStream,
    outputStream,
    canvas,
    context,
    mimeType: mime.mimeType,
    extension: mime.extension,
    outputFormat: mime.outputFormat,
    baseName: buildBaseName(),
    partNumber: 1,
    totalSize: 0,
    currentChunks: [],
    currentBytes: 0,
    createdAt: Date.now(),
    partStartedAt: 0,
    drawTimerId: window.setInterval(drawFrame, Math.max(16, Math.round(1000 / frameRate))),
    splitTimerId: null,
    stopRequested: false,
    closingPart: false,
    continueAfterStop: false,
    finishPromise,
    resolveFinish,
    rejectFinish,
    crop,
    output,
  };

  directSession = session;
  await startDirectPart(session);
  return { ok: true };
}

async function stopDirectRecording(): Promise<MessageResponse> {
  const session = directSession;
  if (!session) {
    return { ok: false, error: "진행 중인 녹화가 없습니다." };
  }

  session.stopRequested = true;
  requestDirectPartStop(session, false);
  await session.finishPromise;
  return { ok: true };
}

function stopDirectRecordingForUnload(): void {
  if (!directSession || directSession.stopRequested) {
    return;
  }

  directSession.stopRequested = true;
  requestDirectPartStop(directSession, false);
}

function showSelectionBorder(region: RegionSelection | null): void {
  ensureStyle();
  removeBorderHandlers?.();
  removeBorderHandlers = null;
  currentBorder?.remove();
  currentBorder = null;

  if (!region) {
    return;
  }

  const border = document.createElement("div");
  border.id = BORDER_ID;
  border.innerHTML = `
    <div class="region-toolbar">
      <span class="record-time" hidden>00:00</span>
      <button class="region-tool record-region" type="button" aria-label="녹화 시작" title="녹화 시작">⏺</button>
      <button class="region-tool move-region" type="button" aria-label="영역 이동" title="영역 이동">✥</button>
      <button class="region-tool clear-region" type="button" aria-label="영역 해제" title="영역 해제">×</button>
    </div>
    <span class="resize-zone" data-edge="n" aria-hidden="true"></span>
    <span class="resize-zone" data-edge="s" aria-hidden="true"></span>
    <span class="resize-zone" data-edge="w" aria-hidden="true"></span>
    <span class="resize-zone" data-edge="e" aria-hidden="true"></span>
    <span class="resize-zone" data-edge="nw" aria-hidden="true"></span>
    <span class="resize-zone" data-edge="ne" aria-hidden="true"></span>
    <span class="resize-zone" data-edge="sw" aria-hidden="true"></span>
    <span class="resize-zone" data-edge="se" aria-hidden="true"></span>
  `;
  applyBorderGeometry(border, region);
  attachBorderControls(border);
  document.body.appendChild(border);
  currentBorder = border;
}

function applyBorderGeometry(border: HTMLDivElement, region: RegionSelection): void {
  const bounds = getVideoSelectionRect();
  const displayRegion = bounds ? clampRegionToRect(region, bounds) : region;
  const left = clamp(displayRegion.x, 0, Math.max(0, window.innerWidth - 1));
  const top = clamp(displayRegion.y, 0, Math.max(0, window.innerHeight - 1));
  const width = Math.min(displayRegion.width, Math.max(1, window.innerWidth - left));
  const height = Math.min(displayRegion.height, Math.max(1, window.innerHeight - top));
  border.style.left = `${left}px`;
  border.style.top = `${top}px`;
  border.style.width = `${width}px`;
  border.style.height = `${height}px`;
}

function attachBorderControls(border: HTMLDivElement): void {
  const cleanupCallbacks: Array<() => void> = [];
  const recordTime = border.querySelector<HTMLElement>(".record-time");
  const recordButton = border.querySelector<HTMLButtonElement>(".record-region");
  const clearButton = border.querySelector<HTMLButtonElement>(".clear-region");
  const moveButton = border.querySelector<HTMLButtonElement>(".move-region");

  const updateRecordButton = () => {
    if (!recordButton) {
      return;
    }

    const isRecording = currentRecordingState.status === "recording";
    const label = isRecording ? "녹화 중지" : "녹화 시작";
    recordButton.textContent = getRecordButtonLabel();
    recordButton.setAttribute("aria-label", label);
    recordButton.title = label;
    if (isRecording) {
      recordButton.dataset.recording = "true";
      border.dataset.recording = "true";
    } else {
      delete recordButton.dataset.recording;
      delete border.dataset.recording;
    }
    if (clearButton) {
      clearButton.disabled = isRecording;
    }
    if (moveButton) {
      moveButton.disabled = isRecording;
    }
    if (recordTime) {
      recordTime.hidden = !isRecording;
      recordTime.textContent = currentRecordingState.startedAt ? formatElapsed(Date.now() - currentRecordingState.startedAt) : "00:00";
    }
  };

  const onRecord = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const type = currentRecordingState.status === "recording" ? "STOP_RECORDING" : "START_RECORDING";
    if (!isExtensionContextAvailable()) {
      window.alert("확장 프로그램이 새로고침되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
      return;
    }

    try {
      chrome.runtime.sendMessage({ type }, (response?: MessageResponse) => {
        if (chrome.runtime.lastError) {
          window.alert(chrome.runtime.lastError.message);
          return;
        }

        if (response && !response.ok) {
          window.alert(response.error);
        }
      });
    } catch {
      window.alert("확장 프로그램이 새로고침되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
    }
  };

  updateRecordButton();
  recordButton?.addEventListener("click", onRecord);
  if (recordButton) {
    cleanupCallbacks.push(() => recordButton.removeEventListener("click", onRecord));
  }

  if (currentRecordingState.status === "recording") {
    const timerId = window.setInterval(updateRecordButton, 1000);
    cleanupCallbacks.push(() => window.clearInterval(timerId));
  }

  const onClear = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (currentRecordingState.status === "recording") {
      return;
    }

    void clearRegion();
    currentRegion = null;
    showSelectionBorder(null);
  };

  clearButton?.addEventListener("click", onClear);
  if (clearButton) {
    cleanupCallbacks.push(() => clearButton.removeEventListener("click", onClear));
  }

  const startMove = (event: PointerEvent) => {
    if (!currentRegion || currentRecordingState.status === "recording") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    moveButton?.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = currentRegion.x;
    const startTop = currentRegion.y;
    const bounds = getVideoSelectionRect();
    if (!bounds) {
      return;
    }
    const width = Math.min(currentRegion.width, bounds.width);
    const height = Math.min(currentRegion.height, bounds.height);

    const onMove = (moveEvent: PointerEvent) => {
      const left = clamp(startLeft + moveEvent.clientX - startX, bounds.left, bounds.right - width);
      const top = clamp(startTop + moveEvent.clientY - startY, bounds.top, bounds.bottom - height);

      currentRegion = {
        x: left,
        y: top,
        width,
        height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        selectedAt: Date.now(),
      };
      applyBorderGeometry(border, currentRegion);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (currentRegion) {
        void saveRegion(currentRegion);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  moveButton?.addEventListener("pointerdown", startMove);
  if (moveButton) {
    cleanupCallbacks.push(() => moveButton.removeEventListener("pointerdown", startMove));
  }

  const startResize = (event: PointerEvent) => {
    const target = event.currentTarget as HTMLElement;
    const edge = target.dataset.edge;
    if (!edge || !currentRegion || currentRecordingState.status === "recording") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = currentRegion.x;
    const startTop = currentRegion.y;
    const startRight = currentRegion.x + currentRegion.width;
    const startBottom = currentRegion.y + currentRegion.height;
    const bounds = getVideoSelectionRect();
    if (!bounds) {
      return;
    }
    const minWidth = Math.min(MIN_WIDTH, bounds.width);
    const minHeight = Math.min(MIN_HEIGHT, bounds.height);

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      let left = startLeft;
      let top = startTop;
      let right = startRight;
      let bottom = startBottom;

      if (edge.includes("w")) {
        left = clamp(startLeft + dx, bounds.left, right - minWidth);
      }
      if (edge.includes("e")) {
        right = clamp(startRight + dx, left + minWidth, bounds.right);
      }
      if (edge.includes("n")) {
        top = clamp(startTop + dy, bounds.top, bottom - minHeight);
      }
      if (edge.includes("s")) {
        bottom = clamp(startBottom + dy, top + minHeight, bounds.bottom);
      }

      currentRegion = {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        selectedAt: Date.now(),
      };
      applyBorderGeometry(border, currentRegion);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (currentRegion) {
        void saveRegion(currentRegion);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const zones = Array.from(border.querySelectorAll<HTMLElement>(".resize-zone"));
  for (const zone of zones) {
    zone.addEventListener("pointerdown", startResize);
    cleanupCallbacks.push(() => zone.removeEventListener("pointerdown", startResize));
  }

  removeBorderHandlers = () => {
    for (const cleanup of cleanupCallbacks) {
      cleanup();
    }
  };
}

async function loadState(): Promise<{ region: RegionSelection | null; recordingState: LocalRecordingState }> {
  if (!isExtensionContextAvailable()) {
    return {
      region: null,
      recordingState: { status: "idle" },
    };
  }

  let result: { region?: unknown; recordingState?: unknown };
  try {
    result = await chrome.storage.local.get({
      region: null,
      recordingState: { status: "idle" as const },
    });
  } catch {
    return {
      region: null,
      recordingState: { status: "idle" },
    };
  }

  return {
    region: normalizeRegion(result.region),
    recordingState: normalizeRecordingState(result.recordingState),
  };
}

function normalizeRegion(raw: unknown): RegionSelection | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Partial<RegionSelection>;
  const fields = [value.x, value.y, value.width, value.height, value.viewportWidth, value.viewportHeight, value.devicePixelRatio, value.selectedAt];
  if (fields.some((item) => !Number.isFinite(Number(item)))) {
    return null;
  }

  return {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
    viewportWidth: Math.max(1, Number(value.viewportWidth)),
    viewportHeight: Math.max(1, Number(value.viewportHeight)),
    devicePixelRatio: Math.max(0.1, Number(value.devicePixelRatio)),
    selectedAt: Number(value.selectedAt),
  };
}

function normalizeRecordingState(raw: unknown): LocalRecordingState {
  const value = raw as Partial<LocalRecordingState> | null | undefined;
  if (value?.status === "recording" || value?.status === "completed" || value?.status === "error") {
    return {
      status: value.status,
      startedAt: Number.isFinite(value.startedAt as number) ? Number(value.startedAt) : undefined,
    };
  }

  return { status: "idle" };
}

async function saveRegion(region: RegionSelection): Promise<boolean> {
  if (!isExtensionContextAvailable()) {
    return false;
  }

  try {
    await chrome.storage.local.set({ region });
    return true;
  } catch {
    return false;
  }
}

async function clearRegion(): Promise<boolean> {
  if (!isExtensionContextAvailable()) {
    return false;
  }

  try {
    await chrome.storage.local.set({ region: null });
    return true;
  } catch {
    return false;
  }
}

async function refreshBorder(): Promise<void> {
  const state = await loadState();
  currentRegion = state.region;
  currentRecordingState = state.recordingState;
  showSelectionBorder(currentRegion);

  if (state.recordingState.status === "recording" && selectionActive) {
    cancelSelection("녹화 중에는 영역을 다시 선택할 수 없습니다.");
  }
}

async function initializePageState(): Promise<void> {
  const state = await loadState();
  currentRecordingState = state.recordingState;

  if (state.recordingState.status !== "recording" && state.region) {
    await clearRegion();
    currentRegion = null;
    showSelectionBorder(null);
    return;
  }

  currentRegion = state.region;
  showSelectionBorder(currentRegion);
}

function teardownOverlay(): void {
  removeSelectionHandlers?.();
  removeSelectionHandlers = null;
  currentOverlay?.remove();
  currentOverlay = null;
  selectionActive = false;
}

function setOverlayError(message: string): void {
  if (!currentOverlay) {
    return;
  }

  const errorNode = currentOverlay.querySelector<HTMLElement>("[data-role='error']");
  if (errorNode) {
    errorNode.textContent = message;
  }
}

function updateSelectionBox(box: HTMLDivElement, startX: number, startY: number, endX: number, endY: number): void {
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  const width = Math.abs(endX - startX);
  const height = Math.abs(endY - startY);

  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  box.style.display = width > 0 && height > 0 ? "block" : "none";
}

function cancelSelection(message?: string): void {
  if (message) {
    setOverlayError(message);
  }

  teardownOverlay();
}

async function commitSelection(region: RegionSelection): Promise<void> {
  const bounds = getVideoSelectionRect();
  const nextRegion = bounds ? clampRegionToRect(region, bounds) : region;
  const saved = await saveRegion(nextRegion);
  if (!saved) {
    setOverlayError("확장 프로그램이 새로고침되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
    return;
  }

  currentRegion = nextRegion;
  showSelectionBorder(nextRegion);
  teardownOverlay();
}

function getCurrentRegionGeometry(): RegionSelection | null {
  const sourceRect = currentBorder?.getBoundingClientRect();
  if (!sourceRect && !currentRegion) {
    return null;
  }

  const inset = BORDER_WIDTH;
  const left = (sourceRect ? sourceRect.left : currentRegion?.x ?? 0) + inset;
  const top = (sourceRect ? sourceRect.top : currentRegion?.y ?? 0) + inset;
  const right = (sourceRect ? sourceRect.right : (currentRegion?.x ?? 0) + (currentRegion?.width ?? 0)) - inset;
  const bottom = (sourceRect ? sourceRect.bottom : (currentRegion?.y ?? 0) + (currentRegion?.height ?? 0)) - inset;
  const bounds = getVideoSelectionRect();
  const limitLeft = bounds?.left ?? 0;
  const limitTop = bounds?.top ?? 0;
  const limitRight = bounds?.right ?? window.innerWidth;
  const limitBottom = bounds?.bottom ?? window.innerHeight;
  const x = clamp(left, limitLeft, limitRight);
  const y = clamp(top, limitTop, limitBottom);
  const width = clamp(right, x + 1, limitRight) - x;
  const height = clamp(bottom, y + 1, limitBottom) - y;

  return {
    x,
    y,
    width,
    height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    selectedAt: Date.now(),
  };
}

function startSelection(): void {
  if (selectionActive) {
    return;
  }

  ensureStyle();
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <div class="hint">
      드래그해서 녹화할 영역을 선택하세요.
      <div>ESC로 취소할 수 있습니다.</div>
      <div data-role="error" class="error"></div>
    </div>
    <div class="selection"></div>
  `;

  document.body.appendChild(overlay);
  currentOverlay = overlay;
  selectionActive = true;

  const selectionBox = overlay.querySelector<HTMLDivElement>(".selection");
  if (!selectionBox) {
    teardownOverlay();
    return;
  }

  let dragging = false;
  let startX = 0;
  let startY = 0;

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    const bounds = getVideoSelectionRect();
    if (!bounds) {
      setOverlayError("재생 가능한 비디오 영역을 찾지 못했습니다.");
      return;
    }

    dragging = true;
    startX = clamp(event.clientX, bounds.left, bounds.right);
    startY = clamp(event.clientY, bounds.top, bounds.bottom);
    updateSelectionBox(selectionBox, startX, startY, startX, startY);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging) {
      return;
    }

    const bounds = getVideoSelectionRect();
    if (!bounds) {
      return;
    }

    updateSelectionBox(selectionBox, startX, startY, clamp(event.clientX, bounds.left, bounds.right), clamp(event.clientY, bounds.top, bounds.bottom));
    event.preventDefault();
  };

  const onPointerUp = async (event: PointerEvent) => {
    if (!dragging) {
      return;
    }

    dragging = false;
    const bounds = getVideoSelectionRect();
    if (!bounds) {
      setOverlayError("재생 가능한 비디오 영역을 찾지 못했습니다.");
      return;
    }

    const endX = clamp(event.clientX, bounds.left, bounds.right);
    const endY = clamp(event.clientY, bounds.top, bounds.bottom);
    const x = Math.min(startX, endX);
    const y = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    if (width < MIN_WIDTH || height < MIN_HEIGHT) {
      setOverlayError(`영역은 최소 ${MIN_WIDTH}px x ${MIN_HEIGHT}px 이상이어야 합니다.`);
      updateSelectionBox(selectionBox, 0, 0, 0, 0);
      return;
    }

    const region: RegionSelection = {
      x,
      y,
      width,
      height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      selectedAt: Date.now(),
    };

    await commitSelection(region);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelSelection();
    }
  };

  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKeyDown, { once: false });

  const cleanup = () => {
    overlay.removeEventListener("pointerdown", onPointerDown);
    overlay.removeEventListener("pointermove", onPointerMove);
    overlay.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
  };

  removeSelectionHandlers = cleanup;

  const observer = new MutationObserver(() => {
    if (!document.body.contains(overlay)) {
      cleanup();
      observer.disconnect();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function getCropIconSvg(): string {
  return `
    <svg width="24" height="24" viewBox="0 0 36 36" fill="none" aria-hidden="true" focusable="false">
      <path d="M8.5 14V8.5H14" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M22 8.5H27.5V14" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8.5 22V27.5H14" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M22 27.5H27.5V22" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="18" cy="18" r="3" fill="currentColor"/>
    </svg>
  `;
}

function setChzzkButtonContent(button: HTMLElement): void {
  button.setAttribute("aria-label", "클립 영역 선택");
  button.removeAttribute("title");
  button.innerHTML = `
    <span class="pzp-button__tooltip pzp-button__tooltip--top">클립 영역 선택</span>
    <span class="pzp-ui-icon pzp-pc-setting-button__icon">${getCropIconSvg()}</span>
  `;
}

function isChzzkToolEvent(event: Event): boolean {
  return event.composedPath().some((item) => item instanceof HTMLElement && item.id === CHZZK_TOOL_BUTTON_ID);
}

function handleChzzkToolEvent(event: Event): void {
  if (!isChzzkToolEvent(event)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  startSelection();
}

function installChzzkToolHandlers(): void {
  if (chzzkToolHandlersInstalled) {
    return;
  }

  document.addEventListener("pointerdown", handleChzzkToolEvent, true);
  document.addEventListener("click", handleChzzkToolEvent, true);
  chzzkToolHandlersInstalled = true;
}

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function getVisiblePzpButtons(root: ParentNode = document): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ".pzp-button, button[class*='pzp'][class*='button'], [role='button'][class*='pzp'][class*='button']",
    ),
  ).filter((button) => button.id !== CHZZK_TOOL_BUTTON_ID && isVisibleElement(button));
}

function compareBottomRight(a: DOMRect, b: DOMRect): number {
  const bottomDifference = b.bottom - a.bottom;
  if (Math.abs(bottomDifference) > 24) {
    return bottomDifference;
  }
  return b.right - a.right;
}

function findChzzkButtonHost(): { host: HTMLElement; reference: HTMLElement } | null {
  const explicitHosts = Array.from(
    document.querySelectorAll<HTMLElement>(
      [
        ".pzp-pc__bottom-buttons-right",
        ".pzp-pc-ui-bottom__right",
        "[class*='pzp'][class*='bottom'][class*='right']",
        "[class*='pzp'][class*='control'][class*='right']",
      ].join(","),
    ),
  )
    .filter(isVisibleElement)
    .map((host) => {
      const reference = getVisiblePzpButtons(host)[0];
      return reference ? { host, reference, rect: host.getBoundingClientRect() } : null;
    })
    .filter((item): item is { host: HTMLElement; reference: HTMLElement; rect: DOMRect } => item !== null)
    .sort((a, b) => compareBottomRight(a.rect, b.rect));

  const explicitHost = explicitHosts[0];
  if (explicitHost) {
    return { host: explicitHost.host, reference: explicitHost.reference };
  }

  const videoRect = findPrimaryVideoElement()?.getBoundingClientRect();
  const groups = new Map<HTMLElement, { host: HTMLElement; reference: HTMLElement; rect: DOMRect }>();
  for (const button of getVisiblePzpButtons()) {
    const host = button.parentElement;
    if (!host || !isVisibleElement(host)) {
      continue;
    }

    const buttonRect = button.getBoundingClientRect();
    if (videoRect && (buttonRect.bottom < videoRect.top || buttonRect.top > videoRect.bottom + 48)) {
      continue;
    }

    const current = groups.get(host);
    if (!current || buttonRect.left < current.reference.getBoundingClientRect().left) {
      groups.set(host, { host, reference: button, rect: host.getBoundingClientRect() });
    }
  }

  const candidates = Array.from(groups.values())
    .filter((item) => {
      if (!videoRect) {
        return true;
      }
      return item.rect.bottom >= videoRect.top && item.rect.top <= videoRect.bottom + 48;
    })
    .sort((a, b) => compareBottomRight(a.rect, b.rect));

  const fallback = candidates[0];
  return fallback ? { host: fallback.host, reference: fallback.reference } : null;
}

function syncChzzkToolButton(): void {
  if (!location.hostname.includes("chzzk.naver.com")) {
    return;
  }

  const existing = document.getElementById(CHZZK_TOOL_BUTTON_ID);
  const target = findChzzkButtonHost();
  if (!target) {
    existing?.remove();
    return;
  }

  const { host } = target;
  if (existing && existing.parentElement === host) {
    existing.className = CHZZK_TOOL_BUTTON_CLASS;
    setChzzkButtonContent(existing);
    return;
  }

  existing?.remove();
  const button = document.createElement("button");
  button.id = CHZZK_TOOL_BUTTON_ID;
  button.className = CHZZK_TOOL_BUTTON_CLASS;
  button.type = "button";
  setChzzkButtonContent(button);
  const firstControl = Array.from(host.children).find(
    (child) => child instanceof HTMLElement && child.id !== CHZZK_TOOL_BUTTON_ID,
  );
  host.insertBefore(button, firstControl ?? null);
}

function requestChzzkToolSync(): void {
  if (chzzkToolSyncFrame !== null) {
    return;
  }

  chzzkToolSyncFrame = window.requestAnimationFrame(() => {
    chzzkToolSyncFrame = null;
    syncChzzkToolButton();
  });
}

function installChzzkToolButton(): void {
  ensureStyle();
  installChzzkToolHandlers();
  syncChzzkToolButton();
  chzzkToolObserver?.disconnect();
  chzzkToolObserver = new MutationObserver(() => requestChzzkToolSync());
  chzzkToolObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function isRecordingState(value: LocalRecordingState): boolean {
  return value.status === "recording";
}

function findPrimaryVideoElement(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) {
    return null;
  }

  let best = videos[0];
  let bestArea = 0;
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (area > bestArea) {
      best = video;
      bestArea = area;
    }
  }

  return best;
}

function getPlayerStatus(): PlayerStatusResponse {
  const video = findPrimaryVideoElement();
  if (!video) {
    return {
      ok: false,
      error: "재생 가능한 비디오 요소를 찾지 못했습니다.",
    };
  }

  const muted = video.muted;
  const label = muted
    ? "현재 탭의 영상이 음소거되어 있습니다."
    : video.paused
      ? "현재 탭의 영상이 재생 중이 아닙니다."
      : "";

  return {
    ok: true,
    data: {
      available: true,
      muted,
      volume: video.volume,
      paused: video.paused,
      hasAudioTracks: true,
      label,
    },
  };
}

chrome.runtime.onMessage.addListener((message: ContentCommand | PlayerStatusRequest, _sender, sendResponse: (response: MessageResponse | PlayerStatusResponse | RegionGeometryResponse) => void) => {
  if (message.type === "GET_PLAYER_STATUS") {
    const status = getPlayerStatus();
    sendResponse(status.ok && status.data.muted ? { ok: false, error: status.data.label || "재생 상태를 확인할 수 없습니다." } : status);
    return false;
  }

  if (message.type === "CLEAR_REGION") {
    void (async () => {
      await clearRegion();
      showSelectionBorder(null);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "GET_REGION_GEOMETRY") {
    const region = getCurrentRegionGeometry();
    sendResponse(region ? { ok: true, data: region } : { ok: false, error: "현재 선택된 녹화 영역을 찾지 못했습니다." });
    return false;
  }

  if (message.type === "START_DIRECT_RECORDING") {
    void startDirectRecording(message)
      .then((response) => sendResponse(response))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "STOP_DIRECT_RECORDING") {
    void stopDirectRecording()
      .then((response) => sendResponse(response))
      .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type !== "START_SELECTION") {
    return false;
  }

  void (async () => {
    const state = await loadState();

    if (isRecordingState(state.recordingState)) {
      sendResponse({ ok: false, error: "녹화 중에는 영역을 선택할 수 없습니다." });
      return;
    }

    startSelection();
    sendResponse({ ok: true });
  })();

  return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.region) {
    currentRegion = normalizeRegion(changes.region.newValue);
    void refreshBorder();
  }

  if (changes.recordingState) {
    const nextState = normalizeRecordingState(changes.recordingState.newValue);
    currentRecordingState = nextState;
    if (nextState.status === "recording" && selectionActive) {
      cancelSelection("녹화 중에는 영역을 다시 선택할 수 없습니다.");
    }
    showSelectionBorder(currentRegion);
  }
});

window.addEventListener("resize", () => {
  void refreshBorder();
});

window.addEventListener("pagehide", () => {
  stopDirectRecordingForUnload();
});

window.addEventListener("beforeunload", () => {
  if (!directSession) {
    return;
  }

  stopDirectRecordingForUnload();
});

window.addEventListener("keydown", (event) => {
  if (!directSession) {
    return;
  }

  const isReloadKey = event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
  if (!isReloadKey) {
    return;
  }

  event.preventDefault();
  void stopDirectRecording().catch((error: Error) => {
    window.alert(error.message);
  });
}, true);

  void initializePageState();
  installChzzkToolButton();
})();
