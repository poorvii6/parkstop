# Handoff Report — Explorer Implementation 3

## 1. Observation
I directly observed the following files and code snippets in the codebase:

1. **Payment Selector Modal UI**: Located in `frontend/app/finder/index.tsx` (lines 2328-2417). It uses generic Unicode emojis inside styled background Views:
   - Line 2343-2345: `View style={[styles.upiAppIconBg, { backgroundColor: '#4285F4' }]}> <Text style={{ fontSize: 20 }}>🌐</Text>` (Google Pay)
   - Line 2357-2359: `View style={[styles.upiAppIconBg, { backgroundColor: '#5f259f' }]}> <Text style={{ fontSize: 20 }}>💜</Text>` (PhonePe)
   - Line 2371-2373: `View style={[styles.upiAppIconBg, { backgroundColor: '#00baf2' }]}> <Text style={{ fontSize: 20 }}>💙</Text>` (Paytm)
   - Line 2385-2387: `View style={[styles.upiAppIconBg, { backgroundColor: '#0f172a', ... }]}> <Text style={{ fontSize: 20 }}>⚡</Text>` (Generic UPI)

2. **UPI Deep Link Construction**: Located in `frontend/app/finder/index.tsx` within `handleUPIPayment` (lines 942-1024):
   - Line 970: `const upiQuery = pa=${upiId}&pn=${encodeURIComponent(pn)}&am=${amountInRupees}&cu=INR&tr=${orderId}&tn=ParkStop%20Booking%20${bookingDetails?.id};`
   - Line 973-981:
     ```typescript
     let upiUrl = '';
     if (app === 'gpay') {
       upiUrl = `gpay://upi/pay?${upiQuery}`;
     } else if (app === 'phonepe') {
       upiUrl = `phonepe://upi/pay?${upiQuery}`;
     } else if (app === 'paytm') {
       upiUrl = `paytmmp://upi/pay?${upiQuery}`;
     } else {
       upiUrl = `upi://pay?${upiQuery}`;
     }
     ```
   - Line 986: `await Linking.openURL(upiUrl);`

3. **Android queries declaration**: Located in `frontend/android/app/src/main/AndroidManifest.xml` (lines 10-16):
   ```xml
   <queries>
     <intent>
       <action android:name="android.intent.action.VIEW"/>
       <category android:name="android.intent.category.BROWSABLE"/>
       <data android:scheme="https"/>
     </intent>
   </queries>
   ```

4. **Stripe/Razorpay package dependencies**: Verified in `frontend/package.json` (lines 13-52). It contains `expo`, `react-native`, `@stripe/stripe-react-native`, but **does not** list `react-native-svg`.

5. **Backend Razorpay verification**:
   - In `backend/src/controllers/paymentController.js` (lines 263-295): Endpoint `/payments/razorpay/verify` calls `PaymentService.verifyRazorpayPayment(razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingId)`.
   - In `backend/src/services/paymentService.js` (lines 46-87): 
     ```javascript
     const isValid = signature === 'mock_upi_intent' ? true : razorpayAdapter.verifyPaymentSignature(orderId, paymentId, signature);
     ```
     Bypasses verification on `'mock_upi_intent'` signature.
   - Triggers payout on completion: `PayoutService.processBookingPayout(bookingId, spotterEarning, spotterId)` (lines 68-80).
   - In `backend/src/services/payments/PayoutService.js` (lines 311-349): Marks payout in DB and does a live payout via RazorpayX if `spotter.razorpay_fund_account_id` is present; otherwise credits spotter's database balance (`users.balance`) via `_createLocalPayout`.

6. **E2E Driver method missing**: In `tests/e2e/helpers/finderDriver.js`, there is no `reset()` method. However, `cases/tier1_feature.test.js` (line 47) and others call `finderDriver.reset()`.

## 2. Logic Chain
1. **R1 (Brand-Accurate Logos)**:
   - Emoticons are currently used as placeholders in `frontend/app/finder/index.tsx`.
   - Since `react-native-svg` is absent in `frontend/package.json`, implementing SVG-based rendering would require modifying dependency lists, which might complicate React Native/Expo builds.
   - Therefore, rendering with local `<Image>` components using PNG assets located in `frontend/assets/images/payments/` is the most direct, stable, and zero-dependency method.

2. **R2 (UPI Launch Fallback & Mock Simulator)**:
   - Deep links are formatted properly inside `handleUPIPayment(app)` using standard schemes.
   - However, the app launch relies on a standard try-catch around `Linking.openURL()`. It does not verify installation via `Linking.canOpenURL()`.
   - To make `Linking.canOpenURL()` resolve accurately on Android 11 (API 30) or above, Android requires explicit package/scheme queries. Currently, `AndroidManifest.xml` lacks declarations for `gpay`, `phonepe`, `paytmmp`, and `upi`.
   - Therefore, the app-specific queries must be added to `<queries>` in `AndroidManifest.xml`.
   - If `Linking.canOpenURL()` returns `false`, the client must launch a custom styled React Native modal matching the branding color and theme of the selected UPI provider, allowing simulated success (triggers verification with `'mock_upi_intent'`) or cancellation (returns state to selection).

3. **R3 (In-App Wallet Updates)**:
   - In-app checkout calls `/payments/razorpay/verify` upon UPI payment completion.
   - The backend already permits `'mock_upi_intent'` as a signature, bypassing Razorpay SDK verification.
   - Upon signature match, the backend updates the booking status to `paid` and initiates spotter payouts via `PayoutService.processBookingPayout`.
   - The payout service either transfers earnings via RazorpayX (if spotter is registered) or credits the spotter's `users.balance` locally in the database.
   - Once verified, the client UI transitions to the `receipt` step, displaying booking IDs, paid amount, and payment details.

## 3. Caveats
- The E2E test files call `finderDriver.reset()`, but `FinderDriver` class in `tests/e2e/helpers/finderDriver.js` does not implement `reset()`. Running tests will cause a runtime crash (`TypeError: finderDriver.reset is not a function`). A `reset()` method must be implemented on the test driver to restore initial properties: `state = 'idle'`, `currentBooking = null`, `checkoutDetails = null`, `selectedUpiApp = null`, `fallbackModalBranding = null`, and `simulateUrlLaunchFailure = false`.
- Android emulator limitations might cause `Linking.canOpenURL()` to always return `false` unless standard UPI applications (or stub receivers) are loaded. Thus, fallback simulation is highly critical for local developer testing.

## 4. Conclusion
1. **R1**: Replace Unicode emojis in the selector modal with `<Image>` components pointing to brand-accurate PNGs inside a new `frontend/assets/images/payments/` folder.
2. **R2**: Implement custom scheme intents in `AndroidManifest.xml` under `<queries>` and a new UI state inside `frontend/app/finder/index.tsx` representing the mock simulator modal. The mock simulator must render colors and text aligned with GPay (`#4285F4`), PhonePe (`#5F259F`), Paytm (`#00BAF2`), and generic UPI, triggering payment verification with `mock_upi_intent` signature or canceling back to selection.
3. **R3**: The backend handles the `'mock_upi_intent'` signature correctly, updates booking statuses, and processes spotter payouts (live RazorpayX or local database balance credits). The frontend must correctly handle `/payments/razorpay/verify` responses and navigate to the receipt screen.

## 5. Verification Method
1. **Test Commands**:
   - To verify the E2E behavior: run `npm test` inside `tests/e2e` (or run `node tests/e2e/runner.js`).
   - *Note*: You must fix the missing `reset()` method in `tests/e2e/helpers/finderDriver.js` first for E2E tests to run successfully.
2. **Files to Inspect**:
   - `frontend/app/finder/index.tsx` (payment selector & mock simulator modals, `canOpenURL` check).
   - `frontend/android/app/src/main/AndroidManifest.xml` (the `<queries>` tag).
   - `backend/src/services/paymentService.js` (verify method).
   - `backend/src/services/payments/PayoutService.js` (local balance credits).
3. **Invalidation Conditions**:
   - If `canOpenURL` check does not fall back to the mock simulator when the app is not installed.
   - If the payment verification fails on `'mock_upi_intent'`.
   - If spotter payout does not update `users.balance` in the database when RazorpayX credentials are not set.
