import assert from 'node:assert/strict';
import { createVideoFrameCapture } from '../dist/content/frame_capture.js';

assert.equal(createVideoFrameCapture({}, 640, 360, () => {}), null, 'unsupported browsers retain canvas recording');
const frames = [], writers = [], errors = [];
globalThis.VideoFrame = class {
  constructor(source, options) {
    if (options.visibleRect?.x % 2) throw Error('unaligned chroma');
    this.source = source instanceof VideoFrame ? source.source : source;
    this.options = options;
    this.visibleRect = options.visibleRect ?? source.visibleRect ?? { x: 0, y: 0, width: 640, height: 360 };
    this.displayWidth = options.displayWidth ?? 640; this.displayHeight = options.displayHeight ?? 360;
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
const crop = { x: 80, y: 90, width: 320, height: 180 };
const placement = { crop, dx: 0, dy: 0, dw: 640, dh: 360 };
const source = {}, canvas = {};
let fallbackCalls = 0;
const fallback = () => { fallbackCalls++; return canvas; };
const capture = createVideoFrameCapture(source, 640, 360, error => errors.push(error));
const writer = writers.at(-1), track = capture.stream.tracks[0];
capture.paint(placement, fallback);
assert.equal(frames.at(-1).source, source);
assert.deepEqual(frames.at(-1).options.visibleRect, crop);
assert.equal(frames.at(-1).options.displayWidth, 640);
assert.equal(fallbackCalls, 0);
capture.paint(placement, fallback);
assert.equal(writer.writes.length, 1, 'a stalled writer must never accumulate frames');
writer.resolve(); await tick();
assert.equal(frames[0].closed, true);
capture.paint({ ...placement, crop: { ...crop, x: 81 } }, fallback);
assert.equal(frames.at(-1).source, canvas, 'unaligned crops preserve the exact canvas crop');
writer.resolve(); await tick();
capture.paint({ ...placement, dx: 10 }, fallback);
assert.equal(frames.at(-1).source, canvas, 'letterboxing retains the original canvas layout');
writer.resolve(); await tick();
capture.paint(placement, fallback);
writer.reject(Error('encoder pipe failed')); await tick();
assert.equal(errors.length, 1);
assert.match(errors[0].message, /encoder pipe failed/);
capture.paint(placement, fallback);
capture.close(); capture.close(); await tick();
assert.equal(track.stopped, true);
assert.equal(writer.aborted, true);
assert.equal(writer.released, true);
assert.equal(frames.at(-1).closed, true, 'stop releases even a frame held by a stalled writer');
assert.equal(errors.length, 1, 'intentional shutdown must not report an encoder failure');
const writes = writer.writes.length;
capture.paint(placement, fallback);
assert.equal(writer.writes.length, writes, 'closed capture must not resume');
const mp4Capture = createVideoFrameCapture(source, 640, 360, error => errors.push(error), false);
mp4Capture.paint({ ...placement, crop: { x: 0, y: 0, width: 640, height: 360 } }, fallback);
assert.equal(frames.at(-1).source, source, 'uncropped MP4 recording retains direct frame delivery');
writers.at(-1).resolve(); await tick();
mp4Capture.paint(placement, fallback);
assert.equal(frames.at(-1).source, canvas, 'MP4 crops must normalize pixels through canvas before encoding');
writers.at(-1).resolve(); await tick();
mp4Capture.close(); await tick();
console.log('native frame capture crop, backpressure and cleanup checks passed');
