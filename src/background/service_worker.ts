import { deleteRecording, deleteRecordingChunks, getChunksByRecordingId, putChunk, putPart, putRecording } from "../shared/idb.js";
import { fail, ok, type AutoDownloadHandledMessage, type ContentCommand, type DeletionScheduleRequest, type FinalizeRecordingMessage, type MessageResponse, type PopupCommand, type RecordingErrorMessage, type StoreRecordingChunkMessage } from "../shared/messages.js";
import { loadAppState, loadRecordingState, saveRecordingState } from "../shared/storage.js";
import { RECORDING_MODE, RECORDING_STATUS, type RecordingRecord, type RegionSelection, type Settings } from "../shared/types.js";
const DELETE_AFTER_MINUTES = 10;
const DELETE_RETRY_MINUTES = 1;
const DELETE_ALARM_PREFIX = "delete-recording:";
const TAB_MESSAGE_RETRY_DELAY_MS = 80;
const CHECKPOINT_FINALIZE_DELAY_MS = 300;
const RECOVERY_FINALIZE_ATTEMPTS = 3;
const RESULT_TAB_CREATE_ATTEMPTS = 3;
const RESULT_TAB_RETRY_DELAY_MS = 200;
const RESULT_TAB_RETRY_ALARM = "open-recording-result";
let recordingStartInFlight = false;
let resultTabLaunchPromise: Promise<boolean> | null = null;
const checkpointStores = new Map<string, Promise<void>>();
const recordingTerminalOperations = new Map<string, Promise<void>>();

function sendToTab<T = undefined>(tabId: number, message: unknown): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(response as T | undefined);
    });
  });
}

function getDeleteAlarmName(recordingId: string): string {
  return `${DELETE_ALARM_PREFIX}${recordingId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getContentScriptErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /message port closed|receiving end does not exist|extension context invalidated/i.test(message)
    ? "현재 페이지가 아직 준비되지 않았습니다. 잠시 후 다시 시도하세요."
    : message || "현재 탭에서 명령을 실행할 수 없습니다.";
}

async function markRecordingErrorIfCurrent(recordingId?: string): Promise<boolean> {
  const state = await loadRecordingState();
  if (state.status !== RECORDING_STATUS.recording || (recordingId && state.recordingId !== recordingId)) {
    return false;
  }

  await saveRecordingState({ ...state, status: RECORDING_STATUS.error });
  return true;
}

async function discardRecordingIfCurrentUnlocked(recordingId: string): Promise<void> {
  const state = await loadRecordingState();
  if (state.recordingId !== recordingId || state.status === RECORDING_STATUS.completed) {
    return;
  }
  if (state.status === RECORDING_STATUS.recording) {
    await saveRecordingState({ ...state, status: RECORDING_STATUS.error });
  }

  await checkpointStores.get(recordingId)?.catch(() => {});
  await deleteRecordingEventually(recordingId);
}

function runRecordingTerminalOperation<T>(recordingId: string, operation: () => Promise<T>): Promise<T> {
  const previous = recordingTerminalOperations.get(recordingId) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  recordingTerminalOperations.set(recordingId, tail);

  return result.finally(() => {
    if (recordingTerminalOperations.get(recordingId) === tail) {
      recordingTerminalOperations.delete(recordingId);
    }
  });
}

async function discardRecordingIfCurrent(recordingId?: string): Promise<void> {
  if (recordingId) {
    await runRecordingTerminalOperation(recordingId, () => discardRecordingIfCurrentUnlocked(recordingId));
  }
}

async function scheduleRecordingDeletion(recordingId: string): Promise<MessageResponse> {
  await chrome.alarms.create(getDeleteAlarmName(recordingId), {
    delayInMinutes: DELETE_AFTER_MINUTES,
  });
  return ok();
}

async function deleteRecordingNow(recordingId: string): Promise<void> {
  await deleteRecording(recordingId);
  await chrome.alarms.clear(getDeleteAlarmName(recordingId));
}

async function deleteRecordingEventually(recordingId: string): Promise<void> {
  try {
    await deleteRecordingNow(recordingId);
  } catch {
    await scheduleRecordingDeletion(recordingId).catch(() => {});
  }
}

async function getActiveRecordableTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const url = tab?.url ?? tab?.pendingUrl;

  if (!tab?.id || !url) {
    throw new Error("녹화할 수 있는 웹 탭에서만 사용할 수 있습니다.");
  }

  const protocol = new URL(url).protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error("http 또는 https 웹 페이지에서만 사용할 수 있습니다.");
  }

  return tab;
}

async function sendCommandToContentScript<T = undefined>(tabId: number, message: ContentCommand): Promise<MessageResponse<T>> {
  const sendMessage = async (): Promise<MessageResponse<T>> => {
    return (await sendToTab<MessageResponse<T>>(tabId, message)) ?? fail("현재 탭에서 응답하지 않았습니다.");
  };

  try {
    return await sendMessage();
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/region_selector.js"],
      });
      await delay(TAB_MESSAGE_RETRY_DELAY_MS);
      return await sendMessage();
    } catch (fallbackError) {
      return fail(getContentScriptErrorMessage(fallbackError instanceof Error ? fallbackError : error));
    }
  }
}

function buildDirectFilename(baseName: string, extension: string, createdAt: number, endedAt: number): string {
  const totalSeconds = Math.max(1, Math.round((endedAt - createdAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  const duration = hours > 0
    ? `${hours}h${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`
    : minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
  return `${baseName}_${duration}.${extension}`;
}

function getFinalRecordingEndedAt(createdAt: number, requestedEndedAt: number, lastCapturedAt?: number): number {
  const endedAt = typeof lastCapturedAt === "number" && Number.isFinite(lastCapturedAt)
    ? Math.min(requestedEndedAt, lastCapturedAt)
    : requestedEndedAt;
  return Math.max(createdAt, endedAt);
}

function decodeRecordingDataUrl(dataUrl: string, mimeType: string): Blob {
  const marker = ";base64,";
  const markerIndex = dataUrl.lastIndexOf(marker);
  if (!dataUrl.startsWith("data:") || markerIndex < 0) {
    throw new Error("녹화 체크포인트 형식이 올바르지 않습니다.");
  }

  const binary = atob(dataUrl.slice(markerIndex + marker.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

async function startSelection(): Promise<MessageResponse> {
  const state = await loadAppState();
  if (state.recordingState.status === RECORDING_STATUS.recording && state.recordingState.mode !== RECORDING_MODE.full) {
    return fail("녹화 중에는 영역을 다시 선택할 수 없습니다.");
  }

  const tab = await getActiveRecordableTab();
  const tabId = tab.id;
  if (typeof tabId !== "number") {
    return fail("녹화할 수 있는 웹 탭에서만 사용할 수 있습니다.");
  }

  return await sendCommandToContentScript(tabId, { type: "START_SELECTION" });
}

async function clearRegion(): Promise<MessageResponse> {
  const state = await loadAppState();
  if (state.recordingState.status === RECORDING_STATUS.recording && state.recordingState.mode !== RECORDING_MODE.full) {
    return fail("녹화 중에는 영역을 해제할 수 없습니다.");
  }

  try {
    const tab = await getActiveRecordableTab();
    const tabId = tab.id;
    if (typeof tabId === "number") {
      const response = await sendCommandToContentScript(tabId, { type: "CLEAR_REGION" });
      if (!response.ok) {
        return response;
      }
    }
  } catch {
    // Storage is the source of truth, so clearing the page border is best-effort.
  }

  await chrome.storage.local.set({ region: null, regions: [] });
  return ok();
}

async function captureFullScreenshot(): Promise<MessageResponse> {
  const tab = await getActiveRecordableTab();
  const tabId = tab.id;
  if (typeof tabId !== "number") {
    return fail("스크린샷을 찍을 수 있는 웹 탭에서만 사용할 수 있습니다.");
  }

  return await sendCommandToContentScript(tabId, { type: "CAPTURE_FULL_SCREENSHOT" });
}

async function getCurrentRegionGeometry(tabId: number): Promise<MessageResponse<RegionSelection>> {
  return await sendCommandToContentScript<RegionSelection>(tabId, { type: "GET_REGION_GEOMETRY" });
}

async function getCurrentRegionGeometries(tabId: number): Promise<MessageResponse<RegionSelection[]>> {
  return await sendCommandToContentScript<RegionSelection[]>(tabId, { type: "GET_REGION_GEOMETRIES" });
}

async function getPlayerRegionGeometry(tabId: number): Promise<MessageResponse<RegionSelection>> {
  return await sendCommandToContentScript<RegionSelection>(tabId, { type: "GET_PLAYER_REGION_GEOMETRY" });
}

async function startDirectRecording(tabId: number, recordingId: string, region: RegionSelection, settings: Settings, regions?: RegionSelection[]): Promise<MessageResponse> {
  return await sendCommandToContentScript(tabId, {
    type: "START_DIRECT_RECORDING",
    recordingId,
    region,
    regions,
    settings,
  });
}

async function stopDirectRecording(tabId: number): Promise<MessageResponse> {
  return await sendCommandToContentScript(tabId, { type: "STOP_DIRECT_RECORDING" });
}

async function cancelDirectRecording(tabId: number, recordingId?: string): Promise<MessageResponse> {
  return await sendCommandToContentScript(tabId, { type: "CANCEL_DIRECT_RECORDING", recordingId });
}

async function startRecordingSession(fullPlayer: boolean): Promise<MessageResponse<{ recordingId: string }>> {
  const tab = await getActiveRecordableTab();
  const tabId = tab.id;
  if (typeof tabId !== "number") {
    return fail("녹화할 수 있는 웹 탭에서만 사용할 수 있습니다.");
  }
  const state = await loadAppState();
  const storedRegion = state.region;

  if (!fullPlayer && !storedRegion) {
    return fail("녹화 영역을 먼저 선택하세요.");
  }

  if (state.recordingState.status === RECORDING_STATUS.recording) {
    return fail("이미 녹화가 진행 중입니다.");
  }
  if (state.recordingState.status === RECORDING_STATUS.completed) {
    const delivered = await ensureCompletedRecordingResult();
    const latestState = await loadRecordingState();
    if (!delivered || latestState.status === RECORDING_STATUS.completed) {
      return fail("이전 녹화 결과를 준비 중입니다. 잠시 후 다시 시도하세요.");
    }
  }

  const settings = state.settings;
  const recordingId = crypto.randomUUID();

  await saveRecordingState({
    status: RECORDING_STATUS.recording,
    recordingId,
    tabId,
    startedAt: Date.now(),
    mode: fullPlayer ? RECORDING_MODE.full : RECORDING_MODE.region,
  });

  try {
    const regionResponse = fullPlayer
      ? await getPlayerRegionGeometry(tabId)
      : settings.enableMultiRegion
        ? await getCurrentRegionGeometries(tabId)
        : await getCurrentRegionGeometry(tabId);
    if (!regionResponse.ok || !regionResponse.data) {
      const error = regionResponse.ok ? "녹화할 영상 영역을 찾지 못했습니다." : regionResponse.error;
      await markRecordingErrorIfCurrent(recordingId);
      return fail(error);
    }

    const regions = Array.isArray(regionResponse.data) ? regionResponse.data : [regionResponse.data];
    if (!regions[0]) {
      const error = "녹화할 영상 영역을 찾지 못했습니다.";
      await markRecordingErrorIfCurrent(recordingId);
      return fail(error);
    }

    const stateBeforeStart = await loadRecordingState();
    if (stateBeforeStart.status !== RECORDING_STATUS.recording || stateBeforeStart.recordingId !== recordingId) {
      return fail("녹화 시작이 취소되었습니다.");
    }

    const response = await startDirectRecording(tabId, recordingId, regions[0], settings, settings.enableMultiRegion ? regions : undefined);
    if (!response.ok) {
      await cancelDirectRecording(tabId, recordingId);
      await discardRecordingIfCurrent(recordingId);
      return response;
    }

    const stateAfterStart = await loadRecordingState();
    if (stateAfterStart.status !== RECORDING_STATUS.recording || stateAfterStart.recordingId !== recordingId) {
      await cancelDirectRecording(tabId, recordingId);
      return fail("녹화 시작이 취소되었습니다.");
    }

    return ok({ recordingId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "녹화를 시작할 수 없습니다.";
    await cancelDirectRecording(tabId, recordingId).catch(() => undefined);
    await discardRecordingIfCurrent(recordingId);
    return fail(message);
  }
}

async function startRecording(fullPlayer = false): Promise<MessageResponse<{ recordingId: string }>> {
  if (recordingStartInFlight) {
    return fail("녹화 시작을 처리 중입니다.");
  }

  recordingStartInFlight = true;
  try {
    return await startRecordingSession(fullPlayer);
  } finally {
    recordingStartInFlight = false;
  }
}

async function stopRecording(): Promise<MessageResponse> {
  const state = await loadRecordingState();
  if (state.status !== RECORDING_STATUS.recording) {
    return fail("진행 중인 녹화가 없습니다.");
  }

  if (typeof state.tabId !== "number") {
    const error = "녹화 중인 탭을 찾지 못했습니다.";
    if (state.recordingId && await recoverRecording(state.recordingId, Date.now())) {
      return ok();
    }
    return fail(error);
  }

  const response = await stopDirectRecording(state.tabId);
  if (!response.ok && state.recordingId) {
    await delay(CHECKPOINT_FINALIZE_DELAY_MS);
    if (await recoverRecording(state.recordingId, Date.now())) {
      return ok();
    }
  }
  return response;
}

async function cancelRecording(): Promise<MessageResponse> {
  const initialState = await loadRecordingState();
  if (initialState.status !== RECORDING_STATUS.recording) {
    return ok();
  }

  if (!initialState.recordingId) {
    await saveRecordingState({ status: RECORDING_STATUS.idle });
    if (typeof initialState.tabId === "number") {
      await cancelDirectRecording(initialState.tabId);
    }
    return ok();
  }

  const recordingId = initialState.recordingId;
  return await runRecordingTerminalOperation(recordingId, async () => {
    const state = await loadRecordingState();
    if (state.status !== RECORDING_STATUS.recording || state.recordingId !== recordingId) {
      return ok();
    }

    await saveRecordingState({ status: RECORDING_STATUS.idle });
    if (typeof state.tabId === "number") {
      await cancelDirectRecording(state.tabId, state.recordingId);
    }
    await checkpointStores.get(state.recordingId)?.catch(() => {});
    await deleteRecordingEventually(state.recordingId);
    return ok();
  });
}

async function completeRecording(recording: RecordingRecord): Promise<MessageResponse> {
  const { recordingState: previousState } = await loadAppState();
  if (previousState.status === RECORDING_STATUS.completed && previousState.recordingId === recording.id) {
    await ensureCompletedRecordingResult();
    return ok();
  }
  if (previousState.status !== RECORDING_STATUS.recording || previousState.recordingId !== recording.id) {
    await deleteRecordingEventually(recording.id);
    return ok();
  }

  await putRecording(recording);
  await saveRecordingState({
    status: RECORDING_STATUS.completed,
    recordingId: recording.id,
    tabId: previousState.tabId,
    startedAt: recording.createdAt,
  });
  await deleteRecordingChunks(recording.id).catch(() => {});

  await ensureCompletedRecordingResult();

  return ok();
}

async function openCompletedRecordingResult(): Promise<boolean> {
  const { recordingState, settings } = await loadAppState();
  if (recordingState.status !== RECORDING_STATUS.completed || !recordingState.recordingId) {
    await chrome.alarms.clear(RESULT_TAB_RETRY_ALARM);
    return true;
  }

  if (typeof recordingState.resultTabId === "number") {
    try {
      await chrome.tabs.get(recordingState.resultTabId);
      await chrome.alarms.clear(RESULT_TAB_RETRY_ALARM);
      return true;
    } catch {
      await saveRecordingState({ ...recordingState, resultTabId: undefined });
    }
  }

  const source = typeof recordingState.tabId === "number" ? `&sourceTabId=${recordingState.tabId}` : "";
  const autoDownload = settings.enableAutoDownloadRecording ? "&autoDownload=1" : "";
  const url = chrome.runtime.getURL(`result/result.html?id=${encodeURIComponent(recordingState.recordingId)}${source}${autoDownload}`);

  for (let attempt = 0; attempt < RESULT_TAB_CREATE_ATTEMPTS; attempt += 1) {
    try {
      const resultTab = await chrome.tabs.create({ url, active: !settings.enableAutoDownloadRecording });
      await chrome.alarms.clear(RESULT_TAB_RETRY_ALARM);
      if (settings.enableAutoDownloadRecording) {
        const latestState = await loadRecordingState();
        if (latestState.status === RECORDING_STATUS.completed && latestState.recordingId === recordingState.recordingId) {
          await saveRecordingState({ ...latestState, resultTabId: resultTab.id });
        }
      } else {
        await saveRecordingState({ status: RECORDING_STATUS.idle });
        await scheduleRecordingDeletion(recordingState.recordingId).catch(() => {});
      }
      return true;
    } catch {
      if (attempt + 1 < RESULT_TAB_CREATE_ATTEMPTS) {
        await delay(RESULT_TAB_RETRY_DELAY_MS * (attempt + 1));
      }
    }
  }

  await chrome.alarms.create(RESULT_TAB_RETRY_ALARM, { delayInMinutes: 0.5 });
  return false;
}

function ensureCompletedRecordingResult(): Promise<boolean> {
  if (resultTabLaunchPromise) {
    return resultTabLaunchPromise;
  }

  resultTabLaunchPromise = openCompletedRecordingResult().finally(() => {
    resultTabLaunchPromise = null;
  });
  return resultTabLaunchPromise;
}

async function handleAutoDownloadHandled(message: AutoDownloadHandledMessage): Promise<MessageResponse> {
  const state = await loadRecordingState();
  if (state.status === RECORDING_STATUS.completed && state.recordingId === message.recordingId) {
    await saveRecordingState({ status: RECORDING_STATUS.idle });
    await scheduleRecordingDeletion(message.recordingId).catch(() => {});
    await chrome.alarms.clear(RESULT_TAB_RETRY_ALARM);
  }
  return ok();
}

async function handleRecordingError(message: RecordingErrorMessage): Promise<MessageResponse> {
  await discardRecordingIfCurrent(message.recordingId);
  return ok();
}

function storeRecordingChunk(message: StoreRecordingChunkMessage): Promise<MessageResponse> {
  const recordingId = message.chunk.recordingId;
  const previousStore = checkpointStores.get(recordingId) ?? Promise.resolve();
  const store = previousStore.catch(() => {}).then(async () => {
    const state = await loadRecordingState();
    if (state.status !== RECORDING_STATUS.recording || state.recordingId !== recordingId) {
      return;
    }

    const blob = decodeRecordingDataUrl(message.chunk.dataUrl, message.chunk.mimeType);
    if (blob.size <= 0) {
      throw new Error("녹화 체크포인트가 비어 있습니다.");
    }

    const latestState = await loadRecordingState();
    if (latestState.status !== RECORDING_STATUS.recording || latestState.recordingId !== recordingId) {
      return;
    }

    const { dataUrl: _dataUrl, ...chunk } = message.chunk;
    await putChunk({ ...chunk, blob });
  });
  checkpointStores.set(recordingId, store);

  return store
    .then(() => ok())
    .catch((error: unknown) => fail(error instanceof Error ? error.message : "녹화 체크포인트를 저장하지 못했습니다."))
    .finally(() => {
      if (checkpointStores.get(recordingId) === store) {
        checkpointStores.delete(recordingId);
      }
    });
}

async function finalizeRecordingFromChunksUnlocked(recordingId: string, endedAt: number): Promise<MessageResponse> {
  const state = await loadRecordingState();
  if (state.status !== RECORDING_STATUS.recording || state.recordingId !== recordingId) {
    return ok();
  }

  await checkpointStores.get(recordingId);
  const chunks = await getChunksByRecordingId(recordingId);
  const first = chunks[0];
  if (!first) {
    return fail("저장된 녹화 데이터가 없습니다.");
  }
  if (chunks.some((chunk, index) => chunk.index !== index + 1 || chunk.mimeType !== first.mimeType)) {
    return fail("저장된 녹화 데이터의 일부가 누락되었습니다.");
  }
  if (chunks.at(-1)?.completesBlob === false) {
    return fail("저장 중이던 녹화 데이터의 일부가 누락되었습니다.");
  }

  const blob = new Blob(chunks.map((chunk) => chunk.blob), { type: first.mimeType });
  if (blob.size <= 0) {
    return fail("녹화 데이터가 비어 있습니다.");
  }

  const lastCapturedAt = chunks.at(-1)?.capturedAt;
  const actualEndedAt = getFinalRecordingEndedAt(first.createdAt, endedAt, lastCapturedAt);
  await putPart({
    id: `${recordingId}:part:001`,
    recordingId,
    index: 1,
    filename: buildDirectFilename(first.baseName, first.extension, first.createdAt, actualEndedAt),
    mimeType: first.mimeType,
    extension: first.extension,
    outputFormat: first.outputFormat,
    size: blob.size,
    blob,
    createdAt: actualEndedAt,
  });

  return await completeRecording({
    id: recordingId,
    createdAt: first.createdAt,
    endedAt: actualEndedAt,
    totalSize: blob.size,
    actualExtension: first.extension,
  });
}

function finalizeRecordingFromChunks(recordingId: string, endedAt: number): Promise<MessageResponse> {
  return runRecordingTerminalOperation(recordingId, () => finalizeRecordingFromChunksUnlocked(recordingId, endedAt));
}

async function recoverRecording(recordingId: string, endedAt: number): Promise<boolean> {
  return await runRecordingTerminalOperation(recordingId, async () => {
    for (let attempt = 0; attempt < RECOVERY_FINALIZE_ATTEMPTS; attempt += 1) {
      try {
        await finalizeRecordingFromChunksUnlocked(recordingId, endedAt);
      } catch {
        // A late checkpoint or a transient IndexedDB failure may succeed on retry.
      }

      const state = await loadRecordingState();
      if (state.status === RECORDING_STATUS.completed && state.recordingId === recordingId) {
        return true;
      }
      if (state.status !== RECORDING_STATUS.recording || state.recordingId !== recordingId) {
        return false;
      }
      if (attempt + 1 < RECOVERY_FINALIZE_ATTEMPTS) {
        await delay(CHECKPOINT_FINALIZE_DELAY_MS);
      }
    }

    await discardRecordingIfCurrentUnlocked(recordingId);
    return false;
  });
}

async function recoverRecordingAfterTabExit(tabId: number): Promise<void> {
  const state = await loadRecordingState();
  if (state.status !== RECORDING_STATUS.recording || state.tabId !== tabId || !state.recordingId) {
    return;
  }

  await delay(CHECKPOINT_FINALIZE_DELAY_MS);
  await recoverRecording(state.recordingId, Date.now());
}

async function recoverResultAfterTabExit(tabId: number, isWindowClosing: boolean): Promise<void> {
  const state = await loadRecordingState();
  if (state.status !== RECORDING_STATUS.completed || state.resultTabId !== tabId) {
    return;
  }

  await saveRecordingState({ ...state, resultTabId: undefined });
  if (!isWindowClosing) {
    await ensureCompletedRecordingResult();
  }
}

async function recoverInterruptedRecording(): Promise<void> {
  const state = await loadRecordingState();
  if (state.status === RECORDING_STATUS.completed) {
    await ensureCompletedRecordingResult();
    return;
  }
  if (state.status !== RECORDING_STATUS.recording || !state.recordingId) {
    return;
  }

  await recoverRecording(state.recordingId, Date.now());
}

chrome.runtime.onInstalled.addListener(() => {
  void recoverInterruptedRecording().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  void recoverInterruptedRecording().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESULT_TAB_RETRY_ALARM) {
    void ensureCompletedRecordingResult().catch(() => {});
    return;
  }
  if (!alarm.name.startsWith(DELETE_ALARM_PREFIX)) {
    return;
  }

  const recordingId = alarm.name.slice(DELETE_ALARM_PREFIX.length);
  void deleteRecordingNow(recordingId).catch(() => {
    void chrome.alarms.create(getDeleteAlarmName(recordingId), { delayInMinutes: DELETE_RETRY_MINUTES }).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void recoverRecordingAfterTabExit(tabId).catch(() => {});
  void recoverResultAfterTabExit(tabId, removeInfo.isWindowClosing).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    void recoverRecordingAfterTabExit(tabId).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message: PopupCommand | RecordingErrorMessage | StoreRecordingChunkMessage | FinalizeRecordingMessage | DeletionScheduleRequest | AutoDownloadHandledMessage, _sender, sendResponse: (response: MessageResponse<unknown>) => void) => {
  void (async () => {
    if (message.type === "SELECT_REGION") {
      sendResponse(await startSelection());
      return;
    }

    if (message.type === "CLEAR_REGION") {
      sendResponse(await clearRegion());
      return;
    }

    if (message.type === "START_RECORDING") {
      sendResponse(await startRecording());
      return;
    }

    if (message.type === "START_FULL_RECORDING") {
      sendResponse(await startRecording(true));
      return;
    }

    if (message.type === "CAPTURE_FULL_SCREENSHOT") {
      sendResponse(await captureFullScreenshot());
      return;
    }

    if (message.type === "STOP_RECORDING") {
      sendResponse(await stopRecording());
      return;
    }

    if (message.type === "CANCEL_RECORDING") {
      sendResponse(await cancelRecording());
      return;
    }

    if (message.type === "RECORDING_ERROR") {
      sendResponse(await handleRecordingError(message));
      return;
    }

    if (message.type === "STORE_RECORDING_CHUNK") {
      sendResponse(await storeRecordingChunk(message));
      return;
    }

    if (message.type === "FINALIZE_RECORDING") {
      sendResponse(await finalizeRecordingFromChunks(message.recordingId, message.endedAt));
      return;
    }

    if (message.type === "SCHEDULE_RECORDING_DELETION") {
      sendResponse(await scheduleRecordingDeletion(message.recordingId));
      return;
    }

    if (message.type === "AUTO_DOWNLOAD_HANDLED") {
      sendResponse(await handleAutoDownloadHandled(message));
      return;
    }

    sendResponse(fail("지원하지 않는 메시지입니다."));
  })().catch((error: unknown) => {
    sendResponse(fail(error instanceof Error ? error.message : "요청을 처리하지 못했습니다."));
  });

  return true;
});
