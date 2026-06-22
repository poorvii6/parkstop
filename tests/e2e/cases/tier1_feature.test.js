const test = require('node:test');
const assert = require('node:assert');
const ApiClient = require('../helpers/api');
const { resetDB, seedDB, prisma } = require('../helpers/db');
const FinderDriver = require('../helpers/finderDriver');
const SpotterDriver = require('../helpers/spotterDriver');

test.describe('Tier 1: Feature Coverage Tests', () => {
  let finderApi, spotterApi;
  let finderDriver, spotterDriver;
  let dbSeed;

  test.before(async () => {
    // Reset and seed DB before tests
    await resetDB();
    dbSeed = await seedDB();

    // Initialize API Clients
    finderApi = new ApiClient();
    spotterApi = new ApiClient();

    // Log in Finder
    const finderLogin = await finderApi.post('/auth/login', {
      email: 'finder@example.com',
      password: 'password123'
    });
    assert.strictEqual(finderLogin.ok, true, 'Finder login failed');
    finderApi.setToken(finderLogin.data.data.access_token);

    // Log in Spotter
    const spotterLogin = await spotterApi.post('/auth/login', {
      email: 'spotter@example.com',
      password: 'password123'
    });
    assert.strictEqual(spotterLogin.ok, true, 'Spotter login failed');
    spotterApi.setToken(spotterLogin.data.data.access_token);

    // Initialize Drivers
    finderDriver = new FinderDriver(finderApi);
    spotterDriver = new SpotterDriver(spotterApi);
  });

  test.beforeEach(async () => {
    // Re-seed DB to have clean starting point for each test
    await resetDB();
    dbSeed = await seedDB();
    finderDriver.reset();
  });

  test.after(async () => {
    await prisma.$disconnect();
  });

  test('UPI app deep link formatting contains required query parameters', async () => {
    // Reserve spot and initiate checkout
    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    
    await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    await finderDriver.initiateCheckout();

    // Test deep links for all major providers
    const apps = ['gpay', 'phonepe', 'paytm', 'generic'];
    for (const app of apps) {
      const url = finderDriver.formatUpiDeepLink(app);
      assert.ok(url.includes('pa=spotter%40upi'), `Deep link for ${app} missing payee address`);
      assert.ok(url.includes('pn=John+Spotter'), `Deep link for ${app} missing payee name`);
      assert.ok(url.includes('am='), `Deep link for ${app} missing amount`);
      assert.ok(url.includes('tr='), `Deep link for ${app} missing transaction reference (order ID)`);
      assert.ok(url.includes('cu=INR'), `Deep link for ${app} missing currency`);

      if (app === 'gpay') {
        assert.ok(url.startsWith('gpay://'), 'Google Pay deep link must start with gpay://');
      } else if (app === 'phonepe') {
        assert.ok(url.startsWith('phonepe://'), 'PhonePe deep link must start with phonepe://');
      } else if (app === 'paytm') {
        assert.ok(url.startsWith('paytmmp://'), 'Paytm deep link must start with paytmmp://');
      } else {
        assert.ok(url.startsWith('upi://'), 'Generic UPI deep link must start with upi://');
      }
    }
  });

  test('Fallback UI Modal displays appropriate branding and styling when app is missing', async () => {
    // Mock no apps installed
    finderDriver.setInstalledApps([]);

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    await finderDriver.initiateCheckout();

    // 1. Google Pay Fallback Branding
    const gpayResult = await finderDriver.selectUpiPayment('gpay');
    assert.strictEqual(gpayResult.type, 'fallback_modal');
    assert.strictEqual(gpayResult.branding.appName, 'Google Pay');
    assert.strictEqual(gpayResult.branding.themeColor, '#4285F4');
    assert.strictEqual(gpayResult.branding.logoAsset, 'gpay_logo_vector.png');

    // Reset back to selection
    finderDriver.cancelFallbackPayment();

    // 2. PhonePe Fallback Branding
    const phonepeResult = await finderDriver.selectUpiPayment('phonepe');
    assert.strictEqual(phonepeResult.type, 'fallback_modal');
    assert.strictEqual(phonepeResult.branding.appName, 'PhonePe');
    assert.strictEqual(phonepeResult.branding.themeColor, '#5F259F');

    finderDriver.cancelFallbackPayment();

    // 3. Paytm Fallback Branding
    const paytmResult = await finderDriver.selectUpiPayment('paytm');
    assert.strictEqual(paytmResult.type, 'fallback_modal');
    assert.strictEqual(paytmResult.branding.appName, 'Paytm');
    assert.strictEqual(paytmResult.branding.logoAsset, 'paytm_logo_vector.png');
  });

  test('Fallback Modal Cancellation returns client state back to checkout selection', async () => {
    finderDriver.setInstalledApps([]);

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    await finderDriver.initiateCheckout();

    // Trigger fallback modal
    await finderDriver.selectUpiPayment('gpay');
    assert.strictEqual(finderDriver.state, 'fallback_modal_visible');

    // Cancel modal
    const cancelRes = finderDriver.cancelFallbackPayment();
    assert.strictEqual(cancelRes.success, true);
    assert.strictEqual(finderDriver.state, 'checkout_initiated');
    assert.strictEqual(finderDriver.fallbackModalBranding, null);
  });

  test('Completing deep link payment updates DB status and formats receipt page', async () => {
    // Simulating PhonePe installed
    finderDriver.setInstalledApps(['phonepe']);

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const booking = await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    await finderDriver.initiateCheckout();

    // Choose PhonePe (should execute deep link and immediately verify)
    const payResult = await finderDriver.selectUpiPayment('phonepe');
    assert.strictEqual(payResult.type, 'deep_link');
    assert.strictEqual(payResult.success, true);
    assert.strictEqual(finderDriver.state, 'receipt_view');

    // Query DB to verify booking has been marked as paid
    const updatedBooking = await prisma.bookings.findUnique({
      where: { id: booking.id }
    });
    assert.strictEqual(updatedBooking.payment_status, 'paid');
    assert.ok(updatedBooking.payment_id.startsWith('pay_deep_'));

    // Verify receipt formatting
    const receipt = finderDriver.getReceipt();
    assert.strictEqual(receipt.bookingId, booking.id);
    assert.strictEqual(receipt.status, 'paid');
    assert.strictEqual(receipt.selectedApp, 'phonepe');
    assert.ok(receipt.receiptNo.startsWith('REC-'));
  });

  test('Full Session flow from reserving, checking in (OTP), paying (fallback modal), and completing', async () => {
    // No apps installed
    finderDriver.setInstalledApps([]);

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    
    // 1. Reserve spot
    const booking = await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    assert.strictEqual(booking.status, 'reserved');

    // 2. Spotter checks in the vehicle by verifying the check-in OTP
    const freshBooking = await prisma.bookings.findUnique({ where: { id: booking.id } });
    const checkinRes = await spotterDriver.verifyCheckInOTP(booking.id, freshBooking.otp_code);
    assert.strictEqual(checkinRes.ok, true, 'Check-in OTP verification failed');
    assert.strictEqual(checkinRes.data.data.status, 'active');

    // 3. Initiate checkout
    await finderDriver.initiateCheckout();

    // 4. Select payment app (triggers fallback)
    const selectRes = await finderDriver.selectUpiPayment('paytm');
    assert.strictEqual(selectRes.type, 'fallback_modal');

    // 5. Complete payment in fallback modal
    const completeRes = await finderDriver.completeFallbackPayment();
    assert.strictEqual(completeRes.success, true);

    // 6. DB check: Payment Status should be paid
    const paidBooking = await prisma.bookings.findUnique({ where: { id: booking.id } });
    assert.strictEqual(paidBooking.payment_status, 'paid');

    // 7. Spotter checks out and completes booking by verifying Checkout OTP
    const checkoutOtp = paidBooking.checkout_otp;
    const checkoutRes = await spotterDriver.verifyCheckOutOTP(booking.id, checkoutOtp);
    assert.strictEqual(checkoutRes.ok, true, 'Checkout OTP verification failed');
    
    // 8. DB check: Booking status should be completed
    const finalBooking = await prisma.bookings.findUnique({ where: { id: booking.id } });
    assert.strictEqual(finalBooking.status, 'completed');
  });
});
