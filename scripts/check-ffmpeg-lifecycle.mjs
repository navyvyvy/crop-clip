import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const text = fs.readFileSync(new URL("../src/result/result.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("result.ts", text, ts.ScriptTarget.Latest, true);
const compile = (code) => ts.transpile(code, { target: ts.ScriptTarget.ES2022 });
const cleanupBlocks = [];
function visit(node) {
  if (ts.isTryStatement(node) && node.finallyBlock?.getText(file).includes("hideSplitProgress();")) {
    cleanupBlocks.push(node.finallyBlock.getText(file));
  }
  ts.forEachChild(node, visit);
}
visit(file);
assert.equal(cleanupBlocks.length, 5, "cover preview, trim, conversion, speed and split completion");
for (const block of cleanupBlocks) {
  let releases = 0;
  await new Function("releaseFfmpeg", "hideSplitProgress", "setSplitBusy", `return (async () => ${compile(block)})();`)(
    async () => { releases++; }, () => {}, () => {},
  );
  assert.equal(releases, 1, "completed jobs must release the idle conversion engine");
}

const functions = file.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ["loadFfmpeg", "releaseFfmpeg"].includes(node.name?.text)).map(node => node.getText(file)).join("\n");
const instances = [];
let failLoad = false;
class FFmpeg {
  terminated = false;
  constructor() { instances.push(this); }
  on() {}
  async load() { if (failLoad) throw new Error("load failed"); }
  terminate() { this.terminated = true; }
}
const code = compile(functions).replace(/import\(chrome\.runtime\.getURL\([^)]*\)\)/g, "Promise.resolve({ FFmpeg })");
const api = new Function("FFmpeg", `
  let ffmpegLoadPromise = null;
  const chrome = { runtime: { getURL: x => x } };
  const setWorkStatus = () => {}, setFfmpegProgressBase = () => {};
  const FFMPEG_LOAD_START_PERCENT = 3, FFMPEG_READY_PERCENT = 8;
  ${code}
  return { loadFfmpeg, releaseFfmpeg };
`)(FFmpeg);
const first = await api.loadFfmpeg();
assert.equal(await api.loadFfmpeg(), first, "reuse the engine within a batch");
await api.releaseFfmpeg();
assert.equal(first.terminated, true);
const second = await api.loadFfmpeg();
assert.notEqual(second, first, "next job can reload the engine");
await api.releaseFfmpeg();
await api.releaseFfmpeg();
failLoad = true;
await assert.rejects(api.loadFfmpeg(), /load failed/);
assert.equal(instances.at(-1).terminated, true, "failed loads must release their worker");
failLoad = false;
await api.loadFfmpeg();
await api.releaseFfmpeg();
assert.ok(instances.every(instance => instance.terminated));
const releaseSource = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "releaseVideoSource");
const revoked = [];
const releaseVideoSource = new Function("URL", `${compile(releaseSource.getText(file))}; return releaseVideoSource;`)(
  { revokeObjectURL: url => revoked.push(url) },
);
for (const ownsUrl of [false, true]) {
  const video = {
    src: "blob:preview", paused: false, readyState: 4, isConnected: true,
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === "src") this.src = ""; },
    load() { if (!this.src) this.readyState = 0; },
    remove() { this.isConnected = false; },
  };
  releaseVideoSource(video, "blob:preview", ownsUrl);
  assert.equal(video.paused, true);
  assert.equal(video.readyState, 0, "detached preview must release its decoder");
  assert.equal(video.isConnected, false);
  assert.equal(revoked.length, Number(ownsUrl), "only revoke URLs owned by the temporary video");
}
console.log("FFmpeg lifecycle checks passed");

const rangeSource = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "recordVideoRange");
for (const failure of ["constructor", "start", "play", "encoder", "video", "timeout", "none"]) {
  const track = { readyState: "live", stop() { this.readyState = "ended"; } };
  const timers = new Map(), listeners = new Set();
  let encoder;
  class Video extends EventTarget {
    currentTime = 0;
    ended = false;
    paused = true;
    captureStream() { return { getTracks: () => [track] }; }
    pause() { this.paused = true; }
    async play() {
      if (failure === "play") throw new Error("play failed");
      this.paused = false;
      queueMicrotask(() => {
        if (failure === "encoder") encoder.onerror();
        else if (failure === "video") this.dispatchEvent(new Event("error"));
        else if (failure === "timeout") timers.values().next().value();
        else { this.currentTime = 10; this.dispatchEvent(new Event("timeupdate")); }
      });
    }
    addEventListener(name, listener, options) { listeners.add(listener); super.addEventListener(name, listener, options); }
    removeEventListener(name, listener) { listeners.delete(listener); super.removeEventListener(name, listener); }
  }
  class Recorder {
    state = "inactive";
    constructor() { if (failure === "constructor") throw new Error("constructor failed"); encoder = this; }
    start() { if (failure === "start") throw new Error("start failed"); this.state = "recording"; }
    stop() {
      this.state = "inactive";
      queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(["video"]) }); this.onstop?.(); });
    }
  }
  const recordRange = new Function("MediaRecorder", "window", `
    const seekVideo = async () => {}, MILLISECONDS_PER_SECOND = 1000, MEDIA_EVENT_TIMEOUT_MS = 30000;
    const prepareRecordingEncoder = async () => {};
    ${compile(rangeSource.getText(file))}
    return recordVideoRange;
  `)(Recorder, { setTimeout(fn) { timers.set(1, fn); return 1; }, clearTimeout(id) { timers.delete(id); } });
  const video = new Video();
  const result = recordRange(video, 0, 10, "video/webm");
  if (failure === "none") assert.ok((await result).size > 0);
  else await assert.rejects(result);
  assert.equal(track.readyState, "ended", failure + ": release captured tracks on every exit");
  assert.equal(video.paused, true, failure + ": pause the temporary player");
  assert.equal(timers.size, 0, failure + ": cancel range timeout");
  assert.equal(listeners.size, 0, failure + ": remove playback listeners");
}
console.log("recorder conversion cleanup checks passed");
