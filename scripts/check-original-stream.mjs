import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { getOriginalPlaylist, openOriginalStream, ORIGINAL_STREAM_PREFIXES, probeOriginalStream } from "../dist/content/original_stream.js";
import { MAX_ORIGINAL_STREAM_SECONDS } from "../dist/shared/time_range.js";

function u32(...values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32BE(value, index * 4));
  return bytes;
}

function box(type, ...payload) {
  return Buffer.concat([u32(8 + payload.reduce((size, bytes) => size + bytes.length, 0)), Buffer.from(type), ...payload]);
}

function fragment(timestamp) {
  return box("moof", box("traf", box("tfhd", u32(0, 1)), box("tfdt", u32(0, timestamp))));
}

const track = (id, kind, codec) => box("trak", box("tkhd", u32(0, 0, 0, id)),
  box("mdia", box("mdhd", u32(0, 0, 0, 1_000)), box("hdlr", u32(0, 0), Buffer.from(kind)),
    box("minf", box("stbl", box("stsd", u32(0, 1), box(codec))))));
const init = box("moov", track(1, "vide", "avc1"), track(2, "soun", "mp4a"));

// A generic MP4 MIME type can omit the video track's sample-entry code.
{
  class SourceBuffer { appendBuffer() {} }
  class MediaSource {
    activeSourceBuffers = [];
    addSourceBuffer() {
      const buffer = new SourceBuffer();
      this.activeSourceBuffers.push(buffer);
      return buffer;
    }
  }
  class HTMLVideoElement extends EventTarget { currentSrc = ""; }
  const listeners = new Map();
  const document = { addEventListener: (type, callback) => listeners.set(type, callback) };
  let urlIndex = 0;
  const objectUrls = { createObjectURL: () => `blob:${++urlIndex}` };
  runInNewContext(readFileSync(new URL("../dist/content/playback_codec.js", import.meta.url), "utf8"), {
    SourceBuffer, MediaSource, HTMLVideoElement, document, Event, URL: objectUrls,
  });
  const video = new HTMLVideoElement();
  const activeSource = new MediaSource();
  video.currentSrc = objectUrls.createObjectURL(activeSource);
  const buffer = activeSource.addSourceBuffer("video/mp4");
  let detected = false;
  video.addEventListener("cropclip-playback-hevc", () => { detected = true; });
  const detect = expected => {
    detected = false;
    listeners.get("cropclip-check-playback-codec")({ target: video });
    assert.equal(detected, expected);
  };
  detect(false);
  for (const codec of ["hvc1", "hev1"]) {
    buffer.appendBuffer(box("ftyp"));
    buffer.appendBuffer(box("moov", track(1, "vide", codec)));
    buffer.appendBuffer(fragment(120_000));
    detect(true);
  }
  buffer.appendBuffer(init);
  detect(false);
}
const url = new URL("https://ex-nlive-streaming.navercdn.com/fixture/live.m3u8");
const manifest = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\nfirst.m4v\n#EXTINF:2,\nlast.m4v\n";
const first = fragment(120_000), last = fragment(122_000);
const requested = [];
const realFetch = globalThis.fetch;
try {
  globalThis.fetch = async value => {
    const name = new URL(value).pathname.split("/").at(-1);
    requested.push(name);
    const data = { "live.m3u8": manifest, "init.mp4": init, "first.m4v": first, "last.m4v": last }[name];
    return new Response(data, { status: data ? 200 : 404 });
  };
  const source = await openOriginalStream(url, 121.69, new AbortController().signal);
  const chunks = [];
  const end = await source.record(async blob => { chunks.push(Buffer.from(await blob.arrayBuffer())); }, () => 122.4, () => 122.4);
  assert.equal(end, 122.4);
  assert.deepEqual(chunks, [Buffer.concat([init, first]), last], "keep the click's containing segment and stop after the endpoint is covered");
  await assert.rejects(() => source.record(() => assert.fail("the first chunk was already handed off"), () => 122.4, () => 122.4), /이미 시작/);
  assert.equal(requested.filter(name => name === "last.m4v").length, 1, "reuse the fragment fetched to find the timeline");
  const beforeRewind = requested.filter(name => name === "first.m4v").length;
  await assert.rejects(() => openOriginalStream(url, 119, new AbortController().signal), /클릭한 위치/);
  assert.equal(requested.filter(name => name === "first.m4v").length, beforeRewind, "do not fetch an unrelated first fragment after rewinding beyond the playlist");

  for (const codec of ["hvc1", "hev1"]) {
    const hevcInit = box("moov", track(1, "vide", codec), track(2, "soun", "mp4a"));
    globalThis.fetch = async value => {
      const name = new URL(value).pathname.split("/").at(-1);
      return new Response({ "live.m3u8": manifest, "init.mp4": hevcInit, "first.m4v": first, "last.m4v": last }[name]);
    };
    const recording = await openOriginalStream(url, 120.25, new AbortController().signal);
    const chunks = [];
    await recording.record(async blob => chunks.push(Buffer.from(await blob.arrayBuffer())), () => 121, () => 121);
    assert.deepEqual(chunks, [Buffer.concat([hevcInit, first])], "HEVC original fragments must be preserved without re-encoding");
  }

  globalThis.fetch = async value => {
    const name = new URL(value).pathname.split("/").at(-1);
    const tagged = manifest.replace("first.m4v", "#EXT-X-PROGRAM-DATE-TIME:2026-11-13T00:00:00Z\nfirst.m4v");
    return new Response({ "live.m3u8": tagged, "init.mp4": init, "first.m4v": first, "last.m4v": last }[name]);
  };
  const taggedSource = await openOriginalStream(url, 121.69, new AbortController().signal);
  const taggedChunks = [];
  await taggedSource.record(async blob => taggedChunks.push(Buffer.from(await blob.arrayBuffer())), () => 122.4, () => 122.4);
  assert.deepEqual(taggedChunks, [Buffer.concat([init, first]), last]);

  let finishRequested = false;
  let interruptedRequest = false;
  globalThis.fetch = async (value, options) => {
    const name = new URL(value).pathname.split("/").at(-1);
    if (name === "live.m3u8" && finishRequested) {
      return new Promise((_, reject) => options.signal.addEventListener("abort", () => {
        interruptedRequest = true;
        reject(options.signal.reason);
      }, { once: true }));
    }
    return new Response({ "live.m3u8": manifest, "init.mp4": init, "first.m4v": first, "last.m4v": last }[name]);
  };
  const slowTail = await openOriginalStream(url, 122.2, new AbortController().signal);
  const stopAt = performance.now();
  const partial = await slowTail.record(async () => {
    finishRequested = true;
    slowTail.stop();
  }, () => 125, () => 125);
  assert.equal(partial, 124, "save through the final complete fragment when the CDN stalls");
  assert.equal(interruptedRequest, true);
  assert.ok(performance.now() - stopAt < 3_800, "stop must not wait for the normal live fetch timeout");

  const requestsWithRange = [];
  globalThis.fetch = async (value, options) => {
    const name = new URL(value).pathname.split("/").at(-1);
    const range = options.headers?.Range;
    requestsWithRange.push([name, range]);
    const data = { "live.m3u8": manifest, "init.mp4": init, "first.m4v": first, "last.m4v": last }[name];
    return new Response(data, { status: range ? 206 : 200 });
  };
  const short = await openOriginalStream(url, 120.25, new AbortController().signal);
  const shortChunks = [];
  await short.record(async blob => { shortChunks.push(Buffer.from(await blob.arrayBuffer())); }, () => 121, () => 121);
  assert.deepEqual(shortChunks, [Buffer.concat([init, first])], "only complete fragments are stored");
  assert.deepEqual(requestsWithRange.filter(([name]) => name === "last.m4v"), [["last.m4v", "bytes=0-8191"]],
    "a fragment needed only to locate the click must not be downloaded in full");

  const payload = Buffer.concat([first, box("mdat", Buffer.alloc(2 * 1024 * 1024))]);
  const fragmentReads = [];
  const priorities = [];
  globalThis.fetch = async (value, options) => {
    const name = new URL(value).pathname.split("/").at(-1);
    priorities.push(options.priority);
    return new Response({ "live.m3u8": manifest, "init.mp4": init, "first.m4v": payload, "last.m4v": last }[name],
      { status: options.headers?.Range ? 206 : 200 });
  };
  const arrayBuffer = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = function () {
    fragmentReads.push(this.size);
    return arrayBuffer.call(this);
  };
  const largeFragmentChunks = [];
  try {
    const recording = await openOriginalStream(url, 120.25, new AbortController().signal);
    await recording.record(async blob => largeFragmentChunks.push(blob), () => 121, () => 121);
  } finally {
    Blob.prototype.arrayBuffer = arrayBuffer;
  }
  assert.ok(priorities.length > 0 && priorities.every(priority => priority === "low"), "original requests should yield to player requests");
  assert.ok(fragmentReads.some(size => size === 8192) && fragmentReads.every(size => size <= 8192),
    "only copy the fragment header when reading its timestamp");
  assert.deepEqual(Buffer.from(await largeFragmentChunks[0].arrayBuffer()), Buffer.concat([init, payload]));

  let playlistReads = 0;
  const newest = fragment(124_000);
  globalThis.fetch = async value => {
    const name = new URL(value).pathname.split("/").at(-1);
    if (name === "live.m3u8") return new Response(++playlistReads === 1 ? manifest : manifest + "#EXTINF:2,\nnewest.m4v\n");
    return new Response({ "init.mp4": init, "last.m4v": last, "newest.m4v": newest }[name]);
  };
  const liveEdge = await openOriginalStream(url, 124.3, new AbortController().signal);
  const liveEdgeChunks = [];
  assert.equal(await liveEdge.record(async blob => { liveEdgeChunks.push(Buffer.from(await blob.arrayBuffer())); }, () => 125, () => 125), 125);
  assert.deepEqual(liveEdgeChunks, [Buffer.concat([init, newest])], "wait for the live fragment that contains the original click");

  // A click inside a fragment keeps the same time limit at different bitrates.
  const timedPlaylist = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MAP:URI=\"init.mp4\"\n"
    + Array.from({ length: 152 }, (_, index) => `#EXTINF:2,\nclip-${index}.m4v\n`).join("");
  for (const bytesPerFragment of [2_125_000, 4_000_000]) {
    globalThis.fetch = async value => {
      const name = new URL(value).pathname.split("/").at(-1);
      if (name === "live.m3u8") return new Response(timedPlaylist);
      if (name === "init.mp4") return new Response(init);
      const index = Number(name.match(/^clip-(\d+)\.m4v$/)?.[1]);
      assert.ok(Number.isInteger(index));
      const data = Buffer.alloc(bytesPerFragment);
      fragment(120_000 + index * 2_000).copy(data);
      return new Response(data);
    };
    const recording = await openOriginalStream(url, 121.69, new AbortController().signal);
    let count = 0;
    const savedEnd = await recording.record(async () => { count++; }, () => 422, () => undefined);
    assert.equal(savedEnd, 121.69 + MAX_ORIGINAL_STREAM_SECONDS, "automatically stop at five minutes of media");
    assert.equal(count, 151, "save the final fragment even when the five-minute limit falls inside it");
  }

  globalThis.fetch = async () => new Response(manifest.replace("first.m4v", "https://example.test/unexpected.m4v"));
  await assert.rejects(() => openOriginalStream(url, 121, new AbortController().signal), /지원하지 않는 방송 주소/);
  globalThis.fetch = async () => new Response(manifest + "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n");
  await assert.rejects(() => openOriginalStream(url, 121, new AbortController().signal), /연속 저장을 지원하지 않는/);

  globalThis.fetch = async () => new Response(manifest.replace(/#EXTINF:[\d.]+/, `#EXTINF:${'9'.repeat(400)}`));
  await assert.rejects(() => openOriginalStream(url, 121, new AbortController().signal), /필요한 정보가 없습니다/);

  let reads = 0, cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (reads === 20) controller.close();
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(() => openOriginalStream(url, 121, new AbortController().signal));
  assert.equal(cancelled, true, 'oversized responses without Content-Length must be cancelled during reading');
  assert.ok(reads < 20, 'the response limit must apply before the entire body enters memory');
} finally {
  globalThis.fetch = realFetch;
}

console.log("original stream click alignment, stop and playlist validation checks passed");

const src = "blob:https://chzzk.naver.com/fixture";
const buffered = { length: 1, end: () => 50 };
const latest = { name: `${url.href}?_HLS_msn=11`, startTime: 20_000, duration: 1 };
const globals = Object.getOwnPropertyDescriptors(globalThis);
let emitResources, disconnected = false, appends = 0, registeredListeners = 0;
class TestSourceBuffer extends EventTarget {
  buffered = { length: 1, end: () => 48 };
  mode = "segments";
  timestampOffset = -120;
  appendBuffer() { appends++; }
  addEventListener(...args) {
    registeredListeners++;
    return super.addEventListener(...args);
  }
}
const originalAppend = TestSourceBuffer.prototype.appendBuffer;
const replacements = {
  document: { querySelectorAll: () => [{ currentSrc: src, paused: false, buffered }] },
  SourceBuffer: TestSourceBuffer,
  performance: { now: () => 20_001, getEntriesByType: () => [{ ...latest, startTime: 0 }] },
  PerformanceObserver: class {
    constructor(callback) { emitResources = entries => callback({ getEntries: () => entries }); }
    observe(options) { assert.deepEqual(options, { type: "resource" }); }
    disconnect() { disconnected = true; }
  },
};
try {
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const pending = probeOriginalStream(src, ORIGINAL_STREAM_PREFIXES);
  const buffer = new TestSourceBuffer();
  buffer.appendBuffer(new ArrayBuffer(1));
  assert.equal(disconnected, false, "old resource timing entries must not finish the probe");
  emitResources([latest, { ...latest, name: new URL("master.m3u8", url).href }]);
  assert.equal(disconnected, false, "appendBuffer has not updated the buffered ranges yet");
  buffer.buffered = buffered;
  buffer.dispatchEvent(new Event("updateend"));
  assert.deepEqual(await pending, { ok: true, data: { offset: -120, playlist: latest.name } });
  assert.equal(appends, 1);
  assert.equal(disconnected, true);
  assert.equal(TestSourceBuffer.prototype.appendBuffer, originalAppend, "restore playback and release the observer after finding the stream");

  const superseded = probeOriginalStream(src, ORIGINAL_STREAM_PREFIXES);
  const replacement = probeOriginalStream(src, ORIGINAL_STREAM_PREFIXES);
  assert.equal((await superseded).ok, false);
  buffer.appendBuffer(new ArrayBuffer(1));
  emitResources([latest]);
  assert.equal((await replacement).ok, true);
  assert.equal(TestSourceBuffer.prototype.appendBuffer, originalAppend, "a retry must not restore an expired probe");

  const cdnPlaylist = new URL("https://livecloud.pstatic.net/fixture/live.m3u8?_HLS_msn=11&_HLS_part=0");
  const cdnProbe = probeOriginalStream(src, ORIGINAL_STREAM_PREFIXES);
  buffer.appendBuffer(new ArrayBuffer(1));
  emitResources([{ ...latest, name: cdnPlaylist.href }]);
  assert.deepEqual(await cdnProbe, { ok: true, data: { offset: -120, playlist: cdnPlaylist.href } });
  assert.equal(TestSourceBuffer.prototype.appendBuffer, originalAppend);
  const cdnSourceUrl = getOriginalPlaylist(cdnPlaylist.href);
  assert.equal(cdnSourceUrl.href, "https://livecloud.pstatic.net/fixture/live.m3u8");
  try {
    globalThis.fetch = async value => {
      const fragmentUrl = new URL(value);
      assert.equal(fragmentUrl.origin, cdnSourceUrl.origin);
      return new Response({ "/fixture/live.m3u8": manifest, "/fixture/init.mp4": init, "/fixture/first.m4v": first, "/fixture/last.m4v": last }[fragmentUrl.pathname]);
    };
    const source = await openOriginalStream(cdnSourceUrl, 121.69, new AbortController().signal);
    const chunks = [];
    await source.record(async blob => chunks.push(Buffer.from(await blob.arrayBuffer())), () => 122.4, () => 122.4);
    assert.deepEqual(chunks, [Buffer.concat([init, first]), last]);
  } finally {
    globalThis.fetch = realFetch;
  }

  const unrecognized = probeOriginalStream(src, ORIGINAL_STREAM_PREFIXES);
  emitResources([{ ...latest, name: "https://alternate.example.test:8443/fixture/chunklist.m3u8?signature=fixture" }]);
  assert.deepEqual(await unrecognized, {
    ok: false,
    error: "원본 목록을 찾지 못했습니다.\n감지한 호스트 · alternate.example.test:8443",
  });
  assert.equal(TestSourceBuffer.prototype.appendBuffer, originalAppend);

  const wrapped = probeOriginalStream(src, ORIGINAL_STREAM_PREFIXES);
  const probeHook = TestSourceBuffer.prototype.appendBuffer;
  TestSourceBuffer.prototype.appendBuffer = function (...args) { return probeHook.apply(this, args); };
  buffer.appendBuffer(new ArrayBuffer(1));
  emitResources([latest]);
  assert.equal((await wrapped).ok, true);
  const listenersAfterFinish = registeredListeners;
  buffer.appendBuffer(new ArrayBuffer(1));
  assert.equal(registeredListeners, listenersAfterFinish, "a retained hook must not register listeners after completion");
  TestSourceBuffer.prototype.appendBuffer = originalAppend;
} finally {
  for (const key of Object.keys(replacements)) {
    if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
    else delete globalThis[key];
  }
}
console.log("original stream observes fresh playlist requests when the browser's history is stale");

const connectorPlaylist = "http://localhost:17080/chzzk/kr/fixture/1080p/live.m3u8?channel_id=fixture&stream_id=1";
assert.equal(getOriginalPlaylist(`${connectorPlaylist}&_HLS_msn=11&_HLS_part=0`).href, connectorPlaylist);
assert.throws(() => getOriginalPlaylist("http://localhost:17080/other/live.m3u8"), /지원하지 않는/);
assert.throws(() => getOriginalPlaylist("http://localhost:17081/chzzk/live.m3u8"), /지원하지 않는/);
assert.throws(() => getOriginalPlaylist("https://livecloud.pstatic.net.invalid/live.m3u8"), /지원하지 않는/);
await assert.rejects(async () => {
  try {
    globalThis.fetch = async () => new Response(manifest.replace("first.m4v", "/other/first.m4v"));
    await openOriginalStream(getOriginalPlaylist(connectorPlaylist), 121, new AbortController().signal);
  } finally {
    globalThis.fetch = realFetch;
  }
}, /지원하지 않는 방송 주소/);
