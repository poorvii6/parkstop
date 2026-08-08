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
      onTapped: (notification: any) => {
        const data = notification?.request?.content?.data || {};
        const type = data.type;
        const bookingId = data.bookingId != null ? String(data.bookingId) : undefined;
        try {
          if (type === 'booking_confirmed') {
            // Finder's confirmation → their booking view.
            router.push('/finder');
          } else if (type === 'new_booking' || type === 'finder_nearby' || type === 'booking_cancelled') {
            // Spotter-facing events → the verify/active-bookings screen, focused on the booking.
            router.push({ pathname: '/spotter/verify', params: bookingId ? { bookingId } : {} });
          } else {
            router.push('/notifications');
          }
        } catch {
          try { router.push('/notifications'); } catch {}
        }
      },
    });
    return unsubscribe;
  }, [router]);

  return null;
}
