# Handoff Report — Explorer E2E 3

This handoff report summarizes the codebase analysis and testing recommendations for the smart parking app Node.js E2E testing suite. Detailed strategy is documented in the co-located `analysis.md` file.

---

## 1. Observation

During read-only inspection, the following files and code blocks were examined:

1. **User Authentication & Auth Token Flow**:
   * **Route definition**: `backend/src/routes/auth.js:13-37` lists register and login POST endpoints.
   * **Controller implementation**: `backend/src/controllers/authController.js:90-131` shows login generates JWT tokens signed using `config.jwt.secret`.

2. **Booking Lifecycle & OTPs**:
   * **Route definition**: `backend/src/routes/bookings.js:26-69` lists creation and OTP verification endpoints.
   * **Controller & Model logic**:
     * `backend/src/controllers/bookingController.js:15-35` delegates booking creation to the `Booking.js` model.
     * `backend/src/models/Booking.js:56-58` generates check-in OTP `otp_code` and check-out OTP `checkout_otp` as random 6-digit codes.
     * `backend/src/models/Booking.js:103-134` shows check-in verification transitions booking status to `'active'`, and check-out verification transitions it to `'completed'`.

3. **Checkout, Payments & Signature Bypass**:
   * **Route definition**: `backend/src/routes/payments.js:82-94` maps checkout and Razorpay verify endpoints.
   * **Signature Verification Bypass Hook**: `backend/src/services/paymentService.js:48` implements bypass:
     ```javascript
     const isValid = signature === 'mock_upi_intent' ? true : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);
     ```
   * **Frontend UPI flow**: `frontend/app/finder/index.tsx:942-1025` shows UPI app launch schemes, deep-link queries (`pa=...&pn=...&am=...&cu=...&tr=...&tn=...`), and verification calls passing `razorpay_signature: 'mock_upi_intent'`.

4. **Spotter Payouts**:
   * **Model & Payout Service logic**:
     * `backend/src/services/payments/PayoutService.js:311-349` handles split payout calculation.
     * If the spotter has no `razorpay_fund_account_id` configured, it calls the local fallback `_createLocalPayout()` (lines 334-335) which directly increments the spotter's user balance:
       ```javascript
       await prisma.users.update({
         where: { id: spotterId },
         data: { balance: { increment: parseFloat(spotterEarning) } }
       });
       ```

5. **Prisma Models**:
   * `backend/prisma/schema.prisma:13-40` defines `bookings` fields including `status`, `payment_status`, `payment_mode`, `payment_id`, `platform_fee`, and `spotter_earning`.
   * `backend/prisma/schema.prisma:92-126` defines `users` fields including `balance`, `role`, and RazorpayX settings.

---

## 2. Logic Chain

From the observations, the testing strategy is synthesized as follows:

1. **Authentication (Finder & Spotter)**:
   * **Observation**: Login returns an `access_token` (`authController.js:129`).
   * **Inference**: The Node.js mock client driver must hold these tokens in-memory and append them as bearer tokens for subsequent API requests to authenticate as either the finder (to book/pay) or the spotter (to verify OTPs).

2. **State Machine Simulation**:
   * **Observation**: The booking lifecycle flows from `reserved` to `active` to `completed` via OTP entries (`Booking.js:103-134`).
   * **Inference**: A test case must simulate a multi-persona flow where a Finder driver creates a booking, grabs the entry OTP, hands it to a Spotter driver who performs OTP check-in, and repeats for checkout.

3. **UPI Payment Simulation & Gateway Bypass**:
   * **Observation**: `paymentService.js:48` accepts `'mock_upi_intent'` as a signature that validates any payment.
   * **Inference**: The client driver can simulate successful deep-linking or mock fallback modals (based on a configurable `upiAppInstalled` setting), and then bypass Razorpay signatures by posting `'mock_upi_intent'` to `/payments/razorpay/verify`.

4. **Database Assertions**:
   * **Observation**: Fallback payouts update `users.balance` directly in the database (`PayoutService.js:334-335`).
   * **Inference**: By querying the PostgreSQL database using the `@prisma/client` library, E2E tests can directly verify that:
     * `bookings.status === 'completed'`
     * `bookings.payment_status === 'paid'`
     * `users.balance` (spotter) matches the initial balance plus `bookings.spotter_earning`.

---

## 3. Caveats

* **Real Gateway Testing**: This E2E suite relies on the `'mock_upi_intent'` signature bypass. It does not test real payment gateway transaction settlements or external webhook processing.
* **Network Mocking**: In a real client environment, `Linking.canOpenURL` queries iOS/Android package managers. The driver mocks this behavior locally using a configuration mapping rather than spawning native emulators.

---

## 4. Conclusion

A Node.js integration testing suite using **Jest** and a custom **MockClientDriver** is highly feasible and sufficient to test the entire application flow (Tier 1-4).
The implementation agent can construct the runner and test cases under `tests/e2e/` using the driver and database helper outlines provided in `analysis.md`.

---

## 5. Verification Method

Once implemented, the E2E suite can be verified by running:
```powershell
npm run test:e2e
```
* **Files to inspect**:
  * `tests/e2e/helpers/driver.js`: Check that `MockClientDriver` wraps the REST endpoints correctly.
  * `tests/e2e/cases/tier1_feature.test.js`: Verify that assertions query the database using the Prisma Client.
* **Invalidation Condition**: If the signature bypass `'mock_upi_intent'` is disabled on the backend or the API base path changes, the E2E tests will fail.
