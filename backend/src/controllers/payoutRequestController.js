const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const NotificationService = require('../services/notificationService');

/**
 * Owner payouts, done by hand.
 *
 * Automatic bank transfers (RazorpayX) are not approved for ParkStop, so:
 *   1. The owner taps "Request payout". Their whole wallet balance moves into
 *      a payout request (taken out of the wallet straight away, so it cannot
 *      be requested twice).
 *   2. An admin sees the request with the owner's VERIFIED bank account,
 *      sends a bank transfer, and marks it paid with the bank reference (UTR).
 *   3. Or the admin rejects it, and the money goes back into the wallet.
 *
 * Every money step is a single database transaction with a status guard, so a
 * double tap or two admins acting at once cannot pay or refund twice.
 */

const MIN_PAYOUT = 100; // rupees

const ok = (res, data, message) => res.json({ success: true, message, data });
const fail = (res, code, message) => res.status(code).json({ success: false, message });

const notify = (userId, title, body, data = {}) =>
  NotificationService.sendPushNotification(userId, { title, body, data })
    .catch((e) => logger.warn(`Payout notification to ${userId} failed: ${e.message}`));

const notifyAdmins = (title, body, data = {}) =>
  prisma.users.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
    .then((admins) => Promise.all(admins.map((a) => notify(a.id, title, body, data))))
    .catch((e) => logger.warn(`Admin payout notification failed: ${e.message}`));

const toNumber = (d) => Math.round(Number(d || 0) * 100) / 100;

const view = (r) => ({
  id: r.id,
  amount: toNumber(r.amount),
  status: r.status,
  bank_account_name: r.bank_account_name,
  bank_account_last4: r.bank_account_last4,
  bank_ifsc: r.bank_ifsc,
  reference: r.reference,
  note: r.note,
  created_at: r.created_at,
  processed_at: r.processed_at,
});

/** Can this owner be paid? Verified owner + a verified bank account on file. */
async function payoutReadiness(userId) {
  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      balance: true,
      verification_status: true,
      bank_account_number: true,
      bank_ifsc: true,
      bank_account_name: true,
    },
  });
  if (!user) return { ready: false, reason: 'User not found', user: null };
  if (user.verification_status !== 'approved') {
    return { ready: false, reason: 'Complete owner verification before requesting a payout.', user };
  }
  if (!user.bank_account_number || !user.bank_ifsc) {
    return { ready: false, reason: 'Verify your bank account in owner verification first.', user };
  }
  return { ready: true, reason: null, user };
}

// ───────────────────────── owner ─────────────────────────

/** GET /payouts/requests — the owner's own payout requests. */
async function myRequests(req, res) {
  try {
    const rows = await prisma.payout_requests.findMany({
      where: { user_id: req.user.id },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    const { ready, reason } = await payoutReadiness(req.user.id);
    return ok(res, {
      requests: rows.map(view),
      open_request: rows.find((r) => r.status === 'requested') ? view(rows.find((r) => r.status === 'requested')) : null,
      can_request: ready,
      blocked_reason: reason,
      min_amount: MIN_PAYOUT,
    });
  } catch (err) {
    logger.error('List payout requests error:', err);
    return fail(res, 500, 'Could not load your payouts.');
  }
}

/** POST /payouts/request — move the whole wallet balance into a payout request. */
async function requestPayout(req, res) {
  try {
    const { ready, reason } = await payoutReadiness(req.user.id);
    if (!ready) return fail(res, 403, reason);

    const created = await prisma.$transaction(async (tx) => {
      // Lock the owner's row: the balance check and the deduction must not
      // race a second tap or an incoming earning.
      await tx.$executeRaw`SELECT id FROM users WHERE id = ${req.user.id} FOR UPDATE`;

      const open = await tx.payout_requests.findFirst({
        where: { user_id: req.user.id, status: 'requested' },
      });
      if (open) throw Object.assign(new Error('You already have a payout on its way.'), { status: 409 });

      const user = await tx.users.findUnique({
        where: { id: req.user.id },
        select: { balance: true, bank_account_number: true, bank_ifsc: true, bank_account_name: true },
      });
      const amount = Math.floor(Number(user.balance || 0) * 100) / 100;
      if (amount < MIN_PAYOUT) {
        throw Object.assign(new Error(`You need at least ₹${MIN_PAYOUT} to request a payout.`), { status: 400 });
      }

      await tx.users.update({
        where: { id: req.user.id },
        data: { balance: { decrement: amount } },
      });

      return tx.payout_requests.create({
        data: {
          user_id: req.user.id,
          amount,
          status: 'requested',
          bank_account_name: user.bank_account_name,
          bank_account_last4: String(user.bank_account_number).slice(-4),
          bank_ifsc: user.bank_ifsc,
        },
      });
    });

    notifyAdmins('Payout requested', `₹${toNumber(created.amount)} requested by owner #${req.user.id}.`, {
      type: 'payout_requested', requestId: created.id,
    });

    return ok(res, view(created), `₹${toNumber(created.amount)} requested. It will reach your bank within 2 working days.`);
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    logger.error('Request payout error:', err);
    return fail(res, 500, 'Could not request the payout. Please try again.');
  }
}

// ───────────────────────── admin ─────────────────────────

/** GET /payouts/admin/requests?status=requested|paid|rejected */
async function adminList(req, res) {
  try {
    const status = ['requested', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'requested';
    const rows = await prisma.payout_requests.findMany({
      where: { status },
      orderBy: { created_at: status === 'requested' ? 'asc' : 'desc' },
      take: 100,
      include: {
        users: {
          select: {
            id: true, full_name: true, name: true, email: true, phone: true,
            // The admin needs the full number to send the transfer.
            bank_account_number: true, bank_ifsc: true, bank_account_name: true,
            verification_status: true,
          },
        },
      },
    });
    return ok(res, rows.map((r) => ({
      ...view(r),
      owner: {
        id: r.users.id,
        name: r.users.full_name || r.users.name,
        email: r.users.email,
        phone: r.users.phone,
        verification_status: r.users.verification_status,
      },
      // Where to send it now (the owner's current verified account).
      pay_to: {
        account_name: r.users.bank_account_name,
        account_number: r.users.bank_account_number,
        ifsc: r.users.bank_ifsc,
      },
    })));
  } catch (err) {
    logger.error('Admin payout list error:', err);
    return fail(res, 500, 'Could not load payout requests.');
  }
}

/** POST /payouts/admin/requests/:id/paid  { reference } */
async function adminMarkPaid(req, res) {
  try {
    const id = parseInt(req.params.id);
    const reference = String(req.body?.reference || '').trim();
    if (!id) return fail(res, 400, 'Invalid request id.');
    if (reference.length < 6 || reference.length > 100) {
      return fail(res, 400, 'Enter the bank transaction reference (UTR).');
    }

    const claimed = await prisma.payout_requests.updateMany({
      where: { id, status: 'requested' },
      data: { status: 'paid', reference, processed_at: new Date(), processed_by: req.user.id },
    });
    if (claimed.count === 0) return fail(res, 409, 'This request was already handled.');

    const row = await prisma.payout_requests.findUnique({ where: { id } });
    notify(row.user_id, 'Payout sent 💸', `₹${toNumber(row.amount)} has been sent to your bank account. Reference: ${reference}`, {
      type: 'payout_paid', requestId: id,
    });
    return ok(res, view(row), 'Marked as paid.');
  } catch (err) {
    logger.error('Admin mark paid error:', err);
    return fail(res, 500, 'Could not update the request.');
  }
}

/** POST /payouts/admin/requests/:id/reject  { reason } — money back to the wallet. */
async function adminReject(req, res) {
  try {
    const id = parseInt(req.params.id);
    const reason = String(req.body?.reason || '').trim().slice(0, 300);
    if (!id) return fail(res, 400, 'Invalid request id.');
    if (reason.length < 3) return fail(res, 400, 'Give a short reason so the owner knows what to fix.');

    const row = await prisma.$transaction(async (tx) => {
      const claimed = await tx.payout_requests.updateMany({
        where: { id, status: 'requested' },
        data: { status: 'rejected', note: reason, processed_at: new Date(), processed_by: req.user.id },
      });
      if (claimed.count === 0) return null;
      const r = await tx.payout_requests.findUnique({ where: { id } });
      await tx.users.update({
        where: { id: r.user_id },
        data: { balance: { increment: toNumber(r.amount) } },
      });
      return r;
    });
    if (!row) return fail(res, 409, 'This request was already handled.');

    notify(row.user_id, 'Payout not sent', `₹${toNumber(row.amount)} is back in your ParkStop wallet. Reason: ${reason}`, {
      type: 'payout_rejected', requestId: id,
    });
    return ok(res, view(row), 'Rejected. The money is back in the owner’s wallet.');
  } catch (err) {
    logger.error('Admin reject payout error:', err);
    return fail(res, 500, 'Could not update the request.');
  }
}

module.exports = { myRequests, requestPayout, adminList, adminMarkPaid, adminReject, MIN_PAYOUT };
