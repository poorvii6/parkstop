/**
 * Google's own turn-by-turn navigation, via the Navigation SDK.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Everything ParkStop previously hand-built for the navigation phase: the
 * camera (follow, pitch, zoom, recenter), the direction arrow, the turn-by-turn
 * instruction card, voice prompts, off-route detection, rerouting, route
 * selection and traffic colouring. All of that is now Google's code, rendered
 * by Google, identical to the Google Maps app.
 *
 * The reason for the switch: the app was drawing Google's map tiles but
 * imitating Google's navigation on top of them. An imitation can be moved
 * closer but never made identical, and the gap was exactly what kept showing up
 * on real rides.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * Booking state, arrival check-in, payments and the bottom sheets stay in the
 * finder. This component owns guidance only, and reports back through
 * callbacks. Keeping the boundary there means the booking flow does not have to
 * know that navigation changed at all.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  NavigationView,
  useNavigation,
  NavigationSessionStatus,
  RouteStatus,
  TravelMode,
  AudioGuidance,
  type ArrivalEvent,
  type Location as NavLocation,
} from '@googlemaps/react-native-navigation-sdk';
import { ensureNavSession } from '../utils/navSession';

type Props = {
  /** Where the rider is going — the booked parking spot. */
  destination: { lat: number; lng: number; title?: string } | null;
  /** Fired once when Google reports arrival at the final destination. */
  onArrive?: () => void;
  /** Road-snapped position updates, for the booking's live tracking. */
  onLocation?: (loc: { lat: number; lng: number }) => void;
  /** Rider tapped the back/exit control. */
  onExit?: () => void;
  /** Mirrors the app's existing mute toggle onto Google's voice guidance. */
  muted?: boolean;
  style?: any;
};

/** Human-readable reason for a failed session start, so the UI can be honest. */
function describeSessionFailure(status: NavigationSessionStatus): string {
  switch (status) {
    case NavigationSessionStatus.NOT_AUTHORIZED:
      // By far the most likely first-run failure, and it looks exactly like a
      // code bug unless it is named. Enabling the API is not sufficient — the
      // Android key's own API restriction list must include Navigation SDK.
      return 'This app key is not authorised for navigation yet. Check that Navigation SDK is enabled and allowed on the API key.';
    case NavigationSessionStatus.TERMS_NOT_ACCEPTED:
      return 'Navigation needs you to accept Google’s terms before it can start.';
    case NavigationSessionStatus.LOCATION_PERMISSION_MISSING:
      return 'Navigation needs location permission.';
    case NavigationSessionStatus.NETWORK_ERROR:
      return 'Could not reach Google to start navigation. Check your connection.';
    default:
      return 'Navigation could not start.';
  }
}

/** Human-readable reason a route could not be built. */
function describeRouteFailure(status: RouteStatus): string {
  switch (status) {
    case RouteStatus.NO_ROUTE_FOUND:
      return 'No driveable route to this parking spot.';
    case RouteStatus.NETWORK_ERROR:
      return 'Lost connection while finding the route.';
    case RouteStatus.QUOTA_CHECK_FAILED:
      return 'Navigation is temporarily unavailable.';
    case RouteStatus.LOCATION_DISABLED:
    case RouteStatus.LOCATION_UNKNOWN:
      // Google cannot route until it has its own fix. This is expected for a
      // moment after starting, so it is retried rather than surfaced.
      return 'Waiting for your location…';
    case RouteStatus.WAYPOINT_ERROR:
      return 'This parking spot could not be used as a destination.';
    default:
      return 'Could not start navigation to this spot.';
  }
}

export default function GoogleNavigation({
  destination,
  onArrive,
  onLocation,
  onExit,
  muted,
  style,
}: Props) {
  const {
    navigationController,
    setOnArrival,
    setOnLocationChanged,
    setOnNavigationReady,
    removeAllListeners,
  } = useNavigation();

  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  /**
   * Size taken from the WINDOW, not from measuring our own container.
   *
   * Google's navigation chrome is laid out once, when the native view is
   * created, against the size it has at that instant — and never re-laid-out
   * afterwards. Measuring the container with onLayout could not work: mounting
   * the navigation view INTO that container changes the container's layout, so
   * Google measured one geometry and then received another. The symptom was an
   * empty banner at the top with the instruction stranded at the bottom, and it
   * came and went depending on which frame won.
   *
   * Window dimensions are known before anything mounts and do not change except
   * on rotation, which useWindowDimensions reports. Subtracting the insets
   * gives exactly the space this view occupies, with no measurement race.
   */
  const win = useWindowDimensions();

  /**
   * Extra clearance under Google's ETA bar, on top of the system inset.
   *
   * The inset alone stops the bar sitting UNDER the gesture indicator, but it
   * still ends up flush against it — close enough that the arrival time reads
   * as part of the system UI rather than the app. A little breathing room lifts
   * it clear, which is how Google Maps itself frames that card.
   */
  const BOTTOM_CLEARANCE = 14;

  const navWidth = win.width;
  const navHeight = Math.max(
    1,
    win.height - insets.top - insets.bottom - BOTTOM_CLEARANCE
  );

  // Guards against re-running the whole start sequence. `destination` is an
  // object literal from the finder's render, so it is a new reference on every
  // render — keying effects on it directly would restart guidance continuously.
  const startedFor = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ── Listeners ────────────────────────────────────────────────
  useEffect(() => {
    setOnNavigationReady(() => {
      if (mounted.current) setReady(true);
    });

    setOnArrival((event: ArrivalEvent) => {
      // ParkStop always navigates to exactly one destination — the booked spot
      // — so any arrival is the arrival. Guidance is stopped here rather than
      // left running, otherwise Google keeps announcing a trip that is over
      // while the rider is filling in check-in.
      if (event.isFinalDestination !== false) {
        navigationController.stopGuidance().catch(() => {});
        onArrive?.();
      }
    });

    // Note the shape: the listener receives the Location directly, not an
    // event wrapper. The README's `{ location }` example does not match the
    // typed signature.
    setOnLocationChanged((location: NavLocation) => {
      const l: any = location;
      if (!l) return;
      // Road-snapped, which is what the booking should record: it is the
      // position Google is actually navigating from, not a raw GPS sample that
      // may sit in a building or on the wrong carriageway.
      const lat = l.lat ?? l.latitude;
      const lng = l.lng ?? l.longitude;
      if (typeof lat === 'number' && typeof lng === 'number') {
        onLocation?.({ lat, lng });
      }
    });

    return () => removeAllListeners();
  }, [
    navigationController,
    setOnArrival,
    setOnLocationChanged,
    setOnNavigationReady,
    removeAllListeners,
    onArrive,
    onLocation,
  ]);

  // ── Start guidance ───────────────────────────────────────────
  const start = useCallback(async () => {
    if (!destination) return;
    const key = `${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`;
    if (startedFor.current === key) return;
    startedFor.current = key;
    setError(null);

    try {
      // Shared with the browsing map — see utils/navSession. Terms and init
      // run once for the whole app, not once per screen, so the rider is not
      // shown Google's dialog again on their way to a spot and two init calls
      // never race.
      const status = await ensureNavSession(navigationController);
      if (status !== NavigationSessionStatus.OK) {
        startedFor.current = null;
        setError(describeSessionFailure(status));
        return;
      }

      const routeStatus = await navigationController.setDestination(
        {
          title: destination.title || 'Parking spot',
          position: { lat: destination.lat, lng: destination.lng },
        },
        {
          routingOptions: {
            // ParkStop's riders are overwhelmingly on two-wheelers, and in
            // India Google routes them differently from cars — narrower roads
            // that are legal and faster on a bike, without four-wheeler-only
            // restrictions. Routing them as DRIVING sends them the long way
            // round, which is part of what looked like "bad roads" before.
            travelMode: TravelMode.TWO_WHEELER,
            avoidFerries: true,
            avoidTolls: false,
          },
          displayOptions: {
            // The spot already has ParkStop's own marker on the map behind
            // navigation; Google adding a second pin on top of it just reads
            // as a duplicate.
            showDestinationMarkers: false,
          },
        }
      );

      if (routeStatus !== RouteStatus.OK) {
        // A missing fix is a timing problem, not a failure: Google cannot route
        // until it has its own location. Allow a retry instead of dead-ending.
        const transient =
          routeStatus === RouteStatus.LOCATION_DISABLED ||
          routeStatus === RouteStatus.LOCATION_UNKNOWN ||
          routeStatus === RouteStatus.ROUTE_CANCELED;
        if (transient) startedFor.current = null;
        setError(describeRouteFailure(routeStatus));
        return;
      }

      await navigationController.startGuidance();
      if (mounted.current) setError(null);
    } catch (e: any) {
      startedFor.current = null;
      setError(e?.message || 'Navigation could not start.');
    }
  }, [destination, navigationController]);

  useEffect(() => {
    start();
  }, [start]);

  // Retry a transient "waiting for location" without the rider doing anything.
  useEffect(() => {
    if (!error || !destination) return;
    if (!error.startsWith('Waiting')) return;
    const t = setTimeout(() => start(), 1500);
    return () => clearTimeout(t);
  }, [error, destination, start]);

  // ── Mute mirrors the app's existing toggle ───────────────────
  useEffect(() => {
    if (!ready) return;
    // Strings, not the enum, so a version bump that renames members cannot
    // silently make this a no-op — a wrong string throws where a wrong enum
    // member would just be undefined.
    // AudioGuidance is a set of numeric BIT FLAGS, not a string enum — the
    // native signature is setAudioGuidanceType(index: Double). Passing the
    // member names as strings (which an `as any` cast happily allowed) meant
    // the native side received a non-number and the setting silently did
    // nothing, so muting had no effect.
    //
    // SILENT is 0 and must be sent alone; the docs are explicit that combining
    // it with other flags is a mistake. Otherwise voice for alerts and
    // turn-by-turn, plus vibration.
    try {
      navigationController.setAudioGuidanceType(
        muted
          ? AudioGuidance.SILENT
          : AudioGuidance.VOICE_ALERTS_AND_GUIDANCE | AudioGuidance.VIBRATION
      );
    } catch {}
  }, [muted, ready, navigationController]);

  // ── Stop guidance when the rider leaves navigation ───────────
  useEffect(() => {
    return () => {
      // Guidance is a background service. Without this it keeps announcing
      // turns after the rider has parked and moved on to check-in.
      navigationController.stopGuidance().catch(() => {});
      navigationController.clearDestinations().catch(() => {});
    };
  }, [navigationController]);

  // Google's header renders at whatever width the view had when its fragment
  // was created. Mounted before React Native has laid the container out, it
  // measures near-zero and lays the turn card out in a narrow column that never
  // re-expands — which is why the instruction appeared clipped to a strip down
  // the left. The SDK's own docs warn that NavigationView "should be used
  // within a View with a bounded size".
  //
  // So: measure first, then mount with explicit pixel dimensions.
  return (
    /* Inset by the system bars.
     *
     * Google's chrome draws to the very edges of whatever view it is given, so
     * on a phone with a status bar and a gesture bar the instruction banner
     * sits under the clock and the ETA bar under the home indicator. The SDK
     * has no padding prop for its chrome — mapPadding moves the MAP, not the
     * UI — so the container itself is inset instead.
     *
     * The dark background matters: the inset strips are outside the map, and
     * left unpainted they show whatever is behind, which reads as the map
     * having come loose from the screen. */
    <View
      style={[
        styles.fill,
        styles.insetBackdrop,
        { paddingTop: insets.top, paddingBottom: insets.bottom + BOTTOM_CLEARANCE },
        style,
      ]}
    >
      <NavigationView
        /* The settled pixel size, NOT absoluteFill.
         *
         * absoluteFill resolves against the parent's padding box, so with the
         * safe-area padding applied the view Google measured did not match the
         * space it was actually given. Explicit dimensions from the settled
         * layout are unambiguous: this is exactly how big the view is, and it
         * will not change under Google after creation. */
        style={{ width: navWidth, height: navHeight }}
        androidStylingOptions={{
          // ParkStop's indigo, so Google's header reads as part of the app
          // rather than a different product bolted on.
          // Primary is the main instruction banner; secondary is the "Then"
          // card beneath it. They were indigo and near-black, which read as two
          // unrelated panels stacked on each other. Same colour makes them one
          // instruction block, which is what they are.
          primaryDayModeThemeColor: '#4f46e5',
          secondaryDayModeThemeColor: '#4f46e5',
          primaryNightModeThemeColor: '#3730a3',
          secondaryNightModeThemeColor: '#3730a3',
        }}
        // Google's full navigation chrome: turn cards, lane guidance, speed
        // limit, recenter, trip progress. This is the entire point of the
        // migration, so none of it is disabled.
        headerEnabled
        footerEnabled
        // The vertical bar down the left edge — destination pin at the top,
        // your position at the bottom, traffic marks along it. On a 27km ride
        // it reads as a stray straight line drawn across the map rather than a
        // progress indicator, and it collides with ParkStop's back control.
        tripProgressBarEnabled={false}
        speedLimitIconEnabled
        recenterButtonEnabled
        trafficPromptsEnabled
        trafficIncidentCardsEnabled
        // Reporting incidents belongs to a driving app, not a parking one, and
        // it puts a Google-branded reporting flow in front of ParkStop's users.
        reportIncidentButtonEnabled={false}
        onMapReady={() => setReady(true)}
      />

      {/* Exit control. Google's own UI has no concept of "leave this app's
          navigation", so ParkStop supplies it. */}
      {onExit ? (
        <TouchableOpacity style={styles.exit} onPress={onExit} activeOpacity={0.85}>
          <Text style={styles.exitText}>Exit</Text>
        </TouchableOpacity>
      ) : null}

      {error ? (
        <View style={styles.errorBar} pointerEvents="box-none">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  insetBackdrop: { backgroundColor: '#0f172a' },
  exit: {
    position: 'absolute',
    left: 16,
    // Clear of Google's header card, which occupies the top of the screen.
    bottom: Platform.OS === 'android' ? 120 : 140,
    backgroundColor: 'rgba(15,23,42,0.92)',
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
  },
  exitText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  errorBar: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 24,
    backgroundColor: 'rgba(15,23,42,0.95)',
    borderRadius: 14,
    padding: 14,
  },
  errorText: { color: '#fff', fontSize: 13, lineHeight: 19 },
});
