jest.mock('../../src/config/firebase', () => ({
  adminApp: {},
  auth: {
    verifyIdToken: jest.fn().mockImplementation((token) => {
      if (token && typeof token === 'string' && token.startsWith('mock-firebase-token-')) {
        const uid = token.replace('mock-firebase-token-', '');
        return Promise.resolve({
          uid: uid,
          email: `${uid}@gmail.com`,
          name: uid.charAt(0).toUpperCase() + uid.slice(1)
        });
      }
      return Promise.reject(new Error('Not a mock Firebase token'));
    })
  }
}));

const request = require('supertest');
const { app, server } = require('../../src/server');
const prisma = require('../../src/config/prisma');

describe('Booking API', () => {
  let finderToken, spotterToken, spotId;

  beforeAll(async () => {
    // 1. Create Finder
    await request(app).post('/api/v1/auth/register').send({
      email: 'testfinder@gmail.com',
      name: 'Test Finder',
      phone: '9876543210',
      role: 'finder',
      firebase_token: 'mock-firebase-token-testfinder'
    });
    finderToken = 'mock-firebase-token-testfinder';

    // 2. Create Spotter
    await request(app).post('/api/v1/auth/register').send({
      email: 'testspotter@gmail.com',
      name: 'Test Spotter',
      phone: '9876543211',
      role: 'spotter',
      firebase_token: 'mock-firebase-token-testspotter'
    });
    spotterToken = 'mock-firebase-token-testspotter';

    // Get spotter user id to create a spot
    const spotter = await prisma.users.findUnique({
      where: { firebase_uid: 'testspotter' }
    });

    // 3. Create a Spot using Prisma directly
    const spot = await prisma.parking_spots.create({
      data: {
        spotter_id: spotter.id,
        title: 'Jest Test Spot',
        description: 'Spot description',
        price_per_hour: 10.00,
        latitude: 12.971598,
        longitude: 77.594562,
        is_available: true,
        address: 'Jest Test Address',
        base_price: 5.00,
        total_slots: 2,
        available_slots: 2,
        location_type: 'urban',
        is_active: true,
        amenities: [],
        slot_names: ['Slot A', 'Slot B']
      }
    });
    spotId = spot.id;
  });

  afterAll(async () => {
    // Close the HTTP server
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
    // Cleanup DB
    await prisma.bookings.deleteMany({ where: { users: { email: { contains: '@gmail.com' } } } });
    await prisma.parking_spots.deleteMany({ where: { users: { email: { contains: '@gmail.com' } } } });
    await prisma.users.deleteMany({ where: { email: { in: ['testfinder@gmail.com', 'testspotter@gmail.com'] } } });
    await prisma.$disconnect();
  });

  test('Finder can create a booking', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${finderToken}`)
      .send({
        spot_id: spotId,
        start_time: new Date(Date.now() + 60000).toISOString(),
        end_time: new Date(Date.now() + 3700000).toISOString()
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  /**
   * The login limiter counts FAILED attempts only.
   *
   * This changed deliberately: /auth/social-login doubles as profile sync, so
   * it fires on every sign-in and role switch. When successes counted toward
   * the budget, ordinary use locked real users out of their own account with a
   * bare 429. The credential here is a Firebase ID token that Firebase has
   * already verified, so this limiter is abuse protection — not a password
   * gate — and rejecting valid sign-ins bought nothing.
   */
  describe('social-login rate limiting', () => {
    // Requests are issued SEQUENTIALLY, not via Promise.all. skipSuccessfulRequests
    // decrements the counter when the response finishes, so a parallel burst can
    // transiently exceed the cap before any decrements land — which would make
    // these tests flaky. Sequential also mirrors how a real person signs in.
    const post = (token) =>
      request(app).post('/api/v1/auth/social-login').send({ token });

    test('repeated SUCCESSFUL logins are never rate limited', async () => {
      // The regression guard for the lockout bug: a real user signing in
      // several times in a row must never be turned away.
      const statuses = [];
      for (let i = 0; i < 25; i++) statuses.push((await post('mock-firebase-token-testfinder')).status);

      expect(statuses).not.toContain(429);
    });

    test('repeated FAILED attempts are rate limited', async () => {
      // Garbage tokens are what probing looks like, and those still get cut off.
      const statuses = [];
      for (let i = 0; i < 30; i++) statuses.push((await post('not-a-valid-token')).status);

      expect(statuses).toContain(429);
    });
  });

  test('Spotter cannot create a booking', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${spotterToken}`)
      .send({ spot_id: 1, start_time: new Date().toISOString(), end_time: new Date().toISOString() });
    expect(res.status).toBe(403);
  });
});
