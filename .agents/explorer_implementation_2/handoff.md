# Handoff Report: Codebase Investigation for UPI Payments, Fallback Mock Simulator, and Wallet Payouts

This report details the findings and implementation strategy for the Smart Parking Application's Payment features.

---

## 1. Observation

### R1: Brand-Accurate Logos in Payment Selector Modal
- **Payment Selector UI File**: `frontend/app/finder/index.tsx`
- **Location of Modal**: The modal `<Modal visible={isUPIModalVisible} transparent animationType="slide">` is defined at lines 2328-2417.
- **Current Rendering**: Emojis are used for logo branding representation in `upiAppIconBg`:
  - **Google Pay**: `<Text style={{ fontSize: 20 }}>🌐</Text>` (line 2344)
  - **PhonePe**: `<Text style={{ fontSize: 20 }}>💜</Text>` (line 2358)
  - **Paytm**: `<Text style={{ fontSize: 20 }}>💙</Text>` (line 2372)
  - **Generic UPI**: `<Text style={{ fontSize: 20 }}>⚡</Text>` (line 2386)
- **Local Asset Directory**: `frontend/assets/images/`
- **Test Asset Expectations** (referenced in `tests/e2e/helpers/finderDriver.js` lines 136-172):
  - Google Pay: `'gpay_logo_vector.png'`
  - PhonePe: `'phonepe_logo_vector.png'`
  - Paytm: `'paytm_logo_vector.png'`
  - Generic UPI: `'upi_logo_vector.png'`
- **SVG Support**: `react-native-svg` is NOT installed in `frontend/package.json` (lines 13-52). Rendering should be done via local PNG images using React Native's `<Image>` component.

### R2: UPI Launch Fallback & Mock Simulator
- **Deep Link Handling Function**: `handleUPIPayment` in `frontend/app/finder/index.tsx` (lines 942-1024).
- **Current Launch Flow**: The deep link URL is opened directly via `Linking.openURL(upiUrl)` in a try-catch block (lines 985-994). It does NOT check `Linking.canOpenURL()` beforehand.
- **Mock Simulator UI Requirements** (matching `tests/e2e/cases/tier1_feature.test.js` lines 89-112):
  - Theme colors and app names matching:
    - **Google Pay**: Name: `'Google Pay'`, Color: `'#4285F4'`, Logo: `'gpay_logo_vector.png'`
    - **PhonePe**: Name: `'PhonePe'`, Color: `'#5F259F'`, Logo: `'phonepe_logo_vector.png'`
    - **Paytm**: Name: `'Paytm'`, Color: `'#00BAF2'`, Logo: `'paytm_logo_vector.png'`
    - **Generic UPI**: Name: `'Generic UPI'`, Color: `'#097969'`, Logo: `'upi_logo_vector.png'`
  - Buttons: A success button simulating payment (triggers backend callback) and a cancel button (returns client state to selection).

### R3: In-App Wallet Updates & Backend Integration
- **Backend Route File**: `backend/src/routes/payments.js`
- **Verification Endpoint**: `POST /payments/razorpay/verify` (routed at lines 83-94 to `PaymentController.verifyRazorpayPayment`).
- **Payment Controller File**: `backend/src/controllers/paymentController.js`
- **Controller Verify Function**: `verifyRazorpayPayment` (lines 263-295). Calls `PaymentService.verifyRazorpayPayment`.
- **Payment Service File**: `backend/src/services/paymentService.js`
- **Service Verify Function**: `verifyRazorpayPayment` (lines 46-87).
- **Bypass Check for 'mock_upi_intent'**: Line 48 in `backend/src/services/paymentService.js`:
  ```javascript
  const isValid = signature === 'mock_upi_intent' ? true : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);
  ```
- **Marking Booking Paid**: Lines 55-65 in `backend/src/services/paymentService.js` update `payment_status` to `'paid'`:
  ```javascript
  const updatedBooking = await prisma.bookings.update({
    where: { id: parseInt(bookingId) },
    data: {
      payment_id: paymentId,
      payment_status: 'paid',
      updated_at: new Date()
    },
    ...
  ```
- **Trigger Spotter Payout**: Lines 68-80 in `backend/src/services/paymentService.js` invoke:
  ```javascript
  await PayoutService.processBookingPayout(bookingId, spotterEarning, spotterId);
  ```
- **Ledger/Platform Fee Deduction for Cash**: In `backend/src/controllers/bookingController.js` (lines 169-175):
  ```javascript
  if (booking.payment_mode === 'cash') {
    // Deduct platform fee from spotter balance for cash payments
    await require('../config/prisma').users.update({
      where: { id: spot.spotter_id },
      data: { balance: { decrement: platformFee } }
    });
  }
  ```
- **Front-end Receipt Navigation**: Set state `step` to `'receipt'` (handled in `frontend/app/finder/index.tsx` line 2282 onwards).

---

## 2. Logic Chain

1. **R1 (Logos)**: Because `react-native-svg` is absent in `frontend/package.json`, local image components utilizing standard `require()` must load PNG assets from `frontend/assets/images/`.
2. **R2 (Fallback & Mock)**: Linking can fail on actual hardware if applications are not installed. Checking `Linking.canOpenURL()` dynamically intercepts unavailable schemes before opening them. By catching uninstalled instances, we display a custom branded mock modal representing the selected provider. Clicking the success button within this mock modal sends `razorpay_signature: 'mock_upi_intent'` to the server to simulate authorization.
3. **R3 (Backend & Payouts)**: The backend payment service bypasses HMAC signature check if `razorpay_signature === 'mock_upi_intent'`. It updates the booking model in PostgreSQL database to `'paid'` and initiates spotter payouts via `PayoutService.processBookingPayout`. E2E tests will succeed when the mobile client sends this signature on mock modal approval.

---

## 3. Caveats

- **Deep Link Application Schemes**: `Linking.canOpenURL()` requires query schemes configuration (`infoPlist` queries on iOS and Android `<queries>`) to work correctly on real devices. These must be declared in `frontend/app.json`.
- **Double Payout Safeguard**: The `payouts` table doesn't enforce a unique index on `booking_id`. If `processBookingPayout` is called twice (e.g., during checkout OTP verification and payment verification), duplicate payout records could be created. A check should be added to ensure a payout with the same `booking_id` does not already exist.

---

## 4. Conclusion

- Replace text emojis inside the Payment Selector Modal with local image assets (`gpay_logo_vector.png`, `phonepe_logo_vector.png`, etc.) using React Native's `<Image>` component.
- Implement `Linking.canOpenURL()` in `handleUPIPayment` inside `frontend/app/finder/index.tsx`.
- Design an app-specific mock checkout modal containing brand theme colors and a success simulation button sending `razorpay_signature: 'mock_upi_intent'`.
- Add queries schemes in `frontend/app.json` for proper OS deep linking integration.

---

## 5. Verification Method

### Test Suite Execution
Execute the automated E2E test suite from the project root directory:
```bash
node tests/e2e/runner.js
```

### Manual Inspection Files
- Check `frontend/app/finder/index.tsx` for `canOpenURL` integration and Mock Simulator modal presentation.
- Verify `frontend/assets/images/` contains the vector PNG files.
- Inspect `frontend/app.json` to confirm `LSApplicationQueriesSchemes` are correctly registered.
