import assert from "node:assert/strict";
import { estimateRangeSize, isFullTimeRange, normalizeTimeRange, parseTimeInput, snapTimeRangeValue, updateTimeRangeHandle } from "../dist/shared/time_range.js";

assert.deepEqual(normalizeTimeRange(-5, 80, 50), { start: 0, end: 50 });
assert.deepEqual(normalizeTimeRange(10, 40, 50), { start: 10, end: 40 });
assert.deepEqual(normalizeTimeRange(49.98, 49.99, 50), { start: 49.9, end: 50 });
assert.deepEqual(updateTimeRangeHandle({ start: 10, end: 40 }, "start", 45, 50), { start: 39.9, end: 40 });
assert.deepEqual(updateTimeRangeHandle({ start: 10, end: 40 }, "end", 5, 50), { start: 10, end: 10.1 });
assert.equal(isFullTimeRange({ start: 0, end: 50 }, 50), true);
assert.equal(isFullTimeRange({ start: 10, end: 40 }, 50), false);
assert.equal(estimateRangeSize(10_000, { start: 10, end: 40 }, 50), 6_000);
assert.equal(parseTimeInput("8.9"), 8.9);
assert.equal(parseTimeInput("00:08.9"), 8.9);
assert.equal(parseTimeInput("1:02:03"), 3_723);
assert.equal(Number.isNaN(parseTimeInput("1::3")), true);
assert.equal(snapTimeRangeValue(3.1, 3.143), 3.143);
assert.equal(snapTimeRangeValue(0.02, 3.143), 0);
assert.equal(snapTimeRangeValue(8.7, 20), 8.7);

console.log("time range checks passed");
