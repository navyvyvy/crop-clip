import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { downloadSourcesAndConfirm } from '../dist/result/downloads.js';

function mockDownloads({ state = 'in_progress', failStart = false, failSearch = false } = {}) {
  const started = [], listeners = new Set(), urls = new Set();
  URL.createObjectURL = () => { const url = `blob:test-${started.length}`; urls.add(url); return url; };
  URL.revokeObjectURL = url => urls.delete(url);
  globalThis.window = { setTimeout: callback => setTimeout(callback, 0) };
  globalThis.chrome = { downloads: {
    async download(options) {
      if (failStart) throw Error('start failed');
      started.push(options);
      return started.length;
    },
    async search() {
      if (failSearch) throw Error('search failed');
      return [{ state }];
    },
    onChanged: {
      addListener: listener => listeners.add(listener),
      removeListener: listener => listeners.delete(listener),
    },
  } };
  return { started, urls, listeners, finish(id, state = 'complete') {
    for (const listener of [...listeners]) listener({ id, state: { current: state } });
  } };
}

const items = [2, 4, 1, 3].map(index => ({ source: new Blob([String(index)]), filename: `clip_${String(index).padStart(3, '0')}.webm` }));
for (const reverseOrder of [false, true]) {
  const mock = mockDownloads();
  const pending = downloadSourcesAndConfirm(items, reverseOrder);
  const expected = reverseOrder ? [4, 3, 2, 1] : [1, 2, 3, 4];
  for (const [index, number] of expected.entries()) {
    await wait(20);
    assert.equal(mock.started.length, index + 1, 'the next file must wait for the previous download to complete');
    assert.equal(mock.started[index].filename, `clip_${String(number).padStart(3, '0')}.webm`);
    assert.equal(mock.urls.size, 1, 'only the active download may retain its temporary URL');
    mock.finish(999); // An unrelated download must not advance the batch.
    await wait(5);
    assert.equal(mock.started.length, index + 1);
    mock.finish(index + 1);
  }
  await pending;
  assert.equal(mock.urls.size, 0);
  assert.equal(mock.listeners.size, 0);
}

for (const options of [{}, { failStart: true }, { failSearch: true }]) {
  const mock = mockDownloads(options);
  const pending = downloadSourcesAndConfirm(items, true).catch(error => error);
  await wait(10);
  if (!options.failStart && !options.failSearch) mock.finish(1, 'interrupted');
  assert.ok(await pending instanceof Error);
  assert.equal(mock.started.length, options.failStart ? 0 : 1, 'a failed or cancelled download must stop the batch');
  assert.equal(mock.urls.size, 0);
  assert.equal(mock.listeners.size, 0);
}

const complete = mockDownloads({ state: 'complete' });
await downloadSourcesAndConfirm(items, true);
assert.equal(complete.started.length, 4, 'a download completed before event registration must still advance');
assert.equal(complete.urls.size, 0);
assert.equal(complete.listeners.size, 0);
console.log('ordered download completion and cleanup checks passed');
