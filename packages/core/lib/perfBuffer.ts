/**
 * Bounded in-memory ring buffer of recent performance timings.
 *
 * Local-only: this never leaves the machine. It backs GET /api/metrics/perf and
 * is populated regardless of whether outbound telemetry is enabled, so an
 * operator who opts out of phone-home still gets local perf visibility
 * (spec 004 FR-004 / US3).
 */

export interface PerfRecord {
  /** Operation name, e.g. "session_created", "session_adopted". */
  op: string;
  /** Non-identifying timing breakdown in milliseconds. */
  timings: Record<string, number>;
  /** Epoch milliseconds when recorded. */
  at: number;
}

const MAX_RECORDS = 100;

const buffer: PerfRecord[] = [];

/** Append a timing record, evicting the oldest once the cap is reached. */
export function recordPerf(
  op: string,
  timings: Record<string, number>,
  at: number = Date.now(),
): void {
  buffer.push({ op, timings, at });
  if (buffer.length > MAX_RECORDS) buffer.splice(0, buffer.length - MAX_RECORDS);
}

/** Return a shallow copy of the recent records (oldest → newest). */
export function getRecent(): PerfRecord[] {
  return buffer.slice();
}

/** Test helper: empty the buffer. */
export function clear(): void {
  buffer.length = 0;
}

export const PERF_BUFFER_CAP = MAX_RECORDS;
