import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const text = fs.readFileSync(new URL("../src/background/service_worker.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("service_worker.ts", text, ts.ScriptTarget.Latest, true);
const functions = file.statements.filter(node => ts.isFunctionDeclaration(node)
  && node.name?.text === "recoverRecordingAfterTabExit");
let updateListener;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === "chrome.tabs.onUpdated.addListener") {
    updateListener = node.arguments[0].getText(file);
  }
  ts.forEachChild(node, visit);
}
visit(file);

let state, owner, disconnected;
const probes = [], recovered = [];
const onUpdated = new Function("loadRecordingState", "sendToTab", "recoverRecording", `
  const RECORDING_STATUS = { recording: 'recording' }, CHECKPOINT_FINALIZE_DELAY_MS = 300;
  const delay = async () => {};
  ${ts.transpile(functions.map(node => node.getText(file)).join("\n"), { target: ts.ScriptTarget.ES2022 })}
  return ${ts.transpile(updateListener, { target: ts.ScriptTarget.ES2022 })};
`)(async () => state, async (tabId, message) => {
  probes.push({ tabId, message });
  if (disconnected) throw new Error("Receiving end does not exist");
  return { ok: true, data: owner === message.recordingId };
}, async recordingId => recovered.push(recordingId));

for (const scenario of ["search", "back", "player-saving", "new-document", "closed-tab", "different-recording", "other-tab", "idle"]) {
  state = { status: "recording", tabId: 7, recordingId: "current" };
  owner = ["search", "back", "player-saving"].includes(scenario) ? "current" : undefined;
  disconnected = scenario === "closed-tab";
  if (scenario === "different-recording") owner = "replacement";
  if (scenario === "idle") state = { status: "idle" };
  probes.length = 0;
  recovered.length = 0;
  onUpdated(scenario === "other-tab" ? 9 : 7, { status: "loading", url: "https://chzzk.naver.com/search?query=test" });
  for (let tick = 0; tick < 10; tick++) await Promise.resolve();
  const mustRecover = ["new-document", "closed-tab", "different-recording"].includes(scenario);
  assert.deepEqual(recovered, mustRecover ? ["current"] : [], scenario + ": only recover when the recording owner is gone");
  if (!["idle", "other-tab"].includes(scenario)) {
    assert.deepEqual(probes, [{ tabId: 7, message: { type: "HAS_DIRECT_RECORDING", recordingId: "current" } }]);
  } else assert.equal(probes.length, 0);
}
console.log("recording navigation checks passed");

const startSource = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "startRecordingSession");
for (const outputFormat of ['webm', 'mp4']) for (const prepared of [true, false]) {
  const order = [];
  const start = new Function('outputFormat', 'prepared', 'order', `
    const RECORDING_STATUS = { recording: 'recording', completed: 'completed' }, RECORDING_MODE = { full: 'full', region: 'region' };
    const settings = { outputFormat }, crypto = { randomUUID: () => 'new-recording' };
    const ok = data => ({ ok: true, data }), fail = error => ({ ok: false, error });
    const getActiveRecordableTab = async () => ({ id: 7 });
    const loadAppState = async () => ({ region: {}, recordingState: { status: 'idle' }, settings });
    const sendCommandToContentScript = async (tabId, message) => {
      order.push(message);
      return prepared ? ok() : fail('encoder preparation failed');
    };
    const saveRecordingState = async () => { order.push('recording'); };
    const getPlayerRegionGeometry = async () => ok({});
    const loadRecordingState = async () => ({ status: 'recording', recordingId: 'new-recording' });
    const startDirectRecording = async () => { order.push('start'); return ok(); };
    ${ts.transpile(startSource.getText(file), { target: ts.ScriptTarget.ES2022 })}
    return startRecordingSession;
  `)(outputFormat, prepared, order);
  assert.equal((await start(true)).ok, prepared);
  assert.deepEqual(order, [{ type: 'PREPARE_DIRECT_RECORDING', settings: { outputFormat } }, ...(prepared ? ['recording', 'start'] : [])], 'prepare either container before setting recording state; a failed preparation must not start capture');
}
console.log('recording startup preparation checks passed');

const openSource = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "openCompletedRecordingResult");
for (const autoFocusResult of [true, false]) {
  for (const enableAutoDownloadRecording of [true, false]) {
    let state = { status: "completed", recordingId: "saved", tabId: 7 };
    const created = [];
    const open = new Function("chrome", "loadAppState", "loadRecordingState", "saveRecordingState", `
      const RECORDING_STATUS = { completed: 'completed', idle: 'idle' }, RESULT_TAB_RETRY_ALARM = 'retry';
      const RESULT_TAB_CREATE_ATTEMPTS = 3, RESULT_TAB_RETRY_DELAY_MS = 200, RESULT_TAB_RETRY_ALARM_DELAY_MINUTES = 0.5;
      const delay = async () => {}, scheduleRecordingDeletion = async () => {};
      ${ts.transpile(openSource.getText(file), { target: ts.ScriptTarget.ES2022 })}
      return openCompletedRecordingResult;
    `)({ runtime: { getURL: path => path }, alarms: { clear: async () => {}, create: async () => {} },
      tabs: { create: async options => { created.push(options); if (created.length === 1) throw new Error("retry"); return { id: 9 }; } },
    }, async () => ({ recordingState: state, settings: { autoFocusResult, enableAutoDownloadRecording } }), async () => state, async value => { state = value; });
    assert.equal(await open(), true);
    assert.equal(created.length, 2);
    assert.ok(created.every(tab => tab.active === (autoFocusResult && !enableAutoDownloadRecording)), "focus preference and automatic download must also apply to retries");
    assert.equal(created[1].url.includes("autoDownload=1"), enableAutoDownloadRecording);
    assert.equal(state.status, enableAutoDownloadRecording ? "completed" : "idle", "background results must not block the next recording");
  }
}

const resultText = fs.readFileSync(new URL("../src/result/result.ts", import.meta.url), "utf8");
const resultFile = ts.createSourceFile("result.ts", resultText, ts.ScriptTarget.Latest, true);
const activationListener = resultFile.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(resultFile) === "chrome.tabs.onActivated.addListener");
const tab = { id: 9, windowId: 1, active: true };
const onActivated = new Function("resultTab", `return ${ts.transpile(activationListener.expression.arguments[0].getText(resultFile), { target: ts.ScriptTarget.ES2022 })}`)(tab);
onActivated({ tabId: 12, windowId: 2 });
assert.equal(tab.active, true, "another window must not change this result tab's state");
onActivated({ tabId: 7, windowId: 1 });
assert.equal(tab.active, false);
onActivated({ tabId: 9, windowId: 1 });
assert.equal(tab.active, true, "a background result can later become active");
const restoreSource = resultFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "restoreSourceTab");
for (const scenario of ["active", "background", "automatic-download", "already-closed"]) {
  const updates = [];
  const restore = new Function("chrome", "restoreSourceTabOnClose", "resultTab", `
    const sourceTabId = 7;
    ${ts.transpile(restoreSource.getText(resultFile), { target: ts.ScriptTarget.ES2022 })}
    return restoreSourceTab;
  `)({ tabs: {
    update: async (id, options) => { if (scenario === "already-closed") throw new Error("closed"); updates.push({ id, ...options }); },
  } }, scenario !== "automatic-download", { active: scenario !== "background" });
  await restore();
  assert.deepEqual(updates, scenario === "active" ? [{ id: 7, active: true }] : [], "closing a background result must not steal focus");
}
console.log("result tab focus checks passed");
