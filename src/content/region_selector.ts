(() => {
  const CONTENT_SCRIPT_BOOT_KEY = "__cropClipRegionSelectorBooted";
  const contentScriptGlobal = globalThis as typeof globalThis & { [CONTENT_SCRIPT_BOOT_KEY]?: boolean };

  if (contentScriptGlobal[CONTENT_SCRIPT_BOOT_KEY]) {
    return;
  }
  contentScriptGlobal[CONTENT_SCRIPT_BOOT_KEY] = true;

const OVERLAY_ID = "crop-clip-overlay";
const BORDER_ID = "crop-clip-border";
const SCREENSHOT_STACK_ID = "crop-clip-screenshot-stack";
const STYLE_ID = "crop-clip-style";
const MIN_WIDTH = 50;
const MIN_HEIGHT = 50;
const BORDER_WIDTH = 2;
const RESIZE_HIT_SIZE = 22;
const CROP_ACCENT = "#5bd6bf";
const MAX_SCREENSHOT_PREVIEWS = 8;
const AUDIO_BITS_PER_SECOND = 128_000;
const CHZZK_TOOL_BUTTON_ID = "crop-clip-chzzk-tool-button";
const CHZZK_TOOL_BUTTON_CLASS = "pzp-button pzp-pc-setting-button pzp-pc__setting-button pzp-pc-ui-button crop-clip-pzp-button";
const YOUTUBE_TOOL_BUTTON_ID = "crop-clip-youtube-tool-button";
const YOUTUBE_TOOL_BUTTON_CLASS = "ytp-button";
const PLAYER_TOOL_LABEL = "녹화 영역 선택";

type ContentCommand = import("../shared/messages.js").ContentCommand;
type MessageResponse<T = undefined> = import("../shared/messages.js").MessageResponse<T>;
type PlayerStatusRequest = import("../shared/messages.js").PlayerStatusRequest;
type RecordingState = import("../shared/types.js").RecordingState;
type RegionSelection = import("../shared/types.js").RegionSelection;
type Settings = import("../shared/types.js").Settings;
type LocalRecordingState = Pick<RecordingState, "status" | "startedAt">;

type PlayerStatusResponse =
  | {
      ok: true;
      data: {
        muted: boolean;
        volume: number;
      };
    }
  | { ok: false; error: string };

type RegionGeometryResponse = MessageResponse<RegionSelection>;

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
  createdAt: number;
  drawTimerId: number;
  stopRequested: boolean;
  closingPart: boolean;
  finishPromise: Promise<void>;
  resolveFinish: () => void;
  rejectFinish: (error: Error) => void;
  crop: { x: number; y: number; width: number; height: number };
  output: { width: number; height: number };
  sourceChangeCleanup?: () => void;
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
let youtubeToolSyncTimer: number | null = null;
let regionLayoutTimerId: number | null = null;
let lastVideoLayoutKey = "";

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

    #${BORDER_ID} .region-tool svg {
      display: block;
      width: 14px;
      height: 14px;
      pointer-events: none;
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
      border-color: rgba(255, 116, 116, 0.55);
      box-shadow: 0 0 0 1px rgba(255, 116, 116, 0.28);
    }

    #${BORDER_ID} .record-region[data-recording="true"]:hover {
      color: #ff8a8a;
      border-color: rgba(255, 138, 138, 0.7);
      box-shadow: 0 0 0 1px rgba(255, 138, 138, 0.36);
    }

    #${BORDER_ID} .move-region {
      cursor: move;
    }

    #${BORDER_ID} .clear-region {
      color: rgba(255, 215, 215, 0.96);
    }

    #${SCREENSHOT_STACK_ID} {
      position: fixed;
      z-index: 2147483645;
      width: min(240px, 42vw);
      pointer-events: auto;
    }

    #${SCREENSHOT_STACK_ID} .screenshot-card {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      overflow: hidden;
      border: 1px solid rgba(91, 214, 191, 0.5);
      border-radius: 8px;
      background: rgba(5, 10, 16, 0.9);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.38);
    }

    #${SCREENSHOT_STACK_ID} img {
      display: block;
      width: 100%;
      max-height: 150px;
      object-fit: contain;
      background: #000;
    }

    #${SCREENSHOT_STACK_ID} .screenshot-actions {
      position: absolute;
      top: 4px;
      right: 4px;
      display: flex;
      gap: 4px;
    }

    #${SCREENSHOT_STACK_ID} .screenshot-action {
      width: 22px;
      height: 22px;
      border: 1px solid rgba(238, 244, 251, 0.52);
      border-radius: 7px;
      background: rgba(6, 13, 20, 0.84);
      color: #f4fbff;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    #${SCREENSHOT_STACK_ID} .screenshot-action:hover {
      background: rgba(15, 26, 36, 0.94);
    }

    #${SCREENSHOT_STACK_ID} .screenshot-action svg {
      width: 14px;
      height: 14px;
      pointer-events: none;
    }

    .crop-clip-pzp-button {
      color: #ffffff;
    }

    .crop-clip-pzp-button .pzp-ui-icon {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .crop-clip-pzp-button svg {
      width: 22px;
      height: 22px;
      pointer-events: none;
    }

    @media (max-width: 543px) {
      #${YOUTUBE_TOOL_BUTTON_ID} {
        top: -4px;
      }

      #${YOUTUBE_TOOL_BUTTON_ID} .crop-clip-ytp-tooltip {
        top: -52px !important;
      }
    }

    #${YOUTUBE_TOOL_BUTTON_ID} {
      position: relative;
      color: #fff;
      overflow: visible !important;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      padding: 0 !important;
      margin: 0 !important;
      vertical-align: middle;
    }

    #${YOUTUBE_TOOL_BUTTON_ID} svg {
      display: block;
      width: 36px;
      height: 36px;
      pointer-events: none;
    }

    #${YOUTUBE_TOOL_BUTTON_ID} .crop-clip-ytp-tooltip {
      position: absolute;
      left: 50%;
      top: -48px;
      z-index: 100000;
      display: block;
      padding: 0;
      border-radius: 8px;
      background: transparent;
      color: #fff;
      font: 500 13px/1.2 Roboto, Arial, sans-serif;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transform: translateX(-50%);
      transition: opacity 0.08s cubic-bezier(0, 0, 0.2, 1);
    }

    #${YOUTUBE_TOOL_BUTTON_ID} .ytp-tooltip-bottom-text {
      display: block;
      padding: 6px 10px;
      border-radius: 8px;
      background: hsla(0, 0%, 6.7%, 0.4);
      color: #fff;
    }

    #${YOUTUBE_TOOL_BUTTON_ID} .ytp-tooltip-text-wrapper {
      display: block;
    }

    #${YOUTUBE_TOOL_BUTTON_ID}:hover .crop-clip-ytp-tooltip,
    #${YOUTUBE_TOOL_BUTTON_ID}:focus-visible .crop-clip-ytp-tooltip {
      opacity: 1;
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

function getVideoRenderedViewportRect(): DOMRect | null {
  const video = findPrimaryVideoElement();
  return video ? getRenderedVideoRect(video).rect : null;
}

function buildRegionSelection(x: number, y: number, width: number, height: number): RegionSelection {
  const renderedRect = getVideoRenderedViewportRect();
  const relativeX = renderedRect && renderedRect.width > 0 ? clamp((x - renderedRect.left) / renderedRect.width, 0, 1) : 0;
  const relativeY = renderedRect && renderedRect.height > 0 ? clamp((y - renderedRect.top) / renderedRect.height, 0, 1) : 0;
  const relative =
    renderedRect && renderedRect.width > 0 && renderedRect.height > 0
      ? {
          x: relativeX,
          y: relativeY,
          width: clamp(width / renderedRect.width, 0, 1 - relativeX),
          height: clamp(height / renderedRect.height, 0, 1 - relativeY),
        }
      : undefined;

  return {
    x,
    y,
    width,
    height,
    ...(relative ? { videoRelative: relative } : {}),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    selectedAt: Date.now(),
  };
}

function resolveRegionToViewport(region: RegionSelection): RegionSelection {
  const renderedRect = getVideoRenderedViewportRect();
  const relative = region.videoRelative;
  if (!renderedRect || !relative) {
    const bounds = getVideoSelectionRect();
    return bounds ? clampRegionToRect(region, bounds) : region;
  }

  return buildRegionSelection(
    renderedRect.left + renderedRect.width * relative.x,
    renderedRect.top + renderedRect.height * relative.y,
    renderedRect.width * relative.width,
    renderedRect.height * relative.height,
  );
}

function clampRegionToRect(region: RegionSelection, rect: DOMRect): RegionSelection {
  const width = Math.min(region.width, rect.width);
  const height = Math.min(region.height, rect.height);
  return buildRegionSelection(clamp(region.x, rect.left, rect.right - width), clamp(region.y, rect.top, rect.bottom - height), width, height);
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

function computeDirectOutput(crop: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(crop.width)),
    height: Math.max(1, Math.round(crop.height)),
  };
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

function getCameraIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M7.5 7.5L9 5.5H15L16.5 7.5H19C20.1 7.5 21 8.4 21 9.5V18C21 19.1 20.1 20 19 20H5C3.9 20 3 19.1 3 18V9.5C3 8.4 3.9 7.5 5 7.5H7.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="12" cy="13.5" r="3.2" stroke="currentColor" stroke-width="2"/>
    </svg>
  `;
}

function getDownloadIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 4V15M12 15L7.5 10.5M12 15L16.5 10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M5 19H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;
}

function blobFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("스크린샷 이미지를 만들지 못했습니다."));
    }, "image/png");
  });
}

function positionScreenshotStack(stack: HTMLElement): void {
  const rect = getVideoSelectionRect();
  const left = rect ? rect.left + 10 : 10;
  const top = rect ? rect.top + 10 : 10;
  stack.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - 80))}px`;
  stack.style.top = `${clamp(top, 8, Math.max(8, window.innerHeight - 80))}px`;
}

function getScreenshotStack(): HTMLDivElement {
  let stack = document.getElementById(SCREENSHOT_STACK_ID) as HTMLDivElement | null;
  if (!stack) {
    stack = document.createElement("div");
    stack.id = SCREENSHOT_STACK_ID;
    document.body.appendChild(stack);
  }

  positionScreenshotStack(stack);
  return stack;
}

function removeScreenshotCard(card: HTMLElement): void {
  if (card.dataset.objectUrl) {
    URL.revokeObjectURL(card.dataset.objectUrl);
  }
  const stack = card.parentElement;
  card.remove();
  if (stack?.childElementCount === 0) {
    stack.remove();
  }
}

function showScreenshotPreview(blob: Blob): void {
  const stack = getScreenshotStack();
  const objectUrl = URL.createObjectURL(blob);
  const filename = `${buildBaseName()}_screenshot.png`;
  const card = document.createElement("div");
  card.className = "screenshot-card";
  card.dataset.objectUrl = objectUrl;
  card.style.zIndex = String(Math.max(0, ...Array.from(stack.children, (item) => Number(getComputedStyle(item).zIndex) || 0)) + 1);
  card.innerHTML = `
    <img alt="스크린샷 미리보기" src="${objectUrl}">
    <div class="screenshot-actions">
      <button class="screenshot-action save" type="button" aria-label="스크린샷 저장" title="스크린샷 저장">${getDownloadIconSvg()}</button>
      <button class="screenshot-action close" type="button" aria-label="스크린샷 닫기" title="스크린샷 닫기">×</button>
    </div>
  `;

  card.querySelector<HTMLButtonElement>(".save")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.click();
  });
  card.querySelector<HTMLButtonElement>(".close")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    removeScreenshotCard(card);
  });

  stack.prepend(card);
  while (stack.childElementCount > MAX_SCREENSHOT_PREVIEWS) {
    const oldest = stack.lastElementChild;
    if (!(oldest instanceof HTMLElement)) {
      break;
    }
    removeScreenshotCard(oldest);
  }
}

async function captureRegionScreenshot(): Promise<void> {
  const region = getCurrentRegionGeometry();
  const video = findPrimaryVideoElement();
  if (!region || !video) {
    window.alert("스크린샷을 찍을 영역을 찾지 못했습니다.");
    return;
  }

  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    window.alert("비디오 크기를 확인할 수 없습니다.");
    return;
  }

  const crop = computeDirectCrop(region, video);
  if (!crop) {
    window.alert("선택 영역이 비디오 화면과 겹치지 않습니다.");
    return;
  }

  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    window.alert("스크린샷 캔버스를 만들지 못했습니다.");
    return;
  }

  try {
    context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    showScreenshotPreview(await blobFromCanvas(canvas));
  } catch {
    window.alert("이 영상은 브라우저 보안 제한으로 스크린샷 저장을 지원하지 않습니다.");
  }
}

function buildDirectFilename(session: DirectRecordingSession): string {
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
}

async function finalizeDirectRecording(session: DirectRecordingSession): Promise<void> {
  clearDirectTimers(session);
  session.sourceChangeCleanup?.();
  session.sourceChangeCleanup = undefined;
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

function stopDirectRecordingAfterSourceChange(session: DirectRecordingSession): void {
  if (directSession !== session || session.stopRequested) {
    return;
  }

  session.stopRequested = true;
  requestDirectPartStop(session);
}

function watchDirectRecordingSource(session: DirectRecordingSession): void {
  const stop = () => stopDirectRecordingAfterSourceChange(session);
  const sourceTracks = session.sourceStream.getTracks();
  session.video.addEventListener("ended", stop);
  session.video.addEventListener("loadstart", stop);
  session.video.addEventListener("emptied", stop);
  sourceTracks.forEach((track) => track.addEventListener("ended", stop));
  session.sourceChangeCleanup = () => {
    session.video.removeEventListener("ended", stop);
    session.video.removeEventListener("loadstart", stop);
    session.video.removeEventListener("emptied", stop);
    sourceTracks.forEach((track) => track.removeEventListener("ended", stop));
  };
}

function requestDirectPartStop(session: DirectRecordingSession): void {
  if (!session.recorder || session.recorder.state === "inactive" || session.closingPart) {
    return;
  }

  session.closingPart = true;
  try {
    session.recorder.requestData();
  } catch {
    // Some browsers throw if data is not ready yet.
  }
  session.recorder.stop();
}

async function startDirectPart(session: DirectRecordingSession): Promise<void> {
  session.currentChunks = [];
  session.closingPart = false;

  const recorder = new MediaRecorder(session.outputStream, {
    mimeType: session.mimeType,
    videoBitsPerSecond: session.settings.videoBitsPerSecond,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  });
  session.recorder = recorder;

  recorder.ondataavailable = (event) => {
    if (event.data.size <= 0) {
      return;
    }

    session.currentChunks.push(event.data);
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

  const output = computeDirectOutput(crop);
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
    ...sourceStream.getAudioTracks(),
  ];
  const outputStream = new MediaStream(tracks);
  const mime = selectDirectMimeType(command.settings);

  const drawFrame = () => {
    const nextCrop = computeDirectCrop(resolveRegionToViewport(command.region), video);
    if (nextCrop) {
      session.crop = nextCrop;
    }
    context.drawImage(video, session.crop.x, session.crop.y, session.crop.width, session.crop.height, 0, 0, output.width, output.height);
  };

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
    createdAt: Date.now(),
    drawTimerId: window.setInterval(drawFrame, Math.max(16, Math.round(1000 / frameRate))),
    stopRequested: false,
    closingPart: false,
    finishPromise,
    resolveFinish,
    rejectFinish,
    crop,
    output,
  };

  directSession = session;
  drawFrame();
  await startDirectPart(session);
  watchDirectRecordingSource(session);
  return { ok: true };
}

async function stopDirectRecording(): Promise<MessageResponse> {
  const session = directSession;
  if (!session) {
    return { ok: false, error: "진행 중인 녹화가 없습니다." };
  }

  session.stopRequested = true;
  requestDirectPartStop(session);
  await session.finishPromise;
  return { ok: true };
}

function stopDirectRecordingForUnload(): void {
  if (!directSession || directSession.stopRequested) {
    return;
  }

  directSession.stopRequested = true;
  requestDirectPartStop(directSession);
}

function showSelectionBorder(region: RegionSelection | null): void {
  ensureStyle();
  stopRegionLayoutWatch();
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
      <button class="region-tool screenshot-region" type="button" aria-label="스크린샷" title="스크린샷">${getCameraIconSvg()}</button>
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
  startRegionLayoutWatch(border);
}

function getVideoLayoutKey(): string {
  const rect = getVideoRenderedViewportRect();
  return rect ? `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}` : "";
}

function stopRegionLayoutWatch(): void {
  if (regionLayoutTimerId !== null) {
    window.clearInterval(regionLayoutTimerId);
    regionLayoutTimerId = null;
  }
  lastVideoLayoutKey = "";
}

function startRegionLayoutWatch(border: HTMLDivElement): void {
  lastVideoLayoutKey = getVideoLayoutKey();
  regionLayoutTimerId = window.setInterval(() => {
    if (!currentRegion || !document.body.contains(border)) {
      stopRegionLayoutWatch();
      return;
    }

    const nextKey = getVideoLayoutKey();
    if (nextKey === lastVideoLayoutKey) {
      return;
    }

    lastVideoLayoutKey = nextKey;
    applyBorderGeometry(border, currentRegion);
    const stack = document.getElementById(SCREENSHOT_STACK_ID);
    if (stack) {
      positionScreenshotStack(stack);
    }
  }, 300);
}

function applyBorderGeometry(border: HTMLDivElement, region: RegionSelection): void {
  const displayRegion = resolveRegionToViewport(region);
  const visibleLeft = Math.max(displayRegion.x, 0);
  const visibleTop = Math.max(displayRegion.y, 0);
  const visibleRight = Math.min(displayRegion.x + displayRegion.width, window.innerWidth);
  const visibleBottom = Math.min(displayRegion.y + displayRegion.height, window.innerHeight);
  if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
    border.style.display = "none";
    return;
  }

  border.style.display = "";
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
  const screenshotButton = border.querySelector<HTMLButtonElement>(".screenshot-region");
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

    if (type === "START_RECORDING") {
      currentRecordingState = { status: "recording", startedAt: Date.now() };
      updateRecordButton();
    }

    const previousRecordingState = currentRecordingState;
    if (type === "STOP_RECORDING") {
      currentRecordingState = { status: "idle" };
      updateRecordButton();
    }

    try {
      chrome.runtime.sendMessage({ type }, (response?: MessageResponse) => {
        if (chrome.runtime.lastError) {
          if (type === "START_RECORDING") {
            currentRecordingState = { status: "idle" };
            updateRecordButton();
          } else if (type === "STOP_RECORDING") {
            currentRecordingState = previousRecordingState;
            updateRecordButton();
          }
          window.alert(chrome.runtime.lastError.message);
          return;
        }

        if (response && !response.ok) {
          if (type === "START_RECORDING") {
            currentRecordingState = { status: "idle" };
            updateRecordButton();
          } else if (type === "STOP_RECORDING") {
            currentRecordingState = previousRecordingState;
            updateRecordButton();
          }
          window.alert(response.error);
        }
      });
    } catch {
      if (type === "START_RECORDING") {
        currentRecordingState = { status: "idle" };
        updateRecordButton();
      } else if (type === "STOP_RECORDING") {
        currentRecordingState = previousRecordingState;
        updateRecordButton();
      }
      window.alert("확장 프로그램이 새로고침되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
    }
  };

  updateRecordButton();
  recordButton?.addEventListener("click", onRecord);
  if (recordButton) {
    cleanupCallbacks.push(() => recordButton.removeEventListener("click", onRecord));
  }

  const onScreenshot = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    void captureRegionScreenshot();
  };

  screenshotButton?.addEventListener("click", onScreenshot);
  if (screenshotButton) {
    cleanupCallbacks.push(() => screenshotButton.removeEventListener("click", onScreenshot));
  }

  const timerId = window.setInterval(updateRecordButton, 1000);
  cleanupCallbacks.push(() => window.clearInterval(timerId));

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
    const startRegion = resolveRegionToViewport(currentRegion);
    const startLeft = startRegion.x;
    const startTop = startRegion.y;
    const bounds = getVideoSelectionRect();
    if (!bounds) {
      return;
    }
    const width = Math.min(startRegion.width, bounds.width);
    const height = Math.min(startRegion.height, bounds.height);

    const onMove = (moveEvent: PointerEvent) => {
      const left = clamp(startLeft + moveEvent.clientX - startX, bounds.left, bounds.right - width);
      const top = clamp(startTop + moveEvent.clientY - startY, bounds.top, bounds.bottom - height);

      currentRegion = buildRegionSelection(left, top, width, height);
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
    const startRegion = resolveRegionToViewport(currentRegion);
    const startLeft = startRegion.x;
    const startTop = startRegion.y;
    const startRight = startRegion.x + startRegion.width;
    const startBottom = startRegion.y + startRegion.height;
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

      currentRegion = buildRegionSelection(left, top, right - left, bottom - top);
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
  const relative = value.videoRelative;
  const videoRelative =
    relative &&
    [relative.x, relative.y, relative.width, relative.height].every((item) => Number.isFinite(Number(item))) &&
    Number(relative.width) > 0 &&
    Number(relative.height) > 0
      ? {
          x: Number(relative.x),
          y: Number(relative.y),
          width: Number(relative.width),
          height: Number(relative.height),
        }
      : undefined;

  return {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
    ...(videoRelative ? { videoRelative } : {}),
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
  const nextRegion = bounds ? clampRegionToRect(region, bounds) : buildRegionSelection(region.x, region.y, region.width, region.height);
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
  if (currentRegion?.videoRelative) {
    return resolveRegionToViewport(currentRegion);
  }

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

  return buildRegionSelection(x, y, width, height);
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

    await commitSelection(buildRegionSelection(x, y, width, height));
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
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true" focusable="false">
      <path d="M8.5 14V8.5H14" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M22 8.5H27.5V14" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8.5 22V27.5H14" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M22 27.5H27.5V22" stroke="currentColor" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="18" cy="18" r="3" fill="currentColor"/>
    </svg>
  `;
}

function setChzzkButtonContent(button: HTMLElement): void {
  button.setAttribute("aria-label", PLAYER_TOOL_LABEL);
  button.setAttribute("type", "button");
  button.removeAttribute("title");
  button.innerHTML = `
    <span class="pzp-button__tooltip pzp-button__tooltip--top">${PLAYER_TOOL_LABEL}</span>
    <span class="pzp-ui-icon pzp-pc-setting-button__icon">${getCropIconSvg()}</span>
  `;
}

function setYoutubeButtonContent(button: HTMLElement): void {
  button.id = YOUTUBE_TOOL_BUTTON_ID;
  button.className = YOUTUBE_TOOL_BUTTON_CLASS;
  button.setAttribute("type", "button");
  button.hidden = false;
  button.removeAttribute("style");
  button.removeAttribute("disabled");
  button.setAttribute("aria-label", PLAYER_TOOL_LABEL);
  button.setAttribute("data-priority", "4");
  button.setAttribute("data-title-no-tooltip", PLAYER_TOOL_LABEL);
  button.setAttribute("data-tooltip-text", PLAYER_TOOL_LABEL);
  button.setAttribute("data-tooltip-title", PLAYER_TOOL_LABEL);
  button.removeAttribute("title");
  button.removeAttribute("aria-keyshortcuts");
  button.removeAttribute("aria-owns");
  button.removeAttribute("aria-haspopup");
  button.removeAttribute("aria-pressed");
  button.removeAttribute("data-tooltip-target-id");
  button.innerHTML = `
    ${getCropIconSvg()}
    <div class="crop-clip-ytp-tooltip ytp-tooltip" role="tooltip">
      <div class="ytp-tooltip-text-wrapper">
        <div class="ytp-tooltip-bottom-text">
          <span class="ytp-tooltip-text">${PLAYER_TOOL_LABEL}</span>
        </div>
      </div>
    </div>
  `;
}

function handlePlayerToolActivation(event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  startSelection();
}

function bindDirectPlayerToolActivation(button: HTMLElement): void {
  if (button.dataset.cropClipBound === "true") {
    return;
  }

  button.dataset.cropClipBound = "true";
  button.addEventListener("pointerdown", handlePlayerToolActivation);
  button.addEventListener("click", handlePlayerToolActivation);
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
    bindDirectPlayerToolActivation(existing);
    return;
  }

  existing?.remove();
  const button = document.createElement("button");
  button.id = CHZZK_TOOL_BUTTON_ID;
  button.className = CHZZK_TOOL_BUTTON_CLASS;
  button.type = "button";
  setChzzkButtonContent(button);
  bindDirectPlayerToolActivation(button);
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

function isYoutubePage(): boolean {
  return location.hostname.includes("youtube.com") || location.hostname.includes("youtu.be");
}

function findYoutubeButtonHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ytp-right-controls-left")
    ?? document.querySelector<HTMLElement>(".ytp-right-controls")
    ?? document.querySelector<HTMLElement>(".ytp-chrome-bottom .ytp-right-controls")
    ?? document.querySelector<HTMLElement>(".html5-video-player .ytp-right-controls");
}

function syncYoutubeToolButton(): void {
  if (!isYoutubePage() || !location.pathname.startsWith("/watch")) {
    document.getElementById(YOUTUBE_TOOL_BUTTON_ID)?.remove();
    return;
  }

  const host = findYoutubeButtonHost();
  if (!host) {
    return;
  }

  const existingButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(`#${YOUTUBE_TOOL_BUTTON_ID}`));
  const existing = existingButtons.find((item) => item.parentElement === host) ?? existingButtons[0];
  const button = existing ?? document.createElement("button");
  for (const extraButton of existingButtons) {
    if (extraButton !== button) {
      extraButton.remove();
    }
  }

  setYoutubeButtonContent(button);
  bindDirectPlayerToolActivation(button);

  if (button.parentElement !== host) {
    const insertionPoint = Array.from(host.children).find(
      (child) => child instanceof HTMLElement && child.id !== YOUTUBE_TOOL_BUTTON_ID,
    );
    if (insertionPoint && insertionPoint.parentElement === host) {
      host.insertBefore(button, insertionPoint);
    } else {
      host.appendChild(button);
    }
  }
}

function requestYoutubeToolSync(delay = 100): void {
  if (youtubeToolSyncTimer !== null) {
    window.clearTimeout(youtubeToolSyncTimer);
  }

  youtubeToolSyncTimer = window.setTimeout(() => {
    youtubeToolSyncTimer = null;
    syncYoutubeToolButton();
  }, delay);
}

function installChzzkToolButton(): void {
  if (!location.hostname.includes("chzzk.naver.com")) {
    return;
  }

  ensureStyle();
  syncChzzkToolButton();
  chzzkToolObserver?.disconnect();
  chzzkToolObserver = new MutationObserver(() => requestChzzkToolSync());
  chzzkToolObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function installYoutubeToolButton(): void {
  if (!isYoutubePage()) {
    return;
  }

  ensureStyle();
  requestYoutubeToolSync(0);
  window.addEventListener("yt-navigate-finish", () => requestYoutubeToolSync(300), true);
  window.setTimeout(() => requestYoutubeToolSync(0), 800);
  window.setTimeout(() => requestYoutubeToolSync(0), 2000);
}

function installPlayerToolButtons(): void {
  installChzzkToolButton();
  installYoutubeToolButton();
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

  return { ok: true, data: { muted: video.muted, volume: video.volume } };
}

chrome.runtime.onMessage.addListener((message: ContentCommand | PlayerStatusRequest, _sender, sendResponse: (response: MessageResponse | PlayerStatusResponse | RegionGeometryResponse) => void) => {
  if (message.type === "GET_PLAYER_STATUS") {
    const status = getPlayerStatus();
    sendResponse(status.ok && status.data.muted ? { ok: false, error: "현재 탭의 영상이 음소거되어 있습니다." } : status);
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

window.addEventListener("scroll", () => {
  if (currentBorder && currentRegion) {
    applyBorderGeometry(currentBorder, currentRegion);
  }
}, true);

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
  installPlayerToolButtons();
})();
