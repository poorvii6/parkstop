# E2E & Integration Testing Strategy Recommendations

This document outlines the strategy for setting up and running a Node.js-based end-to-end (E2E) and integration testing suite for the smart parking application.

---

## 1. Backend Codebase Analysis

Our backend routes, controllers, and database models define the core transactional states and payment verification logic.

### A. User Authentication
* **Endpoints**:
  * `POST /api/auth/register`: Creates a new user with `role` as `'finder'` or `'spotter'`.
  * `POST /api/auth/login`: Authenticates the user and returns an `access_token` and `refresh_token`.
  * `POST /api/auth/profile`: Fetches current profile stats and details.
  * `POST /api/auth/switch-role`: Allows a user to switch roles between finder and spotter.
* **Mechanism**: JWT tokens signed using `config.jwt.secret`. The E2E tests must retain these access tokens and attach them to request headers: `Authorization: Bearer <access_token>`.

### B. Booking Creation
* **Endpoint**: `POST /api/bookings`
* **Controller / Model**: `bookingController.js` → `Booking.js`
* **Initial State**: Status transitions to `'reserved'`.
* **OTP Generation**: Two 6-digit OTPs are generated:
  * `otp_code`: Used for check-in.
  * `checkout_otp`: Used for check-out.
  They are returned in the response payload.
* **Pricing & Commission**:
  * Calculated dynamically via `PricingService.calculatePrice` based on rate-per-hour, duration, location type, and demand surge.
  * Split is calculated via `CommissionService.calculateCommission` into `platform_fee` and `spotter_earning`.

### C. Booking Check-In & Check-Out Verification
* **Check-In OTP Verification**:
  * **Endpoint**: `POST /api/bookings/verify-otp` (Spotter authorization required)
  * **Payload**: `{ bookingId, otp }`
  * **Action**: Sets `bookings.status = 'active'`.
* **Check-Out OTP Verification**:
  * **Endpoint**: `POST /api/bookings/verify-checkout-otp` (Spotter authorization required)
  * **Payload**: `{ bookingId, otp }`
  * **Action**: Sets `bookings.status = 'completed'`, registers actual end time, updates spotter earnings, and triggers payout or ledger deductions.

### D. Checkout & Payment Verification
* **Payment Mode Update**:
  * **Endpoint**: `PATCH /api/bookings/:id/payment-mode` (Finder authorization required)
  * **Payload**: `{ payment_mode: 'online' | 'cash' }`
* **Initiate Checkout**:
  * **Endpoint**: `POST /api/payments/checkout` (Finder authorization required)
  * **Payload**: `{ bookingId }`
  * **Action**: Generates a secure Razorpay order via `PaymentService.createRazorpayOrder`. Returns `order_id` (e.g. `order_...`), `amount` (in paise), and `currency`.
* **Verify Payment**:
  * **Endpoint**: `POST /api/payments/razorpay/verify` (Finder authorization required)
  * **Payload**: `{ bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature }`
  * **Bypass Signature Hook**: In `paymentService.js:48`, the backend implements a bypass signature verification:
    ```javascript
    const isValid = signature === 'mock_upi_intent' ? true : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);
    ```
    This means if `razorpay_signature` is sent as `'mock_upi_intent'`, the payment is marked verified. E2E tests must use this signature to simulate payment completion without a real payment gateway gateway.
  * **Action**: Updates booking `payment_status = 'paid'`, `payment_id = razorpay_payment_id`, and triggers spotter payouts.

### E. Spotter Payouts
* **Payout Logic**: Handled in `PayoutService.processBookingPayout`.
  * If the spotter has `razorpay_fund_account_id` configured, it triggers a RazorpayX payout.
  * If no payout account is configured, it falls back to `_createLocalPayout()`, which logs the transaction and increments the spotter's database `balance` directly:
    ```javascript
    await prisma.users.update({
      where: { id: spotterId },
      data: { balance: { increment: parseFloat(spotterEarning) } }
    });
    ```
    This is highly convenient for E2E tests, allowing assertions directly on the spotter's user balance.

---

## 2. Mock Client Driver Design

To simulate the React Native Expo client state transitions, API requests, and mock deep-link/fallback modal decisions, we recommend implementing a class-based `MockClientDriver` in Node.js.

### Proposed Driver Architecture (`MockClientDriver`)

```javascript
const axios = require('axios');

class MockClientDriver {
  constructor({ baseURL, upiAppInstalled = {} }) {
    this.client = axios.create({ baseURL });
    this.token = null;
    this.userId = null;
    this.role = null;
    this.currentStep = 'vehicle_select'; // Simulates UI step
    
    // Configures which simulated apps are installed on the mock client
    this.upiAppInstalled = {
      gpay: false,
      phonepe: false,
      paytm: false,
      upi: false,
      ...upiAppInstalled
    };
    
    // Log of deep links clicked or modals opened during simulation
    this.simulationLogs = [];
  }

  setToken(token, role) {
    this.token = token;
    this.role = role;
    this.client.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  }

  // --- Auth Actions ---
  async login(email, password) {
    const res = await this.client.post('/auth/login', { email, password });
    if (res.data.success) {
      this.setToken(res.data.data.access_token, res.data.data.user.role);
      this.userId = res.data.data.user.id;
    }
    return res.data;
  }

  // --- Booking Actions ---
  async createBooking(spotId, startTime, endTime, slotName, vehicleType, vehicleSubtype) {
    this.currentStep = 'booking_confirm';
    const res = await this.client.post('/bookings', {
      spot_id: spotId,
      start_time: startTime,
      end_time: endTime,
      slot_name: slotName,
      vehicle_type: vehicleType,
      vehicle_subtype: vehicleSubtype,
      payment_mode: 'online'
    });
    return res.data.data; // contains id, otp_code (entry OTP), checkout_otp
  }

  async updatePaymentMode(bookingId, paymentMode) {
    const res = await this.client.patch(`/bookings/${bookingId}/payment-mode`, {
      payment_mode: paymentMode
    });
    return res.data;
  }

  // --- Payment App Simulation Flow ---
  async simulateUPIPayment(bookingId, appName) {
    this.currentStep = 'payment';
    
    // 1. Ensure backend payment mode is patched
    await this.updatePaymentMode(bookingId, 'online');
    
    // 2. Initiate checkout to get Razorpay order_id
    const checkoutRes = await this.client.post('/payments/checkout', { bookingId });
    if (!checkoutRes.data.success) {
      throw new Error('Checkout session initiation failed');
    }
    
    const { order_id, amount } = checkoutRes.data;
    const amountInRupees = (amount / 100).toFixed(2);
    
    // 3. Replicate Expo Linking Logic & Deep-link Scheme Formatting
    const upiQuery = `pa=parkstop@razorpay&pn=ParkStop&am=${amountInRupees}&cu=INR&tr=${order_id}&tn=ParkStop%20Booking%20${bookingId}`;
    let upiUrl = '';
    switch (appName) {
      case 'gpay': upiUrl = `gpay://upi/pay?${upiQuery}`; break;
      case 'phonepe': upiUrl = `phonepe://upi/pay?${upiQuery}`; break;
      case 'paytm': upiUrl = `paytmmp://upi/pay?${upiQuery}`; break;
      default: upiUrl = `upi://pay?${upiQuery}`;
    }

    // 4. Simulate canOpenURL and Launch decisions
    const isInstalled = this.upiAppInstalled[appName];
    if (isInstalled) {
      this.simulationLogs.push({
        action: 'launch_deep_link',
        app: appName,
        url: upiUrl
      });
      // Simulate launching external app...
    } else {
      this.simulationLogs.push({
        action: 'open_fallback_modal',
        app: appName,
        theme: this.getBrandingTheme(appName)
      });
      // Simulate rendering fallback modal (complete / cancel options)...
    }

    // 5. Verify the payment with backend using mock intent signature
    const mockPaymentId = `pay_mock_upi_${Date.now()}`;
    const verifyRes = await this.client.post('/payments/razorpay/verify', {
      bookingId,
      razorpay_order_id: order_id,
      razorpay_payment_id: mockPaymentId,
      razorpay_signature: 'mock_upi_intent'
    });

    if (verifyRes.data.success) {
      this.currentStep = 'receipt';
    }

    return {
      success: verifyRes.data.success,
      paymentId: mockPaymentId,
      step: this.currentStep,
      logs: this.simulationLogs
    };
  }

  getBrandingTheme(app) {
    const themes = {
      gpay: { primaryColor: '#4285F4', name: 'Google Pay' },
      phonepe: { primaryColor: '#5f259f', name: 'PhonePe' },
      paytm: { primaryColor: '#00baf2', name: 'Paytm' },
      upi: { primaryColor: '#0f172a', name: 'Generic UPI' }
    };
    return themes[app] || themes.upi;
  }
}

module.exports = MockClientDriver;
```

---

## 3. Recommended Directory Structure

We suggest laying out the new `tests/e2e` suite inside the root or backend directory as follows:

```
tests/e2e/
├── package.json                   # E2E test-specific dependencies (jest, axios, pg)
├── runner.js                      # Custom orchestration script to run test sequence
├── config.js                      # Environment and test database connection parameters
├── helpers/
│   ├── driver.js                  # MockClientDriver class definition
│   ├── db.js                      # Database query/assertions wrapper
│   └── seed.js                    # Pre-test database populator (spots, spotters, finders)
└── cases/
    ├── tier1_feature.test.js      # Core business flow and UI modal states
    ├── tier2_boundary.test.js     # Edge cases: app not installed, invalid params, duplicates
    ├── tier3_combination.test.js  # Multi-step state machine flows
    └── tier4_workload.test.js     # Parallel and real-world high volume scenario tests
```

---

## 4. Verification Commands & Setup

### A. Dependencies Configuration (`tests/e2e/package.json`)
Introduce E2E specific packages:
```json
{
  "name": "smart-parking-e2e",
  "version": "1.0.0",
  "scripts": {
    "test": "jest --config jest.config.js --runInBand"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "dotenv": "^16.3.1",
    "@prisma/client": "^5.22.0"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

### B. Execution Commands
To run the suite, configure the root `package.json` scripts:
```json
"scripts": {
  "test:e2e": "cd tests/e2e && npm install && npm run test"
}
```
Run command:
```powershell
npm run test:e2e
```

---

## 5. Database Assertions & Consistency Checks

Using the Prisma client or direct SQL queries, tests should assert consistency across table states.

### Core Entities to Query
1. `bookings`: Verifies status transitions, payments linked, and Platform Fee / Spotter Earning calculations.
2. `users`: Verifies Spotter balance changes before and after payouts.
3. `payouts`: Verifies that a payout record has been registered with status `balance_credited` or RazorpayX details.

### Example Database Assertion Helper (`tests/e2e/helpers/db.js`)
```javascript
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getBookingById(bookingId) {
  return await prisma.bookings.findUnique({
    where: { id: parseInt(bookingId) },
    include: { parking_spots: true }
  });
}

async function getUserBalance(userId) {
  const user = await prisma.users.findUnique({
    where: { id: parseInt(userId) },
    select: { balance: true }
  });
  return Number(user.balance);
}

async function getPayoutByBooking(bookingId) {
  return await prisma.payouts.findFirst({
    where: { booking_id: parseInt(bookingId) }
  });
}

module.exports = {
  getBookingById,
  getUserBalance,
  getPayoutByBooking,
  prisma
};
```

### Test Case Assertion Snippet (`cases/tier1_feature.test.js`)
```javascript
const { getBookingById, getUserBalance, getPayoutByBooking } = require('../helpers/db');

// Inside a Jest test:
test('Verify payment completion, booking transition, and spotter payout', async () => {
  const initialBalance = await getUserBalance(spotterId);

  // Execute checkout and mock UPI payment using the driver
  const paymentResult = await finderDriver.simulateUPIPayment(bookingId, 'gpay');
  expect(paymentResult.success).toBe(true);

  // Assertions:
  // 1. Booking marked as paid
  const booking = await getBookingById(bookingId);
  expect(booking.status).toBe('completed');
  expect(booking.payment_status).toBe('paid');
  expect(booking.payment_id).toBe(paymentResult.paymentId);

  // 2. Platform fee & Spotter split
  const expectedEarning = Number(booking.spotter_earning);
  expect(expectedEarning).toBeGreaterThan(0);

  // 3. Spotter Balance updated
  const finalBalance = await getUserBalance(spotterId);
  expect(finalBalance).toBeCloseTo(initialBalance + expectedEarning, 2);

  // 4. Payout record exists
  const payout = await getPayoutByBooking(bookingId);
  expect(payout).not.toBeNull();
  expect(payout.amount).toBeCloseTo(expectedEarning, 2);
  expect(payout.status).toBe('balance_credited');
});
```
