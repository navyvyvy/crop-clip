import assert from 'node:assert/strict';
import { normalizeSettings, normalizeRegion } from '../dist/shared/normalize.js';
import { DEFAULT_SETTINGS } from '../dist/shared/types.js';

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
assert.equal(normalizeSettings({ customVideoBitsPerSecond: 2_000_000, enableSeekButtons: true }).videoBitsPerSecond, 2_000_000);
assert.equal(normalizeSettings({ enableSeekButtons: true }).enableSeek, true);
for (const value of [null, undefined, 7, 'broken', { x: 0, y: 0, width: 0, height: 4 }]) assert.equal(normalizeRegion(value), null);
const region = { x: 1, y: 2, width: 300, height: 200 };
assert.deepEqual(normalizeRegion(region), region);
assert.equal(normalizeRegion({ ...region, x: { toString: 'invalid' } }), null);
assert.deepEqual(normalizeRegion({ ...region, videoRelative: { x: [], y: 0, width: 1, height: 1 } }), region);
console.log('state normalization checks passed');
