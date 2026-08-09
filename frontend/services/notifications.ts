import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform, AppState, Linking } from 'react-native';
import apiClient from '../api/client';

const isExpoGo = Constants.appOwnership === 'expo';

// Only load and configure expo-notifications if not running in Expo Go
// (remote push is removed from Expo Go on SDK 53+).
let Notifications: any = null;
if (!isExpoGo) {
  try {
    Notifications = require('expo-notifications');
    Notifications.setNotificationHandler({
      // De-dupe: when the app is in the FOREGROUND, the Socket.io channel already
      // shows the update in-app, so we suppress the system banner/sound to avoid
      // a double notification. In the background we show everything.
      handleNotification: async () => {
        const inForeground = AppState.currentState === 'active';
        return {
          shouldShowAlert: !inForeground,
          shouldShowBanner: !inForeground,
          shouldPlaySound: !inForeground,
          shouldSetBadge: true,
          shouldShowList: true,
        };
      },
    });
  } catch (err) {
    console.warn('Failed to load expo-notifications:', err);
  }
}

/**
 * Resolve the EAS project ID from every place Expo may store it. After you run
 * `eas init`, it lands in app.json under expo.extra.eas.projectId and is read
 * here automatically — no need to duplicate it into .env.
 */
function getProjectId(): string | undefined {
  return (
    (Constants.expoConfig as any)?.extra?.eas?.projectId ||
    (Constants as any)?.easConfig?.projectId ||
    process.env.EXPO_PUBLIC_PROJECT_ID ||
    undefined
  );
}

// Remember this device's most recent token so we can hand it to /auth/logout
// (lets the backend detach it, so a shared phone stops old notifications).
let currentPushToken: string | null = null;

/** The current device's Expo push token, or null if not registered yet. */
export function getCurrentPushToken(): string | null {
  return currentPushToken;
}

/** Save a device token against the current user (all devices are kept). */
async function sendTokenToBackend(token: string): Promise<void> {
  currentPushToken = token;

  // Don't post the token before there is a signed-in Firebase user. This call
  // races the login handshake: it fires the moment Expo hands us a token,
  // which can be before /auth/social-login has created the user's row. The
  // request then 401s for a reason that has nothing to do with an expired
  // session. Retrying later is free — the token is cached above, and the
  // AppState/token listeners re-register on the next foreground.
  try {
    const { auth } = require('./firebase');
    if (!auth?.currentUser) {
      console.log('[Push] No signed-in user yet — deferring token registration.');
      return;
    }
  } catch {
    // If the auth module isn't ready, defer rather than guess.
    return;
  }

  try {
    await apiClient.post('/auth/push-token', { push_token: token, platform: Platform.OS });
    console.log('[Push] Token registered with backend.');
  } catch (e) {
    console.log('[Push] Failed to send token to backend:', e);
  }
}

let listenersAttached = false;
/**
 * Attach one-time listeners so tokens stay fresh:
 *  - addPushTokenListener → re-save when Expo rotates the token,
 *  - AppState 'active'    → re-register whenever the app returns to foreground.
 */
function attachTokenListenersOnce(): void {
  if (listenersAttached || !Notifications) return;
  listenersAttached = true;

  try {
    Notifications.addPushTokenListener((t: any) => {
      const token = t?.data || t;
      if (token) sendTokenToBackend(token);
    });
  } catch {}

  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      registerForPushNotificationsAsync().catch(() => {});
    }
  });
}

/** Current OS-level notification permission status. */
export async function getNotificationPermissionStatus(): Promise<string> {
  if (!Notifications) return 'unsupported';
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status; // 'granted' | 'denied' | 'undetermined'
  } catch {
    return 'unsupported';
  }
}

/** Open the OS settings so a user who denied notifications can re-enable them. */
export async function openNotificationSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch {}
}

/**
 * Request permission and get the Expo Push Token for the current device, then
 * send it to our backend. Returns the token, or null if unavailable.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (isExpoGo) {
    console.log('[Push] Remote push is not available in Expo Go (SDK 53+). Use a development or production build.');
    return null;
  }
  if (!Notifications) {
    console.log('[Push] expo-notifications is not loaded.');
    return null;
  }
  if (!Device.isDevice) {
    console.log('[Push] Must use a physical device for push notifications.');
    return null;
  }

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX, // heads-up alerts
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#3b82f6',
    });
  }

  // Ask for permission (gracefully handle denial).
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== 'granted') {
    console.log('[Push] Notification permission not granted. The user can re-enable it in system settings (see openNotificationSettings()).');
    return null;
  }

  const projectId = getProjectId();
  if (!projectId) {
    console.log('[Push] No EAS projectId found. Run `eas init` (writes expo.extra.eas.projectId in app.json), then rebuild the app.');
    return null;
  }

  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    console.log('[Push] Expo push token obtained.');
    await sendTokenToBackend(token);
    attachTokenListenersOnce();
    return token;
  } catch (e) {
    console.log('[Push] Error getting or saving push token:', e);
    return null;
  }
}

/**
 * Attach foreground + tap listeners so the app can react to a push while open
 * (e.g. refresh a list) or when the user taps a notification (e.g. navigate).
 * Returns an unsubscribe function — call it on unmount.
 */
export function addNotificationListeners(handlers: {
  onReceived?: (notification: any) => void;
  onTapped?: (notification: any) => void;
}): () => void {
  if (!Notifications) return () => {};
  const receivedSub = Notifications.addNotificationReceivedListener((n: any) => {
    try { handlers.onReceived?.(n); } catch {}
  });
  const responseSub = Notifications.addNotificationResponseReceivedListener((r: any) => {
    try { handlers.onTapped?.(r?.notification); } catch {}
  });
  return () => {
    try { receivedSub.remove(); } catch {}
    try { responseSub.remove(); } catch {}
  };
}
