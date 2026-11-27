import { MAX_ORIGINAL_STREAM_SECONDS } from "../shared/time_range.js";
import type { MessageResponse } from "../shared/messages.js";
import { boxes, readMp4Tracks } from "../shared/mp4_boxes.js";

const CONNECTOR_STREAM_PREFIX = "http://localhost:17080/chzzk/";
const SLIGHT_SLIT_HOST = "nvelop-slight-slit.pstatic.net";
export const ORIGINAL_STREAM_PREFIXES = [
  "https://ex-nlive-streaming.navercdn.com/",
  "https://nvelop-livecloud.pstatic.net/",
  "https://livecloud.pstatic.net/",
  `https://${SLIGHT_SLIT_HOST}/`,
  `http://${SLIGHT_SLIT_HOST}/`,
  CONNECTOR_STREAM_PREFIX,
];
const FETCH_TIMEOUT_MS = 4_000;
const STOP_FRAGMENT_TIMEOUT_MS = 3_000;
const POLL_MS = 700;
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;
const TIMELINE_HEADER_BYTES = 8 * 1024;
const TIMELINE_HEADER_RANGE = `bytes=0-${TIMELINE_HEADER_BYTES - 1}`;
const TIMELINE_TOLERANCE_SECONDS = 0.15;

export type OriginalStreamProbe = { offset: number; playlists: string[] };
export type OriginalPlaybackTiming = { offset?: number; seekStartedAt?: number };

// Injected into the player page after clicking record. Keep this function self-contained.
export function probeOriginalStream(src: string, prefixes: string[], bufferedOnly = false): Promise<MessageResponse<OriginalStreamProbe>> {
  return new Promise(resolve => {
    let video = Array.from(document.querySelectorAll("video")).find(item => item.currentSrc === src && !item.paused);
    if (!video || typeof SourceBuffer === "undefined") {
      resolve({ ok: false, error: "원본 재생 정보를 읽을 수 없습니다." });
      return;
    }
    type ProbeHook = SourceBuffer["appendBuffer"] & { cancelCropClipProbe?: () => void };
    (SourceBuffer.prototype.appendBuffer as ProbeHook).cancelCropClipProbe?.();
    let timing: OriginalPlaybackTiming | undefined;
    const receive = (event: Event) => { timing = (event as CustomEvent<OriginalPlaybackTiming>).detail; };
    video.addEventListener("cropclip-playback-offset", receive, { once: true });
    video.dispatchEvent(new Event("cropclip-read-playback-offset", { bubbles: true }));
    video.removeEventListener("cropclip-playback-offset", receive);
    const seekStartedAt = timing?.seekStartedAt ?? Infinity;
    const choosePlaylists = (entries: PerformanceEntry[]): PerformanceEntry[] => {
      const cutoff = Math.min(performance.now() - 6_000, seekStartedAt);
      const candidates = entries.filter(({ name, startTime, duration }) => startTime + duration >= cutoff
        && /^https?:\/\/[^?]+\.m3u8(?:\?|$)/.test(name)
        && prefixes.some(prefix => name.startsWith(prefix)))
        .map(entry => {
          const url = new URL(entry.name);
          const completedAt = entry.startTime + entry.duration;
          const priority = completedAt >= seekStartedAt ? 2 : Number(url.searchParams.has("_HLS_msn"));
          // Deduplicate polling positions without changing the URL used to fetch the playlist.
          url.searchParams.delete("_HLS_msn");
          url.searchParams.delete("_HLS_part");
          return { entry, key: url.href, priority, completedAt };
        })
        .sort((a, b) => b.priority - a.priority || b.completedAt - a.completedAt);
      const selected = new Map<string, PerformanceEntry>();
      for (const { entry, key } of candidates) {
        if (!selected.has(key)) selected.set(key, entry);
        if (selected.size === 3) break;
      }
      return [...selected.values()];
    };
    let playlists = choosePlaylists(performance.getEntriesByType("resource"));
    let offset = timing?.offset;
    if (offset !== undefined && Number.isFinite(offset) && playlists.length) {
      resolve({ ok: true, data: { offset, playlists: playlists.map(playlist => playlist.name) } });
      return;
    }
    if (!Number.isFinite(offset)) offset = undefined;
    if (bufferedOnly) {
      resolve({ ok: false, error: "재생 중인 원본 위치를 바로 확인하지 못했습니다." });
      return;
    }
    const original = SourceBuffer.prototype.appendBuffer;
    let finished = false;
    const listeners = new Map<SourceBuffer, () => void>();
    const finish = (result: MessageResponse<OriginalStreamProbe>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      observer.disconnect();
      for (const [buffer, listener] of listeners) buffer.removeEventListener("updateend", listener);
      listeners.clear();
      video = undefined;
      playlists = [];
      if (SourceBuffer.prototype.appendBuffer === sample) SourceBuffer.prototype.appendBuffer = original;
      resolve(result);
    };
    const tryFinish = () => {
      if (offset !== undefined && playlists.length) finish({ ok: true, data: { offset, playlists: playlists.map(playlist => playlist.name) } });
    };
    function sample(this: SourceBuffer, buffer: BufferSource): void {
      original.call(this, buffer);
      if (finished || listeners.has(this)) return;
      const check = () => readOffset(this);
      listeners.set(this, check);
      this.addEventListener("updateend", check);
      readOffset(this);
    }
    function readOffset(buffer: SourceBuffer): void {
      try {
        if (video?.currentSrc !== src || !video.buffered.length || !buffer.buffered.length || buffer.mode !== "segments") return;
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        if (Math.abs(end - video.buffered.end(video.buffered.length - 1)) < 0.15 && Number.isFinite(buffer.timestampOffset)) {
          offset = buffer.timestampOffset;
          tryFinish();
        }
      } catch {
        // The player can remove its source buffer while changing streams.
      }
    }
    const observer = new PerformanceObserver(list => {
      playlists = choosePlaylists([...playlists, ...list.getEntries()]);
      tryFinish();
    });
    const timer = setTimeout(() => {
      finish({ ok: false, error: playlists.length ? "방송의 재생 시각을 원본과 맞추지 못했습니다." : "이 재생 방식의 원본 목록을 찾지 못했습니다." });
    }, 3_000);
    (sample as ProbeHook).cancelCropClipProbe = () => finish({ ok: false, error: "새 원본 탐색을 시작했습니다." });
    SourceBuffer.prototype.appendBuffer = sample;
    observer.observe({ type: "resource" });
  });
}

export class OriginalStreamError extends Error {}

class OriginalStreamNotReadyError extends OriginalStreamError {
  constructor(readonly availableThrough: number) {
    super("클릭한 위치의 원본 조각이 아직 준비되지 않았습니다.");
  }
}

interface Track { id: number; timescale: number }
interface Segment { duration: number; url: string; programDateTime?: number }

function readVideoTrack(init: ArrayBuffer): Track {
  const data = new DataView(init);
  let videoTrack: Track | undefined;
  let hasAac = false;
  for (const { kind, codec, headers, media } of readMp4Tracks(data)) {
    if (kind === 0x736f756e && codec === "mp4a") hasAac = true;
    if (kind !== 0x76696465 || !["avc1", "avc3", "hvc1", "hev1"].includes(codec)) continue;
    const tkhd = headers.find(box => box.type === "tkhd");
    const mdhd = media.find(box => box.type === "mdhd");
    if (!tkhd || !mdhd) continue;
    const id = data.getUint32(tkhd.start + (data.getUint8(tkhd.start) === 1 ? 20 : 12));
    const timescale = data.getUint32(mdhd.start + (data.getUint8(mdhd.start) === 1 ? 20 : 12));
    if (id && timescale) videoTrack = { id, timescale };
  }
  if (videoTrack && hasAac) return videoTrack;
  throw new OriginalStreamError("H.264 또는 H.265 영상과 AAC 음성이 있는 방송만 원본 저장을 지원합니다.");
}

function fragmentStart(fragment: ArrayBuffer, track: Track): number {
  const data = new DataView(fragment);
  for (const moof of boxes(data).filter(box => box.type === "moof")) {
    for (const traf of boxes(data, moof.start, moof.end).filter(box => box.type === "traf")) {
      const headers = boxes(data, traf.start, traf.end);
      const tfhd = headers.find(box => box.type === "tfhd");
      const tfdt = headers.find(box => box.type === "tfdt");
      if (!tfhd || !tfdt || tfhd.start + 8 > tfhd.end || data.getUint32(tfhd.start + 4) !== track.id) continue;
      const wide = data.getUint8(tfdt.start) === 1;
      if (tfdt.start + (wide ? 12 : 8) > tfdt.end) break;
      return (wide ? Number(data.getBigUint64(tfdt.start + 4)) : data.getUint32(tfdt.start + 4)) / track.timescale;
    }
  }
  throw new OriginalStreamError("원본 조각의 시작 시간을 읽지 못했습니다.");
}

async function readFragmentStart(fragment: Blob, track: Track): Promise<number> {
  const header = await fragment.slice(0, TIMELINE_HEADER_BYTES).arrayBuffer();
  try {
    return fragmentStart(header, track);
  } catch (error) {
    if (fragment.size === header.byteLength) throw error;
    return fragmentStart(await fragment.arrayBuffer(), track);
  }
}

function originalUrl(value: string, base?: URL): URL {
  const url = new URL(value, base);
  if (url.protocol === "http:" && url.host === SLIGHT_SLIT_HOST) url.protocol = "https:";
  return url;
}

function mediaUrl(value: string, base: URL): string {
  const url = originalUrl(value, base);
  if (url.origin !== base.origin || !ORIGINAL_STREAM_PREFIXES.some(prefix => url.href.startsWith(prefix)) || url.username || url.password) {
    throw new OriginalStreamError("지원하지 않는 방송 주소입니다.");
  }
  return url.href;
}

function parsePlaylist(text: string, url: URL): { init: string; sequence: number; segments: Segment[] } {
  if (!text.startsWith("#EXTM3U") || /#EXT-X-KEY:METHOD=(?!NONE\b)|#EXT-X-BYTERANGE:|^#EXT-X-(?:DISCONTINUITY|ENDLIST)\s*$/m.test(text)) {
    throw new OriginalStreamError("연속 저장을 지원하지 않는 원본 재생 목록입니다.");
  }
  const map = text.match(/^#EXT-X-MAP:URI="([^"]+)"\s*$/m)?.[1];
  const sequence = Number(text.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)\s*$/m)?.[1]);
  const segments: Segment[] = [];
  let duration: number | undefined;
  let programDateTime: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      duration = Number(line.slice(8).split(",", 1)[0]);
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const time = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length));
      programDateTime = Number.isFinite(time) ? time : undefined;
    } else if (duration !== undefined && line && !line.startsWith("#")) {
      segments.push({ duration, programDateTime, url: mediaUrl(line, url) });
      duration = undefined;
      programDateTime = undefined;
    }
  }
  if (!map || !Number.isSafeInteger(sequence) || !segments.length || segments.some(item => !Number.isFinite(item.duration) || item.duration <= 0)) {
    throw new OriginalStreamError("원본 재생 목록에 필요한 정보가 없습니다.");
  }
  return { init: mediaUrl(map, url), sequence, segments };
}

export function getOriginalPlaylist(value: string): URL {
  const url = originalUrl(value);
  if (!ORIGINAL_STREAM_PREFIXES.some(prefix => url.href.startsWith(prefix)) || !url.pathname.endsWith(".m3u8") || url.username || url.password) {
    throw new OriginalStreamError("지원하지 않는 원본 재생 목록 주소입니다.");
  }
  // Keep the original encoding of CDN signatures while removing the live-edge polling position.
  url.search = url.search.slice(1).split("&").filter(part => {
    const parameter = new URLSearchParams(part);
    return !parameter.has("_HLS_msn") && !parameter.has("_HLS_part");
  }).join("&");
  return url;
}

async function fetchOriginal(url: string | URL, signal: AbortSignal, range?: string): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    cache: "no-store",
    redirect: "error",
    priority: "low",
    headers: range ? { Range: range } : undefined,
  });
  if (!response.ok || Number(response.headers.get("Content-Length")) > MAX_FRAGMENT_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new OriginalStreamError("원본 방송 데이터를 받지 못했습니다.");
  }
  return response;
}

async function readOriginalBody(response: Response): Promise<Blob> {
  const reader = response.body?.getReader();
  if (!reader) throw new OriginalStreamError("원본 방송 데이터가 비어 있습니다.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FRAGMENT_BYTES) throw new OriginalStreamError("원본 조각 크기가 올바르지 않습니다.");
      chunks.push(value.buffer instanceof ArrayBuffer
        ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        : value.slice());
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size === 0) throw new OriginalStreamError("원본 방송 데이터가 비어 있습니다.");
  return new Blob(chunks);
}

async function fetchFragment(url: string, signal: AbortSignal): Promise<Blob> {
  return readOriginalBody(await fetchOriginal(url, signal));
}

export async function openMatchingOriginalStream(playlists: string[], startSeconds: number, signal: AbortSignal, waitForLiveFragment: boolean) {
  const urls = [...new Set(playlists.map(playlist => getOriginalPlaylist(playlist).href))];
  if (urls.length === 1) return openOriginalStream(new URL(urls[0]), startSeconds, signal, { waitForLiveFragment });
  let waitFor: { url: URL; availableThrough: number } | undefined;
  let lastError: unknown = new OriginalStreamError("이 재생 방식의 원본 목록을 찾지 못했습니다.");
  for (const value of urls) {
    signal.throwIfAborted();
    const url = new URL(value);
    const attempt = new AbortController();
    const deadline = setTimeout(() => attempt.abort(), 1_000);
    try {
      return await openOriginalStream(url, startSeconds, AbortSignal.any([signal, attempt.signal]), { waitForLiveFragment: false });
    } catch (error) {
      attempt.abort();
      signal.throwIfAborted();
      lastError = error;
      if (error instanceof OriginalStreamNotReadyError && (!waitFor || error.availableThrough > waitFor.availableThrough)) {
        waitFor = { url, availableThrough: error.availableThrough };
      }
    } finally {
      clearTimeout(deadline);
    }
  }
  if (waitForLiveFragment && waitFor) return openOriginalStream(waitFor.url, startSeconds, signal);
  throw lastError;
}

export async function openOriginalStream(url: URL, startSeconds: number, signal: AbortSignal, { waitForLiveFragment = true } = {}) {
  const loadPlaylist = async (requestSignal = signal) =>
    parsePlaylist(await (await readOriginalBody(await fetchOriginal(url, requestSignal))).text(), url);
  let playlist = await loadPlaylist();
  const initUrl = playlist.init;
  const initPromise = fetchFragment(initUrl, signal);
  const trackPromise = initPromise.then(async init => readVideoTrack(await init.arrayBuffer()));
  const readTail = async (tailUrl: string) => {
    const [track, probe] = await Promise.all([
      trackPromise,
      fetchOriginal(tailUrl, signal, TIMELINE_HEADER_RANGE).catch(() => fetchOriginal(tailUrl, signal)),
    ]);
    const header = await readOriginalBody(probe);
    let complete = probe.status === 206 ? undefined : header;
    let start: number;
    try {
      start = await readFragmentStart(header, track);
    } catch (error) {
      if (complete) throw error;
      complete = await fetchFragment(tailUrl, signal);
      start = await readFragmentStart(complete, track);
    }
    return { start, complete };
  };
  let lastIndex = playlist.segments.length - 1;
  let lastUrl = playlist.segments[lastIndex].url;
  let tail = await readTail(lastUrl);
  // Low-latency playback can reach a fragment before it is listed as complete.
  for (let retry = 0; startSeconds >= tail.start + playlist.segments[lastIndex].duration; retry++) {
    if (!waitForLiveFragment || retry === 3) throw new OriginalStreamNotReadyError(tail.start + playlist.segments[lastIndex].duration);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
    playlist = await loadPlaylist();
    if (playlist.init !== initUrl) throw new OriginalStreamError("원본 방송 재생 경로가 바뀌었습니다.");
    lastIndex = playlist.segments.length - 1;
    const nextUrl = playlist.segments[lastIndex].url;
    if (lastUrl !== nextUrl) {
      lastUrl = nextUrl;
      tail = await readTail(lastUrl);
    }
  }
  const init = await initPromise;
  const track = await trackPromise;
  let last = tail.complete;
  tail.complete = undefined;
  let index = lastIndex;
  let expectedStart = tail.start;
  const tailDate = playlist.segments[lastIndex].programDateTime;
  while (index > 0 && startSeconds < expectedStart) {
    const { duration, programDateTime } = playlist.segments[--index];
    // Small differences in EXTINF can accumulate across a long DVR playlist.
    expectedStart = tailDate !== undefined && programDateTime !== undefined && programDateTime < tailDate
      ? tail.start - (tailDate - programDateTime) / 1000
      : expectedStart - duration;
  }
  if (tailDate === undefined && startSeconds < expectedStart - TIMELINE_TOLERANCE_SECONDS * (lastIndex + 1)) {
    throw new OriginalStreamError("클릭한 위치의 원본 조각을 찾지 못했습니다.");
  }
  let first: Blob;
  let savedThrough: number;
  let lower = 0;
  let upper = lastIndex;
  let estimateFromFragment = true;
  for (;;) {
    const segment = playlist.segments[index];
    const cachedFirst = index === lastIndex ? last : undefined;
    first = cachedFirst ?? await fetchFragment(segment.url, signal);
    const firstStart = cachedFirst ? tail.start : await readFragmentStart(first, track);
    savedThrough = firstStart + segment.duration;
    if (startSeconds >= firstStart && startSeconds < savedThrough) break;
    if (startSeconds < firstStart) upper = index - 1;
    else lower = index + 1;
    if (lower > upper) throw new OriginalStreamError("클릭한 위치의 원본 조각을 찾지 못했습니다.");
    index = estimateFromFragment
      ? Math.max(lower, Math.min(upper, index + Math.floor((startSeconds - firstStart) / segment.duration)))
      : Math.floor((lower + upper) / 2);
    estimateFromFragment = false;
  }
  if (index === lastIndex) last = undefined;
  let next = playlist.sequence + index + 1;
  const limit = startSeconds + MAX_ORIGINAL_STREAM_SECONDS;
  let firstChunk: Blob | undefined = new Blob([init, first], { type: "video/mp4" });
  const stopDeadline = new AbortController();
  const requestSignal = AbortSignal.any([signal, stopDeadline.signal]);
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    stop() {
      stopTimer ??= setTimeout(() => stopDeadline.abort(), STOP_FRAGMENT_TIMEOUT_MS);
    },
    async record(onChunk: (blob: Blob) => Promise<void>, getPosition: () => number, getEnd: () => number | undefined): Promise<number> {
      try {
        return await recordFragments(onChunk, getPosition, getEnd);
      } catch (error) {
        if (stopDeadline.signal.aborted && error === stopDeadline.signal.reason && !signal.aborted && savedThrough > startSeconds) {
          return Math.min(savedThrough, getEnd() ?? limit);
        }
        throw error;
      } finally {
        clearTimeout(stopTimer);
      }
    },
  };

  async function recordFragments(onChunk: (blob: Blob) => Promise<void>, getPosition: () => number, getEnd: () => number | undefined): Promise<number> {
    if (!firstChunk) throw new OriginalStreamError("원본 녹화가 이미 시작되었습니다.");
    const chunk = firstChunk;
    firstChunk = undefined;
    await onChunk(chunk);
    let current = playlist;
    let lastProgress = performance.now();
    while (!requestSignal.aborted) {
      const requestedEnd = getEnd();
      const end = Math.min(requestedEnd ?? limit, limit);
      const position = getPosition();
      if (savedThrough >= end && (requestedEnd !== undefined || position >= limit)) return end;
      if (requestedEnd === undefined && savedThrough >= Math.min(position, limit)) {
        lastProgress = performance.now();
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        continue;
      }
      const segment = current.segments[next - current.sequence];
      if (!segment) {
        if (performance.now() - lastProgress >= FETCH_TIMEOUT_MS * 2) throw new Error("새 방송 조각을 받지 못했습니다.");
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
        current = await loadPlaylist(requestSignal);
        if (current.init !== playlist.init || next < current.sequence) throw new Error("원본 방송 재생 경로가 바뀌었습니다.");
        continue;
      }
      const cached = next === playlist.sequence + lastIndex && segment.url === lastUrl ? last : undefined;
      const fragment = cached ?? await fetchFragment(segment.url, requestSignal);
      if (cached) last = undefined;
      const start = cached ? tail.start : await readFragmentStart(fragment, track);
      if (Math.abs(start - savedThrough) > TIMELINE_TOLERANCE_SECONDS) throw new Error("원본 방송 조각이 연속되지 않습니다.");
      await onChunk(new Blob([fragment], { type: "video/mp4" }));
      savedThrough = start + segment.duration;
      next++;
      lastProgress = performance.now();
    }
    throw requestSignal.reason;
  }
}
