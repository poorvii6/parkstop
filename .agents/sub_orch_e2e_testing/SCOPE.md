# Scope: E2E Testing Track

## Architecture
- The application uses a React Native (Expo) frontend and Express/Prisma/PostgreSQL backend.
- E2E tests are implemented as automated Node.js integration scripts that run against the API, simulate client states, mock `Linking` behavior, and verify database consistency and UI requirements (logo existence, style checks, modal layout, navigation state transitions).

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Test Plan Definition | Define E2E test scenarios across all 4 tiers in SCOPE.md and write `TEST_INFRA.md`. | none | IN_PROGRESS |
| 2 | Test Infra Setup | Design and build the Node.js test runner and helper tools. | M1 | PLANNED |
| 3 | Test Case Implementation | Implement the 4 tiers of test cases (Tier 1-4). | M2 | PLANNED |
| 4 | Verification & Audit | Verify correctness and pass the Forensic Auditor checks. | M3 | PLANNED |
| 5 | Publishing | Publish `TEST_READY.md`. | M4 | PLANNED |

## Interface Contracts
- Tests simulate the API endpoints for user login, booking, checkout, and payment verification.
- Frontend testing uses mocked native calls for `Linking.canOpenURL` and `Linking.openURL` to test the fallback modal triggers and deep-linking values.

## Code Layout
- `tests/e2e/runner.js` - Main E2E test execution runner.
- `tests/e2e/cases/tier1_feature.test.js` - Tier 1 Feature Coverage test cases.
- `tests/e2e/cases/tier2_boundary.test.js` - Tier 2 Boundary & Edge Cases test cases.
- `tests/e2e/cases/tier3_combination.test.js` - Tier 3 Cross-feature Combinations.
- `tests/e2e/cases/tier4_workload.test.js` - Tier 4 Real-world Application Scenarios.

## Detailed Test Scenarios (4 Tiers)

### Tier 1: Feature Coverage (>=5 cases per feature)
1. **Payment Selector Logos**
   - Case 1.1: Verify Google Pay button displays GPay logo element (SVG/Image).
   - Case 1.2: Verify PhonePe button displays PhonePe logo element (SVG/Image).
   - Case 1.3: Verify Paytm button displays Paytm logo element (SVG/Image).
   - Case 1.4: Verify Other UPI button displays generic UPI logo element.
   - Case 1.5: Verify card payment selector displays card icon/logo.
2. **UPI App Deep-Linking**
   - Case 2.1: Verify GPay launches `gpay://upi/pay?...` deep link when installed.
   - Case 2.2: Verify PhonePe launches `phonepe://upi/pay?...` deep link when installed.
   - Case 2.3: Verify Paytm launches `paytmmp://upi/pay?...` deep link when installed.
   - Case 2.4: Verify generic UPI launches `upi://pay?...` deep link when installed.
   - Case 2.5: Verify deep-link parameters (`pa`, `pn`, `am`, `cu`, `tr`, `tn`) are correctly formatted.
3. **Fallback Modal UI**
   - Case 3.1: Verify Google Pay fallback modal uses blue themed branding styles.
   - Case 3.2: Verify PhonePe fallback modal uses purple themed branding styles.
   - Case 3.3: Verify Paytm fallback modal uses light-blue themed branding styles.
   - Case 3.4: Verify fallback modal contains a "Complete Mock Payment" button.
   - Case 3.5: Verify fallback modal contains a "Cancel" button.
4. **Payment Completion Status Update**
   - Case 4.1: Verify completing mock payment transitions booking status to `paid`.
   - Case 4.2: Verify payment record is correctly saved in the database with transaction ID `pay_mock_upi_...`.
   - Case 4.3: Verify spotter payout is triggered upon mock payment verification.
   - Case 4.4: Verify verify API validates payload structure.
   - Case 4.5: Verify verification endpoint returns success status.
5. **Booking Receipt Transition**
   - Case 5.1: Verify transitioning to receipt displays the matching booking ID.
   - Case 5.2: Verify receipt displays correct total price.
   - Case 5.3: Verify receipt shows parking spot location details.
   - Case 5.4: Verify receipt contains "Back to Dashboard" button.
   - Case 5.5: Verify clicking "Back to Dashboard" returns screen state to choice/dashboard.

### Tier 2: Boundary & Edge Cases (>=5 cases per feature)
1. **UPI App Not Installed**
   - Case 1.1: GPay selected but `canOpenURL` is false -> opens GPay themed fallback modal.
   - Case 1.2: PhonePe selected but `canOpenURL` is false -> opens PhonePe themed fallback modal.
   - Case 1.3: Paytm selected but `canOpenURL` is false -> opens Paytm themed fallback modal.
   - Case 1.4: Generic UPI selected but `canOpenURL` is false -> opens generic UPI fallback modal.
   - Case 1.5: Verify no deep-link redirect is triggered if `canOpenURL` is false.
2. **URL Launch Fails**
   - Case 2.1: GPay `openURL` throws error -> opens GPay themed fallback modal.
   - Case 2.2: PhonePe `openURL` throws error -> opens PhonePe themed fallback modal.
   - Case 2.3: Paytm `openURL` throws error -> opens Paytm themed fallback modal.
   - Case 2.4: Ensure error logs are produced upon deep link launch failure.
   - Case 2.5: User can successfully checkout with alternative method after deep-link launch fails.
3. **User Cancels Mock Payment**
   - Case 3.1: Tapping "Cancel" in mock modal does not mark booking as paid.
   - Case 3.2: Tapping "Cancel" keeps booking in unpaid/completed (awaiting payment) state.
   - Case 3.3: Tapping "Cancel" returns user to payment method selection screen.
   - Case 3.4: Cancellation does not trigger spotter payout.
   - Case 3.5: User can retry checkout immediately after cancelling mock payment.
4. **Empty or Invalid Inputs**
   - Case 4.1: Verify API called with missing bookingId returns 400.
   - Case 4.2: Verify API called with invalid signature returns 400/error.
   - Case 4.3: Verify API called with mismatching orderId returns 400.
   - Case 4.4: Verify API rejected for bookings owned by other users.
   - Case 4.5: Verify API rejects checkout session request for non-finder roles.
5. **Duplicate Payments**
   - Case 5.1: Duplicate verify payments request fails gracefully or is idempotent.
   - Case 5.2: Verification endpoint ensures only one spotter payout is triggered per booking.
   - Case 5.3: Duplicate complete payment triggers are disabled at UI component level.
   - Case 5.4: Booking status remains `paid` and does not overwrite existing transaction details.
   - Case 5.5: Simultaneous database checkout checks prevent double reservations.

### Tier 3: Cross-Feature Combinations (pairwise interactions)
- Case 3.1: Happy-path flow: booking creation -> check-in OTP verification -> checkout -> modal fallback -> payment -> receipt screen.
- Case 3.2: Cancellation flow: booking creation -> checkout -> modal fallback -> cancel -> select different app -> open fallback -> complete payment -> receipt screen.
- Case 3.3: Wallet/Payout verification flow: booking creation -> check-out -> mock payment -> verification -> verify spotter balance increased by spotter_earning.
- Case 3.4: Re-entry flow: booking creation -> check-out -> app not installed -> modal fallback -> click complete -> navigate to receipt -> go back to dashboard -> verify finder flow is clean.
- Case 3.5: Error recovery flow: invalid checkout session request -> select card instead -> simulate card payment -> verify receipt transitions correctly.

### Tier 4: Real-World Workloads
- Scenario 4.1: Full happy-path finder booking: finder logs in -> selects vehicle -> searches for spot -> selects slot -> confirms reservation -> navigates -> checks in via OTP -> ends session -> checks out via OTP -> pays online via Paytm mock fallback -> receipt transitions -> spotter balance verified.
- Scenario 4.2: Spotter payout loop: finder books -> checks in -> checks out -> pays via GPay mock fallback -> spotter account balance is updated by the exact payout amount (80% of booking price or spotter_earning) -> verify spotter can query their balance.
- Scenario 4.3: Dynamic price booking: search -> confirm booking with surge price -> check-in -> end session -> pay surge price via fallback modal -> receipt matches surge price exactly.
- Scenario 4.4: Navigation cancel & re-book: finder books -> starts navigation -> cancels navigation halfway -> books another spot -> completes parking -> pays cash -> check spot status changed.
- Scenario 4.5: Multiple parallel bookings and payouts: two finders book different spots at the same time -> check in -> check out -> finder 1 pays via GPay fallback modal -> finder 2 pays via PhonePe fallback modal -> verify both spotters get correct payouts concurrently and balances match.
