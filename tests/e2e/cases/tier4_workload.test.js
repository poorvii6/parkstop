const test = require('node:test');
const assert = require('node:assert');
const ApiClient = require('../helpers/api');
const { resetDB, seedDB, prisma } = require('../helpers/db');
const FinderDriver = require('../helpers/finderDriver');
const SpotterDriver = require('../helpers/spotterDriver');

test.describe('Tier 4: Real-world Workloads', () => {
  let finderApi, spotterApi;
  let finderDriver, spotterDriver;
  let dbSeed;

  test.before(async () => {
    await resetDB();
    dbSeed = await seedDB();

    finderApi = new ApiClient();
    spotterApi = new ApiClient();

    // Log in Finder
    const finderLogin = await finderApi.post('/auth/login', {
      email: 'finder@example.com',
      password: 'password123'
    });
    finderApi.setToken(finderLogin.data.data.access_token);

    // Log in Spotter
    const spotterLogin = await spotterApi.post('/auth/login', {
      email: 'spotter@example.com',
      password: 'password123'
    });
    spotterApi.setToken(spotterLogin.data.data.access_token);

    finderDriver = new FinderDriver(finderApi);
    spotterDriver = new SpotterDriver(spotterApi);
  });

  test.beforeEach(async () => {
    await resetDB();
    dbSeed = await seedDB();
    finderDriver.reset();
  });

  test.after(async () => {
    await prisma.$disconnect();
  });

  test('Concurrency: multiple finders checkout and pay concurrently', async () => {
    // 1. Create a spot with 5 slots so multiple finders can check out simultaneously
    const spot = await prisma.parking_spots.update({
      where: { id: dbSeed.spot.id },
      data: { total_slots: 5, available_slots: 5, car_slots: 5 }
    });

    // 2. Register/login 3 separate finder clients
    const numFinders = 3;
    const finders = [];
    
    for (let i = 1; i <= numFinders; i++) {
      const email = `finder_concur_${i}@example.com`;
      const pwd = 'password123';
      
      // Register
      const regRes = await finderApi.post('/auth/register', {
        email,
        password: pwd,
        name: `Finder ${i}`,
        phone: `987654321${i}`,
        role: 'finder'
      });
      assert.strictEqual(regRes.ok, true, `Failed to register concurrency finder ${i}`);

      // Login
      const client = new ApiClient();
      const loginRes = await client.post('/auth/login', { email, password: pwd });
      assert.strictEqual(loginRes.ok, true);
      client.setToken(loginRes.data.data.access_token);

      // Create payment method for auto-billing compatibility
      await prisma.payment_methods.create({
        data: {
          user_id: loginRes.data.data.user.id,
          provider: 'stripe',
          provider_method_id: `pm_concur_${i}`,
          method_type: 'card',
          is_default: true
        }
      });

      finders.push({
        client,
        driver: new FinderDriver(client, ['gpay']) // simulates Google Pay installed
      });
    }

    // 3. Initiate parallel reservations and checkouts
    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();

    const paymentPromises = finders.map(async ({ driver }) => {
      // Reserve
      const booking = await driver.reserveSpot(spot.id, startTime, endTime);
      // Checkout
      await driver.initiateCheckout();
      // Pay via deep link
      const payRes = await driver.selectUpiPayment('gpay');
      return { booking, payRes };
    });

    const results = await Promise.all(paymentPromises);

    // 4. Assert that all payments went through successfully
    for (const res of results) {
      assert.strictEqual(res.payRes.type, 'deep_link');
      assert.strictEqual(res.payRes.success, true);
      
      const bookingInDB = await prisma.bookings.findUnique({
        where: { id: res.booking.id }
      });
      assert.strictEqual(bookingInDB.payment_status, 'paid');
    }
  });

  test('Dynamic pricing surge payments: occupancy increments increase price', async () => {
    // 1. Create a spot with 2 slots
    const spot = await prisma.parking_spots.update({
      where: { id: dbSeed.spot.id },
      data: { total_slots: 2, available_slots: 2, car_slots: 2, price_per_hour: 10.00 }
    });

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();

    // 2. Fetch base price (no occupancy)
    const basePriceRes = await finderApi.post('/bookings/calculate-price', {
      spot_id: spot.id,
      start_time: startTime,
      end_time: endTime
    });
    assert.strictEqual(basePriceRes.ok, true);
    const firstPrice = basePriceRes.data.data.total_price;

    // 3. Occupy slot 1 (create active booking)
    const booking1 = await prisma.bookings.create({
      data: {
        user_id: dbSeed.finder.id,
        spot_id: spot.id,
        start_time: new Date(),
        status: 'active', // Active booking increases occupancy
        total_price: 10.00,
        hours: 1
      }
    });

    // 4. Recalculate price. Occupancy is now 1 out of 2 slots (50% occupancy)
    // Demand multiplier should increase to 1.1x
    const surgePriceRes = await finderApi.post('/bookings/calculate-price', {
      spot_id: spot.id,
      start_time: startTime,
      end_time: endTime
    });
    assert.strictEqual(surgePriceRes.ok, true);
    const secondPrice = surgePriceRes.data.data.total_price;

    assert.ok(secondPrice > firstPrice, `Surge price (${secondPrice}) should be greater than base price (${firstPrice})`);

    // Clean up booking
    await prisma.bookings.delete({ where: { id: booking1.id } });
  });

  test('Cash platform fee wallet updates: completes cash booking and decrements spotter wallet balance', async () => {
    // Get initial spotter wallet balance
    const initialWallet = await spotterDriver.getWalletDetails();
    const initialBalance = initialWallet.balance;

    const startTime = new Date(Date.now() + 60 * 1000).toISOString();
    const endTime = new Date(Date.now() + 3600 * 1000).toISOString();

    // 1. Reserve spot with payment mode = CASH
    const booking = await finderDriver.reserveSpot(dbSeed.spot.id, startTime, endTime, {
      payment_mode: 'cash'
    });
    assert.strictEqual(booking.payment_mode, 'cash');
    assert.strictEqual(booking.payment_status, 'pending_cash');

    // 2. Spotter checks in (OTP verification)
    const checkinRes = await spotterDriver.verifyCheckInOTP(booking.id, booking.otp_code);
    assert.strictEqual(checkinRes.ok, true);

    // 3. Spotter completes booking via checkout OTP
    // Fetch fresh booking to get checkout OTP
    const freshBooking = await prisma.bookings.findUnique({ where: { id: booking.id } });
    const checkoutRes = await spotterDriver.verifyCheckOutOTP(booking.id, freshBooking.checkout_otp);
    assert.strictEqual(checkoutRes.ok, true);

    // 4. Assert booking status is completed and paid
    const finalBooking = await prisma.bookings.findUnique({ where: { id: booking.id } });
    assert.strictEqual(finalBooking.status, 'completed');
    assert.strictEqual(finalBooking.payment_status, 'paid');
    
    // Platform fee should be filled
    const platformFee = parseFloat(finalBooking.platform_fee);
    assert.ok(platformFee > 0, 'Platform fee should be greater than 0');

    // 5. Assert spotter wallet balance has been decremented by the platform fee
    const finalWallet = await spotterDriver.getWalletDetails();
    const finalBalance = finalWallet.balance;

    const expectedBalance = parseFloat((initialBalance - platformFee).toFixed(2));
    assert.strictEqual(finalBalance, expectedBalance, 'Spotter wallet balance should be decremented by platform fee');
  });
});
