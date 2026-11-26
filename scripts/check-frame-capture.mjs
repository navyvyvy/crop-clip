import assert from 'node:assert/strict';
import { createVideoFrameCapture, getNextRecordingFrameDeadline } from '../dist/content/frame_capture.js';

for (const sourceFps of [24, 30, 50, 60]) {
  const interval = 1000 / 30;
  let deadline = 140;
  let captured = 0;
  for (let index = 0; index < sourceFps * 10; index++) {
    const next = getNextRecordingFrameDeadline(140 + index * 1000 / sourceFps, deadline, interval);
    if (next === undefined) continue;
    deadline = next;
    captured++;
  }
  assert.equal(captured, Math.min(sourceFps, 30) * 10, `${sourceFps} fps input must keep the intended recording cadence`);
}
const afterDelay = getNextRecordingFrameDeadline(160, 100, 1000 / 30);
assert.ok(afterDelay > 160);
assert.equal(getNextRecordingFrameDeadline(161, afterDelay, 1000 / 30), undefined, 'delayed callbacks must not cause a catch-up burst');

assert.equal(createVideoFrameCapture({}, () => {}), null, 'unsupported browsers retain canvas recording');
const frames = [], writers = [], errors = [];
globalThis.VideoFrame = class {
  constructor(source, options = {}) {
    this.source = source;
    this.timestamp = options.timestamp ?? source.timestamp;
    frames.push(this);
  }
  close() { this.closed = true; this.source = null; }
};
globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };
globalThis.MediaStreamTrackGenerator = class {
  constructor() {
    const writer = { writes: [], aborted: false, released: false,
      write(frame) { this.writes.push(frame); return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; }); },
      abort() { this.aborted = true; this.reject?.(Error('aborted')); return Promise.resolve(); },
      releaseLock() { this.released = true; },
    };
    this.writable = { getWriter: () => writer }; this.writer = writer; writers.push(writer);
  }
  stop() { this.stopped = true; }
};
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const source = { timestamp: 1_000 }, canvas = {};
let draws = 0;
const drawFrame = () => { draws++; return canvas; };
const capture = createVideoFrameCapture(source, error => errors.push(error));
const writer = writers.at(-1), track = capture.stream.tracks[0];
assert.equal(capture.paint(drawFrame), true);
assert.equal(frames.at(-1).source, canvas, 'the encoder must receive the painted colors');
assert.equal(capture.paint(drawFrame), false, 'the caller must know when a frame did not reach the writer');
assert.equal(writer.writes.length, 1, 'a stalled writer must never accumulate frames');
writer.resolve(); await tick();
assert.equal(frames[0].closed, true);
assert.equal(capture.paint(drawFrame, false), false, 'stale display counters must not duplicate an unchanged source frame');
assert.equal(draws, 1, 'a busy encoder or duplicate frame must not trigger an additional draw');
assert.equal(frames.at(-1).closed, true, 'discarded source frames must be closed');
source.timestamp += 33_333;
assert.equal(capture.paint(drawFrame, false), true, 'a new source timestamp must survive a stale display counter');
assert.equal(writer.writes.length, 2);
writer.resolve(); await tick();
capture.paint(drawFrame);
writer.reject(Error('encoder pipe failed')); await tick();
assert.equal(errors.length, 1);
assert.match(errors[0].message, /encoder pipe failed/);
capture.paint(drawFrame);
capture.close(); capture.close(); await tick();
assert.equal(track.stopped, true);
assert.equal(writer.aborted, true);
assert.equal(writer.released, true);
assert.equal(frames.at(-1).closed, true, 'stop releases even a frame held by a stalled writer');
assert.equal(errors.length, 1, 'intentional shutdown must not report an encoder failure');
const writes = writer.writes.length;
capture.paint(drawFrame);
assert.equal(writer.writes.length, writes, 'closed capture must not resume');
console.log('frame capture color path, backpressure and cleanup checks passed');
