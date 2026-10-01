import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';

const source = ts.createSourceFile('service_worker.ts', fs.readFileSync(new URL('../src/background/service_worker.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const code = ts.transpile(source.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(source)).join('\n'), { target: ts.ScriptTarget.ES2022 });
function fixture(options = {}) {
  let state = { status: 'recording', recordingId: 'clip', tabId: 7 };
  let chunks = [1, 2].map(index => ({ id: `chunk${index}`, recordingId: 'clip', index, mimeType: 'video/webm', extension: 'webm', baseName: 'clip', createdAt: 0, capturedAt: index * 1000, completesBlob: true, blob: new Blob(['saved']) }));
  const parts = [], results = [], deleted = [];
  let recording;
  const env = {
    chrome: {
      alarms: { create: async () => {}, clear: async () => {} },
      runtime: {
        getURL: path => `chrome-extension://test/${path}`, ContextType: { TAB: 'TAB' },
        getContexts: async () => results.filter(tab => tab.url.startsWith('chrome-extension://test/')).map(tab => ({ documentUrl: tab.url, tabId: results.indexOf(tab) + 8 })),
      },
      tabs: {
        query: async () => [{ id: 7, url: 'https://chzzk.naver.com/test' }],
        create: async tabOptions => { results.push(tabOptions); return { id: results.length + 7, ...tabOptions }; },
        sendMessage: (_tabId, _message, callback) => callback({ ok: false, error: 'The recording owner disconnected' }),
      },
    },
    loadRecordingState: async () => state,
    loadAppState: async () => ({ recordingState: state, settings: { autoFocusResult: true, enableAutoDownloadRecording: false } }),
    saveRecordingState: async next => {
      if (next.status === 'idle' && options.failResultState) {
        options.failResultState = false;
        throw new Error('Temporary state write failure');
      }
      state = next;
    },
    getChunksByRecordingId: async () => chunks,
    putChunk: async () => { throw new Error('QuotaExceededError'); },
    putPart: async part => { if (options.failFinalize) throw new Error('Storage full'); parts.push(part); },
    putRecording: async record => { recording = record; },
    deleteRecordingChunks: async () => { chunks = []; },
    deleteRecording: async id => { deleted.push(id); chunks = []; parts.length = 0; recording = undefined; },
  };
  const api = new Function('env', `
    const { chrome, loadRecordingState, loadAppState, saveRecordingState, getChunksByRecordingId, putChunk, putPart, putRecording, deleteRecordingChunks, deleteRecording } = env;
    const RECORDING_STATUS = { idle: 'idle', recording: 'recording', completed: 'completed', error: 'error' };
    const checkpointStores = new Map(), recordingTerminalOperations = new Map();
    let resultTabLaunchPromise = null;
    const MILLISECONDS_PER_SECOND = 1000, SECONDS_PER_MINUTE = 60, SECONDS_PER_HOUR = 3600;
    const DELETE_AFTER_MINUTES = 10, DELETE_ALARM_PREFIX = 'delete:', RESULT_TAB_RETRY_ALARM = 'retry';
    const RESULT_TAB_CREATE_ATTEMPTS = 3, RESULT_TAB_RETRY_DELAY_MS = 0, RESULT_TAB_RETRY_ALARM_DELAY_MINUTES = 0.5;
    const RECOVERY_FINALIZE_ATTEMPTS = 3, CHECKPOINT_FINALIZE_DELAY_MS = 0;
    const ok = data => ({ ok: true, data }), fail = error => ({ ok: false, error });
    ${code}
    return { storeRecordingChunk, handleRecordingError, stopRecording, cancelRecording, recoverRecording, finalizeRecordingFromChunks, startRecordingSession, recoverInterruptedRecording, ensureCompletedRecordingResult };
  `)(env);
  return { api, parts, results, deleted, options, get chunks() { return chunks; }, get recording() { return recording; }, get state() { return state; }, set state(next) { state = next; } };
}

test('a failed later checkpoint must preserve previously saved recording data', async () => {
  const f = fixture();
  const response = await f.api.storeRecordingChunk({ chunk: { recordingId: 'clip', dataUrl: 'data:video/webm;base64,eA==', mimeType: 'video/webm' } });
  assert.equal(response.ok, false);
  assert.equal(f.chunks.length, 2);
  // Production saveDirectCheckpoints -> finishDirectRecording -> failDirectRecordingSession sends this message.
  await f.api.handleRecordingError({ recordingId: 'clip', error: response.error });
  assert.equal(f.deleted.length, 0, 'an encoder/checkpoint error must not delete all recoverable chunks');
  assert.equal(await f.parts[0].blob.text(), 'savedsaved');
  assert.equal(f.recording.endedAt, 2000);
});

test('stop must report success when checkpoint recovery saved the result', async () => {
  const f = fixture();
  const response = await f.api.stopRecording();
  assert.equal(f.parts.length, 1);
  assert.equal(f.results.length, 1);
  assert.equal(f.recording.id, 'clip');
  assert.equal(f.state.status, 'idle');
  assert.equal(response.ok, true, 'opening the saved result resets state to idle, which is still a successful recovery');
});

test('recovery uses only the contiguous prefix ending at a complete blob', async () => {
  for (const kind of ['unfinished-tail', 'missing-middle', 'changed-codec', 'unfinished-first']) {
    const f = fixture();
    const tail = { ...f.chunks[1], index: 3, blob: new Blob(['unsafe']) };
    if (kind === 'unfinished-tail') tail.completesBlob = false;
    if (kind === 'missing-middle') tail.index = 4;
    if (kind === 'changed-codec') tail.mimeType = 'video/mp4';
    if (kind === 'unfinished-first') f.chunks.forEach(chunk => { chunk.completesBlob = false; });
    else f.chunks.push(tail);
    assert.equal((await f.api.finalizeRecordingFromChunks('clip', 5000)).ok, false, 'normal finalization must still reject incomplete data');
    const recovered = await f.api.recoverRecording('clip', 5000);
    assert.equal(recovered, kind !== 'unfinished-first');
    assert.equal(f.deleted.length, 0);
    if (recovered) {
      assert.equal(await f.parts[0].blob.text(), 'savedsaved');
      assert.equal(f.recording.endedAt, 2000);
    } else {
      assert.equal(f.parts.length, 0);
      assert.equal(f.chunks.length, 2);
    }
  }
});

test('persistent storage failure preserves data and prevents a new start overwriting recovery', async () => {
  const f = fixture({ failFinalize: true });
  assert.equal((await f.api.handleRecordingError({ recordingId: 'clip', error: 'Storage full' })).ok, false);
  assert.equal(f.state.status, 'error');
  assert.equal(f.chunks.length, 2);
  assert.equal(f.deleted.length, 0);
  assert.equal((await f.api.startRecordingSession(true)).ok, false);
  assert.equal(f.state.recordingId, 'clip');
  f.options.failFinalize = false;
  await f.api.recoverInterruptedRecording();
  assert.equal(f.results.length, 1);
  assert.equal(f.state.status, 'idle');
});

test('explicit cancellation discards retained data and late errors do not affect another recording', async () => {
  const f = fixture({ failFinalize: true });
  await f.api.handleRecordingError({ recordingId: 'clip', error: 'Storage full' });
  await f.api.cancelRecording();
  assert.equal(f.state.status, 'idle');
  assert.deepEqual(f.deleted, ['clip']);
  assert.equal(await f.api.recoverRecording('clip', 5000), false);
  f.state = { status: 'recording', recordingId: 'new-clip', tabId: 7 };
  await f.api.handleRecordingError({ recordingId: 'clip', error: 'Late error' });
  assert.equal(f.state.recordingId, 'new-clip');
  assert.equal(f.state.status, 'recording');
  assert.deepEqual(f.deleted, ['clip']);
});

test('a state write failure after opening the result must reuse that tab on retry', async () => {
  const f = fixture({ failResultState: true });
  await f.api.recoverRecording('clip', 5000);
  await f.api.ensureCompletedRecordingResult();
  assert.equal(f.results.length, 1, 'post-open failure must not create a second result and duplicate its memory usage');
  assert.equal(f.state.status, 'idle');
});

test('an old result tab that navigated away cannot block delivery', async () => {
  const f = fixture();
  f.results.push({ url: 'https://example.org/' });
  f.state = { status: 'completed', recordingId: 'clip', tabId: 7, resultTabId: 8 };
  assert.equal(await f.api.ensureCompletedRecordingResult(), true);
  assert.equal(f.results.length, 2);
  assert.ok(f.results[1].url.includes('result/result.html?id=clip'));
  assert.equal(f.state.status, 'idle');
});
