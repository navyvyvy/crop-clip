import { DEFAULT_MULTI_REGION_COUNT, DEFAULT_SEEK_SECONDS, DEFAULT_SETTINGS, DEFAULT_SHORTCUT_KEYS, FPS_WARNING_VIDEO_BITS_PER_SECOND, MAX_MULTI_REGION_COUNT, MAX_SEEK_SECONDS, MAX_VIDEO_BITS_PER_SECOND, MIN_MULTI_REGION_COUNT, MIN_SEEK_SECONDS, MIN_VIDEO_BITS_PER_SECOND, RECORDING_MODE, RECORDING_STATUS, type AppState, type Settings, type ShortcutAction } from "../shared/types.js";
import { loadAppState, saveSettings } from "../shared/storage.js";
import { normalizeRecordingState, normalizeRegion, normalizeRegions, normalizeSettings } from "../shared/normalize.js";
import type { ContentCommand, MessageResponse, PopupCommand } from "../shared/messages.js";
import { formatRecordingTimer, MILLISECONDS_PER_SECOND } from "../shared/time_range.js";

const elements = {
  versionBadge: document.getElementById("version-badge") as HTMLSpanElement,
  recordingTime: document.getElementById("recording-time") as HTMLParagraphElement,
  selectRegionButton: document.getElementById("select-region-button") as HTMLButtonElement,
  clearRegionButton: document.getElementById("clear-region-button") as HTMLButtonElement,
  recordToggleButton: document.getElementById("record-toggle-button") as HTMLButtonElement,
  fullActionRow: document.getElementById("full-action-row") as HTMLDivElement,
  fullRecordToggleButton: document.getElementById("full-record-toggle-button") as HTMLButtonElement,
  fullScreenshotButton: document.getElementById("full-screenshot-button") as HTMLButtonElement,
  outputFormatInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='output-format']")),
  multiRegionCountRow: document.getElementById("multi-region-count-row") as HTMLDivElement,
  multiRegionCountDecreaseButton: document.getElementById("multi-region-count-decrease-button") as HTMLButtonElement,
  multiRegionCountIncreaseButton: document.getElementById("multi-region-count-increase-button") as HTMLButtonElement,
  multiRegionCountInput: document.getElementById("multi-region-count-input") as HTMLInputElement,
  seekSecondsRow: document.getElementById("seek-seconds-row") as HTMLDivElement,
  seekDecreaseButton: document.getElementById("seek-decrease-button") as HTMLButtonElement,
  seekIncreaseButton: document.getElementById("seek-increase-button") as HTMLButtonElement,
  seekSecondsInput: document.getElementById("seek-seconds-input") as HTMLInputElement,
  bitrateDecreaseButton: document.getElementById("bitrate-decrease-button") as HTMLButtonElement,
  bitrateIncreaseButton: document.getElementById("bitrate-increase-button") as HTMLButtonElement,
  customVideoBitrateInput: document.getElementById("custom-video-bitrate-input") as HTMLInputElement,
  fpsWarning: document.getElementById("fps-warning") as HTMLParagraphElement,
  shortcutSettingsButton: document.getElementById("shortcut-settings-button") as HTMLButtonElement,
  resetSettingsButton: document.getElementById("reset-settings-button") as HTMLButtonElement,
  shortcutDialog: document.getElementById("shortcut-dialog") as HTMLDialogElement,
  shortcutList: document.getElementById("shortcut-list") as HTMLDivElement,
  shortcutResetButton: document.getElementById("shortcut-reset-button") as HTMLButtonElement,
  shortcutCloseButton: document.getElementById("shortcut-close-button") as HTMLButtonElement,
};

type ToggleSetting = { [Key in keyof Settings]: Settings[Key] extends boolean ? Key : never }[keyof Settings];

const toggleInputNames = {
  enableOriginalStreamRecording: "original-stream-mode",
  showRecordingSize: "recording-size-mode",
  enable60fps: "fps-mode",
  allowMutedRecording: "muted-recording-mode",
  enableMultiRegion: "multi-region-mode",
  enableFullRecordButton: "full-record-mode",
  enableFullScreenshotButton: "full-screenshot-mode",
  enableSeek: "seek-button-mode",
  enableStreamerFilename: "streamer-filename-mode",
  autoFocusResult: "auto-focus-result-mode",
  enableAutoDownloadRecording: "auto-download-recording-mode",
  enableAutoDownloadSplit: "auto-download-split-mode",
  enableShortcuts: "shortcut-mode",
} satisfies Record<ToggleSetting, string>;

const toggleControls = (Object.keys(toggleInputNames) as ToggleSetting[]).map(setting => ({
  setting,
  inputs: Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${toggleInputNames[setting]}"]`)),
}));

const integerControls = [
  {
    setting: "multiRegionMaxCount",
    enabledBy: "enableMultiRegion",
    row: elements.multiRegionCountRow,
    input: elements.multiRegionCountInput,
    decrease: elements.multiRegionCountDecreaseButton,
    increase: elements.multiRegionCountIncreaseButton,
    min: MIN_MULTI_REGION_COUNT,
    max: MAX_MULTI_REGION_COUNT,
    fallback: DEFAULT_MULTI_REGION_COUNT,
  },
  {
    setting: "seekSeconds",
    enabledBy: "enableSeek",
    row: elements.seekSecondsRow,
    input: elements.seekSecondsInput,
    decrease: elements.seekDecreaseButton,
    increase: elements.seekIncreaseButton,
    min: MIN_SEEK_SECONDS,
    max: MAX_SEEK_SECONDS,
    fallback: DEFAULT_SEEK_SECONDS,
  },
] as const;

const controlsLockedDuringRecording = [
  ...elements.outputFormatInputs,
  ...toggleControls.filter(({ setting }) => setting !== "showRecordingSize").flatMap(({ inputs }) => inputs),
  ...integerControls.flatMap(({ input, decrease, increase }) => [input, decrease, increase]),
  elements.bitrateDecreaseButton,
  elements.bitrateIncreaseButton,
  elements.customVideoBitrateInput,
];

const BITS_PER_MEGABIT = 1_000_000;
const BITRATE_STEP_MEGABITS_PER_SECOND = 0.5;
const MIN_VIDEO_MEGABITS_PER_SECOND = MIN_VIDEO_BITS_PER_SECOND / BITS_PER_MEGABIT;
const MAX_VIDEO_MEGABITS_PER_SECOND = MAX_VIDEO_BITS_PER_SECOND / BITS_PER_MEGABIT;

elements.seekSecondsInput.min = String(MIN_SEEK_SECONDS);
elements.seekSecondsInput.max = String(MAX_SEEK_SECONDS);
const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  selectRegion: "영역 선택",
  clearRegion: "영역 해제",
  clearAllRegions: "전체 영역 해제",
  regionRecord: "영역 녹화",
  cancelRecording: "녹화 취소",
  regionScreenshot: "영역 스크린샷",
  fullRecord: "전체 녹화",
  fullScreenshot: "전체 스크린샷",
};

elements.versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;

let appState: AppState = {
  settings: DEFAULT_SETTINGS,
  region: null,
  regions: [],
  recordingState: { status: RECORDING_STATUS.idle },
};

let sendingCommand = false;
let recordingTimerId: number | null = null;
let recordingSize: { recordingId: string; bytes?: number; pending: boolean } | undefined;
let waitingShortcutAction: ShortcutAction | null = null;

function updateRecordingTimer(): void {
  const { status, startedAt, recordingId, tabId } = appState.recordingState;
  if (status !== RECORDING_STATUS.recording || !startedAt) {
    elements.recordingTime.textContent = status === RECORDING_STATUS.recording ? "시작 중" : "";
    return;
  }

  if (!appState.settings.showRecordingSize || !recordingId || tabId === undefined) {
    recordingSize = undefined;
    elements.recordingTime.textContent = formatRecordingTimer(Date.now() - startedAt);
    return;
  }

  if (recordingSize?.recordingId !== recordingId) recordingSize = { recordingId, pending: false };
  const sample = recordingSize;
  const render = () => {
    const text = formatRecordingTimer(Date.now() - startedAt, sample.bytes);
    if (elements.recordingTime.textContent !== text) elements.recordingTime.textContent = text;
  };
  render();
  if (sample.pending) return;

  sample.pending = true;
  void chrome.tabs.sendMessage(tabId, { type: "GET_RECORDING_SIZE", recordingId } satisfies ContentCommand)
    .then((response: MessageResponse<number> | undefined) => {
      if (response?.ok && response.data !== undefined) {
        sample.bytes = response.data;
        if (recordingSize === sample) render();
      }
    }).catch(() => {
      // The recording tab can close between reading its state and requesting its size.
    }).finally(() => { sample.pending = false; });
}

function syncRecordingTimer(): void {
  if (recordingTimerId !== null) {
    window.clearInterval(recordingTimerId);
    recordingTimerId = null;
  }

  if (appState.recordingState.status !== RECORDING_STATUS.recording || !appState.recordingState.startedAt) {
    recordingSize = undefined;
    updateRecordingTimer();
    return;
  }

  updateRecordingTimer();
  recordingTimerId = window.setInterval(updateRecordingTimer, MILLISECONDS_PER_SECOND);
}

function showError(message = ""): void {
  if (message) {
    window.alert(message);
  }
}

function showFpsWarning(settings: Settings): void {
  if (settings.enable60fps && settings.videoBitsPerSecond < FPS_WARNING_VIDEO_BITS_PER_SECOND) {
    elements.fpsWarning.textContent = `60fps는 높음 / ${formatBitrateMbps(FPS_WARNING_VIDEO_BITS_PER_SECOND / BITS_PER_MEGABIT)} Mbps 이상을 권장합니다.`;
    return;
  }

  elements.fpsWarning.textContent = "";
}

function showBitrateRangeWarning(): void {
  elements.fpsWarning.textContent = `비트레이트는 ${MIN_VIDEO_MEGABITS_PER_SECOND} ~ ${MAX_VIDEO_MEGABITS_PER_SECOND} Mbps 사이로 입력해 주세요.`;
}

function formatBitrateMbps(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}

function syncPresetUi(settings: Settings): void {
  for (const input of elements.outputFormatInputs) {
    input.checked = input.value === settings.outputFormat;
  }
  for (const { setting, inputs } of toggleControls) {
    for (const input of inputs) {
      input.checked = input.value === (settings[setting] ? "on" : "off");
    }
  }
  for (const { setting, enabledBy, row, input } of integerControls) {
    row.hidden = !settings[enabledBy];
    input.value = String(settings[setting]);
  }
  elements.customVideoBitrateInput.value = formatBitrateMbps(settings.videoBitsPerSecond / BITS_PER_MEGABIT);
  renderShortcutList();
  showFpsWarning(settings);
}

function renderState(): void {
  const isRecording = appState.recordingState.status === RECORDING_STATUS.recording;
  const isFullRecording = isRecording && appState.recordingState.mode === RECORDING_MODE.full;
  const isRegionRecording = isRecording && !isFullRecording;
  elements.selectRegionButton.disabled = isRecording || sendingCommand;
  elements.clearRegionButton.disabled = isRegionRecording || sendingCommand || !appState.region;
  elements.recordToggleButton.disabled = sendingCommand || isFullRecording;
  elements.recordToggleButton.textContent = isRegionRecording ? "영역 정지" : "영역 녹화";
  elements.recordToggleButton.classList.toggle("primary", false);
  elements.recordToggleButton.classList.toggle("secondary", true);
  elements.recordToggleButton.classList.toggle("recording", isRegionRecording);
  elements.fullRecordToggleButton.hidden = !appState.settings.enableFullRecordButton;
  elements.fullScreenshotButton.hidden = !appState.settings.enableFullScreenshotButton;
  elements.fullActionRow.hidden = !appState.settings.enableFullRecordButton && !appState.settings.enableFullScreenshotButton;
  elements.fullRecordToggleButton.disabled = sendingCommand || (isRecording && !isFullRecording);
  elements.fullScreenshotButton.disabled = sendingCommand;
  elements.fullRecordToggleButton.textContent = isFullRecording ? "전체 정지" : "전체 녹화";
  elements.shortcutSettingsButton.disabled = isRecording || sendingCommand;
  elements.resetSettingsButton.disabled = isRecording || sendingCommand;

  for (const control of controlsLockedDuringRecording) {
    control.disabled = isRecording;
  }
}

async function stepBitrate(direction: -1 | 1): Promise<void> {
  const current = Number(elements.customVideoBitrateInput.value);
  const fallback = appState.settings.videoBitsPerSecond / BITS_PER_MEGABIT;
  const next = Math.min(
    MAX_VIDEO_MEGABITS_PER_SECOND,
    Math.max(
      MIN_VIDEO_MEGABITS_PER_SECOND,
      (Number.isFinite(current) ? current : fallback) + direction * BITRATE_STEP_MEGABITS_PER_SECOND,
    ),
  );

  elements.customVideoBitrateInput.value = formatBitrateMbps(next);
  await persistUiSettings();
}

function readIntegerControl({ input, min, max, fallback }: typeof integerControls[number], direction = 0): number {
  const value = Number(input.value || fallback);
  const next = (Number.isFinite(value) ? value : fallback) + direction;
  return Math.min(max, Math.max(min, Math.round(next)));
}

async function sendCommand<T = undefined>(message: PopupCommand): Promise<MessageResponse<T>> {
  const { tabId, recordingId } = appState.recordingState;
  if (message.type === "STOP_RECORDING" && typeof tabId === "number" && recordingId) {
    try {
      const response: MessageResponse<T> | undefined = await chrome.tabs.sendMessage(tabId, { type: "STOP_DIRECT_RECORDING", recordingId });
      if (response?.ok) return response;
    } catch {
      // A closed/reloaded tab still needs the background checkpoint recovery path.
    }
  }
  return (await chrome.runtime.sendMessage(message.type === "STOP_RECORDING" && recordingId
    ? { ...message, recordingId } : message)) as MessageResponse<T>;
}

async function refreshAppState(): Promise<void> {
  appState = await loadAppState();
  syncPresetUi(appState.settings);
  syncRecordingTimer();
  renderState();
}

function readSettingsFromUi(): Settings {
  const fallbackBitrateMbps = appState.settings.videoBitsPerSecond / BITS_PER_MEGABIT;
  const settings = {
    ...appState.settings,
    outputFormat: elements.outputFormatInputs.find(input => input.checked)?.value ?? appState.settings.outputFormat,
    videoBitsPerSecond: Math.round(Number(elements.customVideoBitrateInput.value || fallbackBitrateMbps) * BITS_PER_MEGABIT),
  };
  for (const { setting, inputs } of toggleControls) {
    const selected = inputs.find(input => input.checked);
    if (selected) settings[setting] = selected.value === "on";
  }
  for (const control of integerControls) {
    settings[control.setting] = readIntegerControl(control);
  }
  return normalizeSettings(settings);
}

function renderShortcutList(): void {
  elements.shortcutList.innerHTML = "";
  for (const action of Object.keys(SHORTCUT_LABELS) as ShortcutAction[]) {
    const isWaiting = waitingShortcutAction === action;
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const label = document.createElement("span");
    label.textContent = SHORTCUT_LABELS[action];
    const controls = document.createElement("span");
    controls.className = "shortcut-controls";
    const button = document.createElement("button");
    button.className = "shortcut-key";
    button.type = "button";
    button.dataset.action = action;
    button.dataset.waiting = isWaiting ? "true" : "false";
    button.textContent = isWaiting ? "입력" : appState.settings.shortcutKeys[action].toUpperCase();
    button.title = `${SHORTCUT_LABELS[action]} 단축키 변경`;
    button.addEventListener("click", () => {
      waitingShortcutAction = action;
      renderShortcutList();
      elements.shortcutDialog.focus();
    });
    controls.appendChild(button);
    if (isWaiting) {
      const cancelButton = document.createElement("button");
      cancelButton.className = "shortcut-cancel";
      cancelButton.type = "button";
      cancelButton.textContent = "취소";
      cancelButton.title = "단축키 입력 취소";
      cancelButton.addEventListener("click", () => {
        waitingShortcutAction = null;
        renderShortcutList();
        elements.shortcutDialog.focus();
      });
      controls.appendChild(cancelButton);
    }
    row.append(label, controls);
    elements.shortcutList.appendChild(row);
  }
}

function sanitizeBitrateInput(): void {
  const sanitized = elements.customVideoBitrateInput.value
    .replace(/[^\d.]/g, "")
    .replace(/(\..*)\./g, "$1");
  if (!sanitized) {
    elements.customVideoBitrateInput.value = "";
    return;
  }

  elements.customVideoBitrateInput.value = Number(sanitized) > MAX_VIDEO_MEGABITS_PER_SECOND
    ? String(MAX_VIDEO_MEGABITS_PER_SECOND)
    : sanitized;
}

async function persistUiSettings(): Promise<void> {
  sanitizeBitrateInput();
  if (!elements.customVideoBitrateInput.value) {
    syncPresetUi(appState.settings);
    return;
  }

  const value = Number(elements.customVideoBitrateInput.value);
  if (!Number.isFinite(value) || value < MIN_VIDEO_MEGABITS_PER_SECOND || value > MAX_VIDEO_MEGABITS_PER_SECOND) {
    syncPresetUi(appState.settings);
    showBitrateRangeWarning();
    return;
  }

  const settings = readSettingsFromUi();
  appState.settings = settings;
  await saveSettings(settings);
  syncPresetUi(settings);
  renderState();
}

async function persistBitrateInput(): Promise<void> {
  sanitizeBitrateInput();
  const value = Number(elements.customVideoBitrateInput.value);
  if (!Number.isFinite(value) || value < MIN_VIDEO_MEGABITS_PER_SECOND || value > MAX_VIDEO_MEGABITS_PER_SECOND) {
    return;
  }

  const settings = readSettingsFromUi();
  appState.settings = settings;
  await saveSettings(settings);
  showFpsWarning(settings);
  renderState();
}

async function withCommandInFlight<T>(command: () => Promise<T>): Promise<T | undefined> {
  sendingCommand = true;
  renderState();
  try {
    return await command();
  } catch (error) {
    showError(error instanceof Error ? error.message : "요청을 처리하지 못했습니다.");
    return undefined;
  } finally {
    sendingCommand = false;
    renderState();
  }
}

elements.selectRegionButton.addEventListener("click", () => {
  void withCommandInFlight(async () => {
    const response = await sendCommand({ type: "SELECT_REGION" });
    if (!response.ok) {
      showError(response.error);
      return;
    }
  });
});

elements.clearRegionButton.addEventListener("click", () => {
  void withCommandInFlight(async () => {
    const response = await sendCommand({ type: "CLEAR_REGION" });
    if (!response.ok) {
      showError(response.error);
      return;
    }
  });
});

elements.recordToggleButton.addEventListener("click", () => {
  void withCommandInFlight(async () => {
    if (appState.recordingState.status === RECORDING_STATUS.recording) {
      const response = await sendCommand({ type: "STOP_RECORDING" });
      if (!response.ok) {
        showError(response.error);
      }
      return;
    }

    const response = await sendCommand<{ recordingId: string }>({ type: "START_RECORDING" });
    if (!response.ok) {
      window.alert(response.error);
      return;
    }

    if (response.data?.recordingId) {
      appState.recordingState.recordingId = response.data.recordingId;
    }
  });
});

elements.fullRecordToggleButton.addEventListener("click", () => {
  void withCommandInFlight(async () => {
    const type = appState.recordingState.status === RECORDING_STATUS.recording && appState.recordingState.mode === RECORDING_MODE.full ? "STOP_RECORDING" : "START_FULL_RECORDING";
    const response = await sendCommand<{ recordingId: string }>({ type });
    if (!response.ok) {
      showError(response.error);
    }
  });
});

elements.fullScreenshotButton.addEventListener("click", () => {
  void withCommandInFlight(async () => {
    const response = await sendCommand({ type: "CAPTURE_FULL_SCREENSHOT" });
    if (!response.ok) {
      showError(response.error);
    }
  });
});

for (const input of [
  ...elements.outputFormatInputs,
  ...toggleControls.flatMap(({ inputs }) => inputs),
  ...integerControls.map(({ input }) => input),
  elements.customVideoBitrateInput,
]) {
  input.addEventListener("change", () => {
    void persistUiSettings();
  });
}

elements.customVideoBitrateInput.addEventListener("input", () => {
  void persistBitrateInput();
});

for (const control of integerControls) {
  control.decrease.addEventListener("click", () => {
    control.input.value = String(readIntegerControl(control, -1));
    void persistUiSettings();
  });
  control.increase.addEventListener("click", () => {
    control.input.value = String(readIntegerControl(control, 1));
    void persistUiSettings();
  });
}

elements.bitrateDecreaseButton.addEventListener("click", () => {
  void stepBitrate(-1);
});

elements.bitrateIncreaseButton.addEventListener("click", () => {
  void stepBitrate(1);
});

elements.shortcutSettingsButton.addEventListener("click", () => {
  waitingShortcutAction = null;
  renderShortcutList();
  elements.shortcutDialog.showModal();
  elements.shortcutDialog.focus();
});

elements.shortcutCloseButton.addEventListener("click", () => {
  waitingShortcutAction = null;
  elements.shortcutDialog.close();
});

elements.shortcutDialog.addEventListener("cancel", (event) => {
  if (!waitingShortcutAction) return;
  event.preventDefault();
  waitingShortcutAction = null;
  renderShortcutList();
  elements.shortcutDialog.focus();
});

elements.shortcutDialog.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (!waitingShortcutAction || event.key === "Escape" || event.key === "Tab") return;
  if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement) return;

  const key = event.key.toLowerCase();
  if (!/^[a-z0-9]$/.test(key) || event.ctrlKey || event.metaKey || event.altKey) {
    event.preventDefault();
    return;
  }

  const used = Object.entries(appState.settings.shortcutKeys).find(([action, value]) => action !== waitingShortcutAction && value === key);
  if (used) {
    window.alert("이미 사용 중인 단축키입니다.");
    event.preventDefault();
    return;
  }

  void (async () => {
    appState.settings = normalizeSettings({
      ...appState.settings,
      shortcutKeys: { ...appState.settings.shortcutKeys, [waitingShortcutAction]: key },
    });
    waitingShortcutAction = null;
    await saveSettings(appState.settings);
    syncPresetUi(appState.settings);
    renderState();
  })();
  event.preventDefault();
});

elements.shortcutResetButton.addEventListener("click", () => {
  void (async () => {
    waitingShortcutAction = null;
    appState.settings = normalizeSettings({ ...appState.settings, shortcutKeys: DEFAULT_SHORTCUT_KEYS });
    await saveSettings(appState.settings);
    syncPresetUi(appState.settings);
    renderState();
  })();
});

elements.resetSettingsButton.addEventListener("click", () => {
  void (async () => {
    if (!window.confirm("CropClip 설정을 전체 초기화할까요?")) {
      return;
    }
    waitingShortcutAction = null;
    appState.settings = normalizeSettings(DEFAULT_SETTINGS);
    await saveSettings(appState.settings);
    syncPresetUi(appState.settings);
    renderState();
  })();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.settings) {
    appState.settings = normalizeSettings(changes.settings.newValue);
    if (document.activeElement !== elements.customVideoBitrateInput) {
      syncPresetUi(appState.settings);
    } else {
      showFpsWarning(appState.settings);
    }
  }

  if (changes.region) {
    appState.region = normalizeRegion(changes.region.newValue ?? null);
  }

  if (changes.regions) {
    appState.regions = normalizeRegions(changes.regions.newValue, appState.region);
  }

  if (changes.recordingState) {
    appState.recordingState = normalizeRecordingState(changes.recordingState.newValue as Partial<AppState["recordingState"]> | undefined);
    syncRecordingTimer();
  } else if (changes.settings) {
    updateRecordingTimer();
  }

  renderState();
});

void refreshAppState();
