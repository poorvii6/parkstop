/**
 * One navigation session for the whole app.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Navigation SDK's views — both NavigationView and the plain MapView —
 * cannot be created until a navigation session has been initialised. Mounting
 * one first crashes inside Google's own code:
 *
 *   java.lang.NullPointerException: Attempt to invoke interface method
 *   'boolean ...navigation.internal.py.d.y()' on a null object reference
 *     at com.google.android.gms.maps.SupportMapFragment.onCreateView
 *
 * There is nothing in that stack to suggest "you forgot to call init()", which
 * is exactly why this needs to be centralised rather than left to each screen
 * to remember.
 *
 * WHY A MODULE-LEVEL SINGLETON
 * ----------------------------
 * Initialisation shows Google's terms dialog. Two components mounting at once —
 * the browsing map and, moments later, the navigation view — would each start
 * their own sequence and the rider would see the dialog twice, or worse, race
 * two init() calls. Holding the in-flight promise here means every caller
 * awaits the same one and the dialog appears at most once per install.
 */
import * as Location from 'expo-location';
import {
  NavigationSessionStatus,
  type NavigationController,
} from '@googlemaps/react-native-navigation-sdk';

let sessionPromise: Promise<NavigationSessionStatus> | null = null;

/**
 * Ensure terms are accepted and the session is initialised.
 * Safe to call from anywhere, as often as you like.
 */
export function ensureNavSession(
  controller: NavigationController
): Promise<NavigationSessionStatus> {
  if (sessionPromise) return sessionPromise;

  sessionPromise = (async () => {
    try {
      // PERMISSION FIRST, AND WAIT FOR IT.
      //
      // This is not just because the SDK needs location. Requesting permission
      // launches GrantPermissionsActivity, which PAUSES our activity — and if a
      // Navigation SDK map fragment is pending creation at that moment, the
      // FragmentManager builds it mid-pause and Google's code dies:
      //
      //   NullPointerException ... at SupportMapFragment.onCreateView
      //   ... at FragmentManager.dispatchPause
      //
      // Awaiting the request here means the dialog is finished before any
      // caller is told the session is ready, so no map view can be mounted
      // while the activity is pausing. Returns immediately when permission was
      // granted on a previous launch.
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) return NavigationSessionStatus.LOCATION_PERMISSION_MISSING;

      // Google requires their driver-awareness terms before a session can
      // exist. Acceptance is remembered by the SDK across launches, so this
      // resolves immediately for returning riders.
      const accepted = await controller.areTermsAccepted().catch(() => false);
      if (!accepted) {
        // Branded, not bare.
        //
        // Called with no options, the SDK renders its stock dialog: a generic
        // title, no company name, and the FULL legal text with most of it
        // greyed out. On a phone that reads like a system error the rider has
        // to dismiss, not like a step in ParkStop — which is exactly how it
        // was being reported.
        //
        // `showOnlyDisclaimer` (Android) drops the wall of greyed licence text
        // and keeps just the driver-awareness message, which is the part that
        // actually concerns the rider. The colours are ParkStop's own, so the
        // dialog reads as ours rather than as a Google interstitial.
        const ok = await controller.showTermsAndConditionsDialog({
          title: 'Navigate with ParkStop',
          companyName: 'ParkStop',
          showOnlyDisclaimer: true,
          uiParams: {
            backgroundColor: '#0f172a',
            titleColor: '#ffffff',
            mainTextColor: '#cbd5e1',
            acceptButtonTextColor: '#818cf8',
            cancelButtonTextColor: '#94a3b8',
          },
        });
        if (!ok) return NavigationSessionStatus.TERMS_NOT_ACCEPTED;
      }
      return await controller.init();
    } catch {
      // A thrown init is as fatal as a failed one, and callers should not have
      // to handle both shapes.
      return NavigationSessionStatus.UNKNOWN_ERROR;
    }
  })();

  // A failed session must not be cached forever — the usual causes (no network,
  // permission not yet granted, key restriction still propagating) all clear on
  // their own, and a rider who fixes one should not have to restart the app.
  sessionPromise = sessionPromise.then(status => {
    if (status !== NavigationSessionStatus.OK) sessionPromise = null;
    return status;
  });

  return sessionPromise;
}

/** Forget the cached session, so the next call retries from scratch. */
export function resetNavSession(): void {
  sessionPromise = null;
}

// ── Destination pre-warm ─────────────────────────────────────────
//
// Computing a route is a network round-trip, and it only starts when
// setDestination is called. Doing that when the navigation screen opens means
// the rider watches a blank banner while Google works. Doing it at booking
// confirmation instead means the route is computed while they finish paying,
// and guidance appears almost immediately.
//
// This is an OPTIMISATION and must never become a dependency: if the pre-warm
// is slow, fails, or never ran, navigation sets the destination itself exactly
// as before. The only thing tracked here is whether a given destination has
// already been handed to the SDK, so it is not requested twice.

/** Stable key for a destination, at roughly 10cm precision. */
export const destKey = (lat: number, lng: number) =>
  `${lat.toFixed(6)},${lng.toFixed(6)}`;

let preparedDest: string | null = null;

/** True when this exact destination has already been sent to the SDK. */
export function isDestinationPrepared(key: string): boolean {
  return preparedDest === key;
}

/** Forget the pre-warm — call when the rider abandons or changes the booking. */
export function clearPreparedDestination(): void {
  preparedDest = null;
}

/**
 * Send the destination to Google early, WITHOUT starting guidance.
 *
 * Guidance deliberately does not start here: the rider is still on the booking
 * sheet, and hearing "head south" while choosing a slot would be alarming. Only
 * the route is computed.
 */
export async function prepareDestination(
  controller: NavigationController,
  dest: { lat: number; lng: number; title?: string },
  routingOptions: any
): Promise<void> {
  const key = destKey(dest.lat, dest.lng);
  if (preparedDest === key) return;
  try {
    const status = await ensureNavSession(controller);
    if (status !== NavigationSessionStatus.OK) return;
    const res = await controller.setDestination(
      { title: dest.title || 'Parking spot', position: { lat: dest.lat, lng: dest.lng } },
      routingOptions
    );
    // Only claim it if Google actually built a route. Marking a failed attempt
    // as prepared would make navigation skip its own setDestination and start
    // guidance with no route at all.
    if (res === 'OK' || res === undefined) preparedDest = key;
  } catch {
    // Silent: the rider is mid-booking and this is invisible groundwork.
    // Navigation will do it properly when it opens.
  }
}
