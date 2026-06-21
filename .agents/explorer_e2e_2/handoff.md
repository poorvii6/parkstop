# Handoff Report: E2E Integration Testing Track Recommendation

## 1. Observation
- **Prisma Schema File (`backend/prisma/schema.prisma`)**:
  - `bookings` model has columns: `id`, `user_id`, `status` (default: `'active'`, but set to `'reserved'` on creation), `otp_code` (check-in PIN), `checkout_otp`, `total_price`, `payment_status` (default: `'pending'`), `payment_mode` (default: `'online'`), `spotter_earning` (Decimal), `platform_fee` (Decimal) (lines 13-40).
  - `payouts` model has columns: `id`, `user_id`, `booking_id`, `amount`, `status` (default: `'pending'`), `mode` (default: `'UPI'`) (lines 128-142).
  - `users` model has column `balance` (Decimal) (line 107).
- **Razorpay Signature Bypass (`backend/src/services/paymentService.js`)**:
  - Line 48:
    ```javascript
    const isValid = signature === 'mock_upi_intent' ? true : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);
    ```
    This verifies that passing `'mock_upi_intent'` as the signature successfully bypasses Razorpay validation.
- **Spotter Payout Fallback (`backend/src/services/payments/PayoutService.js`)**:
  - Lines 167-170:
    ```javascript
    if (!this.accountNumber) {
      logger.warn('RAZORPAY_ACCOUNT_NUMBER not set — skipping live payout, crediting balance only');
      return this._createLocalPayout(userId, bookingId, amount, mode, narration);
    }
    ```
    Lines 238-242 in `_createLocalPayout`:
    ```javascript
    await prisma.users.update({
      where: { id: userId },
      data: { balance: { increment: parseFloat(amount) } }
    });
    ```
    This confirms that when `RAZORPAY_ACCOUNT_NUMBER` is not set, payouts default to updating the spotter's in-app balance in the database and inserting a local payout record.
- **Frontend Payment Flow (`frontend/app/finder/index.tsx`)**:
  - State machine transitions are controlled by the `step` variable of type `AppStep` (line 55).
  - Inside `handleUPIPayment` (lines 942-1024), the app performs a sequence of updating the backend payment-mode, calling `/payments/checkout` to get the order details, formatting the deep link URI (`gpay://upi/pay`, `phonepe://upi/pay`, `paytmmp://upi/pay`, or `upi://`), launching the URL via `Linking.openURL()`, and calling the `/payments/razorpay/verify` endpoint with `razorpay_signature: 'mock_upi_intent'` after a timeout.

---

## 2. Logic Chain
1. **Endpoint Sequence Validation**: The observations from the routes and controllers confirm the happy-path integration sequence: `auth/login` -> create booking (`POST /bookings`) -> verify check-in (`POST /bookings/verify-otp`) -> end session -> verify check-out (`POST /bookings/verify-checkout-otp`) -> pay (`POST /payments/checkout` & `POST /payments/razorpay/verify` with `'mock_upi_intent'`).
2. **Mock Payment Integration**: Observation of `paymentService.js` line 48 shows we can programmatically trigger a verified payment on the backend using `razorpay_signature: 'mock_upi_intent'` without mocking external gateways.
3. **Database Consistency Verification**: Observation of `PayoutService.js` shows that if live Razorpay credentials are empty, the code increments `users.balance` and inserts a `payouts` record. Therefore, we can reliably test payout logic by querying the database for a `payouts` row matching the `booking_id` and confirming that the spotter's `balance` increased by `spotter_earning`.
4. **Mock Client Driver Feasibility**: Since the mobile frontend in `index.tsx` is state-driven and communicates exclusively via REST APIs, we can write a Node.js class (`FinderDriver`) that mirrors `step` values and triggers API endpoints sequentially.
5. **Branding & Deep-Link Simulation**: By injecting custom variables into `FinderDriver` (e.g. `installedUpiApps = []`), we can assert that:
   - When GPay is installed, it verifies the GPay deep-link URL format and calls the verify endpoint on launch success.
   - When GPay is missing, it opens the mock fallback modal, simulates clicking "Complete Payment," and posts to the verify endpoint.

---

## 3. Caveats
- **Live Payments**: Real deep-linking and Razorpay gateway validations are bypassed; we assume signature check bypass operates the same as live execution.
- **WebSockets**: Real-time notifications emitted to the spotter are not explicitly checked by the HTTP client driver, though they could be integrated using a `socket.io-client` connection in the tests.

---

## 4. Conclusion
We recommend establishing a Node.js-based E2E test suite under `tests/e2e` that launches the backend server, runs a database migration reset, and uses mock client drivers (`FinderDriver` and `SpotterDriver`) to execute simulated state transitions. Database assertions using Prisma client are sufficient to check that bookings transition to `'completed'`, payments transition to `'paid'`, and payouts increase the spotter's balance correctly.

---

## 5. Verification Method
1. **Inspect Analysis Report**: Read the comprehensive strategy report at `tests/e2e/analysis.md` (or `.agents/explorer_e2e_2/analysis.md`).
2. **Run E2E Suite Command**: Once implemented by the implementer, run the test suite using:
   ```bash
   node tests/e2e/runner.js
   ```
   Or native Node test runner:
   ```bash
   node --test tests/e2e/cases/*.test.js
   ```
3. **Verify Database Records**: Query the PostgreSQL database directly or via Prisma to assert:
   ```sql
   SELECT * FROM bookings WHERE id = <id>;
   SELECT balance FROM users WHERE id = <spotter_id>;
   SELECT * FROM payouts WHERE booking_id = <id>;
   ```
