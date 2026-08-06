/**
 * authErrors.ts — turn raw auth/network errors into clean, professional
 * messages for the user.
 *
 * The auth screens previously showed developer-facing text on failure (e.g.
 * "Cannot connect to backend server … port 3000 … Windows Firewall"). That is
 * inaccurate and unprofessional for an end user. This maps errors — especially
 * the offline case — to friendly, actionable prompts, the way polished apps do.
 */
import { Alert, Platform } from 'react-native';
import { isNetworkError } from './networkStatus';

export const OFFLINE_TITLE = "You're offline";
export const OFFLINE_MESSAGE = 'Please check your internet connection and try again.';

/** Map any auth/network error to a clean { title, message } pair. */
export function getAuthErrorMessage(error: any): { title: string; message: string } {
  // Offline / can't reach the server — the case this was built for.
  if (isNetworkError(error)) {
    return { title: OFFLINE_TITLE, message: OFFLINE_MESSAGE };
  }

  const code: string | number | undefined = error?.code;
  const status: number | undefined = error?.response?.status;
  const serverMsg: string | undefined = error?.response?.data?.message;

  if (status === 429 || code === 'auth/too-many-requests') {
    return { title: 'Too many attempts', message: 'Please wait a few minutes and try again.' };
  }

  // Native Google Sign-In cancelled (code 12501) or dismissed.
  if (code === 12501 || code === '12501' || code === 'SIGN_IN_CANCELLED' || code === 'auth/popup-closed-by-user') {
    return { title: 'Sign-in cancelled', message: 'You closed the sign-in before it finished. Please try again.' };
  }
  // Native Google Sign-In config problem — keep it non-technical for the user.
  if (code === 10 || code === '10' || code === 'DEVELOPER_ERROR') {
    return { title: 'Sign-in unavailable', message: "Google sign-in isn't available right now. Please try email sign-in, or try again later." };
  }

  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return { title: 'Sign-in failed', message: 'Incorrect email or password.' };
    case 'auth/invalid-email':
      return { title: 'Invalid email', message: 'Please enter a valid email address.' };
    case 'auth/email-already-in-use':
      return { title: 'Email already in use', message: 'An account with this email already exists. Try signing in instead.' };
    case 'auth/weak-password':
      return { title: 'Weak password', message: 'Please choose a password with at least 6 characters.' };
    case 'SIGN_IN_CANCELLED':
    case 'auth/popup-closed-by-user':
      return { title: 'Sign-in cancelled', message: 'You closed the sign-in before it finished. Please try again.' };
  }

  // Fall back to the server's own message if it's user-friendly, else a
  // neutral, non-technical line.
  return { title: 'Something went wrong', message: serverMsg || 'Please try again in a moment.' };
}

/** Show a clean, professional popup for an auth/network error. */
export function presentAuthError(error: any): void {
  const { title, message } = getAuthErrorMessage(error);
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    alert(`${title}\n\n${message}`);
  } else {
    Alert.alert(title, message);
  }
}
