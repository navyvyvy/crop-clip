import { BITRATE_PRESET_VALUES, DEFAULT_SETTINGS, MAX_VIDEO_BITS_PER_SECOND, MIN_VIDEO_BITS_PER_SECOND, type AppState, type DownloadFormat, type Settings } from "../shared/types.js";
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
  customVideoBitrateInput: document.getElementById("custom-video-bitrate-input") as HTMLInputElement,
  fpsWarning: document.getElementById("fps-warning") as HTMLParagraphElement,
};

elements.versionBadge.textContent = `v${chrome.runtime.getManifest().version}`;
elements.customVideoBitrateInput.min = String(MIN_VIDEO_BITS_PER_SECOND);
elements.customVideoBitrateInput.max = String(MAX_VIDEO_BITS_PER_SECOND);

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
  if (settings.enable60fps && settings.videoBitsPerSecond <= BITRATE_PRESET_VALUES.standard) {
    elements.fpsWarning.textContent = "60fps는 높음 / 4 Mbps 이상을 권장합니다.";
    return;
  }

  elements.fpsWarning.textContent = "";
}

function syncPresetUi(settings: Settings): void {
  const outputFormat = settings.outputFormat === "mp4" ? "mp4" : "webm";
  for (const input of elements.outputFormatInputs) {
    input.checked = input.value === outputFormat;
  }
  for (const input of elements.fpsModeInputs) {
    input.checked = input.value === (settings.enable60fps ? "on" : "off");
  }
  elements.customVideoBitrateInput.value = String(settings.customVideoBitsPerSecond ?? settings.videoBitsPerSecond);
  showFpsWarning(settings);
}

function renderState(): void {
  const isRecording = appState.recordingState.status === "recording";
  elements.selectRegionButton.disabled = isRecording || sendingCommand;
  elements.clearRegionButton.disabled = isRecording || sendingCommand || !appState.region;
  elements.recordToggleButton.disabled = sendingCommand;
  elements.recordToggleButton.textContent = isRecording ? "녹화 정지" : "녹화 시작";
  elements.recordToggleButton.classList.toggle("primary", false);
  elements.recordToggleButton.classList.toggle("secondary", true);
  elements.recordToggleButton.classList.toggle("recording", isRecording);

  const lockControls = isRecording;
  const controls = [
    ...elements.outputFormatInputs,
    ...elements.fpsModeInputs,
    elements.customVideoBitrateInput,
  ];

  for (const control of controls) {
    control.disabled = lockControls;
  }

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
  const outputFormat = (elements.outputFormatInputs.find((input) => input.checked)?.value ?? DEFAULT_SETTINGS.outputFormat) as DownloadFormat;
  const enable60fps = elements.fpsModeInputs.find((input) => input.checked)?.value === "on";
  const customVideoBitsPerSecond = Math.round(Number(elements.customVideoBitrateInput.value || DEFAULT_SETTINGS.customVideoBitsPerSecond));

  return normalizeSettings({
    outputFormat,
    bitratePreset: "custom",
    videoBitsPerSecond: customVideoBitsPerSecond,
    customVideoBitsPerSecond,
    enable60fps,
    targetHeight: DEFAULT_SETTINGS.targetHeight,
    includeAudio: DEFAULT_SETTINGS.includeAudio,
    autoSplit: DEFAULT_SETTINGS.autoSplit,
    audioGain: DEFAULT_SETTINGS.audioGain,
    audioBitsPerSecond: DEFAULT_SETTINGS.audioBitsPerSecond,
    splitSeconds: DEFAULT_SETTINGS.splitSeconds,
  });
}

async function persistUiSettings(): Promise<void> {
  const settings = readSettingsFromUi();
  appState.settings = settings;
  await saveSettings(settings);
  syncPresetUi(settings);
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

for (const element of [...elements.outputFormatInputs, ...elements.fpsModeInputs]) {
  element.addEventListener("change", () => {
    void persistUiSettings();
  });
}

elements.customVideoBitrateInput.addEventListener("input", () => {
  void persistUiSettings();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.settings) {
    appState.settings = normalizeSettings(changes.settings.newValue as Partial<Settings> | undefined);
    syncPresetUi(appState.settings);
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
