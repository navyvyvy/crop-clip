import { normalizeSettings } from "../dist/shared/normalize.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = ts.createSourceFile("region_selector.ts", fs.readFileSync(new URL("../src/content/region_selector.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node)) functions.set(node.name?.text, node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
const compile = (...names) => ts.transpile(names.map(name => functions.get(name)).join("\n"), { target: ts.ScriptTarget.ES2022 });
const reads = [];
const stateReader = new Function('chrome', 'normalizeSettings', `
  let storedStateRevision = 0;
  const RECORDING_STATUS = { idle: 'idle' };
  const isExtensionContextAvailable = () => true, directSession = { recordingId: 'current' };
  const normalizeRegion = value => value, normalizeRegions = value => value ?? [];
  const normalizeRecordingState = value => value, getMultiRegionLimit = () => 2, normalizeShortcutKeys = value => value;
  const DEFAULT_SEEK_SECONDS = 5, DEFAULT_MULTI_REGION_COUNT = 2, DEFAULT_CONTENT_SHORTCUT_KEYS = {};
  ${compile('loadState')}
  return { load: loadState, changed() { storedStateRevision++; } };
`)({ storage: { local: { get: () => new Promise(resolve => reads.push(resolve)) } } }, normalizeSettings);
const loading = stateReader.load();
stateReader.changed();
reads.shift()({ settings: { enableShortcuts: true }, recordingState: { status: 'idle' } });
await new Promise(resolve => setImmediate(resolve));
assert.equal(reads.length, 1, 'a changed snapshot must be read again before it can overwrite current settings');
reads.shift()({ settings: { enableShortcuts: false }, recordingState: { status: 'recording' } });
const freshState = await loading;
assert.equal(freshState.shortcutsEnabled, false);
assert.equal(freshState.recordingState.status, 'recording');

const actions = [];
const handleShortcut = new Function("actions", `
  const isChzzkClipEditorPage = () => false, isEditableShortcutTarget = target => target === 'input';
  const seekEnabled = false, shortcutsEnabled = true, multiRegionEnabled = false, fullRecordButtonEnabled = true, fullScreenshotButtonEnabled = true;
  const shortcutKeys = { regionRecord: 'r', fullRecord: 'e', cancelRecording: 'c', fullScreenshot: 'd' };
  const toggleRecording = async full => actions.push(full ? 'full' : 'region');
  const cancelRecording = async () => actions.push('cancel');
  const captureFullScreenshot = () => actions.push('screenshot');
  ${compile('handleShortcut')}
  return handleShortcut;
`)(actions);
for (const [key, code, action] of [['r','KeyR','region'], ['ㄱ','KeyR','region'], ['Process','KeyE','full'], ['ㅊ','KeyC','cancel'], ['ㅇ','KeyD','screenshot']]) {
  actions.length = 0;
  const event = { key, code, preventDefault() {} };
  handleShortcut(event);
  assert.deepEqual(actions, [action], `${key}/${code} must activate the shortcut`);
  for (const ignored of [{ target: 'input' }, { repeat: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
    actions.length = 0;
    handleShortcut({ ...event, ...ignored });
    assert.deepEqual(actions, [], 'typing, modifiers and held keys must remain untouched');
  }
}

let captures = 0, now = 1000;
// Use the production renderer for both button layouts, including rebuilt controls.
const render = new Function('button', 'full', 'command', 'queued', 'state', `
  const HTMLButtonElement = Object;
  const RECORDING_STATUS = { recording: 'recording' }, RECORDING_MODE = { full: 'full' };
  const currentRecordingState = state, recordingCommandInFlight = command, pendingRecordingTerminalCommand = queued;
  const withShortcut = label => label;
  ${compile('setRecordButtonContent', 'getRecordIconSvg', 'setChzzkButtonPresentation', 'setChzzkToolContent')}
  setRecordButtonContent(button, full);
`);
for (const full of [false, true]) {
  const attrs = new Map();
  const control = { dataset: {}, setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key), toggleAttribute: (key, on) => on ? attrs.set(key, '') : attrs.delete(key) };
  for (const queued of [null, 'STOP_RECORDING', 'CANCEL_RECORDING']) {
    render(control, full, full ? 'START_FULL_RECORDING' : 'START_RECORDING', queued, { status: 'idle' });
    assert.equal(attrs.get('aria-busy'), 'true');
    assert.match(attrs.get('aria-label'), queued === 'CANCEL_RECORDING' ? /취소 예정/ : queued ? /정지 예정/ : /시작 중/);
    assert.equal(control.disabled, false, 'pending start must still accept a stop request');
    assert.equal(attrs.has('data-recording'), false, 'pending start must not pretend to be recording');
  }
  const pendingIcon = control.innerHTML;
  render(control, full, null, null, { status: 'idle' });
  assert.equal(attrs.get('aria-busy'), 'false');
  assert.match(attrs.get('aria-label'), /녹화 시작/);
  assert.notEqual(control.innerHTML, pendingIcon);
  render(control, full, null, null, { status: 'recording', mode: full ? 'full' : 'region' });
  assert.match(attrs.get('aria-label'), /녹화 정지/);
  assert.equal(attrs.has('data-recording'), true);
}
for (const mode of ['region', 'full']) for (const outcome of ['stop', 'cancel', 'failure', 'rejection', 'early-stop']) {
  const commands = [], replies = [], presentations = [];
  const api = new Function('sendRuntimeMessage', 'presentations', `
    const RECORDING_STATUS = { idle: 'idle', recording: 'recording' }, RECORDING_MODE = { region: 'region', full: 'full' };
    let currentRecordingState = { status: 'idle' }, recordingCommandInFlight = null, pendingRecordingTerminalCommand = null;
    const window = { alert: message => { throw Error(message); } }, showPlayerFeedback = () => {};
    const syncRecordingCommandButtons = () => presentations.push(recordingCommandInFlight);
    ${compile('runRecordingCommand', 'toggleRecording', 'cancelRecording')}
    return { cancel: cancelRecording, toggle: () => toggleRecording(${mode === 'full'}), setState(state) { currentRecordingState = state; } };
  `)(message => { commands.push(message.type); return new Promise((resolve, reject) => replies.push({ resolve, reject })); }, presentations);
  const started = api.toggle();
  assert.equal(presentations.at(-1), commands[0], 'the button must update before a delayed start response');
  const settled = started.then(() => null, error => error);
  if (outcome !== 'early-stop') api.setState({ status: 'recording', mode });
  await api.toggle();
  await api.toggle();
  if (outcome === 'cancel') await api.cancel();
  assert.equal(commands.length, 1, 'pending start must finish before stop is sent');
  const startReply = replies.shift();
  if (outcome === 'rejection') startReply.reject(Error('start failed'));
  else startReply.resolve(outcome === 'failure' ? { ok: false, error: 'start failed' } : { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  if (['failure', 'rejection'].includes(outcome)) {
    assert.equal(commands.length, 1, 'failed starts must discard pending stop/cancel');
    assert.match((await settled).message, /start failed/);
  } else {
    assert.deepEqual(commands, [mode === 'region' ? 'START_RECORDING' : 'START_FULL_RECORDING', outcome === 'cancel' ? 'CANCEL_RECORDING' : 'STOP_RECORDING'], 'stop pressed during a delayed start must not be dropped or duplicated');
    await api.toggle();
    assert.equal(commands.length, 2, 'saving must not queue another recording');
    replies.shift().resolve({ ok: true });
    assert.equal(await settled, null);
  }
  api.setState({ status: 'idle' });
  assert.equal(presentations.at(-1), null, 'success and failure must clear the pending presentation');
  const next = api.toggle();
  assert.equal(commands.at(-1), mode === 'region' ? 'START_RECORDING' : 'START_FULL_RECORDING', 'lock must release after success or failure');
  replies.shift().resolve({ ok: true });
  await next;
  api.setState({ status: 'recording', mode: mode === 'full' ? 'region' : 'full' });
  const sent = commands.length;
  await assert.rejects(api.toggle(), /녹화 중에는/);
  assert.equal(commands.length, sent, 'the other recording mode must not start or stop the active recording');
}
const bind = new Function("captureFullScreenshot", "Date", `
  const POINTER_CLICK_DEDUP_MS = 500;
  let lastScreenshotPointerActivationAt = 0;
  ${compile('bindDirectPlayerActivation', 'handlePlayerScreenshotActivation')}
  return button => bindDirectPlayerActivation(button, handlePlayerScreenshotActivation);
`)(() => captures++, { now: () => now });
const button = Object.assign(new EventTarget(), { dataset: {} });
bind(button);
bind(button);
const dispatch = (type, detail) => button.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { button: 0, detail }));
dispatch('pointerdown', 0);
now += 1000; // The click reaches us late under load (or after a long press).
dispatch('click', 1);
assert.equal(captures, 1, 'one pointer gesture must trigger exactly once even after 500 ms');
dispatch('click', 0);
assert.equal(captures, 2, 'keyboard/assistive activation must still work immediately afterwards');
console.log('player shortcut and delayed click checks passed');
