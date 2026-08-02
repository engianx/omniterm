/**
 * Pseudonymous installation identity + persisted telemetry state.
 *
 * The only correlation key telemetry uses is a random UUID generated once and
 * stored locally. It is not derived from a user or machine identifier, but it
 * does correlate events from the same installation (spec 004 FR-003). The same
 * file persists the first-run-notice flag (FR-008); the opt-out lives in the
 * shared settings file.
 *
 * Lives in the existing omniterm config dir (~/.omniterm, overridable via
 * SETTINGS_DIR — which also makes this testable against a temp dir).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SETTINGS_DIR } from './paths.js';

export interface TelemetryState {
  installId: string;
  noticeShown?: boolean;
}

/** Path to the telemetry state file — shares the omniterm config dir (paths.ts). */
export function telemetryStatePath(): string {
  return path.join(SETTINGS_DIR, 'telemetry.json');
}

/** Read persisted state; returns null if absent or unreadable/corrupt. */
export function readState(file: string = telemetryStatePath()): TelemetryState | null {
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as TelemetryState;
    if (parsed && typeof parsed.installId === 'string' && parsed.installId) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Atomically persist state (temp file + rename). Best-effort; never throws. */
export function writeState(state: TelemetryState, file: string = telemetryStatePath()): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmp, file);
  } catch {
    /* telemetry persistence is best-effort */
  }
}

/**
 * Return the pseudonymous install id, creating + persisting one on first run.
 * Concurrent-safe: after writing a freshly generated id, re-read so racing
 * instances converge on whichever id won the atomic rename.
 */
export function getOrCreateInstallId(file: string = telemetryStatePath()): string {
  const existing = readState(file);
  if (existing) return existing.installId;

  const created: TelemetryState = { installId: randomUUID() };
  writeState(created, file);

  if (existsSync(file)) {
    const persisted = readState(file);
    if (persisted) return persisted.installId;
  }
  return created.installId;
}

/** Mark the first-run disclosure as shown, preserving other fields. */
export function markNoticeShown(file: string = telemetryStatePath()): void {
  const state = readState(file);
  if (!state) return;
  if (state.noticeShown) return;
  writeState({ ...state, noticeShown: true }, file);
}
