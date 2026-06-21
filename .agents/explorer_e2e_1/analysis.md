# E2E & Integration Testing Strategy for Smart Parking App

## 1. Executive Summary
This document defines the strategy for setting up and running a Node.js-based E2E and integration testing suite for the Smart Parking Application (ParkStop). The strategy covers:
1. Backend authentication, reservation, checkout, payment, and payout API lifecycles.
2. A Mock Client Driver architecture designed to simulate mobile app client state transitions and verify payment selector configurations (deep links, parameter formatting, and branded fallback modals).
3. A modular directory structure matching a 4-tier testing hierarchy (Feature, Boundary, Pairwise Combination, Workload).
4. Direct database validation using Prisma Client.
5. Standardized test runner execution commands.

---

## 2. Backend Routes & Lifecycles Analysis

We examined the Express backend routes, controllers, and services located under `backend/src/`. Below is the complete API lifecycle breakdown for a booking session.

### A. Authentication
* **Registration**: `POST /api/v1/auth/register`
  * **Controller**: `AuthController.register`
  * **Payload**: `{ email, password, name, phone, role }` where `role` is either `'finder'` or `'spotter'`.
  * **Database**: Inserts a record in the `users` table. Passwords are encrypted using bcrypt.
* **Login**: `POST /api/v1/auth/login`
  * **Controller**: `AuthController.login`
  * **Payload**: `{ email, password }`
  * **Response**: Returns JWT `access_token` and `refresh_token`. The access token must be included as `Authorization: Bearer <token>` in subsequent requests.

### B. Booking & Session State Transitions
* **Booking Creation (Finder)**: `POST /api/v1/bookings`
  * **Controller**: `BookingController.createBooking`
  * **Payload**: `{ spot_id, start_time, end_time, vehicle_type, vehicle_subtype, payment_mode }`
  * **Logic**: Executed inside a Prisma transaction (`$transaction`). Checks slot availability, calculates price using `PricingService` and commission split using `CommissionService`. Generates a 6-digit `otp_code` (check-in) and `checkout_otp` (checkout).
  * **State**: Sets booking `status` to `'reserved'` and decrements availability in `parking_spots`.
* **Check-in OTP Verification (Spotter)**: `POST /api/v1/bookings/verify-otp`
  * **Controller**: `BookingController.verifyOTP`
  * **Payload**: `{ bookingId, otp }`
  * **Logic**: Spotter submits the OTP received from the Finder.
  * **State**: Transitions booking `status` from `'reserved'` to `'active'`.
* **Checkout OTP Verification (Spotter)**: `POST /api/v1/bookings/verify-checkout-otp`
  * **Controller**: `BookingController.verifyCheckoutOTP`
  * **Payload**: `{ bookingId, otp }`
  * **Logic**: Spotter submits the checkout OTP received from the Finder. Transitions status to `'completed'`, calculates actual total price, increments availability in `parking_spots`.
  * **State**: Transitions booking `status` from `'active'` to `'completed'`.
  * **Ledger Split**:
    * **If Cash**: Decrements `platform_fee` directly from the spotter's wallet `balance` (since the spotter collected 100% of the cash). Transitions `payment_status` to `'paid'`.
    * **If Online**: Leaves `payment_status` as `'pending'` until the Finder completes payment verification.

### C. Payment & Payouts (Online Flow)
* **Checkout Session**: `POST /api/v1/payments/checkout`
  * **Controller**: `PaymentController.createCheckoutSession`
  * **Payload**: `{ bookingId }`
  * **Logic**: Initiates payment process. For Razorpay (exclusive provider), calls `PaymentService.createRazorpayOrder` to generate a transaction order and returns `{ success: true, provider: 'razorpay', order_id, amount, currency }`.
* **Update Payment Mode**: `PATCH /api/v1/bookings/:id/payment-mode`
  * **Controller**: `BookingController.updatePaymentMode`
  * **Payload**: `{ payment_mode: 'online' | 'cash' }`
* **Payment Verification**: `POST /api/v1/payments/razorpay/verify`
  * **Controller**: `PaymentController.verifyRazorpayPayment`
  * **Payload**: `{ bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature }`
  * **Mock Intent Bypass**: If `razorpay_signature` is exactly `'mock_upi_intent'`, validation is bypassed. The booking `payment_status` is updated to `'paid'`, and the `payment_id` is saved.
* **Payout Trigger**: Upon payment status transition to `'paid'`, `PayoutService.processBookingPayout` is triggered.
  * **Logic**: If the Spotter has `razorpay_fund_account_id` and `RAZORPAY_ACCOUNT_NUMBER` is configured, it initiates a RazorpayX payout.
  * **Local Fallback**: If RazorpayX is unconfigured, it logs a warning, creates a local payout record (`payouts` table) with status `'balance_credited'`, and increments the spotter's `balance` directly in the database (`users` table) by `spotter_earning` (80% of booking price).

---

## 3. Node.js Mock Client Driver Design

The E2E tests require a mock client driver that simulates the React Native mobile app's front-end logic.

### A. Driver Architecture
The driver maintains the user context, auth headers, and local state. It operates as an async client driver class:

```javascript
class MockClientDriver {
  constructor(baseUrl, role) {
    this.baseUrl = baseUrl;
    this.role = role; // 'finder' or 'spotter'
    this.token = null;
    this.socket = null;
    this.currentBooking = null;
  }

  // Set Authorization headers for API calls
  getHeaders() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json'
    };
  }
}
```

### B. Mobile Transition & Payment Selector Simulation
1. **Checkout Phase**: When the booking is completed (status = `'completed'`, payment_status = `'pending'`), the Finder driver calls the payment selector simulation.
2. **UPI App Installation Mock**: The simulator is configured with mock flags representing the device environment:
   * `mockUPIAppsInstalled = { gpay: boolean, phonepe: boolean, paytm: boolean, upi: boolean }`
3. **Flow Decisioning**:
   * **Case A: App Installed (`canOpenURL` evaluates to true)**:
     * Construct the expected deep-link URL (e.g. GPay: `gpay://upi/pay?pa=parkstop@razorpay&pn=ParkStop&am=<amount>&cu=INR&tr=<orderId>&tn=ParkStop Booking <bookingId>`).
     * Validate the query parameters using URL parsing:
       * `pa` (payee VPA) must equal `parkstop@razorpay`.
       * `pn` (payee name) must equal `ParkStop` (URL encoded).
       * `am` (amount) must match the booking `totalPrice` precisely.
       * `cu` (currency) must equal `INR`.
       * `tr` (transaction reference) must equal the Razorpay `orderId`.
       * `tn` (transaction note) must follow: `ParkStop Booking <bookingId>`.
     * Simulate redirection delay (e.g., 3.5 seconds) and invoke `/payments/razorpay/verify` with `razorpay_signature: 'mock_upi_intent'`.
   * **Case B: App Not Installed (`canOpenURL` evaluates to false) / Launch Fails**:
     * Open the styled fallback modal interface.
     * Validate branding styles programmatically:
       * GPay: blue theme.
       * PhonePe: purple theme.
       * Paytm: light-blue theme.
       * Generic UPI: dark/default theme.
     * Simulate User Choice:
       * **Cancel**: Reset step to payment selection, leaving payment status as `'pending'`.
       * **Complete Mock Payment**: Call `/payments/razorpay/verify` with:
         ```json
         {
           "bookingId": 123,
           "razorpay_order_id": "order_mock_123",
           "razorpay_payment_id": "pay_mock_upi_1234567890",
           "razorpay_signature": "mock_upi_intent"
         }
         ```

---

## 4. Suggested Directory Structure & File Layout

We recommend placing all E2E test suite files inside a new root-level `tests/e2e/` directory.

```
tests/e2e/
├── package.json               # E2E test-specific dependencies (jest, axios, socket.io-client)
├── jest.config.js             # Jest configuration
├── runner.js                  # Global setup/teardown (spins up backend server, resets DB, triggers test cases)
├── helpers/
│   ├── apiClient.js           # Axios instance wrapped with baseURL and helper headers
│   ├── dbHelper.js            # Prisma wrapper to verify db assertions
│   ├── socketHelper.js        # Socket.io helper for subscribing to real-time events
│   └── mockClientDriver.js    # Client simulator for Finder and Spotter interactions
└── cases/
    ├── tier1_feature.test.js  # Tier 1: SVG logos, deep links, fallback modals, payments, receipts
    ├── tier2_boundary.test.js # Tier 2: App missing, launch failures, user cancellations, double payments
    ├── tier3_combination.test.js # Tier 3: Pairwise flows (Reserve -> Check-in -> Check-out -> Pay -> Receipt)
    └── tier4_workload.test.js # Tier 4: Parallel bookings, dynamic pricing, host payout balances
```

### Dependency Recommendations (`tests/e2e/package.json`)
```json
{
  "name": "parkstop-e2e",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "jest --runInBand --detectOpenHandles"
  },
  "dependencies": {
    "axios": "^1.6.2",
    "socket.io-client": "^4.8.3"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

---

## 5. Database Assertions (Prisma Client)

During E2E flow steps, direct database queries must be performed to guarantee transactional integrity.

### A. Reservation & Check-in
* **Slot Decrement**: After `POST /api/v1/bookings`, verify the slots:
  ```javascript
  const spot = await prisma.parking_spots.findUnique({ where: { id: spotId } });
  expect(spot.available_slots).toBe(initialAvailableSlots - 1);
  if (vehicleType === 'car') {
    expect(spot.car_slots).toBe(initialCarSlots - 1);
  }
  ```
* **State Check**: Verify booking state is `'reserved'`:
  ```javascript
  const booking = await prisma.bookings.findUnique({ where: { id: bookingId } });
  expect(booking.status).toBe('reserved');
  expect(booking.otp_code).toBeDefined();
  ```

### B. Checkout Completion
* **Slot Increment**: After checkout OTP verification, verify the slots are released:
  ```javascript
  const spot = await prisma.parking_spots.findUnique({ where: { id: spotId } });
  expect(spot.available_slots).toBe(initialAvailableSlots); // Slot returned
  ```
* **Duration & Calculations**: Verify dynamic calculations match:
  ```javascript
  const booking = await prisma.bookings.findUnique({ where: { id: bookingId } });
  expect(booking.status).toBe('completed');
  expect(Number(booking.total_price)).toBeCloseTo(expectedPrice);
  ```

### C. Cash Payouts Ledger
* **Platform Fee Deduction**: For cash payment, the Spotter pays the platform fee from their in-app wallet balance:
  ```javascript
  const spotter = await prisma.users.findUnique({ where: { id: spotterId } });
  expect(Number(spotter.balance)).toBeCloseTo(previousBalance - Number(booking.platform_fee));
  ```

### D. Online Payment & Spotter Payout
* **Status Updates**: Verify payment verified:
  ```javascript
  const booking = await prisma.bookings.findUnique({ where: { id: bookingId } });
  expect(booking.payment_status).toBe('paid');
  expect(booking.payment_id).toContain('pay_mock_upi_');
  ```
* **Payout Record**: Verify the local payout ledger record exists:
  ```javascript
  const payout = await prisma.payouts.findFirst({ where: { booking_id: bookingId } });
  expect(payout).not.toBeNull();
  expect(Number(payout.amount)).toBeCloseTo(Number(booking.spotter_earning));
  ```
* **Spotter Balance Increment**: Verify spotter's in-app balance increased:
  ```javascript
  const spotter = await prisma.users.findUnique({ where: { id: spotterId } });
  expect(Number(spotter.balance)).toBeCloseTo(previousBalance + Number(booking.spotter_earning));
  ```

---

## 6. Verification Commands

To run the E2E test suite in isolation, the test runner must orchestrate the setup, execution, and teardown:

### A. Environment Configuration
Create a `.env.test` file inside the backend workspace directory with test configuration:
```env
PORT=3000
NODE_ENV=test
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/parkstop_test?schema=public"
RAZORPAY_KEY_ID="rzp_test_mock"
RAZORPAY_KEY_SECRET="rzp_secret_mock"
RAZORPAY_ACCOUNT_NUMBER="" # Empty to force local balance fallback payout verification
```

### B. Execution Sequence
1. **Initialize Test Database**:
   ```bash
   npx prisma db push --schema=backend/prisma/schema.prisma --force-reset
   ```
2. **Seed Initial Spot and User Accounts**:
   ```bash
   node backend/scripts/seed.js
   ```
3. **Start the Express API Server (using test database)**:
   ```bash
   cross-env NODE_ENV=test node backend/src/server.js
   ```
4. **Execute E2E Jest Suite**:
   ```bash
   cd tests/e2e && npm install && npm test
   ```
