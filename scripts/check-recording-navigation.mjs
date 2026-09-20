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
