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
const crypto = require('crypto');
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

/**
 * Everything about delivering a private document, in one place.
 *
 * Both documents are uploaded with `resource_type: 'image'` and
 * `type: 'authenticated'`, PDFs included. Cloudinary treats a PDF as an image
 * resource, which is what makes the admin preview below possible — stored as
 * `raw` it would come back as bytes with no way to render a page.
 *
 * A PDF therefore has TWO signed URLs and they are not interchangeable:
 *
 *   - `url`     the PDF itself, signed. Opens in a browser or a PDF viewer.
 *               React Native's <Image> cannot render it.
 *   - `preview` page 1 rasterised to a JPEG, signed. This is what the admin
 *               screen shows inline, and the only one an <Image> can take.
 *
 * For a photo the two are the same URL, so a screen can always use `preview`
 * to display and `url` to open full size without caring which it has.
 *
 * ⚠️ OPERATIONAL: Cloudinary blocks PDF delivery by default on newer accounts
 * — Settings > Security > "Allow delivery of PDF and ZIP files". Until that is
 * ticked, uploads succeed and both PDF URLs 403. There is no way to detect it
 * from here, so it has to be ticked by hand once.
 */
const PDF_FORMAT = 'pdf';

/**
 * How wide a preview is delivered.
 *
 * The preview used to carry no transformation at all, so the admin screen
 * downloaded the untouched original — up to MAX_DOC_BYTES, 15MB, straight off
 * a phone camera at full sensor resolution — to fill an <Image> 260pt tall.
 * That is the several-second wait before a document appears.
 *
 * `c_limit` never upscales, so a small scan is left alone. 1200px is well
 * above what the preview can show (260pt is ~780 device pixels at 3x) and is
 * deliberately generous: an admin reads the name and the address off this
 * image to make the decision, so it has to stay legible, and a tighter crop
 * would save bytes the reviewer needs. The full original is still one tap
 * away on `url`.
 */
const PREVIEW_MAX_WIDTH = 1200;

function signedDocUrls(publicId, format) {
  if (!publicId) return { url: null, preview_url: null, format: null, is_pdf: false };

  // Still authenticated, still signed. Cloudinary signs the transformation as
  // part of the URL, so a derived preview is exactly as private as the
  // original — the signature does not grant access to anything else.
  const base = { type: 'authenticated', resource_type: 'image', sign_url: true, secure: true };
  const sized = { ...base, width: PREVIEW_MAX_WIDTH, crop: 'limit', quality: 'auto' };
  const isPdf = String(format || '').toLowerCase() === PDF_FORMAT;

  return {
    url: cloudinary.url(publicId, isPdf ? { ...base, format: PDF_FORMAT } : base),
    // Page 1 as a JPEG. For an image this is the image, resized.
    preview_url: isPdf
      ? cloudinary.url(publicId, { ...sized, format: 'jpg', page: 1 })
      // fetch_format: 'auto' lets the CDN serve WebP where the client takes
      // it. Not used on the PDF branch, where the explicit jpg is the point.
      : cloudinary.url(publicId, { ...sized, fetch_format: 'auto' }),
    format: format || null,
    is_pdf: isPdf,
  };
}

/**
 * Has this exact file already been submitted for a DIFFERENT address?
 *
 * Cloudinary mints a new public_id on every upload, so two uploads of one file
 * look unrelated. Hashing the bytes is what makes reuse visible at all.
 *
 * Why it matters: one genuine khata could verify four unrelated driveways.
 * The name check passes — it really is the same person. The address check
 * cannot help, because a Bengaluru address usually geocodes to a locality and
 * a locality hit is UNVERIFIABLE, which deliberately does not block. The field
 * check cannot help either: the record exists, because the document is real.
 * Nothing in the flow was looking at whether the SAME piece of paper had
 * already been spent.
 *
 * Reuse at the SAME address is ordinary and allowed. Four bays on one property
 * is one property, one khata, four spots, and refusing that would make honest
 * owners list their bays as one spot — the opposite of what we want.
 *
 * @returns {Promise<{spot_id: number, claimed_address: string|null}[]>} the
 *   spots holding this file under a different address
 */
async function sameFileElsewhere({ sha256, column, spotId, address }) {
  if (!sha256) return [];

  const rows = await prisma.spot_verifications.findMany({
    where: { [column]: sha256, spot_id: { not: spotId } },
    select: { spot_id: true, claimed_address: true, status: true },
    take: 20,
  });

  return rows.filter((r) => !Policy.sameClaimedAddress(r.claimed_address, address));
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

    if (!req.file?.buffer) return fail(res, 400, 'Please attach your document — a PDF, or a photo of it.');

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

    // Before anything is uploaded: is this the same piece of paper somebody
    // already used for another address?
    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const reused = await sameFileElsewhere({
      sha256, column: 'doc_sha256', spotId: spot.id, address,
    });
    if (reused.length) {
      return fail(res, 409,
        'This document is already being used for a different address, so it cannot prove this one too. '
        + 'Upload the document for THIS address. If both spots really are at the same place, '
        + 'enter the same address for both.',
        { also_used_for: reused.map((r) => ({ spot_id: r.spot_id, address: r.claimed_address })) });
    }

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
        doc_sha256: sha256,
        doc_format: uploaded.format || null,
        claimed_address: address.slice(0, 300),
        relationship,
        // A new document invalidates the old verdict, so the desk fields go
        // back to empty rather than describing a document nobody has read.
        name_on_document: null,
        name_match: null,
        name_checked_against: null,
        noc_names_owner: null,
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

    if (!req.file?.buffer) return fail(res, 400, 'Please attach the letter from your landlord — a PDF, or a photo of it.');

    const landlordName = String(req.body?.landlord_name || '').trim();
    if (landlordName.length < 2) return fail(res, 400, 'Enter the name of the landlord who signed the letter.');

    const record = await getOrCreateRecord(spot.id);
    const blocked = editBlocked(record);
    if (blocked) return fail(res, 409, blocked);

    // One letter must not quietly authorise spots at several addresses. The
    // address compared against is the one on THIS spot's submission, because
    // the letter is supposed to name this spot.
    const sha256 = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const reused = await sameFileElsewhere({
      sha256, column: 'landlord_noc_sha256', spotId: spot.id, address: record.claimed_address,
    });
    if (reused.length) {
      return fail(res, 409,
        'This letter is already being used for a different address. '
        + 'A landlord\'s consent has to name the place it is about, so please upload the letter for this spot.',
        { also_used_for: reused.map((r) => ({ spot_id: r.spot_id, address: r.claimed_address })) });
    }

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
        landlord_noc_sha256: sha256,
        landlord_noc_format: uploaded.format || null,
        landlord_name: landlordName.slice(0, 150),
        // A new letter, or a new landlord name, invalidates the admin's
        // confirmation that the letter named this owner.
        noc_names_owner: null,
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
 * `missingTenantConsent` lived here and has moved to
 * Policy.submissionGaps / Policy.isTenantSubmission.
 *
 * Not for tidiness: the owner's screen has to warn a tenant that the
 * landlord's letter is required BEFORE they upload anything, and a rule that
 * only exists inside this controller cannot be read by a screen. Two copies of
 * "what is missing" would eventually disagree, and the way they would disagree
 * is a screen saying "ready to submit" over a button that returns 400.
 */

/** Submit the spot for review. This is when the 48-hour clock starts. */
async function submit(req, res) {
  try {
    const spot = await spotFor(req, res);
    if (!spot) return undefined;

    const record = await getOrCreateRecord(spot.id);
    const blocked = editBlocked(record);
    if (blocked) return fail(res, 409, blocked);

    /**
     * What is missing, from the one function the owner's screen also reads.
     *
     * A rented spot without the landlord's consent is not a submission we can
     * act on, so it is refused here rather than wasting the owner's 48 hours
     * and an admin's review before telling them — but the screen has already
     * said so, because it asked Policy.submissionGaps the same question.
     */
    const gaps = Policy.submissionGaps(record, spot);
    if (gaps.length) {
      return fail(res, 400, gaps[0].message, { missing: gaps.map((g) => g.code) });
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
async function runDeskChecks({
  record, spot, aadhaarName, nameOnDocument,
  nocNamesOwner = null, inheritanceDocument = null,
}) {
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

  /**
   * A tenant's ownership document names their LANDLORD, which is what we asked
   * them for. So that is who it is compared against — not the tenant's own
   * Aadhaar name, which it was never going to match. See
   * Policy.NAME_CHECKED_AGAINST for the full reasoning.
   *
   * `Policy.isTenantSubmission` is the same union used at submit and on the
   * owner's screen: a stated tenant, or a tenancy document whatever they
   * ticked.
   */
  const isTenant = Policy.isTenantSubmission(record);
  const checkedAgainst = isTenant
    ? Policy.NAME_CHECKED_AGAINST.LANDLORD
    : Policy.NAME_CHECKED_AGAINST.AADHAAR;
  const expectedName = isTenant ? record.landlord_name : aadhaarName;

  const typed = String(nameOnDocument || '').trim();
  const name = typed
    ? (() => {
      const result = compareNames(typed, expectedName);
      return {
        name_on_document: typed,
        /** Who the document was compared against, and why. */
        checked_against: checkedAgainst,
        expected_name: expectedName || null,
        aadhaar_name: aadhaarName || null,
        landlord_name: record.landlord_name || null,
        verdict: result.verdict,
        matched: result.matched,
        of: result.total,
        conflicting: result.conflicting,
        via_variant: result.via_variant,
        /** The variant agreed only on a short key — thin evidence. */
        weak_variant: result.weak_variant,
        exact_full_matches: result.exact_full_matches,
        /** The document names a holder recorded as deceased. */
        deceased_holder: result.deceased_holder,
        explanation: explainNameMatch(result),
        note: isTenant
          ? 'This spot is rented, so the ownership document should name the LANDLORD. '
            + 'It is compared to the name on the consent letter, not to the owner\'s Aadhaar.'
          : null,
      };
    })()
    : null;

  const blockers = Policy.deskPassBlockers({
    nameVerdict: name?.verdict || null,
    addressVerdict: address.verdict,
    checkedAgainst,
    isTenant,
    nocNamesOwner,
    deceasedOnDocument: !!name?.deceased_holder,
    inheritanceDocument,
  });

  return { address, name, blockers, geocode, isTenant, checkedAgainst, inheritanceDocument };
}

/**
 * Nobody verifies their own spot.
 *
 * An ADMIN may also be a spotter, and the owner routes accept SPOTTER or
 * ADMIN while `spotFor` lets an admin touch any spot. So without this an admin
 * could upload a document to their own driveway, submit it, pass their own
 * desk review and record their own field check — the entire flow, alone, with
 * nothing in the log to show it. Both decision routes call this, and it does
 * NOT yield to an override: there is no reason that makes checking your own
 * paperwork a check.
 *
 * It compares the spot's owner, not the submitter, because the submitter is
 * not recorded — and the owner is who the verification is about.
 */
function reviewingOwnSpot(ctx, reviewerId) {
  if (!ctx?.owner?.id || !reviewerId) return null;
  if (ctx.owner.id !== reviewerId) return null;
  return 'This spot belongs to you. Another admin has to check it.';
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
      nocNamesOwner: typeof req.body?.noc_names_owner === 'boolean' ? req.body.noc_names_owner : null,
      inheritanceDocument: req.body?.inheritance_document || null,
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
        ...(checks.name ? {
          name_on_document: checks.name.name_on_document,
          name_match: checks.name.verdict,
          name_checked_against: checks.checkedAgainst,
        } : {}),
      },
      {
        stage: 'desk',
        action: 'checked',
        by: req.user.id,
        note: `address ${checks.address.verdict}`
          + `${checks.name ? `, name ${checks.name.verdict} vs ${checks.checkedAgainst}` : ''}`,
      }
    );

    // Not stored and not decided — just shown, so the reviewer knows this is
    // their own spot before they read any further.
    const selfReview = reviewingOwnSpot(ctx, req.user.id);

    return ok(res, {
      spot_id: spotId,
      status: updated.status,
      address: checks.address,
      name: checks.name,
      blockers: checks.blockers,
      is_tenant: checks.isTenant,
      cannot_be_overridden: Policy.unoverridableBlockers(checks.blockers).map((b) => b.code),
      your_own_spot: !!selfReview,
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

    const selfReview = reviewingOwnSpot(ctx, req.user.id);
    if (selfReview) return fail(res, 403, selfReview);

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
      nocNamesOwner: typeof req.body?.noc_names_owner === 'boolean' ? req.body.noc_names_owner : null,
      inheritanceDocument: req.body?.inheritance_document || null,
    });

    // Some blockers are missing facts rather than judgment calls, and no
    // amount of written reasoning supplies them. A consent letter that does
    // not name this owner is one: the admin is looking at the letter.
    const final = Policy.unoverridableBlockers(checks.blockers);
    if (final.length) {
      return fail(res, 409, 'This submission cannot pass.', {
        blockers: checks.blockers,
        address: checks.address,
        name: checks.name,
        cannot_be_overridden: final.map((b) => b.code),
        how_to_proceed: final.some((b) => b.code === 'DOCUMENT_HOLDER_DECEASED')
          ? 'The ownership document names a dead holder. If you are holding a transfer document, '
            + 'send inheritance_document as one of: khata_transfer, succession_certificate, '
            + 'partition_deed, probated_will. If you are not, reject it and ask for one.'
          : final.some((b) => b.code === 'NOC_DOES_NOT_NAME_OWNER')
            ? 'Read the consent letter. If it names this owner and this address, send '
              + 'noc_names_owner: true. If it does not, reject the submission with a reason.'
            : 'Reject the submission with a reason the owner can act on.',
      });
    }

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
        /**
         * WHOSE name the document was compared against. Stored because
         * `name_match` is unreadable without it months later: a DIRECT_MATCH
         * means the owner for an owner-occupied spot and the LANDLORD for a
         * rented one, and those are different claims.
         */
        name_checked_against: checks.checkedAgainst,
        /** The admin read the consent letter and confirmed it names this owner. */
        noc_names_owner: checks.isTenant ? true : null,
        /**
         * WHICH transfer document the admin was holding, when the ownership
         * document named a dead holder. A named document rather than a note,
         * so it can be checked again later.
         */
        inheritance_doc_type: checks.name?.deceased_holder ? checks.inheritanceDocument : null,
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

    // This is the only route that can make a spot live, so it is the last
    // place self-review could matter and the most important one to refuse.
    const selfReview = reviewingOwnSpot(ctx, req.user.id);
    if (selfReview) return fail(res, 403, selfReview);

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

    /**
     * The same property record, already used to verify somewhere else.
     *
     * This is the duplicate check that does not depend on bytes, and it is the
     * one that actually holds. doc_sha256 catches the same FILE; a determined
     * owner re-downloads the PDF (portals embed a timestamp) or rescans the
     * paper and the hash changes. The registration reference does not change,
     * because it identifies the property record itself.
     *
     * It is also checked at the right moment: this is the only route that can
     * make a spot live, and the reference is not known until someone has stood
     * at the registrar's counter.
     *
     * Same reference at the same address is fine — one property, several bays,
     * each verified against the same record. A different address means one
     * property record is being used to vouch for two places, and only one of
     * them can be the place that record describes.
     */
    const sameRecordElsewhere = await prisma.spot_verifications.findMany({
      where: {
        field_reference: reference.slice(0, 100),
        field_record_found: true,
        spot_id: { not: spotId },
      },
      select: {
        spot_id: true,
        claimed_address: true,
        status: true,
        parking_spots: { select: { title: true } },
      },
      take: 20,
    });
    const atAnotherAddress = sameRecordElsewhere.filter(
      (r) => !Policy.sameClaimedAddress(r.claimed_address, ctx.record.claimed_address)
    );
    if (atAnotherAddress.length) {
      logger.warn(
        `Spot ${spotId} field reference ${reference.slice(0, 60)} is already recorded for `
        + `spot(s) ${atAnotherAddress.map((r) => r.spot_id).join(', ')} at another address`
      );
      return fail(res, 409,
        'This registration reference is already recorded for a spot at a different address. '
        + 'One property record cannot describe two places — check which address it really covers.', {
          code: 'FIELD_REFERENCE_ALREADY_USED',
          also_used_for: atAnotherAddress.map((r) => ({
            spot_id: r.spot_id,
            title: r.parking_spots?.title || null,
            claimed_address: r.claimed_address,
            status: r.status,
          })),
          how_to_proceed: 'If both spots really are at that one property, their addresses should '
            + 'match. If they are different places, this reference belongs to only one of them.',
        });
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

    const doc = signedDocUrls(record.doc_public_id, record.doc_format);
    const noc = signedDocUrls(record.landlord_noc_public_id, record.landlord_noc_format);

    const wait = Policy.waitFor({ status: record.status, submittedAt: record.submitted_at });
    const owner = record.parking_spots?.users;

    /**
     * Every OTHER spot holding this same file, whatever its address.
     *
     * Wider than the upload check on purpose. The upload refuses reuse at a
     * different address; this shows the admin the whole picture, including
     * reuse at the SAME address, which is allowed and still worth seeing — one
     * khata across four spots at one address should make a reviewer check that
     * four bays really exist rather than one bay listed four times.
     */
    const sameDocument = record.doc_sha256
      ? await prisma.spot_verifications.findMany({
        where: { doc_sha256: record.doc_sha256, spot_id: { not: spotId } },
        select: {
          spot_id: true, claimed_address: true, status: true,
          parking_spots: { select: { title: true, spotter_id: true } },
        },
        take: 20,
      })
      : [];

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
        /**
         * The document itself, signed. For a PDF this is the PDF — a React
         * Native <Image> cannot render it, so a screen opens it rather than
         * embedding it.
         */
        doc_url: doc.url,
        /** Page 1 as a JPEG for a PDF; the same image for a photo. Always renderable. */
        doc_preview_url: doc.preview_url,
        doc_format: doc.format,
        doc_is_pdf: doc.is_pdf,
        landlord_noc_url: noc.url,
        landlord_noc_preview_url: noc.preview_url,
        landlord_noc_format: noc.format,
        landlord_noc_is_pdf: noc.is_pdf,
        submitted_at: record.submitted_at,
        grandfathered_at: record.grandfathered_at,
        /**
         * The same file on other spots. Reuse at a different address is
         * refused at upload, so anything here is either same-address (fine,
         * but check the bays exist) or predates the check.
         */
        same_document_on: sameDocument.map((r) => ({
          spot_id: r.spot_id,
          title: r.parking_spots?.title || null,
          claimed_address: r.claimed_address,
          status: r.status,
          same_owner: r.parking_spots?.spotter_id === owner?.id,
          same_address: Policy.sameClaimedAddress(r.claimed_address, record.claimed_address),
        })),
        ...wait,
      },
      desk: {
        name_on_document: record.name_on_document,
        name_match: record.name_match,
        /**
         * WHOSE name that verdict is about. A rented spot's ownership document
         * names the LANDLORD, so a DIRECT_MATCH there is a different claim
         * from a DIRECT_MATCH on an owner-occupied spot.
         */
        name_checked_against: record.name_checked_against,
        noc_names_owner: record.noc_names_owner,
        /** Set only when the ownership document named a deceased holder. */
        inheritance_doc_type: record.inheritance_doc_type,
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
      /**
       * Who looked, and whether that was more than one person.
       *
       * The field check is meant to be independent of the desk review. One
       * admin may do both — refusing that would stop a one-admin team working
       * — so it is recorded and shown rather than blocked. An auditor asking
       * "did two people see this?" can answer it from here.
       *
       * Reviewing your OWN spot is a different matter and is refused outright,
       * at both stages.
       */
      independence: {
        desk_reviewed_by: record.desk_reviewed_by,
        field_checked_by: record.field_checked_by,
        both_stages_same_admin: !!record.desk_reviewed_by
          && record.desk_reviewed_by === record.field_checked_by,
        reviewer_is_the_owner: (!!record.desk_reviewed_by && record.desk_reviewed_by === owner?.id)
          || (!!record.field_checked_by && record.field_checked_by === owner?.id),
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
  signedDocUrls,
  PREVIEW_MAX_WIDTH,
};
