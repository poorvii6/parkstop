# E2E Testing Strategy Analysis & Recommendation Report

## Executive Summary
This report defines the architecture and strategy for a Node.js-based end-to-end (E2E) and integration testing suite for the Smart Parking application. Since we are operating in a read-only capacity, this document serves as a blueprint for the implementer agent. It details the backend API routes, defines a state-machine-based mock client driver for simulating user behaviors and mobile deep-linking, suggests a clean directory structure, and details the verification commands and database assertion methods.

---

## 1. Backend API & Services Examination
To test the complete lifecycle of a booking—from authentication to payout—the testing suite must interact with the following backend components.

### 1.1 User Authentication
* **Routes File**: `backend/src/routes/auth.js`
* **Controller**: `backend/src/controllers/authController.js`
* **Endpoints**:
  * `POST /api/v1/auth/register`: Creates a new user. Required body parameters: `email`, `password`, `name`, `role` (`'finder'` or `'spotter'`), and optional `phone`.
  * `POST /api/v1/auth/login`: Authenticates user credentials. Returns an access token (`access_token`) and a refresh token (`refresh_token`).
* **Test Application**:
  * Tests must simulate both a **Finder** user and a **Spotter** user.
  * Tokens returned on login must be saved by the test driver and included in subsequent API request headers as: `Authorization: Bearer <access_token>`.

### 1.2 Booking Creation & Lifecycle
* **Routes File**: `backend/src/routes/bookings.js`
* **Controller**: `backend/src/controllers/bookingController.js`
* **Model**: `backend/src/models/Booking.js`
* **Endpoints**:
  * `POST /api/v1/bookings`: Reserved for finders. Body: `spot_id` (Int), `start_time` (ISO date), `end_time` (ISO date), `vehicle_type` (`'car'` or `'bike'`), `vehicle_subtype` (e.g. `'SUV'`), `slot_name` (String), and `payment_mode` (`'online'` or `'cash'`).
    * **Action**: Decrements spot slots, calculates the price, and generates check-in OTP (`otp_code`) and check-out OTP (`checkout_otp`). Returns the booking object with state `'reserved'`.
  * `POST /api/v1/bookings/verify-otp` (Spotter only): Verifies the check-in OTP. Body: `{ bookingId, otp }`. Transitions the booking status to `'active'`.
  * `POST /api/v1/bookings/verify-checkout-otp` (Spotter only): Verifies the check-out OTP. Body: `{ bookingId, otp }`. Calls `Booking.complete()`, transitions the booking status to `'completed'`, releases the spot slot (increments available slots), and triggers the spotter payout logic.
  * `PATCH /api/v1/bookings/:id/payment-mode` (Finder only): Updates payment mode to `'online'` or `'cash'`.
  * `PUT /api/v1/bookings/:id/extend` (Finder only): Extends the active session. Body: `{ additionalHours }`.

### 1.3 Checkout & Payment Verification
* **Routes File**: `backend/src/routes/payments.js`
* **Controller**: `backend/src/controllers/paymentController.js`
* **Service**: `backend/src/services/paymentService.js`
* **Endpoints**:
  * `POST /api/v1/payments/checkout`: Initiates checkout. Enforces Razorpay as the gateway. Body: `{ bookingId }`. Returns `{ success: true, provider: 'razorpay', order_id, amount, currency, key_id }`.
  * `POST /api/v1/payments/razorpay/verify`: Verifies payment. Body: `{ bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature }`.
    * **Key Bypass Mock**: The backend contains a built-in mock check in `paymentService.js` (line 48):
      ```javascript
      const isValid = signature === 'mock_upi_intent' ? true : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);
      ```
      If `razorpay_signature` is sent as `'mock_upi_intent'`, signature verification automatically passes. This allows the E2E suite to complete simulated payments by sending `'mock_upi_intent'` as the signature.

### 1.4 Spotter Payouts
* **Service**: `backend/src/services/payments/PayoutService.js`
* **Trigger**: Executed upon payment verification (`verifyRazorpayPayment` or checkout completion in `bookingController.js` depending on the payment mode).
* **Payout Logic**:
  * Uses `CommissionService.calculateCommission` to compute the split (`spotterEarning` and `platformFee`).
  * **Cash Payment**:
    * Platform fee is decremented directly from the spotter's wallet balance:
      ```javascript
      await prisma.users.update({
        where: { id: spotterId },
        data: { balance: { decrement: platformFee } }
      });
      ```
    * Sets booking `payment_status` to `'paid'`.
  * **Online Payment**:
    * If `RAZORPAY_ACCOUNT_NUMBER` is not set or the spotter does not have a registered Razorpay fund account, the system falls back to `_createLocalPayout()`.
    * `_createLocalPayout` creates a local `payouts` record with status `'balance_credited'` and increments the spotter's balance field:
      ```javascript
      await prisma.users.update({
        where: { id: spotterId },
        data: { balance: { increment: spotterEarning } }
      });
      ```
  * **Testing/Assertion Strategy**:
    * Rather than calling live Razorpay APIs, the E2E tests can run with `RAZORPAY_ACCOUNT_NUMBER` unset.
    * Assertions should query the database directly to verify:
      1. A record is added to the `payouts` table containing the correct `booking_id` and `amount`.
      2. The spotter's user record `balance` is updated correctly (+`spotterEarning` for online, -`platformFee` for cash).

---

## 2. Mock Client Driver Design
The mobile frontend (`frontend/app/finder/index.tsx`) operates as a state machine driven by a `step` variable. To run tests programmatically in Node.js, we must implement a **Finder Mock Client Driver** that maintains state, calls APIs, and simulates device-level capabilities (like UPI deep-linking).

### 2.1 State Transition Model
The mock driver should wrap the state machine of the app:
* `INITIAL` -> `vehicle_select`: Client initialized.
* `vehicle_select` -> `choice`: via `selectVehicle(type, subType)`
* `choice` -> `nearby_list`: via `searchNearby(lat, lng)` (sends GET `/spots/nearby`)
* `nearby_list` -> `spot_detail`: via `selectSpot(spotId)` (sends GET `/spots/:id/slots`)
* `spot_detail` -> `slot_select`: via `selectSlot(slotName)`
* `slot_select` -> `time_select`: via `selectDuration(hours, minutes)` (sends POST `/bookings/calculate-price`)
* `time_select` -> `booking_confirm`: via `confirmReservation()` (sends POST `/bookings`, saves booking ID, OTP, and checkout OTP)
* `booking_confirm` -> `navigating`/`en_route`: via `startNavigation()`
* `en_route`/`navigating` -> `arriving`: via `arriveAtSpot()`
* `arriving` -> `active_parking`: simulated check-in verification (calls spotter verify endpoint `/bookings/verify-otp`)
* `active_parking` -> `checkout_verification`: via `endSession()`
* `checkout_verification` -> `payment`: simulated check-out verification (calls spotter verify endpoint `/bookings/verify-checkout-otp`)
* `payment` -> `receipt`: via `pay(options)` (calls `/bookings/:id/payment-mode`, `/payments/checkout`, and `/payments/razorpay/verify`)
* `receipt` -> `choice`: via `backToDashboard()` (resets parameters)

### 2.2 Deep-Link Formatting & Fallback Modal Logic Simulation
The mock driver must simulate the native `Linking` environment. We can provide parameters like `installedUpiApps` (an array of app keys present on the device) and `linkingLaunchSucceeds` (boolean) to the driver.

When `pay(online, appKey)` is called:
1. **Update mode**: The driver patches payment mode to `'online'`.
2. **Initiate Checkout**: Calls `/payments/checkout` to fetch the Razorpay `order_id` and total `amount`.
3. **Format UPI URL**:
   * Construct the UPI query parameters:
     `pa=parkstop@razorpay&pn=ParkStop&am=<amount_in_rupees>&cu=INR&tr=<order_id>&tn=ParkStop%20Booking%20<booking_id>`
   * Build the scheme URL based on the selected UPI app:
     * Google Pay: `gpay://upi/pay?pa=...`
     * PhonePe: `phonepe://upi/pay?pa=...`
     * Paytm: `paytmmp://upi/pay?pa=...`
     * Generic UPI: `upi://pay?pa=...`
4. **App Installation & Launch Check**:
   * If the app key (e.g. `'gpay'`) is **NOT** in `installedUpiApps`:
     * **Modal Decision**: Open the mock fallback modal for Google Pay.
     * **Theme Assertion**: Verify styling properties match GPay theme (e.g., blue theme).
     * **Action - Complete**: Call `/payments/razorpay/verify` with `razorpay_signature: 'mock_upi_intent'` and transition to `receipt`.
     * **Action - Cancel**: Retain status `'payment'` to allow retry.
   * If the app key **IS** in `installedUpiApps`:
     * If `linkingLaunchSucceeds` is `true`:
       * Format and log URL. Trigger simulated success. Call `/payments/razorpay/verify` with signature `'mock_upi_intent'` and transition to `receipt`.
     * If `linkingLaunchSucceeds` is `false`:
       * Open the mock fallback modal (as above) to handle the failure and proceed or cancel.

---

## 3. Suggested Directory Structure & Layout
All testing files should be placed under a new `tests/e2e` directory inside the project root:

```
tests/e2e/
├── package.json                   # E2E test dependencies (e.g., axios, dotenv, mocha, chai)
├── runner.js                      # Central test orchestrator (starts server, runs tests, teardown)
├── config.js                      # Environment and endpoint configurations
├── drivers/                       # Client simulators
│   ├── finderDriver.js            # Finder mock client driver (state machine, deep links, API calls)
│   └── spotterDriver.js           # Spotter mock client driver (OTP verification, dashboard stats)
├── helpers/                       # Database and API utilities
│   ├── api.js                     # Base Axios wrapper handling authorization headers & error logging
│   └── db.js                      # Prisma Client instance for direct DB queries and assertions
├── fixtures/                      # Mock seed data
│   ├── users.js                   # Mock user credentials (role finder, role spotter)
│   └── spots.js                   # Mock spots with coordinates, price rates, location types
└── cases/                         # E2E Test Cases (grouped by tiers)
    ├── tier1_feature.test.js      # Logos presence, deep-links formats, fallback UI themes, paid status
    ├── tier2_boundary.test.js     # Apps missing, launch failures, cancellations, invalid inputs, duplicates
    ├── tier3_combination.test.js  # End-to-end multi-step flows, cancel & retry, balance changes
    └── tier4_workload.test.js     # Multi-user concurrency, dynamic surge pricing, payout splits
```

---

## 4. Verification Commands & Database Assertions

### 4.1 Prerequisites & Test Environment
To avoid contaminating production/development data, a dedicated test database should be used. The runner should load environment variables (e.g., from `.env.test`) before starting.
```env
PORT=5000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/parkstop_test?schema=public"
JWT_SECRET="test_jwt_secret_key"
NODE_ENV="test"
```

### 4.2 Run Commands
The E2E tests can be initiated using either a custom runner script or a standard test package.
* **Option A: Custom Runner Script** (Runs setup, starts API server, executes tests, shuts down server):
  ```bash
  npm run test:e2e
  ```
  *Corresponding script in root `package.json`:*
  ```json
  "test:e2e": "node tests/e2e/runner.js"
  ```
* **Option B: Standard Mocha Suite** (If Mocha is added to dependencies):
  ```bash
  npx mocha tests/e2e/cases/**/*.test.js --timeout 15000
  ```

### 4.3 Database Assertions (Prisma Client & Direct SQL)
Tests should verify the outcomes of payments and payouts directly inside the database using the Prisma Client.

#### 1. Confirm Booking Paid & Completed Status
```javascript
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const assert = require('assert');

async function verifyBookingStatus(bookingId) {
  const booking = await prisma.bookings.findUnique({
    where: { id: parseInt(bookingId) }
  });
  
  assert.ok(booking, 'Booking record should exist');
  assert.strictEqual(booking.status, 'completed', 'Booking status should be completed');
  assert.strictEqual(booking.payment_status, 'paid', 'Booking payment status should be paid');
  assert.ok(booking.payment_id.startsWith('pay_mock_upi_'), 'Payment ID should match mock format');
}
```

#### 2. Confirm Spotter Wallet Balance Changes (Online Payment)
```javascript
async function verifyOnlinePayout(spotterId, initialBalance, expectedEarning, bookingId) {
  // Check user balance increment
  const spotter = await prisma.users.findUnique({
    where: { id: spotterId }
  });
  const actualBalance = Number(spotter.balance);
  const targetBalance = Number(initialBalance) + Number(expectedEarning);
  assert.strictEqual(actualBalance, targetBalance, `Wallet balance should increase by ${expectedEarning}`);

  // Check local payout record insertion
  const payout = await prisma.payouts.findFirst({
    where: {
      user_id: spotterId,
      booking_id: parseInt(bookingId)
    }
  });
  assert.ok(payout, 'Local payout record should exist');
  assert.strictEqual(payout.status, 'balance_credited', 'Payout fallback status should be balance_credited');
  assert.strictEqual(Number(payout.amount), Number(expectedEarning), 'Payout amount matches');
}
```

#### 3. Confirm Spotter Platform Fee Wallet Deduction (Cash Payment)
```javascript
async function verifyCashCommissionDeduction(spotterId, initialBalance, platformFee) {
  const spotter = await prisma.users.findUnique({
    where: { id: spotterId }
  });
  const actualBalance = Number(spotter.balance);
  const targetBalance = Number(initialBalance) - Number(platformFee);
  assert.strictEqual(actualBalance, targetBalance, `Wallet balance should decrement platform fee of ${platformFee}`);
}
```
