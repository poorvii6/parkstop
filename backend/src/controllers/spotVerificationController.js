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
const {
  SPOT_VERIFICATION_STATUS: S,
  SPOT_DOC_TYPES,
  RELATIONSHIPS,
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
        geocoded_lat: record.geocoded_lat,
        geocoded_lng: record.geocoded_lng,
        geocode_source: record.geocode_source,
        reviewed_by: record.desk_reviewed_by,
        reviewed_at: record.desk_reviewed_at,
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
  // exported for the tests and for stages 2 and 3
  getOrCreateRecord,
  saveAndSync,
  summarizeForOwner,
};
