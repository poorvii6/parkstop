/**
 * ownerVerificationController.js — spot-owner verification.
 *
 * Steps (any order after Aadhaar, all required before submit):
 *   1. Aadhaar via DigiLocker   — name, DOB, last 4 digits (never the full number)
 *   2. PAN                      — must be valid and match the Aadhaar name
 *   3. Live selfie              — must be a live person matching the Aadhaar photo
 *   4. Bank account             — must be valid and match the Aadhaar name;
 *                                 becomes the owner's payout account
 *   5. Property proof           — private upload, checked by an admin
 * Then: submit -> admin approves or rejects (with a reason).
 *
 * Only approved owners' spots are shown to drivers and only they can withdraw.
 * Nothing here has a test/mock shortcut: every check is a real Cashfree call.
 */
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const cf = require('../services/cashfreeVerification');
const NotificationService = require('../services/notificationService');

const MAX_ATTEMPTS_PER_DAY = 5;           // per paid step, to cap cost and abuse
const GOOD_NAME_MATCH = ['DIRECT_MATCH', 'GOOD_PARTIAL_MATCH'];
const REVIEW_NAME_MATCH = ['MODERATE_PARTIAL_MATCH']; // allowed, flagged for admin
const DOC_TYPES = ['electricity_bill', 'property_tax', 'rent_agreement', 'sale_deed', 'water_bill', 'other'];

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ───────────────────────── helpers ─────────────────────────
const ok = (res, data, message = '') => res.json({ success: true, message, data });
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

function handleError(res, err, where) {
  if (err instanceof cf.VerificationError) return fail(res, err.status, err.message, { code: err.code });
  logger.error(`ownerVerification.${where} error:`, err);
  return fail(res, 500, 'Something went wrong. Please try again.');
}

async function getOrCreate(userId) {
  const existing = await prisma.owner_verifications.findUnique({ where: { user_id: userId } });
  if (existing) return existing;
  return prisma.owner_verifications.create({ data: { user_id: userId, status: 'not_started' } });
}

/** Mirror the status onto users for fast filtering (search, bookings). */
async function setStatus(userId, status, data = {}) {
  const rec = await prisma.owner_verifications.update({
    where: { user_id: userId },
    data: { status, ...data },
  });
  await prisma.users.update({ where: { id: userId }, data: { verification_status: status } });
  return rec;
}

function editBlocked(rec) {
  if (rec.status === 'pending') return 'Your verification is under review. You can make changes if it is sent back to you.';
  if (rec.status === 'approved') return 'You are already verified. Contact support to change verified details.';
  return null;
}

/** Each paid step: at most MAX_ATTEMPTS_PER_DAY tries in a rolling 24h window. */
async function useAttempt(rec, step) {
  const all = rec.attempts && typeof rec.attempts === 'object' ? { ...rec.attempts } : {};
  const now = Date.now();
  const recent = (Array.isArray(all[step]) ? all[step] : []).filter((t) => now - t < 24 * 3600 * 1000);
  if (recent.length >= MAX_ATTEMPTS_PER_DAY) {
    const err = new cf.VerificationError(`Too many attempts for this step today. Please try again tomorrow or contact support.`, { status: 429, code: 'DAILY_LIMIT' });
    throw err;
  }
  recent.push(now);
  all[step] = recent;
  await prisma.owner_verifications.update({ where: { id: rec.id }, data: { attempts: all } });
}

function addFlag(rec, flag) {
  const flags = Array.isArray(rec.flags) ? rec.flags.filter((f) => f.code !== flag.code) : [];
  flags.push({ ...flag, at: new Date().toISOString() });
  return flags;
}

function verificationId(userId, step) {
  // Cashfree: max 50 chars, [A-Za-z0-9._-]. Must be unique per call.
  return `PS_${userId}_${step}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`.slice(0, 50);
}

function panHash(pan) {
  const key = process.env.JWT_SECRET || '';
  return crypto.createHmac('sha256', key).update(`pan:${pan}`).digest('hex');
}

function publicBase(req) {
  // Railway terminates TLS at its proxy; DigiLocker requires an https redirect.
  return `https://${req.get('host')}`;
}

/** What the app shows: each step done/not, plus overall status. No raw IDs. */
function summarize(rec) {
  const steps = {
    aadhaar: !!rec.aadhaar_verified_at,
    pan: !!rec.pan_verified_at,
    selfie: !!rec.selfie_verified_at,
    bank: !!rec.bank_verified_at,
    property: !!rec.property_uploaded_at,
  };
  return {
    status: rec.status,
    steps,
    all_done: Object.values(steps).every(Boolean),
    rejection_reason: rec.status === 'rejected' ? rec.rejection_reason : null,
    submitted_at: rec.submitted_at,
    details: {
      aadhaar: steps.aadhaar ? { name: rec.aadhaar_name, last4: rec.aadhaar_last4 } : null,
      pan: steps.pan ? { masked: rec.pan_masked } : null,
      bank: steps.bank ? { last4: rec.bank_last4, ifsc: rec.bank_ifsc, bank_name: rec.bank_name } : null,
      property: steps.property ? { doc_type: rec.property_doc_type, address: rec.property_address } : null,
    },
  };
}

async function markInProgress(rec) {
  if (rec.status === 'not_started' || rec.status === 'rejected') {
    return setStatus(rec.user_id, 'in_progress');
  }
  return rec;
}

function needAadhaar(rec) {
  return rec.aadhaar_verified_at ? null : 'Please complete the Aadhaar step first.';
}

// ───────────────────────── owner endpoints ─────────────────────────

async function getStatus(req, res) {
  try {
    const rec = await getOrCreate(req.user.id);
    return ok(res, summarize(rec));
  } catch (err) { return handleError(res, err, 'getStatus'); }
}

/** 1a. Create a DigiLocker link (valid 10 minutes). */
async function startAadhaar(req, res) {
  try {
    const rec = await getOrCreate(req.user.id);
    const blocked = editBlocked(rec);
    if (blocked) return fail(res, 409, blocked);
    await useAttempt(rec, 'aadhaar');

    const vid = verificationId(req.user.id, 'DL');
    const redirectUrl = `${publicBase(req)}/api/v1/owner-verification/aadhaar/return`;
    const out = await cf.createDigilockerUrl(vid, redirectUrl);
    if (!out?.url) throw new cf.VerificationError('Could not open DigiLocker. Please try again.');

    await prisma.owner_verifications.update({ where: { id: rec.id }, data: { digilocker_verification_id: vid } });
    await markInProgress(rec);
    return ok(res, { url: out.url, return_url: redirectUrl, expires_in_seconds: 600 });
  } catch (err) { return handleError(res, err, 'startAadhaar'); }
}

/** 1b. Page DigiLocker sends the user back to. The app watches for this URL. */
function aadhaarReturnPage(req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8').send(
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>ParkStop</title></head><body style="font-family:sans-serif;background:#0C0C14;color:#fff;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center">' +
    '<div><h2>Done</h2><p>Please return to the ParkStop app.</p></div></body></html>'
  );
}

/** 1c. After DigiLocker: read the result and save Aadhaar details. */
async function completeAadhaar(req, res) {
  try {
    const rec = await getOrCreate(req.user.id);
    const blocked = editBlocked(rec);
    if (blocked) return fail(res, 409, blocked);
    if (!rec.digilocker_verification_id) return fail(res, 400, 'Please start the Aadhaar step first.');

    const st = await cf.getDigilockerStatus(rec.digilocker_verification_id);
    if (st?.status === 'PENDING') return fail(res, 409, 'DigiLocker is not finished yet. Please complete it and allow sharing your Aadhaar.', { code: 'PENDING' });
    if (st?.status === 'EXPIRED') return fail(res, 410, 'The DigiLocker link expired. Please start again.', { code: 'EXPIRED' });
    if (st?.status === 'CONSENT_DENIED') return fail(res, 400, 'Aadhaar sharing was denied in DigiLocker. Please try again and tap Allow.', { code: 'CONSENT_DENIED' });
    if (st?.status !== 'AUTHENTICATED') return fail(res, 400, 'DigiLocker could not confirm your identity. Please try again.');

    const doc = await cf.getDigilockerAadhaar(rec.digilocker_verification_id);
    if (doc.httpStatus === 202) return fail(res, 409, 'Your Aadhaar is still being fetched. Please tap Continue again in a few seconds.', { code: 'PENDING' });
    if (doc.status === 'AADHAAR_NOT_LINKED') {
      return fail(res, 400, 'No Aadhaar is linked to this DigiLocker account. Please add your Aadhaar in DigiLocker and try again.', { code: 'AADHAAR_NOT_LINKED' });
    }
    if (doc.status !== 'SUCCESS' || !doc.name || !doc.uid) {
      return fail(res, 400, 'DigiLocker did not return your Aadhaar details. Please try again.');
    }

    const last4 = String(doc.uid).replace(/\D/g, '').slice(-4);
    const addr = doc.split_address || {};
    let updated = await prisma.owner_verifications.update({
      where: { id: rec.id },
      data: {
        aadhaar_name: String(doc.name).slice(0, 150),
        aadhaar_last4: last4 || null,
        aadhaar_dob: doc.dob ? String(doc.dob).slice(0, 20) : null,
        aadhaar_gender: doc.gender ? String(doc.gender).slice(0, 10) : null,
        aadhaar_state: addr.state ? String(addr.state).slice(0, 60) : null,
        aadhaar_pincode: addr.pincode ? String(addr.pincode).slice(0, 10) : null,
        aadhaar_verified_at: new Date(),
        // A new identity invalidates checks that were matched to the old name/photo.
        pan_verified_at: null, selfie_verified_at: null, bank_verified_at: null,
      },
    });

    // Same person already verified on another account? Flag for the admin.
    const dup = await prisma.owner_verifications.findFirst({
      where: {
        user_id: { not: req.user.id },
        aadhaar_last4: updated.aadhaar_last4,
        aadhaar_dob: updated.aadhaar_dob,
        aadhaar_name: updated.aadhaar_name,
      },
      select: { user_id: true },
    });
    if (dup) {
      updated = await prisma.owner_verifications.update({
        where: { id: rec.id },
        data: { flags: addFlag(updated, { code: 'POSSIBLE_DUPLICATE_AADHAAR', note: `Same Aadhaar details as user ${dup.user_id}` }) },
      });
    }
    await markInProgress(updated);
    return ok(res, summarize(await getOrCreate(req.user.id)), 'Aadhaar verified');
  } catch (err) { return handleError(res, err, 'completeAadhaar'); }
}

/** 2. PAN — valid, individual, and the name must match Aadhaar. */
async function verifyPan(req, res) {
  try {
    const pan = String(req.body?.pan || '').toUpperCase().trim();
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return fail(res, 400, 'Please enter a valid 10-character PAN (like ABCDE1234F).');
    if (pan[3] !== 'P') return fail(res, 400, 'Please use your personal PAN card (the 4th letter of a personal PAN is P).');

    const rec = await getOrCreate(req.user.id);
    const blocked = editBlocked(rec) || needAadhaar(rec);
    if (blocked) return fail(res, 409, blocked);

    const hash = panHash(pan);
    const usedElsewhere = await prisma.owner_verifications.findFirst({
      where: { pan_hash: hash, user_id: { not: req.user.id }, pan_verified_at: { not: null } },
      select: { user_id: true },
    });
    if (usedElsewhere) return fail(res, 409, 'This PAN is already used by another ParkStop owner account. Contact support if this is a mistake.');

    await useAttempt(rec, 'pan');
    const out = await cf.verifyPan(pan, rec.aadhaar_name);

    if (!out?.valid || out.pan_status !== 'VALID') {
      return fail(res, 400, 'This PAN is not valid as per Income Tax records. Please check the number.');
    }
    const match = out.name_match_result;
    if (![...GOOD_NAME_MATCH, ...REVIEW_NAME_MATCH].includes(match)) {
      return fail(res, 400, `The name on this PAN (${out.registered_name || 'unknown'}) does not match your Aadhaar name (${rec.aadhaar_name}).`, { code: 'NAME_MISMATCH' });
    }

    let flags = rec.flags;
    if (REVIEW_NAME_MATCH.includes(match)) flags = addFlag(rec, { code: 'PAN_NAME_PARTIAL', note: `PAN name "${out.registered_name}" vs Aadhaar "${rec.aadhaar_name}"` });
    if (out.aadhaar_seeding_status && out.aadhaar_seeding_status !== 'Y') {
      flags = addFlag({ flags }, { code: 'PAN_NOT_LINKED_TO_AADHAAR', note: `Seeding status ${out.aadhaar_seeding_status}` });
    }

    await prisma.owner_verifications.update({
      where: { id: rec.id },
      data: {
        pan_masked: `${pan.slice(0, 2)}XXXXXX${pan.slice(-2)}`,
        pan_hash: hash,
        pan_registered_name: out.registered_name ? String(out.registered_name).slice(0, 150) : null,
        pan_name_match: match,
        pan_aadhaar_linked: out.aadhaar_seeding_status || null,
        pan_verified_at: new Date(),
        flags,
      },
    });
    return ok(res, summarize(await getOrCreate(req.user.id)), 'PAN verified');
  } catch (err) { return handleError(res, err, 'verifyPan'); }
}

/** 3. Live selfie: liveness, then face match against the Aadhaar photo. */
async function verifySelfie(req, res) {
  try {
    if (!req.file?.buffer) return fail(res, 400, 'Please take a selfie.');
    const rec = await getOrCreate(req.user.id);
    const blocked = editBlocked(rec) || needAadhaar(rec);
    if (blocked) return fail(res, 409, blocked);

    await useAttempt(rec, 'selfie');

    const live = await cf.faceLiveness(verificationId(req.user.id, 'LV'), req.file.buffer, req.file.mimetype);
    if (live?.status === 'MULTIPLE_FACES_DETECTED') return fail(res, 400, 'More than one face was found. Please take the selfie alone.');
    if (live?.status === 'FACE_NOT_DETECTED') return fail(res, 400, 'No face was found. Please face the camera in good light.');
    if (live?.status !== 'SUCCESS' || live.liveness !== true) {
      return fail(res, 400, 'We could not confirm a live photo. Please take a fresh selfie, face the camera, in good light (not a photo of a photo).');
    }

    // Fetch the Aadhaar photo again from DigiLocker (we never store it).
    const doc = await cf.getDigilockerAadhaar(rec.digilocker_verification_id);
    const photoB64 = doc?.photo_link ? String(doc.photo_link).replace(/^data:image\/\w+;base64,/, '') : null;
    if (!photoB64) {
      return fail(res, 409, 'Your DigiLocker access has expired. Please redo the Aadhaar step, then the selfie.', { code: 'REDO_AADHAAR' });
    }

    const match = await cf.faceMatch(verificationId(req.user.id, 'FM'), Buffer.from(photoB64, 'base64'), req.file.buffer, 0.75);
    if (match?.status !== 'SUCCESS' || match.face_match_result !== 'YES') {
      return fail(res, 400, 'Your selfie does not match your Aadhaar photo. Please try again in good light, without glasses or a mask.', { code: 'FACE_MISMATCH' });
    }

    await prisma.owner_verifications.update({
      where: { id: rec.id },
      data: {
        liveness_score: Number(live.liveness_score) || null,
        face_match_score: Number(match.face_match_score) || null,
        selfie_verified_at: new Date(),
      },
    });
    return ok(res, summarize(await getOrCreate(req.user.id)), 'Selfie verified');
  } catch (err) { return handleError(res, err, 'verifySelfie'); }
}

/** 4. Bank account — valid and in the Aadhaar holder's name. Becomes the payout account. */
async function verifyBank(req, res) {
  try {
    const account = String(req.body?.account_number || '').replace(/\s/g, '');
    const ifsc = String(req.body?.ifsc || '').toUpperCase().trim();
    if (!/^[A-Za-z0-9]{6,40}$/.test(account)) return fail(res, 400, 'Please enter a valid bank account number.');
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return fail(res, 400, 'Please enter a valid IFSC code (like SBIN0001234).');

    const rec = await getOrCreate(req.user.id);
    const blocked = editBlocked(rec) || needAadhaar(rec);
    if (blocked) return fail(res, 409, blocked);

    await useAttempt(rec, 'bank');
    const out = await cf.verifyBankAccount(account, ifsc, rec.aadhaar_name);

    if (out?.account_status !== 'VALID') {
      const why = {
        INVALID_ACCOUNT_FAIL: 'The account number is not valid for this IFSC.',
        INVALID_IFSC_FAIL: 'The IFSC code is not valid.',
        ACCOUNT_BLOCKED: 'This account is blocked or closed.',
        NRE_ACCOUNT_FAIL: 'NRE accounts cannot receive payouts.',
      }[out?.account_status_code] || 'This bank account could not be verified.';
      return fail(res, 400, why);
    }
    const match = out.name_match_result;
    if (![...GOOD_NAME_MATCH, ...REVIEW_NAME_MATCH].includes(match)) {
      return fail(res, 400, `This account is in the name "${out.name_at_bank || 'unknown'}", which does not match your Aadhaar name (${rec.aadhaar_name}). Please use your own account.`, { code: 'NAME_MISMATCH' });
    }

    let flags = rec.flags;
    if (REVIEW_NAME_MATCH.includes(match)) flags = addFlag(rec, { code: 'BANK_NAME_PARTIAL', note: `Bank name "${out.name_at_bank}" vs Aadhaar "${rec.aadhaar_name}"` });

    await prisma.$transaction([
      prisma.owner_verifications.update({
        where: { id: rec.id },
        data: {
          bank_last4: account.slice(-4),
          bank_ifsc: ifsc,
          bank_name: (out.bank_name || out.ifsc_details?.bank || '').slice(0, 100) || null,
          bank_name_at_bank: out.name_at_bank ? String(out.name_at_bank).slice(0, 150) : null,
          bank_name_match: match,
          bank_verified_at: new Date(),
          flags,
        },
      }),
      // The verified account is the ONLY way payout details get set.
      prisma.users.update({
        where: { id: req.user.id },
        data: {
          bank_account_number: account.slice(0, 20),
          bank_ifsc: ifsc,
          bank_account_name: (out.name_at_bank || rec.aadhaar_name || '').slice(0, 100),
          payout_mode: 'bank',
        },
      }),
    ]);
    return ok(res, summarize(await getOrCreate(req.user.id)), 'Bank account verified');
  } catch (err) { return handleError(res, err, 'verifyBank'); }
}

/** 5. Property proof — private upload, an admin checks it. */
async function uploadProperty(req, res) {
  try {
    if (!req.file?.buffer) return fail(res, 400, 'Please add a photo of your document.');
    const docType = String(req.body?.doc_type || '');
    const address = String(req.body?.address || '').trim();
    if (!DOC_TYPES.includes(docType)) return fail(res, 400, 'Please choose the document type.');
    if (address.length < 10) return fail(res, 400, 'Please enter the full address of the parking space.');

    const rec = await getOrCreate(req.user.id);
    const blocked = editBlocked(rec);
    if (blocked) return fail(res, 409, blocked);
    if (!process.env.CLOUDINARY_CLOUD_NAME) return fail(res, 503, 'File uploads are not configured on the server.');

    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'parkstop/owner-docs', type: 'authenticated', resource_type: 'image' },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    // Remove the previous document, if any.
    if (rec.property_doc_public_id && rec.property_doc_public_id !== uploaded.public_id) {
      cloudinary.uploader.destroy(rec.property_doc_public_id, { type: 'authenticated' }).catch(() => {});
    }

    await prisma.owner_verifications.update({
      where: { id: rec.id },
      data: {
        property_doc_type: docType,
        property_doc_public_id: uploaded.public_id,
        property_address: address.slice(0, 300),
        property_uploaded_at: new Date(),
      },
    });
    await markInProgress(rec);
    return ok(res, summarize(await getOrCreate(req.user.id)), 'Document uploaded');
  } catch (err) { return handleError(res, err, 'uploadProperty'); }
}

/** 6. Submit for admin review. */
async function submit(req, res) {
  try {
    const rec = await getOrCreate(req.user.id);
    const blocked = editBlocked(rec);
    if (blocked) return fail(res, 409, blocked);
    const s = summarize(rec);
    if (!s.all_done) {
      const missing = Object.entries(s.steps).filter(([, v]) => !v).map(([k]) => k);
      return fail(res, 400, `Please complete: ${missing.join(', ')}.`, { missing });
    }
    const updated = await setStatus(req.user.id, 'pending', { submitted_at: new Date(), rejection_reason: null });

    // Tell admins (best-effort).
    prisma.users.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
      .then((admins) => Promise.all(admins.map((a) => NotificationService.sendPushNotification(a.id, {
        title: 'New owner to verify',
        body: `${rec.aadhaar_name} submitted their verification.`,
        data: { type: 'owner_verification_submitted', userId: req.user.id },
      }))))
      .catch((e) => logger.warn('Admin notify failed:', e.message));

    return ok(res, summarize(updated), 'Submitted for review');
  } catch (err) { return handleError(res, err, 'submit'); }
}

// ───────────────────────── admin endpoints ─────────────────────────

async function adminList(req, res) {
  try {
    const status = ['pending', 'approved', 'rejected', 'in_progress'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await prisma.owner_verifications.findMany({
      where: { status },
      orderBy: { submitted_at: 'asc' },
      take: 100,
      include: { users: { select: { id: true, email: true, full_name: true, phone: true } } },
    });
    return ok(res, rows.map((r) => ({
      user_id: r.user_id,
      email: r.users?.email,
      account_name: r.users?.full_name,
      aadhaar_name: r.aadhaar_name,
      status: r.status,
      submitted_at: r.submitted_at,
      flags: Array.isArray(r.flags) ? r.flags.map((f) => f.code) : [],
    })));
  } catch (err) { return handleError(res, err, 'adminList'); }
}

async function adminDetail(req, res) {
  try {
    const userId = parseInt(req.params.userId, 10);
    const r = await prisma.owner_verifications.findUnique({
      where: { user_id: userId },
      include: {
        users: {
          select: {
            id: true, email: true, full_name: true, phone: true, created_at: true,
            parking_spots: { select: { id: true, title: true, address: true, latitude: true, longitude: true } },
          },
        },
      },
    });
    if (!r) return fail(res, 404, 'No verification found for this user.');
    const docUrl = r.property_doc_public_id
      ? cloudinary.url(r.property_doc_public_id, { type: 'authenticated', sign_url: true, secure: true })
      : null;
    return ok(res, {
      user: r.users,
      status: r.status,
      submitted_at: r.submitted_at,
      reviewed_at: r.reviewed_at,
      rejection_reason: r.rejection_reason,
      flags: r.flags || [],
      aadhaar: { name: r.aadhaar_name, last4: r.aadhaar_last4, dob: r.aadhaar_dob, gender: r.aadhaar_gender, state: r.aadhaar_state, pincode: r.aadhaar_pincode, verified_at: r.aadhaar_verified_at },
      pan: { masked: r.pan_masked, registered_name: r.pan_registered_name, name_match: r.pan_name_match, aadhaar_linked: r.pan_aadhaar_linked, verified_at: r.pan_verified_at },
      selfie: { liveness_score: r.liveness_score, face_match_score: r.face_match_score, verified_at: r.selfie_verified_at },
      bank: { last4: r.bank_last4, ifsc: r.bank_ifsc, bank_name: r.bank_name, name_at_bank: r.bank_name_at_bank, name_match: r.bank_name_match, verified_at: r.bank_verified_at },
      property: { doc_type: r.property_doc_type, address: r.property_address, uploaded_at: r.property_uploaded_at, doc_url: docUrl },
    });
  } catch (err) { return handleError(res, err, 'adminDetail'); }
}

async function adminApprove(req, res) {
  try {
    const userId = parseInt(req.params.userId, 10);
    const r = await prisma.owner_verifications.findUnique({ where: { user_id: userId } });
    if (!r) return fail(res, 404, 'No verification found for this user.');
    if (r.status !== 'pending') return fail(res, 409, `Only submitted verifications can be approved (this one is ${r.status}).`);
    if (!summarize(r).all_done) return fail(res, 409, 'Some steps are not complete.');

    await setStatus(userId, 'approved', { reviewed_at: new Date(), reviewed_by: req.user.id, rejection_reason: null });
    NotificationService.sendPushNotification(userId, {
      title: 'You are verified ✅',
      body: 'Your parking spots are now visible to drivers on ParkStop.',
      data: { type: 'owner_verification_approved' },
    }).catch(() => {});
    logger.info(`Owner ${userId} approved by admin ${req.user.id}`);
    return ok(res, { user_id: userId, status: 'approved' }, 'Owner approved');
  } catch (err) { return handleError(res, err, 'adminApprove'); }
}

async function adminReject(req, res) {
  try {
    const userId = parseInt(req.params.userId, 10);
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) return fail(res, 400, 'Please give the owner a clear reason (at least 5 characters).');
    const r = await prisma.owner_verifications.findUnique({ where: { user_id: userId } });
    if (!r) return fail(res, 404, 'No verification found for this user.');
    if (!['pending', 'approved'].includes(r.status)) return fail(res, 409, `This verification is ${r.status}.`);

    await setStatus(userId, 'rejected', { reviewed_at: new Date(), reviewed_by: req.user.id, rejection_reason: reason.slice(0, 500) });
    NotificationService.sendPushNotification(userId, {
      title: 'Verification needs changes',
      body: reason.slice(0, 140),
      data: { type: 'owner_verification_rejected' },
    }).catch(() => {});
    logger.info(`Owner ${userId} rejected by admin ${req.user.id}`);
    return ok(res, { user_id: userId, status: 'rejected' }, 'Owner sent back with reason');
  } catch (err) { return handleError(res, err, 'adminReject'); }
}

module.exports = {
  getStatus, startAadhaar, aadhaarReturnPage, completeAadhaar,
  verifyPan, verifySelfie, verifyBank, uploadProperty, submit,
  adminList, adminDetail, adminApprove, adminReject,
  // exported for tests
  _summarize: summarize,
  DOC_TYPES,
};
