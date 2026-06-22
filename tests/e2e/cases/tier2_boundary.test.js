const test = require('node:test');
const assert = require('node:assert');
const ApiClient = require('../helpers/api');
const { resetDB, seedDB, prisma } = require('../helpers/db');
const FinderDriver = require('../helpers/finderDriver');

test.describe('Tier 2: Boundary Cases', () => {
  let finderApi;
  let finderDriver;
  let dbSeed;

  test.before(async () => {
    await resetDB();
    dbSeed = await seedDB();

    finderApi = new ApiClient();
    const finderLogin = await finderApi.post('/auth/login', {
      email: 'finder@example.com',
      password: 'password123'
    });
    finderApi.setToken(finderLogin.data.data.access_token);
    finderDriver = new FinderDriver(finderApi);
  });

  test.beforeEach(async () => {
    await resetDB();
    dbSeed = await seedDB();
    finderDriver.reset();
  });

  test.after(async () => {
    await prisma.$disconnect();
  });

  test('Missing apps: always triggers fallback modal when installed list is empty', async () => {
    finderDriver.setInstalledApps([]);

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    await finderDriver.initiateCheckout();

    const result = await finderDriver.selectUpiPayment('gpay');
    assert.strictEqual(result.type, 'fallback_modal');
    assert.strictEqual(finderDriver.state, 'fallback_modal_visible');
  });

  test('URL launch failure: falls back to modal even if app is in installed list', async () => {
    // App is installed, but launch failure is simulated
    finderDriver.setInstalledApps(['gpay']);
    finderDriver.simulateUrlLaunchFailure = true;

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    await finderDriver.initiateCheckout();

    const result = await finderDriver.selectUpiPayment('gpay');
    assert.strictEqual(result.type, 'fallback_modal');
    assert.strictEqual(finderDriver.state, 'fallback_modal_visible');
  });

  test('Mock cancel decision: transitions state back to selection', async () => {
    finderDriver.setInstalledApps([]);

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    await finderDriver.initiateCheckout();

    await finderDriver.selectUpiPayment('gpay');
    assert.strictEqual(finderDriver.state, 'fallback_modal_visible');

    const cancelRes = finderDriver.cancelFallbackPayment();
    assert.strictEqual(cancelRes.success, true);
    assert.strictEqual(finderDriver.state, 'checkout_initiated');
  });

  test('Invalid inputs: API verification rejects invalid booking ID, missing parameters, or bad signature', async () => {
    // 1. Missing parameters
    const res1 = await finderApi.post('/payments/razorpay/verify', {
      bookingId: dbSeed.spot.id,
      razorpay_order_id: '',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'mock_upi_intent'
    });
    assert.strictEqual(res1.status, 400, 'Expected 400 Bad Request for missing order ID');

    // 2. Invalid booking ID
    const res2 = await finderApi.post('/payments/razorpay/verify', {
      bookingId: 99999, // Non-existent booking
      razorpay_order_id: 'order_123',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'mock_upi_intent'
    });
    assert.strictEqual(res2.status, 404, 'Expected 404 Not Found for invalid booking ID');

    // 3. Bad/unauthorized signature
    const res3 = await finderApi.post('/payments/razorpay/verify', {
      bookingId: dbSeed.spot.id,
      razorpay_order_id: 'order_123',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'invalid_signature'
    });
    // The backend verify signature will call Razorpay SDK or check signature. If signature is not 'mock_upi_intent', 
    // it executes verification logic which will fail (status 500 or 400) because keys/signatures are mock.
    assert.ok(res3.status >= 400, 'Expected failure status code for bad signature');
  });

  test('Duplicate payment validations: handles consecutive verification requests gracefully without failure', async () => {
    finderDriver.setInstalledApps(['gpay']);

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const booking = await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
    const checkout = await finderDriver.initiateCheckout();

    // Call verify the first time
    const res1 = await finderApi.post('/payments/razorpay/verify', {
      bookingId: booking.id,
      razorpay_order_id: checkout.order_id,
      razorpay_payment_id: 'pay_duplicate_test',
      razorpay_signature: 'mock_upi_intent'
    });
    assert.strictEqual(res1.status, 200, 'First payment verification should succeed');

    // Call verify the second time (should still respond successfully/idempotently or without crashing)
    const res2 = await finderApi.post('/payments/razorpay/verify', {
      bookingId: booking.id,
      razorpay_order_id: checkout.order_id,
      razorpay_payment_id: 'pay_duplicate_test',
      razorpay_signature: 'mock_upi_intent'
    });
    assert.strictEqual(res2.status, 200, 'Second payment verification should handle duplicate gracefully');

    const checkBooking = await prisma.bookings.findUnique({
      where: { id: booking.id }
    });
    assert.strictEqual(checkBooking.payment_status, 'paid', 'Booking payment status should remain paid');
  });
});
