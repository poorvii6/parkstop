/**
 * services/cashfree.ts — Cashfree UPI checkout for the finder.
 *
 * Flow:
 *   1. payBookingWithCashfree(bookingId) asks our backend for a split order
 *      (80% spotter / 20% ParkStop) and gets a payment_session_id.
 *   2. It opens Cashfree's UPI Intent checkout — the finder picks GPay / PhonePe /
 *      Paytm and their app opens with the amount prefilled (the "Zomato" feel).
 *   3. When the SDK reports the flow finished (onVerify), we confirm server-side
 *      with verifyCashfreePayment() — which asks Cashfree "is this order PAID?"
 *      and marks the booking paid. (We do NOT rely on the dashboard webhook,
 *      which is gated behind full account activation.)
 */
import { CFErrorResponse, CFPaymentGatewayService } from 'react-native-cashfree-pg-sdk';
import {
  CFSession,
  CFEnvironment,
  CFThemeBuilder,
  CFUPIIntentCheckoutPayment,
} from 'cashfree-pg-api-contract';
import apiClient from '../api/client';

type Handlers = {
  onSuccess: (orderId: string) => void;
  onError: (message: string) => void;
};

/** Register the SDK callbacks. Call once (e.g. in a useEffect) before paying. */
export function setCashfreeCallbacks({ onSuccess, onError }: Handlers) {
  CFPaymentGatewayService.setCallback({
    onVerify(orderId: string) {
      onSuccess(orderId);
    },
    onError(error: CFErrorResponse, _orderId: string) {
      let msg = 'Payment failed';
      try {
        // CFErrorResponse exposes getMessage()/getCode() on some versions,
        // plain fields on others — handle both.
        msg =
          (typeof (error as any)?.getMessage === 'function' && (error as any).getMessage()) ||
          (error as any)?.message ||
          JSON.stringify(error) ||
          msg;
      } catch {}
      onError(msg);
    },
  });
}

/** Remove callbacks on unmount so stale handlers don't fire. */
export function removeCashfreeCallbacks() {
  try {
    CFPaymentGatewayService.removeCallback();
  } catch {}
}

/**
 * Start a Cashfree UPI-intent checkout for a booking.
 * Returns the Cashfree order_id (used to verify afterwards).
 */
export async function payBookingWithCashfree(bookingId: number): Promise<string> {
  const res = await apiClient.post('/payments/cashfree/checkout', { bookingId });
  if (!res.data?.success) {
    throw new Error(res.data?.message || 'Could not start checkout');
  }
  const { payment_session_id, order_id, mode } = res.data.data;
  const env = mode === 'production' ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;

  const session = new CFSession(payment_session_id, order_id, env);
  const theme = new CFThemeBuilder()
    .setNavigationBarBackgroundColor('#4285F4')
    .setNavigationBarTextColor('#FFFFFF')
    .setButtonBackgroundColor('#4285F4')
    .setButtonTextColor('#FFFFFF')
    .setPrimaryTextColor('#0f172a')
    .setSecondaryTextColor('#64748b')
    .build();

  const upiPayment = new CFUPIIntentCheckoutPayment(session, theme);
  CFPaymentGatewayService.doUPIPayment(upiPayment);
  return order_id;
}

/**
 * Confirm with our backend that the order was actually paid.
 * Returns true if the booking is now settled.
 */
export async function verifyCashfreePayment(orderId: string, bookingId: number): Promise<boolean> {
  const res = await apiClient.post('/payments/cashfree/verify', { orderId, bookingId });
  return !!res.data?.data?.paid;
}
