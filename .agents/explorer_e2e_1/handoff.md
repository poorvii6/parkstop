# Handoff Report — Explorer E2E 1

## 1. Observation

During my read-only investigation, I directly observed the following files and code blocks:

* **Backend Routing**:
  * In `backend/src/routes/bookings.js` (lines 26-69):
    * Line 26: `router.post('/', authenticate, authorize('FINDER'), ... BookingController.createBooking);`
    * Line 42: `router.post('/verify-otp', otpLimiter, authenticate, authorize('SPOTTER'), ... BookingController.verifyOTP);`
    * Line 58: `router.post('/verify-checkout-otp', otpLimiter, authenticate, authorize('SPOTTER'), ... BookingController.verifyCheckoutOTP);`
  * In `backend/src/routes/payments.js` (lines 12-21, 82-94):
    * Line 12: `router.post('/checkout', authenticate, authorize('FINDER'), ... PaymentController.createCheckoutSession);`
    * Line 82: `router.post('/razorpay/verify', authenticate, authorize('FINDER'), ... PaymentController.verifyRazorpayPayment);`

* **Mock Signature Bypass**:
  * In `backend/src/services/paymentService.js` (lines 46-48):
    ```javascript
    static async verifyRazorpayPayment(orderId, paymentId, signature, bookingId) {
      try {
        const isValid = signature === 'mock_upi_intent' ? true : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);
    ```
    This confirms that a mock signature string of `'mock_upi_intent'` is automatically accepted as valid.

* **In-App Wallet Fallback Payouts**:
  * In `backend/src/services/payments/PayoutService.js` (lines 167-170, 238-242):
    * Line 167: `if (!this.accountNumber) { logger.warn('RAZORPAY_ACCOUNT_NUMBER not set — skipping live payout, crediting balance only'); return this._createLocalPayout(...); }`
    * Line 238:
      ```javascript
      // Always credit in-app balance as fallback
      await prisma.users.update({
        where: { id: userId },
        data: { balance: { increment: parseFloat(amount) } }
      });
      ```
    This confirms that when live Razorpay credentials/account are not configured, the payout directly increments the Spotter's balance in the database.

* **Frontend Payment Handling**:
  * In `frontend/app/finder/index.tsx` (lines 942-995):
    * Simulates UPI launching with schemes: `gpay://upi/pay`, `phonepe://upi/pay`, `paytmmp://upi/pay`, and `upi://`.
    * Calls `/payments/checkout` to create a Razorpay order, parses deep-link parameters (`pa`, `pn`, `am`, `cu`, `tr`, `tn`), and tries `Linking.openURL()`.
    * In lines 997-1004:
      ```javascript
      const verification = await razorpayService.verifyPayment({
        bookingId: Number(bookingDetails?.id),
        razorpay_order_id: orderId,
        razorpay_payment_id: `pay_mock_upi_${Date.now()}`,
        razorpay_signature: 'mock_upi_intent',
      });
      ```

* **Database Models**:
  * In `backend/prisma/schema.prisma`:
    * Models `users`, `bookings`, `parking_spots`, and `payouts` are defined. `users.balance` is a Decimal field representing the wallet balance.

* **Pre-existing Integration Tests**:
  * In `backend/src/tests/test_razorpay_endpoints.js` (lines 75-146) and `backend/src/tests/test_billing_flow.js` (lines 61-86):
    * Demonstrate initializing test cases using `prisma.users.upsert` and direct controller simulation with mock Request/Response objects, followed by database assertions using `prisma.bookings.findUnique`.

---

## 2. Logic Chain

1. **API Flow Verification**: Because the backend provides register, login, reservation creation, check-in OTP verification, checkout OTP verification, payment checkout initiation, payment verification, and payout processing endpoints, a client driver can programmatically execute the entire lifecycle by storing JWT tokens returned from `/auth/login` and passing them in request headers.
2. **Deep-linking Verification**: In the frontend, the deep-link query parameters are constructed from the booking price, order ID, and transaction details. The client driver can verify correct query parameter formatting by intercepting the parameters and matching them to the expected schema (VPA `parkstop@razorpay`, currency `INR`, etc.).
3. **Mock Payment Verification**: The backend explicitly bypasses signature validation if `razorpay_signature` is `'mock_upi_intent'`. Therefore, E2E tests simulating the client's fallback modal payment can successfully complete payments by invoking `POST /payments/razorpay/verify` with this specific signature.
4. **Database Verification**: Payout transactions increment `users.balance` directly in the database when Razorpay credentials are not set (fallback payout mode). E2E tests can verify this by checking `users.balance` before and after the payment verification request.
5. **Separation of Concerns**: Suggesting a separate `tests/e2e/` folder with its own `package.json` allows tests to have separate dependencies (e.g. `jest` or `mocha`, `axios`) without polluting the production backend workspace.

---

## 3. Caveats

* **Geofence Check Bypass**: The frontend code has a geofence check (distance check) when completing a booking checkout. E2E tests executing directly against the Express backend do not run frontend coordinates checks unless they simulate the locations table. We must ensure the test environment uses a seeded location or mock coordinates in client simulation.
* **RazorpayX Live Payouts**: The live payout flow requires basic auth headers (`RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`). In the test environment, we assume these are mock/empty values to force the local fallback payout (`balance_credited`), which increments database balance.

---

## 4. Conclusion

It is highly feasible to implement a fully automated E2E testing suite in Node.js running against the Express backend.
The test runner should:
1. Reset the test database using `npx prisma db push --force-reset`.
2. Start the Express API server on a dedicated test port.
3. Instantiate simulated Finder and Spotter drivers using the `MockClientDriver` design.
4. Verify all 4 tiers of test cases (Feature, Boundary, Combination, Workload) by making sequential API requests and executing Prisma database queries to verify slot updates and spotter wallet balances.

---

## 5. Verification Method

To verify the test suite design and database integration:
1. Inspect the `analysis.md` file in the explorer directory.
2. Verify the Prisma schema queries match the database assertions documented in `analysis.md`.
3. Check that executing `node backend/src/tests/test_razorpay_endpoints.js` runs successfully and passes. This proves that the backend's mock verification logic behaves exactly as expected.
