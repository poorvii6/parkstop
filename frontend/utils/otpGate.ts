/**
 * otpGate.ts — remembers that THIS Firebase user passed the login OTP.
 *
 * Firebase keeps the user signed in across app restarts. Without this marker,
 * someone could sign in with Google, close the app at the OTP screen, reopen
 * it and land inside without ever entering the code. The splash screen
 * (app/index.tsx) checks this marker and signs the user out if it is missing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'otp_verified_uid';

/** Call only after the server has accepted the OTP. */
export async function markOtpVerified(uid: string | undefined | null): Promise<void> {
  if (!uid) return;
  await AsyncStorage.setItem(KEY, uid);
}

/** True only if this exact Firebase user passed the OTP on this phone. */
export async function isOtpVerified(uid: string | undefined | null): Promise<boolean> {
  if (!uid) return false;
  try {
    return (await AsyncStorage.getItem(KEY)) === uid;
  } catch {
    return false;
  }
}

/** Forget the marker (on logout or when the OTP step is cancelled). */
export async function clearOtpVerified(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}
