import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = ts.createSourceFile("region_selector.ts", fs.readFileSync(new URL("../src/content/region_selector.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["queueDirectChunkCheckpoint", "saveDirectCheckpoints", "sendCheckpointMessage", "getRecordingChunkSliceRanges", "cancelDirectRecordingSession", "abortDirectRecordingSession"];
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
const limit = 64 * 1024 * 1024;
const writes = [], notices = [];
let releaseWrite, blocked = true, failWrite = false;
const api = new Function("sendRuntimeMessage", "showPlayerFeedback", `
  const MAX_RECORDING_MESSAGE_BLOB_BYTES = 8 * 1024 * 1024;
  const MAX_PENDING_RECORDING_BYTES = ${limit}, CHUNK_INDEX_DIGITS = 6;
  const readBlobAsDataUrl = async blob => 'data:' + blob.size;
  const cleanupDirectRecordingSession = () => {};
  const requestDirectPartStop = session => { session.stops++; };
  ${ts.transpile(functions.join("\n"), { target: ts.ScriptTarget.ES2022 })}
  return { queue: queueDirectChunkCheckpoint, cancel: cancelDirectRecordingSession };
`)(async message => {
  writes.push(message.chunk);
  if (blocked) await new Promise(resolve => { releaseWrite = resolve; });
  return failWrite ? { ok: false, error: "disk failure" } : { ok: true };
}, message => notices.push(message));
const makeSession = () => ({
  recordingId: "test", checkpointIndex: 0, checkpointSaveChain: Promise.resolve(),
  pendingChunks: [], pendingBytes: 0, checkpointSaving: false, checkpointAbort: new AbortController(),
  stops: 0, resolveFinish() {},
});
const tick = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
const chunk = new Blob([new Uint8Array(limit / 8)]);
const session = makeSession();
for (let n = 0; n < 8; n++) api.queue(session, chunk);
await tick();
assert.equal(session.stops, 1, "stalled storage must stop recording at the buffer limit");
assert.equal(session.stopRequested, true);
assert.equal(session.pendingBytes, limit);
assert.equal(notices.length, 1, "tell the user why recording stopped");
// The encoder's final chunk is still saved, even after the automatic stop.
api.queue(session, new Blob(["tail"]));
blocked = false;
releaseWrite();
await session.checkpointSaveChain;
assert.equal(writes.length, 9, "save all queued chunks and the encoder's final data without truncating");
assert.deepEqual(writes.map(item => item.index), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
assert.equal(session.pendingBytes, 0);
assert.equal(session.pendingChunks.length, 0);

blocked = true;
const cancelled = makeSession();
for (let n = 0; n < 4; n++) api.queue(cancelled, chunk);
await tick();
const beforeCancel = writes.length;
cancelled.cancelRequested = true;
api.cancel(cancelled);
await tick();
assert.equal(cancelled.pendingChunks.length, 0, "cancel releases queued blobs without waiting for storage");
assert.equal(cancelled.pendingBytes, 0);
assert.equal(cancelled.checkpointSaving, false, "cancel releases the active writer even if its acknowledgement never arrives");
blocked = false;
releaseWrite();
await tick();
assert.equal(writes.length, beforeCancel, "a late acknowledgement cannot restart a cancelled queue");

const immediateCancel = makeSession(), beforeImmediateCancel = writes.length;
api.queue(immediateCancel, chunk);
immediateCancel.cancelRequested = true;
api.cancel(immediateCancel);
await immediateCancel.checkpointSaveChain;
assert.equal(writes.length, beforeImmediateCancel, "cancel during blob conversion must not send new data");

const sliced = makeSession(), beforeSliced = writes.length;
api.queue(sliced, new Blob([chunk, chunk, "tail"]));
await sliced.checkpointSaveChain;
assert.deepEqual(writes.slice(beforeSliced).map(item => item.completesBlob), [false, false, true]);
assert.equal(sliced.pendingBytes, 0);

failWrite = true;
const failed = makeSession();
api.queue(failed, chunk);
api.queue(failed, chunk);
await failed.checkpointSaveChain;
assert.equal(failed.stops, 1, "a failed write must stop the encoder rather than accumulate more data");
assert.match(failed.checkpointError.message, /disk failure/);
assert.equal(failed.pendingBytes, 0);
assert.equal(failed.pendingChunks.length, 0);
console.log("recording backpressure checks passed");
