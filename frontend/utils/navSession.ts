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
        const ok = await controller.showTermsAndConditionsDialog();
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
