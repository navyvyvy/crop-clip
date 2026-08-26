export interface TimeRange {
  start: number;
  end: number;
}

export const TIME_STEP_SECONDS = 0.1;
export const MILLISECONDS_PER_SECOND = 1_000;
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3_600;
const BYTES_PER_MEGABYTE = 1_000_000;
const SIZE_SPLIT_SAFETY_RATIO = 0.9;
const FLOATING_POINT_PRECISION_DIGITS = 10;
const SPLIT_COUNT_EPSILON = 1e-6;
const MAX_TIME_INPUT_PARTS = 3;

export type TimeRangeHandle = "start" | "end";

export function normalizeTimeRange(start: number, end: number, duration: number): TimeRange {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  if (safeDuration === 0) {
    return { start: 0, end: 0 };
  }

  const minimum = Math.min(TIME_STEP_SECONDS, safeDuration);
  const safeStart = Number.isFinite(start) ? Math.max(0, Math.min(start, safeDuration - minimum)) : 0;
  const safeEnd = Number.isFinite(end) ? Math.max(safeStart + minimum, Math.min(end, safeDuration)) : safeDuration;
  return { start: safeStart, end: safeEnd };
}

export function updateTimeRangeHandle(
  range: TimeRange,
  handle: TimeRangeHandle,
  value: number,
  duration: number,
): TimeRange {
  const minimum = Math.min(TIME_STEP_SECONDS, Math.max(0, duration));
  return handle === "start"
    ? normalizeTimeRange(Math.min(value, range.end - minimum), range.end, duration)
    : normalizeTimeRange(range.start, Math.max(value, range.start + minimum), duration);
}

export function snapTimeRangeValue(value: number, duration: number, step = TIME_STEP_SECONDS): number {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  if (value <= step / 2) {
    return 0;
  }
  if (value >= duration - step / 2) {
    return duration;
  }
  return Number((Math.round(value / step) * step).toFixed(FLOATING_POINT_PRECISION_DIGITS));
}

export function isFullTimeRange(range: TimeRange, duration: number): boolean {
  const tolerance = TIME_STEP_SECONDS / 2;
  return range.start < tolerance && Math.abs(range.end - duration) < tolerance;
}

export function estimateRangeSize(totalBytes: number, range: TimeRange, duration: number): number {
  if (duration <= 0) {
    return totalBytes;
  }
  return Math.round(totalBytes * Math.max(0, range.end - range.start) / duration);
}

export function megabytesToBytes(megabytes: number): number {
  return megabytes * BYTES_PER_MEGABYTE;
}

export function bytesToMegabytes(bytes: number): number {
  return bytes / BYTES_PER_MEGABYTE;
}

export function floorTimeToStep(seconds: number): number {
  const stepsPerSecond = 1 / TIME_STEP_SECONDS;
  return Math.floor(seconds * stepsPerSecond) / stepsPerSecond;
}

export function getNextSizeSplitSeconds(currentSeconds: number, maxBytes: number, largestBytes: number): number {
  const proportional = floorTimeToStep(currentSeconds * maxBytes / largestBytes * SIZE_SPLIT_SAFETY_RATIO);
  return Math.max(TIME_STEP_SECONDS, Math.min(currentSeconds - TIME_STEP_SECONDS, proportional));
}

export function getExpectedSplitCount(duration: number, segmentSeconds: number): number {
  if (!Number.isFinite(duration) || !Number.isFinite(segmentSeconds) || duration <= 0 || segmentSeconds <= 0) {
    return 0;
  }
  return Math.ceil(duration / segmentSeconds - SPLIT_COUNT_EPSILON);
}

export function parseSegmentTimeList(value: string): TimeRange[] {
  return value.trim().split(/\r?\n/).flatMap((line) => {
    const columns = line.split(",");
    const start = Number(columns.at(-2));
    const end = Number(columns.at(-1));
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [{ start, end }] : [];
  });
}

export function parseTimeInput(value: string): number {
  const tokens = value.trim().split(":");
  if (tokens.length === 0 || tokens.length > MAX_TIME_INPUT_PARTS || tokens.some((token) => token.trim() === "")) {
    return Number.NaN;
  }
  const parts = tokens.map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return Number.NaN;
  }
  return parts.reduce((total, part) => total * SECONDS_PER_MINUTE + part, 0);
}
