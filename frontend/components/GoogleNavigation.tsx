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
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  NavigationView,
  useNavigation,
  NavigationSessionStatus,
  RouteStatus,
  TravelMode,
  AudioGuidance,
  type NavigationViewController,
  type ArrivalEvent,
  type Location as NavLocation,
} from '@googlemaps/react-native-navigation-sdk';
import { ensureNavSession, isDestinationPrepared, clearPreparedDestination } from '../utils/navSession';

type Props = {
  /** Where the rider is going — the booked parking spot. */
  destination: { lat: number; lng: number; title?: string } | null;
  /** Fired once when Google reports arrival at the final destination. */
  onArrive?: () => void;
  /** Road-snapped position updates, for the booking's live tracking. */
  onLocation?: (loc: { lat: number; lng: number }) => void;
  /** Rider tapped the back/exit control. */
  onExit?: () => void;
  /**
   * Google's own remaining distance to the destination, in metres.
   *
   * Surfaced because it is a better arrival signal than anything the app can
   * compute: it comes from the routing engine following the actual route,
   * not from comparing two GPS points.
   */
  onRemaining?: (meters: number) => void;
  /** Mirrors the app's existing mute toggle onto Google's voice guidance. */
  muted?: boolean;
  /**
   * Current speed in km/h, already filtered for stillness by the caller.
   *
   * Google's own speedometer is switched off in favour of this, because the
   * SDK renders raw GPS speed with no way to intervene: a parked vehicle
   * shows 10–20 km/h as successive fixes wander. The caller's watcher already
   * decides when the rider is genuinely moving, so that decision is reused
   * rather than repeated here.
   */
  speedKmh?: number;
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
  onRemaining,
  muted,
  speedKmh,
  style,
}: Props) {
  const {
    navigationController,
    setOnArrival,
    setOnLocationChanged,
    setOnNavigationReady,
    setOnRemainingTimeOrDistanceChanged,
    removeAllListeners,
  } = useNavigation();

  const insets = useSafeAreaInsets();
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  /**
   * MEASURE THE CONTAINER, THEN FILL IT EXACTLY.
   *
   * This replaces an earlier approach that derived the size from
   * useWindowDimensions minus the safe-area insets, with extra padding on the
   * container. That produced the blank strip along the bottom of the screen,
   * and it did so for three compounding reasons:
   *
   *  1. The padding IS the strip. `paddingBottom: insets.bottom + clearance`
   *     reserves space inside this view that the map is not allowed to draw
   *     into, and the backdrop colour paints it. Removing only the clearance
   *     left the inset behind — a smaller strip, but the same strip.
   *
   *  2. The top inset was applied TWICE. The finder already wraps this screen
   *     in <SafeAreaView edges={['top']}>, so the container handed to us has
   *     already been pushed below the status bar; padding by insets.top again
   *     subtracted it a second time.
   *
   *  3. `useWindowDimensions().height` is not this view's height. On Android it
   *     does not include the system navigation bar, while `insets.bottom` still
   *     reports one — so the arithmetic subtracted a bar that was never in the
   *     number to begin with.
   *
   * Measuring removes all three: whatever box this component is given, the
   * navigation view is exactly that size, with no padding and no assumptions
   * about who inset what.
   *
   * The original objection to measuring was a race — mounting the view changed
   * the container it was being measured against. That is avoided here by giving
   * the wrapper no padding and positioning the navigation view absolutely, so
   * mounting it cannot alter the wrapper's layout. Google still receives an
   * explicit pixel size, which is its actual requirement.
   *
   * WHY THE INSETS ARE BACK — AND WHY THEY NO LONGER SHOW
   * -----------------------------------------------------
   * Removing the padding outright fixed the blank strip but broke the chrome:
   * the SDK has no padding prop of its own (only *Enabled booleans), so the
   * container really is the only way to keep Google's banner out from under the
   * status bar and its ETA card off the navigation buttons. Without it the
   * banner was clipped by the clock and the ETA card sat behind the back button.
   *
   * The insets are therefore restored, but WITHOUT the extra clearance and,
   * critically, on an OUTER view while the navigation view is measured against
   * an INNER one. That is the difference between this and the version that
   * produced the strip: each padded edge is now exactly the size of the system
   * bar that covers it, so the bar is drawn over it and nothing shows. The old
   * code added 34px on top of the inset and sized the view from window
   * dimensions that did not match, so the reserved space was visibly larger
   * than the bar — a band of bare backdrop above the buttons.
   */
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  /**
   * Height of our trip sheet, and the strip Google's view must NOT be given.
   *
   * This is why the speedometer ended up underneath the sheet: Google places
   * the speedometer and speed-limit icon at the bottom-left of whatever height
   * its view has, normally just above its own footer. With that footer switched
   * off they moved down into the space our sheet occupies.
   *
   * Shrinking the navigation view by exactly the sheet's height puts them back
   * where they belong — above the sheet — instead of behind it. It is a
   * constant, so Google still receives one fixed size at creation and never
   * has to re-lay-out.
   */
  const SHEET_HEIGHT = 76;

  /**
   * Remaining time and distance, for OUR bottom sheet.
   *
   * Google's own footer is switched off below. It shows the same numbers, but
   * it is their view: nothing can be added to it, and the X that Google Maps
   * puts at the left of that sheet therefore had nowhere to go except floating
   * above it, where it collided with the speedometer. The SDK does publish the
   * underlying trip data, so the sheet is rebuilt here instead — same
   * information, same layout as Google Maps, and room for the exit control
   * inside it.
   */
  const [trip, setTrip] = useState<{ seconds: number; meters: number; severity: number } | null>(null);

  /**
   * The NAVIGATION VIEW controller — distinct from navigationController, which
   * drives the trip. This one drives the camera, and it is how the recenter
   * control below works.
   *
   * Needed because switching Google's footer off also took their "Re-center"
   * button with it: it belongs to that same chrome group. The camera API is
   * public, so the button is rebuilt here rather than the footer brought back.
   */
  const navView = useRef<NavigationViewController | null>(null);

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

    setOnRemainingTimeOrDistanceChanged?.((td: any) => {
      if (!mounted.current || !td) return;
      const meters = Number(td.meters) || 0;
      setTrip({
        seconds: Number(td.seconds) || 0,
        meters,
        severity: Number(td.delaySeverity) || 0,
      });
      onRemaining?.(meters);
    });

    return () => removeAllListeners();
  }, [
    navigationController,
    setOnArrival,
    setOnLocationChanged,
    setOnNavigationReady,
    setOnRemainingTimeOrDistanceChanged,
    removeAllListeners,
    onArrive,
    onLocation,
    onRemaining,
  ]);

  // ── Start guidance ───────────────────────────────────────────
  const start = useCallback(async () => {
    if (!destination) return;
    const key = `${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`; // matches destKey()
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

      // Already computed during booking confirmation? Then skip straight to
      // guidance — this is the whole point of the pre-warm, and it removes the
      // network round-trip the rider used to watch.
      if (isDestinationPrepared(key)) {
        await navigationController.startGuidance();
        if (mounted.current) setError(null);
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
            // Google's red destination pin, ON.
            //
            // I turned this off originally to avoid a duplicate with ParkStop's
            // own marker — but our map is unmounted during guidance, so there
            // was no other pin and the rider had nothing marking where they
            // were actually going. Google Maps always shows the destination.
            showDestinationMarkers: true,
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
      // The SDK no longer holds that destination, so the pre-warm record must
      // not claim it does — otherwise the next trip skips setDestination and
      // starts guidance with nothing to guide along.
      clearPreparedDestination();
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
    /* NO PADDING. The map fills this view edge to edge.
     *
     * Any padding here is, by definition, a band the map cannot draw into —
     * which is precisely the blank strip that kept appearing under the map.
     * The status bar is already handled by the finder's SafeAreaView, and
     * Google's own chrome floats above the map rather than being clipped by
     * it, which is how Google Maps itself is laid out.
     *
     * The dark background still matters: it is what shows for the one frame
     * between measuring and mounting, and it matches the app rather than
     * flashing white. */
    <View
      style={[
        styles.fill,
        styles.insetBackdrop,
        // Exactly the system bars, nothing more. Each padded edge ends up
        // underneath the bar that covers it, so it is never visible as a band.
        // A little air under Google's ETA card. The inset alone ends the map
        // exactly where the system bar starts, so the card's rounded bottom
        // corners sit flush against the buttons and read as clipped. 12px is
        // the margin Google Maps itself leaves there.
        //
        // Safe to add now in a way it was not before: this component only
        // renders while guidance is actually running, so this can never be an
        // empty strip on the check-in screen — Google's card fills it.
        { paddingTop: insets.top, paddingBottom: insets.bottom + 12 },
        style,
      ]}
    >
    <View
      style={styles.fill}
      onLayout={e => {
        const { width, height } = e.nativeEvent.layout;
        if (width <= 0 || height <= 0) return;
        // Only react to REAL changes (rotation, or the first measurement).
        // Re-setting an identical size would remount Google's view and restart
        // its layout for nothing.
        setBox(prev =>
          prev && Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1
            ? prev
            : { w: width, h: height }
        );
      }}
    >
      {box ? (
      <NavigationView
        /* Absolutely positioned at the measured size.
         *
         * Absolute is what makes measuring safe: this view cannot influence
         * the layout of the container it was measured from, so there is no
         * feedback loop between mounting and measuring. Google still gets the
         * explicit pixel size it needs, and it is now the size this component
         * was actually given rather than a number derived from the window. */
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: box.w,
          height: Math.max(1, box.h - SHEET_HEIGHT),
        }}
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
        // OFF — replaced by ParkStop's own sheet below, so the exit control can
        // live INSIDE it the way Google Maps does. The header stays Google's:
        // it carries turn-by-turn guidance we have no business reimplementing.
        footerEnabled={false}
        // The vertical bar down the left edge — destination pin at the top,
        // your position at the bottom, traffic marks along it. On a 27km ride
        // it reads as a stray straight line drawn across the map rather than a
        // progress indicator, and it collides with ParkStop's back control.
        tripProgressBarEnabled={false}
        // OFF, deliberately. Google's dial reads raw GPS speed, which sits at
        // 10–20 km/h while the vehicle is parked because a stationary phone's
        // successive fixes wander by a few metres. The SDK exposes no way to
        // filter it, so the speed readout moved into ParkStop's own trip sheet
        // below, where it can be held at zero until the rider is actually
        // moving.
        speedometerEnabled={false}
        // Kept: this is the road's legal limit from Google's map data, not a
        // measurement, so none of the above applies to it.
        speedLimitIconEnabled
        // Google's own re-centre control. It appears only once the camera has
        // been panned away and hides itself again on follow — exactly the
        // Google Maps behaviour — and the SDK positions it clear of its own
        // chrome. ParkStop used to draw a second, always-visible pill next to
        // it; that was the duplicate.
        recenterButtonEnabled
        trafficPromptsEnabled
        trafficIncidentCardsEnabled
        // Reporting incidents belongs to a driving app, not a parking one, and
        // it puts a Google-branded reporting flow in front of ParkStop's users.
        reportIncidentButtonEnabled={false}
        onNavigationViewControllerCreated={(c: NavigationViewController) => {
          navView.current = c;
        }}
        onMapReady={() => setReady(true)}
      />
      ) : null}

      {/* The custom Re-center pill that used to sit here has been removed.
        *
        * It was added when switching Google's footer off appeared to take
        * their re-centre control with it. That turned out to be wrong —
        * recenterButtonEnabled draws it independently of the footer — so the
        * app was rendering two, one from Google at the bottom-left and one of
        * ours at the bottom-right.
        *
        * Google's is the better of the two to keep: it appears only after the
        * camera has been panned away and hides again on follow, which is what
        * Google Maps does, whereas ours sat there permanently. */}

      {/* ── Trip sheet: exit, remaining time, distance and arrival ──
        * A rebuild of Google Maps' bottom sheet, because Google's own footer
        * cannot host the exit control. */}
      {box ? (
        <View style={styles.sheet}>
          {onExit ? (
            <TouchableOpacity
              onPress={onExit}
              activeOpacity={0.7}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.sheetClose}
            >
              <Text style={styles.sheetCloseGlyph}>✕</Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.sheetText}>
            <Text style={[styles.sheetEta, { color: etaColor(trip?.severity) }]} numberOfLines={1}>
              {trip ? fmtDuration(trip.seconds) : '—'}
            </Text>
            <Text style={styles.sheetSub} numberOfLines={1}>
              {trip ? `${fmtDistance(trip.meters)} · ${fmtArrival(trip.seconds)}` : 'Calculating route…'}
            </Text>
          </View>

          {/* Speed, replacing Google's dial. Lives in the sheet rather than
            * floating over the map because the sheet's layout is ours: a pill
            * placed over the map would be guessing at where the SDK has drawn
            * the speed-limit icon this frame, and that guess is what put the
            * back arrow on top of the "Then" card before.
            *
            * The number is already filtered upstream — held at zero below
            * walking pace — so a parked vehicle reads 0, not GPS drift. */}
          {typeof speedKmh === 'number' ? (
            <View style={styles.speedPill}>
              <Text style={styles.speedValue}>{Math.max(0, Math.round(speedKmh))}</Text>
              <Text style={styles.speedUnit}>km/h</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Google's chrome is blank until it has computed the route, which is a
        * network round-trip. Left unlabelled that gap reads as the app having
        * frozen; naming it makes the same delay feel like progress. It clears
        * the moment guidance is ready. */}
      {!ready && !error ? (
        <View style={styles.errorBar} pointerEvents="none">
          <Text style={styles.errorText}>Starting navigation…</Text>
        </View>
      ) : null}

      {error ? (
        <View style={styles.errorBar} pointerEvents="box-none">
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
    </View>
  );
}

/** "43 min", "1 hr 8 min" — the phrasing Google Maps uses. */
function fmtDuration(seconds: number): string {
  const mins = Math.max(0, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** Metres below a kilometre, then km — one decimal only while it still says something. */
function fmtDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters / 1000;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** Clock time of arrival, e.g. "10:11 am". */
function fmtArrival(seconds: number): string {
  const d = new Date(Date.now() + seconds * 1000);
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'pm' : 'am';
  const h = d.getHours() % 12 || 12;
  return `${h}:${mm} ${ampm}`;
}

/**
 * Google's traffic colours: green when clear, amber for medium, red for heavy.
 * DelaySeverity is 1 HEAVY, 2 MEDIUM, 3 LIGHT, 0 NO_DATA.
 */
function etaColor(severity?: number): string {
  if (severity === 1) return '#d93025';
  if (severity === 2) return '#e37400';
  return '#188038';
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  insetBackdrop: { backgroundColor: '#0f172a' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // Must match SHEET_HEIGHT above — the navigation view is shortened by
    // exactly this much so Google's controls sit above it, not behind it.
    height: 76,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 16,
  },
  /* Speed readout, right-hand end of the trip sheet. In flow rather than
   * absolutely positioned, so it can never land on top of Google's chrome. */
  speedPill: {
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#dadce0',
    backgroundColor: '#f8f9fa',
  },
  speedValue: { fontSize: 18, fontWeight: '700', color: '#202124', lineHeight: 20 },
  speedUnit: { fontSize: 10, fontWeight: '600', color: '#5f6368' },
  sheetClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#dadce0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetCloseGlyph: { fontSize: 20, color: '#3c4043', lineHeight: 22 },
  sheetText: { flex: 1, marginLeft: 14 },
  sheetEta: { fontSize: 22, fontWeight: '700' },
  sheetSub: { fontSize: 14, color: '#5f6368', marginTop: 2 },
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
