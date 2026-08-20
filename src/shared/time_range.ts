export interface TimeRange {
  start: number;
  end: number;
}

export const MIN_TIME_RANGE_SECONDS = 0.1;
export const BYTES_PER_MEGABYTE = 1_000_000;

export type TimeRangeHandle = "start" | "end";

export function normalizeTimeRange(start: number, end: number, duration: number): TimeRange {
  const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  if (safeDuration === 0) {
    return { start: 0, end: 0 };
  }

  const minimum = Math.min(MIN_TIME_RANGE_SECONDS, safeDuration);
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
  const minimum = Math.min(MIN_TIME_RANGE_SECONDS, Math.max(0, duration));
  return handle === "start"
    ? normalizeTimeRange(Math.min(value, range.end - minimum), range.end, duration)
    : normalizeTimeRange(range.start, Math.max(value, range.start + minimum), duration);
}

export function snapTimeRangeValue(value: number, duration: number, step = MIN_TIME_RANGE_SECONDS): number {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  if (value <= step / 2) {
    return 0;
  }
  if (value >= duration - step / 2) {
    return duration;
  }
  return Number((Math.round(value / step) * step).toFixed(10));
}

export function isFullTimeRange(range: TimeRange, duration: number): boolean {
  return range.start < 0.05 && Math.abs(range.end - duration) < 0.05;
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

export function getNextSizeSplitSeconds(currentSeconds: number, maxBytes: number, largestBytes: number, minimumSeconds = 0.1, safetyRatio = 0.9): number {
  const proportional = Math.floor(currentSeconds * maxBytes / largestBytes * safetyRatio * 10) / 10;
  return Math.max(minimumSeconds, Math.min(currentSeconds - minimumSeconds, proportional));
}

export function getExpectedSplitCount(duration: number, segmentSeconds: number): number {
  if (!Number.isFinite(duration) || !Number.isFinite(segmentSeconds) || duration <= 0 || segmentSeconds <= 0) {
    return 0;
  }
  return Math.ceil(duration / segmentSeconds - 1e-6);
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
  if (tokens.length === 0 || tokens.length > 3 || tokens.some((token) => token.trim() === "")) {
    return Number.NaN;
  }
  const parts = tokens.map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return Number.NaN;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}
