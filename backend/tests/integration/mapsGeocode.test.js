/**
 * GET /maps/geocode — what it returns, and what it now returns as well.
 *
 * It used to answer `{lat, lon}` and throw everything else away. That was
 * enough for the map search, which flies the camera to a place name, and
 * useless for the per-spot address check: a full Indian street address comes
 * back as the STREET and a locality as a box kilometres across, so a distance
 * measured against it means nothing without knowing which it was.
 *
 * `lat` and `lon` are still there, and still strings, because that is all the
 * finder reads (app/finder/index.tsx parseFloats them).
 *
 *   npm run test:integration
 */
jest.mock('../../src/config/firebase', () => ({
  adminApp: {},
  auth: {
    verifyIdToken: jest.fn().mockImplementation((token) => {
      if (token && typeof token === 'string' && token.startsWith('mock-firebase-token-')) {
        const uid = token.replace('mock-firebase-token-', '');
        return Promise.resolve({ uid, email: `${uid}@gmail.com`, name: uid });
      }
      return Promise.reject(new Error('Not a mock Firebase token'));
    }),
  },
}));

jest.mock('../../src/services/geocoding', () => {
  const actual = jest.requireActual('../../src/services/geocoding');
  return { ...actual, geocodeAddress: jest.fn() };
});

const request = require('supertest');
const { app } = require('../../src/server');
const prisma = require('../../src/config/prisma');
const { geocodeAddress } = require('../../src/services/geocoding');

const USER = { uid: 'geocodeuser', email: 'geocodeuser@gmail.com', phone: '9876400077' };
const token = `mock-firebase-token-${USER.uid}`;

/** A locality-sized answer, of the kind most Indian addresses produce. */
const SUBURB = {
  lat: '12.9719', lon: '77.6412',
  precision: 'locality', uncertainty_m: 2211, source: 'nominatim',
  display_name: 'Indiranagar, Bengaluru Central City Corporation, Bengaluru',
  bbox: [12.952, 12.992, 77.6212, 77.6612],
  place_rank: 19, kind: 'place/suburb',
};

beforeAll(async () => {
  await request(app).post('/api/v1/auth/register').send({
    email: USER.email, name: USER.uid, phone: USER.phone, role: 'finder', firebase_token: token,
  });
});

afterAll(async () => {
  await prisma.users.deleteMany({ where: { email: USER.email } });
  await prisma.$disconnect();
});

const get = (q, withAuth = true) => {
  const req = request(app).get(`/api/v1/maps/geocode?q=${encodeURIComponent(q)}`);
  return withAuth ? req.set('Authorization', `Bearer ${token}`) : req;
};

beforeEach(() => jest.clearAllMocks());

describe('GET /maps/geocode', () => {
  test('it still answers lat and lon as strings, which is all the app reads', async () => {
    geocodeAddress.mockResolvedValue(SUBURB);

    // A query no other test uses, so the shared 5-minute cache cannot answer.
    const res = await get('Indiranagar lat lon shape, Bengaluru');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.data.lat).toBe('string');
    expect(typeof res.body.data.lon).toBe('string');
    expect(parseFloat(res.body.data.lat)).toBeCloseTo(12.9719, 4);
  });

  test('and now says what the address resolved TO, and how big that was', async () => {
    geocodeAddress.mockResolvedValue(SUBURB);

    const res = await get('Indiranagar precision, Bengaluru');

    expect(res.body.data.precision).toBe('locality');
    expect(res.body.data.uncertainty_m).toBe(2211);
    expect(res.body.data.source).toBe('nominatim');
    expect(res.body.data.display_name).toMatch(/Indiranagar/);
    expect(res.body.data.bbox).toHaveLength(4);
  });

  test('a repeat is served from the cache, not from the provider', async () => {
    geocodeAddress.mockResolvedValue(SUBURB);
    const q = `cache test ${Date.now()}`;

    const first = await get(q);
    const second = await get(q);

    expect(first.body.cached).toBeUndefined();
    expect(second.body.cached).toBe(true);
    // Nominatim asks for no more than one request a second; this is how a
    // screen that refreshes does not spend them.
    expect(geocodeAddress).toHaveBeenCalledTimes(1);
  });

  test('nothing resolving is reported honestly, not as a point', async () => {
    geocodeAddress.mockResolvedValue(null);

    const res = await get('Qqzzx Nowhere Street 99999');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.data).toBeUndefined();
  });

  test('a missing query is a 400, and never reaches the provider', async () => {
    const res = await get('   ');

    expect(res.status).toBe(400);
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  test('it needs a signed-in user, like every other /maps route', async () => {
    // These endpoints proxy a paid service and /style hands out the API key.
    const res = await get('Indiranagar, Bengaluru', false);

    expect(res.status).toBe(401);
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  test('a provider blowing up is a 500, not a fabricated location', async () => {
    geocodeAddress.mockRejectedValue(new Error('socket hang up'));

    const res = await get(`boom ${Date.now()}`);

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
