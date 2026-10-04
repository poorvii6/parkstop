/**
 * networkStatus.ts — accurate, non-annoying connectivity feedback.
 *
 * The banner must NEVER appear when the device is actually online. Rules:
 *   1. Startup grace: ignore all failures for the first 20 seconds after module
 *      load. The app bootstraps a lot — Firebase, Expo, push, splash — and any
 *      brief flake at that moment is not a user-visible connectivity problem.
 *   2. Need SEVERAL consecutive failures with NO successes to show the banner.
 *      A single blip or a backend cold-start never counts.
 *   3. A successful request immediately resets the failure counter and clears
 *      the banner.
 *   4. NetInfo's negative signal does NOT trigger the banner. Its captive-
 *      portal probe (connectivitycheck.gstatic.com) is unreliable on carrier
 *      networks, VPNs, custom DNS, and Jio/Airtel hotspots. We only trust it
 *      for the POSITIVE recovery signal.
 */
import { DeviceEventEmitter, NativeModules } from 'react-native';

export const OFFLINE_EVENT = 'network-offline';
export const ONLINE_EVENT = 'network-online';

export function isNetworkError(error: any): boolean {
  if (!error) return false;
  if (error.code === 'auth/network-request-failed') return true;
  if (error.code === 'ERR_NETWORK') return true;
  if (error.message === 'Network Error') return true;
  if (error.isAxiosError && !error.response) return true;
  if (error.code === 'ECONNABORTED') return true;
  if (error.code === 7 || error.code === '7') return true;
  if (typeof error.message === 'string' && error.message.toUpperCase() === 'NETWORK_ERROR') return true;
  return false;
}

// -------- Tuning knobs --------
const STARTUP_GRACE_MS = 20000;   // ignore every failure for the first 20s after launch
const FAILURE_WINDOW_MS = 12000;  // failures older than this don't count
const FAILURES_TO_SHOW = 3;       // need N failures within the window with no success in between
const THROTTLE_MS = 15000;        // show the banner at most once per this window

// -------- State --------
const bootTime = Date.now();
let failureTimestamps: number[] = [];
let bannerVisible = false;
let lastShownAt = 0;
let deviceOnline: boolean | null = null;

const DEFAULT_MSG = "Connection problem — can't reach ParkStop. Check your internet.";

function nowPastStartupGrace(): boolean {
  return Date.now() - bootTime > STARTUP_GRACE_MS;
}

function pruneOldFailures(now: number): void {
  failureTimestamps = failureTimestamps.filter(t => now - t <= FAILURE_WINDOW_MS);
}

/**
 * Report a network-level failure. The banner only appears if we have had
 * FAILURES_TO_SHOW consecutive failures within FAILURE_WINDOW_MS with no
 * success in between, AND we're past the startup grace period.
 */
export function reportNetworkFailure(message: string = DEFAULT_MSG): void {
  const now = Date.now();

  // Startup grace: ignore everything that fires during app bootstrap.
  if (!nowPastStartupGrace()) return;

  // Already showing the banner — nothing more to do.
  if (bannerVisible) return;

  failureTimestamps.push(now);
  pruneOldFailures(now);

  if (failureTimestamps.length < FAILURES_TO_SHOW) return;
  if (now - lastShownAt < THROTTLE_MS) return;

  lastShownAt = now;
  bannerVisible = true;
  DeviceEventEmitter.emit(OFFLINE_EVENT, message);
}

/**
 * Report a successful response. Resets the failure counter and, if the banner
 * is showing, hides it (we're clearly reachable).
 */
export function reportNetworkSuccess(): void {
  const wasFailing = failureTimestamps.length > 0 || bannerVisible;
  failureTimestamps = [];
  if (bannerVisible) {
    bannerVisible = false;
    DeviceEventEmitter.emit(ONLINE_EVENT);
  } else if (wasFailing) {
    // Brief dip that never surfaced — still emit ONLINE so screens refetch.
    DeviceEventEmitter.emit(ONLINE_EVENT);
  }
}

/**
 * NOT USED. Kept as an export for back-compat so a hypothetical caller that
 * imports it does not crash. The device-level connectivity probe we had was
 * unreliable; the banner is driven exclusively by request-based detection now.
 */
export function forceOffline(_message: string = DEFAULT_MSG): void {
  // Intentionally a no-op. Do not force the banner from any OS-level signal.
}

/** True only when we positively know the device has no connection. */
export function isDefinitelyOffline(): boolean {
  return deviceOnline === false;
}

let monitorStarted = false;
/**
 * Start listening to the OS connectivity state. We ONLY use it to CLEAR the
 * banner on reconnect — never to show it. The pessimistic signal (gstatic
 * probe) is too unreliable on real-world networks.
 */
export function initConnectivityMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  try {
    if (!(NativeModules as any)?.RNCNetInfo) return;
    const NetInfo = require('@react-native-community/netinfo').default;
    if (!NetInfo?.addEventListener) return;
    NetInfo.addEventListener((state: any) => {
      if (state?.isConnected === true) {
        deviceOnline = true;
        reportNetworkSuccess();
      } else if (state?.isConnected === false) {
        // Note it locally; never force the banner.
        deviceOnline = false;
      }
    });
  } catch {
    // NetInfo unavailable — request-based detection still works.
  }
}

/** Back-compat alias for any existing callers. */
export const notifyOffline = reportNetworkFailure;
