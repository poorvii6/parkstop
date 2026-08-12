/**
 * Price-pill markers for the Navigation SDK map.
 *
 * WHY THIS IS NECESSARY
 * ---------------------
 * The Navigation SDK's MarkerOptions accepts only `imgPath` — a path to an
 * image. There is no custom-view marker, which react-native-maps had and which
 * is how ParkStop's price pill ("₹40/hr", coloured by availability) used to be
 * drawn straight onto the map. That capability left with the Maps SDK.
 *
 * So the pill is rendered offscreen as a real React view, captured to a PNG,
 * and the resulting file path is handed to the marker.
 *
 * WHY CACHING IS NOT OPTIONAL
 * ---------------------------
 * A capture is a real render plus a file write. Doing one per spot on every
 * refresh would stutter the map badly on a screen showing dozens of spots.
 * Pills are cached by their APPEARANCE — price plus availability — not by spot
 * id, so twenty spots at ₹40/hr share a single image and only genuinely new
 * looks cost a capture.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { captureRef } from 'react-native-view-shot';

export type PinSpec = { price: number; available: boolean };

/** Appearance key: two spots that look identical share one captured image. */
export const pinKey = (s: PinSpec) => `${s.price}|${s.available ? 'open' : 'full'}`;

export function useSpotPinImages(specs: PinSpec[]) {
  // key -> captured file path
  const [images, setImages] = useState<Record<string, string>>({});
  // Keys currently rendered offscreen, waiting to be captured.
  const [queue, setQueue] = useState<PinSpec[]>([]);
  const inFlight = useRef<Set<string>>(new Set());
  // Bumped after any batch that did not fully succeed, purely to re-run the
  // queueing effect. Without it a failed capture is never retried: that effect
  // watches only `specs` and `images`, and a failure changes neither, so the
  // pill would stay missing until the spot list itself happened to change.
  const [retryTick, setRetryTick] = useState(0);
  const refs = useRef<Record<string, any>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Queue anything we have never captured and are not already capturing.
  useEffect(() => {
    const missing: PinSpec[] = [];
    const seen = new Set<string>();
    for (const s of specs) {
      const k = pinKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      if (images[k] || inFlight.current.has(k)) continue;
      inFlight.current.add(k);
      missing.push(s);
    }
    if (missing.length) setQueue(q => [...q, ...missing]);
  }, [specs, images, retryTick]);

  // Capture after the offscreen pills have had a frame to lay out. Capturing
  // in the same tick yields a blank or zero-sized image.
  const captureQueued = useCallback(async () => {
    if (!queue.length) return;
    const done: Record<string, string> = {};
    for (const spec of queue) {
      const k = pinKey(spec);
      const node = refs.current[k];
      if (!node) {
        // PERMANENT STALL, now fixed.
        //
        // This used to `continue`, skipping the try/finally — so the key was
        // never removed from `inFlight`. The queueing effect skips anything in
        // `inFlight`, so that pill was never attempted again for the lifetime
        // of the screen. One unlucky frame where the ref had not yet committed
        // meant that price NEVER got an image, and every spot at that price
        // fell back to a red pin forever. That matches exactly what has been
        // on screen.
        inFlight.current.delete(k);
        continue;
      }
      try {
        const uri = await captureRef(node, {
          format: 'png',
          quality: 1,
          // A real file on disk. The native side resolves absolute paths
          // through BitmapDescriptorFactory.fromPath (see the ParkStop patch in
          // MapViewController.java) — upstream only handled bundled assets,
          // which runtime-generated images can never be.
          result: 'tmpfile',
        });
        // Strip the scheme: fromPath wants a filesystem path. The patch handles
        // either form, but sending the plain path keeps it unambiguous.
        done[k] = uri.startsWith('file://') ? uri.slice(7) : uri;
      } catch {
        // Leave it uncaptured. The map falls back to a default pin, which is
        // far better than a spot vanishing because its label failed to render.
      } finally {
        inFlight.current.delete(k);
      }
    }
    if (!alive.current) return;
    if (Object.keys(done).length) {
      setImages(prev => ({ ...prev, ...done }));
    }
    // Clear the queue whether or not anything captured. Leaving a failed batch
    // in place kept `hiddenPills` mounted with the same refs and the effect
    // never re-ran, so a single failure froze the whole mechanism. Cleared,
    // the queueing effect sees the pills are still missing and tries again.
    setQueue([]);
    if (Object.keys(done).length < queue.length) {
      // Something in this batch failed — schedule another attempt rather than
      // leaving those spots as plain pins for the rest of the session.
      setTimeout(() => { if (alive.current) setRetryTick(t => t + 1); }, 300);
    }
  }, [queue]);

  useEffect(() => {
    if (!queue.length) return;
    const t = setTimeout(captureQueued, 60);
    return () => clearTimeout(t);
  }, [queue, captureQueued]);

  /**
   * The offscreen pills. Must be MOUNTED and laid out to be capturable, so it
   * cannot use display:none or zero size — it is pushed off the visible area
   * instead, and made non-interactive so it cannot swallow touches.
   */
  const hiddenPills = (
    <View style={styles.offscreen} pointerEvents="none" collapsable={false}>
      {queue.map(spec => {
        const k = pinKey(spec);
        return (
          <View key={k} ref={(r: any) => { refs.current[k] = r; }} collapsable={false} style={styles.pillWrap}>
            <View style={[styles.pill, { backgroundColor: spec.available ? '#1a73e8' : '#9aa0a6' }]}>
              <Text style={styles.pillText}>₹{spec.price}</Text>
              <Text style={styles.pillPerHr}>/hr</Text>
            </View>
            <View style={[styles.pillTail, { borderTopColor: spec.available ? '#1a73e8' : '#9aa0a6' }]} />
          </View>
        );
      })}
    </View>
  );

  return { images, hiddenPills };
}

const styles = StyleSheet.create({
  // Positioned at the origin and fully opaque, NOT pushed off-screen with
  // opacity 0.
  //
  // Android only rasterises what it actually draws. A view at left:-1000 is
  // outside the window and a view at opacity 0 is skipped by the compositor,
  // so captureRef returns a blank or fails outright — which is why spots kept
  // falling back to plain red pins instead of showing their price. The pills
  // are instead drawn at the top-left corner and covered by the map, which
  // renders after them, so they are captured correctly and never seen.
  offscreen: { position: 'absolute', left: 0, top: 0 },
  pillWrap: { alignItems: 'center', marginBottom: 8, padding: 4 },
  pill: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14,
    borderWidth: 2, borderColor: '#fff',
  },
  pillText: { color: '#fff', fontWeight: '900', fontSize: 13 },
  pillPerHr: { color: 'rgba(255,255,255,0.85)', fontWeight: '700', fontSize: 9, marginLeft: 1, marginBottom: 1 },
  pillTail: {
    width: 0, height: 0, marginTop: -2,
    borderLeftWidth: 5, borderRightWidth: 5, borderTopWidth: 7,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
  },
});
