(() => {
  // This file is emitted as a classic content script, so runtime imports are intentionally avoided.
  const CONTENT_SCRIPT_BOOT_KEY = "__cropClipRegionSelectorBooted";
  const contentScriptGlobal = globalThis as typeof globalThis & { [CONTENT_SCRIPT_BOOT_KEY]?: boolean };

  if (contentScriptGlobal[CONTENT_SCRIPT_BOOT_KEY]) {
    return;
  }
  contentScriptGlobal[CONTENT_SCRIPT_BOOT_KEY] = true;

const RECORDING_FORMAT = {
  webm: "webm",
  mp4: "mp4",
} as const;
const RECORDING_STATUS = {
  idle: "idle",
  recording: "recording",
  completed: "completed",
  error: "error",
} as const;
const RECORDING_MODE = {
  region: "region",
  full: "full",
} as const;
const OVERLAY_ID = "crop-clip-overlay";
const BORDER_ID = "crop-clip-border";
const BORDER_CLASS = "crop-clip-border";
const SEEK_FEEDBACK_ID = "crop-clip-seek-feedback";
const SCREENSHOT_STACK_ID = "crop-clip-screenshot-stack";
const STYLE_ID = "crop-clip-style";
const MIN_WIDTH = 50;
const MIN_HEIGHT = 50;
const BORDER_WIDTH = 2;
const RESIZE_HIT_SIZE = 22;
const SNAP_DISTANCE = 10;
const MAX_ACTIVE_REGIONS = 4;
const DEFAULT_MULTI_REGION_COUNT = 2;
const DEFAULT_SEEK_SECONDS = 5;
const DIRECT_RECORDING_PART_INDEX = 1;
const POINTER_CLICK_DEDUP_MS = 500;
const CROP_ACCENT = "#5bd6bf";
const CROP_SECONDARY = "#5bb0d6";
const CROP_REGION_COLORS = [CROP_ACCENT, CROP_SECONDARY, "#49c7e6", "#7be0b2"];
const CROP_GUIDE = "#ffd166";
const MAX_SCREENSHOT_PREVIEWS = 8;
const AUDIO_BITS_PER_SECOND = 128_000;
const CHZZK_RECORD_BUTTON_ID = "crop-clip-chzzk-record-button";
const CHZZK_RECORD_TIME_ID = "crop-clip-chzzk-record-time";
const CHZZK_CANCEL_BUTTON_ID = "crop-clip-chzzk-cancel-button";
const CHZZK_SCREENSHOT_BUTTON_ID = "crop-clip-chzzk-screenshot-button";
const CHZZK_TOOL_BUTTON_ID = "crop-clip-chzzk-tool-button";
const CHZZK_TOOL_BUTTON_CLASS = "pzp-button pzp-pc-setting-button pzp-pc__setting-button pzp-pc-ui-button crop-clip-pzp-button";
const PLAYER_TOOL_LABEL = "녹화 영역 선택";
const DEFAULT_CONTENT_SHORTCUT_KEYS: ShortcutKeys = {
  selectRegion: "a",
  clearRegion: "x",
  clearAllRegions: "z",
  regionRecord: "r",
  cancelRecording: "c",
  regionScreenshot: "s",
  fullRecord: "e",
  fullScreenshot: "d",
};

type ContentCommand = import("../shared/messages.js").ContentCommand;
type MessageResponse<T = undefined> = import("../shared/messages.js").MessageResponse<T>;
type PlayerStatusRequest = import("../shared/messages.js").PlayerStatusRequest;
type RecordingState = import("../shared/types.js").RecordingState;
type RegionSelection = import("../shared/types.js").RegionSelection;
type Settings = import("../shared/types.js").Settings;
type ShortcutAction = import("../shared/types.js").ShortcutAction;
type ShortcutKeys = import("../shared/types.js").ShortcutKeys;
type LocalRecordingState = Pick<RecordingState, "status" | "startedAt" | "mode">;

type PlayerStatusResponse =
  | {
      ok: true;
      data: {
        muted: boolean;
        volume: number;
      };
    }
  | { ok: false; error: string };

type GuideSide = "n" | "s" | "w" | "e";
type RegionGeometryResponse = MessageResponse<RegionSelection>;
type RegionGeometriesResponse = MessageResponse<RegionSelection[]>;

interface DirectCropPlacement {
  crop: DirectCrop;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

interface DirectCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DirectLayout {
  output: { width: number; height: number };
  placements: DirectCropPlacement[];
}

interface DirectRecordingSession {
  recordingId: string;
  settings: Settings;
  video: HTMLVideoElement;
  sourceStream: MediaStream;
  outputStream: MediaStream;
  canvas: HTMLCanvasElement;
  recorder?: MediaRecorder;
  mimeType: string;
  extension: "webm" | "mp4";
  outputFormat: "webm" | "mp4";
  baseName: string;
  totalSize: number;
  currentChunks: BlobPart[];
  createdAt: number;
  drawTimerId: number;
  stopRequested: boolean;
  cancelRequested: boolean;
  cleanedUp: boolean;
  closingPart: boolean;
  finishPromise: Promise<void>;
  resolveFinish: () => void;
  rejectFinish: (error: Error) => void;
  placements: DirectCropPlacement[];
  sourceChangeCleanup?: () => void;
}

let currentOverlay: HTMLDivElement | null = null;
let currentBorder: HTMLDivElement | null = null;
let currentRegion: RegionSelection | null = null;
let currentRegions: RegionSelection[] = [];
let currentBorders = new Map<number, HTMLDivElement>();
let activeRegionIndex = 0;
let selectionActive = false;
let multiRegionEnabled = false;
let multiRegionMaxCount = DEFAULT_MULTI_REGION_COUNT;
let fullRecordButtonEnabled = false;
let fullScreenshotButtonEnabled = false;
let seekEnabled = false;
let seekSeconds = DEFAULT_SEEK_SECONDS;
let streamerFilenameEnabled = false;
let shortcutsEnabled = false;
let shortcutKeys: ShortcutKeys = DEFAULT_CONTENT_SHORTCUT_KEYS;
let removeSelectionHandlers: (() => void) | null = null;
let removeBorderHandlers: (() => void) | null = null;
let currentRecordingState: LocalRecordingState = { status: RECORDING_STATUS.idle };
let directSession: DirectRecordingSession | null = null;
let recordingCommandInFlight = false;
let chzzkToolObserver: MutationObserver | null = null;
let chzzkToolSyncFrame: number | null = null;
let chzzkRecordTimerId: number | null = null;
let seekFeedbackTimerId: number | null = null;
let lastRecordPointerActivationAt = 0;
let lastScreenshotPointerActivationAt = 0;
let lastCancelPointerActivationAt = 0;
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

    .${BORDER_CLASS} {
      position: fixed;
      z-index: 2147483646;
      outline: ${BORDER_WIDTH}px solid var(--crop-clip-region-outline, rgba(91, 214, 191, 0.9));
      box-shadow: 0 0 0 1px rgba(8, 16, 24, 0.42);
      pointer-events: none;
      border-radius: 2px;
      box-sizing: border-box;
    }

    .${BORDER_CLASS}[data-active="true"] {
      box-shadow: 0 0 0 1px var(--crop-clip-region-shadow, rgba(91, 214, 191, 0.62)), 0 0 14px rgba(91, 214, 191, 0.16);
    }

    .${BORDER_CLASS}[data-active="false"] {
      box-shadow: 0 0 0 1px rgba(8, 16, 24, 0.34);
    }

    .${BORDER_CLASS} .guide-edge {
      position: absolute;
      z-index: 4;
      pointer-events: none;
      background: ${CROP_GUIDE};
      box-shadow: 0 0 8px rgba(255, 209, 102, 0.6);
    }

    .${BORDER_CLASS} .guide-edge[hidden] {
      display: none;
    }

    .${BORDER_CLASS} .guide-edge[data-side="n"] {
      left: 0;
      right: 0;
      top: -${BORDER_WIDTH}px;
      height: ${BORDER_WIDTH}px;
    }

    .${BORDER_CLASS} .guide-edge[data-side="s"] {
      left: 0;
      right: 0;
      bottom: -${BORDER_WIDTH}px;
      height: ${BORDER_WIDTH}px;
    }

    .${BORDER_CLASS} .guide-edge[data-side="w"] {
      left: -${BORDER_WIDTH}px;
      top: 0;
      bottom: 0;
      width: ${BORDER_WIDTH}px;
    }

    .${BORDER_CLASS} .guide-edge[data-side="e"] {
      right: -${BORDER_WIDTH}px;
      top: 0;
      bottom: 0;
      width: ${BORDER_WIDTH}px;
    }

    .${BORDER_CLASS} .resize-zone {
      position: absolute;
      z-index: 2;
      background: transparent;
      pointer-events: auto;
      box-sizing: border-box;
    }

    .${BORDER_CLASS} .resize-zone[data-edge="n"] {
      top: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      left: 0;
      right: 0;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: ns-resize;
    }

    .${BORDER_CLASS} .resize-zone[data-edge="s"] {
      bottom: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      left: 0;
      right: 0;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: ns-resize;
    }

    .${BORDER_CLASS} .resize-zone[data-edge="w"] {
      left: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      top: 0;
      bottom: 0;
      width: ${RESIZE_HIT_SIZE}px;
      cursor: ew-resize;
    }

    .${BORDER_CLASS} .resize-zone[data-edge="e"] {
      right: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      top: 0;
      bottom: 0;
      width: ${RESIZE_HIT_SIZE}px;
      cursor: ew-resize;
    }

    .${BORDER_CLASS} .resize-zone[data-edge="nw"] {
      left: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      top: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      width: ${RESIZE_HIT_SIZE}px;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: nwse-resize;
    }

    .${BORDER_CLASS} .resize-zone[data-edge="ne"] {
      right: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      top: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      width: ${RESIZE_HIT_SIZE}px;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: nesw-resize;
    }

    .${BORDER_CLASS} .resize-zone[data-edge="sw"] {
      left: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      bottom: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      width: ${RESIZE_HIT_SIZE}px;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: nesw-resize;
    }

    .${BORDER_CLASS} .resize-zone[data-edge="se"] {
      right: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      bottom: -${Math.round(RESIZE_HIT_SIZE / 2)}px;
      width: ${RESIZE_HIT_SIZE}px;
      height: ${RESIZE_HIT_SIZE}px;
      cursor: nwse-resize;
    }

    .${BORDER_CLASS} .region-toolbar {
      position: absolute;
      right: -2px;
      top: -30px;
      z-index: 5;
      display: flex;
      gap: 4px;
      pointer-events: auto;
    }

    .${BORDER_CLASS} .region-tool {
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

    .${BORDER_CLASS} .region-tool:hover {
      background: rgba(14, 24, 34, 0.9);
      border-color: rgba(238, 244, 251, 0.54);
    }

    .${BORDER_CLASS} .region-tool svg {
      display: block;
      width: 14px;
      height: 14px;
      pointer-events: none;
    }

    .${BORDER_CLASS} .region-tool:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }

    .${BORDER_CLASS}[data-recording="true"] .resize-zone {
      pointer-events: none;
    }

    .${BORDER_CLASS} .record-time {
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

    .${BORDER_CLASS} .record-time[hidden] {
      display: none;
    }

    .${BORDER_CLASS} .record-region {
      min-width: 26px;
      color: #f4fbff;
    }

    .${BORDER_CLASS} .record-region:hover {
      color: #ffffff;
    }

    .${BORDER_CLASS} .record-region[data-recording="true"] {
      color: #ff7474;
      border-color: rgba(255, 116, 116, 0.55);
      box-shadow: 0 0 0 1px rgba(255, 116, 116, 0.28);
    }

    .${BORDER_CLASS} .record-region[data-recording="true"]:hover {
      color: #ff8a8a;
      border-color: rgba(255, 138, 138, 0.7);
      box-shadow: 0 0 0 1px rgba(255, 138, 138, 0.36);
    }

    .${BORDER_CLASS} .move-region {
      cursor: move;
    }

    .${BORDER_CLASS} .cancel-recording {
      color: #ff9a9a;
    }

    .${BORDER_CLASS} .clear-region {
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

    #${CHZZK_CANCEL_BUTTON_ID} {
      color: #ff9a9a;
    }

    #${CHZZK_RECORD_TIME_ID} {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 42px;
      height: 100%;
      padding: 0 4px;
      color: var(--crop-clip-danger);
      font-size: 12px;
      font-weight: 800;
      line-height: 1;
      white-space: nowrap;
      pointer-events: none;
    }

    #${CHZZK_RECORD_TIME_ID}[hidden] {
      display: none !important;
    }

    #${SEEK_FEEDBACK_ID} {
      position: fixed;
      z-index: 2147483644;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      padding: 8px 12px;
      border: 1px solid rgba(238, 244, 251, 0.16);
      border-radius: 10px;
      background: rgba(6, 13, 20, 0.42);
      color: rgba(244, 251, 255, 0.78);
      font-size: 17px;
      font-weight: 900;
      line-height: 1;
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease;
    }

    #${SEEK_FEEDBACK_ID}[data-visible="true"] {
      opacity: 1;
    }

  `;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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

function regionEdges(region: RegionSelection): { left: number; top: number; right: number; bottom: number } {
  return {
    left: region.x,
    top: region.y,
    right: region.x + region.width,
    bottom: region.y + region.height,
  };
}

function regionsOverlap(a: RegionSelection, b: RegionSelection): boolean {
  const ae = regionEdges(a);
  const be = regionEdges(b);
  return ae.left < be.right && ae.right > be.left && ae.top < be.bottom && ae.bottom > be.top;
}

function collidesWithOtherRegion(region: RegionSelection, index: number): boolean {
  return currentRegions.some((item, itemIndex) => itemIndex !== index && regionsOverlap(resolveRegionToViewport(item), region));
}

function normalizeRegions(raw: unknown, fallback?: RegionSelection | null): RegionSelection[] {
  const source = Array.isArray(raw) ? raw : fallback ? [fallback] : [];
  return source
    .map((item) => normalizeRegion(item))
    .filter((item): item is RegionSelection => item !== null)
    .slice(0, MAX_ACTIVE_REGIONS);
}

function getActiveRegion(): RegionSelection | null {
  return currentRegions[activeRegionIndex] ?? currentRegions[0] ?? null;
}

function setActiveRegion(index: number): void {
  activeRegionIndex = clamp(index, 0, Math.max(0, currentRegions.length - 1));
  currentRegion = getActiveRegion();
  syncBorderState();
}

function computeDirectCrop(region: RegionSelection, video: HTMLVideoElement): DirectCrop | null {
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

function computeDirectCropFromSelection(region: RegionSelection, video: HTMLVideoElement): DirectCrop | null {
  const relative = region.videoRelative;
  if (!relative) {
    return computeDirectCrop(resolveRegionToViewport(region), video);
  }

  const x = clamp(Math.round(relative.x * video.videoWidth), 0, Math.max(0, video.videoWidth - 1));
  const y = clamp(Math.round(relative.y * video.videoHeight), 0, Math.max(0, video.videoHeight - 1));
  const right = clamp(Math.round((relative.x + relative.width) * video.videoWidth), x + 1, video.videoWidth);
  const bottom = clamp(Math.round((relative.y + relative.height) * video.videoHeight), y + 1, video.videoHeight);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function getCropLayoutKey(crops: DirectCrop[]): string {
  return crops.map((crop) => `${crop.x}:${crop.y}:${crop.width}:${crop.height}`).join("|");
}

function computeDirectOutput(crop: { width: number; height: number }): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(crop.width)),
    height: Math.max(1, Math.round(crop.height)),
  };
}

function getMultiRegionLimit(settings?: Partial<Settings>): number {
  const value = settings?.multiRegionMaxCount ?? multiRegionMaxCount;
  return clamp(Math.round(Number(value) || DEFAULT_MULTI_REGION_COUNT), 2, MAX_ACTIVE_REGIONS);
}

function getActiveRegionLimit(): number {
  return multiRegionEnabled ? getMultiRegionLimit() : 1;
}

function scaleLayout(layout: DirectLayout, scale: number, dx: number, dy: number): DirectCropPlacement[] {
  return layout.placements.map((placement) => {
    const left = Math.round(placement.dx * scale);
    const top = Math.round(placement.dy * scale);
    const right = Math.round((placement.dx + placement.dw) * scale);
    const bottom = Math.round((placement.dy + placement.dh) * scale);
    return {
      crop: placement.crop,
      dx: dx + left,
      dy: dy + top,
      dw: Math.max(1, right - left),
      dh: Math.max(1, bottom - top),
    };
  });
}

function composeHorizontal(layouts: DirectLayout[]): DirectLayout {
  const height = Math.max(1, Math.round(Math.max(...layouts.map((layout) => layout.output.height))));
  let x = 0;
  const placements: DirectCropPlacement[] = [];
  for (const layout of layouts) {
    const scale = height / layout.output.height;
    placements.push(...scaleLayout(layout, scale, x, 0));
    x += Math.max(1, Math.round(layout.output.width * scale));
  }
  return { output: { width: Math.max(1, x), height }, placements };
}

function composeVertical(layouts: DirectLayout[]): DirectLayout {
  const width = Math.max(1, Math.round(Math.max(...layouts.map((layout) => layout.output.width))));
  let y = 0;
  const placements: DirectCropPlacement[] = [];
  for (const layout of layouts) {
    const scale = width / layout.output.width;
    placements.push(...scaleLayout(layout, scale, 0, y));
    y += Math.max(1, Math.round(layout.output.height * scale));
  }
  return { output: { width, height: Math.max(1, y) }, placements };
}

function getPairLayoutDirection(crops: DirectCrop[]): "horizontal" | "vertical" | null {
  if (crops.length !== 2) {
    return null;
  }

  const [first, second] = crops;
  const separatedX = first.x + first.width <= second.x || second.x + second.width <= first.x;
  const separatedY = first.y + first.height <= second.y || second.y + second.height <= first.y;
  if (separatedX !== separatedY) {
    return separatedX ? "horizontal" : "vertical";
  }

  const centerDistanceX = Math.abs((first.x + first.width / 2) - (second.x + second.width / 2));
  const centerDistanceY = Math.abs((first.y + first.height / 2) - (second.y + second.height / 2));
  const normalizedX = centerDistanceX / Math.max(1, (first.width + second.width) / 2);
  const normalizedY = centerDistanceY / Math.max(1, (first.height + second.height) / 2);
  return normalizedX >= normalizedY ? "horizontal" : "vertical";
}

function getGroupedLayout(crops: DirectCrop[]): DirectLayout | null {
  if (crops.length < 3 || crops.length > 4) {
    return null;
  }

  const fullMask = (1 << crops.length) - 1;
  let best: { score: number; horizontal: boolean; layout: DirectLayout } | null = null;
  for (let mask = 1; mask < fullMask; mask += 1) {
    if ((mask & 1) === 0) {
      continue;
    }
    const first: number[] = [];
    const second: number[] = [];
    for (let index = 0; index < crops.length; index += 1) {
      ((mask & (1 << index)) === 0 ? second : first).push(index);
    }
    const groups = [first, second].map((indices) => indices.map((index) => crops[index]));
    const bounds = groups.map((group) => ({
      left: Math.min(...group.map((crop) => crop.x)),
      top: Math.min(...group.map((crop) => crop.y)),
      right: Math.max(...group.map((crop) => crop.x + crop.width)),
      bottom: Math.max(...group.map((crop) => crop.y + crop.height)),
    }));
    const horizontalOrder = bounds[0].right <= bounds[1].left ? [0, 1] : bounds[1].right <= bounds[0].left ? [1, 0] : null;
    const verticalOrder = bounds[0].bottom <= bounds[1].top ? [0, 1] : bounds[1].bottom <= bounds[0].top ? [1, 0] : null;
    if (!horizontalOrder && !verticalOrder) {
      continue;
    }
    const layouts = groups.map((group) => computeDirectLayout(group));

    if (horizontalOrder) {
      const gap = bounds[horizontalOrder[1]].left - bounds[horizontalOrder[0]].right;
      const score = gap / Math.max(1, Math.max(bounds[0].right, bounds[1].right) - Math.min(bounds[0].left, bounds[1].left));
      if (!best || score > best.score || (score === best.score && !best.horizontal)) {
        best = { score, horizontal: true, layout: composeHorizontal(horizontalOrder.map((index) => layouts[index])) };
      }
    }

    if (verticalOrder) {
      const gap = bounds[verticalOrder[1]].top - bounds[verticalOrder[0]].bottom;
      const score = gap / Math.max(1, Math.max(bounds[0].bottom, bounds[1].bottom) - Math.min(bounds[0].top, bounds[1].top));
      if (!best || score > best.score) {
        best = { score, horizontal: false, layout: composeVertical(verticalOrder.map((index) => layouts[index])) };
      }
    }
  }

  return best?.layout ?? null;
}

function computeDirectLayout(crops: DirectCrop[]): DirectLayout {
  if (crops.length <= 1) {
    const crop = crops[0];
    return {
      output: computeDirectOutput(crop),
      placements: [{ crop, dx: 0, dy: 0, dw: crop.width, dh: crop.height }],
    };
  }

  const left = Math.min(...crops.map((crop) => crop.x));
  const top = Math.min(...crops.map((crop) => crop.y));
  const right = Math.max(...crops.map((crop) => crop.x + crop.width));
  const bottom = Math.max(...crops.map((crop) => crop.y + crop.height));
  const pairDirection = getPairLayoutDirection(crops);
  const horizontal = pairDirection ? pairDirection === "horizontal" : right - left >= bottom - top;

  if (crops.length > 2) {
    const groupedLayout = getGroupedLayout(crops);
    if (groupedLayout) {
      return groupedLayout;
    }

    if (horizontal) {
      const ordered = [...crops].sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2));
      const split = Math.ceil(ordered.length / 2);
      return composeHorizontal([
        composeVertical(ordered.slice(0, split).sort((a, b) => a.y - b.y).map((crop) => computeDirectLayout([crop]))),
        composeVertical(ordered.slice(split).sort((a, b) => a.y - b.y).map((crop) => computeDirectLayout([crop]))),
      ]);
    }

    const ordered = [...crops].sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2));
    const split = Math.ceil(ordered.length / 2);
    return composeVertical([
      composeHorizontal(ordered.slice(0, split).sort((a, b) => a.x - b.x).map((crop) => computeDirectLayout([crop]))),
      composeHorizontal(ordered.slice(split).sort((a, b) => a.x - b.x).map((crop) => computeDirectLayout([crop]))),
    ]);
  }

  const ordered = [...crops].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);

  if (horizontal) {
    const height = Math.max(1, Math.round(Math.max(...ordered.map((crop) => crop.height))));
    let x = 0;
    const placements = ordered.map((crop) => {
      const width = Math.max(1, Math.round(crop.width * (height / crop.height)));
      const placement = { crop, dx: x, dy: 0, dw: width, dh: height };
      x += width;
      return placement;
    });
    return {
      output: { width: Math.max(1, x), height },
      placements,
    };
  }

  const width = Math.max(1, Math.round(Math.max(...ordered.map((crop) => crop.width))));
  let y = 0;
  const placements = ordered.map((crop) => {
    const height = Math.max(1, Math.round(crop.height * (width / crop.width)));
    const placement = { crop, dx: 0, dy: y, dw: width, dh: height };
    y += height;
    return placement;
  });
  return {
    output: { width, height: Math.max(1, y) },
    placements,
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
  const candidates = settings.outputFormat === RECORDING_FORMAT.mp4 ? mp4Candidates : webmCandidates;

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return {
        mimeType,
        extension: settings.outputFormat === RECORDING_FORMAT.mp4 ? RECORDING_FORMAT.mp4 : RECORDING_FORMAT.webm,
        outputFormat: settings.outputFormat === RECORDING_FORMAT.mp4 ? RECORDING_FORMAT.mp4 : RECORDING_FORMAT.webm,
      };
    }
  }

  if (settings.outputFormat === RECORDING_FORMAT.mp4) {
    throw new Error("이 브라우저에서는 MP4 녹화가 제대로 동작하지 않습니다. WebM으로 변경하세요.");
  }

  throw new Error("이 브라우저에서는 WebM 녹화가 제대로 동작하지 않습니다.");
}

function buildBaseName(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const rawName = streamerFilenameEnabled ? getStreamerName() : "";
  const prefix = rawName ? sanitizeFilenamePart(rawName) || "cropClip" : "cropClip";
  return `${prefix}_${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_").trim().slice(0, 60);
}

function getStreamerName(): string {
  const title = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content || document.title;
  const titleName = title.split(/[-|]/)[0]?.replace(/치지직|CHZZK/gi, "").trim();
  if (titleName) {
    return titleName;
  }

  const selectors = [
    "[class*='channel'][class*='name']",
    "[class*='profile'][class*='name']",
    "[class*='live'][class*='name']",
  ];
  for (const selector of selectors) {
    const text = document.querySelector<HTMLElement>(selector)?.textContent?.trim();
    if (text && text.length <= 60) {
      return text;
    }
  }

  return document.title.split(/[-|]/)[0]?.trim() ?? "";
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

function getTrashIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M5 7H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M10 11V17M14 11V17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <path d="M8 7L9 4H15L16 7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
      <path d="M7 7L8 20H16L17 7" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    </svg>
  `;
}

function getMoveIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 3V21M12 3L8.5 6.5M12 3L15.5 6.5M12 21L8.5 17.5M12 21L15.5 17.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M3 12H21M3 12L6.5 8.5M3 12L6.5 15.5M21 12L17.5 8.5M21 12L17.5 15.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

function getPlusIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
    </svg>
  `;
}

function getCloseIconSvg(): string {
  return `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M7 7L17 17M17 7L7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
    </svg>
  `;
}

function getRegionToolbarHtml(): string {
  return `
    <div class="region-toolbar">
      <span class="record-time" hidden>00:00</span>
      <button class="region-tool record-region" type="button" aria-label="녹화 시작" title="녹화 시작">${getRecordIconSvg(false)}</button>
      <button class="region-tool cancel-recording" type="button" aria-label="녹화 취소" title="녹화 취소" hidden>${getTrashIconSvg()}</button>
      <button class="region-tool add-region" type="button" aria-label="영역 추가" title="영역 추가">${getPlusIconSvg()}</button>
      <button class="region-tool screenshot-region" type="button" aria-label="스크린샷" title="스크린샷">${getCameraIconSvg()}</button>
      <button class="region-tool move-region" type="button" aria-label="영역 이동" title="영역 이동">${getMoveIconSvg()}</button>
      <button class="region-tool clear-region" type="button" aria-label="영역 해제" title="영역 해제">${getCloseIconSvg()}</button>
    </div>
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

async function captureScreenshot(region: RegionSelection | null, missingMessage: string): Promise<void> {
  const video = findPrimaryVideoElement();
  if (!region || !video) {
    window.alert(missingMessage);
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

async function captureRegionScreenshot(): Promise<void> {
  await captureScreenshot(getCurrentRegionGeometry(), "스크린샷을 찍을 영역을 찾지 못했습니다.");
}

async function captureFullScreenshot(): Promise<void> {
  await captureScreenshot(getPlayerRegionGeometry(), "스크린샷을 찍을 비디오 영역을 찾지 못했습니다.");
}

async function toggleRegionRecording(): Promise<void> {
  if (recordingCommandInFlight) {
    return;
  }

  if (currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode === RECORDING_MODE.full) {
    window.alert("전체 녹화 중에는 영역 녹화를 시작할 수 없습니다.");
    return;
  }

  const type = currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode !== RECORDING_MODE.full ? "STOP_RECORDING" : "START_RECORDING";
  recordingCommandInFlight = true;
  try {
    const response = await sendRuntimeMessage({ type });
    if (!response.ok) {
      window.alert(response.error);
    }
  } finally {
    recordingCommandInFlight = false;
  }
}

async function toggleFullRecording(): Promise<void> {
  if (recordingCommandInFlight) {
    return;
  }

  if (currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode !== RECORDING_MODE.full) {
    window.alert("영역 녹화 중에는 전체 녹화를 시작할 수 없습니다.");
    return;
  }

  const type = currentRecordingState.status === RECORDING_STATUS.recording ? "STOP_RECORDING" : "START_FULL_RECORDING";
  recordingCommandInFlight = true;
  try {
    const response = await sendRuntimeMessage({ type });
    if (!response.ok) {
      window.alert(response.error);
    }
  } finally {
    recordingCommandInFlight = false;
  }
}

async function cancelRecording(): Promise<void> {
  if (recordingCommandInFlight) {
    return;
  }

  recordingCommandInFlight = true;
  try {
    const response = await sendRuntimeMessage({ type: "CANCEL_RECORDING" });
    if (!response.ok) {
      throw new Error(response.error);
    }
  } finally {
    recordingCommandInFlight = false;
  }
}

function buildDirectFilename(session: DirectRecordingSession): string {
  return `${session.baseName}.${session.extension}`;
}

function sendRuntimeMessage<T = undefined>(message: Record<string, unknown>): Promise<MessageResponse & { data?: T }> {
  return new Promise((resolve, reject) => {
    if (!isExtensionContextAvailable()) {
      reject(new Error("확장 프로그램이 새로고침되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요."));
      return;
    }

    try {
      chrome.runtime.sendMessage(message, (response?: MessageResponse & { data?: T }) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        resolve(response ?? { ok: false, error: "확장 프로그램에서 응답하지 않았습니다." });
      });
    } catch (error) {
      if (error instanceof Error) {
        reject(error);
        return;
      }
      reject(new Error("확장 프로그램이 새로고침되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요."));
    }
  });
}

async function saveDirectPart(session: DirectRecordingSession, blob: Blob): Promise<void> {
  if (blob.size <= 0) {
    throw new Error("녹화 데이터가 비어 있습니다.");
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const response = await sendRuntimeMessage({
      type: "STORE_RECORDING_PART",
      part: {
        id: `${session.recordingId}:part:${String(DIRECT_RECORDING_PART_INDEX).padStart(3, "0")}`,
        recordingId: session.recordingId,
        index: DIRECT_RECORDING_PART_INDEX,
        filename: buildDirectFilename(session),
        mimeType: session.mimeType,
        extension: session.extension,
        outputFormat: session.outputFormat,
        size: blob.size,
        objectUrl,
        createdAt: Date.now(),
      },
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }

  session.totalSize += blob.size;
}

function clearDirectTimers(session: DirectRecordingSession): void {
  window.clearInterval(session.drawTimerId);
}

function cleanupDirectRecordingSession(session: DirectRecordingSession): void {
  if (session.cleanedUp) {
    return;
  }

  session.cleanedUp = true;
  clearDirectTimers(session);
  session.sourceChangeCleanup?.();
  session.sourceChangeCleanup = undefined;
  session.sourceStream.getTracks().forEach((track) => track.stop());
  session.outputStream.getTracks().forEach((track) => track.stop());
  session.canvas.remove();
  if (directSession === session) {
    directSession = null;
  }
}

async function finalizeDirectRecording(session: DirectRecordingSession): Promise<void> {
  cleanupDirectRecordingSession(session);

  try {
    const response = await sendRuntimeMessage({
      type: "RECORDING_FINISHED",
      recording: {
        id: session.recordingId,
        createdAt: session.createdAt,
        endedAt: Date.now(),
        totalSize: session.totalSize,
        actualExtension: session.extension,
      },
    });
    if (!response.ok) {
      throw new Error(response.error);
    }
    session.resolveFinish();
  } catch (error) {
    session.rejectFinish(error instanceof Error ? error : new Error("녹화 결과를 저장하지 못했습니다."));
  }
}

function cancelDirectRecordingSession(session: DirectRecordingSession): void {
  cleanupDirectRecordingSession(session);
  session.resolveFinish();
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
    session.cancelRequested = true;
    session.stopRequested = true;
    cleanupDirectRecordingSession(session);
    session.rejectFinish(error);
    void sendRuntimeMessage({
      type: "RECORDING_ERROR",
      recordingId: session.recordingId,
      error: error.message,
    }).catch(() => {});
  };

  recorder.onstop = () => {
    void (async () => {
      if (session.cancelRequested) {
        cancelDirectRecordingSession(session);
        return;
      }

      const blob = new Blob(session.currentChunks, { type: session.mimeType });
      await saveDirectPart(session, blob);
      await finalizeDirectRecording(session);
    })().catch((error: Error) => {
      cleanupDirectRecordingSession(session);
      session.rejectFinish(error);
      void sendRuntimeMessage({
        type: "RECORDING_ERROR",
        recordingId: session.recordingId,
        error: error.message,
      }).catch(() => {});
    });
  };

  recorder.start(1000);
}

async function startDirectRecording(command: Extract<ContentCommand, { type: "START_DIRECT_RECORDING" }>): Promise<MessageResponse> {
  if (directSession) {
    directSession.cancelRequested = true;
    directSession.stopRequested = true;
    requestDirectPartStop(directSession);
    cancelDirectRecordingSession(directSession);
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

  const sourceRegions = (command.regions?.length ? command.regions : [command.region]).slice(0, command.settings.enableMultiRegion ? getMultiRegionLimit(command.settings) : 1);
  const crops = sourceRegions
    .map((region) => computeDirectCropFromSelection(region, video))
    .filter((crop): crop is DirectCrop => crop !== null);
  if (crops.length === 0) {
    return { ok: false, error: "선택 영역이 비디오 화면과 겹치지 않습니다." };
  }

  const layout = computeDirectLayout(crops);
  const output = layout.output;
  const mime = selectDirectMimeType(command.settings);
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
  let cropLayoutKey = getCropLayoutKey(crops);

  const drawFrame = () => {
    const nextCrops = sourceRegions
      .map((region) => computeDirectCropFromSelection(region, video))
      .filter((crop): crop is DirectCrop => crop !== null);
    const nextCropLayoutKey = getCropLayoutKey(nextCrops);
    if (nextCrops.length > 0 && nextCropLayoutKey !== cropLayoutKey) {
      cropLayoutKey = nextCropLayoutKey;
      const nextLayout = computeDirectLayout(nextCrops);
      const scale = Math.min(output.width / nextLayout.output.width, output.height / nextLayout.output.height);
      const width = nextLayout.output.width * scale;
      const height = nextLayout.output.height * scale;
      session.placements = scaleLayout(nextLayout, scale, Math.round((output.width - width) / 2), Math.round((output.height - height) / 2));
    }
    context.fillStyle = "#000";
    context.fillRect(0, 0, output.width, output.height);
    for (const placement of session.placements) {
      context.drawImage(video, placement.crop.x, placement.crop.y, placement.crop.width, placement.crop.height, placement.dx, placement.dy, placement.dw, placement.dh);
    }
  };

  let resolveFinish: () => void = () => {};
  let rejectFinish: (error: Error) => void = () => {};
  const finishPromise = new Promise<void>((resolve, reject) => {
    resolveFinish = resolve;
    rejectFinish = reject;
  });
  void finishPromise.catch(() => {});

  const session: DirectRecordingSession = {
    recordingId: command.recordingId,
    settings: command.settings,
    video,
    sourceStream,
    outputStream,
    canvas,
    mimeType: mime.mimeType,
    extension: mime.extension,
    outputFormat: mime.outputFormat,
    baseName: buildBaseName(),
    totalSize: 0,
    currentChunks: [],
    createdAt: Date.now(),
    drawTimerId: window.setInterval(drawFrame, Math.max(16, Math.round(1000 / frameRate))),
    stopRequested: false,
    cancelRequested: false,
    cleanedUp: false,
    closingPart: false,
    finishPromise,
    resolveFinish,
    rejectFinish,
    placements: layout.placements,
  };

  directSession = session;
  try {
    drawFrame();
    await startDirectPart(session);
    watchDirectRecordingSource(session);
    return { ok: true };
  } catch (error) {
    cleanupDirectRecordingSession(session);
    throw error;
  }
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

async function cancelDirectRecording(recordingId?: string): Promise<MessageResponse> {
  const session = directSession;
  if (!session) {
    return { ok: true };
  }
  if (recordingId && session.recordingId !== recordingId) {
    return { ok: true };
  }

  session.cancelRequested = true;
  session.stopRequested = true;
  requestDirectPartStop(session);
  cancelDirectRecordingSession(session);
  return { ok: true };
}

function stopDirectRecordingForUnload(): void {
  if (!directSession || directSession.stopRequested) {
    return;
  }

  directSession.stopRequested = true;
  requestDirectPartStop(directSession);
}

function showSelectionBorders(regions: RegionSelection[]): void {
  ensureStyle();
  stopRegionLayoutWatch();
  removeBorderHandlers?.();
  removeBorderHandlers = null;
  currentBorder?.remove();
  currentBorder = null;
  for (const border of currentBorders.values()) {
    border.remove();
  }
  currentBorders = new Map();

  if (regions.length === 0) {
    return;
  }

  const cleanupCallbacks: Array<() => void> = [];
  regions.forEach((region, index) => {
    const border = document.createElement("div");
    border.id = index === 0 ? BORDER_ID : `${BORDER_ID}-${index}`;
    border.className = BORDER_CLASS;
    border.dataset.regionIndex = String(index);
    border.innerHTML = `
      ${getRegionToolbarHtml()}
      <span class="resize-zone" data-edge="n" aria-hidden="true"></span>
      <span class="resize-zone" data-edge="s" aria-hidden="true"></span>
      <span class="resize-zone" data-edge="w" aria-hidden="true"></span>
      <span class="resize-zone" data-edge="e" aria-hidden="true"></span>
      <span class="resize-zone" data-edge="nw" aria-hidden="true"></span>
      <span class="resize-zone" data-edge="ne" aria-hidden="true"></span>
      <span class="resize-zone" data-edge="sw" aria-hidden="true"></span>
      <span class="resize-zone" data-edge="se" aria-hidden="true"></span>
      <span class="guide-edge" data-side="n" hidden></span>
      <span class="guide-edge" data-side="s" hidden></span>
      <span class="guide-edge" data-side="w" hidden></span>
      <span class="guide-edge" data-side="e" hidden></span>
    `;
    applyBorderGeometry(border, region);
    const cleanup = attachBorderControls(border, index);
    cleanupCallbacks.push(cleanup);
    document.body.appendChild(border);
    currentBorders.set(index, border);
    if (index === activeRegionIndex) {
      currentBorder = border;
    }
  });
  removeBorderHandlers = () => {
    for (const cleanup of cleanupCallbacks) {
      cleanup();
    }
  };
  syncBorderState();
  startRegionLayoutWatch();
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

function startRegionLayoutWatch(): void {
  lastVideoLayoutKey = getVideoLayoutKey();
  regionLayoutTimerId = window.setInterval(() => {
    if (currentRegions.length === 0) {
      stopRegionLayoutWatch();
      return;
    }

    const nextKey = getVideoLayoutKey();
    if (nextKey === lastVideoLayoutKey) {
      return;
    }

    lastVideoLayoutKey = nextKey;
    currentRegions.forEach((region, index) => {
      const border = currentBorders.get(index);
      if (border && document.body.contains(border)) {
        applyBorderGeometry(border, region);
      }
    });
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

function getRegionAccent(index: number): string {
  return CROP_REGION_COLORS[index] ?? CROP_SECONDARY;
}

function hexToRgb(value: string): { r: number; g: number; b: number } {
  const hex = value.replace("#", "");
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function rgba(value: string, alpha: number): string {
  const { r, g, b } = hexToRgb(value);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function syncBorderState(guides = new Map<number, Set<GuideSide>>()): void {
  for (const [index, border] of currentBorders) {
    const active = index === activeRegionIndex;
    const accent = getRegionAccent(index);
    border.dataset.active = active ? "true" : "false";
    border.style.setProperty("--crop-clip-region-outline", rgba(accent, active ? 0.96 : 0.5));
    border.style.setProperty("--crop-clip-region-shadow", rgba(accent, active ? 0.62 : 0.28));
    border.querySelector<HTMLButtonElement>(".add-region")?.toggleAttribute("hidden", !active || !multiRegionEnabled || currentRegions.length >= getActiveRegionLimit() || isRegionRecordingActive());
    const guideSides = guides.get(index) ?? new Set<GuideSide>();
    for (const side of ["n", "s", "w", "e"] as GuideSide[]) {
      border.querySelector<HTMLElement>(`.guide-edge[data-side="${side}"]`)?.toggleAttribute("hidden", !guideSides.has(side));
    }
    border.querySelector<HTMLButtonElement>(".record-region")?.toggleAttribute("hidden", !active);
  }
  currentBorder = currentBorders.get(activeRegionIndex) ?? currentBorders.get(0) ?? null;
}

function removeRegionAtIndex(index: number): void {
  if (currentRegions.length === 0) {
    return;
  }

  if (currentRegions.length === 1) {
    currentRegion = null;
    currentRegions = [];
    void clearRegion();
    showSelectionBorders([]);
    return;
  }

  currentRegions.splice(index, 1);
  activeRegionIndex = Math.min(index, currentRegions.length - 1);
  currentRegion = getActiveRegion();
  void saveRegions(currentRegions);
  showSelectionBorders(currentRegions);
}

function addGuide(guides: Map<number, Set<GuideSide>>, index: number, side: GuideSide): void {
  const set = guides.get(index) ?? new Set<GuideSide>();
  set.add(side);
  guides.set(index, set);
}

function snapRegionEdges(region: RegionSelection, index: number, edge = "nsew"): { region: RegionSelection; guides: Map<number, Set<GuideSide>> } {
  let { left, top, right, bottom } = regionEdges(region);
  const guides = new Map<number, Set<GuideSide>>();

  currentRegions.forEach((item, itemIndex) => {
    if (itemIndex === index) {
      return;
    }
    const other = regionEdges(resolveRegionToViewport(item));
    const checks: Array<{ enabled: boolean; side: "left" | "right" | "top" | "bottom"; guideSide: GuideSide; otherSide: GuideSide; value: number; target: number }> = [
      { enabled: edge.includes("w"), side: "left", guideSide: "w", otherSide: "w", value: left, target: other.left },
      { enabled: edge.includes("w"), side: "left", guideSide: "w", otherSide: "e", value: left, target: other.right },
      { enabled: edge.includes("e"), side: "right", guideSide: "e", otherSide: "w", value: right, target: other.left },
      { enabled: edge.includes("e"), side: "right", guideSide: "e", otherSide: "e", value: right, target: other.right },
      { enabled: edge.includes("n"), side: "top", guideSide: "n", otherSide: "n", value: top, target: other.top },
      { enabled: edge.includes("n"), side: "top", guideSide: "n", otherSide: "s", value: top, target: other.bottom },
      { enabled: edge.includes("s"), side: "bottom", guideSide: "s", otherSide: "n", value: bottom, target: other.top },
      { enabled: edge.includes("s"), side: "bottom", guideSide: "s", otherSide: "s", value: bottom, target: other.bottom },
    ];

    for (const check of checks) {
      if (!check.enabled || Math.abs(check.value - check.target) > SNAP_DISTANCE) {
        continue;
      }
      if (check.side === "left") {
        left = check.target;
      } else if (check.side === "right") {
        right = check.target;
      } else if (check.side === "top") {
        top = check.target;
      } else {
        bottom = check.target;
      }
      addGuide(guides, index, check.guideSide);
      addGuide(guides, itemIndex, check.otherSide);
    }
  });

  return {
    region: buildRegionSelection(left, top, Math.max(MIN_WIDTH, right - left), Math.max(MIN_HEIGHT, bottom - top)),
    guides,
  };
}

function snapRegionMove(region: RegionSelection, index: number): { region: RegionSelection; guides: Map<number, Set<GuideSide>> } {
  let { left, top, right, bottom } = regionEdges(region);
  const width = right - left;
  const height = bottom - top;
  const guides = new Map<number, Set<GuideSide>>();

  currentRegions.forEach((item, itemIndex) => {
    if (itemIndex === index) {
      return;
    }
    const other = regionEdges(resolveRegionToViewport(item));
    const xChecks: Array<{ value: number; target: number; side: GuideSide; otherSide: GuideSide }> = [
      { value: left, target: other.left, side: "w", otherSide: "w" },
      { value: left, target: other.right, side: "w", otherSide: "e" },
      { value: right, target: other.left, side: "e", otherSide: "w" },
      { value: right, target: other.right, side: "e", otherSide: "e" },
    ];
    const yChecks: Array<{ value: number; target: number; side: GuideSide; otherSide: GuideSide }> = [
      { value: top, target: other.top, side: "n", otherSide: "n" },
      { value: top, target: other.bottom, side: "n", otherSide: "s" },
      { value: bottom, target: other.top, side: "s", otherSide: "n" },
      { value: bottom, target: other.bottom, side: "s", otherSide: "s" },
    ];

    for (const check of xChecks) {
      if (Math.abs(check.value - check.target) <= SNAP_DISTANCE) {
        const dx = check.target - check.value;
        left += dx;
        right += dx;
        addGuide(guides, index, check.side);
        addGuide(guides, itemIndex, check.otherSide);
        break;
      }
    }
    for (const check of yChecks) {
      if (Math.abs(check.value - check.target) <= SNAP_DISTANCE) {
        const dy = check.target - check.value;
        top += dy;
        bottom += dy;
        addGuide(guides, index, check.side);
        addGuide(guides, itemIndex, check.otherSide);
        break;
      }
    }
  });

  return { region: buildRegionSelection(left, top, width, height), guides };
}

function attachBorderControls(border: HTMLDivElement, index: number): () => void {
  const cleanupCallbacks: Array<() => void> = [];
  let stopActiveDrag: (() => void) | null = null;
  const recordTime = border.querySelector<HTMLElement>(".record-time");
  const recordButton = border.querySelector<HTMLButtonElement>(".record-region");
  const cancelButton = border.querySelector<HTMLButtonElement>(".cancel-recording");
  const screenshotButton = border.querySelector<HTMLButtonElement>(".screenshot-region");
  const clearButton = border.querySelector<HTMLButtonElement>(".clear-region");
  const moveButton = border.querySelector<HTMLButtonElement>(".move-region");
  const addButton = border.querySelector<HTMLButtonElement>(".add-region");

  const activate = () => setActiveRegion(index);
  border.addEventListener("pointerdown", activate);
  cleanupCallbacks.push(() => border.removeEventListener("pointerdown", activate));

  const updateRecordButton = () => {
    if (!recordButton) {
      return;
    }

    const isRegionRecording = isRegionRecordingActive();
    const isFullRecording = currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode === RECORDING_MODE.full;
    const label = withShortcut(isRegionRecording ? "녹화 중지" : "녹화 시작", "regionRecord");
    recordButton.hidden = index !== activeRegionIndex;
    recordButton.innerHTML = getRecordIconSvg(isRegionRecording);
    recordButton.setAttribute("aria-label", label);
    recordButton.title = label;
    recordButton.disabled = isFullRecording;
    if (cancelButton) {
      const cancelLabel = withShortcut("녹화 취소", "cancelRecording");
      cancelButton.hidden = index !== activeRegionIndex || !isRegionRecording;
      cancelButton.disabled = !isRegionRecording;
      cancelButton.setAttribute("aria-label", cancelLabel);
      cancelButton.title = cancelLabel;
    }
    if (screenshotButton) {
      const screenshotLabel = withShortcut("스크린샷", "regionScreenshot");
      screenshotButton.setAttribute("aria-label", screenshotLabel);
      screenshotButton.title = screenshotLabel;
    }
    if (clearButton) {
      const clearLabel = withShortcut("영역 해제", "clearRegion");
      clearButton.setAttribute("aria-label", clearLabel);
      clearButton.title = clearLabel;
    }
    if (isRegionRecording) {
      recordButton.dataset.recording = "true";
      border.dataset.recording = "true";
    } else {
      delete recordButton.dataset.recording;
      delete border.dataset.recording;
    }
    if (clearButton) {
      clearButton.disabled = isRegionRecording;
    }
    if (moveButton) {
      moveButton.disabled = isRegionRecording;
    }
    if (addButton) {
      addButton.hidden = index !== activeRegionIndex || !multiRegionEnabled || currentRegions.length >= getActiveRegionLimit() || isRegionRecording;
      addButton.disabled = isRegionRecording;
    }
    if (recordTime) {
      recordTime.hidden = !isRegionRecording || index !== activeRegionIndex;
      recordTime.textContent = isRegionRecording && currentRecordingState.startedAt ? formatElapsed(Date.now() - currentRecordingState.startedAt) : "00:00";
    }
  };

  const onRecord = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode === RECORDING_MODE.full) {
      return;
    }
    if (recordingCommandInFlight) {
      return;
    }

    const type = currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode !== RECORDING_MODE.full ? "STOP_RECORDING" : "START_RECORDING";
    const previousRecordingState = currentRecordingState;
    if (type === "STOP_RECORDING") {
      currentRecordingState = { status: RECORDING_STATUS.idle };
      updateRecordButton();
    }

    recordingCommandInFlight = true;
    void sendRuntimeMessage({ type }).then((response) => {
      if (response.ok) {
        if (type === "START_RECORDING") {
          currentRecordingState = { status: RECORDING_STATUS.recording, startedAt: Date.now(), mode: RECORDING_MODE.region };
          updateRecordButton();
        }
        return;
      }
      if (type === "STOP_RECORDING") {
        currentRecordingState = previousRecordingState;
        updateRecordButton();
      }
      window.alert(response.error);
    }).catch((error: Error) => {
      if (type === "STOP_RECORDING") {
        currentRecordingState = previousRecordingState;
        updateRecordButton();
      }
      window.alert(error.message);
    }).finally(() => {
      recordingCommandInFlight = false;
    });
  };

  updateRecordButton();
  recordButton?.addEventListener("click", onRecord);
  if (recordButton) {
    cleanupCallbacks.push(() => recordButton.removeEventListener("click", onRecord));
  }

  const onCancelRecording = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const previousRecordingState = currentRecordingState;
    currentRecordingState = { status: RECORDING_STATUS.idle };
    updateRecordButton();
    void cancelRecording().catch((error: Error) => {
      currentRecordingState = previousRecordingState;
      updateRecordButton();
      window.alert(error.message);
    });
  };

  cancelButton?.addEventListener("click", onCancelRecording);
  if (cancelButton) {
    cleanupCallbacks.push(() => cancelButton.removeEventListener("click", onCancelRecording));
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
    if (isRegionRecordingActive()) {
      return;
    }

    removeRegionAtIndex(index);
  };

  clearButton?.addEventListener("click", onClear);
  if (clearButton) {
    cleanupCallbacks.push(() => clearButton.removeEventListener("click", onClear));
  }

  const onAdd = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (isRegionRecordingActive() || !multiRegionEnabled || currentRegions.length >= getActiveRegionLimit()) {
      return;
    }
    startSelection();
  };

  addButton?.addEventListener("click", onAdd);
  if (addButton) {
    cleanupCallbacks.push(() => addButton.removeEventListener("click", onAdd));
  }

  const startMove = (event: PointerEvent) => {
    const region = currentRegions[index];
    if (!region || (currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode !== RECORDING_MODE.full)) {
      return;
    }

    setActiveRegion(index);
    event.preventDefault();
    event.stopPropagation();
    moveButton?.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startRegion = resolveRegionToViewport(region);
    const startLeft = startRegion.x;
    const startTop = startRegion.y;
    const bounds = getVideoSelectionRect();
    if (!bounds) {
      return;
    }
    stopActiveDrag?.();
    const width = Math.min(startRegion.width, bounds.width);
    const height = Math.min(startRegion.height, bounds.height);

    const onMove = (moveEvent: PointerEvent) => {
      const left = clamp(startLeft + moveEvent.clientX - startX, bounds.left, bounds.right - width);
      const top = clamp(startTop + moveEvent.clientY - startY, bounds.top, bounds.bottom - height);

      const snapped = snapRegionMove(buildRegionSelection(left, top, width, height), index);
      const nextLeft = clamp(snapped.region.x, bounds.left, bounds.right - width);
      const nextTop = clamp(snapped.region.y, bounds.top, bounds.bottom - height);
      const nextRegion = buildRegionSelection(nextLeft, nextTop, width, height);
      if (collidesWithOtherRegion(nextRegion, index)) {
        return;
      }
      currentRegions[index] = nextRegion;
      currentRegion = getActiveRegion();
      applyBorderGeometry(border, nextRegion);
      syncBorderState(snapped.guides);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopActiveDrag = null;
      syncBorderState();
      void saveRegions(currentRegions);
    };

    stopActiveDrag = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  };

  moveButton?.addEventListener("pointerdown", startMove);
  if (moveButton) {
    cleanupCallbacks.push(() => moveButton.removeEventListener("pointerdown", startMove));
  }

  const startResize = (event: PointerEvent) => {
    const target = event.currentTarget as HTMLElement;
    const edge = target.dataset.edge;
    const region = currentRegions[index];
    if (!edge || !region || (currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode !== RECORDING_MODE.full)) {
      return;
    }

    setActiveRegion(index);
    event.preventDefault();
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startY = event.clientY;
    const startRegion = resolveRegionToViewport(region);
    const startLeft = startRegion.x;
    const startTop = startRegion.y;
    const startRight = startRegion.x + startRegion.width;
    const startBottom = startRegion.y + startRegion.height;
    const bounds = getVideoSelectionRect();
    if (!bounds) {
      return;
    }
    stopActiveDrag?.();
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

      let nextRegion = buildRegionSelection(left, top, right - left, bottom - top);
      const snap = snapRegionEdges(nextRegion, index, edge);
      nextRegion = snap.region;
      if (collidesWithOtherRegion(nextRegion, index)) {
        return;
      }
      currentRegions[index] = nextRegion;
      currentRegion = getActiveRegion();
      applyBorderGeometry(border, nextRegion);
      syncBorderState(snap.guides);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopActiveDrag = null;
      syncBorderState();
      void saveRegions(currentRegions);
    };

    stopActiveDrag = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
  };

  const zones = Array.from(border.querySelectorAll<HTMLElement>(".resize-zone"));
  for (const zone of zones) {
    zone.addEventListener("pointerdown", startResize);
    cleanupCallbacks.push(() => zone.removeEventListener("pointerdown", startResize));
  }

  return () => {
    stopActiveDrag?.();
    for (const cleanup of cleanupCallbacks) {
      cleanup();
    }
  };
}

async function loadState(): Promise<{ region: RegionSelection | null; regions: RegionSelection[]; recordingState: LocalRecordingState; multiRegionEnabled: boolean; multiRegionMaxCount: number; fullRecordButtonEnabled: boolean; fullScreenshotButtonEnabled: boolean; seekEnabled: boolean; seekSeconds: number; streamerFilenameEnabled: boolean; shortcutsEnabled: boolean; shortcutKeys: ShortcutKeys }> {
  if (!isExtensionContextAvailable()) {
    return {
      region: null,
      regions: [],
      recordingState: { status: RECORDING_STATUS.idle },
      multiRegionEnabled: false,
      multiRegionMaxCount: DEFAULT_MULTI_REGION_COUNT,
      fullRecordButtonEnabled: false,
      fullScreenshotButtonEnabled: false,
      seekEnabled: false,
      seekSeconds: DEFAULT_SEEK_SECONDS,
      streamerFilenameEnabled: false,
      shortcutsEnabled: false,
      shortcutKeys: DEFAULT_CONTENT_SHORTCUT_KEYS,
    };
  }

  let result: { region?: unknown; regions?: unknown; recordingState?: unknown; settings?: Partial<Settings> };
  try {
    result = await chrome.storage.local.get({
      region: null,
      regions: [],
      recordingState: { status: RECORDING_STATUS.idle },
      settings: {},
    });
  } catch {
    return {
      region: null,
      regions: [],
      recordingState: { status: RECORDING_STATUS.idle },
      multiRegionEnabled: false,
      multiRegionMaxCount: DEFAULT_MULTI_REGION_COUNT,
      fullRecordButtonEnabled: false,
      fullScreenshotButtonEnabled: false,
      seekEnabled: false,
      seekSeconds: DEFAULT_SEEK_SECONDS,
      streamerFilenameEnabled: false,
      shortcutsEnabled: false,
      shortcutKeys: DEFAULT_CONTENT_SHORTCUT_KEYS,
    };
  }

  const region = normalizeRegion(result.region);
  return {
    region,
    regions: normalizeRegions(result.regions, region),
    recordingState: normalizeRecordingState(result.recordingState),
    multiRegionEnabled: Boolean(result.settings?.enableMultiRegion),
    multiRegionMaxCount: getMultiRegionLimit(result.settings),
    fullRecordButtonEnabled: Boolean(result.settings?.enableFullRecordButton),
    fullScreenshotButtonEnabled: Boolean(result.settings?.enableFullScreenshotButton),
    seekEnabled: Boolean(result.settings?.enableSeek ?? (result.settings as Partial<Settings> & { enableSeekButtons?: boolean } | undefined)?.enableSeekButtons),
    seekSeconds: Number.isFinite(result.settings?.seekSeconds) ? Number(result.settings?.seekSeconds) : DEFAULT_SEEK_SECONDS,
    streamerFilenameEnabled: Boolean(result.settings?.enableStreamerFilename),
    shortcutsEnabled: Boolean(result.settings?.enableShortcuts),
    shortcutKeys: normalizeShortcutKeys(result.settings?.shortcutKeys),
  };
}

function normalizeRegion(raw: unknown): RegionSelection | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const value = raw as Partial<RegionSelection>;
  const fields = [value.x, value.y, value.width, value.height, value.viewportWidth, value.viewportHeight, value.devicePixelRatio, value.selectedAt];
  if (fields.some((item) => !Number.isFinite(Number(item))) || Number(value.width) <= 0 || Number(value.height) <= 0) {
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
  if (value?.status === RECORDING_STATUS.recording || value?.status === RECORDING_STATUS.completed || value?.status === RECORDING_STATUS.error) {
    return {
      status: value.status,
      startedAt: Number.isFinite(value.startedAt as number) ? Number(value.startedAt) : undefined,
      mode: value.mode === RECORDING_MODE.region || value.mode === RECORDING_MODE.full ? value.mode : undefined,
    };
  }

  return { status: RECORDING_STATUS.idle };
}

function normalizeShortcutKeys(raw: Partial<ShortcutKeys> | undefined): ShortcutKeys {
  const normalized = { ...DEFAULT_CONTENT_SHORTCUT_KEYS };
  for (const action of Object.keys(normalized) as ShortcutAction[]) {
    const key = raw?.[action]?.toLowerCase();
    if (key && /^[a-z0-9]$/.test(key)) {
      normalized[action] = key;
    }
  }
  return normalized;
}

function trimRegionsToLimit(): void {
  const limit = getActiveRegionLimit();
  if (currentRegions.length <= limit) {
    return;
  }
  currentRegions = currentRegions.slice(0, limit);
  activeRegionIndex = Math.min(activeRegionIndex, currentRegions.length - 1);
  currentRegion = getActiveRegion();
  void saveRegions(currentRegions);
  showSelectionBorders(currentRegions);
}

async function saveRegions(regions: RegionSelection[]): Promise<boolean> {
  if (!isExtensionContextAvailable()) {
    return false;
  }

  const nextRegions = regions.slice(0, getActiveRegionLimit());
  try {
    await chrome.storage.local.set({ region: nextRegions[0] ?? null, regions: nextRegions });
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
    await chrome.storage.local.set({ region: null, regions: [] });
    return true;
  } catch {
    return false;
  }
}

async function refreshBorder(): Promise<void> {
  const state = await loadState();
  currentRegion = state.region;
  currentRegions = state.regions;
  activeRegionIndex = Math.min(activeRegionIndex, Math.max(0, currentRegions.length - 1));
  currentRecordingState = state.recordingState;
  multiRegionEnabled = state.multiRegionEnabled;
  multiRegionMaxCount = state.multiRegionMaxCount;
  trimRegionsToLimit();
  fullRecordButtonEnabled = state.fullRecordButtonEnabled;
  fullScreenshotButtonEnabled = state.fullScreenshotButtonEnabled;
  seekEnabled = state.seekEnabled;
  seekSeconds = state.seekSeconds;
  streamerFilenameEnabled = state.streamerFilenameEnabled;
  shortcutsEnabled = state.shortcutsEnabled;
  shortcutKeys = state.shortcutKeys;
  showSelectionBorders(currentRegions);

  if (state.recordingState.status === RECORDING_STATUS.recording && state.recordingState.mode !== RECORDING_MODE.full && selectionActive) {
    cancelSelection("녹화 중에는 영역을 다시 선택할 수 없습니다.");
  }
}

async function initializePageState(): Promise<void> {
  const state = await loadState();
  currentRecordingState = state.recordingState;
  multiRegionEnabled = state.multiRegionEnabled;
  multiRegionMaxCount = state.multiRegionMaxCount;
  trimRegionsToLimit();
  fullRecordButtonEnabled = state.fullRecordButtonEnabled;
  fullScreenshotButtonEnabled = state.fullScreenshotButtonEnabled;
  seekEnabled = state.seekEnabled;
  seekSeconds = state.seekSeconds;
  streamerFilenameEnabled = state.streamerFilenameEnabled;
  shortcutsEnabled = state.shortcutsEnabled;
  shortcutKeys = state.shortcutKeys;

  if (state.recordingState.status !== RECORDING_STATUS.recording && state.regions.length > 0) {
    await clearRegion();
    currentRegion = null;
    currentRegions = [];
    showSelectionBorders([]);
    return;
  }

  currentRegion = state.region;
  currentRegions = state.regions;
  trimRegionsToLimit();
  showSelectionBorders(currentRegions);
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
  if (multiRegionEnabled && currentRegions.some((item) => regionsOverlap(resolveRegionToViewport(item), nextRegion))) {
    setOverlayError("영역끼리는 겹칠 수 없습니다.");
    return;
  }
  const nextRegions = multiRegionEnabled ? [...currentRegions, nextRegion].slice(0, getActiveRegionLimit()) : [nextRegion];
  const saved = await saveRegions(nextRegions);
  if (!saved) {
    setOverlayError("확장 프로그램이 새로고침되었습니다. 페이지를 새로고침한 뒤 다시 시도하세요.");
    return;
  }

  currentRegions = nextRegions;
  setActiveRegion(nextRegions.length - 1);
  showSelectionBorders(nextRegions);
  teardownOverlay();
}

function getCurrentRegionGeometry(): RegionSelection | null {
  const activeRegion = getActiveRegion();
  if (activeRegion?.videoRelative) {
    return resolveRegionToViewport(activeRegion);
  }

  const sourceRect = currentBorder?.getBoundingClientRect();
  if (!sourceRect && !activeRegion) {
    return null;
  }

  const inset = BORDER_WIDTH;
  const left = (sourceRect ? sourceRect.left : activeRegion?.x ?? 0) + inset;
  const top = (sourceRect ? sourceRect.top : activeRegion?.y ?? 0) + inset;
  const right = (sourceRect ? sourceRect.right : (activeRegion?.x ?? 0) + (activeRegion?.width ?? 0)) - inset;
  const bottom = (sourceRect ? sourceRect.bottom : (activeRegion?.y ?? 0) + (activeRegion?.height ?? 0)) - inset;
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

function getCurrentRegionGeometries(): RegionSelection[] {
  return currentRegions
    .map((region) => resolveRegionToViewport(region))
    .filter((region) => region.width > 0 && region.height > 0)
    .slice(0, getActiveRegionLimit());
}

function getPlayerRegionGeometry(): RegionSelection | null {
  const rect = getVideoRenderedViewportRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  return buildRegionSelection(rect.left, rect.top, rect.width, rect.height);
}

function startSelection(): void {
  if (selectionActive || isRegionRecordingActive()) {
    return;
  }
  if (multiRegionEnabled && currentRegions.length >= getActiveRegionLimit()) {
    window.alert(`다중영역은 최대 ${getActiveRegionLimit()}개까지 사용할 수 있습니다.`);
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

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    cancelSelection();
  };

  const onPointerCancel = () => {
    dragging = false;
    updateSelectionBox(selectionBox, 0, 0, 0, 0);
  };

  overlay.addEventListener("pointerdown", onPointerDown);
  overlay.addEventListener("pointermove", onPointerMove);
  overlay.addEventListener("pointerup", onPointerUp);
  overlay.addEventListener("pointercancel", onPointerCancel);
  overlay.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", onKeyDown, { once: false });

  const cleanup = () => {
    overlay.removeEventListener("pointerdown", onPointerDown);
    overlay.removeEventListener("pointermove", onPointerMove);
    overlay.removeEventListener("pointerup", onPointerUp);
    overlay.removeEventListener("pointercancel", onPointerCancel);
    overlay.removeEventListener("contextmenu", onContextMenu);
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

function getRecordIconSvg(recording = false): string {
  return recording
    ? `
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true" focusable="false">
        <circle cx="18" cy="18" r="9.5" stroke="currentColor" stroke-width="2.4"/>
        <circle cx="18" cy="18" r="6.2" fill="#ff7474" stroke="currentColor" stroke-width="2"/>
      </svg>
    `
    : `
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true" focusable="false">
        <circle cx="18" cy="18" r="9.5" stroke="currentColor" stroke-width="2.4"/>
        <circle cx="18" cy="18" r="6.2" stroke="currentColor" stroke-width="2"/>
      </svg>
    `;
}

function withShortcut(label: string, action: ShortcutAction): string {
  return shortcutsEnabled ? `${label} (${shortcutKeys[action]})` : label;
}

function setChzzkRecordButtonContent(button: HTMLElement): void {
  const isFullRecording = currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode === RECORDING_MODE.full;
  const isRegionRecording = currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode !== RECORDING_MODE.full;
  const label = withShortcut(isFullRecording ? "전체 녹화 정지" : "전체 녹화 시작", "fullRecord");
  button.setAttribute("aria-label", label);
  button.setAttribute("type", "button");
  button.removeAttribute("title");
  button.toggleAttribute("data-recording", isFullRecording);
  if (button instanceof HTMLButtonElement) {
    button.disabled = isRegionRecording;
  }
  button.innerHTML = `
    <span class="pzp-button__tooltip pzp-button__tooltip--top">${label}</span>
    <span class="pzp-ui-icon pzp-pc-setting-button__icon">${getRecordIconSvg(isFullRecording)}</span>
  `;
}

function setChzzkCancelButtonContent(button: HTMLElement): void {
  const label = withShortcut("녹화 취소", "cancelRecording");
  button.setAttribute("aria-label", label);
  button.setAttribute("type", "button");
  button.removeAttribute("title");
  button.innerHTML = `
    <span class="pzp-button__tooltip pzp-button__tooltip--top">${label}</span>
    <span class="pzp-ui-icon pzp-pc-setting-button__icon">${getTrashIconSvg()}</span>
  `;
}

function setChzzkScreenshotButtonContent(button: HTMLElement): void {
  const label = withShortcut("전체 스크린샷", "fullScreenshot");
  button.setAttribute("aria-label", label);
  button.setAttribute("type", "button");
  button.removeAttribute("title");
  button.innerHTML = `
    <span class="pzp-button__tooltip pzp-button__tooltip--top">${label}</span>
    <span class="pzp-ui-icon pzp-pc-setting-button__icon">${getCameraIconSvg()}</span>
  `;
}

function setChzzkButtonContent(button: HTMLElement): void {
  const label = withShortcut(PLAYER_TOOL_LABEL, "selectRegion");
  button.setAttribute("aria-label", label);
  button.setAttribute("type", "button");
  button.removeAttribute("title");
  button.innerHTML = `
    <span class="pzp-button__tooltip pzp-button__tooltip--top">${label}</span>
    <span class="pzp-ui-icon pzp-pc-setting-button__icon">${getCropIconSvg()}</span>
  `;
}

function showSeekFeedback(deltaSeconds: number): void {
  ensureStyle();
  const videoRect = findPrimaryVideoElement()?.getBoundingClientRect();
  const feedback = document.getElementById(SEEK_FEEDBACK_ID) ?? document.createElement("div");
  feedback.id = SEEK_FEEDBACK_ID;
  feedback.textContent = `${deltaSeconds > 0 ? "+" : ""}${deltaSeconds}초`;
  if (videoRect && videoRect.width > 0 && videoRect.height > 0) {
    feedback.style.left = `${videoRect.left + videoRect.width / 2}px`;
    feedback.style.top = `${videoRect.top + videoRect.height / 2}px`;
  } else {
    feedback.style.left = "50%";
    feedback.style.top = "50%";
  }
  document.body.appendChild(feedback);
  feedback.dataset.visible = "true";

  if (seekFeedbackTimerId !== null) {
    window.clearTimeout(seekFeedbackTimerId);
  }
  seekFeedbackTimerId = window.setTimeout(() => {
    feedback.dataset.visible = "false";
    seekFeedbackTimerId = null;
  }, 650);
}

function handlePlayerScreenshotActivation(event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }

  const now = Date.now();
  if (event.type === "click" && now - lastScreenshotPointerActivationAt < POINTER_CLICK_DEDUP_MS) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.type === "pointerdown") {
    lastScreenshotPointerActivationAt = now;
  }

  event.preventDefault();
  event.stopPropagation();
  void captureFullScreenshot();
}

function seekPrimaryVideo(deltaSeconds: number): void {
  const video = findPrimaryVideoElement();
  if (!video) {
    window.alert("이동할 비디오를 찾지 못했습니다.");
    return;
  }

  const nextTime = video.currentTime + deltaSeconds;
  video.currentTime = Number.isFinite(video.duration)
    ? clamp(nextTime, 0, video.duration)
    : Math.max(0, nextTime);
  showSeekFeedback(deltaSeconds);
}

function handlePlayerToolActivation(event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  startSelection();
}

function handlePlayerRecordActivation(event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }

  const now = Date.now();
  if (event.type === "click" && now - lastRecordPointerActivationAt < POINTER_CLICK_DEDUP_MS) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.type === "pointerdown") {
    lastRecordPointerActivationAt = now;
  }

  event.preventDefault();
  event.stopPropagation();
  if (currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode !== RECORDING_MODE.full) {
    return;
  }
  if (recordingCommandInFlight) {
    return;
  }

  const type = currentRecordingState.status === RECORDING_STATUS.recording ? "STOP_RECORDING" : "START_FULL_RECORDING";
  const previousRecordingState = currentRecordingState;
  if (type === "STOP_RECORDING") {
    currentRecordingState = { status: RECORDING_STATUS.idle };
    requestChzzkToolSync();
    syncChzzkRecordTimer();
  }

  recordingCommandInFlight = true;
  void sendRuntimeMessage({ type })
    .then((response) => {
      if (response.ok) {
        if (type === "START_FULL_RECORDING") {
          currentRecordingState = { status: RECORDING_STATUS.recording, startedAt: Date.now(), mode: RECORDING_MODE.full };
          requestChzzkToolSync();
          syncChzzkRecordTimer();
        }
        return;
      }
      if (type === "STOP_RECORDING") {
        currentRecordingState = previousRecordingState;
        requestChzzkToolSync();
        syncChzzkRecordTimer();
      }
      window.alert(response.error);
    })
    .catch((error: Error) => {
      if (type === "STOP_RECORDING") {
        currentRecordingState = previousRecordingState;
        requestChzzkToolSync();
        syncChzzkRecordTimer();
      }
      window.alert(error.message);
    })
    .finally(() => {
      recordingCommandInFlight = false;
    });
}

function handlePlayerCancelActivation(event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }

  const now = Date.now();
  if (event.type === "click" && now - lastCancelPointerActivationAt < POINTER_CLICK_DEDUP_MS) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.type === "pointerdown") {
    lastCancelPointerActivationAt = now;
  }

  event.preventDefault();
  event.stopPropagation();
  if (currentRecordingState.status !== RECORDING_STATUS.recording || currentRecordingState.mode !== RECORDING_MODE.full) {
    return;
  }

  const previousRecordingState = currentRecordingState;
  currentRecordingState = { status: RECORDING_STATUS.idle };
  requestChzzkToolSync();
  syncChzzkRecordTimer();

  void cancelRecording()
    .catch((error: Error) => {
      currentRecordingState = previousRecordingState;
      requestChzzkToolSync();
      syncChzzkRecordTimer();
      window.alert(error.message);
    });
}

function bindDirectPlayerScreenshotActivation(button: HTMLElement): void {
  if (button.dataset.cropClipBound === "true") {
    return;
  }

  button.dataset.cropClipBound = "true";
  button.addEventListener("pointerdown", handlePlayerScreenshotActivation);
  button.addEventListener("click", handlePlayerScreenshotActivation);
}

function bindDirectPlayerToolActivation(button: HTMLElement): void {
  if (button.dataset.cropClipBound === "true") {
    return;
  }

  button.dataset.cropClipBound = "true";
  button.addEventListener("pointerdown", handlePlayerToolActivation);
  button.addEventListener("click", handlePlayerToolActivation);
}

function bindDirectPlayerRecordActivation(button: HTMLElement): void {
  if (button.dataset.cropClipBound === "true") {
    return;
  }

  button.dataset.cropClipBound = "true";
  button.addEventListener("pointerdown", handlePlayerRecordActivation);
  button.addEventListener("click", handlePlayerRecordActivation);
}

function bindDirectPlayerCancelActivation(button: HTMLElement): void {
  if (button.dataset.cropClipBound === "true") {
    return;
  }

  button.dataset.cropClipBound = "true";
  button.addEventListener("pointerdown", handlePlayerCancelActivation);
  button.addEventListener("click", handlePlayerCancelActivation);
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
  ).filter((button) =>
    button.id !== CHZZK_TOOL_BUTTON_ID &&
    button.id !== CHZZK_RECORD_BUTTON_ID &&
    button.id !== CHZZK_CANCEL_BUTTON_ID &&
    button.id !== CHZZK_SCREENSHOT_BUTTON_ID &&
    isVisibleElement(button)
  );
}

function compareBottomRight(a: DOMRect, b: DOMRect): number {
  const bottomDifference = b.bottom - a.bottom;
  if (Math.abs(bottomDifference) > 24) {
    return bottomDifference;
  }
  return b.right - a.right;
}

function findChzzkButtonHost(): HTMLElement | null {
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
    return explicitHost.host;
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
  return fallback?.host ?? null;
}

function syncChzzkToolButton(): void {
  if (!location.hostname.includes("chzzk.naver.com")) {
    return;
  }

  const existing = document.getElementById(CHZZK_TOOL_BUTTON_ID) as HTMLButtonElement | null;
  const existingRecord = document.getElementById(CHZZK_RECORD_BUTTON_ID) as HTMLButtonElement | null;
  const existingTime = document.getElementById(CHZZK_RECORD_TIME_ID) as HTMLSpanElement | null;
  const existingCancel = document.getElementById(CHZZK_CANCEL_BUTTON_ID) as HTMLButtonElement | null;
  const existingScreenshot = document.getElementById(CHZZK_SCREENSHOT_BUTTON_ID) as HTMLButtonElement | null;
  const target = findChzzkButtonHost();
  if (!target) {
    existing?.remove();
    existingRecord?.remove();
    existingTime?.remove();
    existingCancel?.remove();
    existingScreenshot?.remove();
    return;
  }

  const host = target;
  if (!fullRecordButtonEnabled) {
    existingRecord?.remove();
    existingTime?.remove();
    existingCancel?.remove();
  }
  if (!fullScreenshotButtonEnabled) {
    existingScreenshot?.remove();
  }
  const isFullRecording = currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode === RECORDING_MODE.full;
  const timeBadge = fullRecordButtonEnabled && isFullRecording ? existingTime ?? document.createElement("span") : null;
  if (timeBadge) {
    timeBadge.id = CHZZK_RECORD_TIME_ID;
    timeBadge.className = `${CHZZK_TOOL_BUTTON_CLASS} crop-clip-record-time`;
    timeBadge.setAttribute("aria-hidden", "true");
    timeBadge.hidden = false;
    timeBadge.textContent = currentRecordingState.startedAt ? formatElapsed(Date.now() - currentRecordingState.startedAt) : "";
  } else {
    existingTime?.remove();
  }

  const recordButton = fullRecordButtonEnabled ? existingRecord ?? document.createElement("button") : null;
  if (recordButton) {
    recordButton.id = CHZZK_RECORD_BUTTON_ID;
    recordButton.className = CHZZK_TOOL_BUTTON_CLASS;
    recordButton.type = "button";
    setChzzkRecordButtonContent(recordButton);
    bindDirectPlayerRecordActivation(recordButton);
  }

  const cancelButton = fullRecordButtonEnabled && isFullRecording ? existingCancel ?? document.createElement("button") : null;
  if (cancelButton) {
    cancelButton.id = CHZZK_CANCEL_BUTTON_ID;
    cancelButton.className = CHZZK_TOOL_BUTTON_CLASS;
    cancelButton.type = "button";
    setChzzkCancelButtonContent(cancelButton);
    bindDirectPlayerCancelActivation(cancelButton);
  } else {
    existingCancel?.remove();
  }

  const screenshotButton = fullScreenshotButtonEnabled ? existingScreenshot ?? document.createElement("button") : null;
  if (screenshotButton) {
    screenshotButton.id = CHZZK_SCREENSHOT_BUTTON_ID;
    screenshotButton.className = CHZZK_TOOL_BUTTON_CLASS;
    screenshotButton.type = "button";
    setChzzkScreenshotButtonContent(screenshotButton);
    bindDirectPlayerScreenshotActivation(screenshotButton);
  }

  const selectButton = existing ?? document.createElement("button");
  selectButton.id = CHZZK_TOOL_BUTTON_ID;
  selectButton.className = CHZZK_TOOL_BUTTON_CLASS;
  selectButton.type = "button";
  selectButton.disabled = isRegionRecordingActive();
  setChzzkButtonContent(selectButton);
  bindDirectPlayerToolActivation(selectButton);

  const needsReinsert = (recordButton ? recordButton.parentElement !== host : false)
    || (cancelButton ? cancelButton.parentElement !== host : false)
    || (screenshotButton ? screenshotButton.parentElement !== host : false)
    || selectButton.parentElement !== host
    || (timeBadge && recordButton ? timeBadge.parentElement !== host || timeBadge.nextElementSibling !== recordButton : false)
    || (recordButton && cancelButton ? recordButton.nextElementSibling !== cancelButton : false)
    || (cancelButton && screenshotButton ? cancelButton.nextElementSibling !== screenshotButton : false)
    || (recordButton && !cancelButton && screenshotButton ? recordButton.nextElementSibling !== screenshotButton : false)
    || (recordButton && !cancelButton && !screenshotButton ? recordButton.nextElementSibling !== selectButton : false)
    || (cancelButton && !screenshotButton ? cancelButton.nextElementSibling !== selectButton : false)
    || (screenshotButton ? screenshotButton.nextElementSibling !== selectButton : false);

  if (needsReinsert) {
    timeBadge?.remove();
    recordButton?.remove();
    cancelButton?.remove();
    screenshotButton?.remove();
    selectButton.remove();
    const firstControl = Array.from(host.children).find(
      (child) =>
        child instanceof HTMLElement &&
        child.id !== CHZZK_TOOL_BUTTON_ID &&
        child.id !== CHZZK_RECORD_BUTTON_ID &&
        child.id !== CHZZK_CANCEL_BUTTON_ID &&
        child.id !== CHZZK_SCREENSHOT_BUTTON_ID &&
        child.id !== CHZZK_RECORD_TIME_ID,
    );
    if (timeBadge) {
      host.insertBefore(timeBadge, firstControl ?? null);
    }
    if (recordButton) {
      host.insertBefore(recordButton, firstControl ?? null);
    }
    if (cancelButton) {
      host.insertBefore(cancelButton, firstControl ?? null);
    }
    if (screenshotButton) {
      host.insertBefore(screenshotButton, firstControl ?? null);
    }
    host.insertBefore(selectButton, firstControl ?? null);
  }
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

function syncChzzkRecordTimer(): void {
  if (chzzkRecordTimerId !== null) {
    window.clearInterval(chzzkRecordTimerId);
    chzzkRecordTimerId = null;
  }

  if (!fullRecordButtonEnabled || currentRecordingState.status !== RECORDING_STATUS.recording || currentRecordingState.mode !== RECORDING_MODE.full) {
    document.getElementById(CHZZK_RECORD_TIME_ID)?.remove();
    return;
  }

  chzzkRecordTimerId = window.setInterval(() => requestChzzkToolSync(), 1000);
}

function installChzzkToolButton(): void {
  if (!location.hostname.includes("chzzk.naver.com")) {
    return;
  }

  ensureStyle();
  syncChzzkToolButton();
  syncChzzkRecordTimer();
  chzzkToolObserver?.disconnect();
  chzzkToolObserver = new MutationObserver(() => requestChzzkToolSync());
  chzzkToolObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function installPlayerToolButtons(): void {
  installChzzkToolButton();
}

function isRegionRecordingActive(): boolean {
  return currentRecordingState.status === RECORDING_STATUS.recording && currentRecordingState.mode !== RECORDING_MODE.full;
}

function isRegionRecordingState(value: LocalRecordingState): boolean {
  return value.status === RECORDING_STATUS.recording && value.mode !== RECORDING_MODE.full;
}

function activateRegionAtPoint(x: number, y: number): void {
  if (isRegionRecordingActive()) {
    return;
  }

  const nextIndex = currentRegions.findIndex((region) => {
    const displayRegion = resolveRegionToViewport(region);
    return x >= displayRegion.x && x <= displayRegion.x + displayRegion.width
      && y >= displayRegion.y && y <= displayRegion.y + displayRegion.height;
  });
  if (nextIndex >= 0) {
    setActiveRegion(nextIndex);
  }
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function handleShortcut(event: KeyboardEvent): void {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || isEditableShortcutTarget(event.target)) {
    return;
  }

  if (seekEnabled && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
    event.preventDefault();
    seekPrimaryVideo(event.key === "ArrowLeft" ? -seekSeconds : seekSeconds);
    return;
  }

  if (!shortcutsEnabled) {
    return;
  }

  const key = event.key.toLowerCase();
  if (multiRegionEnabled && /^[1-4]$/.test(key)) {
    const nextIndex = Number(key) - 1;
    if (nextIndex < getActiveRegionLimit() && currentRegions[nextIndex]) {
      event.preventDefault();
      setActiveRegion(nextIndex);
    }
    return;
  }

  if (key === shortcutKeys.selectRegion) {
    event.preventDefault();
    if (isRegionRecordingActive()) {
      return;
    }
    startSelection();
  } else if (key === shortcutKeys.clearRegion) {
    event.preventDefault();
    if (isRegionRecordingActive()) {
      return;
    }
    if (selectionActive) {
      cancelSelection();
      return;
    }

    void (async () => {
      if (currentRegions.length === 0) {
        return;
      }
      removeRegionAtIndex(activeRegionIndex);
    })();
  } else if (key === shortcutKeys.clearAllRegions) {
    event.preventDefault();
    if (isRegionRecordingActive()) {
      return;
    }
    if (selectionActive) {
      cancelSelection();
    }
    void clearRegion();
  } else if (key === shortcutKeys.regionRecord) {
    event.preventDefault();
    void toggleRegionRecording().catch((error: Error) => window.alert(error.message));
  } else if (key === shortcutKeys.cancelRecording) {
    event.preventDefault();
    void cancelRecording().catch((error: Error) => window.alert(error.message));
  } else if (key === shortcutKeys.regionScreenshot) {
    event.preventDefault();
    void captureRegionScreenshot();
  } else if (key === shortcutKeys.fullRecord && fullRecordButtonEnabled) {
    event.preventDefault();
    void toggleFullRecording().catch((error: Error) => window.alert(error.message));
  } else if (key === shortcutKeys.fullScreenshot && fullScreenshotButtonEnabled) {
    event.preventDefault();
    void captureFullScreenshot();
  }
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

if (isExtensionContextAvailable()) {
  chrome.runtime.onMessage.addListener((message: ContentCommand | PlayerStatusRequest, _sender, sendResponse: (response: MessageResponse | PlayerStatusResponse | RegionGeometryResponse | RegionGeometriesResponse) => void) => {
    if (message.type === "GET_PLAYER_STATUS") {
      sendResponse(getPlayerStatus());
      return false;
    }

    if (message.type === "CLEAR_REGION") {
      void (async () => {
        const state = await loadState();
        if (isRegionRecordingState(state.recordingState)) {
          sendResponse({ ok: false, error: "녹화 중에는 영역을 해제할 수 없습니다." });
          return;
        }

        await clearRegion();
        currentRegion = null;
        currentRegions = [];
        showSelectionBorders([]);
        sendResponse({ ok: true });
      })().catch((error: unknown) => {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "영역을 해제하지 못했습니다." });
      });
      return true;
    }

    if (message.type === "GET_REGION_GEOMETRY") {
      const region = getCurrentRegionGeometry();
      sendResponse(region ? { ok: true, data: region } : { ok: false, error: "현재 선택된 녹화 영역을 찾지 못했습니다." });
      return false;
    }

    if (message.type === "GET_REGION_GEOMETRIES") {
      const regions = getCurrentRegionGeometries();
      sendResponse(regions.length > 0 ? { ok: true, data: regions } : { ok: false, error: "현재 선택된 녹화 영역을 찾지 못했습니다." });
      return false;
    }

    if (message.type === "GET_PLAYER_REGION_GEOMETRY") {
      const region = getPlayerRegionGeometry();
      sendResponse(region ? { ok: true, data: region } : { ok: false, error: "재생 가능한 비디오 영역을 찾지 못했습니다." });
      return false;
    }

    if (message.type === "CAPTURE_FULL_SCREENSHOT") {
      void captureFullScreenshot()
        .then(() => sendResponse({ ok: true }))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;
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

    if (message.type === "CANCEL_DIRECT_RECORDING") {
      void cancelDirectRecording(message.recordingId)
        .then((response) => sendResponse(response))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message.type !== "START_SELECTION") {
      return false;
    }

    void (async () => {
      const state = await loadState();

      if (state.recordingState.status === RECORDING_STATUS.recording && state.recordingState.mode !== RECORDING_MODE.full) {
        sendResponse({ ok: false, error: "녹화 중에는 영역을 선택할 수 없습니다." });
        return;
      }

      currentRegion = state.region;
      currentRegions = state.regions;
      multiRegionEnabled = state.multiRegionEnabled;
      multiRegionMaxCount = state.multiRegionMaxCount;
      trimRegionsToLimit();
      startSelection();
      sendResponse({ ok: true });
    })().catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "영역 선택을 시작하지 못했습니다." });
    });

    return true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes.region) {
      currentRegion = normalizeRegion(changes.region.newValue);
    }

    if (changes.regions) {
      currentRegions = normalizeRegions(changes.regions.newValue, currentRegion);
    }

    if (changes.region || changes.regions) {
      void refreshBorder();
    }

    if (changes.recordingState) {
      const nextState = normalizeRecordingState(changes.recordingState.newValue);
      currentRecordingState = nextState;
      if (nextState.status === RECORDING_STATUS.recording && nextState.mode !== RECORDING_MODE.full && selectionActive) {
        cancelSelection("녹화 중에는 영역을 다시 선택할 수 없습니다.");
      }
      showSelectionBorders(currentRegions);
      requestChzzkToolSync();
      syncChzzkRecordTimer();
    }

    if (changes.settings) {
      const settings = changes.settings.newValue as Partial<Settings> | undefined;
      multiRegionEnabled = Boolean(settings?.enableMultiRegion);
      multiRegionMaxCount = getMultiRegionLimit(settings);
      if (!multiRegionEnabled && currentRegions.length > 1) {
        currentRegions = currentRegions.slice(0, 1);
        void saveRegions(currentRegions);
        showSelectionBorders(currentRegions);
      }
      trimRegionsToLimit();
      fullRecordButtonEnabled = Boolean(settings?.enableFullRecordButton);
      fullScreenshotButtonEnabled = Boolean(settings?.enableFullScreenshotButton);
      seekEnabled = Boolean(settings?.enableSeek ?? (settings as Partial<Settings> & { enableSeekButtons?: boolean } | undefined)?.enableSeekButtons);
      seekSeconds = Number.isFinite(settings?.seekSeconds) ? Number(settings?.seekSeconds) : DEFAULT_SEEK_SECONDS;
      streamerFilenameEnabled = Boolean(settings?.enableStreamerFilename);
      shortcutsEnabled = Boolean(settings?.enableShortcuts);
      shortcutKeys = normalizeShortcutKeys(settings?.shortcutKeys);
      requestChzzkToolSync();
      syncChzzkRecordTimer();
    }
  });
}

window.addEventListener("resize", () => {
  void refreshBorder();
});

window.addEventListener("scroll", () => {
  if (currentRegions.length > 0) {
    currentRegions.forEach((region, index) => {
      const border = currentBorders.get(index);
      if (border) {
        applyBorderGeometry(border, region);
      }
    });
  }
}, true);

window.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || selectionActive || currentRegions.length === 0) {
    return;
  }
  activateRegionAtPoint(event.clientX, event.clientY);
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
  handleShortcut(event);
  if (event.defaultPrevented) {
    return;
  }

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

  void initializePageState()
    .catch(() => {})
    .then(installPlayerToolButtons);
})();
