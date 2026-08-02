/**
 * Shared UI breakpoint. Viewports narrower than this (CSS px) are treated as
 * "mobile" — used for the layout's `isMobile` (page.tsx) and the `is_mobile`
 * telemetry dimension (telemetryClient.ts) so the two never drift.
 */
export const MOBILE_MAX_WIDTH = 768;
