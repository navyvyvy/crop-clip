import assert from "node:assert/strict";
import { getOriginalPlaylist, openOriginalStream, ORIGINAL_STREAM_PREFIXES, probeOriginalStream } from "../dist/content/original_stream.js";

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
  assert.equal(requested.filter(name => name === "last.m4v").length, 1, "reuse the fragment fetched to find the timeline");
  await assert.rejects(() => openOriginalStream(url, 119, new AbortController().signal), /클릭한 위치/);

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

  // A click inside a fragment must still fit five minutes at 8.5 Mbps.
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
    if (bytesPerFragment === 2_125_000) {
      assert.equal(savedEnd, 421.69, "automatically stop at five minutes of media");
      assert.equal(count, 151, "save the final fragment even when the five-minute limit falls inside it");
    } else {
      assert.ok(savedEnd < 421.69, "stop early if the memory budget is reached first");
      assert.equal(savedEnd, 120 + count * 2, "save through the last complete fragment");
    }
  }

  globalThis.fetch = async () => new Response(manifest.replace("first.m4v", "https://example.test/unexpected.m4v"));
  await assert.rejects(() => openOriginalStream(url, 121, new AbortController().signal), /지원하지 않는 방송 주소/);
  globalThis.fetch = async () => new Response(manifest + "#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n");
  await assert.rejects(() => openOriginalStream(url, 121, new AbortController().signal), /연속 저장을 지원하지 않는/);
} finally {
  globalThis.fetch = realFetch;
}

console.log("original stream click alignment, stop and playlist validation checks passed");

const src = "blob:https://chzzk.naver.com/fixture";
const buffered = { length: 1, end: () => 50 };
const latest = { name: `${url.href}?_HLS_msn=11`, startTime: 20_000, duration: 1 };
const globals = Object.getOwnPropertyDescriptors(globalThis);
let emitResources, disconnected = false, appends = 0;
class TestSourceBuffer {
  buffered = buffered;
  mode = "segments";
  timestampOffset = -120;
  appendBuffer() { appends++; }
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
  new TestSourceBuffer().appendBuffer(new ArrayBuffer(1));
  assert.equal(disconnected, false, "old resource timing entries must not finish the probe");
  emitResources([latest, { ...latest, name: new URL("master.m3u8", url).href }]);
  assert.deepEqual(await pending, { ok: true, data: { offset: -120, playlist: latest.name } });
  assert.equal(appends, 1);
  assert.equal(disconnected, true);
  assert.equal(TestSourceBuffer.prototype.appendBuffer, originalAppend, "restore playback and release the observer after finding the stream");
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
await assert.rejects(async () => {
  try {
    globalThis.fetch = async () => new Response(manifest.replace("first.m4v", "/other/first.m4v"));
    await openOriginalStream(getOriginalPlaylist(connectorPlaylist), 121, new AbortController().signal);
  } finally {
    globalThis.fetch = realFetch;
  }
}, /지원하지 않는 방송 주소/);
