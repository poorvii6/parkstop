/**
 * NotificationTapHandler.tsx — mounted once in the root layout.
 *
 * When the user taps a system push notification (app in foreground or
 * background), this opens the in-app notifications screen so they land somewhere
 * meaningful instead of just the last screen. Renders nothing.
 */
import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { addNotificationListeners } from '../services/notifications';

export default function NotificationTapHandler() {
  const router = useRouter();

  useEffect(() => {
    const unsubscribe = addNotificationListeners({
      onTapped: () => {
        try { router.push('/notifications'); } catch {}
      },
    });
    return unsubscribe;
  }, [router]);

  return null;
}
