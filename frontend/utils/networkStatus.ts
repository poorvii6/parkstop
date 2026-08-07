/**
 * networkStatus.ts — accurate, non-annoying connectivity feedback.
 *
 * The problem this solves: a single failed or slow request — e.g. the Railway
 * backend cold-starting, or one flaky endpoint — should NOT make the app shout
 * "You're offline" when the device is perfectly online.
 *
 * Strategy (no native dependency needed):
 *   1. A network failure does NOT show the banner immediately. It starts a short
 *      GRACE timer. If ANY request succeeds within that window, the pending
 *      banner is cancelled — so cold-starts and transient blips never surface.
 *   2. Only if nothing succeeds for the whole grace window do we show one banner,
 *      and then at most once per throttle window.
 *   3. The wording does not falsely blame the user's internet — the problem may
 *      be our server, so it says "can't reach ParkStop".
 *   4. When a request finally succeeds again, we emit ONLINE so the banner hides.
 */
import { DeviceEventEmitter } from 'react-native';

export const OFFLINE_EVENT = 'network-offline';
export const ONLINE_EVENT = 'network-online';

/**
 * True when an error is a connectivity-level failure (no server response was
 * received), as opposed to a real HTTP error like 401/404/500 which DID reach
 * the server and must not be treated as "offline".
 */
export function isNetworkError(error: any): boolean {
  if (!error) return false;
  if (error.code === 'auth/network-request-failed') return true; // Firebase token refresh offline
  if (error.code === 'ERR_NETWORK') return true;                 // axios: no network
  if (error.message === 'Network Error') return true;
  if (error.isAxiosError && !error.response) return true;         // request sent, no response
  if (error.code === 'ECONNABORTED') return true;                // timeout (often a slow/cold server)

  // Native Google Sign-In (@react-native-google-signin) offline error:
  // it surfaces as { code: 7, message: 'NETWORK_ERROR' }.
  if (error.code === 7 || error.code === '7') return true;
  if (typeof error.message === 'string' && error.message.toUpperCase() === 'NETWORK_ERROR') return true;

  return false;
}

const GRACE_MS = 4000;     // wait this long, watching for a success, before deciding we're cut off
const THROTTLE_MS = 8000;  // show the banner at most once per this window

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let bannerVisible = false;
let lastShownAt = 0;

const DEFAULT_MSG = "Connection problem — can't reach ParkStop. Check your internet.";

/**
 * Report a network-level failure. The banner only appears if NO successful
 * request clears it within the grace window — so a single blip or a backend
 * cold-start that recovers quickly will never show anything.
 */
export function reportNetworkFailure(message: string = DEFAULT_MSG): void {
  if (pendingTimer || bannerVisible) return; // already deciding, or already shown
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const now = Date.now();
    if (now - lastShownAt < THROTTLE_MS) return;
    lastShownAt = now;
    bannerVisible = true;
    DeviceEventEmitter.emit(OFFLINE_EVENT, message);
  }, GRACE_MS);
}

/**
 * Report a successful response. Cancels any pending banner and, if one is
 * showing, hides it (we're clearly reachable again).
 */
export function reportNetworkSuccess(): void {
  const wasFailing = !!pendingTimer || bannerVisible;
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  bannerVisible = false;
  // Emit ONLINE on ANY recovery from a failed state — even a brief blip that
  // never showed the banner — so screens refetch stale data immediately. The
  // OfflineBanner ignores this unless it was actually showing "offline".
  if (wasFailing) DeviceEventEmitter.emit(ONLINE_EVENT);
}

/** Back-compat alias for any existing callers. */
export const notifyOffline = reportNetworkFailure;
