import { HIGH_RECORDING_FRAME_RATE, STANDARD_RECORDING_FRAME_RATE, STARTUP_SHORT_STALL_SECONDS, STARTUP_SHORT_STALL_WINDOW_SECONDS, STARTUP_STALL_WINDOW_SECONDS, WEBM_REPAIR_MIN_GAP_SECONDS, WEBM_REPAIR_MIN_OPENING_SECONDS } from "../shared/types.js";

interface VideoGap {
  start: number;
  end: number;
}

export function findRepairableVideoGaps(timestamps: number[], frameRate: number | undefined, { opening, middle }: { opening: boolean; middle: boolean }): VideoGap[] {
  const frames = [...new Set(timestamps.filter(time => Number.isFinite(time) && time >= 0))].sort((a, b) => a - b);
  const frameSeconds = 1 / (frameRate === HIGH_RECORDING_FRAME_RATE ? HIGH_RECORDING_FRAME_RATE : STANDARD_RECORDING_FRAME_RATE);
  const gaps: VideoGap[] = [];
  for (let index = opening ? 0 : 1; index < frames.length; index++) {
    const previous = frames[index - 1] ?? 0;
    const next = frames[index];
    const gap = next - previous;
    const openingGap = opening && previous < STARTUP_STALL_WINDOW_SECONDS
      && gap >= (previous < STARTUP_SHORT_STALL_WINDOW_SECONDS ? STARTUP_SHORT_STALL_SECONDS : WEBM_REPAIR_MIN_GAP_SECONDS);
    const middleGap = middle && previous >= WEBM_REPAIR_MIN_OPENING_SECONDS && gap >= WEBM_REPAIR_MIN_GAP_SECONDS;
    if ((openingGap || middleGap) && gap <= 2) {
      gaps.push({ start: previous + frameSeconds, end: next });
    }
  }
  const removed = getRemovedGapSeconds(gaps);
  return gaps.length <= 8 && removed <= 5 && (frames.at(-1) ?? 0) - removed >= 0.5 ? gaps : [];
}

export function getRemovedGapSeconds(gaps: readonly VideoGap[]): number {
  return gaps.reduce((seconds, gap) => seconds + gap.end - gap.start, 0);
}

export function buildGapRepairVideoTimestamps(gaps: readonly VideoGap[]): string {
  const shift = (timestamp: "PTS" | "DTS") => {
    const removed = gaps.map(({ start, end }) =>
      `gte(${timestamp}*TB,${(end - 0.0005).toFixed(6)})*${(end - start).toFixed(6)}`).join("+");
    return `${timestamp}-(${removed})/TB`;
  };
  return `setts=pts='${shift("PTS")}':dts='if(eq(DTS,NOPTS),DTS,${shift("DTS")})'`;
}

export function buildGapRepairAudioFilter(gaps: readonly VideoGap[]): string {
  const boundaries = [...gaps.map(({ start }) => start), undefined];
  const inputLabels = boundaries.map((_end, index) => `[a${index}]`).join("");
  const audio = boundaries.map((end, index) => {
    const start = index ? gaps[index - 1].end : 0;
    const trim = `atrim=start=${start.toFixed(6)}${end === undefined ? "" : `:end=${end.toFixed(6)}`}`;
    return `[a${index}]${trim},asetpts=PTS-STARTPTS[audio${index}]`;
  });
  const outputLabels = audio.map((_filter, index) => `[audio${index}]`).join("");
  return [`[0:a:0]asplit=${audio.length}${inputLabels}`, ...audio,
    `${outputLabels}concat=n=${audio.length}:v=0:a=1[a]`].join(";");
}
