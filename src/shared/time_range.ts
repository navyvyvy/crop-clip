export interface TimeRange {
  start: number;
  end: number;
}

export const MIN_TIME_RANGE_SECONDS = 0.1;

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

export function snapTimeRangeToSecond(value: number, duration: number, threshold: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || !Number.isFinite(threshold) || duration <= 0 || threshold <= 0) {
    return value;
  }
  const second = Math.round(value);
  return second >= 0 && second <= duration && Math.abs(value - second) <= threshold ? second : value;
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
