import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { auth } from '../services/firebase';
import { isNetworkError, reportNetworkFailure, reportNetworkSuccess } from '../utils/networkStatus';

import * as Device from 'expo-device';

let cachedApiUrl: string | null = null;

const getAPIUrlSync = () => {
  if (cachedApiUrl) return cachedApiUrl;

  let apiUrl = process.env.EXPO_PUBLIC_API_URL || Platform.select({
    android: 'https://parkstop-production.up.railway.app/api/v1',
    ios: 'https://parkstop-production.up.railway.app/api/v1',
    default: 'https://parkstop-production.up.railway.app/api/v1',
  })!;

  // In local development, dynamically rewrite localhost to the Metro host IP 
  // ONLY for emulators/simulators. For physical devices connected via USB, 
  // we want to preserve 'localhost' so adb reverse works.
  if (__DEV__ && Platform.OS !== 'web' && !Device.isDevice) {
    const hostUri = Constants.expoConfig?.hostUri || '';
    let metroHost = hostUri.split(':')[0];
    if (!metroHost) {
      metroHost = '192.168.31.68';
      console.log(`[API] hostUri was empty. Falling back to known Wi-Fi IP: ${metroHost}`);
    }
    if (metroHost) {
      if (apiUrl.includes('localhost')) {
        apiUrl = apiUrl.replace('localhost', metroHost);
        console.log(`[API] Rewrote localhost to Metro host: ${metroHost}`);
      } else if (apiUrl.includes('127.0.0.1')) {
        apiUrl = apiUrl.replace('127.0.0.1', metroHost);
        console.log(`[API] Rewrote 127.0.0.1 to Metro host: ${metroHost}`);
      }
    }
  }

  cachedApiUrl = apiUrl;
  if (__DEV__) console.log(`[API] Using backend: ${apiUrl}`);
  return apiUrl;
};

const getAPIUrl = async () => {
  return getAPIUrlSync();
};

const apiClient = axios.create({
  baseURL: getAPIUrlSync(),
  timeout: 15000,
  headers: {
    'Bypass-Tunnel-Reminder': 'true',
  },
});

// ---- Proactive reconnect probe ----
// While we believe we're offline, quietly poll /health so we detect the moment
// the network returns and fire ONLINE (which makes screens refetch) instead of
// waiting for the user's next action. Stops as soon as we're reachable again.
let reconnectProbe: ReturnType<typeof setInterval> | null = null;

function healthUrl(): string {
  const base = apiClient.defaults.baseURL || getAPIUrlSync();
  return base.replace(/\/api\/v1\/?$/, '') + '/health';
}

function startReconnectProbe() {
  if (reconnectProbe) return;
  reconnectProbe = setInterval(async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(healthUrl(), { method: 'GET', signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        stopReconnectProbe();
        reportNetworkSuccess(); // fires ONLINE -> screens refetch immediately
      }
    } catch {
      // still offline — keep probing
    }
  }, 3000);
}

function stopReconnectProbe() {
  if (reconnectProbe) {
    clearInterval(reconnectProbe);
    reconnectProbe = null;
  }
}

// REQUEST INTERCEPTOR: Inject dynamic URL and Auth token
apiClient.interceptors.request.use(
  async (config) => {
    if (!config.baseURL) {
      config.baseURL = await getAPIUrl();
    }

    if (__DEV__) {
      console.log('[API REQUEST]');
      console.log('Base URL:', config.baseURL);
      console.log('Final URL:', `${config.baseURL}${config.url}`);
    }

    try {
      const currentUser = auth.currentUser;
      if (currentUser) {
        const token = await currentUser.getIdToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      } else {
        // Fallback for guest mode / offline_token
        const token = await AsyncStorage.getItem('access_token');
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      }
    } catch (e) {
      // Offline: Firebase token refresh throws auth/network-request-failed.
      // Don't surface a banner from here — it's noisy and often transient. The
      // response interceptor decides about connectivity based on real requests.
      if (!isNetworkError(e)) {
        console.error('Auth Request Interceptor Error:', e);
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// Guards against a burst of parallel 401s each tearing down the session.
let isSigningOut = false;

// RESPONSE INTERCEPTOR: Retry on 502/503 (Railway cold start), handle 401
apiClient.interceptors.response.use(
  (response) => {
    // A real response came back → we are reachable. Clears any pending/showing
    // "can't reach ParkStop" banner and stops the reconnect probe.
    stopReconnectProbe();
    reportNetworkSuccess();
    return response;
  },
  async (error) => {
    const config = error.config;
    const status = error.response?.status;

    // No response reached the server → possible connectivity loss. Report it;
    // the banner only appears if nothing succeeds within a short grace window
    // (so backend cold-starts and transient blips stay silent).
    if (isNetworkError(error)) {
      reportNetworkFailure();
      startReconnectProbe(); // start watching for reconnection so we recover fast
      return Promise.reject(error);
    }

    // Retry once on 502/503 (server waking up) with a short delay
    if ((status === 502 || status === 503) && config && !config._retried) {
      config._retried = true;
      if (__DEV__) console.log(`[API] Got ${status}, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
      return apiClient(config);
    }

    if (status === 401) {
      const url: string = config?.url || '';

      // NOT every 401 means "your session died".
      //
      // During sign-in there is a window where Firebase has authenticated the
      // user but /auth/social-login has not yet created (or linked) their row
      // in our database. Any authenticated call that races ahead of that —
      // push-token registration is the usual culprit, since it fires as soon
      // as a token is obtained — legitimately 401s.
      //
      // Treating those as an expired session was catastrophic: this handler
      // signed the user out and bounced them to /login *in the middle of
      // logging in*, which tore down the in-flight social-login and produced
      // an endless loop plus a multi-second freeze from several concurrent
      // signOut + navigation calls.
      //
      // So: 401s from the auth handshake itself are surfaced to the caller to
      // handle, but never sign anyone out.
      const isHandshakeEndpoint =
        url.includes('/auth/push-token') ||
        url.includes('/auth/social-login') ||
        url.includes('/auth/register') ||
        url.includes('/auth/login');

      if (isHandshakeEndpoint) {
        if (__DEV__) console.log(`[API] 401 on ${url} during auth handshake — not signing out.`);
        return Promise.reject(error);
      }

      if (__DEV__) console.log('[API] Request returned 401 Unauthorized - Redirecting to login.');

      // Only one teardown, however many requests fail at once. Without this,
      // a screen firing several parallel calls produces several signOuts,
      // several Alerts and several navigations — which is what made the UI
      // lock up for seconds.
      if (isSigningOut) return Promise.reject(error);
      isSigningOut = true;

      try {
        await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role']);

        try {
          await auth.signOut();
        } catch (signOutErr) {
          console.error('Signout Error on 401:', signOutErr);
        }

        if (Platform.OS !== 'web') {
          const { Alert } = require('react-native');
          Alert.alert('Session Expired', 'Please log in again.', [{ text: 'OK' }]);
        }

        const { router } = require('expo-router');
        router.replace('/login');
      } finally {
        // Release after the redirect settles so late failures from the old
        // screen don't immediately re-trigger the whole sequence.
        setTimeout(() => { isSigningOut = false; }, 3000);
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
