import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = ts.createSourceFile("recording.ts", ["recording_controller.ts", "recording_session.ts"].map(name => fs.readFileSync(new URL(`../src/content/${name}`, import.meta.url), "utf8")).join("\n").replace(/^export /gm, ""), ts.ScriptTarget.Latest, true);
const names = ["queueDirectChunkCheckpoint", "flushDirectCheckpoints", "saveDirectCheckpoints", "waitBeforeBacklogWrite", "sendCheckpointMessage", "getRecordingChunkSliceRanges", "cancelDirectRecordingSession", "abortDirectRecordingSession", "releaseDirectRecordingRecorder", "readBlobAsDataUrl"];
const functions = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
const readSource = functions.splice(functions.findIndex(code => code.startsWith("function readBlobAsDataUrl(")), 1)[0];
let abortedReads = 0;
const readBlob = new Function("FileReader", `${ts.transpile(readSource)}\nreturn readBlobAsDataUrl;`)(class {
  readAsDataURL() {}
  abort() { abortedReads++; this.onabort(); }
});
const readAbort = new AbortController();
const reading = readBlob(new Blob(["pending checkpoint"]), readAbort.signal);
readAbort.abort();
await assert.rejects(reading, { name: "AbortError" });
assert.equal(abortedReads, 1, "cancel must stop a checkpoint read already in progress");

const limit = 64 * 1024 * 1024;
const writes = [], notices = [];
const turns = new Map();
let releaseWrite, blocked = true, failWrite = false;
const clock = {
  setTimeout(callback) { const id = Symbol(); turns.set(id, callback); return id; },
  clearTimeout(id) { turns.delete(id); },
};
const api = new Function("sendRuntimeMessage", "showPlayerFeedback", "window", `
  const document = { hidden: false };
  const CHECKPOINT_REPLY_TIMEOUT_MS = 15000;
  const MAX_RECORDING_MESSAGE_BLOB_BYTES = 8 * 1024 * 1024;
  const MAX_ACTIVE_BACKLOG_SLICE_BYTES = 1024 * 1024;
  const ACTIVE_BACKLOG_WRITE_INTERVAL_MS = 34;
  const HIGH_RECORDING_FRAME_RATE = 60, STANDARD_RECORDING_FRAME_RATE = 30;
  const MAX_PENDING_RECORDING_BYTES = ${limit}, CHUNK_INDEX_DIGITS = 6;
  const buildBaseName = createdAt => 'recording-' + createdAt;
  const readBlobAsDataUrl = async blob => 'data:' + blob.size;
  const cleanupDirectRecordingSession = () => {};
  const requestDirectPartStop = session => { session.stops++; };
  ${ts.transpile(functions.join("\n"), { target: ts.ScriptTarget.ES2022 })}
  return { queue: queueDirectChunkCheckpoint, flush: flushDirectCheckpoints, cancel: cancelDirectRecordingSession };
`)(async message => {
  writes.push(message.chunk);
  if (blocked) await new Promise(resolve => { releaseWrite = resolve; });
  return failWrite ? { ok: false, error: "disk failure" } : { ok: true };
}, message => notices.push(message), clock);
const makeSession = () => ({
  recordingId: "test", createdAt: 1_000, checkpointIndex: 0, checkpointSaveChain: Promise.resolve(),
  pendingChunks: [], pendingBytes: 0, recordedBytes: 0, checkpointSaving: false, checkpointAbort: new AbortController(),
  settings: { enable60fps: true },
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
assert.ok(writes.every(item => item.baseName === "recording-1000"));
assert.deepEqual(writes.filter(item => item.frameRate !== undefined).map(item => item.frameRate), [60]);
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

const fallback = makeSession(), beforeFallback = writes.length;
fallback.originalStreamFallback = true;
fallback.originalProbe = new AbortController();
const backlogBlob = new Blob([new Uint8Array(2 * 1024 * 1024)]);
api.queue(fallback, backlogBlob);
api.queue(fallback, backlogBlob);
assert.equal(writes.length, beforeFallback);
fallback.originalProbe = undefined;
api.flush(fallback);
await tick();
assert.equal(writes.length, beforeFallback, "a failed original lookup must yield before sending queued screen video");
for (let sent = 0; sent < 4; sent++) {
  assert.equal(turns.size, 1);
  [...turns.values()][0]();
  await tick();
  assert.equal(writes.length, beforeFallback + sent + 1, "send at most one slice between render turns");
}
await fallback.checkpointSaveChain;
assert.deepEqual(writes.slice(beforeFallback).map(item => item.completesBlob), [false, true, false, true]);
assert.equal(fallback.pendingBytes, 0);

const cancelledBacklog = makeSession(), beforeCancelledBacklog = writes.length;
cancelledBacklog.originalStreamFallback = true;
cancelledBacklog.originalProbe = new AbortController();
api.queue(cancelledBacklog, backlogBlob);
api.queue(cancelledBacklog, backlogBlob);
cancelledBacklog.originalProbe = undefined;
api.flush(cancelledBacklog);
api.cancel(cancelledBacklog);
await cancelledBacklog.checkpointSaveChain;
assert.equal(turns.size, 0, "cancel must clear the scheduled backlog write");
assert.equal(writes.length, beforeCancelledBacklog, "cancel must not write the backlog after the render turn");

const stoppedBacklog = makeSession(), beforeStoppedBacklog = writes.length;
stoppedBacklog.originalStreamFallback = true;
stoppedBacklog.originalProbe = new AbortController();
api.queue(stoppedBacklog, backlogBlob);
api.queue(stoppedBacklog, backlogBlob);
stoppedBacklog.originalProbe = undefined;
stoppedBacklog.stopRequested = true;
api.flush(stoppedBacklog);
await stoppedBacklog.checkpointSaveChain;
assert.equal(turns.size, 0, "stopping must save the remaining video without render delays");
assert.deepEqual(writes.slice(beforeStoppedBacklog).map(item => item.completesBlob), [true, true]);

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
