const test = require('node:test');
const assert = require('node:assert');
const ApiClient = require('../helpers/api');
const { resetDB, seedDB, prisma } = require('../helpers/db');
const FinderDriver = require('../helpers/finderDriver');

test.describe('Tier 3: Pairwise Combination Tests', () => {
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

  const combinations = [
    // 1. None installed, select gpay, complete fallback
    { installed: [], select: 'gpay', action: 'complete' },
    // 2. None installed, select phonepe, cancel fallback
    { installed: [], select: 'phonepe', action: 'cancel' },
    // 3. None installed, select paytm, complete fallback
    { installed: [], select: 'paytm', action: 'complete' },
    // 4. None installed, select generic, cancel fallback
    { installed: [], select: 'generic', action: 'cancel' },
    
    // 5. Gpay installed, select gpay (direct deep link)
    { installed: ['gpay'], select: 'gpay', action: 'complete' },
    // 6. Gpay installed, select phonepe, complete fallback
    { installed: ['gpay'], select: 'phonepe', action: 'complete' },
    // 7. Gpay installed, select paytm, cancel fallback
    { installed: ['gpay'], select: 'paytm', action: 'cancel' },

    // 8. PhonePe and Paytm installed, select phonepe (direct deep link)
    { installed: ['phonepe', 'paytm'], select: 'phonepe', action: 'complete' },
    // 9. PhonePe and Paytm installed, select paytm (direct deep link)
    { installed: ['phonepe', 'paytm'], select: 'paytm', action: 'complete' },
    // 10. PhonePe and Paytm installed, select gpay, complete fallback
    { installed: ['phonepe', 'paytm'], select: 'gpay', action: 'complete' },
    // 11. PhonePe and Paytm installed, select generic, cancel fallback
    { installed: ['phonepe', 'paytm'], select: 'generic', action: 'cancel' }
  ];

  combinations.forEach(({ installed, select, action }, index) => {
    test(`Combo #${index + 1}: installed=[${installed.join(',')}], select=${select}, action=${action}`, async () => {
      // Re-seed DB
      await resetDB();
      dbSeed = await seedDB();
      finderDriver.reset();
      finderDriver.setInstalledApps(installed);

      // Reserve and checkout
      const startTime = new Date(Date.now() + 60 * 1000).toISOString();
      const endTime = new Date(Date.now() + 3600 * 1000).toISOString();
      const booking = await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime);
      await finderDriver.initiateCheckout();

      // Trigger payment choice
      const payResult = await finderDriver.selectUpiPayment(select);

      const isInstalled = installed.includes(select);
      if (isInstalled) {
        // Direct deep link flow
        assert.strictEqual(payResult.type, 'deep_link');
        assert.strictEqual(finderDriver.state, 'receipt_view');
        
        // Assert DB is paid
        const checkBooking = await prisma.bookings.findUnique({ where: { id: booking.id } });
        assert.strictEqual(checkBooking.payment_status, 'paid');
      } else {
        // Fallback modal flow
        assert.strictEqual(payResult.type, 'fallback_modal');
        assert.strictEqual(finderDriver.state, 'fallback_modal_visible');

        if (action === 'complete') {
          const completeRes = await finderDriver.completeFallbackPayment();
          assert.strictEqual(completeRes.success, true);
          assert.strictEqual(finderDriver.state, 'receipt_view');

          const checkBooking = await prisma.bookings.findUnique({ where: { id: booking.id } });
          assert.strictEqual(checkBooking.payment_status, 'paid');
        } else {
          const cancelRes = finderDriver.cancelFallbackPayment();
          assert.strictEqual(cancelRes.success, true);
          assert.strictEqual(finderDriver.state, 'checkout_initiated');

          const checkBooking = await prisma.bookings.findUnique({ where: { id: booking.id } });
          assert.notStrictEqual(checkBooking.payment_status, 'paid');
        }
      }
    });
  });
});
