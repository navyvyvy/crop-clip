import assert from 'node:assert/strict';
import { getRegionLimit, normalizeSettings, normalizeRegion, normalizeRecordingState } from '../dist/shared/normalize.js';
import { getPlayerRecordingState } from '../dist/content/player_state.js';
import { DEFAULT_SETTINGS } from '../dist/shared/types.js';
import { loadAppState, loadRecordingState } from '../dist/shared/storage.js';

for (const value of [undefined, null, 7, 'broken', []]) {
  assert.deepEqual(normalizeSettings(value), DEFAULT_SETTINGS, 'missing or invalid settings must restore defaults');
}
const repaired = normalizeSettings({
  shortcutKeys: { regionRecord: 7, fullRecord: 'E', cancelRecording: {}, selectRegion: null },
  enable60fps: 'false', allowMutedRecording: 'true', enableShortcuts: {},
  seekSeconds: 999, multiRegionMaxCount: -1, videoBitsPerSecond: NaN,
});
assert.equal(repaired.shortcutKeys.regionRecord, 'r');
assert.equal(repaired.shortcutKeys.fullRecord, 'e');
assert.equal(repaired.shortcutKeys.cancelRecording, 'c');
assert.equal(repaired.enable60fps, false);
assert.equal(repaired.allowMutedRecording, false);
assert.equal(repaired.enableShortcuts, false);
assert.equal(repaired.seekSeconds, 60);
assert.equal(repaired.multiRegionMaxCount, 2);
assert.equal(repaired.videoBitsPerSecond, DEFAULT_SETTINGS.videoBitsPerSecond);
assert.equal(normalizeSettings({}).videoBitsPerSecond, 8_000_000);
assert.equal(normalizeSettings({ videoBitsPerSecond: 6_000_000 }).videoBitsPerSecond, 6_000_000);
assert.equal(normalizeSettings({ customVideoBitsPerSecond: 2_000_000, enableSeekButtons: true }).videoBitsPerSecond, 2_000_000);
assert.equal(normalizeSettings({ enableSeekButtons: true }).enableSeek, true);
assert.equal(normalizeSettings({ enableSeek: false, enableSeekButtons: true }).enableSeek, false);
assert.equal(normalizeSettings({ enableSeek: 'invalid', enableSeekButtons: true }).enableSeek, true);
assert.equal(normalizeSettings({ customVideoBitsPerSecond: 'invalid', videoBitsPerSecond: 4_000_000 }).videoBitsPerSecond, 4_000_000);
assert.equal(normalizeSettings({ customVideoBitsPerSecond: 2_000_000, videoBitsPerSecond: 8_500_000 }).videoBitsPerSecond, 8_500_000);
assert.equal(normalizeSettings({ videoBitsPerSecond: 16_000_000 }).videoBitsPerSecond, 16_000_000);
assert.equal(normalizeSettings({ videoBitsPerSecond: 20_000_000 }).videoBitsPerSecond, 16_000_000);
assert.equal(normalizeSettings({ outputFormat: 'mp4', recordingCodec: 'hevc' }).recordingCodec, 'hevc');
assert.equal(normalizeSettings({ outputFormat: 'webm', recordingCodec: 'hevc' }).recordingCodec, 'auto');
const repairedShortcuts = normalizeSettings({ shortcutKeys: { selectRegion: 'r', clearRegion: 'r' } }).shortcutKeys;
assert.equal(repairedShortcuts.selectRegion, 'r');
assert.equal(new Set(Object.values(repairedShortcuts)).size, Object.keys(repairedShortcuts).length);
assert.equal(normalizeSettings({}).showRecordingSize, false);
assert.equal(normalizeSettings({ showRecordingSize: true }).showRecordingSize, true);
assert.equal(normalizeSettings({ enableAutoDownloadRecording: true }).autoFocusResult, true);
assert.equal(normalizeSettings({ autoFocusResult: false, keepResultOpenOnAutoDownload: true }).autoFocusResult, false);
assert.equal(normalizeSettings({ autoSplitMode: 'wrong' }).autoSplitMode, 'half');
assert.equal(normalizeSettings({ enableAutoSplitRecording: true }).autoSplitAfterSeconds, 35);
assert.equal(normalizeSettings({ autoSplitMode: 'thirds', autoSplitAfterSeconds: 41.5 }).autoSplitAfterSeconds, 42);
assert.equal(normalizeSettings({ autoSplitIntervalSeconds: -1 }).autoSplitIntervalSeconds, 1);
assert.equal(normalizeSettings({ autoSplitMode: 'size', autoSplitMaxMegabytes: -10 }).autoSplitMaxMegabytes, 1);
assert.equal(normalizeSettings({ autoSplitMode: 'quarters' }).autoSplitMode, 'quarters');
assert.equal(normalizeSettings({ autoSplitFormat: 'webm' }).autoSplitFormat, 'webm');
assert.equal(normalizeSettings({ autoSplitMode: 'thirds' }).autoSplitFormat, 'mp4');
assert.equal(getRegionLimit(normalizeSettings({ multiRegionMaxCount: 4 })), 1);
assert.equal(getRegionLimit(normalizeSettings({ enableMultiRegion: true, multiRegionMaxCount: 8 })), 4);
assert.equal(getRegionLimit(normalizeSettings({ enableMultiRegion: true, multiRegionMaxCount: 2.6 })), 3);
for (const value of [null, undefined, 7, 'broken', { x: 0, y: 0, width: 0, height: 4 }]) assert.equal(normalizeRegion(value), null);
const region = { x: 1, y: 2, width: 300, height: 200 };
assert.deepEqual(normalizeRegion(region), region);
assert.equal(normalizeRegion({ ...region, x: { toString: 'invalid' } }), null);
assert.deepEqual(normalizeRegion({ ...region, videoRelative: { x: [], y: 0, width: 1, height: 1 } }), region);
console.log('state normalization checks passed');

for (const recordingState of [undefined, null, {}, { status: 'recording', recordingId: 'active', tabId: 3, startedAt: NaN }, { status: 'broken', mode: 'invalid' }]) {
  const reads = [];
  globalThis.chrome = { storage: { local: { async get(defaults) {
    reads.push(Object.keys(defaults));
    return Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key,
      key === 'recordingState' && recordingState !== undefined ? recordingState : value]));
  } } } };
  const expected = (await loadAppState()).recordingState;
  assert.deepEqual(await loadRecordingState(), expected, 'targeted reads must retain normalization and defaults');
  assert.deepEqual(reads.at(-1), ['recordingState'], 'recording updates must not read settings and regions');
}
console.log('targeted recording state reads passed');

for (const storedRegions of [undefined, null, [], [region]]) {
  globalThis.chrome = { storage: { local: { async get(defaults) {
    return { ...defaults, region, ...(storedRegions === undefined ? {} : { regions: storedRegions }) };
  } } } };
  assert.deepEqual((await loadAppState()).regions, storedRegions ?? [region],
    'old single-region saves must load without reviving an explicitly empty region list');
}

const active = normalizeRecordingState({ status: 'recording', recordingId: 'recording-tab', startedAt: 1_000, mode: 'full' });
assert.deepEqual(getPlayerRecordingState(active, 'recording-tab'), { status: 'recording', startedAt: 1_000, mode: 'full' });
assert.deepEqual(getPlayerRecordingState(active, 'other-tab'), { status: 'idle', recordingElsewhere: true, mode: 'full' });
assert.deepEqual(getPlayerRecordingState(active), { status: 'idle', recordingElsewhere: true, mode: 'full' });
assert.deepEqual(getPlayerRecordingState(normalizeRecordingState({ status: 'unexpected', mode: 'full' })), { status: 'idle' });
