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
const actions = [];
const handleShortcut = new Function("actions", `
  const isChzzkClipEditorPage = () => false, isEditableShortcutTarget = target => target === 'input';
  const seekEnabled = false, shortcutsEnabled = true, multiRegionEnabled = false, fullRecordButtonEnabled = true, fullScreenshotButtonEnabled = true;
  const shortcutKeys = { regionRecord: 'r', fullRecord: 'e', cancelRecording: 'c', fullScreenshot: 'd' };
  const toggleRegionRecording = async () => actions.push('region');
  const toggleFullRecording = async () => actions.push('full');
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
for (const mode of ['region', 'full']) for (const outcome of ['stop', 'cancel', 'failure', 'rejection', 'early-stop']) {
  const commands = [], replies = [];
  const api = new Function('sendRuntimeMessage', `
    const RECORDING_STATUS = { idle: 'idle', recording: 'recording' }, RECORDING_MODE = { region: 'region', full: 'full' };
    let currentRecordingState = { status: 'idle' }, recordingCommandInFlight = null, pendingRecordingTerminalCommand = null;
    const window = { alert: message => { throw Error(message); } }, showPlayerFeedback = () => {};
    ${compile('runRecordingCommand', 'toggleRegionRecording', 'toggleFullRecording', 'cancelRecording')}
    return { cancel: cancelRecording, toggle: ${mode === 'region' ? 'toggleRegionRecording' : 'toggleFullRecording'}, setState(state) { currentRecordingState = state; } };
  `)(message => { commands.push(message.type); return new Promise((resolve, reject) => replies.push({ resolve, reject })); });
  const started = api.toggle();
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
  const next = api.toggle();
  assert.equal(commands.at(-1), mode === 'region' ? 'START_RECORDING' : 'START_FULL_RECORDING', 'lock must release after success or failure');
  replies.shift().resolve({ ok: true });
  await next;
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
