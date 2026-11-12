import { MAX_ORIGINAL_STREAM_SECONDS } from "../shared/time_range.js";
import type { MessageResponse } from "../shared/messages.js";

const CONNECTOR_STREAM_PREFIX = "http://localhost:17080/chzzk/";
export const ORIGINAL_STREAM_PREFIXES = ["https://ex-nlive-streaming.navercdn.com/", "https://nvelop-livecloud.pstatic.net/", CONNECTOR_STREAM_PREFIX];
const FETCH_TIMEOUT_MS = 4_000;
const POLL_MS = 700;
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;
const TIMELINE_HEADER_RANGE = "bytes=0-8191";
// shortcut: Budget for 5 minutes at 8.5 Mbps until the result page can remux without loading the full input.
const MAX_RECORDING_BYTES = 8_500_000 * MAX_ORIGINAL_STREAM_SECONDS / 8;

export type OriginalStreamProbe = { offset: number; playlist: string };

// Injected into the player page after clicking record. Keep this function self-contained.
export function probeOriginalStream(src: string, prefixes: string[]): Promise<MessageResponse<OriginalStreamProbe>> {
  return new Promise(resolve => {
    const video = Array.from(document.querySelectorAll("video")).find(item => item.currentSrc === src && !item.paused);
    if (!video || typeof SourceBuffer === "undefined") {
      resolve({ ok: false, error: "원본 재생 정보를 읽을 수 없습니다." });
      return;
    }
    const original = SourceBuffer.prototype.appendBuffer;
    const isPlaylist = (entry: PerformanceEntry) => prefixes.some(prefix => entry.name.startsWith(prefix))
      && /\.m3u8(?:\?|$)/.test(entry.name);
    const choosePlaylist = (entries: PerformanceEntry[]) => {
      const candidates = entries.filter(isPlaylist).reverse();
      return candidates.find(entry => new URL(entry.name).searchParams.has("_HLS_msn")) ?? candidates[0];
    };
    let playlist = choosePlaylist(performance.getEntriesByType("resource")
      .filter(entry => performance.now() - (entry.startTime + entry.duration) <= 6_000));
    let offset: number | undefined;
    const finish = (result: MessageResponse<OriginalStreamProbe>) => {
      clearTimeout(timer);
      observer.disconnect();
      if (SourceBuffer.prototype.appendBuffer === sample) SourceBuffer.prototype.appendBuffer = original;
      resolve(result);
    };
    const tryFinish = () => {
      if (offset !== undefined && playlist) finish({ ok: true, data: { offset, playlist: playlist.name } });
    };
    function sample(this: SourceBuffer, buffer: BufferSource): void {
      original.call(this, buffer);
      try {
        if (video?.currentSrc !== src || !video.buffered.length || !this.buffered.length || this.mode !== "segments") return;
        const end = this.buffered.end(this.buffered.length - 1);
        if (Math.abs(end - video.buffered.end(video.buffered.length - 1)) < 0.15 && Number.isFinite(this.timestampOffset)) {
          offset = this.timestampOffset;
          tryFinish();
        }
      } catch {
        // The player can remove its source buffer while changing streams.
      }
    }
    const observer = new PerformanceObserver(list => {
      const candidate = choosePlaylist(list.getEntries());
      if (candidate && (!playlist || new URL(candidate.name).searchParams.has("_HLS_msn")
        || !new URL(playlist.name).searchParams.has("_HLS_msn"))) playlist = candidate;
      tryFinish();
    });
    const timer = setTimeout(() => finish({
      ok: false,
      error: playlist ? "방송의 재생 시각을 원본과 맞추지 못했습니다." : "이 재생 방식의 원본 목록을 찾지 못했습니다.",
    }), 3_000);
    SourceBuffer.prototype.appendBuffer = sample;
    observer.observe({ type: "resource" });
  });
}

export class OriginalStreamError extends Error {}

interface Box { type: string; start: number; end: number }
interface Track { id: number; timescale: number }
interface Segment { duration: number; url: string }

function boxes(data: DataView, start = 0, end = data.byteLength): Box[] {
  const result: Box[] = [];
  for (let pos = start; pos + 8 <= end;) {
    const size = data.getUint32(pos);
    if (size < 8 || size > end - pos) break;
    const type = String.fromCharCode(...new Uint8Array(data.buffer, data.byteOffset + pos + 4, 4));
    result.push({ type, start: pos + 8, end: pos + size });
    pos += size;
  }
  return result;
}

function readVideoTrack(init: ArrayBuffer): Track {
  const data = new DataView(init);
  const moov = boxes(data).find(box => box.type === "moov");
  let videoTrack: Track | undefined;
  let hasAac = false;
  for (const track of moov ? boxes(data, moov.start, moov.end) : []) {
    if (track.type !== "trak") continue;
    const headers = boxes(data, track.start, track.end);
    const tkhd = headers.find(box => box.type === "tkhd");
    const media = headers.find(box => box.type === "mdia");
    if (!tkhd || !media) continue;
    const children = boxes(data, media.start, media.end);
    const handler = children.find(box => box.type === "hdlr");
    const mdhd = children.find(box => box.type === "mdhd");
    const minf = children.find(box => box.type === "minf");
    const stbl = minf && boxes(data, minf.start, minf.end).find(box => box.type === "stbl");
    const stsd = stbl && boxes(data, stbl.start, stbl.end).find(box => box.type === "stsd");
    if (!handler || !mdhd || !stsd || handler.start + 12 > handler.end) continue;
    const codec = boxes(data, stsd.start + 8, stsd.end)[0]?.type;
    const kind = data.getUint32(handler.start + 8);
    if (kind === 0x736f756e && codec === "mp4a") hasAac = true;
    if (kind !== 0x76696465 || (codec !== "avc1" && codec !== "avc3")) continue;
    const id = data.getUint32(tkhd.start + (data.getUint8(tkhd.start) === 1 ? 20 : 12));
    const timescale = data.getUint32(mdhd.start + (data.getUint8(mdhd.start) === 1 ? 20 : 12));
    if (id && timescale) videoTrack = { id, timescale };
  }
  if (videoTrack && hasAac) return videoTrack;
  throw new OriginalStreamError("H.264 영상과 AAC 음성이 함께 있는 방송만 원본 저장을 지원합니다.");
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

function mediaUrl(value: string, base: URL): string {
  const url = new URL(value, base);
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
  const segments = [...text.matchAll(/^#EXTINF:([\d.]+)[^\n]*\n([^#\r\n][^\r\n]*)/gm)].map(([, duration, path]) => ({
    duration: Number(duration), url: mediaUrl(path, url),
  }));
  if (!map || !Number.isSafeInteger(sequence) || !segments.length || segments.some(item => !(item.duration > 0))) {
    throw new OriginalStreamError("원본 재생 목록에 필요한 정보가 없습니다.");
  }
  return { init: mediaUrl(map, url), sequence, segments };
}

export function getOriginalPlaylist(value: string): URL {
  const url = new URL(value);
  if (!ORIGINAL_STREAM_PREFIXES.some(prefix => url.href.startsWith(prefix)) || !url.pathname.endsWith(".m3u8") || url.username || url.password) {
    throw new OriginalStreamError("지원하지 않는 원본 재생 목록 주소입니다.");
  }
  url.searchParams.delete("_HLS_msn");
  url.searchParams.delete("_HLS_part");
  return url;
}

async function fetchOriginal(url: string | URL, signal: AbortSignal, range?: string): Promise<Response> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    cache: "no-store",
    redirect: "error",
    headers: range ? { Range: range } : undefined,
  });
  if (!response.ok || Number(response.headers.get("Content-Length")) > MAX_FRAGMENT_BYTES) {
    throw new OriginalStreamError("원본 방송 데이터를 받지 못했습니다.");
  }
  return response;
}

async function readFragment(response: Response): Promise<ArrayBuffer> {
  const data = await response.arrayBuffer();
  if (data.byteLength === 0 || data.byteLength > MAX_FRAGMENT_BYTES) throw new OriginalStreamError("원본 조각 크기가 올바르지 않습니다.");
  return data;
}

async function fetchFragment(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  return readFragment(await fetchOriginal(url, signal));
}

export async function openOriginalStream(url: URL, startSeconds: number, signal: AbortSignal) {
  const loadPlaylist = async () => parsePlaylist(await (await fetchOriginal(url, signal)).text(), url);
  let playlist = await loadPlaylist();
  const initUrl = playlist.init;
  const initPromise = fetchFragment(initUrl, signal);
  const trackPromise = initPromise.then(readVideoTrack);
  const readTail = async (tailUrl: string) => {
    const [track, probe] = await Promise.all([
      trackPromise,
      fetchOriginal(tailUrl, signal, TIMELINE_HEADER_RANGE).catch(() => fetchOriginal(tailUrl, signal)),
    ]);
    const header = await readFragment(probe);
    let complete = probe.status === 206 ? undefined : header;
    let start: number;
    try {
      start = fragmentStart(header, track);
    } catch (error) {
      if (complete) throw error;
      complete = await fetchFragment(tailUrl, signal);
      start = fragmentStart(complete, track);
    }
    return { start, complete };
  };
  let lastIndex = playlist.segments.length - 1;
  let lastUrl = playlist.segments[lastIndex].url;
  let tail = await readTail(lastUrl);
  // Low-latency playback can reach a fragment before it is listed as complete.
  for (let retry = 0; startSeconds >= tail.start + playlist.segments[lastIndex].duration; retry++) {
    if (retry === 3) throw new OriginalStreamError("클릭한 위치의 원본 조각이 아직 준비되지 않았습니다.");
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
  let index = lastIndex;
  let expectedStart = tail.start;
  while (index > 0 && startSeconds < expectedStart) expectedStart -= playlist.segments[--index].duration;
  const first = (index === lastIndex ? last : undefined) ?? await fetchFragment(playlist.segments[index].url, signal);
  if (index === lastIndex) last = undefined;
  const firstStart = fragmentStart(first, track);
  let savedThrough = firstStart + playlist.segments[index].duration;
  if (startSeconds < firstStart || startSeconds >= savedThrough || Math.abs(firstStart - expectedStart) > 0.15) {
    throw new OriginalStreamError("클릭한 위치의 원본 조각을 찾지 못했습니다.");
  }
  let next = playlist.sequence + index + 1;
  let size = init.byteLength + first.byteLength;
  const limit = startSeconds + MAX_ORIGINAL_STREAM_SECONDS;
  // The first and last fragments include samples outside the requested interval.
  const maxInputBytes = MAX_RECORDING_BYTES + size + MAX_FRAGMENT_BYTES;

  return {
    async record(onChunk: (blob: Blob) => Promise<void>, getPosition: () => number, getEnd: () => number | undefined): Promise<number> {
      await onChunk(new Blob([init, first], { type: "video/mp4" }));
      let current = playlist;
      let lastProgress = performance.now();
      while (!signal.aborted) {
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
          current = await loadPlaylist();
          if (current.init !== playlist.init || next < current.sequence) throw new Error("원본 방송 재생 경로가 바뀌었습니다.");
          continue;
        }
        const cached = next === playlist.sequence + lastIndex && segment.url === lastUrl ? last : undefined;
        const fragment = cached ?? await fetchFragment(segment.url, signal);
        if (cached) last = undefined;
        if (size + fragment.byteLength > maxInputBytes) return Math.min(savedThrough, end);
        const start = fragmentStart(fragment, track);
        if (Math.abs(start - savedThrough) > 0.15) throw new Error("원본 방송 조각이 연속되지 않습니다.");
        await onChunk(new Blob([fragment], { type: "video/mp4" }));
        size += fragment.byteLength;
        savedThrough = start + segment.duration;
        next++;
        lastProgress = performance.now();
      }
      throw signal.reason;
    },
  };
}
