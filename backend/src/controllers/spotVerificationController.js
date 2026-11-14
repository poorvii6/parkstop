/**
 * Per-spot property verification — the record, the clock and the queue.
 *
 * Owner verification (ownerVerificationController) approves a PERSON: Aadhaar,
 * PAN, selfie, bank. It says nothing about a PLACE, and the property document
 * it collects is never compared to any spot — so an owner could upload their
 * own electricity bill and list a driveway three kilometres away.
 *
 * Here each SPOT is verified in its own right: a document for that address, in
 * that person's name, read by an admin (desk) and confirmed against the local
 * record by our team (field). Both stages must pass before a spot is visible
 * or bookable. Stage 1 is this file: submitting, measuring the wait, and
 * showing the owner and the admins where every spot stands. The desk checks
 * land in stage 2 and the field result in stage 3.
 *
 * WHAT 'approved' WILL MEAN, so nobody reads it as more: a person whose
 * identity we checked submitted a document in their name for an address near
 * this pin, an admin read it, and our team found the record at the regional
 * office. A desk review cannot prove a document is genuine — a good forgery
 * passes it, which is exactly why the field check exists.
 */
const cloudinary = require('cloudinary').v2;

const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const NotificationService = require('../services/notificationService');
const Policy = require('../services/SpotVerificationPolicy');
const { geocodeAddress } = require('../services/geocoding');
const { compareNames, explainNameMatch } = require('../services/nameMatch');
const { metresBetween } = require('../utils/geo');
const {
  SPOT_VERIFICATION_STATUS: S,
  SPOT_DOC_TYPES,
  RELATIONSHIPS,
  TENANT_DOC_TYPES,
  AWAITING_REVIEW_STATUSES,
} = require('../constants/spotVerification');

const ok = (res, data, message = '') => res.json({ success: true, message, data });
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

/** The owner may not edit a submission while someone is looking at it. */
function editBlocked(record) {
  if (AWAITING_REVIEW_STATUSES.includes(record.status)) {
    return 'This spot is being checked. You can make changes if it is sent back to you.';
  }
  if (record.status === S.APPROVED) {
    return 'This spot is verified. Contact support to change its address or document.';
  }
  return null;
}

async function getOrCreateRecord(spotId) {
  const existing = await prisma.spot_verifications.findUnique({ where: { spot_id: spotId } });
  if (existing) return existing;
  return prisma.spot_verifications.create({
    data: { spot_id: spotId, status: S.NOT_STARTED },
  });
}

/**
 * Write the record, then cache what a driver may see onto the spot.
 *
 * The cached column is NOT a copy of the record's status —
 * Policy.driverVisibleStatusFor decides, so a spot that was live before this
 * feature existed does not drop out of the finder the moment its owner starts
 * the process. Both writes in one transaction: a status the finder disagrees
 * with is the one state this must never be left in.
 */
async function saveAndSync(record, data, logEntry = null) {
  const review_log = logEntry
    ? [...(Array.isArray(record.review_log) ? record.review_log : []), { at: new Date().toISOString(), ...logEntry }]
    : undefined;

  const [updated] = await prisma.$transaction(async (tx) => {
    const row = await tx.spot_verifications.update({
      where: { id: record.id },
      data: { ...data, ...(review_log ? { review_log } : {}) },
    });
    await tx.parking_spots.update({
      where: { id: row.spot_id },
      data: { spot_verification_status: Policy.driverVisibleStatusFor(row) },
    });
    return [row];
  });

  return updated;
}

/** The spot, if this caller is allowed to see its verification. */
async function spotFor(req, res) {
  const spotId = parseInt(req.params.spotId, 10);
  if (!Number.isInteger(spotId)) {
    fail(res, 400, 'Spot id must be a number.');
    return null;
  }

  const spot = await prisma.parking_spots.findUnique({
    where: { id: spotId },
    select: {
      id: true, spotter_id: true, title: true, address: true,
      latitude: true, longitude: true, spot_verification_status: true,
    },
  });
  if (!spot) {
    fail(res, 404, 'Spot not found.');
    return null;
  }

  const isAdmin = String(req.user.role || '').toUpperCase() === 'ADMIN';
  if (!isAdmin && spot.spotter_id !== req.user.id) {
    // Same answer as updateSpot gives: a spot that is not yours is not yours.
    fail(res, 403, 'You can only manage your own spots.');
    return null;
  }

  return spot;
}

/**
 * What the OWNER sees.
 *
 * Policy.ownerSummary, with the spot's freshly written cached status — the
 * dashboard's inventory list calls the same function, so the two screens
 * cannot tell an owner different things about the same spot.
 */
function summarizeForOwner(spot, record, now = new Date()) {
  return Policy.ownerSummary(
    { ...spot, spot_verification_status: Policy.driverVisibleStatusFor(record) },
    record,
    now
  );
}

// ───────────────────────────── owner ─────────────────────────────

/** Upload (or replace) the document for one spot. */
async function uploadDocument(req, res) {
  try {
    const spot = await spotFor(req, res);
    if (!spot) return undefined;

    if (!req.file?.buffer) return fail(res, 400, 'Please add a photo of your document.');

    const docType = String(req.body?.doc_type || '');
    const address = String(req.body?.address || '').trim();
    const relationship = String(req.body?.relationship || RELATIONSHIPS.OWNER).toLowerCase();

    if (!SPOT_DOC_TYPES.includes(docType)) return fail(res, 400, 'Please choose the document type.');
    if (!Object.values(RELATIONSHIPS).includes(relationship)) {
      return fail(res, 400, 'Tell us whether you own this place or rent it.');
    }
    // The spot's own `address` column is no substitute: every active spot in
    // production has one shorter than ten characters.
    if (address.length < 10) return fail(res, 400, 'Please enter the full address printed on the document.');

    const record = await getOrCreateRecord(spot.id);
    const blocked = editBlocked(record);
    if (blocked) return fail(res, 409, blocked);

    if (!process.env.CLOUDINARY_CLOUD_NAME) return fail(res, 503, 'File uploads are not configured on the server.');

    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        // Private, like the per-person documents: admins get a signed URL and
        // nobody else can read it.
        { folder: 'parkstop/spot-docs', type: 'authenticated', resource_type: 'image' },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    if (record.doc_public_id && record.doc_public_id !== uploaded.public_id) {
      cloudinary.uploader.destroy(record.doc_public_id, { type: 'authenticated' }).catch(() => {});
    }

    const updated = await saveAndSync(
      record,
      {
        status: S.IN_PROGRESS,
        doc_type: docType,
        doc_public_id: uploaded.public_id,
        claimed_address: address.slice(0, 300),
        relationship,
        // A new document invalidates the old verdict, so the desk fields go
        // back to empty rather than describing a document nobody has read.
        name_on_document: null,
        name_match: null,
        address_match_metres: null,
        geocoded_lat: null,
        geocoded_lng: null,
        geocode_source: null,
        desk_reviewed_by: null,
        desk_reviewed_at: null,
        rejection_reason: null,
      },
      { stage: 'owner', action: 'document_uploaded', by: req.user.id, note: docType }
    );

    return ok(res, summarizeForOwner(spot, updated), 'Document saved');
  } catch (err) {
    logger.error('spotVerification.uploadDocument error:', err);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}

/**
 * The landlord's no-objection letter, for a spot that is rented.
 *
 * A separate upload because it is a separate document about a different
 * person: the main document proves an address, this one says the person who
 * owns that address agrees to it being let as parking. The landlord's name is
 * taken with it because an NOC with no name on it says nothing.
 *
 * Be clear about what it is worth: nothing here verifies the landlord. We hold
 * a letter and a name, neither checked against any record — the field check is
 * what tests whether the property record matches, and even that does not
 * confirm the signature on an NOC. It is the weakest evidence in the whole
 * flow, and it is required rather than trusted.
 */
async function uploadLandlordNoc(req, res) {
  try {
    const spot = await spotFor(req, res);
    if (!spot) return undefined;

    if (!req.file?.buffer) return fail(res, 400, 'Please add a photo of the letter from your landlord.');

    const landlordName = String(req.body?.landlord_name || '').trim();
    if (landlordName.length < 2) return fail(res, 400, 'Enter the name of the landlord who signed the letter.');

    const record = await getOrCreateRecord(spot.id);
    const blocked = editBlocked(record);
    if (blocked) return fail(res, 409, blocked);

    if (!process.env.CLOUDINARY_CLOUD_NAME) return fail(res, 503, 'File uploads are not configured on the server.');

    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'parkstop/spot-docs', type: 'authenticated', resource_type: 'image' },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    if (record.landlord_noc_public_id && record.landlord_noc_public_id !== uploaded.public_id) {
      cloudinary.uploader.destroy(record.landlord_noc_public_id, { type: 'authenticated' }).catch(() => {});
    }

    const updated = await saveAndSync(
      record,
      {
        status: record.status === S.NOT_STARTED ? S.IN_PROGRESS : record.status,
        landlord_noc_public_id: uploaded.public_id,
        landlord_name: landlordName.slice(0, 150),
        rejection_reason: null,
      },
      { stage: 'owner', action: 'landlord_noc_uploaded', by: req.user.id, note: landlordName.slice(0, 100) }
    );

    return ok(res, summarizeForOwner(spot, updated), 'Landlord letter saved');
  } catch (err) {
    logger.error('spotVerification.uploadLandlordNoc error:', err);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}

/**
 * Whether this submission needs the landlord's consent, and what is missing.
 *
 * The union of two conditions, on purpose. A stated tenant needs it for the
 * obvious reason. A rent agreement needs it whatever the owner ticked, because
 * a rent agreement IS a tenant's document — somebody describing themselves as
 * the owner while submitting one has either mis-tapped or is hoping nobody
 * reads it, and both are handled by asking for the letter.
 */
function missingTenantConsent(record) {
  const isTenant = record.relationship === RELATIONSHIPS.TENANT
    || TENANT_DOC_TYPES.includes(record.doc_type);
  if (!isTenant) return null;

  const missing = [];
  if (!record.landlord_noc_public_id) missing.push('the letter from your landlord');
  if (!record.landlord_name) missing.push("the landlord's name");
  if (!missing.length) return null;

  return `This spot is rented, so we need ${missing.join(' and ')} before we can check it.`;
}

/** Submit the spot for review. This is when the 48-hour clock starts. */
async function submit(req, res) {
  try {
    const spot = await spotFor(req, res);
    if (!spot) return undefined;

    const record = await getOrCreateRecord(spot.id);
    const blocked = editBlocked(record);
    if (blocked) return fail(res, 409, blocked);

    if (!record.doc_public_id || !record.claimed_address) {
      return fail(res, 400, 'Add a document for this address before submitting.');
    }

    // A rented spot without the landlord's consent is not a submission we can
    // act on, so it is refused here rather than wasting the owner's 48 hours
    // and an admin's review before telling them.
    const needsConsent = missingTenantConsent(record);
    if (needsConsent) return fail(res, 400, needsConsent);
    if (spot.latitude === null || spot.longitude === null) {
      // The desk check measures the document's address against the pin. With
      // no pin there is nothing to measure, and the spot could never be found
      // in any case.
      return fail(res, 400, 'Set this spot\'s location on the map before submitting it.');
    }

    const updated = await saveAndSync(
      record,
      { status: S.DESK_PENDING, submitted_at: new Date(), rejection_reason: null },
      { stage: 'owner', action: 'submitted', by: req.user.id }
    );

    prisma.users.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
      .then((admins) => Promise.all(admins.map((a) => NotificationService.sendPushNotification(a.id, {
        title: 'A spot needs checking',
        body: `${spot.title} — ${record.claimed_address}`,
        data: { type: 'spot_verification_submitted', spotId: spot.id },
      }))))
      .catch((e) => logger.warn('Admin notify failed:', e.message));

    logger.info(`Spot ${spot.id} submitted for verification by user ${req.user.id}`);
    return ok(res, summarizeForOwner(spot, updated), 'Submitted for review');
  } catch (err) {
    logger.error('spotVerification.submit error:', err);
    return fail(res, 500, 'Something went wrong. Please try again.');
  }
}

/** Where one spot stands, for its owner. */
async function getOne(req, res) {
  try {
    const spot = await spotFor(req, res);
    if (!spot) return undefined;

    const record = await getOrCreateRecord(spot.id);
    return ok(res, summarizeForOwner(spot, record));
  } catch (err) {
    logger.error('spotVerification.getOne error:', err);
    return fail(res, 500, 'Could not load this spot\'s verification.');
  }
}

// ───────────────────────────── admin ─────────────────────────────

/**
 * The queue, oldest first, with how long each has been waiting.
 *
 * We promise 48 hours. A promise nobody measures is one we break quietly, so
 * every row carries its wait and its state: ok, at_risk past 36 hours, overdue
 * past 48. Ordered by submitted_at so the oldest is always at the top -- the
 * order is the queue, not a suggestion.
 */
async function adminQueue(req, res) {
  try {
    const stage = ['desk', 'field'].includes(req.query.stage) ? req.query.stage : null;
    const status = stage === 'desk' ? [S.DESK_PENDING]
      : stage === 'field' ? [S.DESK_APPROVED]
        : AWAITING_REVIEW_STATUSES;

    const rows = await prisma.spot_verifications.findMany({
      where: { status: { in: status } },
      orderBy: { submitted_at: 'asc' },
      take: 200,
      include: {
        parking_spots: {
          select: {
            id: true, title: true, address: true, latitude: true, longitude: true,
            spot_verification_status: true,
            users: { select: { id: true, full_name: true, email: true, phone: true, verification_status: true } },
          },
        },
      },
    });

    const now = new Date();
    const items = rows.map((r) => {
      const wait = Policy.waitFor({ status: r.status, submittedAt: r.submitted_at, now });
      return {
        spot_id: r.spot_id,
        title: r.parking_spots?.title,
        claimed_address: r.claimed_address,
        doc_type: r.doc_type,
        relationship: r.relationship,
        status: r.status,
        stage: r.status === S.DESK_PENDING ? 'desk' : 'field',
        submitted_at: r.submitted_at,
        waiting_hours: wait.waiting_hours,
        hours_left: wait.hours_left,
        overdue_by_hours: wait.overdue_by_hours,
        sla: wait.sla,
        owner: r.parking_spots?.users
          ? {
            id: r.parking_spots.users.id,
            name: r.parking_spots.users.full_name,
            email: r.parking_spots.users.email,
            person_verified: r.parking_spots.users.verification_status === 'approved',
          }
          : null,
        visible_to_drivers: r.parking_spots?.spot_verification_status,
      };
    });

    return ok(res, {
      promised_hours: Policy.SLA_HOURS,
      at_risk_after_hours: Policy.AT_RISK_HOURS,
      counts: {
        total: items.length,
        desk: items.filter((i) => i.stage === 'desk').length,
        field: items.filter((i) => i.stage === 'field').length,
        at_risk: items.filter((i) => i.sla === Policy.SLA.AT_RISK).length,
        overdue: items.filter((i) => i.sla === Policy.SLA.OVERDUE).length,
      },
      items,
    });
  } catch (err) {
    logger.error('spotVerification.adminQueue error:', err);
    return fail(res, 500, 'Could not load the queue.');
  }
}

/**
 * The spots that were live before any of this existed and have not been
 * submitted yet — the chasing list.
 *
 * Kept out of the queue above on purpose: nobody promised these owners 48
 * hours, and counting them would open the feature with a queue full of
 * breaches that mean nothing. They are visible to drivers and unchecked, which
 * is work to get through, not a broken promise. Oldest spot first.
 *
 * Once such an owner submits, the spot leaves this list and joins the ordinary
 * queue on the ordinary clock — it is waiting on us then, like any other. A
 * spot in both lists would mean chasing an owner who has already done it.
 */
async function adminBacklog(req, res) {
  try {
    const rows = await prisma.spot_verifications.findMany({
      where: {
        grandfathered_at: { not: null },
        status: { notIn: [S.APPROVED, S.REJECTED] },
        submitted_at: null,
      },
      orderBy: { spot_id: 'asc' },
      take: 200,
      include: {
        parking_spots: {
          select: {
            id: true, title: true, address: true, created_at: true,
            spot_verification_status: true,
            users: { select: { id: true, full_name: true, email: true, phone: true } },
          },
        },
      },
    });

    // How many of these have since been submitted and moved to the queue, so
    // the two screens add up to the whole grandfathered set.
    const submitted = await prisma.spot_verifications.count({
      where: {
        grandfathered_at: { not: null },
        status: { notIn: [S.APPROVED, S.REJECTED] },
        submitted_at: { not: null },
      },
    });

    return ok(res, {
      note: 'Live in the finder before per-spot verification existed. Unchecked, not submitted, and not on the 48-hour clock.',
      count: rows.length,
      submitted_and_in_the_queue: submitted,
      items: rows.map((r) => ({
        spot_id: r.spot_id,
        title: r.parking_spots?.title,
        spot_address: r.parking_spots?.address,
        listed_at: r.parking_spots?.created_at,
        grandfathered_at: r.grandfathered_at,
        status: r.status,
        has_document: !!r.doc_public_id,
        claimed_address: r.claimed_address,
        visible_to_drivers: r.parking_spots?.spot_verification_status,
        owner: r.parking_spots?.users
          ? {
            id: r.parking_spots.users.id,
            name: r.parking_spots.users.full_name,
            email: r.parking_spots.users.email,
            phone: r.parking_spots.users.phone,
          }
          : null,
      })),
    });
  } catch (err) {
    logger.error('spotVerification.adminBacklog error:', err);
    return fail(res, 500, 'Could not load the backlog.');
  }
}

/**
 * The two desk checks: is this the same person, and is this the same place.
 *
 * Shared by the preview an admin runs before deciding and by the decision
 * itself, so the numbers they were shown and the numbers that were stored are
 * produced by the same code. Geocoding happens here and nowhere else in the
 * request path — adminDetail stays a read, because a GET that makes an
 * external call and writes a row is a trap for whoever next adds a refresh
 * button to a screen.
 *
 * @returns {Promise<{address: object, name: object|null, blockers: object[], geocode: object|null}>}
 */
async function runDeskChecks({ record, spot, aadhaarName, nameOnDocument }) {
  const geocode = await geocodeAddress(record.claimed_address);

  const metres = geocode && spot.latitude !== null && spot.longitude !== null
    ? metresBetween(Number(spot.latitude), Number(spot.longitude), Number(geocode.lat), Number(geocode.lon))
    : null;

  const address = {
    ...Policy.addressVerdictFor({
      metres,
      precision: geocode?.precision || null,
      uncertaintyM: geocode?.uncertainty_m || null,
    }),
    claimed_address: record.claimed_address,
    resolved_to: geocode?.display_name || null,
    precision: geocode?.precision || null,
    uncertainty_m: geocode?.uncertainty_m || null,
    source: geocode?.source || null,
    geocoded_lat: geocode?.lat || null,
    geocoded_lng: geocode?.lon || null,
  };

  const typed = String(nameOnDocument || '').trim();
  const name = typed
    ? (() => {
      const result = compareNames(typed, aadhaarName);
      return {
        name_on_document: typed,
        aadhaar_name: aadhaarName || null,
        verdict: result.verdict,
        matched: result.matched,
        of: result.total,
        explanation: explainNameMatch(result),
      };
    })()
    : null;

  const blockers = Policy.deskPassBlockers({
    nameVerdict: name?.verdict || null,
    addressVerdict: address.verdict,
  });

  return { address, name, blockers, geocode };
}

/** The spot, its record and the owner's verified name, for a desk review. */
async function deskContext(spotId) {
  const record = await prisma.spot_verifications.findUnique({
    where: { spot_id: spotId },
    include: {
      parking_spots: {
        select: {
          id: true, title: true, latitude: true, longitude: true,
          users: {
            select: {
              id: true, verification_status: true,
              owner_verification: { select: { aadhaar_name: true } },
            },
          },
        },
      },
    },
  });
  if (!record) return null;

  return {
    record,
    spot: record.parking_spots,
    owner: record.parking_spots?.users,
    aadhaarName: record.parking_spots?.users?.owner_verification?.aadhaar_name || null,
  };
}

/**
 * Run the checks and store what they found, without deciding anything.
 *
 * This is what the admin screen calls when it opens a submission: it geocodes
 * the claimed address, measures it against the pin, compares a typed name if
 * one was given, and writes all of it to the record. A POST because it costs
 * an external request and changes a row.
 */
async function adminCheck(req, res) {
  try {
    const spotId = parseInt(req.params.spotId, 10);
    if (!Number.isInteger(spotId)) return fail(res, 400, 'Spot id must be a number.');

    const ctx = await deskContext(spotId);
    if (!ctx) return fail(res, 404, 'No verification record for this spot.');
    if (!ctx.record.claimed_address) return fail(res, 409, 'This spot has no submitted address to check.');

    const checks = await runDeskChecks({
      record: ctx.record,
      spot: ctx.spot,
      aadhaarName: ctx.aadhaarName,
      nameOnDocument: req.body?.name_on_document,
    });

    const updated = await saveAndSync(
      ctx.record,
      {
        geocoded_lat: checks.geocode ? Number(checks.geocode.lat) : null,
        geocoded_lng: checks.geocode ? Number(checks.geocode.lon) : null,
        geocode_source: checks.geocode?.source || null,
        geocode_precision: checks.geocode?.precision || null,
        geocode_uncertainty_m: checks.geocode?.uncertainty_m ?? null,
        address_match_metres: checks.address.metres,
        address_match_verdict: checks.address.verdict,
        ...(checks.name ? { name_on_document: checks.name.name_on_document, name_match: checks.name.verdict } : {}),
      },
      {
        stage: 'desk',
        action: 'checked',
        by: req.user.id,
        note: `address ${checks.address.verdict}${checks.name ? `, name ${checks.name.verdict}` : ''}`,
      }
    );

    return ok(res, {
      spot_id: spotId,
      status: updated.status,
      address: checks.address,
      name: checks.name,
      blockers: checks.blockers,
      // Said plainly, because it is the one thing a reviewer must not forget.
      reminder: 'These checks cannot tell you whether the document is genuine. Only the field check can test the record behind it.',
    });
  } catch (err) {
    logger.error('spotVerification.adminCheck error:', err);
    return fail(res, 500, 'Could not run the checks.');
  }
}

/**
 * The desk decision: an admin has read the document.
 *
 * A pass sends the spot to the FIELD stage, not live — `desk_approved` is not
 * a status a driver may see. The checks are re-run here rather than trusting
 * whatever adminCheck stored, so a decision is always made against a fresh
 * measurement and a name the admin typed in the same breath.
 */
async function adminDeskDecision(req, res) {
  try {
    const spotId = parseInt(req.params.spotId, 10);
    if (!Number.isInteger(spotId)) return fail(res, 400, 'Spot id must be a number.');

    const decision = String(req.body?.decision || '').toLowerCase();
    if (!['pass', 'reject'].includes(decision)) {
      return fail(res, 400, 'Decision must be pass or reject.');
    }

    const ctx = await deskContext(spotId);
    if (!ctx) return fail(res, 404, 'No verification record for this spot.');
    if (ctx.record.status !== S.DESK_PENDING) {
      return fail(res, 409, `Only a submission waiting for a desk review can be decided (this one is ${ctx.record.status}).`);
    }

    // ── reject ────────────────────────────────────────────────────────────
    if (decision === 'reject') {
      const reason = String(req.body?.reason || '').trim();
      if (reason.length < 10) {
        return fail(res, 400, 'Give the owner a clear reason they can act on (at least 10 characters).');
      }

      const updated = await saveAndSync(
        ctx.record,
        {
          status: S.REJECTED,
          rejection_reason: reason.slice(0, 500),
          desk_reviewed_by: req.user.id,
          desk_reviewed_at: new Date(),
        },
        { stage: 'desk', action: 'rejected', by: req.user.id, note: reason.slice(0, 200) }
      );

      NotificationService.sendPushNotification(ctx.owner?.id, {
        title: 'Your spot needs a different document',
        body: reason.slice(0, 140),
        data: { type: 'spot_verification_rejected', spotId },
      }).catch(() => {});

      logger.info(`Spot ${spotId} desk review rejected by admin ${req.user.id}`);
      return ok(res, { spot_id: spotId, status: updated.status }, 'Sent back to the owner with a reason');
    }

    // ── pass ──────────────────────────────────────────────────────────────

    // A place is verified in a PERSON's name. If we have not verified the
    // person, there is no name to check the document against and nothing to
    // override — this one does not yield.
    if (ctx.owner?.verification_status !== 'approved') {
      return fail(res, 409, 'This owner is not verified yet. Verify the person before verifying their property.');
    }

    const nameOnDocument = String(req.body?.name_on_document || '').trim();
    if (nameOnDocument.length < 2) {
      return fail(res, 400, 'Type the name printed on the document.');
    }

    const checks = await runDeskChecks({
      record: ctx.record,
      spot: ctx.spot,
      aadhaarName: ctx.aadhaarName,
      nameOnDocument,
    });

    const override = String(req.body?.override_reason || '').trim();
    if (checks.blockers.length && override.length < 10) {
      return fail(res, 409, 'This submission cannot pass as it stands.', {
        blockers: checks.blockers,
        address: checks.address,
        name: checks.name,
        how_to_proceed: 'If you are passing it anyway, send override_reason explaining why (at least 10 characters). It is recorded against the spot.',
      });
    }

    const updated = await saveAndSync(
      ctx.record,
      {
        status: S.DESK_APPROVED,
        name_on_document: nameOnDocument,
        name_match: checks.name.verdict,
        geocoded_lat: checks.geocode ? Number(checks.geocode.lat) : null,
        geocoded_lng: checks.geocode ? Number(checks.geocode.lon) : null,
        geocode_source: checks.geocode?.source || null,
        geocode_precision: checks.geocode?.precision || null,
        geocode_uncertainty_m: checks.geocode?.uncertainty_m ?? null,
        address_match_metres: checks.address.metres,
        address_match_verdict: checks.address.verdict,
        desk_override_reason: checks.blockers.length ? override.slice(0, 500) : null,
        desk_reviewed_by: req.user.id,
        desk_reviewed_at: new Date(),
        rejection_reason: null,
      },
      {
        stage: 'desk',
        action: checks.blockers.length ? 'passed_with_override' : 'passed',
        by: req.user.id,
        note: checks.blockers.length
          ? `over ${checks.blockers.map((b) => b.code).join(', ')}: ${override.slice(0, 200)}`
          : `name ${checks.name.verdict}, address ${checks.address.verdict}`,
      }
    );

    logger.info(
      `Spot ${spotId} desk review passed by admin ${req.user.id}`
      + `${checks.blockers.length ? ` WITH OVERRIDE of ${checks.blockers.map((b) => b.code).join(', ')}` : ''}`
    );

    return ok(res, {
      spot_id: spotId,
      status: updated.status,
      address: checks.address,
      name: checks.name,
      overridden: checks.blockers.map((b) => b.code),
      // Nobody should read desk_approved as live.
      next: 'Waiting for the field check. The spot is not visible to drivers until that passes.',
    }, 'Desk review passed');
  } catch (err) {
    logger.error('spotVerification.adminDeskDecision error:', err);
    return fail(res, 500, 'Could not record the decision.');
  }
}

/**
 * The field check: our team went to the regional office.
 *
 * This is the only thing in the whole feature that can make a spot live, and
 * the only step that tests anything a forger cannot simply print. The desk
 * review says the document names the right person and points at roughly the
 * right place; this says the record behind it exists.
 *
 * What it still does not establish, so that nobody reads `approved` as more
 * than it is: that the record names THIS person as the current holder, that
 * the holder may let the space (society rules, municipal permission), or —
 * for a tenant — that the signature on the landlord's letter is real.
 *
 * A result is recorded either way. "We went and found nothing" is a finding,
 * not a failure to act, and it is written down with the office that was
 * checked so the next person does not repeat the visit.
 */
async function adminFieldDecision(req, res) {
  try {
    const spotId = parseInt(req.params.spotId, 10);
    if (!Number.isInteger(spotId)) return fail(res, 400, 'Spot id must be a number.');

    const ctx = await deskContext(spotId);
    if (!ctx) return fail(res, 404, 'No verification record for this spot.');

    // Both stages, in order. A field check on a submission nobody has read is
    // a visit made on the strength of an unexamined document.
    if (ctx.record.status !== S.DESK_APPROVED) {
      return fail(res, 409, ctx.record.status === S.DESK_PENDING
        ? 'The desk review has to pass before the field check. Read the document first.'
        : `Only a spot waiting for its field check can be recorded (this one is ${ctx.record.status}).`);
    }

    const office = String(req.body?.office || '').trim();
    if (office.length < 3) return fail(res, 400, 'Record which office was checked.');

    const recordFound = req.body?.record_found;
    if (typeof recordFound !== 'boolean') {
      return fail(res, 400, 'Say whether the record was found: record_found must be true or false.');
    }

    const reference = String(req.body?.reference || '').trim();
    const notes = String(req.body?.notes || '').trim();

    // ── the record was not found ──────────────────────────────────────────
    if (!recordFound) {
      const reason = String(req.body?.reason || '').trim();
      if (reason.length < 10) {
        return fail(res, 400, 'Give the owner a clear reason they can act on (at least 10 characters).');
      }

      const updated = await saveAndSync(
        ctx.record,
        {
          status: S.REJECTED,
          field_office: office.slice(0, 120),
          field_record_found: false,
          field_reference: reference ? reference.slice(0, 100) : null,
          field_notes: notes ? notes.slice(0, 1000) : null,
          field_checked_by: req.user.id,
          field_checked_at: new Date(),
          rejection_reason: reason.slice(0, 500),
        },
        { stage: 'field', action: 'record_not_found', by: req.user.id, note: `${office}: ${notes.slice(0, 150)}` }
      );

      NotificationService.sendPushNotification(ctx.owner?.id, {
        title: 'We could not confirm your spot',
        body: reason.slice(0, 140),
        data: { type: 'spot_verification_rejected', spotId },
      }).catch(() => {});

      logger.info(`Spot ${spotId} field check found no record at ${office} (admin ${req.user.id})`);
      return ok(res, { spot_id: spotId, status: updated.status }, 'Recorded: no record found');
    }

    // ── the record was found ──────────────────────────────────────────────

    // A found record has a reference. Without one there is nothing for anyone
    // to check again later, and "found it, trust me" is not a record.
    if (reference.length < 3) {
      return fail(res, 400, 'Record the registration reference for the record you found.');
    }

    const pending = {
      ...ctx.record,
      field_record_found: true,
      field_checked_at: new Date(),
    };
    // The belt to the status check's braces: `approved` is written in one
    // place and only when both stages have actually passed.
    if (!Policy.deskAndFieldPassed(pending)) {
      logger.error(`Spot ${spotId} reached the field pass without both stages — refusing to publish`);
      return fail(res, 409, 'This spot has not passed both checks, so it cannot go live.');
    }

    const updated = await saveAndSync(
      ctx.record,
      {
        status: S.APPROVED,
        field_office: office.slice(0, 120),
        field_record_found: true,
        field_reference: reference.slice(0, 100),
        field_notes: notes ? notes.slice(0, 1000) : null,
        field_checked_by: req.user.id,
        field_checked_at: pending.field_checked_at,
        rejection_reason: null,
      },
      { stage: 'field', action: 'record_found', by: req.user.id, note: `${office} ref ${reference.slice(0, 60)}` }
    );

    NotificationService.sendPushNotification(ctx.owner?.id, {
      title: 'Your spot is live ✅',
      body: `${ctx.spot?.title} is verified and drivers can book it now.`,
      data: { type: 'spot_verification_approved', spotId },
    }).catch(() => {});

    logger.info(`Spot ${spotId} approved after field check at ${office} (admin ${req.user.id})`);
    return ok(res, {
      spot_id: spotId,
      status: updated.status,
      visible_to_drivers: Policy.driverVisibleStatusFor(updated),
      means: 'A person we verified submitted a document in their name for an address near this pin, an admin read it, '
        + 'and our team found the record at the regional office. It does not mean the document is genuine.',
    }, 'Spot verified and live');
  } catch (err) {
    logger.error('spotVerification.adminFieldDecision error:', err);
    return fail(res, 500, 'Could not record the field check.');
  }
}

/** Everything an admin needs to review one spot, including the document. */
async function adminDetail(req, res) {
  try {
    const spotId = parseInt(req.params.spotId, 10);
    if (!Number.isInteger(spotId)) return fail(res, 400, 'Spot id must be a number.');

    const record = await prisma.spot_verifications.findUnique({
      where: { spot_id: spotId },
      include: {
        parking_spots: {
          select: {
            id: true, title: true, address: true, latitude: true, longitude: true,
            created_at: true, is_active: true, spot_verification_status: true,
            users: {
              select: {
                id: true, full_name: true, email: true, phone: true, verification_status: true,
                owner_verification: { select: { aadhaar_name: true, property_address: true } },
              },
            },
          },
        },
      },
    });
    if (!record) return fail(res, 404, 'No verification record for this spot.');

    const signed = (publicId) => (publicId
      ? cloudinary.url(publicId, { type: 'authenticated', sign_url: true, secure: true })
      : null);

    const wait = Policy.waitFor({ status: record.status, submittedAt: record.submitted_at });
    const owner = record.parking_spots?.users;

    return ok(res, {
      spot: {
        id: record.parking_spots?.id,
        title: record.parking_spots?.title,
        address_on_listing: record.parking_spots?.address,
        latitude: record.parking_spots?.latitude,
        longitude: record.parking_spots?.longitude,
        listed_at: record.parking_spots?.created_at,
        is_active: record.parking_spots?.is_active,
        visible_to_drivers: record.parking_spots?.spot_verification_status,
      },
      owner: owner
        ? {
          id: owner.id,
          name: owner.full_name,
          email: owner.email,
          phone: owner.phone,
          person_verified: owner.verification_status === 'approved',
          // The name to compare the document against, and the address the
          // PERSON gave at KYC -- which is not the same claim as this spot's.
          aadhaar_name: owner.owner_verification?.aadhaar_name || null,
          person_property_address: owner.owner_verification?.property_address || null,
        }
        : null,
      submission: {
        status: record.status,
        doc_type: record.doc_type,
        claimed_address: record.claimed_address,
        relationship: record.relationship,
        landlord_name: record.landlord_name,
        doc_url: signed(record.doc_public_id),
        landlord_noc_url: signed(record.landlord_noc_public_id),
        submitted_at: record.submitted_at,
        grandfathered_at: record.grandfathered_at,
        ...wait,
      },
      desk: {
        name_on_document: record.name_on_document,
        name_match: record.name_match,
        address_match_metres: record.address_match_metres,
        address_match_verdict: record.address_match_verdict,
        geocoded_lat: record.geocoded_lat,
        geocoded_lng: record.geocoded_lng,
        geocode_source: record.geocode_source,
        // What the address resolved TO. The metres above cannot be read
        // without it: 800 m from a house means something, 800 m from the
        // middle of a 4 km suburb means nothing.
        geocode_precision: record.geocode_precision,
        geocode_uncertainty_m: record.geocode_uncertainty_m,
        override_reason: record.desk_override_reason,
        reviewed_by: record.desk_reviewed_by,
        reviewed_at: record.desk_reviewed_at,
        // Re-stated from the stored numbers, so a screen that shows this does
        // not have to reimplement the bands.
        reading: record.address_match_metres === null && !record.address_match_verdict
          ? null
          : Policy.addressVerdictFor({
            metres: record.address_match_metres,
            precision: record.geocode_precision,
            uncertaintyM: record.geocode_uncertainty_m,
          }).explanation,
      },
      field: {
        office: record.field_office,
        record_found: record.field_record_found,
        reference: record.field_reference,
        notes: record.field_notes,
        checked_by: record.field_checked_by,
        checked_at: record.field_checked_at,
      },
      rejection_reason: record.rejection_reason,
      review_log: Array.isArray(record.review_log) ? record.review_log : [],
    });
  } catch (err) {
    logger.error('spotVerification.adminDetail error:', err);
    return fail(res, 500, 'Could not load this spot\'s verification.');
  }
}

module.exports = {
  uploadDocument,
  submit,
  getOne,
  adminQueue,
  adminBacklog,
  adminDetail,
  adminCheck,
  adminDeskDecision,
  adminFieldDecision,
  uploadLandlordNoc,
  // exported for the tests and for stages 2 and 3
  getOrCreateRecord,
  saveAndSync,
  summarizeForOwner,
};
