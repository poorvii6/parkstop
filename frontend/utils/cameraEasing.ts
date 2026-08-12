/**
 * Camera easing for the Google Navigation SDK MapView.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Navigation SDK's JS bridge exposes only `moveCamera`, which calls
 * Android's `GoogleMap.moveCamera` — an instant jump. The native
 * `MapViewController` does implement `animateCamera`, but it is not bridged to
 * JavaScript, so there is no way to ask for a smooth transition.
 *
 * Left alone that makes recentring, search fly-to and follow all teleport,
 * which reads as broken next to Google Maps itself. So we interpolate the
 * camera ourselves and push a position per frame.
 *
 * A NOTE ON THE ZOOM FOOTGUN
 * --------------------------
 * The native implementation reads each field with a default of 0:
 *
 *     float zoom = CollectionUtil.getDouble("zoom", map, 0);
 *
 * So omitting `zoom` does not mean "keep current zoom", it means zoom 0 — the
 * whole planet. Every camera we send must therefore be COMPLETE. `easeCamera`
 * requires all four fields for exactly this reason; making them optional would
 * hand callers a very easy way to zoom the map out to the entire world.
 */

export type EaseTarget = {
  lat: number;
  lng: number;
  zoom: number;
  tilt: number;
  bearing: number;
};

/** Google's camera moves ease out — quick to leave, gentle to arrive. */
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/**
 * Interpolate a bearing along the SHORTEST arc.
 *
 * Naive interpolation from 350° to 10° runs backwards through 180°, spinning
 * the map most of a full turn to cover 20 degrees. This is the same correction
 * the navigation puck needs.
 */
export const shortestArcDelta = (from: number, to: number): number =>
  (((to - from + 540) % 360) - 180);

export type CameraEaser = {
  /** Ease to a target over `durationMs`. Cancels any easing already running. */
  easeCamera: (target: EaseTarget, durationMs: number) => void;
  /** Jump immediately, no interpolation. */
  setCamera: (target: EaseTarget) => void;
  /** Stop any running easing — call when a gesture takes over, and on unmount. */
  cancel: () => void;
  /** True while an easing is in flight. */
  isEasing: () => boolean;
};

/**
 * Build an easer bound to a `moveCamera` function.
 *
 * `moveCamera` is whatever the MapViewController hands us. It is deliberately
 * injected rather than imported so this module stays testable without a native
 * map, and so a controller arriving late (the controller is delivered by a
 * callback prop) can be swapped in without rebuilding the easer.
 */
export function createCameraEaser(
  getMoveCamera: () => ((pos: any) => void) | null | undefined,
  scheduleFrame: (cb: () => void) => number = requestAnimationFrame,
  cancelFrame: (id: number) => void = cancelAnimationFrame
): CameraEaser {
  let raf = 0;
  let running = false;
  let current: EaseTarget | null = null;

  const push = (t: EaseTarget) => {
    const move = getMoveCamera();
    if (!move) return;
    // Always a COMPLETE camera — see the zoom footgun note above.
    move({
      target: { lat: t.lat, lng: t.lng },
      zoom: t.zoom,
      tilt: t.tilt,
      // Normalise on the way out. Interpolation deliberately works in absolute
      // degrees so it can cross north (350 -> 370 rather than 350 -> 10), but
      // 370 is not a bearing anyone should receive. Google would normalise it
      // internally; sending it anyway makes getCameraPosition() readings and
      // logs confusing for no benefit.
      bearing: ((t.bearing % 360) + 360) % 360,
    });
    // `current` keeps the ABSOLUTE bearing, so a follow-up ease continues from
    // where the arc actually was rather than snapping back across north.
    current = t;
  };

  const cancel = () => {
    if (raf) cancelFrame(raf);
    raf = 0;
    running = false;
  };

  const setCamera = (target: EaseTarget) => {
    cancel();
    push(target);
  };

  const easeCamera = (target: EaseTarget, durationMs: number) => {
    // Nothing to ease from on the very first move, and easing from a default
    // would fly the camera in from null island. Jump instead.
    if (!current || durationMs <= 0) {
      setCamera(target);
      return;
    }

    cancel();
    const from = current;
    // Resolve the bearing to an absolute value on the shortest arc, so the
    // interpolation below can stay a plain lerp.
    const toBearing = from.bearing + shortestArcDelta(from.bearing, target.bearing);
    const start = Date.now();
    running = true;

    const step = () => {
      const raw = Math.min(1, (Date.now() - start) / durationMs);
      const t = easeOutCubic(raw);
      push({
        lat: from.lat + (target.lat - from.lat) * t,
        lng: from.lng + (target.lng - from.lng) * t,
        zoom: from.zoom + (target.zoom - from.zoom) * t,
        tilt: from.tilt + (target.tilt - from.tilt) * t,
        bearing: from.bearing + (toBearing - from.bearing) * t,
      });
      if (raw < 1) {
        raf = scheduleFrame(step);
      } else {
        // Land exactly on the target, and normalise the bearing so it does not
        // drift outside 0-360 across many eases.
        push({ ...target, bearing: ((target.bearing % 360) + 360) % 360 });
        running = false;
        raf = 0;
      }
    };
    raf = scheduleFrame(step);
  };

  return { easeCamera, setCamera, cancel, isEasing: () => running };
}
