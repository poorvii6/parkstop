# Synthesis Analysis Report - E2E Testing Track

## Consensus
All three Explorer subagents (Explorer 1, 2, and 3) have reached a consensus on the following architecture and design for the E2E testing track:
1. **API Endpoints**:
   - Auth: `/api/v1/auth/register` and `/api/v1/auth/login`.
   - Booking: `POST /api/v1/bookings`, `POST /api/v1/bookings/verify-otp`, `POST /api/v1/bookings/verify-checkout-otp`.
   - Checkout: `POST /api/v1/payments/checkout`.
   - Verification: `POST /api/v1/payments/razorpay/verify` (with `razorpay_signature: 'mock_upi_intent'`).
2. **UPI App Checking**:
   - The React Native `Linking.canOpenURL` check determines whether an app is installed.
   - If installed, it deep-links using specific app schemes: GPay (`gpay://upi/pay?...`), PhonePe (`phonepe://upi/pay?...`), Paytm (`paytmmp://upi/pay?...`), or Generic (`upi://pay?...`).
   - If not installed (or launch fails), it triggers a mock checkout modal styled with the app's brand colors (GPay: Blue, PhonePe: Purple, Paytm: Light Blue, Generic: Dark Slate).
3. **Database Assertions via Prisma**:
   - Check `bookings.payment_status` is `'paid'` and booking status is `'completed'`.
   - Check `users.balance` for the Spotter: increments by `spotter_earning` for online payment, and decrements by `platform_fee` for cash payments.
   - Check `payouts` ledger table record creation.
4. **Execution Strategy**:
   - The E2E tests will run in a standalone Node.js environment under `tests/e2e`.
   - A custom runner will start the Express server using a test configuration, seed the database with test data, and run tests.

## Resolved Conflicts
No conflicts identified. All explorers reached identical conclusions on codebase entry points, signature bypass parameters, and payout fallbacks.

## Dissenting Views
None.

## Gaps
- Socket.io live connection updates: Explorers noted that while we could test WebSocket updates, testing the REST API response states and database results is sufficient for E2E checkout verification.
