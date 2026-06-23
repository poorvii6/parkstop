const request = require('supertest');
const { app, server } = require('../../src/server');
const prisma = require('../../src/config/prisma');

describe('Booking API', () => {
  let finderToken, spotterToken, spotId;

  beforeAll(async () => {
    // 1. Create Finder
    await request(app).post('/api/v1/auth/register').send({
      email: 'testfinder@parkstop.test',
      password: 'Password123',
      name: 'Test Finder',
      role: 'finder'
    });
    
    const finderLogin = await request(app).post('/api/v1/auth/login').send({
      email: 'testfinder@parkstop.test',
      password: 'Password123'
    });
    finderToken = finderLogin.body.data.access_token;

    // 2. Create Spotter
    await request(app).post('/api/v1/auth/register').send({
      email: 'testspotter@parkstop.test',
      password: 'Password123',
      name: 'Test Spotter',
      role: 'spotter'
    });
    
    const spotterLogin = await request(app).post('/api/v1/auth/login').send({
      email: 'testspotter@parkstop.test',
      password: 'Password123'
    });
    spotterToken = spotterLogin.body.data.access_token;
    const spotterId = spotterLogin.body.data.user.id;

    // 3. Create a Spot using Prisma directly
    const spot = await prisma.parking_spots.create({
      data: {
        spotter_id: spotterId,
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
    await prisma.bookings.deleteMany({ where: { users: { email: { contains: '@parkstop.test' } } } });
    await prisma.parking_spots.deleteMany({ where: { users: { email: { contains: '@parkstop.test' } } } });
    await prisma.users.deleteMany({ where: { email: { contains: '@parkstop.test' } } });
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

  test('Rate limiter blocks >10 login attempts', async () => {
    const attempts = Array(12).fill(null).map(() =>
      request(app).post('/api/v1/auth/login').send({ email: 'x@x.com', password: 'wrong' })
    );
    const responses = await Promise.all(attempts);
    const tooMany = responses.some(r => r.status === 429);
    expect(tooMany).toBe(true);
  });

  test('Spotter cannot create a booking', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .set('Authorization', `Bearer ${spotterToken}`)
      .send({ spot_id: 1, start_time: new Date().toISOString(), end_time: new Date().toISOString() });
    expect(res.status).toBe(403);
  });
});
