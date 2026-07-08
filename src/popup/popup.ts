import { DEFAULT_MULTI_REGION_COUNT, DEFAULT_SEEK_SECONDS, DEFAULT_SETTINGS, DEFAULT_SHORTCUT_KEYS, FPS_WARNING_VIDEO_BITS_PER_SECOND, MAX_MULTI_REGION_COUNT, MAX_SEEK_SECONDS, MAX_VIDEO_BITS_PER_SECOND, MIN_MULTI_REGION_COUNT, MIN_SEEK_SECONDS, MIN_VIDEO_BITS_PER_SECOND, type AppState, type RecordingFormat, type Settings, type ShortcutAction } from "../shared/types.js";
import { loadAppState, normalizeRecordingState, normalizeRegion, normalizeRegions, normalizeSettings, saveSettings } from "../shared/storage.js";
import type { MessageResponse } from "../shared/messages.js";

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
  fpsModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='fps-mode']")),
  multiRegionModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='multi-region-mode']")),
  multiRegionCountRow: document.getElementById("multi-region-count-row") as HTMLDivElement,
  multiRegionCountDecreaseButton: document.getElementById("multi-region-count-decrease-button") as HTMLButtonElement,
  multiRegionCountIncreaseButton: document.getElementById("multi-region-count-increase-button") as HTMLButtonElement,
  multiRegionCountInput: document.getElementById("multi-region-count-input") as HTMLInputElement,
  fullRecordModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='full-record-mode']")),
  fullScreenshotModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='full-screenshot-mode']")),
  seekButtonModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='seek-button-mode']")),
  seekSecondsRow: document.getElementById("seek-seconds-row") as HTMLDivElement,
  seekDecreaseButton: document.getElementById("seek-decrease-button") as HTMLButtonElement,
  seekIncreaseButton: document.getElementById("seek-increase-button") as HTMLButtonElement,
  seekSecondsInput: document.getElementById("seek-seconds-input") as HTMLInputElement,
  streamerFilenameModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='streamer-filename-mode']")),
  shortcutModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='shortcut-mode']")),
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

const BITS_PER_MEGABIT = 1_000_000;
const BITRATE_STEP_MEGABITS_PER_SECOND = 0.5;
const MIN_VIDEO_MEGABITS_PER_SECOND = MIN_VIDEO_BITS_PER_SECOND / BITS_PER_MEGABIT;
const MAX_VIDEO_MEGABITS_PER_SECOND = MAX_VIDEO_BITS_PER_SECOND / BITS_PER_MEGABIT;
const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  selectRegion: "영역 선택",
  clearRegion: "영역 해제",
  regionRecord: "영역 녹화",
  regionScreenshot: "영역 스크린샷",
  fullRecord: "전체 녹화",
  fullScreenshot: "전체 스크린샷",
};

elements.versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;

let appState: AppState = {
  settings: DEFAULT_SETTINGS,
  region: null,
  regions: [],
  recordingState: { status: "idle" },
};

let sendingCommand = false;
let recordingTimerId: number | null = null;
let waitingShortcutAction: ShortcutAction | null = null;

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

function updateRecordingTimer(): void {
  if (appState.recordingState.status !== "recording" || !appState.recordingState.startedAt) {
    elements.recordingTime.textContent = "";
    return;
  }

  elements.recordingTime.textContent = formatElapsed(Date.now() - appState.recordingState.startedAt);
}

function syncRecordingTimer(): void {
  if (recordingTimerId !== null) {
    window.clearInterval(recordingTimerId);
    recordingTimerId = null;
  }

  if (appState.recordingState.status !== "recording" || !appState.recordingState.startedAt) {
    elements.recordingTime.textContent = "";
    return;
  }

  updateRecordingTimer();
  recordingTimerId = window.setInterval(updateRecordingTimer, 1000);
}

function showError(message = ""): void {
  if (message) {
    window.alert(message);
  }
}

function showFpsWarning(settings: Settings): void {
  if (settings.enable60fps && settings.videoBitsPerSecond < FPS_WARNING_VIDEO_BITS_PER_SECOND) {
    elements.fpsWarning.textContent = "60fps는 높음 / 4 Mbps 이상을 권장합니다.";
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
  const outputFormat = settings.outputFormat === "mp4" ? "mp4" : "webm";
  for (const input of elements.outputFormatInputs) {
    input.checked = input.value === outputFormat;
  }
  for (const input of elements.fpsModeInputs) {
    input.checked = input.value === (settings.enable60fps ? "on" : "off");
  }
  for (const input of elements.multiRegionModeInputs) {
    input.checked = input.value === (settings.enableMultiRegion ? "on" : "off");
  }
  elements.multiRegionCountRow.hidden = !settings.enableMultiRegion;
  elements.multiRegionCountInput.value = String(settings.multiRegionMaxCount);
  for (const input of elements.fullRecordModeInputs) {
    input.checked = input.value === (settings.enableFullRecordButton ? "on" : "off");
  }
  for (const input of elements.fullScreenshotModeInputs) {
    input.checked = input.value === (settings.enableFullScreenshotButton ? "on" : "off");
  }
  for (const input of elements.seekButtonModeInputs) {
    input.checked = input.value === (settings.enableSeek ? "on" : "off");
  }
  elements.seekSecondsRow.hidden = !settings.enableSeek;
  elements.seekSecondsInput.value = String(settings.seekSeconds);
  for (const input of elements.streamerFilenameModeInputs) {
    input.checked = input.value === (settings.enableStreamerFilename ? "on" : "off");
  }
  for (const input of elements.shortcutModeInputs) {
    input.checked = input.value === (settings.enableShortcuts ? "on" : "off");
  }
  elements.customVideoBitrateInput.value = formatBitrateMbps(settings.videoBitsPerSecond / BITS_PER_MEGABIT);
  renderShortcutList();
  showFpsWarning(settings);
}

function renderState(): void {
  const isRecording = appState.recordingState.status === "recording";
  const isFullRecording = appState.recordingState.status === "recording" && appState.recordingState.mode === "full";
  const isRegionRecording = isRecording && !isFullRecording;
  elements.selectRegionButton.disabled = isRecording || sendingCommand;
  elements.clearRegionButton.disabled = isRecording || sendingCommand || !appState.region;
  elements.recordToggleButton.disabled = sendingCommand || isFullRecording;
  elements.recordToggleButton.textContent = isRegionRecording ? "녹화 정지" : "영역 녹화";
  elements.recordToggleButton.classList.toggle("primary", false);
  elements.recordToggleButton.classList.toggle("secondary", true);
  elements.recordToggleButton.classList.toggle("recording", isRegionRecording);
  elements.fullRecordToggleButton.hidden = !appState.settings.enableFullRecordButton;
  elements.fullScreenshotButton.hidden = !appState.settings.enableFullScreenshotButton;
  elements.fullActionRow.hidden = !appState.settings.enableFullRecordButton && !appState.settings.enableFullScreenshotButton;
  elements.fullRecordToggleButton.disabled = sendingCommand || (isRecording && !isFullRecording);
  elements.fullScreenshotButton.disabled = sendingCommand;
  elements.fullRecordToggleButton.textContent = isFullRecording ? "전체 녹화 정지" : "전체 녹화";
  elements.shortcutSettingsButton.disabled = isRecording || sendingCommand;
  elements.resetSettingsButton.disabled = isRecording || sendingCommand;

  const lockControls = isRecording;
  const controls = [
    ...elements.outputFormatInputs,
    ...elements.fpsModeInputs,
    ...elements.multiRegionModeInputs,
    elements.multiRegionCountDecreaseButton,
    elements.multiRegionCountIncreaseButton,
    elements.multiRegionCountInput,
    ...elements.fullRecordModeInputs,
    ...elements.fullScreenshotModeInputs,
    ...elements.seekButtonModeInputs,
    elements.seekDecreaseButton,
    elements.seekIncreaseButton,
    elements.seekSecondsInput,
    ...elements.streamerFilenameModeInputs,
    ...elements.shortcutModeInputs,
    elements.bitrateDecreaseButton,
    elements.bitrateIncreaseButton,
    elements.customVideoBitrateInput,
  ];

  for (const control of controls) {
    control.disabled = lockControls;
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

async function stepSeekSeconds(direction: -1 | 1): Promise<void> {
  const current = Number(elements.seekSecondsInput.value || DEFAULT_SEEK_SECONDS);
  const next = Math.min(MAX_SEEK_SECONDS, Math.max(MIN_SEEK_SECONDS, (Number.isFinite(current) ? current : DEFAULT_SEEK_SECONDS) + direction));
  elements.seekSecondsInput.value = String(next);
  await persistUiSettings();
}

async function stepMultiRegionCount(direction: -1 | 1): Promise<void> {
  const current = Number(elements.multiRegionCountInput.value || DEFAULT_MULTI_REGION_COUNT);
  const next = Math.min(MAX_MULTI_REGION_COUNT, Math.max(MIN_MULTI_REGION_COUNT, (Number.isFinite(current) ? current : DEFAULT_MULTI_REGION_COUNT) + direction));
  elements.multiRegionCountInput.value = String(next);
  await persistUiSettings();
}

async function sendCommand<T = undefined>(message: { type: string }): Promise<MessageResponse<T>> {
  return (await chrome.runtime.sendMessage(message)) as MessageResponse<T>;
}

async function refreshAppState(): Promise<void> {
  appState = await loadAppState();
  syncPresetUi(appState.settings);
  syncRecordingTimer();
  renderState();
}

function readSettingsFromUi(): Settings {
  const outputFormat = (elements.outputFormatInputs.find((input) => input.checked)?.value ?? DEFAULT_SETTINGS.outputFormat) as RecordingFormat;
  const enable60fps = elements.fpsModeInputs.find((input) => input.checked)?.value === "on";
  const enableMultiRegion = elements.multiRegionModeInputs.find((input) => input.checked)?.value === "on";
  const multiRegionMaxCount = Number(elements.multiRegionCountInput.value || DEFAULT_MULTI_REGION_COUNT);
  const enableFullRecordButton = elements.fullRecordModeInputs.find((input) => input.checked)?.value !== "off";
  const enableFullScreenshotButton = elements.fullScreenshotModeInputs.find((input) => input.checked)?.value !== "off";
  const enableSeek = elements.seekButtonModeInputs.find((input) => input.checked)?.value !== "off";
  const seekSeconds = Number(elements.seekSecondsInput.value || DEFAULT_SEEK_SECONDS);
  const enableStreamerFilename = elements.streamerFilenameModeInputs.find((input) => input.checked)?.value !== "off";
  const enableShortcuts = elements.shortcutModeInputs.find((input) => input.checked)?.value !== "off";
  const fallbackBitrateMbps = (appState.settings.videoBitsPerSecond ?? DEFAULT_SETTINGS.videoBitsPerSecond) / BITS_PER_MEGABIT;
  const videoBitsPerSecond = Math.round(Number(elements.customVideoBitrateInput.value || fallbackBitrateMbps) * BITS_PER_MEGABIT);

  return normalizeSettings({
    outputFormat,
    videoBitsPerSecond,
    enable60fps,
    enableMultiRegion,
    multiRegionMaxCount,
    enableFullRecordButton,
    enableFullScreenshotButton,
    enableSeek,
    seekSeconds,
    enableStreamerFilename,
    enableShortcuts,
    shortcutKeys: appState.settings.shortcutKeys,
  });
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
  elements.multiRegionCountInput.value = String(Math.min(MAX_MULTI_REGION_COUNT, Math.max(MIN_MULTI_REGION_COUNT, Math.round(Number(elements.multiRegionCountInput.value || DEFAULT_MULTI_REGION_COUNT)))));
  const rawSeekSeconds = Number(elements.seekSecondsInput.value || DEFAULT_SEEK_SECONDS);
  elements.seekSecondsInput.value = String(Math.min(MAX_SEEK_SECONDS, Math.max(MIN_SEEK_SECONDS, Math.round(Number.isFinite(rawSeekSeconds) ? rawSeekSeconds : DEFAULT_SEEK_SECONDS))));
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

async function withCommandInFlight<T>(command: () => Promise<T>): Promise<T> {
  sendingCommand = true;
  renderState();
  try {
    return await command();
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
    if (appState.recordingState.status === "recording") {
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
    const type = appState.recordingState.status === "recording" && appState.recordingState.mode === "full" ? "STOP_RECORDING" : "START_FULL_RECORDING";
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

for (const element of [...elements.outputFormatInputs, ...elements.fpsModeInputs, ...elements.multiRegionModeInputs, ...elements.fullRecordModeInputs, ...elements.fullScreenshotModeInputs, ...elements.seekButtonModeInputs, ...elements.streamerFilenameModeInputs, ...elements.shortcutModeInputs]) {
  element.addEventListener("change", () => {
    void persistUiSettings();
  });
}

elements.customVideoBitrateInput.addEventListener("input", () => {
  void persistBitrateInput();
});

elements.customVideoBitrateInput.addEventListener("change", () => {
  void persistUiSettings();
});

elements.seekSecondsInput.addEventListener("change", () => {
  void persistUiSettings();
});

elements.multiRegionCountInput.addEventListener("change", () => {
  void persistUiSettings();
});

elements.bitrateDecreaseButton.addEventListener("click", () => {
  void stepBitrate(-1);
});

elements.bitrateIncreaseButton.addEventListener("click", () => {
  void stepBitrate(1);
});

elements.seekDecreaseButton.addEventListener("click", () => {
  void stepSeekSeconds(-1);
});

elements.seekIncreaseButton.addEventListener("click", () => {
  void stepSeekSeconds(1);
});

elements.multiRegionCountDecreaseButton.addEventListener("click", () => {
  void stepMultiRegionCount(-1);
});

elements.multiRegionCountIncreaseButton.addEventListener("click", () => {
  void stepMultiRegionCount(1);
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
  event.preventDefault();
});

elements.shortcutDialog.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (!waitingShortcutAction || event.key === "Escape") {
    event.preventDefault();
    return;
  }

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
    appState.settings = normalizeSettings(changes.settings.newValue as Partial<Settings> | undefined);
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
  }

  renderState();
});

void refreshAppState();
