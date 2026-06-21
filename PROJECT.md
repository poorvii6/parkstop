# Project: Smart Parking App - Payment Brand Logos & Fallback Mock Simulator

## Architecture
The application has a React Native/Expo frontend and a Node.js/Prisma backend.
- Payments are triggered during the checkout phase of a booking session in the frontend (`frontend/app/finder/index.tsx`).
- The payment selector modal offers UPI apps (Google Pay, PhonePe, Paytm, generic UPI) and credit card payments.
- Real UPI apps are opened via deep-links (`gpay://`, `phonepe://`, `paytmmp://`, `upi://`).
- The backend verifies Razorpay/Stripe payments, marks the booking as paid, and payouts are initiated to the spotter.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | E2E Testing Track | Design and implement the comprehensive E2E test suite; publish `TEST_READY.md`. | none | IN_PROGRESS |
| 2 | Implementation Track | Implement brand-accurate logos, UPI launch checks, mock simulator, and verify against E2E tests and adversarial testing. | none | IN_PROGRESS |

## Interface Contracts
### Payments Integration
- Frontend calls `Linking.canOpenURL()` for UPI app schemes:
  - Google Pay: `gpay://upi/pay` or `gpay://`
  - PhonePe: `phonepe://upi/pay` or `phonepe://`
  - Paytm: `paytmmp://upi/pay` or `paytmmp://`
- If app is installed, open via `Linking.openURL(upiUrl)`.
- If app is not installed, open the mock simulator modal styled as the selected app (Google Pay, PhonePe, Paytm, or generic UPI).
- Completing the mock payment calls the backend verification endpoint `/payments/razorpay/verify` (or equivalent mock endpoint) with `razorpay_signature: 'mock_upi_intent'` to set booking as paid.

## Code Layout
- `frontend/app/finder/index.tsx` - Main screen showing booking/checkout flows and payment modals.
- `frontend/components/RazorpayCheckout.tsx` - WebView Razorpay checkout component.
- `backend/src/controllers/paymentController.js` - Backend endpoints for checkout and verification.
- `backend/src/services/paymentService.js` - Service layer handling Razorpay verification and spotter payouts.
