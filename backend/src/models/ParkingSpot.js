const prisma = require('../config/prisma');
const logger = require('../utils/logger');

/** Booking states that are physically holding a bay right now. */
const OCCUPYING_STATUSES = ['reserved', 'active', 'checkout_pending'];

/**
 * How far a finder is willing to walk, in kilometres.
 *
 * One number, defined once. This used to be a default of 5 here, 5 again in the
 * controller, 10 from the map, 1000 from the place-search and 50 from an unused
 * hook — five answers to the same question, so the same spot appeared in one
 * view and not another.
 */
const SEARCH_RADIUS_KM = Number(process.env.SEARCH_RADIUS_KM) || 2;

/**
 * The furthest a *fallback* suggestion may be when nothing is in range.
 *
 * Distinct from the search radius on purpose: "there is nothing within 2 km,
 * here is something at 6 km" is a useful answer. "Here is something in Delhi"
 * is not, which is what an uncapped fallback produced.
 */
const FALLBACK_RADIUS_KM = Number(process.env.FALLBACK_RADIUS_KM) || 10;

/**
 * Replace a spot's stored availability with the counted truth.
 *
 * `available_slots` is a running counter, incremented and decremented by the
 * booking lifecycle — and a counter is only ever as correct as the last code
 * path that touched it. Cash and arrears checkouts used to close a booking
 * without giving the slot back, so live spots still carry drift from before
 * that was fixed: the map advertised "5 free" while the slot picker, which
 * counts real bookings, offered six.
 *
 * Counting bookings asks exactly the question the slot picker asks, so the two
 * can no longer disagree.
 *
 * @param {object} row  a spot row carrying `taken_now` from a counted join
 */
function withLiveAvailability(row) {
  const total = Number(row.total_slots) || 0;
  const taken = Number(row.taken_now) || 0;
  const free = Math.max(0, total - taken);

  return {
    ...row,
    available_slots: free,
    is_available: free > 0,
    // Kept alongside so a drifted counter is diagnosable rather than silently
    // papered over — if these disagree, something is still leaking.
    available_slots_stored: row.available_slots,
  };
}

/**
 * price_per_hour decides what every booking of this spot costs, and it had no
 * validation on update at all: `price_per_hour ? parseFloat(...) : undefined`
 * let -50 straight through, and a non-numeric string became NaN. On create the
 * controller checked `!price || price <= 0`, which passes 'abc' ('abc' <= 0 is
 * false) and then writes NaN.
 *
 * Validated in the model rather than the route so both doors are covered and a
 * future caller cannot miss it. statusCode travels with the error so the
 * controller can answer 400 instead of a blanket 500.
 */
function assertValidPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error('price_per_hour must be a positive number');
    err.statusCode = 400;
    throw err;
  }
  return Math.round(n * 100) / 100;
}

/**
 * The most bays one listing may claim.
 *
 * 50 is not a new number — it is what the create route has always enforced
 * (`body('total_slots').isInt({ min: 1, max: 50 })`). The update route had no
 * validators at all, so the same field was capped coming in one door and
 * unbounded through the other. Reusing the cap rather than inventing a
 * tighter one keeps a legitimate 40-bay listing editable.
 */
const MAX_SLOTS = Number(process.env.MAX_SPOT_SLOTS) || 50;

/**
 * A slot count: a whole number inside the cap.
 *
 * total_slots is not a cosmetic field. Three things read it:
 *
 *   - advertised availability, via withLiveAvailability above, which is
 *     `total_slots - counted bookings` and ignores the stored counter. So
 *     total_slots: 100 advertises 100 free bays on a driveway that holds one.
 *   - the slot picker a driver chooses from: SpotController.getSlotStatus
 *     generates one named slot per total_slots when slot_names is empty, so
 *     100 invents a hundred bays called "Slot A1" to "Slot J10".
 *   - the surge multiplier, via PricingService.demandMultiplierFor, which is
 *     `active / total_slots`. One active booking on total_slots: 1 is a ratio
 *     of 1.0, which is 2.0x — an owner doubling what the next driver pays.
 *
 * car_slots and bike_slots are live per-type counters that the booking flow
 * decrements and increments (Booking.js), and Booking.create refuses a car
 * when car_slots has run out. Raising them by hand lets through more bookings
 * than the bay can physically hold.
 */
function assertSlotCount(value, field, { min }) {
  // Deliberately not Number(value). Number('') and Number(null) are both 0,
  // and 0 IS a valid car_slots — so a blank form field or an explicit null
  // would pass this guard and silently zero a live counter instead of being
  // refused. Only a number, or a string that actually contains one, counts.
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

  if (!Number.isInteger(n) || n < min || n > MAX_SLOTS) {
    const err = new Error(
      `${field} must be a whole number between ${min} and ${MAX_SLOTS}`
    );
    err.statusCode = 400;
    throw err;
  }
  return n;
}

/**
 * A per-type counter cannot exceed the capacity it is counting against.
 *
 * Checked against the row as it will BE after the write, not against whichever
 * fields happen to be in this request: `{ total_slots: 1 }` alone on a spot
 * carrying car_slots: 5 would otherwise leave five car bays on a one-bay
 * driveway, which is the same lie by a different route.
 *
 * A number is required for `total` — a legacy row with total_slots NULL has no
 * capacity to compare against, so there is nothing to enforce.
 */
function assertTypeSlotsFitTotal({ car, bike, total }) {
  if (!Number.isFinite(total)) return;

  for (const [field, value] of [['car_slots', car], ['bike_slots', bike]]) {
    if (Number.isFinite(value) && value > total) {
      const err = new Error(`${field} (${value}) cannot exceed total_slots (${total})`);
      err.statusCode = 400;
      throw err;
    }
  }
}

/**
 * A coordinate, or a 400.
 *
 * The update path used to drop an unparseable coordinate on the floor:
 * `coordsOk` was false and the column was simply left alone, so a client
 * sending latitude: 'abc' got a 200 and believed the pin had moved. Present
 * means it must be a real coordinate; absent still means "leave it alone".
 */
function assertCoordinate(value, field, limit) {
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);

  if (!Number.isFinite(n) || Math.abs(n) > limit) {
    const err = new Error(`${field} must be a number between -${limit} and ${limit}`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

/** Whether a caller actually sent a field, as opposed to leaving it out. */
const isGiven = (v) => v !== undefined && v !== null && v !== '';

/** Metres between two coordinates. Flat-earth is ample at this scale. */
function metresBetween(aLat, aLng, bLat, bLng) {
  const dx = (bLng - aLng) * 111320 * Math.cos((aLat * Math.PI) / 180);
  const dy = (bLat - aLat) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * How far the pin may shift before it counts as a MOVE rather than the app
 * sending back what it already had.
 *
 * Decimal(10,8) round-trips and a client re-serialising a float will not agree
 * to the last digit, and refusing those would mean a verified owner could not
 * edit their own title. Ten metres is below anything meaningful for finding a
 * driveway and far above float noise.
 */
const PIN_MOVE_TOLERANCE_M = 10;

/**
 * What location_type to write, given who is asking.
 *
 * location_type sets the commission rate: CommissionService charges 15% for
 * 'rural' against a 20% default. Both create and update passed the caller's
 * own value into normalizeLocationType, so an owner calling PUT /spots/:id
 * directly could set 'rural' on their spot and cut ParkStop's fee on every
 * booking of it. It is our revenue, decided by the person who collects the
 * other side of it.
 *
 * Only an ADMIN may set it now. For anyone else an update leaves the column
 * alone (undefined) and a create defaults to urban. The attempt is logged
 * rather than refused, so an owner editing their spot does not get an error
 * about a field the app may be sending back unchanged — but a deliberate
 * attempt is still visible.
 */
function locationTypeFor(actorRole, requested, { isCreate }) {
  const { normalizeLocationType, LOCATION_TYPES } = require('../constants/spotTypes');
  const isAdmin = String(actorRole || '').toUpperCase() === 'ADMIN';

  if (isAdmin) {
    // An admin's value is still validated; it just is not ignored.
    return requested ? normalizeLocationType(requested) : (isCreate ? LOCATION_TYPES.URBAN : undefined);
  }

  // Deliberately not normalizeLocationType here: the value is being discarded,
  // and throwing on garbage we are not going to use would turn a harmless
  // stale field into a failed save.
  const asked = String(requested || '').toLowerCase().trim();
  if (asked && asked !== LOCATION_TYPES.URBAN) {
    logger.warn(
      `location_type '${asked}' requested by a non-admin (role ${actorRole || 'unknown'}) ` +
      `was ignored — it sets the commission rate and is admin-only`
    );
  }

  return isCreate ? LOCATION_TYPES.URBAN : undefined;
}

class ParkingSpot {

  /**
   * @param {string|null} [actorRole]  the caller's role. Anything other than
   *   'ADMIN' cannot choose location_type. Defaults to null, i.e. not an
   *   admin, so a caller that forgets gets the safe behaviour.
   */
  static async create(data, actorRole = null) {
    try {
      const {
        spotter_id,
        title,
        description,
        price_per_hour,
        latitude,
        longitude,
        address,
        location_type = 'urban',
        amenities = [],
        total_slots = 1,
        car_slots = 1,
        bike_slots = 0,
        images = []
      } = data;

      const normalizedLocation = locationTypeFor(actorRole, location_type, { isCreate: true });
      const validatedPrice = assertValidPrice(price_per_hour);

      const newTotal = assertSlotCount(total_slots, 'total_slots', { min: 1 });
      const newCar = assertSlotCount(car_slots, 'car_slots', { min: 0 });
      const newBike = assertSlotCount(bike_slots, 'bike_slots', { min: 0 });
      assertTypeSlotsFitTotal({ car: newCar, bike: newBike, total: newTotal });

      // A spot with no usable pin can never be found — the finder filters on a
      // bounding box — so a listing is not created with one. parseFloat('abc')
      // wrote NaN and Prisma turned that into a 500.
      const newLat = assertCoordinate(latitude, 'latitude', 90);
      const newLng = assertCoordinate(longitude, 'longitude', 180);

      const spot = await prisma.parking_spots.create({
        data: {
          spotter_id: parseInt(spotter_id),
          title,
          description,
          price_per_hour: validatedPrice,
          latitude: newLat,
          longitude: newLng,
          address,
          location_type: normalizedLocation,
          amenities: Array.isArray(amenities) ? amenities : [],
          total_slots: newTotal,
          available_slots: newTotal,
          car_slots: newCar,
          bike_slots: newBike,
          images: Array.isArray(images) ? images : [],
          is_available: true,
          is_active: true
        }
      });

      return spot;
    } catch (error) {
      logger.error('Error creating parking spot:', error);
      throw error;
    }
  }

  static async findById(id) {
    return prisma.parking_spots.findFirst({
      where: {
        id: parseInt(id),
        is_active: true
      },
      include: {
        users: {
          select: {
            full_name: true,
            phone: true
          }
        }
      }
    });
  }

  static async findNearby(lat, lng, radius = SEARCH_RADIUS_KM) {
    // Uses the lat/lng index for bounding box pre-filter, then Haversine for precision
    const latDelta = radius / 111.0;
    const lngDelta = radius / (111.0 * Math.cos(lat * Math.PI / 180));

    const rows = await prisma.$queryRaw`
      SELECT parking_spots.*,
      COALESCE(b.taken, 0)::int AS taken_now,
      (
        6371 * acos(
          cos(radians(${lat})) * cos(radians(latitude)) *
          cos(radians(longitude) - radians(${lng})) +
          sin(radians(${lat})) * sin(radians(latitude))
        )
      ) AS distance
      FROM parking_spots
      JOIN users u ON parking_spots.spotter_id = u.id
      LEFT JOIN (
        SELECT spot_id, COUNT(*)::int AS taken
        FROM bookings
        WHERE status IN ('reserved', 'active', 'checkout_pending')
        GROUP BY spot_id
      ) b ON b.spot_id = parking_spots.id
      WHERE is_active = true
        AND u.balance >= -500
        AND u.verification_status = 'approved'
        AND latitude BETWEEN ${lat - latDelta} AND ${lat + latDelta}
        AND longitude BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
        AND (
          6371 * acos(
            cos(radians(${lat})) * cos(radians(latitude)) *
            cos(radians(longitude) - radians(${lng})) +
            sin(radians(${lat})) * sin(radians(latitude))
          )
        ) < ${radius}
      ORDER BY distance
      LIMIT 50
    `;

    // `is_available` is deliberately no longer in the WHERE clause: it is
    // derived from the same drifting counter, so a spot whose count had leaked
    // to zero switched itself off and stayed invisible however empty it
    // actually was. Filter on the counted truth instead.
    return rows
      .map((r) => withLiveAvailability(r))
      .filter((r) => r.available_slots > 0);
  }

  /**
   * Nearest spots when the search radius came back empty.
   *
   * TWO BUGS FIXED HERE.
   *
   * 1. There was no distance limit at all. "LIMIT 5 ORDER BY distance" over the
   *    whole table means the five nearest spots *in existence* — so a finder in
   *    Bengaluru with nothing in range was shown spots hundreds of kilometres
   *    away under the message "Showing the nearest alternatives". With listings
   *    concentrated in one area, that is what early users outside it would see.
   *    Suggestions are now capped at FALLBACK_RADIUS_KM; beyond that the honest
   *    answer is an empty list.
   *
   * 2. It filtered on `is_available` and `available_slots` — the drifting
   *    counters already removed from findNearby for exactly this reason. A spot
   *    whose counter had leaked to zero was invisible here however empty it
   *    really was, and one that had leaked the other way was offered when it
   *    was full. It now counts live bookings, like every other read path.
   */
  static async findAbsoluteNearest(lat, lng, limit = 5, maxKm = FALLBACK_RADIUS_KM) {
    const rows = await prisma.$queryRaw`
      SELECT parking_spots.*,
      COALESCE(b.taken, 0)::int AS taken_now,
      (
        6371 *
        acos(
          cos(radians(${lat})) *
          cos(radians(latitude)) *
          cos(radians(longitude) - radians(${lng})) +
          sin(radians(${lat})) *
          sin(radians(latitude))
        )
      ) AS distance
      FROM parking_spots
      JOIN users u ON parking_spots.spotter_id = u.id
      LEFT JOIN (
        SELECT spot_id, COUNT(*)::int AS taken
        FROM bookings
        WHERE status IN ('reserved', 'active', 'checkout_pending')
        GROUP BY spot_id
      ) b ON b.spot_id = parking_spots.id
      WHERE is_active = true
        AND u.balance >= -500
        AND u.verification_status = 'approved'
        AND (
          6371 *
          acos(
            cos(radians(${lat})) *
            cos(radians(latitude)) *
            cos(radians(longitude) - radians(${lng})) +
            sin(radians(${lat})) *
            sin(radians(latitude))
          )
        ) < ${maxKm}
      ORDER BY distance ASC
      LIMIT ${limit}
    `;

    return rows
      .map((r) => withLiveAvailability(r))
      .filter((r) => r.available_slots > 0);
  }

  static async findAvailable() {
    // Same reasoning as findNearby: filtering on the stored counter hid spots
    // that were genuinely free but had drifted to zero. Fetch the active ones
    // and let the counted occupancy decide.
    const spots = await prisma.parking_spots.findMany({
      where: {
        is_active: true,
        users: {
          balance: { gte: -500 },
          // Only verified owners' spots are shown to drivers.
          verification_status: 'approved'
        }
      },
      include: {
        users: {
          select: {
            full_name: true
          }
        }
      },
      orderBy: {
        created_at: 'desc'
      }
    });

    if (spots.length === 0) return spots;

    // One grouped query for the whole page rather than a count per spot.
    const counts = await prisma.bookings.groupBy({
      by: ['spot_id'],
      where: { spot_id: { in: spots.map((s) => s.id) }, status: { in: OCCUPYING_STATUSES } },
      _count: { _all: true },
    });
    const takenBySpot = new Map(counts.map((c) => [c.spot_id, c._count._all]));

    return spots
      .map((s) => withLiveAvailability({ ...s, taken_now: takenBySpot.get(s.id) || 0 }))
      .filter((s) => s.available_slots > 0);
  }

  /**
   * @param {string|null} [actorRole]  see create. location_type is admin-only;
   *   for anyone else the column is left as it is.
   */
  static async update(spotId, userId, updates, actorRole = null) {
    const {
      title,
      description,
      price_per_hour,
      address,
      location_type,
      amenities,
      car_slots,
      bike_slots,
      total_slots,
      images,
      latitude,
      longitude
    } = updates;
    // Moving the pin.
    //
    // A lone coordinate is refused rather than ignored. The old condition
    // needed BOTH to be usable, so `{ latitude: 12.98 }` on its own wrote
    // nothing and answered 200 — the owner is told the pin moved, the pin did
    // not move, and the spot keeps sending drivers to the old place. Half a
    // coordinate is not a location, so say so.
    const movingPin = isGiven(latitude) || isGiven(longitude);
    if (movingPin && !(isGiven(latitude) && isGiven(longitude))) {
      const err = new Error('latitude and longitude must be sent together');
      err.statusCode = 400;
      throw err;
    }

    // Both present, so both are validated here: an unparseable coordinate used
    // to leave `coordsOk` false and the column untouched, which is the same
    // silent success by another name.
    const lat = movingPin ? assertCoordinate(latitude, 'latitude', 90) : undefined;
    const lng = movingPin ? assertCoordinate(longitude, 'longitude', 180) : undefined;

    const normalizedLocation = locationTypeFor(actorRole, location_type, { isCreate: false });

    // Absent means "leave it alone"; present means it must be a real price.
    // A present-but-rubbish value is refused rather than quietly ignored, so a
    // client sending -50 is told, instead of believing it worked.
    const validatedPrice = price_per_hour === undefined || price_per_hour === null || price_per_hour === ''
      ? undefined
      : assertValidPrice(price_per_hour);

    const isAdmin = String(actorRole || '').toUpperCase() === 'ADMIN';

    const nextTotal = total_slots !== undefined ? assertSlotCount(total_slots, 'total_slots', { min: 1 }) : undefined;
    const nextCar = car_slots !== undefined ? assertSlotCount(car_slots, 'car_slots', { min: 0 }) : undefined;
    const nextBike = bike_slots !== undefined ? assertSlotCount(bike_slots, 'bike_slots', { min: 0 }) : undefined;
    const touchesCapacity = nextTotal !== undefined || nextCar !== undefined || nextBike !== undefined;

    // Everything below needs the spot as it stands.
    const needsCurrent = touchesCapacity || movingPin;
    const current = needsCurrent
      ? await prisma.parking_spots.findUnique({
          where: { id: parseInt(spotId) },
          select: {
            latitude: true, longitude: true,
            total_slots: true, car_slots: true, bike_slots: true,
            users: { select: { verification_status: true } },
          },
        })
      : null;

    // The three capacity fields must agree once this write lands, so each is
    // compared against the value the row will END UP with — which is how
    // raising total_slots and car_slots together works, and how raising
    // car_slots alone past the stored total is caught.
    //
    // Only when the request touches capacity. A row that is already
    // inconsistent (nothing stopped car_slots > total_slots before this
    // change) must not become uneditable: an owner renaming such a spot would
    // be refused over a state they cannot see and did not cause.
    if (touchesCapacity) {
      const stored = (v) => (v === null || v === undefined ? undefined : Number(v));
      assertTypeSlotsFitTotal({
        car: nextCar ?? stored(current?.car_slots),
        bike: nextBike ?? stored(current?.bike_slots),
        total: nextTotal ?? stored(current?.total_slots),
      });
    }

    // Capacity may not drop below the cars already in the bay.
    //
    // withLiveAvailability clamps `total - taken` at zero, so an owner setting
    // total_slots: 1 with three cars parked makes the spot read as full and
    // vanish from the finder while three drivers are mid-booking — and the
    // surge ratio goes over 1.0, which is 2.0x for whoever books next.
    if (nextTotal !== undefined) {
      const taken = await prisma.bookings.count({
        where: { spot_id: parseInt(spotId), status: { in: OCCUPYING_STATUSES } },
      });
      if (nextTotal < taken) {
        const err = new Error(
          `total_slots cannot be set to ${nextTotal}: ${taken} booking(s) are using this spot right now`
        );
        err.statusCode = 400;
        throw err;
      }
    }

    // Moving the pin of a live spot.
    //
    // Owner verification approves a PERSON, not a place, so nothing re-checks
    // the location afterwards: an owner verified at one address could move the
    // pin across the city, or onto a driveway they have no claim to, and the
    // listing stays approved and bookable the whole time. Once an owner is
    // approved their spots are visible to drivers — findNearby filters on
    // `u.verification_status = 'approved'` — so from that point the pin is
    // fixed, and a different place is a different listing.
    //
    // The alternative was to allow the move and reset verification instead.
    // That is not implementable here: verification_status lives on USERS, not
    // on parking_spots, so resetting it would hide every other spot the owner
    // lists and push them back into the KYC queue over a 20-metre correction.
    // Doing it properly needs a per-spot column and an admin review queue,
    // which is a migration and a screen, not a guard.
    let allowCoords = movingPin;
    if (movingPin && current) {
      const hasStoredPin = current.latitude !== null && current.longitude !== null;
      const moved = hasStoredPin
        ? metresBetween(Number(current.latitude), Number(current.longitude), lat, lng)
        : Infinity;
      const approved = current.users?.verification_status === 'approved';

      if (hasStoredPin && moved <= PIN_MOVE_TOLERANCE_M) {
        // Within tolerance nothing actually moved: the app sends the
        // coordinates back with every save, and that is not a relocation.
        // Leave the column alone rather than rewriting it with noise.
        allowCoords = false;
      } else if (!hasStoredPin) {
        // Nothing to move FROM. A spot with no coordinates can never appear in
        // the finder at all, so setting them for the first time is a fix, not
        // a move — refusing it would strand the listing permanently.
        logger.info(`Spot ${spotId} had no pin; coordinates set for the first time`);
      } else if (isAdmin) {
        logger.info(`Spot ${spotId} pin moved ${Math.round(moved)}m by an admin`);
      } else if (approved) {
        const err = new Error(
          'This spot cannot be moved now that your account is verified, because drivers ' +
          'are already navigating to it. List the new location as a new spot, or contact ' +
          'ParkStop support to move this one.'
        );
        err.statusCode = 400;
        throw err;
      } else {
        logger.info(`Spot ${spotId} pin moved ${Math.round(moved)}m by an unverified owner — allowed, not live yet`);
      }
    }

    return prisma.parking_spots.update({
      where: { id: parseInt(spotId) },
      data: {
        title,
        description,
        price_per_hour: validatedPrice,
        address,
        location_type: normalizedLocation,
        amenities: Array.isArray(amenities) ? amenities : undefined,
        car_slots: nextCar,
        bike_slots: nextBike,
        total_slots: nextTotal,
        images: Array.isArray(images) ? images : undefined,
        latitude: allowCoords ? lat : undefined,
        longitude: allowCoords ? lng : undefined,
        updated_at: new Date()
      }
    });
  }

  static async delete(id, userId) {
    await prisma.parking_spots.update({
      where: { id: parseInt(id) },
      data: {
        is_active: false,
        deleted_at: new Date(),
        updated_at: new Date()
      }
    });
  }

  static async decreaseSlot(spotId, client = prisma) {
    const spot = await client.parking_spots.update({
      where: { id: parseInt(spotId) },
      data: {
        available_slots: { decrement: 1 },
        updated_at: new Date()
      }
    });

    if (spot.available_slots <= 0) {
      await client.parking_spots.update({
        where: { id: parseInt(spotId) },
        data: { is_available: false }
      });
    }

    return spot;
  }

  static async increaseSlot(spotId, client = prisma) {
    const spot = await client.parking_spots.findUnique({ where: { id: parseInt(spotId) } });
    if (!spot) return;

    await client.parking_spots.update({
      where: { id: parseInt(spotId) },
      data: {
        available_slots: { 
          set: Math.min(spot.available_slots + 1, spot.total_slots) 
        },
        is_available: true,
        updated_at: new Date()
      }
    });
  }

  static async getSpotterDashboard(userId) {
    const activeSpotsCount = await prisma.parking_spots.count({
      where: {
        spotter_id: parseInt(userId),
        is_active: true
      }
    });

    // ── Earned vs still owed ────────────────────────────────────────
    //
    // This used to sum EVERY completed booking regardless of whether the money
    // was ever collected, and the tile calls it "Total earned / All-time
    // income". A booking the driver never paid for counted the same as one paid
    // in full — so the headline figure could exceed what the host will actually
    // receive. Income you might never see is not income.
    //
    // SETTLED means the host is genuinely owed nothing further:
    //   paid           — collected, online or cash.
    //   unpaid_arrears — the driver left without paying, but the host was still
    //                    credited in full and the debt moved onto the DRIVER
    //                    (see BookingController.checkoutUnpaid). Earned.
    // Anything else (pending, failed) is money in flight, reported separately
    // rather than folded into the total.
    const SETTLED_STATUSES = ['paid', 'unpaid_arrears'];
    const completedForSpotter = {
      parking_spots: { spotter_id: parseInt(userId) },
      status: 'completed',
    };

    // Settlements are earnings too, and they are NOT in the bookings sum.
    //
    // When a driver cancels or never turns up, the owner is credited their
    // share of what is withheld -- real money, in their wallet, recorded as a
    // payouts row. But the booking behind it is 'cancelled' or 'expired', so
    // a total built from completed bookings alone leaves it out. The owner
    // then sees their wallet hold more than they have supposedly "earned",
    // with nothing on screen to explain the gap. Counted here so the two
    // figures describe the same money.
    const { SETTLEMENT_PURPOSES } = require('../constants/payoutPurposes');
    const settledForSpotter = {
      user_id: parseInt(userId),
      purpose: { in: SETTLEMENT_PURPOSES },
    };

    const [earnings, pendingEarnings, settlementEarnings] = await Promise.all([
      prisma.bookings.aggregate({
        where: { ...completedForSpotter, payment_status: { in: SETTLED_STATUSES } },
        _sum: { spotter_earning: true },
      }),
      prisma.bookings.aggregate({
        where: { ...completedForSpotter, NOT: { payment_status: { in: SETTLED_STATUSES } } },
        _sum: { spotter_earning: true },
      }),
      prisma.payouts.aggregate({
        where: settledForSpotter,
        _sum: { amount: true },
      }),
    ]);

    // ── 7-day earnings trend ────────────────────────────────────────
    //
    // Two things this gets right that the previous version did not.
    //
    // 1. It buckets by WHEN THE MONEY WAS EARNED (actual_end_time), not when
    //    the booking was created. A booking made on Monday and completed on
    //    Friday belongs to Friday's earnings; bucketing it on Monday put income
    //    on a day the host earned nothing, and the chart is labelled as a
    //    weekly trend of earnings.
    //
    // 2. It buckets in IST. Day boundaries were computed from server time,
    //    which is UTC on Railway, while the chart's day labels are generated on
    //    the phone in IST. Anything completed between midnight and 05:30 IST
    //    fell into the previous day's bar, so the labels and the data disagreed
    //    for exactly the late-night bookings a parking host cares about.
    const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
    /** Midnight IST for a given instant, expressed as a UTC-epoch day marker. */
    const istDayStart = (d) => {
      const shifted = new Date(new Date(d).getTime() + IST_OFFSET_MS);
      return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
    };

    const DAY_MS = 24 * 60 * 60 * 1000;
    const todayIstDay = istDayStart(new Date());
    // The real UTC instant that the 7-day IST window opens at.
    const windowStart = new Date(todayIstDay - 6 * DAY_MS - IST_OFFSET_MS);

    const recentCompletedBookings = await prisma.bookings.findMany({
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        },
        status: 'completed',
        // Completion time where we have it; fall back to created_at for older
        // rows written before actual_end_time was recorded, so their earnings
        // do not silently vanish from the chart.
        OR: [
          { actual_end_time: { gte: windowStart } },
          { AND: [{ actual_end_time: null }, { created_at: { gte: windowStart } }] },
        ],
      },
      select: {
        created_at: true,
        actual_end_time: true,
        spotter_earning: true
      }
    });

    // The same settlements, on the same chart. Leaving them out of the trend
    // while counting them in the total above would make the bars and the
    // headline figure disagree, which is worse than either being wrong alone.
    // Bucketed by when the credit was written, which is when it was earned.
    const recentSettlements = await prisma.payouts.findMany({
      where: { ...settledForSpotter, created_at: { gte: windowStart } },
      select: { created_at: true, amount: true },
    });

    const trend = Array(7).fill(0);
    const addToTrend = (when, amount) => {
      if (!when) return;
      const dayDiff = Math.round((todayIstDay - istDayStart(when)) / DAY_MS);
      if (dayDiff >= 0 && dayDiff < 7) trend[6 - dayDiff] += Number(amount || 0);
    };
    recentCompletedBookings.forEach((item) => {
      addToTrend(item.actual_end_time || item.created_at, item.spotter_earning);
    });
    recentSettlements.forEach((p) => addToTrend(p.created_at, p.amount));

    // Calculate Current Surge Factor (Average for their active spots)
    const activeSpots = await prisma.parking_spots.findMany({
      where: { spotter_id: parseInt(userId), is_active: true },
      select: {
        id: true,
        title: true,
        total_slots: true,
        available_slots: true,
        car_slots: true,
        bike_slots: true,
        // Extra fields so an owner can see and edit their spot (website).
        price_per_hour: true,
        address: true,
        description: true,
        images: true,
        latitude: true,
        longitude: true,
      }
    });

    // Surge for every spot from ONE query, not one query per spot.
    //
    // This was a loop calling calculateDemandMultiplier per spot — each of
    // which runs its own COUNT, and awaited sequentially. A host with ten
    // spots paid ten round trips, and this dashboard refetches on every
    // booking event, every push, every reconnect and every screen focus.
    //
    // groupBy returns only spots that HAVE active bookings, so a missing entry
    // means zero — which is why the lookup below defaults to 0 rather than
    // assuming every spot appears.
    const PricingService = require('../services/PricingService');
    const activeSpotIds = activeSpots.map((s) => s.id);
    const activeCounts = activeSpotIds.length
      ? await prisma.bookings.groupBy({
          by: ['spot_id'],
          where: { spot_id: { in: activeSpotIds }, status: 'active' },
          _count: { _all: true },
        })
      : [];
    const activeBySpot = new Map(activeCounts.map((r) => [r.spot_id, r._count?._all || 0]));

    const totalSurge = activeSpots.reduce(
      (acc, spot) =>
        acc + PricingService.demandMultiplierFor(activeBySpot.get(spot.id) || 0, spot.total_slots),
      0
    );
    const avgSurge = activeSpots.length > 0 ? (totalSurge / activeSpots.length) : 1.0;

    const recentTraffic = await prisma.bookings.findMany({
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        }
      },
      orderBy: { updated_at: 'desc' },
      take: 5,
      select: {
        id: true,
        status: true,
        total_price: true,
        vehicle_type: true,
        vehicle_subtype: true,
        slot_name: true,
        parking_spots: {
          select: {
            title: true
          }
        }
      }
    });

    // 1. Occupancy Rate Calculation
    const totalSlotsSum = activeSpots.reduce((acc, s) => acc + (s.total_slots || 0), 0);
    const availableSlotsSum = activeSpots.reduce((acc, s) => acc + (s.available_slots || 0), 0);
    const occupiedSlotsSum = Math.max(0, totalSlotsSum - availableSlotsSum);
    const occupancyRate = totalSlotsSum > 0 ? Number(((occupiedSlotsSum / totalSlotsSum) * 100).toFixed(0)) : 0;

    // 2. Average Booking Duration Calculation (completed bookings)
    const avgDurationAgg = await prisma.bookings.aggregate({
      where: {
        parking_spots: {
          spotter_id: parseInt(userId)
        },
        status: 'completed'
      },
      _avg: {
        hours: true
      }
    });
    const avgDuration = avgDurationAgg._avg.hours ? Number(Number(avgDurationAgg._avg.hours).toFixed(1)) : 0.0;

    // 3. Global Online/Offline Status
    const allSpots = await prisma.parking_spots.findMany({
      where: { spotter_id: parseInt(userId), deleted_at: null },
      select: { is_active: true }
    });
    const globalOnline = allSpots.length > 0 && allSpots.some(s => s.is_active);

    // 4. Payouts History
    const payoutHistory = await prisma.payouts.findMany({
      where: { user_id: parseInt(userId) },
      orderBy: { created_at: 'desc' },
      take: 5,
      select: {
        id: true,
        amount: true,
        status: true,
        created_at: true,
        mode: true
      }
    });

    return {
      active_spots: activeSpotsCount,
      earnings: Number(earnings._sum.spotter_earning || 0)
        + Number(settlementEarnings._sum.amount || 0),
      // Completed, but the money has not been collected yet. Surfaced so the
      // dashboard can say so plainly instead of quietly counting it as income.
      pending_earnings: Number(pendingEarnings._sum.spotter_earning || 0),
      revenue_trend: trend,
      surge_factor: Number(avgSurge.toFixed(1)),
      inventory: activeSpots,
      recent_traffic: recentTraffic,
      occupancy_rate: occupancyRate,
      avg_duration: avgDuration,
      global_online: globalOnline,
      payout_history: payoutHistory
    };
  }

  static async isOwner(spotId, userId) {
    const spot = await prisma.parking_spots.findUnique({
      where: { id: parseInt(spotId) },
      select: { spotter_id: true }
    });
    return spot?.spotter_id === parseInt(userId);
  }
}

// Exported as properties rather than a separate object so every existing
// `require('../models/ParkingSpot')` keeps working unchanged.
ParkingSpot.SEARCH_RADIUS_KM = SEARCH_RADIUS_KM;
ParkingSpot.FALLBACK_RADIUS_KM = FALLBACK_RADIUS_KM;

module.exports = ParkingSpot;