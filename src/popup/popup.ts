import { DEFAULT_MULTI_REGION_COUNT, DEFAULT_SEEK_SECONDS, DEFAULT_SETTINGS, DEFAULT_SHORTCUT_KEYS, FPS_WARNING_VIDEO_BITS_PER_SECOND, MAX_MULTI_REGION_COUNT, MAX_SEEK_SECONDS, MAX_VIDEO_BITS_PER_SECOND, MIN_MULTI_REGION_COUNT, MIN_SEEK_SECONDS, MIN_VIDEO_BITS_PER_SECOND, RECORDING_FORMAT, RECORDING_MODE, RECORDING_STATUS, type AppState, type AutoSplitMode, type Settings, type ShortcutAction } from "../shared/types.js";
import { loadAppState, updateStoredSettings } from "../shared/storage.js";
import { normalizeAutoSplitMode, normalizeRecordingState, normalizeRegion, normalizeRegions, normalizeSettings } from "../shared/normalize.js";
import { UNSUPPORTED_RUNTIME_MESSAGE, type ContentCommand, type MessageResponse, type PopupCommand, type RuntimeMessage, type SettingsPatch } from "../shared/messages.js";
import { formatRecordingTimer, MILLISECONDS_PER_SECOND } from "../shared/time_range.js";

const elements = {
  versionBadge: document.getElementById("version-badge") as HTMLSpanElement,
  recordingTime: document.getElementById("recording-time") as HTMLParagraphElement,
  popupError: document.getElementById("popup-error") as HTMLParagraphElement,
  selectRegionButton: document.getElementById("select-region-button") as HTMLButtonElement,
  clearRegionButton: document.getElementById("clear-region-button") as HTMLButtonElement,
  recordToggleButton: document.getElementById("record-toggle-button") as HTMLButtonElement,
  fullActionRow: document.getElementById("full-action-row") as HTMLDivElement,
  fullRecordToggleButton: document.getElementById("full-record-toggle-button") as HTMLButtonElement,
  fullScreenshotButton: document.getElementById("full-screenshot-button") as HTMLButtonElement,
  outputFormatInputs: Array.from(document.querySelectorAll<HTMLInputElement>("input[name='output-format']")),
  recordingCodecInputs: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="recording-codec"]')),
  hevcCodecLabel: document.getElementById("recording-codec-hevc") as HTMLLabelElement,
  multiRegionCountDecreaseButton: document.getElementById("multi-region-count-decrease-button") as HTMLButtonElement,
  multiRegionCountIncreaseButton: document.getElementById("multi-region-count-increase-button") as HTMLButtonElement,
  multiRegionCountInput: document.getElementById("multi-region-count-input") as HTMLInputElement,
  autoSplitKinds: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="auto-split-kind"]')),
  autoSplitTimeMode: document.getElementById("auto-split-time-mode") as HTMLSelectElement,
  autoSplitTimePrevious: document.getElementById("auto-split-time-previous") as HTMLButtonElement,
  autoSplitTimeNext: document.getElementById("auto-split-time-next") as HTMLButtonElement,
  autoSplitTimeOptions: document.getElementById("auto-split-time-options") as HTMLDivElement,
  autoSplitSizeOptions: document.getElementById("auto-split-size-options") as HTMLDivElement,
  autoSplitFormats: Array.from(document.querySelectorAll<HTMLInputElement>('input[name="auto-split-format"]')),
  autoSplitThreshold: document.getElementById("auto-split-threshold") as HTMLInputElement,
  autoSplitThresholdDecrease: document.getElementById("auto-split-threshold-decrease") as HTMLButtonElement,
  autoSplitThresholdIncrease: document.getElementById("auto-split-threshold-increase") as HTMLButtonElement,
  autoSplitIntervalRow: document.getElementById("auto-split-interval-row") as HTMLDivElement,
  autoSplitInterval: document.getElementById("auto-split-interval") as HTMLInputElement,
  autoSplitIntervalDecrease: document.getElementById("auto-split-interval-decrease") as HTMLButtonElement,
  autoSplitIntervalIncrease: document.getElementById("auto-split-interval-increase") as HTMLButtonElement,
  autoSplitMaxMegabytes: document.getElementById("auto-split-max-megabytes") as HTMLInputElement,
  autoSplitSizeDecrease: document.getElementById("auto-split-size-decrease") as HTMLButtonElement,
  autoSplitSizeIncrease: document.getElementById("auto-split-size-increase") as HTMLButtonElement,
  seekDecreaseButton: document.getElementById("seek-decrease-button") as HTMLButtonElement,
  seekIncreaseButton: document.getElementById("seek-increase-button") as HTMLButtonElement,
  seekSecondsInput: document.getElementById("seek-seconds-input") as HTMLInputElement,
  bitrateDecreaseButton: document.getElementById("bitrate-decrease-button") as HTMLButtonElement,
  bitrateIncreaseButton: document.getElementById("bitrate-increase-button") as HTMLButtonElement,
  customVideoBitrateInput: document.getElementById("custom-video-bitrate-input") as HTMLInputElement,
  fpsWarning: document.getElementById("fps-warning") as HTMLParagraphElement,
  resetSettingsButton: document.getElementById("reset-settings-button") as HTMLButtonElement,
  shortcutPanel: document.getElementById("shortcut-settings") as HTMLElement,
  shortcutList: document.getElementById("shortcut-list") as HTMLDivElement,
  shortcutResetButton: document.getElementById("shortcut-reset-button") as HTMLButtonElement,
  settingsResetDialog: document.getElementById("settings-reset-dialog") as HTMLDialogElement,
  settingsResetTitle: document.getElementById("settings-reset-title") as HTMLHeadingElement,
  settingsResetDescription: document.getElementById("settings-reset-description") as HTMLParagraphElement,
};

const settingsTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-tabs [role=tab]"), tab => ({
  tab,
  panel: document.getElementById(tab.getAttribute("aria-controls") ?? ""),
}));

function selectSettingsTab(index: number): void {
  if (waitingShortcutAction && settingsTabs[index].panel !== elements.shortcutPanel) {
    waitingShortcutAction = null;
    renderShortcutList();
  }
  settingsTabs.forEach(({ tab, panel }, position) => {
    const selected = position === index;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (panel) panel.hidden = !selected;
  });
  settingsTabs[index].tab.focus();
}

settingsTabs.forEach(({ tab }, index) => {
  tab.addEventListener("click", () => selectSettingsTab(index));
  tab.addEventListener("keydown", event => {
    const last = settingsTabs.length - 1;
    const positions: Record<string, number> = {
      ArrowUp: index === 0 ? last : index - 1,
      ArrowDown: index === last ? 0 : index + 1,
      Home: 0,
      End: last,
    };
    const next = positions[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectSettingsTab(next);
  });
});

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
  enableAutoSplitRecording: "auto-split",
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
    isEnabled: (settings: Settings) => settings.enableMultiRegion,
    input: elements.multiRegionCountInput,
    decrease: elements.multiRegionCountDecreaseButton,
    increase: elements.multiRegionCountIncreaseButton,
    min: MIN_MULTI_REGION_COUNT,
    max: MAX_MULTI_REGION_COUNT,
    fallback: DEFAULT_MULTI_REGION_COUNT,
  },
  {
    setting: "seekSeconds",
    isEnabled: (settings: Settings) => settings.enableSeek,
    input: elements.seekSecondsInput,
    decrease: elements.seekDecreaseButton,
    increase: elements.seekIncreaseButton,
    min: MIN_SEEK_SECONDS,
    max: MAX_SEEK_SECONDS,
    fallback: DEFAULT_SEEK_SECONDS,
  },
  {
    setting: "autoSplitAfterSeconds",
    isEnabled: (settings: Settings) => settings.enableAutoSplitRecording,
    input: elements.autoSplitThreshold,
    decrease: elements.autoSplitThresholdDecrease,
    increase: elements.autoSplitThresholdIncrease,
    min: 1,
    max: Infinity,
    fallback: undefined,
  },
  {
    setting: "autoSplitIntervalSeconds",
    isEnabled: (settings: Settings) => settings.enableAutoSplitRecording,
    input: elements.autoSplitInterval,
    decrease: elements.autoSplitIntervalDecrease,
    increase: elements.autoSplitIntervalIncrease,
    min: 1,
    max: Infinity,
    fallback: undefined,
  },
  {
    setting: "autoSplitMaxMegabytes",
    isEnabled: (settings: Settings) => settings.enableAutoSplitRecording,
    input: elements.autoSplitMaxMegabytes,
    decrease: elements.autoSplitSizeDecrease,
    increase: elements.autoSplitSizeIncrease,
    min: 1,
    max: Infinity,
    fallback: undefined,
  },
] as const;

const controlsLockedDuringRecording = [
  ...elements.outputFormatInputs,
  ...toggleControls.filter(({ setting }) => setting !== "showRecordingSize").flatMap(({ inputs }) => inputs),
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
let storageRevision = 0;
let resetScope: "shortcuts" | "all" = "all";

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
  elements.popupError.textContent = message;
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

type IntegerSetting = typeof integerControls[number]["setting"];
type NumericSetting = IntegerSetting | "videoBitsPerSecond";
type OptimisticSetting = NumericSetting | "autoSplitMode";

const pendingSettings = new Map<OptimisticSetting, { value: Settings[OptimisticSetting] }>();
let lastAutoSplitTimeMode: Exclude<AutoSplitMode, "size"> = "half";

function getVisibleSetting<Key extends OptimisticSetting>(settings: Settings, key: Key, fallback?: Settings[Key]): Settings[Key] {
  return (pendingSettings.get(key)?.value as Settings[Key] | undefined) ?? fallback ?? settings[key];
}

function renderBitrateInput(settings: Settings, editingField: Element | null): void {
  if (elements.customVideoBitrateInput === editingField) return;
  const value = getVisibleSetting(settings, "videoBitsPerSecond");
  elements.customVideoBitrateInput.value = formatBitrateMbps(value / BITS_PER_MEGABIT);
}

function renderAutoSplitMode(): void {
  const mode = getVisibleSetting(appState.settings, "autoSplitMode");
  if (mode !== "size") lastAutoSplitTimeMode = mode;
  for (const input of elements.autoSplitKinds) input.checked = input.value === (mode === "size" ? "size" : "duration");
  elements.autoSplitTimeMode.value = lastAutoSplitTimeMode;
  elements.autoSplitTimeOptions.hidden = mode === "size";
  elements.autoSplitSizeOptions.hidden = mode !== "size";
  elements.autoSplitIntervalRow.hidden = mode !== "duration";
}

function syncPresetUi(settings: Settings, editingField: Element | null = null): void {
  for (const input of elements.outputFormatInputs) {
    input.checked = input.value === settings.outputFormat;
  }
  for (const input of elements.recordingCodecInputs) input.checked = input.value === settings.recordingCodec;
  for (const { setting, inputs } of toggleControls) {
    for (const input of inputs) {
      input.checked = input.value === (settings[setting] ? "on" : "off");
    }
  }
  renderAutoSplitMode();
  for (const input of elements.autoSplitFormats) input.checked = input.value === settings.autoSplitFormat;
  for (const { setting, input } of integerControls) {
    if (input !== editingField) input.value = String(getVisibleSetting(settings, setting));
  }
  renderBitrateInput(settings, editingField);
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
  const showFullRecordButton = appState.settings.enableFullRecordButton || isFullRecording;
  elements.fullRecordToggleButton.hidden = !showFullRecordButton;
  elements.fullScreenshotButton.hidden = !appState.settings.enableFullScreenshotButton;
  elements.fullActionRow.hidden = !showFullRecordButton && !appState.settings.enableFullScreenshotButton;
  elements.fullRecordToggleButton.disabled = sendingCommand || (isRecording && !isFullRecording);
  elements.fullScreenshotButton.disabled = sendingCommand;
  elements.fullRecordToggleButton.textContent = isFullRecording ? "전체 정지" : "전체 녹화";
  const shortcutsLocked = isRecording || sendingCommand;
  if (shortcutsLocked && waitingShortcutAction) {
    waitingShortcutAction = null;
    renderShortcutList();
  }
  elements.shortcutResetButton.disabled = shortcutsLocked;
  for (const button of elements.shortcutList.querySelectorAll("button")) {
    button.disabled = shortcutsLocked;
  }
  elements.resetSettingsButton.disabled = isRecording || sendingCommand;

  for (const control of controlsLockedDuringRecording) {
    control.disabled = isRecording;
  }
  const hevcFormatAvailable = appState.settings.outputFormat === RECORDING_FORMAT.mp4;
  elements.hevcCodecLabel.title = hevcFormatAvailable ? "" : "저장 형식을 MP4로 선택하세요.";
  for (const input of elements.recordingCodecInputs) {
    input.disabled = isRecording || (input.value === "hevc" && !hevcFormatAvailable);
  }
  for (const { isEnabled, input, decrease, increase } of integerControls) {
    input.disabled = decrease.disabled = increase.disabled = isRecording || !isEnabled(appState.settings);
  }
  for (const control of [...elements.autoSplitKinds, ...elements.autoSplitFormats,
    elements.autoSplitTimeMode, elements.autoSplitTimePrevious, elements.autoSplitTimeNext]) {
    control.disabled = isRecording || !appState.settings.enableAutoSplitRecording;
  }
}

async function stepBitrate(direction: -1 | 1): Promise<void> {
  const current = Number(elements.customVideoBitrateInput.value || Number.NaN);
  const fallback = getVisibleSetting(appState.settings, "videoBitsPerSecond") / BITS_PER_MEGABIT;
  const next = Math.min(
    MAX_VIDEO_MEGABITS_PER_SECOND,
    Math.max(
      MIN_VIDEO_MEGABITS_PER_SECOND,
      (Number.isFinite(current) ? current : fallback) + direction * BITRATE_STEP_MEGABITS_PER_SECOND,
    ),
  );

  elements.customVideoBitrateInput.value = formatBitrateMbps(next);
  await saveVideoBitrate(Math.round(next * BITS_PER_MEGABIT));
}

function readIntegerControl({ setting, input, min, max, fallback }: typeof integerControls[number], direction = 0): number {
  const savedValue = getVisibleSetting(appState.settings, setting, fallback);
  const value = Number(input.value || savedValue);
  const next = (Number.isFinite(value) ? value : savedValue) + direction;
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
  let revision: number;
  let state: AppState;
  do {
    revision = storageRevision;
    state = await loadAppState();
  } while (revision !== storageRevision);
  appState = state;
  syncPresetUi(appState.settings, document.activeElement);
  syncRecordingTimer();
  renderState();
}

async function updatePopupSettings(patch: SettingsPatch): Promise<boolean> {
  showError();
  try {
    let response = await chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", patch } satisfies RuntimeMessage) as MessageResponse;
    if (!response.ok && response.error === UNSUPPORTED_RUNTIME_MESSAGE) response = await updateStoredSettings(patch);
    if (!response.ok) throw new Error(response.error);
    return true;
  } catch (error) {
    syncPresetUi(appState.settings, document.activeElement);
    renderState();
    showError(error instanceof Error ? error.message : "설정을 저장하지 못했습니다.");
    return false;
  }
}

async function saveOptimisticSetting<Key extends OptimisticSetting>(key: Key, value: Settings[Key], render: (saved: boolean) => void): Promise<void> {
  if (value === getVisibleSetting(appState.settings, key)) return;
  const edit = { value };
  pendingSettings.set(key, edit);
  render(true);
  const saved = await updatePopupSettings({ [key]: value });
  if (pendingSettings.get(key) === edit && saved && appState.settings[key] !== value) {
    await refreshAppState().catch(() => {});
  }
  if (pendingSettings.get(key) !== edit) return;
  pendingSettings.delete(key);
  render(saved);
}

function saveNumericSetting(key: NumericSetting, value: number, input: HTMLInputElement, format: (value: number) => string = String): Promise<void> {
  const submitted = input.value;
  return saveOptimisticSetting(key, value, saved => {
    if (input !== document.activeElement || (!saved && input.value === submitted)) {
      input.value = format(getVisibleSetting(appState.settings, key));
    }
  });
}

function saveVideoBitrate(value: number): Promise<void> {
  return saveNumericSetting("videoBitsPerSecond", value, elements.customVideoBitrateInput,
    bits => formatBitrateMbps(bits / BITS_PER_MEGABIT));
}

function renderShortcutList(focusAction?: string): void {
  const focused = document.activeElement;
  if (focused instanceof HTMLButtonElement && elements.shortcutList.contains(focused)) {
    focusAction ??= focused.dataset.action;
  }
  let focusButton: HTMLButtonElement | undefined;
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
    button.setAttribute("aria-label", `${button.title}, ${button.textContent}`);
    button.addEventListener("click", () => {
      waitingShortcutAction = action;
      renderShortcutList(action);
    });
    if (action === focusAction) focusButton = button;
    controls.appendChild(button);
    if (isWaiting) {
      const cancelButton = document.createElement("button");
      cancelButton.className = "shortcut-cancel";
      cancelButton.type = "button";
      cancelButton.textContent = "취소";
      cancelButton.title = "단축키 입력 취소";
      cancelButton.addEventListener("click", () => {
        waitingShortcutAction = null;
        renderShortcutList(action);
      });
      controls.appendChild(cancelButton);
    }
    row.append(label, controls);
    elements.shortcutList.appendChild(row);
  }
  focusButton?.focus({ preventScroll: true });
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

function persistBitrateInput(commit: boolean): void {
  sanitizeBitrateInput();
  const value = Number(elements.customVideoBitrateInput.value);
  if (!Number.isFinite(value) || value < MIN_VIDEO_MEGABITS_PER_SECOND) {
    if (commit) {
      renderBitrateInput(appState.settings, null);
      showBitrateRangeWarning();
    }
    return;
  }
  if (commit) elements.customVideoBitrateInput.value = formatBitrateMbps(value);
  void saveVideoBitrate(Math.round(value * BITS_PER_MEGABIT));
}

async function withCommandInFlight<T>(command: () => Promise<T>): Promise<T | undefined> {
  showError();
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

for (const { setting, inputs } of toggleControls) {
  for (const input of inputs) {
    input.addEventListener("change", () => {
      if (input.checked) void updatePopupSettings({ [setting]: input.value === "on" });
    });
  }
}

for (const input of elements.outputFormatInputs) {
  input.addEventListener("change", () => {
    const value = input.value;
    if (input.checked && (value === "webm" || value === "mp4")) void updatePopupSettings({ outputFormat: value });
  });
}

for (const input of elements.recordingCodecInputs) {
  input.addEventListener("change", () => {
    if (input.checked) void updatePopupSettings({ recordingCodec: input.value === "hevc" ? "hevc" : "auto" });
  });
}

function chooseAutoSplitMode(value: AutoSplitMode): Promise<void> {
  return saveOptimisticSetting("autoSplitMode", value, renderAutoSplitMode);
}

for (const input of elements.autoSplitKinds) {
  input.addEventListener("change", () => {
    if (input.checked) void chooseAutoSplitMode(input.value === "size" ? "size" : lastAutoSplitTimeMode);
  });
}

elements.autoSplitTimeMode.addEventListener("change", () => {
  void chooseAutoSplitMode(normalizeAutoSplitMode(elements.autoSplitTimeMode.value));
});

function stepAutoSplitTimeMode(direction: -1 | 1): void {
  const select = elements.autoSplitTimeMode;
  const next = (select.selectedIndex + direction + select.length) % select.length;
  void chooseAutoSplitMode(normalizeAutoSplitMode(select.options[next].value));
}

elements.autoSplitTimePrevious.addEventListener("click", () => stepAutoSplitTimeMode(-1));
elements.autoSplitTimeNext.addEventListener("click", () => stepAutoSplitTimeMode(1));

for (const input of elements.autoSplitFormats) {
  input.addEventListener("change", () => {
    if (input.checked) void updatePopupSettings({ autoSplitFormat: input.value === "webm" ? "webm" : "mp4" });
  });
}

elements.customVideoBitrateInput.addEventListener("input", () => persistBitrateInput(false));
elements.customVideoBitrateInput.addEventListener("change", () => persistBitrateInput(true));

for (const control of integerControls) {
  const save = (direction = 0) => {
    const value = readIntegerControl(control, direction);
    control.input.value = String(value);
    void saveNumericSetting(control.setting, value, control.input);
  };
  control.input.addEventListener("change", () => save());
  control.input.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    control.input.blur();
  });
  control.decrease.addEventListener("click", () => save(-1));
  control.increase.addEventListener("click", () => save(1));
}

elements.bitrateDecreaseButton.addEventListener("click", () => {
  void stepBitrate(-1);
});

elements.bitrateIncreaseButton.addEventListener("click", () => {
  void stepBitrate(1);
});

elements.shortcutPanel.addEventListener("keydown", (event) => {
  const action = waitingShortcutAction;
  if (!action || event.key === "Tab") return;
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    waitingShortcutAction = null;
    renderShortcutList(action);
    return;
  }
  if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement) return;

  const key = event.key.toLowerCase();
  if (!/^[a-z0-9]$/.test(key) || event.ctrlKey || event.metaKey || event.altKey) {
    event.preventDefault();
    return;
  }

  const used = Object.entries(appState.settings.shortcutKeys).some(([other, value]) => other !== action && value === key);
  if (used) {
    showError("이미 사용 중인 단축키입니다.");
    event.preventDefault();
    return;
  }

  waitingShortcutAction = null;
  renderShortcutList(action);
  void updatePopupSettings({ shortcutKeys: { [action]: key } });
  event.preventDefault();
});

function confirmSettingsReset(scope: typeof resetScope): void {
  resetScope = scope;
  elements.settingsResetTitle.textContent = scope === "all" ? "전체 설정 초기화" : "단축키 초기화";
  elements.settingsResetDescription.textContent = scope === "all"
    ? "CropClip 설정을 모두 기본값으로 되돌릴까요?"
    : "설정한 단축키를 모두 기본값으로 되돌릴까요?";
  elements.settingsResetDialog.returnValue = "";
  elements.settingsResetDialog.showModal();
}

elements.shortcutResetButton.addEventListener("click", () => confirmSettingsReset("shortcuts"));
elements.resetSettingsButton.addEventListener("click", () => confirmSettingsReset("all"));

elements.settingsResetDialog.addEventListener("close", () => {
  if (elements.settingsResetDialog.returnValue !== "reset" || elements.resetSettingsButton.disabled) return;
  waitingShortcutAction = null;
  renderShortcutList();
  void updatePopupSettings(resetScope === "all" ? DEFAULT_SETTINGS : { shortcutKeys: DEFAULT_SHORTCUT_KEYS });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes.settings || changes.region || changes.regions || changes.recordingState) storageRevision++;
  if (changes.settings) {
    appState.settings = normalizeSettings(changes.settings.newValue);
    syncPresetUi(appState.settings, document.activeElement);
  }

  if (changes.region) {
    appState.region = normalizeRegion(changes.region.newValue ?? null);
  }

  if (changes.regions) {
    appState.regions = normalizeRegions(changes.regions.newValue, appState.region);
  }

  if (changes.recordingState) {
    appState.recordingState = normalizeRecordingState(changes.recordingState.newValue);
    syncRecordingTimer();
  } else if (changes.settings) {
    updateRecordingTimer();
  }

  renderState();
});

void refreshAppState().catch(() => showError("설정을 불러오지 못했습니다."));
