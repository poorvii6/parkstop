/**
 * What an address resolved TO, and how much to trust it.
 *
 * The fixtures below are the real shapes Nominatim returned for real Indian
 * addresses on 14 Nov 2026, recorded rather than invented, because the whole
 * design rests on what it actually does:
 *
 *   a full street address with a house number -> the STREET
 *   a named apartment complex                 -> a BUS STOP of the same name
 *   a flat number                             -> nothing
 *   a bill-style address with no commas       -> nothing, until the house
 *                                                number is dropped
 *
 *   npx jest tests/unit/geocoding.test.js
 */
const G = require('../../src/services/geocoding');

/** Live Nominatim hits, trimmed to the fields that matter. */
const HITS = {
  // "No 42, 3rd Cross Road, Indiranagar, Bengaluru 560038"
  streetFromHouseAddress: {
    lat: '12.9719', lon: '77.6412', class: 'highway', type: 'residential',
    place_rank: 26, boundingbox: ['12.9712', '12.9727', '77.6410', '77.6414'],
    display_name: '3rd Cross Road, Defence Colony, Indiranagar, Bengaluru',
  },
  // "Prestige Shantiniketan, Whitefield, Bengaluru" — a bus stop, rank 30
  busStop: {
    lat: '12.9951', lon: '77.7169', class: 'highway', type: 'bus_stop',
    place_rank: 30, boundingbox: ['12.9950', '12.9952', '77.7168', '77.7170'],
    display_name: 'Prestige Shantiniketan, Whitefield Road, Hoodi, Bengaluru',
  },
  house: {
    lat: '12.9719', lon: '77.6412', class: 'building', type: 'house',
    place_rank: 30, boundingbox: ['12.97185', '12.97195', '77.64115', '77.64125'],
    display_name: '42, 3rd Cross Road, Indiranagar, Bengaluru',
  },
  // "Indiranagar, Bengaluru" — a suburb 4.4 km across
  suburb: {
    lat: '12.9719', lon: '77.6412', class: 'place', type: 'suburb',
    place_rank: 19, boundingbox: ['12.9520', '12.9920', '77.6212', '77.6612'],
    display_name: 'Indiranagar, Bengaluru Central City Corporation, Bengaluru',
  },
  // "560038" — a postcode area 2.4 km across
  postcode: {
    lat: '12.9719', lon: '77.6412', class: 'boundary', type: 'postal_code',
    place_rank: 21, boundingbox: ['12.9612', '12.9827', '77.6305', '77.6519'],
    display_name: '560038, Indiranagar, Bengaluru',
  },
  // "Bengaluru" — the city, 34 km across
  city: {
    lat: '12.9716', lon: '77.5946', class: 'boundary', type: 'administrative',
    place_rank: 14, boundingbox: ['12.8166', '13.1366', '77.4376', '77.7516'],
    display_name: 'Bengaluru, Bengaluru Urban, Karnataka, India',
  },
};

describe('what kind of thing was found', () => {
  test('a house is a building', () => {
    expect(G.precisionFor(HITS.house)).toBe(G.PRECISION.BUILDING);
  });

  test('a bus stop is a POINT, not a building, though it shares rank 30', () => {
    // This is why place_rank alone cannot be trusted: a complex's bus stop is
    // as fine-grained as a house and is not the address on the document.
    expect(HITS.busStop.place_rank).toBe(30);
    expect(G.precisionFor(HITS.busStop)).toBe(G.PRECISION.POINT);
  });

  test('a road is a street', () => {
    expect(G.precisionFor(HITS.streetFromHouseAddress)).toBe(G.PRECISION.STREET);
  });

  test('a suburb and a postcode are localities', () => {
    expect(G.precisionFor(HITS.suburb)).toBe(G.PRECISION.LOCALITY);
    expect(G.precisionFor(HITS.postcode)).toBe(G.PRECISION.LOCALITY);
  });

  test('a city is a region', () => {
    expect(G.precisionFor(HITS.city)).toBe(G.PRECISION.REGION);
  });

  test('a hit with no rank is unknown, not assumed precise', () => {
    expect(G.precisionFor({ lat: '1', lon: '1' })).toBe(G.PRECISION.UNKNOWN);
    expect(G.precisionFor(null)).toBe(G.PRECISION.UNKNOWN);
  });

  test('only the fine ones are worth measuring a distance against', () => {
    expect(G.FINE_PRECISIONS).toEqual(
      expect.arrayContaining([G.PRECISION.BUILDING, G.PRECISION.POINT, G.PRECISION.STREET])
    );
    expect(G.FINE_PRECISIONS).not.toContain(G.PRECISION.LOCALITY);
    expect(G.FINE_PRECISIONS).not.toContain(G.PRECISION.REGION);
    expect(G.FINE_PRECISIONS).not.toContain(G.PRECISION.UNKNOWN);
  });
});

describe('how big the thing found was', () => {
  test('a suburb comes back as kilometres, which is the point', () => {
    const m = G.uncertaintyFor(HITS.suburb, G.PRECISION.LOCALITY);

    // 0.04 degrees of latitude is about 4.4 km, so the radius is about 2.2 km.
    expect(m).toBeGreaterThan(2000);
    expect(m).toBeLessThan(2500);
  });

  test('a city comes back as tens of kilometres', () => {
    expect(G.uncertaintyFor(HITS.city, G.PRECISION.REGION)).toBeGreaterThan(15000);
  });

  test('a house is tens of metres, floored so it is never absurdly small', () => {
    const m = G.uncertaintyFor(HITS.house, G.PRECISION.BUILDING);

    expect(m).toBe(G.PRECISION_FLOOR_M[G.PRECISION.BUILDING]);
  });

  test('a hit with no bounding box falls back to the floor for its kind', () => {
    expect(G.uncertaintyFor({ place_rank: 26 }, G.PRECISION.STREET))
      .toBe(G.PRECISION_FLOOR_M[G.PRECISION.STREET]);
  });
});

describe('dropping a leading house number', () => {
  const strip = G.dropLeadingHouseNumber;

  test.each([
    ['12 1st main road jayanagar', '1st main road jayanagar'],
    ['No 42, 3rd Cross Road', '3rd Cross Road'],
    ['#9/1 2nd cross hosur road', '2nd cross hosur road'],
    ['Flat 3B, Sai Residency', 'Sai Residency'],
    ['Plot 7, Sector 4', 'Sector 4'],
    ['H.No. 21 Gandhi Nagar', 'Gandhi Nagar'],
    ['21-A Brigade Road', 'Brigade Road'],
  ])('%s -> %s', (input, expected) => {
    expect(strip(input)).toBe(expected);
  });

  /**
   * Indian addresses are full of ordinals and they belong to the STREET.
   * Exact assertions, because a loose one hid a real bug here: an earlier
   * pattern turned "3rd Cross Road, Indiranagar" into "d Cross Road,
   * Indiranagar", which still contained "Cross Road, Indiranagar" and so
   * passed a `toMatch`. It geocodes to somewhere else entirely.
   */
  test.each([
    '3rd Cross Road, Indiranagar',
    '1st Main Road, Jayanagar',
    '2nd Stage, Indiranagar, Bengaluru',
    '4th Block, Jayanagar, Bengaluru',
  ])('%s is left exactly as it is', (input) => {
    expect(strip(input)).toBe(input);
  });

  /**
   * A road named after its WIDTH. The number is the name, and this is one of
   * the commonest address shapes in Bengaluru.
   *
   * Exact assertions, because the failure is not a missing result: measured
   * against the live API, "Feet Road, Indiranagar" resolves to 80 Feet Road in
   * Old Thippasandra, 0.8 km from the 100 Feet Road that was asked for, and
   * "Feet Road, Koramangala" resolves to 100 feet Road, 0.4 km from the 80
   * Feet Road that was asked for. A clean, plausible hit at the wrong address.
   */
  test.each([
    '100 Feet Road, Indiranagar',
    '80 Feet Road, Koramangala',
    '60 Feet Road, Jayanagar',
    '100 Ft Road, Indiranagar',
    '100 Feet Ring Road, Banashankari',
    '200 Feet Radial Road, Chennai',
    '90 Feet Road, Dharavi, Mumbai',
    '100 feet road indiranagar bangalore 560038',
    '80 ft road koramangala bangalore 560095',
    // "Futa" is feet in Hindi: Delhi and the NCR print the same convention.
    '100 Futa Road, Delhi',
    '60 Futa Road, Shahdara, Delhi',
    '100 foota road ghaziabad',
    '80 Phuta Road, Noida',
  ])('%s is left exactly as it is', (input) => {
    expect(strip(input)).toBe(input);
  });

  test('a house number in front of a Feet road is still stripped', () => {
    // The road keeps its number; the house loses its own.
    expect(strip('No 42, 100 Feet Road, Indiranagar')).toBe('100 Feet Road, Indiranagar');
    expect(strip('42 100 Feet Road Indiranagar')).toBe('100 Feet Road Indiranagar');
  });

  test('a word merely starting with "ft" is not read as a width', () => {
    expect(strip('12 Ftizgerald Lane, Bengaluru')).toBe('Ftizgerald Lane, Bengaluru');
  });

  test('a width is protected even behind a "No", unlike an ordinal', () => {
    // The ordinal guard is skipped when a prefix word is present, because
    // "No 42, 3rd Cross Road" has a real house number to strip. A width never
    // does: there is no house numbered "100 Feet".
    expect(strip('No 100 Feet Road, Indiranagar')).toBe('No 100 Feet Road, Indiranagar');
  });

  /**
   * The control, and the reason the width rule is narrow rather than a rule
   * about numbers before road words: "42 Main Road" genuinely is house 42.
   * Protecting Main, Cross or Block would make every house number on them
   * unstrippable.
   */
  test.each([
    ['42 Main Road, Bengaluru', 'Main Road, Bengaluru'],
    ['21 Church Street, Bengaluru', 'Church Street, Bengaluru'],
  ])('%s is a house number and is stripped', (input, expected) => {
    expect(strip(input)).toBe(expected);
  });

  test('a number with nothing useful after it is left alone', () => {
    // Searching for the remnant would be worse than searching for the whole.
    expect(strip('42')).toBe('42');
    expect(strip('No 42')).toBe('No 42');
  });

  test('an address with no house number is untouched', () => {
    expect(strip('Indiranagar, Bengaluru')).toBe('Indiranagar, Bengaluru');
    expect(strip('')).toBe('');
  });
});

/**
 * The provider chain, with the network mocked. The real calls are exercised by
 * hand against the live API (see the service's header); these pin the ORDER
 * and the fallbacks, which is what breaks silently.
 */
describe('the provider chain', () => {
  const asNominatim = (hit) => ({ ok: true, json: async () => (hit ? [hit] : []) });
  let calls;

  beforeEach(() => {
    calls = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => [] };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test('Nominatim is asked first, and its answer is used', async () => {
    global.fetch.mockImplementation(async (url) => {
      calls.push(String(url));
      return asNominatim(HITS.suburb);
    });

    const out = await G.geocodeAddress('Indiranagar, Bengaluru');

    expect(out.source).toBe('nominatim');
    expect(out.precision).toBe(G.PRECISION.LOCALITY);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/nominatim/);
    expect(calls[0]).toMatch(/countrycodes=in/);
  });

  test('Nominatim wins even when Ola is configured and would answer', async () => {
    // The order is a decision, not an accident: routes/maps.js records Ola's
    // free-text geocode dropping administrative names tens or hundreds of km
    // away ("Mysuru" ~30 km off, "Jammu and Kashmir" onto Ludhiana). With no
    // Ola key configured, asking Ola first would look identical to this, which
    // is how a reordering could go unnoticed.
    process.env.OLA_MAPS_API_KEY = 'test-key';
    try {
      global.fetch.mockImplementation(async (url) => {
        calls.push(String(url));
        if (String(url).includes('nominatim')) return asNominatim(HITS.suburb);
        return {
          ok: true,
          json: async () => ({
            geocodingResults: [{ geometry: { location: { lat: 28.6, lng: 77.2 } } }],
          }),
        };
      });

      const out = await G.geocodeAddress('Indiranagar, Bengaluru');

      expect(out.source).toBe('nominatim');
      expect(calls.some((c) => c.includes('olamaps'))).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      delete process.env.OLA_MAPS_API_KEY;
    }
  });

  test('a house number is dropped and Nominatim asked once more', async () => {
    // Measured: "#9/1 2nd cross hosur road madiwala bangalore 560068" returns
    // nothing as typed and Hosur Road once the number goes.
    global.fetch.mockImplementation(async (url) => {
      calls.push(String(url));
      return calls.length === 1 ? asNominatim(null) : asNominatim(HITS.streetFromHouseAddress);
    });

    const out = await G.geocodeAddress('#9/1 2nd cross hosur road madiwala bangalore 560068');

    expect(out.source).toBe('nominatim:no-house');
    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[1])).not.toMatch(/9%2F1|#9/);
    expect(decodeURIComponent(calls[1])).toMatch(/2nd cross hosur road/);
  });

  test('the retry is not made when there is no house number to drop', async () => {
    // One address, one request: Nominatim asks for a maximum of one call per
    // second, and a pointless second call is a pointless second second.
    await G.geocodeAddress('Indiranagar, Bengaluru');

    expect(calls.filter((c) => c.includes('nominatim'))).toHaveLength(1);
  });

  test('Ola is the last resort, and is honestly UNKNOWN precision', async () => {
    process.env.OLA_MAPS_API_KEY = 'test-key';
    global.fetch.mockImplementation(async (url) => {
      calls.push(String(url));
      if (String(url).includes('nominatim')) return asNominatim(null);
      return {
        ok: true,
        json: async () => ({
          geocodingResults: [{
            geometry: { location: { lat: 12.9, lng: 77.5 } },
            formatted_address: 'Somewhere, Bengaluru',
          }],
        }),
      };
    });

    const out = await G.geocodeAddress('No 42 somewhere nobody knows');

    expect(out.source).toBe('ola');
    // Ola returns a point and nothing about granularity, and routes/maps.js
    // records it landing tens of km away on administrative names. It can never
    // read as confirmation of an address.
    expect(out.precision).toBe(G.PRECISION.UNKNOWN);
    expect(out.uncertainty_m).toBe(G.PRECISION_FLOOR_M[G.PRECISION.UNKNOWN]);
    delete process.env.OLA_MAPS_API_KEY;
  });

  test('nothing resolving returns null, which is a usable answer', async () => {
    delete process.env.OLA_MAPS_API_KEY;

    expect(await G.geocodeAddress('Qqzzx Nowhere Street 99999')).toBeNull();
  });

  test('an empty query never reaches the network', async () => {
    expect(await G.geocodeAddress('   ')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a provider throwing does not take the request down', async () => {
    global.fetch.mockImplementation(async () => { throw new Error('socket hang up'); });

    expect(await G.geocodeAddress('Indiranagar, Bengaluru')).toBeNull();
  });
});
