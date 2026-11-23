import { stopRecordingStream, releaseDirectRecordingCapture, releaseDirectRecordingRecorder, requestDirectPartStop, type DirectRecordingSession } from "./recording_session.js";
import { getVideoStream } from "./player_capture.js";
import { createVideoFrameCapture, getNextRecordingFrameDeadline } from "./frame_capture.js";
import { getOriginalPlaylist, openOriginalStream, OriginalStreamError, type OriginalStreamProbe } from "./original_stream.js";
import { computeDirectLayout, scaleLayout, type DirectCrop, type DirectCropPlacement } from "./crop_layout.js";
import type { PlayerRecordingState } from "./player_state.js";
import { getRegionLimit } from "../shared/normalize.js";
import { MAX_ORIGINAL_STREAM_SECONDS, MILLISECONDS_PER_SECOND, SECONDS_PER_MINUTE } from "../shared/time_range.js";
import { HEVC_MP4_MIME_TYPES, RECORDING_FORMAT, RECORDING_MIME_CANDIDATES, STANDARD_RECORDING_FRAME_RATE, HIGH_RECORDING_FRAME_RATE, STARTUP_STALL_WINDOW_SECONDS, STARTUP_TRIM_MIN_SECONDS, STARTUP_TRIM_MAX_SECONDS, type RegionSelection, type Settings } from "../shared/types.js";
import type { ContentCommand, MessageResponse, RuntimeMessage } from "../shared/messages.js";

const CHUNK_INDEX_DIGITS = 6;
const AUDIO_BITS_PER_SECOND = 128_000;
const STARTUP_FRAME_GAP_MS = 150;
const MAX_RECORDING_MESSAGE_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_RECORDING_BYTES = 64 * 1024 * 1024;
const CHECKPOINT_REPLY_TIMEOUT_MS = 15_000;
const FINALIZE_REPLY_TIMEOUT_MS = 30_000;

type RecordingStatus = Readonly<Pick<DirectRecordingSession, "recordingId" | "startedAt" | "stopRequested" | "recordedBytes">>;

interface RecordingControllerOptions {
  findPrimaryVideoElement(): HTMLVideoElement | null;
  waitForCurrentVideoFrame(video: HTMLVideoElement): Promise<boolean>;
  computeDirectCropFromSelection(region: RegionSelection, video: HTMLVideoElement): DirectCrop | null;
  buildBaseName(startedAt: number): string;
  handleDetachedPlayer(video: HTMLVideoElement): void;
  sendRuntimeMessage<T = undefined>(message: RuntimeMessage): Promise<MessageResponse<T>>;
  showPlayerFeedback(message: string, duration?: number): void;
  syncRecordingCommandButtons(): void;
  loadState(): Promise<{ recordingState: PlayerRecordingState }>;
  renderRecordingState(state: PlayerRecordingState): void;
}

function playbackUsesHevc(video: HTMLVideoElement): boolean {
  let hevc = false;
  const receive = () => { hevc = true; };
  video.addEventListener("cropclip-playback-hevc", receive, { once: true });
  video.dispatchEvent(new Event("cropclip-check-playback-codec", { bubbles: true }));
  video.removeEventListener("cropclip-playback-hevc", receive);
  return hevc;
}

function selectDirectMimeType(settings: Settings, sourceUsesHevc = false): { mimeType: string; extension: "webm" | "mp4"; hevc?: true } {
  const extension = settings.outputFormat === RECORDING_FORMAT.mp4 ? RECORDING_FORMAT.mp4 : RECORDING_FORMAT.webm;
  if (extension === RECORDING_FORMAT.mp4 && settings.recordingCodec === "hevc" && sourceUsesHevc) {
    const mimeType = HEVC_MP4_MIME_TYPES.find(candidate => MediaRecorder.isTypeSupported(candidate));
    if (mimeType) return { mimeType, extension, hevc: true };
  }
  const candidates = RECORDING_MIME_CANDIDATES[extension];

  for (const mimeType of candidates) {
    if (MediaRecorder.isTypeSupported(mimeType)) {
      return {
        mimeType,
        extension,
      };
    }
  }

  if (extension === RECORDING_FORMAT.mp4) {
    throw new Error("이 브라우저에서는 MP4 녹화가 제대로 동작하지 않습니다. WebM으로 변경하세요.");
  }

  throw new Error("이 브라우저에서는 WebM 녹화가 제대로 동작하지 않습니다.");
}

function getCropLayoutKey(crops: DirectCrop[]): string {
  return crops.map((crop) => `${crop.x}:${crop.y}:${crop.width}:${crop.height}`).join("|");
}

export function createRecordingController({
  findPrimaryVideoElement, waitForCurrentVideoFrame, computeDirectCropFromSelection, buildBaseName,
  handleDetachedPlayer, sendRuntimeMessage, showPlayerFeedback, syncRecordingCommandButtons, loadState, renderRecordingState,
}: RecordingControllerOptions) {
  let directSession: DirectRecordingSession | null = null;
  let savedFirstScreenRecording = false;

  function readBlobAsDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const reader = new FileReader();
    const abort = () => reader.abort();
    return new Promise<string>((resolve, reject) => {
      reader.onload = () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
        } else {
          reject(new Error("녹화 체크포인트를 변환하지 못했습니다."));
        }
      };
      reader.onerror = () => reject(reader.error ?? new Error("녹화 체크포인트를 변환하지 못했습니다."));
      reader.onabort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      reader.readAsDataURL(blob);
    }).finally(() => signal.removeEventListener("abort", abort));
  }

  function getRecordingChunkSliceRanges(size: number, maxBytes: number): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];
    for (let start = 0; start < size; start += maxBytes) {
      ranges.push({ start, end: Math.min(size, start + maxBytes) });
    }
    return ranges;
  }

  function queueDirectChunkCheckpoint(session: DirectRecordingSession, blob: Blob): void {
    if (session.cancelRequested || session.checkpointError) {
      return;
    }

    session.pendingChunks.push({ blob, capturedAt: Date.now() });
    session.recordedBytes += blob.size;
    session.pendingBytes += blob.size;
    if (session.pendingBytes >= MAX_PENDING_RECORDING_BYTES && !session.stopRequested) {
      session.stopRequested = true;
      requestDirectPartStop(session);
      showPlayerFeedback("저장이 지연되어 녹화를 종료했습니다. 녹화한 내용은 계속 저장합니다.", 8_000);
    }
    flushDirectCheckpoints(session);
  }

  function flushDirectCheckpoints(session: DirectRecordingSession): void {
    if (!session.originalProbe && !session.checkpointSaving && session.pendingChunks.length) {
      session.checkpointSaving = true;
      session.checkpointSaveChain = saveDirectCheckpoints(session);
    }
  }

  function sendCheckpointMessage<T = undefined>(message: RuntimeMessage, signal: AbortSignal): Promise<MessageResponse<T>> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let abort: () => void;
    return new Promise<MessageResponse<T>>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void sendRuntimeMessage<T>(message).then(resolve, reject);
    }).finally(() => signal.removeEventListener("abort", abort));
  }

  async function saveDirectCheckpoints(session: DirectRecordingSession): Promise<void> {
    try {
      const baseName = session.baseName ??= buildBaseName(session.createdAt);
      while (session.pendingChunks.length > 0 && !session.cancelRequested) {
        const { blob, capturedAt } = session.pendingChunks.shift()!;
        const ranges = getRecordingChunkSliceRanges(blob.size, MAX_RECORDING_MESSAGE_BLOB_BYTES);
        for (const [rangeIndex, range] of ranges.entries()) {
          if (session.cancelRequested) {
            return;
          }

          const dataUrl = await readBlobAsDataUrl(blob.slice(range.start, range.end, blob.type), session.checkpointAbort.signal);
          if (session.cancelRequested) {
            return;
          }
          const deadline = AbortSignal.timeout(CHECKPOINT_REPLY_TIMEOUT_MS);
          const chunkIndex = ++session.checkpointIndex;
          const firstChunk = chunkIndex === 1;
          const firstScreenChunk = firstChunk && session.originalStreamStart === undefined;
          const response = await sendCheckpointMessage({
            type: "STORE_RECORDING_CHUNK",
            chunk: {
              id: `${session.recordingId}:chunk:${String(chunkIndex).padStart(CHUNK_INDEX_DIGITS, "0")}`,
              recordingId: session.recordingId,
              index: chunkIndex,
              mimeType: session.mimeType,
              extension: session.extension,
              baseName,
              createdAt: session.createdAt,
              capturedAt,
              completesBlob: rangeIndex === ranges.length - 1,
              frameRate: firstScreenChunk
                ? session.settings.enable60fps ? HIGH_RECORDING_FRAME_RATE : STANDARD_RECORDING_FRAME_RATE
                : undefined,
              videoBitsPerSecond: firstScreenChunk ? session.settings.videoBitsPerSecond : undefined,
              inspectStartup: firstChunk ? session.inspectStartup : undefined,
              originalStreamStart: firstChunk ? session.originalStreamStart : undefined,
              originalStreamFallback: firstChunk ? session.originalStreamFallback : undefined,
              dataUrl,
            },
          }, AbortSignal.any([session.checkpointAbort.signal, deadline])).catch(error => {
            if (deadline.aborted && error === deadline.reason) throw new Error("녹화 저장 응답이 늦어 받은 구간을 복구합니다.");
            throw error;
          });
          if (!response.ok) {
            throw new Error(response.error);
          }
        }
        session.pendingBytes = Math.max(0, session.pendingBytes - blob.size);
      }
    } catch (error) {
      if (!session.cancelRequested) {
        session.checkpointError ??= error instanceof Error ? error : new Error("녹화 체크포인트를 저장하지 못했습니다.");
        session.stopRequested = true;
        requestDirectPartStop(session);
      }
    } finally {
      session.pendingChunks.length = 0;
      session.pendingBytes = 0;
      session.checkpointSaving = false;
    }
  }

  function cleanupDirectRecordingSession(session: DirectRecordingSession): void {
    releaseDirectRecordingCapture(session);
    if (directSession === session) {
      directSession = null;
    }
  }

  async function finalizeDirectRecording(session: DirectRecordingSession): Promise<void> {
    const response = await sendCheckpointMessage({
      type: "FINALIZE_RECORDING",
      recordingId: session.recordingId,
      endedAt: session.endedAt ?? Date.now(),
      startupTrimSeconds: session.startupTrimSeconds,
      originalStreamEnd: session.originalStreamEnd,
    }, AbortSignal.any([session.checkpointAbort.signal, AbortSignal.timeout(FINALIZE_REPLY_TIMEOUT_MS)]));
    if (!response.ok) {
      // Let finishDirectRecording route this failure through checkpoint recovery too.
      throw new Error(response.error);
    }
    if (session.inspectStartup) savedFirstScreenRecording = true;
    cleanupDirectRecordingSession(session);
    session.resolveFinish();
  }

  function abortDirectRecordingSession(session: DirectRecordingSession): void {
    session.cancelRequested = true;
    session.stopRequested = true;
    requestDirectPartStop(session);
    // Cancelled recordings do not need the final data or a delayed stop callback.
    releaseDirectRecordingRecorder(session);
    session.pendingChunks.length = 0;
    session.pendingBytes = 0;
    session.checkpointAbort.abort();
    cleanupDirectRecordingSession(session);
  }

  function cancelDirectRecordingSession(session: DirectRecordingSession): void {
    abortDirectRecordingSession(session);
    session.resolveFinish();
  }

  function failDirectRecordingSession(session: DirectRecordingSession, error: Error): void {
    if (session.cancelRequested) return;
    abortDirectRecordingSession(session);
    void sendRuntimeMessage({ type: "RECORDING_ERROR", recordingId: session.recordingId, error: error.message })
      .then(response => {
        if (response.ok) session.resolveFinish();
        else session.rejectFinish(error);
      }, () => session.rejectFinish(error));
  }

  async function finishDirectRecording(session: DirectRecordingSession): Promise<void> {
    releaseDirectRecordingCapture(session);
    releaseDirectRecordingRecorder(session);
    try {
      if (!session.cancelRequested) {
        session.originalProbe = undefined;
        flushDirectCheckpoints(session);
        await session.checkpointSaveChain;
      }
      if (session.cancelRequested) {
        cancelDirectRecordingSession(session);
        return;
      }
      if (session.checkpointError) throw session.checkpointError;
      await finalizeDirectRecording(session);
    } catch (error) {
      failDirectRecordingSession(session, error instanceof Error ? error : new Error("녹화 결과를 저장하지 못했습니다."));
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
    const video = session.video;
    if (!video) return;
    const stop = () => stopDirectRecordingAfterSourceChange(session);
    const sourceTracks = session.sourceStream?.getTracks() ?? [];
    const events = ["ended", "loadstart", "emptied"];
    events.forEach(event => video.addEventListener(event, stop));
    sourceTracks.forEach((track) => track.addEventListener("ended", stop));
    session.sourceChangeCleanup = () => {
      events.forEach(event => video.removeEventListener(event, stop));
      sourceTracks.forEach((track) => track.removeEventListener("ended", stop));
    };
  }

  async function startDirectPart(session: DirectRecordingSession, useHevc = false, onStarted?: () => void): Promise<void> {
    session.closingPart = false;

    const output = session.outputStream;
    if (!output) throw new Error("녹화 화면을 준비하지 못했습니다.");
    const retryWithDefaultCodec = async () => {
      releaseDirectRecordingRecorder(session);
      session.mimeType = selectDirectMimeType({ ...session.settings, recordingCodec: "auto" }).mimeType;
      showPlayerFeedback("H.265를 시작할 수 없어 기본 코덱으로 녹화합니다.", 8_000);
      return startDirectPart(session, false, onStarted);
    };
    try {
      const recorder = new MediaRecorder(output, {
        mimeType: session.mimeType,
        videoBitsPerSecond: session.settings.videoBitsPerSecond,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        ...(session.stabilizeStartup ? { videoKeyFrameIntervalDuration: MILLISECONDS_PER_SECOND } : {}),
      });
      session.recorder = recorder;
      recorder.onstart = () => {
        recorder.onstart = null;
        session.mimeType = recorder.mimeType || session.mimeType;
        markDirectRecordingStarted(session);
        if (session.startedAt && !session.stopRequested && !session.cancelRequested) onStarted?.();
      };

      recorder.ondataavailable = (event) => {
        if (event.data.size <= 0 || session.cancelRequested) return;
        queueDirectChunkCheckpoint(session, event.data);
      };

      recorder.onerror = () => {
        if (useHevc && !session.startedAt && !session.stopRequested && !session.cancelRequested) {
          void retryWithDefaultCodec().catch(error => failDirectRecordingSession(session, error));
        } else {
          failDirectRecordingSession(session, new Error("녹화 중 오류가 발생했습니다."));
        }
      };
      session.finishAfterStop = timedOut => {
        if (timedOut) showPlayerFeedback("녹화 종료 신호가 늦어 받은 영상까지 저장합니다.", 8_000);
        void finishDirectRecording(session);
      };
      recorder.onstop = () => session.finishAfterStop?.();

      recorder.start(MILLISECONDS_PER_SECOND);
    } catch (error) {
      if (useHevc) return retryWithDefaultCodec();
      throw error;
    }
  }

  // A handler created inside startDirectRecording retains its canvas/video scope until saving finishes.
  function ignoreRecordingRejection(): void {}

  function handleVideoFrameError(recordingId: string, error: Error): void {
    if (directSession?.recordingId === recordingId) failDirectRecordingSession(directSession, error);
  }

  let recordingEncoderCheck: Promise<void> | undefined;

  function checkDirectRecordingEncoder(): Promise<void> {
    return recordingEncoderCheck ??= prepareRecordingEncoder().catch(error => {
      recordingEncoderCheck = undefined;
      throw error;
    });
  }

  async function prepareDirectRecordingEncoder(settings: Settings, sourceUsesHevc = false): Promise<ReturnType<typeof selectDirectMimeType>> {
    const mime = selectDirectMimeType(settings, sourceUsesHevc);
    if (!mime.hevc && (mime.extension === "mp4" || mime.mimeType.includes("avc1"))) await checkDirectRecordingEncoder();
    return mime;
  }

  function createRecordingSession(
    command: Extract<ContentCommand, { type: "START_DIRECT_RECORDING" }>,
    video: HTMLVideoElement,
    mimeType: string,
    extension: "webm" | "mp4",
  ): DirectRecordingSession {
    let resolveFinish!: () => void;
    let rejectFinish!: (error: Error) => void;
    const finishPromise = new Promise<void>((resolve, reject) => {
      resolveFinish = resolve;
      rejectFinish = reject;
    });
    void finishPromise.catch(ignoreRecordingRejection);
    return {
      recordingId: command.recordingId,
      settings: command.settings,
      video,
      canvas: null,
      mimeType,
      extension,
      checkpointIndex: 0,
      checkpointSaveChain: Promise.resolve(),
      pendingChunks: [],
      pendingBytes: 0,
      recordedBytes: 0,
      checkpointSaving: false,
      checkpointAbort: new AbortController(),
      createdAt: Date.now(),
      stopRequested: false,
      cancelRequested: false,
      cleanedUp: false,
      closingPart: false,
      finishPromise,
      resolveFinish,
      rejectFinish,
      placements: [],
    };
  }

  function markDirectRecordingStarted(session: DirectRecordingSession): void {
    if (directSession !== session || session.startedAt || session.stopRequested || session.cancelRequested) return;
    session.startedAt = session.createdAt = Date.now();
    session.baseName = buildBaseName(session.startedAt);
    syncRecordingCommandButtons();
    void sendRuntimeMessage({
      type: "RECORDING_STARTED",
      recordingId: session.recordingId,
      startedAt: session.startedAt,
    }).catch(ignoreRecordingRejection);
  }

  async function syncStartedRecording(session: DirectRecordingSession): Promise<void> {
    const { recordingState } = await loadState();
    if (directSession !== session) return;
    renderRecordingState(recordingState);
  }

  async function startOriginalRecording(command: Extract<ContentCommand, { type: "START_DIRECT_RECORDING" }>, video: HTMLVideoElement, fallback: DirectRecordingSession, probe: AbortController): Promise<string | undefined> {
    const src = video.currentSrc;
    if (video.paused || !src.startsWith("blob:") || (video.duration !== Infinity && !location.pathname.startsWith("/live/"))) {
      return "지원하는 라이브 재생이 아닙니다.";
    }
    if (command.playback && command.playback.src !== src) return "방송 영상이 바뀌었습니다.";
    const startTime = video.currentTime;
    if (!Number.isFinite(startTime) || startTime < 0) return "방송의 재생 시각을 읽지 못했습니다.";
    const timeout = window.setTimeout(() => probe.abort(), 5_000);
    let source;
    let offset: number;
    let start: number;
    try {
      const response = await sendCheckpointMessage<OriginalStreamProbe>({ type: "READ_STREAM_OFFSET", src }, probe.signal);
      if (!response.ok) return response.error;
      if (!response.data || !Number.isFinite(response.data.offset) || video.currentSrc !== src) return "방송의 재생 시각을 읽지 못했습니다.";
      offset = response.data.offset;
      start = startTime - offset;
      if (start < 0) return "방송의 재생 시각을 원본과 맞추지 못했습니다.";
      source = await openOriginalStream(getOriginalPlaylist(response.data.playlist), start, probe.signal);
    } catch (error) {
      if (probe.signal.aborted) return "원본 응답이 지연되었습니다.";
      return error instanceof OriginalStreamError ? error.message : "원본 방송 데이터를 받지 못했습니다.";
    } finally {
      window.clearTimeout(timeout);
    }

    if (directSession !== fallback || fallback.stopRequested || fallback.cancelRequested || probe.signal.aborted) return;
    if (video.currentSrc !== src || video.seeking) return "방송 영상이 바뀌었습니다.";
    const session = createRecordingSession(command, video, "video/mp4", "mp4");
    session.startedAt = fallback.startedAt;
    session.createdAt = fallback.createdAt;
    session.baseName = fallback.baseName;
    session.checkpointAbort = probe;
    session.originalStreamStart = start;
    let end: number | undefined;
    let lastPlaybackTime = video.currentTime;
    const updatePlaybackTime = () => { if (!video.seeking && video.currentSrc === src) lastPlaybackTime = video.currentTime; };
    session.stopOriginalStream = () => {
      const position = video.currentSrc === src && !video.seeking ? Math.max(video.currentTime, lastPlaybackTime) : lastPlaybackTime;
      end ??= Math.max(start + 1 / STANDARD_RECORDING_FRAME_RATE, position - offset);
      source.stop();
    };
    const stop = () => stopDirectRecordingAfterSourceChange(session);
    const stopEvents = ["ended", "loadstart", "emptied", "seeking", "resize"];
    stopEvents.forEach(event => video.addEventListener(event, stop));
    video.addEventListener("timeupdate", updatePlaybackTime);
    session.sourceChangeCleanup = () => {
      stopEvents.forEach(event => video.removeEventListener(event, stop));
      video.removeEventListener("timeupdate", updatePlaybackTime);
    };
    // Neither path has written a checkpoint yet. Commit to the original once its first fragment is ready.
    fallback.originalProbe = undefined;
    cancelDirectRecordingSession(fallback);
    directSession = session;
    let saved = false;
    void source.record(async blob => {
      queueDirectChunkCheckpoint(session, blob);
      await session.checkpointSaveChain;
      if (session.checkpointError) throw session.checkpointError;
      saved = true;
    }, () => video.currentTime - offset, () => end).then(async last => {
      if (session.cancelRequested) return;
      if (!session.stopRequested) {
        showPlayerFeedback(`최대 녹화 시간인 ${MAX_ORIGINAL_STREAM_SECONDS / SECONDS_PER_MINUTE}분에 도달해 저장합니다.`, 8_000);
      }
      if (end !== undefined && last < end - 1 / STANDARD_RECORDING_FRAME_RATE) {
        showPlayerFeedback("마지막 방송 조각이 늦어 먼저 받은 구간까지 저장합니다.", 8_000);
      }
      session.originalStreamEnd = last;
      await finishDirectRecording(session);
    }, async error => {
      if (session.cancelRequested) return;
      if (saved && !session.checkpointError) {
        showPlayerFeedback("원본 연결이 끊겨 받은 구간까지 저장합니다.", 8_000);
        await finishDirectRecording(session);
      } else {
        failDirectRecordingSession(session, error instanceof Error ? error : new Error("원본 방송을 저장하지 못했습니다."));
      }
    });
    await syncStartedRecording(session);
    return undefined;
  }

  function tryOriginalRecording(command: Extract<ContentCommand, { type: "START_DIRECT_RECORDING" }>, video: HTMLVideoElement, session: DirectRecordingSession, probe: AbortController): void {
    void startOriginalRecording(command, video, session, probe).then(reason => {
      if (directSession !== session) {
        if (directSession?.recordingId === session.recordingId) showPlayerFeedback("원본 저장 중");
        return;
      }
      if (!session.stopRequested) {
        const format = session.extension === "webm" ? "WebM" : "MP4";
        showPlayerFeedback([`화면 녹화 중 · ${format}`, reason].filter(Boolean).join("\n"), 8_000);
      }
    }).catch(ignoreRecordingRejection).finally(() => {
      if (session.originalProbe !== probe) return;
      session.originalProbe = undefined;
      if (directSession === session && !session.cancelRequested) flushDirectCheckpoints(session);
    });
  }

  async function startDirectRecording(command: Extract<ContentCommand, { type: "START_DIRECT_RECORDING" }>): Promise<MessageResponse> {
    if (directSession) {
      cancelDirectRecordingSession(directSession);
    }

    const video = findPrimaryVideoElement();
    if (!video) {
      return { ok: false, error: "재생 중인 영상을 찾지 못했습니다." };
    }

    if (!await waitForCurrentVideoFrame(video)) {
      return { ok: false, error: "영상 프레임이 아직 준비되지 않았습니다. 잠시 후 다시 시도하세요." };
    }

    if (!command.settings.allowMutedRecording && (video.muted || video.volume === 0)) {
      return { ok: false, error: "영상이 음소거되어 녹화할 수 없습니다." };
    }

    const originalProbe = command.fullPlayer && command.settings.enableOriginalStreamRecording ? new AbortController() : undefined;
    const sourceUsesHevc = command.settings.recordingCodec === "hevc" && playbackUsesHevc(video);
    const mime = await prepareDirectRecordingEncoder(command.settings, sourceUsesHevc);
    if (sourceUsesHevc && !mime.hevc) {
      showPlayerFeedback("이 환경에서 H.265 인코딩을 지원하지 않아 기본 코덱으로 녹화합니다.", 8_000);
    }

    const sourceRegions = (command.regions?.length ? command.regions : [command.region]).slice(0, getRegionLimit(command.settings));
    const crops = sourceRegions
      .map((region) => computeDirectCropFromSelection(region, video))
      .filter((crop): crop is DirectCrop => crop !== null);
    if (crops.length === 0) {
      return { ok: false, error: "선택 영역이 영상 밖에 있습니다." };
    }

    const layout = computeDirectLayout(crops);
    const output = layout.output;

    const canvas = document.createElement("canvas");
    canvas.width = output.width;
    canvas.height = output.height;

    let context: CanvasRenderingContext2D | null = null;

    // Feed cropped MP4 through canvas capture to keep Chromium's fallback encoder on a native track.
    const useFrameCapture = crops.length === 1 && (mime.extension !== RECORDING_FORMAT.mp4 || command.fullPlayer);
    const frameCapture = useFrameCapture
      ? createVideoFrameCapture(video, output.width, output.height, handleVideoFrameError.bind(null, command.recordingId), mime.extension !== "mp4")
      : null;
    const paintCanvas = (placements: DirectCropPlacement[]) => {
      context ??= canvas.getContext("2d", { alpha: false, desynchronized: true });
      if (!context) throw new Error("녹화 화면을 준비하지 못했습니다.");
      context.fillStyle = "#000";
      context.fillRect(0, 0, output.width, output.height);
      for (const placement of placements) {
        context.drawImage(video, placement.crop.x, placement.crop.y, placement.crop.width, placement.crop.height, placement.dx, placement.dy, placement.dw, placement.dh);
      }
    };
    const paintPlacements = (placements: DirectCropPlacement[]) => {
      if (frameCapture) {
        return frameCapture.paint(placements[0], () => { paintCanvas(placements); return canvas; });
      }
      canvasTrack?.requestFrame();
      paintCanvas(placements);
      return true;
    };

    const frameRate = command.settings.enable60fps ? HIGH_RECORDING_FRAME_RATE : STANDARD_RECORDING_FRAME_RATE;
    const frameInterval = MILLISECONDS_PER_SECOND / frameRate;
    const manualCanvasCapture = typeof CanvasCaptureMediaStreamTrack !== "undefined"
      && typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame === "function";
    const canvasStream = frameCapture?.stream ?? canvas.captureStream(manualCanvasCapture ? 0 : frameRate);
    const canvasTrack = !frameCapture && manualCanvasCapture
      ? canvasStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined
      : undefined;
    const releaseOutput = () => {
      frameCapture?.close();
      stopRecordingStream(canvasStream);
      canvas.width = 0;
      canvas.height = 0;
    };
    try {
      paintPlacements(layout.placements);
    } catch {
      releaseOutput();
      return { ok: false, error: "녹화 화면을 준비하지 못했습니다." };
    }

    let sourceStream: MediaStream | null = null;
    try {
      sourceStream = getVideoStream(video, handleDetachedPlayer);
    } catch {
      releaseOutput();
      return { ok: false, error: "이 브라우저에서는 현재 영상 녹화를 지원하지 않습니다." };
    }
    if (!sourceStream) {
      releaseOutput();
      return { ok: false, error: "이 브라우저에서는 현재 영상 녹화를 지원하지 않습니다." };
    }

    const tracks = [
      ...canvasStream.getVideoTracks(),
      ...sourceStream.getAudioTracks(),
    ];
    const outputStream = new MediaStream(tracks);
    let cropLayoutKey = getCropLayoutKey(crops);
    const layoutDependsOnlyOnVideoSize = sourceRegions.every(region => region.videoRelative);
    let layoutVideoWidth = video.videoWidth;
    let layoutVideoHeight = video.videoHeight;
    let lastPaintedFrame = -1;
    const stabilizeStartup = command.fullPlayer && (mime.hevc || mime.mimeType.includes("avc1"));
    let startupStartedAt: number | undefined;
    let lastStartupFrameAt = 0;
    let lastStartupMediaTime = video.currentTime;

    const drawFrame = () => {
      if (startupStartedAt !== undefined && (video.paused || video.seeking)) startupStartedAt = undefined;
      if (video.paused || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const frame = video.getVideoPlaybackQuality?.().totalVideoFrames;
      if (frame !== undefined && frame === lastPaintedFrame) return;
      if (!layoutDependsOnlyOnVideoSize || layoutVideoWidth !== video.videoWidth || layoutVideoHeight !== video.videoHeight) {
        layoutVideoWidth = video.videoWidth;
        layoutVideoHeight = video.videoHeight;
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
      }
      try {
        if (!paintPlacements(session.placements)) return;
      } catch (error) {
        failDirectRecordingSession(session, error instanceof Error ? error : new Error("녹화 프레임을 준비하지 못했습니다."));
        return;
      }
      lastPaintedFrame = frame ?? -1;
      if (startupStartedAt !== undefined) {
        const now = performance.now();
        const elapsedSeconds = (now - startupStartedAt) / MILLISECONDS_PER_SECOND;
        if (elapsedSeconds <= STARTUP_TRIM_MAX_SECONDS && now - lastStartupFrameAt >= STARTUP_FRAME_GAP_MS && video.currentTime >= lastStartupMediaTime) {
          session.startupTrimSeconds = Math.max(STARTUP_TRIM_MIN_SECONDS, elapsedSeconds);
        }
        if (elapsedSeconds > STARTUP_STALL_WINDOW_SECONDS) {
          startupStartedAt = undefined;
        }
        lastStartupFrameAt = now;
        lastStartupMediaTime = video.currentTime;
      }
    };

    const session: DirectRecordingSession = {
      ...createRecordingSession(command, video, mime.mimeType, mime.extension),
      originalStreamFallback: originalProbe ? true : undefined,
      originalProbe,
      sourceStream,
      outputStream,
      canvas,
      frameCapture: frameCapture ?? undefined,
      stabilizeStartup,
      inspectStartup: stabilizeStartup && !savedFirstScreenRecording ? true : undefined,
      placements: layout.placements,
    };

    directSession = session;
    try {
      if (stabilizeStartup) startupStartedAt = lastStartupFrameAt = performance.now();
      const useVideoCallbacks = typeof video.requestVideoFrameCallback === "function";
      let lastVideoCallbackAt = performance.now();
      let nextDrawAt: number | undefined;
      let previousMediaTime = -Infinity;
      let previousPlaybackRate = 0;
      const drawOnVideoFrame: VideoFrameRequestCallback = (now, { mediaTime }) => {
        session.drawFrameCallbackId = undefined;
        lastVideoCallbackAt = now;
        if (!document.hidden) {
          const playbackRate = Math.abs(video.playbackRate) || 1;
          if (mediaTime < previousMediaTime || playbackRate !== previousPlaybackRate) nextDrawAt = undefined;
          previousMediaTime = mediaTime;
          previousPlaybackRate = playbackRate;
          // Display refresh can round consecutive 30fps frames to 30ms and 40ms.
          const frameTime = mediaTime * MILLISECONDS_PER_SECOND / playbackRate;
          const next = getNextRecordingFrameDeadline(frameTime, nextDrawAt ?? frameTime, frameInterval);
          if (next !== undefined) {
            nextDrawAt = next;
            drawFrame();
          }
        }
        if (!session.cleanedUp) session.drawFrameCallbackId = video.requestVideoFrameCallback(drawOnVideoFrame);
      };
      if (useVideoCallbacks) session.drawFrameCallbackId = video.requestVideoFrameCallback(drawOnVideoFrame);
      session.drawTimerId = window.setInterval(() => {
        // Background tabs may stop receiving presentation callbacks even while audio continues.
        if (!useVideoCallbacks || document.hidden || performance.now() - lastVideoCallbackAt > frameInterval * 2) drawFrame();
      }, Math.round(frameInterval));
      await startDirectPart(session, mime.hevc, originalProbe ? () => tryOriginalRecording(command, video, session, originalProbe) : undefined);
      watchDirectRecordingSource(session);
      await syncStartedRecording(session);
      return { ok: true };
    } catch (error) {
      abortDirectRecordingSession(session);
      session.rejectFinish(error instanceof Error ? error : new Error("녹화를 시작하지 못했습니다."));
      throw error;
    }
  }

  async function stopDirectRecording(recordingId?: string): Promise<MessageResponse> {
    const session = directSession;
    if (recordingId && session && session.recordingId !== recordingId) {
      return { ok: true };
    }
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

    cancelDirectRecordingSession(session);
    return { ok: true };
  }

  function stopDirectRecordingForUnload(video?: HTMLVideoElement): void {
    if (directSession && (!video || directSession.video === video)) stopDirectRecordingAfterSourceChange(directSession);
  }

  return {
    getDirectRecording: (): RecordingStatus | null => directSession,
    checkDirectRecordingEncoder,
    prepareDirectRecordingEncoder,
    playbackUsesHevc,
    startDirectRecording,
    stopDirectRecording,
    cancelDirectRecording,
    stopDirectRecordingForUnload,
  };
}
