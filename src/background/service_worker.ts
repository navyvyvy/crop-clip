import { deleteRecording, putPart, putRecording } from "../shared/idb.js";
import { fail, ok, type ContentCommand, type DeletionCancelRequest, type DeletionScheduleRequest, type MessageResponse, type PopupCommand, type RecordingErrorMessage, type RecordingFinishedMessage, type StoreRecordingPartMessage } from "../shared/messages.js";
import { loadAppState, loadRecordingState, patchRecordingState, saveRecordingState } from "../shared/storage.js";
import type { RegionSelection, Settings } from "../shared/types.js";
const DELETE_AFTER_MINUTES = 10;
const DELETE_ALARM_PREFIX = "delete-recording:";

async function sendToTab<T = undefined>(tabId: number, message: Record<string, unknown>): Promise<T | undefined> {
  return await new Promise<T | undefined>((resolve, reject) => {
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

async function scheduleRecordingDeletion(recordingId: string): Promise<MessageResponse> {
  await chrome.alarms.create(getDeleteAlarmName(recordingId), {
    delayInMinutes: DELETE_AFTER_MINUTES,
  });
  return ok();
}

async function cancelRecordingDeletion(recordingId: string): Promise<MessageResponse> {
  await chrome.alarms.clear(getDeleteAlarmName(recordingId));
  return ok();
}

async function deleteRecordingNow(recordingId: string): Promise<void> {
  await chrome.alarms.clear(getDeleteAlarmName(recordingId));
  await deleteRecording(recordingId);
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

async function queryPlayerStatus(tabId: number): Promise<{ ok: true; data: { muted: boolean; volume: number } } | { ok: false; error: string }> {
  try {
    const response = await sendToTab<{ ok: true; data: { muted: boolean; volume: number } } | { ok: false; error: string }>(tabId, { type: "GET_PLAYER_STATUS" });
    if (!response) {
      return { ok: false, error: "재생 상태를 확인할 수 없습니다." };
    }

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "재생 상태를 확인할 수 없습니다.";
    return { ok: false, error: message };
  }
}

async function sendCommandToContentScript<T = undefined>(tabId: number, message: ContentCommand): Promise<MessageResponse<T>> {
  const sendMessage = async (): Promise<MessageResponse<T>> => {
    return await new Promise<MessageResponse<T>>((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }

        resolve((response as MessageResponse<T>) ?? ok());
      });
    });
  };

  try {
    return await sendMessage();
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/region_selector.js"],
      });
      return await sendMessage();
    } catch (fallbackError) {
      const message =
        fallbackError instanceof Error
          ? fallbackError.message
          : error instanceof Error
            ? error.message
            : "현재 탭에서 명령을 실행할 수 없습니다.";
      return fail(message);
    }
  }
}

async function startSelection(): Promise<MessageResponse> {
  const state = await loadAppState();
  if (state.recordingState.status === "recording") {
    return fail("녹화 중에는 영역을 다시 선택할 수 없습니다.");
  }

  const tab = await getActiveRecordableTab();
  const tabId = tab.id;
  if (typeof tabId !== "number") {
    return fail("녹화할 수 있는 웹 탭에서만 사용할 수 있습니다.");
  }

  const sendSelectionMessage = async (): Promise<MessageResponse> => {
    return await sendCommandToContentScript(tabId, { type: "START_SELECTION" });
  };

  return await sendSelectionMessage();
}

async function clearRegion(): Promise<MessageResponse> {
  const state = await loadAppState();
  if (state.recordingState.status === "recording") {
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

async function cancelDirectRecording(tabId: number): Promise<MessageResponse> {
  return await sendCommandToContentScript(tabId, { type: "CANCEL_DIRECT_RECORDING" });
}

async function startRecording(fullPlayer = false): Promise<MessageResponse<{ recordingId: string }>> {
  const tab = await getActiveRecordableTab();
  const tabId = tab.id;
  if (typeof tabId !== "number") {
    return fail("녹화할 수 있는 웹 탭에서만 사용할 수 있습니다.");
  }
  const state = await loadAppState();
  const storedRegion = state.region;

  if (!fullPlayer && !storedRegion) {
    return fail("먼저 녹화 영역을 선택하세요.");
  }

  if (state.recordingState.status === "recording") {
    return fail("이미 녹화가 진행 중입니다.");
  }

  const settings = state.settings;
  const recordingId = crypto.randomUUID();

  await saveRecordingState({
    status: "recording",
    recordingId,
    tabId,
    startedAt: Date.now(),
    mode: fullPlayer ? "full" : "region",
    requestedOutputFormat: settings.outputFormat,
  });

  try {
    const playerStatus = await queryPlayerStatus(tabId);
    if (!playerStatus.ok) {
      await patchRecordingState({
        status: "error",
        recordingId,
        tabId,
        lastError: playerStatus.error,
      });
      return fail(playerStatus.error);
    }

    if (playerStatus.data.muted || playerStatus.data.volume === 0) {
      const error = "현재 탭의 영상이 음소거되어 있어 녹화할 수 없습니다.";
      await patchRecordingState({
        status: "error",
        recordingId,
        tabId,
        lastError: error,
      });
      return fail(error);
    }

    const regionResponse = fullPlayer
      ? await getPlayerRegionGeometry(tabId)
      : settings.enableMultiRegion
        ? await getCurrentRegionGeometries(tabId)
        : await getCurrentRegionGeometry(tabId);
    if (!regionResponse.ok || !regionResponse.data) {
      const error = regionResponse.ok ? "녹화할 비디오 영역을 찾지 못했습니다." : regionResponse.error;
      await patchRecordingState({
        status: "error",
        recordingId,
        tabId,
        lastError: error,
      });
      return fail(error);
    }

    const regions = Array.isArray(regionResponse.data) ? regionResponse.data : [regionResponse.data];
    if (!regions[0]) {
      const error = "녹화할 비디오 영역을 찾지 못했습니다.";
      await patchRecordingState({
        status: "error",
        recordingId,
        tabId,
        lastError: error,
      });
      return fail(error);
    }
    const response = await startDirectRecording(tabId, recordingId, regions[0], settings, settings.enableMultiRegion ? regions : undefined);
    if (!response.ok) {
      await patchRecordingState({
        status: "error",
        recordingId,
        tabId,
        lastError: response.error,
      });
      return response;
    }

    return ok({ recordingId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "녹화를 시작할 수 없습니다.";
    await patchRecordingState({
      status: "error",
      recordingId,
      tabId,
      lastError: message,
    });
    return fail(message);
  }
}

async function stopRecording(): Promise<MessageResponse> {
  const state = await loadRecordingState();
  if (state.status !== "recording") {
    return fail("진행 중인 녹화가 없습니다.");
  }

  if (typeof state.tabId !== "number") {
    return fail("녹화 중인 탭을 찾지 못했습니다.");
  }

  return await stopDirectRecording(state.tabId);
}

async function cancelRecording(): Promise<MessageResponse> {
  const state = await loadRecordingState();
  if (state.status !== "recording") {
    return fail("진행 중인 녹화가 없습니다.");
  }

  if (typeof state.tabId !== "number") {
    return fail("녹화 중인 탭을 찾지 못했습니다.");
  }

  const response = await cancelDirectRecording(state.tabId);
  if (!response.ok) {
    return response;
  }

  await saveRecordingState({ status: "idle" });
  return ok();
}


async function handleRecordingFinished(message: RecordingFinishedMessage): Promise<MessageResponse> {
  const previousState = await loadRecordingState();

  await putRecording(message.recording);
  await saveRecordingState({
    status: "completed",
    recordingId: message.recording.id,
    tabId: undefined,
    startedAt: message.recording.createdAt,
    endedAt: message.recording.endedAt,
    requestedOutputFormat: message.recording.requestedOutputFormat,
    actualOutputFormat: message.recording.actualOutputFormat,
    actualMimeType: message.recording.actualMimeType,
    actualExtension: message.recording.actualExtension,
  });

  if (previousState.status === "recording") {
    const source = typeof previousState.tabId === "number" ? `&sourceTabId=${previousState.tabId}` : "";
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`result/result.html?id=${encodeURIComponent(message.recording.id)}${source}`),
    });
  }

  return ok();
}

async function handleRecordingError(message: RecordingErrorMessage): Promise<MessageResponse> {
  await patchRecordingState({
    status: "error",
    recordingId: message.recordingId,
    lastError: message.error,
  });

  return ok();
}

async function storeRecordingPart(message: StoreRecordingPartMessage): Promise<MessageResponse> {
  await putPart(message.part);
  return ok();
}

chrome.runtime.onInstalled.addListener(() => {
  void loadAppState();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(DELETE_ALARM_PREFIX)) {
    return;
  }

  const recordingId = alarm.name.slice(DELETE_ALARM_PREFIX.length);
  void deleteRecordingNow(recordingId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const state = await loadRecordingState();
    if (state.status === "recording" && state.tabId === tabId) {
      await patchRecordingState({
        status: "error",
        recordingId: state.recordingId,
        tabId,
        lastError: "녹화 중인 탭이 닫혔습니다.",
      });
    }
  })();
});

chrome.runtime.onMessage.addListener((message: PopupCommand | RecordingFinishedMessage | RecordingErrorMessage | StoreRecordingPartMessage | DeletionScheduleRequest | DeletionCancelRequest, _sender, sendResponse: (response: MessageResponse<any>) => void) => {
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

    if (message.type === "RECORDING_FINISHED") {
      sendResponse(await handleRecordingFinished(message));
      return;
    }

    if (message.type === "RECORDING_ERROR") {
      sendResponse(await handleRecordingError(message));
      return;
    }

    if (message.type === "STORE_RECORDING_PART") {
      sendResponse(await storeRecordingPart(message));
      return;
    }

    if (message.type === "SCHEDULE_RECORDING_DELETION") {
      sendResponse(await scheduleRecordingDeletion(message.recordingId));
      return;
    }

    if (message.type === "CANCEL_RECORDING_DELETION") {
      sendResponse(await cancelRecordingDeletion(message.recordingId));
      return;
    }

    sendResponse(fail("지원하지 않는 메시지입니다."));
  })();

  return true;
});
