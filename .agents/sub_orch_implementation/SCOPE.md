# Scope: Implementation Track

## Architecture
- React Native/Expo frontend: Payment selector modal and new Mock Simulator modals (Google Pay, PhonePe, Paytm, generic UPI).
- Backend: Razorpay payment verification endpoint checking for signature `mock_upi_intent` to simulate successful payment, updating database, and triggering spotter payouts.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | R1: Brand-Accurate Logos | Replace payment emojis with SVG/vector-like styling or local image assets for UPI brands. | none | PLANNED |
| 2 | R2: UPI Launch Fallback | Implement `Linking.canOpenURL` check, open app if installed, fallback to styled mock modals. | M1 | PLANNED |
| 3 | R3: Backend Integration & E2E | Connect mock modals to backend `/payments/razorpay/verify` with `mock_upi_intent` signature, verify receipt, run full E2E suite. | M2 | PLANNED |

## Interface Contracts
### Frontend ↔ Backend Payments Verification
- Endpoint: `/api/payments/razorpay/verify` (or similar endpoint)
- Payload format: `{ bookingId: string, razorpay_payment_id: string, razorpay_order_id: string, razorpay_signature: 'mock_upi_intent' }`
- Expected response: `{ success: true, booking: { status: 'paid' } }`
