import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (!global.gc) {
  const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url)], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const text = fs.readFileSync(new URL("../src/content/region_selector.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("region_selector.ts", text, ts.ScriptTarget.Latest, true);
const functions = [];
const startupFunctions = [];
let drawFrameSource;
let borderControlsSource;
let toggleRecordingSource;
let runRecordingCommandSource;
let selectDirectMimeTypeSource;
function visit(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "runRecordingCommand") runRecordingCommandSource = node.getText(file);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "selectDirectMimeType") selectDirectMimeTypeSource = node.getText(file);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "toggleRecording") toggleRecordingSource = node.getText(file);
  if (ts.isFunctionDeclaration(node) && node.name?.text === "attachBorderControls") borderControlsSource = node.getText(file);
  if (ts.isFunctionDeclaration(node) && ["startDirectRecording", "prepareDirectRecordingEncoder", "ignoreRecordingRejection", "releaseDirectRecordingCapture", "stopRecordingStream"].includes(node.name?.text)) startupFunctions.push(node.getText(file));
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "drawFrame") drawFrameSource = node.initializer.getText(file);
  if (ts.isFunctionDeclaration(node) && ["getVideoStream", "stopRegionLayoutWatch", "stopRecordingStream", "releaseDirectRecordingCapture", "cleanupDirectRecordingSession", "startDirectPart", "finalizeDirectRecording", "cancelDirectRecordingSession", "abortDirectRecordingSession", "failDirectRecordingSession", "finishDirectRecording", "requestDirectPartStop"].includes(node.name?.text)) {
    functions.push(node.getText(file));
  }
  ts.forEachChild(node, visit);
}
visit(file);
const selectMime = new Function("MediaRecorder", `
  const RECORDING_FORMAT = { webm: 'webm', mp4: 'mp4' };
  ${ts.transpile(selectDirectMimeTypeSource, { target: ts.ScriptTarget.ES2022 })}
  return selectDirectMimeType;
`);
assert.equal(selectMime({ isTypeSupported: () => true })({ outputFormat: "webm" }).mimeType,
  "video/webm;codecs=avc1", "prefer H.264 to preserve fast MP4 splitting without re-encoding");
assert.equal(selectMime({ isTypeSupported: type => type.includes("vp8") })({ outputFormat: "webm" }).mimeType,
  "video/webm;codecs=vp8,opus");
assert.equal(selectMime({ isTypeSupported: type => type.includes("vp9") })({ outputFormat: "webm" }).mimeType,
  "video/webm;codecs=vp9,opus");
assert.match(selectMime({ isTypeSupported: () => true })({ outputFormat: "mp4" }).mimeType, /^video\/mp4/);
assert.throws(() => selectMime({ isTypeSupported: () => false })({ outputFormat: "webm" }), /WebM/);
console.log("recording codec selection checks passed");
const { cleanup, getVideoStream, startDirectPart, messages, observers, detachTimers, layoutWatch } = new Function("MediaStream", `
  let directSession = null;
  let regionLayoutVideo = null, regionLayoutObserver = null, regionLayoutSyncFrame = null;
  const layoutWatch = { disconnected: false, get video() { return regionLayoutVideo; },
    watch(video) { regionLayoutVideo = video; regionLayoutObserver = { disconnect() { layoutWatch.disconnected = true; } }; } };
  const playerCaptureStreams = new WeakMap();
  const detachTimers = new Map();
  const window = { clearInterval() {}, setTimeout(fn) { detachTimers.set(1, fn); return 1; }, clearTimeout(id) { detachTimers.delete(id); } };
  const AUDIO_BITS_PER_SECOND = 128000, MILLISECONDS_PER_SECOND = 1000;
  const messages = [];
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const sendRuntimeMessage = async message => { messages.push(message); return { ok: true }; };
  class MediaRecorder {
    constructor() { this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    requestData() {}
    stop() { this.state = 'inactive'; }
  }
  ${ts.transpile(functions.join("\n"), { target: ts.ScriptTarget.ES2022 })}
  return { cleanup: cleanupDirectRecordingSession, getVideoStream, startDirectPart, messages, observers, detachTimers, layoutWatch };
`)(Stream);
function track(kind = "video") { return { kind, enabled: true, readyState: "live", clone() { return track(this.kind); }, stop() { this.readyState = "ended"; } }; }
function Stream(tracks) { return new FakeStream(tracks); }
class FakeStream extends EventTarget {
  constructor(tracks) { super(); this.tracks = tracks; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter(track => track.kind === "video"); }
  getAudioTracks() { return this.tracks.filter(track => track.kind === "audio"); }
  removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
  addTrack(track) {
    this.tracks.push(track);
    this.dispatchEvent(Object.assign(new Event("addtrack"), { track }));
  }
}

const unusedVideo = track(), requiredAudio = track("audio");
const captured = new Stream([unusedVideo, requiredAudio]);
let captureCalls = 0;
const player = { isConnected: true, parentNode: { parentNode: null }, captureStream: () => { captureCalls++; return captured; } };
for (let recording = 0; recording < 20; recording++) {
  const recordingStream = getVideoStream(player);
  assert.equal(recordingStream.getAudioTracks().length, 1);
  assert.equal(recordingStream.getAudioTracks()[0].enabled, true);
  recordingStream.getTracks().forEach(track => track.stop());
}
assert.equal(captureCalls, 1, "repeated recordings must not allocate native captures for the same player");
assert.equal(unusedVideo.readyState, "ended", "canvas output must not keep a duplicate source video capture running");
assert.equal(requiredAudio.readyState, "live", "recording audio must remain active");
assert.equal(requiredAudio.enabled, false, "the reusable source must stay disabled; only recording clones output audio");
assert.deepEqual(captured.getTracks(), [requiredAudio]);
assert.equal(getVideoStream({}), null);

// Reloads update the cached source, but cannot restart a completed recording.
for (let recording = 0; recording < 3; recording++) {
  const sourceStream = getVideoStream(player);
  const [audio] = sourceStream.getAudioTracks(), canvasVideo = track();
  let watcherRemoved = false;
  const session = {
    sourceStream, outputStream: new Stream([canvasVideo, audio]),
    canvas: { remove() {} }, drawTimerId: 1, cleanedUp: false,
    sourceChangeCleanup() { watcherRemoved = true; },
  };
  cleanup(session);
  cleanup(session);
  assert.ok(watcherRemoved);
  assert.ok([audio, canvasVideo].every(track => track.readyState === "ended"));
  assert.equal(session.outputStream.getTracks().length, 0, "release ended output tracks as well as source tracks");
  assert.equal(session.canvas, null);
  assert.equal(session.video, null);
  for (let reload = 0; reload < 3; reload++) {
    const lateVideo = track(), lateAudio = track("audio");
    captured.addTrack(lateVideo);
    captured.addTrack(lateAudio);
    assert.equal(lateVideo.readyState, "ended", "completed recording must not restart video capture");
    assert.equal(lateAudio.enabled, false, "the cached audio source stays disabled after reload");
    assert.equal(sourceStream.getTracks().length, 0, "finished recording clones cannot receive reloaded source tracks");
    assert.deepEqual(captured.getTracks(), [lateAudio], "reloads cannot accumulate old source tracks");
    captured.dispatchEvent(Object.assign(new Event("addtrack"), { track: requiredAudio }));
    assert.deepEqual(captured.getTracks(), [lateAudio], "a late event for a removed track must not stop the current audio");
  }
}

const detachWatcher = observers[0];
layoutWatch.watch(player);
assert.equal(observers.length, 1, "reuse the player removal watcher across recordings");
player.parentNode = { parentNode: { parentNode: null } };
detachWatcher.callback();
assert.equal(detachWatcher.connected, true, "moving a connected player must keep its capture and watch the new parents");
assert.equal(captured.getAudioTracks().length, 1);
player.isConnected = false;
detachWatcher.callback();
assert.equal(captured.getAudioTracks().length, 1, "a temporary detach during search must not release recording audio");
assert.equal(detachTimers.size, 1);
player.isConnected = true;
player.parentNode = { parentNode: null };
detachWatcher.callback();
assert.equal(detachTimers.size, 0, "reattaching the mini player cancels disposal");
assert.equal(layoutWatch.video, player, "temporary detachment must preserve the layout watcher");
assert.equal(getVideoStream(player).getAudioTracks()[0].readyState, "live");
player.isConnected = false;
detachWatcher.callback();
const recheck = detachTimers.get(1);
detachWatcher.callback();
assert.equal(detachTimers.get(1), recheck, "other DOM mutations must not postpone disposal indefinitely");
player.isConnected = true;
recheck();
assert.equal(detachTimers.size, 0, "the deadline also detects reattachment outside watched parents");
assert.equal(captured.getAudioTracks().length, 1);
player.isConnected = false;
detachWatcher.callback();
const dispose = detachTimers.get(1);
detachTimers.clear();
dispose();
assert.equal(detachWatcher.connected, false, "stop watching after the player is detached");
assert.equal(captured.getTracks().length, 0, "detach releases the reusable audio connection");
assert.equal(layoutWatch.video, null, "a removed player must not stay alive through the region layout watcher");
assert.equal(layoutWatch.disconnected, true);
const detachedAudio = track("audio");
captured.addTrack(detachedAudio);
assert.equal(detachedAudio.readyState, "ended", "late source events cannot restart a detached player capture");

// Stopping the encoder must release capture even while a disk write is pending.
for (const cancelWhileSaving of [false, true]) {
  let completeWrite, finish;
  const sourceAudio = track("audio"), canvasVideo = track();
  const session = {
    recordingId: "delayed-save", settings: {},
    sourceStream: new Stream([sourceAudio]), outputStream: new Stream([canvasVideo, sourceAudio]),
    canvas: { width: 3840, height: 2160, remove() {} }, drawTimerId: 1, cleanedUp: false,
    checkpointSaveChain: new Promise(resolve => { completeWrite = resolve; }),
    pendingChunks: [], pendingBytes: 0, checkpointAbort: new AbortController(),
    resolveFinish() { finish = "completed"; }, rejectFinish(error) { throw error; },
  };
  const canvas = session.canvas;
  await startDirectPart(session);
  session.recorder.state = "inactive";
  session.recorder.onstop();
  assert.equal(sourceAudio.readyState, "ended", "stopped recording must not capture audio while waiting for storage");
  assert.equal(canvasVideo.readyState, "ended", "stopped recording must not capture frames while waiting for storage");
  assert.equal(canvas.width * canvas.height, 0, "release the full-resolution canvas backing buffer");
  assert.equal(session.canvas, null, "saving must not retain a canvas object");
  assert.equal(session.video, null, "saving must not retain the source player");
  assert.equal(session.recorder, undefined, "saving must not retain the stopped encoder or its handlers");
  assert.equal(finish, undefined, "wait for all recorded data before reporting completion");
  session.cancelRequested = cancelWhileSaving;
  const before = messages.length;
  completeWrite();
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  assert.equal(finish, "completed");
  assert.equal(messages.length - before, cancelWhileSaving ? 0 : 1, "cancellation during saving must not finalize the recording");
}
console.log("recording cleanup checks passed");

for (const failure of ["encoder", "storage"]) {
  let resolveFinish, rejectFinish;
  const finished = new Promise((resolve, reject) => { resolveFinish = resolve; rejectFinish = reject; });
  const session = {
    recordingId: failure, settings: {}, sourceStream: new Stream([track("audio")]),
    outputStream: new Stream([track()]), canvas: { width: 1920, height: 1080, remove() {} },
    checkpointSaveChain: Promise.resolve(), pendingChunks: [new Blob(["queued"])], pendingBytes: 6,
    checkpointAbort: new AbortController(), resolveFinish, rejectFinish,
  };
  const rejected = assert.rejects(finished, failure === "encoder" ? /녹화 중 오류/ : /disk failed/);
  const before = messages.length;
  await startDirectPart(session);
  const recorder = session.recorder;
  if (failure === "encoder") recorder.onerror();
  else session.checkpointError = new Error("disk failed");
  recorder.state = "inactive";
  recorder.onstop();
  await rejected;
  assert.equal(session.pendingBytes, 0);
  assert.equal(session.pendingChunks.length, 0);
  assert.equal(session.recorder, undefined);
  assert.equal(session.canvas, null);
  assert.equal(session.checkpointAbort.signal.aborted, true);
  assert.equal(messages.slice(before).filter(message => message.type === "RECORDING_ERROR").length, 1);
}
console.log("recording error cleanup checks passed");

const video = { paused: false, readyState: 4, frame: 1, getVideoPlaybackQuality() { return { totalVideoFrames: this.frame }; } };
let paints = 0;
const draw = new Function("video", "paintPlacements", `
  let lastPaintedFrame = -1, cropLayoutKey = 'fixed';
  const HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
  const sourceRegions = [{}], session = { placements: [] };
  const computeDirectCropFromSelection = () => ({}), getCropLayoutKey = () => 'fixed';
  return ${ts.transpile(drawFrameSource, { target: ts.ScriptTarget.ES2022 })};
`)(video, () => paints++);
for (let tick = 0; tick < 60; tick++) draw();
assert.equal(paints, 1, "paint each decoded frame only once, even when the recording timer runs faster");
video.paused = true;
video.frame++;
draw();
assert.equal(paints, 1, "paused playback must not cause redundant full-frame copies");
video.paused = false;
draw();
assert.equal(paints, 2, "resume drawing as soon as playback resumes");
video.readyState = 0;
video.frame++;
draw();
assert.equal(paints, 2, "do not draw a frame while the player is loading");
console.log("recording frame checks passed");

// Starting a recording rebuilds the border before its message response arrives.
// A late response must not restart the disposed border's display timer.
for (const outcome of ["success", "failure", "rejection"]) {
  const timers = new Map();
  let nextTimer = 0, respond, reject;
  const makeBorder = () => {
    const button = Object.assign(new EventTarget(), { dataset: {}, setAttribute() {} });
    return { button, border: Object.assign(new EventTarget(), {
      dataset: {}, querySelector: selector => selector === ".record-region" ? button : null, querySelectorAll: () => [],
    }) };
  };
  const { attach, setState } = new Function("window", "sendRuntimeMessage", `
    const RECORDING_STATUS = { idle: 'idle', recording: 'recording' }, RECORDING_MODE = { full: 'full', region: 'region' };
    const MILLISECONDS_PER_SECOND = 1000, activeRegionIndex = 0;
    let currentRecordingState = { status: 'idle' }, recordingCommandInFlight = null, pendingRecordingTerminalCommand = null;
    const showPlayerFeedback = () => {}, syncRecordingCommandButtons = () => {}, setRecordButtonContent = () => {};
    const isRegionRecordingActive = () => currentRecordingState.status === 'recording';
    const withShortcut = label => label, getRecordIconSvg = () => '';
    ${ts.transpile(runRecordingCommandSource, { target: ts.ScriptTarget.ES2022 })}
    ${ts.transpile(toggleRecordingSource, { target: ts.ScriptTarget.ES2022 })}
    ${ts.transpile(borderControlsSource, { target: ts.ScriptTarget.ES2022 })}
    return { attach: attachBorderControls, setState(state) { currentRecordingState = state; } };
  `)({ setInterval(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); }, alert() {} },
    () => new Promise((resolve, fail) => { respond = resolve; reject = fail; }));
  const { border, button } = makeBorder();
  const dispose = attach(border, 0);
  button.dispatchEvent(new Event("click"));
  dispose();
  setState({ status: "recording", mode: "region" });
  const disposeCurrent = attach(makeBorder().border, 0);
  assert.equal(timers.size, 1, "the current border still shows recording time");
  if (outcome === "rejection") reject(new Error("message failed"));
  else respond({ ok: outcome === "success", error: "recording failed" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 1, "late recording responses must not revive a removed border timer");
  disposeCurrent();
  assert.equal(timers.size, 0);
}
console.log("recording border timer cleanup checks passed");

// Exercise the real startup scope: clearing session fields alone cannot detect
// a pending Promise handler that still retains the drawing closure.
const createStartup = new Function("playerState", "mimeType", `
  let directSession = null, currentRecordingState;
  const currentRegions = [], timers = new Map(), refs = {};
  const window = { setInterval(fn) { timers.set(1, fn); return 1; }, clearInterval(id) { timers.delete(id); } };
  class MediaStream {
    getTracks() { return []; } getVideoTracks() { return []; } getAudioTracks() { return []; }
  }
  const document = { createElement() {
    const canvas = { remove() {}, captureStream: () => new MediaStream(),
      getContext() { return { canvas: this, fillRect() {}, drawImage() {} }; } };
    refs.canvas = new WeakRef(canvas); return canvas;
  } };
  const findPrimaryVideoElement = () => {
    const player = { ...playerState }; refs.video = new WeakRef(player); return player;
  };
  const waitForCurrentVideoFrame = async () => true;
  const prepareRecordingEncoder = async () => { refs.encoderPreparations = (refs.encoderPreparations ?? 0) + 1; };
  const computeDirectCropFromSelection = () => ({});
  const computeDirectLayout = () => ({ output: { width: 1920, height: 1080 }, placements: [] });
  const selectDirectMimeType = () => ({ mimeType: mimeType ?? 'video/webm', extension: mimeType?.startsWith('video/mp4') ? 'mp4' : 'webm' });
  const getVideoStream = () => new MediaStream();
  const getCropLayoutKey = () => '', buildBaseName = () => 'recording';
  const startDirectPart = async () => {};
  const watchDirectRecordingSource = () => {}, showSelectionBorders = () => {};
  const requestChzzkToolSync = () => {}, syncChzzkRecordTimer = () => {};
  const loadState = async () => ({ recordingState: {} });
  const HIGH_RECORDING_FRAME_RATE = 60, STANDARD_RECORDING_FRAME_RATE = 30, MILLISECONDS_PER_SECOND = 1000;
  ${ts.transpile(startupFunctions.join("\n"), { target: ts.ScriptTarget.ES2022 })}
  return { start: startDirectRecording, refs, timers,
    stop() { releaseDirectRecordingCapture(directSession); },
    finish() { directSession.resolveFinish(); } };
`);
for (const allowMutedRecording of [undefined, false, true]) {
  for (const playerState of [{ muted: false, volume: 1 }, { muted: true, volume: 1 }, { muted: false, volume: 0 }]) {
    const recording = createStartup(playerState);
    const response = await recording.start({ recordingId: "mute-option", region: {}, settings: { allowMutedRecording } });
    const allowed = allowMutedRecording === true || (!playerState.muted && playerState.volume > 0);
    assert.equal(response.ok, allowed, "muted recording requires an explicit opt-in");
    assert.deepEqual(recording.refs.video.deref(), playerState, "recording must preserve player mute and volume");
    if (allowed) { recording.stop(); recording.finish(); }
    assert.equal(recording.timers.size, 0);
  }
}
for (const mime of ['video/webm;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus']) {
  const recording = createStartup({ muted: false, volume: 1 }, mime);
  await recording.start({ recordingId: 'codec-preparation', region: {}, settings: { outputFormat: mime.startsWith('video/mp4') ? 'mp4' : 'webm' } });
  assert.equal(recording.refs.encoderPreparations ?? 0, /vp[89]/.test(mime) ? 0 : 1, 'H.264 preparation must depend on the codec, including WebM');
  recording.stop(); recording.finish();
}
const startup = createStartup({ muted: false, volume: 1 });
assert.deepEqual(await startup.start({ recordingId: "pending-save", region: {}, settings: {} }), { ok: true });
startup.stop();
assert.equal(startup.timers.size, 0);
// Keep the completion Promise pending, as when a storage acknowledgement stalls.
for (let round = 0; round < 3; round++) {
  await new Promise(resolve => setImmediate(resolve));
  global.gc();
}
assert.equal(startup.refs.canvas.deref(), undefined, "pending completion must not retain the canvas through a closure");
assert.equal(startup.refs.video.deref(), undefined, "pending completion must not retain the source player through a closure");
startup.finish();
console.log("recording pending-save collection checks passed");

const encoderSource = fs.readFileSync(new URL("../src/shared/recording_encoder.ts", import.meta.url), "utf8");
for (const scenario of ["ready", "unavailable", "error", "timeout"]) {
  const timers = new Map();
  let finishDiscovery, settled = false;
  const encoder = scenario === "unavailable" ? undefined : {
    isConfigSupported(config) {
      assert.equal(config.hardwareAcceleration, "prefer-hardware");
      return new Promise((resolve, reject) => { finishDiscovery = () => scenario === "error" ? reject(new Error("discovery failed")) : resolve({ supported: false }); });
    },
  };
  const prepare = new Function("VideoEncoder", "window", `${ts.transpile(encoderSource)}; return prepareRecordingEncoder;`)(encoder, {
    setTimeout(fn) { timers.set(1, fn); return 1; }, clearTimeout(id) { timers.delete(id); },
  });
  const pending = prepare().finally(() => { settled = true; });
  if (scenario !== "unavailable") {
    await Promise.resolve();
    assert.equal(settled, false, "recording must wait for encoder discovery");
    if (scenario === "timeout") timers.get(1)();
    else finishDiscovery();
  }
  if (["error", "timeout"].includes(scenario)) await assert.rejects(pending);
  else await pending;
  assert.equal(timers.size, 0, "encoder preparation must release its deadline on every exit");
}
console.log("recording encoder preparation checks passed");
