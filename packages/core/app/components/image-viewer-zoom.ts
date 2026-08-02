/**
 * Pure zoom/layout math for the image viewer. Kept free of React and the DOM
 * so it can be unit-tested in isolation; the component owns the refs, wheel
 * listener, and scroll-based panning.
 */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;
export const ZOOM_STEP = 1.25;

export interface Size {
  width: number;
  height: number;
}

/** Clamp a zoom factor to the supported range. */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Fit an image inside a surface preserving aspect ratio ("contain"). Images
 * smaller than the surface are shown at natural size (never upscaled at the
 * fit baseline), so `fit-to-pane` doesn't blow up tiny icons. Returns the
 * rendered size at zoom = 1.
 */
export function fitSize(image: Size, surface: Size): Size {
  if (!image.width || !image.height || !surface.width || !surface.height) {
    return { width: image.width, height: image.height };
  }
  const scale = Math.min(surface.width / image.width, surface.height / image.height, 1);
  return { width: image.width * scale, height: image.height * scale };
}

/** Rendered size at a given zoom (fit baseline × zoom). */
export function zoomedSize(image: Size, surface: Size, zoom: number): Size {
  const fit = fitSize(image, surface);
  const z = clampZoom(zoom);
  return { width: fit.width * z, height: fit.height * z };
}
