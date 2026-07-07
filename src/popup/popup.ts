import { DEFAULT_SETTINGS, FPS_WARNING_VIDEO_BITS_PER_SECOND, MAX_VIDEO_BITS_PER_SECOND, MIN_VIDEO_BITS_PER_SECOND, type AppState, type RecordingFormat, type Settings } from "../shared/types.js";
import { loadAppState, normalizeRecordingState, normalizeRegion, normalizeSettings, saveSettings } from "../shared/storage.js";
import type { MessageResponse } from "../shared/messages.js";

const elements = {
  versionBadge: document.getElementById("version-badge") as HTMLSpanElement,
  recordingTime: document.getElementById("recording-time") as HTMLParagraphElement,
  selectRegionButton: document.getElementById("select-region-button") as HTMLButtonElement,
  clearRegionButton: document.getElementById("clear-region-button") as HTMLButtonElement,
  recordToggleButton: document.getElementById("record-toggle-button") as HTMLButtonElement,
  outputFormatInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='output-format']")),
  fpsModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='fps-mode']")),
  fullRecordModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='full-record-mode']")),
  fullScreenshotModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='full-screenshot-mode']")),
  streamerFilenameModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='streamer-filename-mode']")),
  shortcutModeInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='shortcut-mode']")),
  bitrateDecreaseButton: document.getElementById("bitrate-decrease-button") as HTMLButtonElement,
  bitrateIncreaseButton: document.getElementById("bitrate-increase-button") as HTMLButtonElement,
  customVideoBitrateInput: document.getElementById("custom-video-bitrate-input") as HTMLInputElement,
  fpsWarning: document.getElementById("fps-warning") as HTMLParagraphElement,
};

const BITS_PER_MEGABIT = 1_000_000;
const BITRATE_STEP_MEGABITS_PER_SECOND = 0.5;
const MIN_VIDEO_MEGABITS_PER_SECOND = MIN_VIDEO_BITS_PER_SECOND / BITS_PER_MEGABIT;
const MAX_VIDEO_MEGABITS_PER_SECOND = MAX_VIDEO_BITS_PER_SECOND / BITS_PER_MEGABIT;

elements.versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;

let appState: AppState = {
  settings: DEFAULT_SETTINGS,
  region: null,
  recordingState: { status: "idle" },
};

let sendingCommand = false;
let recordingTimerId: number | null = null;

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
  for (const input of elements.fullRecordModeInputs) {
    input.checked = input.value === (settings.enableFullRecordButton ? "on" : "off");
  }
  for (const input of elements.fullScreenshotModeInputs) {
    input.checked = input.value === (settings.enableFullScreenshotButton ? "on" : "off");
  }
  for (const input of elements.streamerFilenameModeInputs) {
    input.checked = input.value === (settings.enableStreamerFilename ? "on" : "off");
  }
  for (const input of elements.shortcutModeInputs) {
    input.checked = input.value === (settings.enableShortcuts ? "on" : "off");
  }
  elements.customVideoBitrateInput.value = formatBitrateMbps(settings.videoBitsPerSecond / BITS_PER_MEGABIT);
  showFpsWarning(settings);
}

function renderState(): void {
  const isRecording = appState.recordingState.status === "recording";
  elements.selectRegionButton.disabled = isRecording || sendingCommand;
  elements.clearRegionButton.disabled = isRecording || sendingCommand || !appState.region;
  elements.recordToggleButton.disabled = sendingCommand;
  elements.recordToggleButton.textContent = isRecording ? "녹화 정지" : "영역 녹화";
  elements.recordToggleButton.classList.toggle("primary", false);
  elements.recordToggleButton.classList.toggle("secondary", true);
  elements.recordToggleButton.classList.toggle("recording", isRecording);

  const lockControls = isRecording;
  const controls = [
    ...elements.outputFormatInputs,
    ...elements.fpsModeInputs,
    ...elements.fullRecordModeInputs,
    ...elements.fullScreenshotModeInputs,
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
  const enableFullRecordButton = elements.fullRecordModeInputs.find((input) => input.checked)?.value !== "off";
  const enableFullScreenshotButton = elements.fullScreenshotModeInputs.find((input) => input.checked)?.value !== "off";
  const enableStreamerFilename = elements.streamerFilenameModeInputs.find((input) => input.checked)?.value !== "off";
  const enableShortcuts = elements.shortcutModeInputs.find((input) => input.checked)?.value !== "off";
  const fallbackBitrateMbps = (appState.settings.videoBitsPerSecond ?? DEFAULT_SETTINGS.videoBitsPerSecond) / BITS_PER_MEGABIT;
  const videoBitsPerSecond = Math.round(Number(elements.customVideoBitrateInput.value || fallbackBitrateMbps) * BITS_PER_MEGABIT);

  return normalizeSettings({
    outputFormat,
    videoBitsPerSecond,
    enable60fps,
    enableFullRecordButton,
    enableFullScreenshotButton,
    enableStreamerFilename,
    enableShortcuts,
  });
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

for (const element of [...elements.outputFormatInputs, ...elements.fpsModeInputs, ...elements.fullRecordModeInputs, ...elements.fullScreenshotModeInputs, ...elements.streamerFilenameModeInputs, ...elements.shortcutModeInputs]) {
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

elements.bitrateDecreaseButton.addEventListener("click", () => {
  void stepBitrate(-1);
});

elements.bitrateIncreaseButton.addEventListener("click", () => {
  void stepBitrate(1);
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

  if (changes.recordingState) {
    appState.recordingState = normalizeRecordingState(changes.recordingState.newValue as Partial<AppState["recordingState"]> | undefined);
    syncRecordingTimer();
  }

  renderState();
});

void refreshAppState();
