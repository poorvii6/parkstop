const cron = require('node-cron');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const NotificationService = require('./notificationService');

/**
 * Weekly owner payouts.
 *
 * Owners do not ask to be paid. Every Saturday morning this sweeps each
 * eligible owner's wallet into a payout request, and an admin sends the
 * transfers and records the bank reference against each one.
 *
 * It replaces an on-demand "Request payout" button, which had a hole: the
 * balance left the wallet the moment the owner tapped, and nothing but an
 * admin could move it on. With no admin account, no owner-side cancel and no
 * sweep touching payout_requests, the first owner to tap had their wallet
 * emptied into a row nobody could act on. A scheduled run has no such state:
 * either the batch is created or it is not, and the next one is seven days
 * away regardless.
 *
 * The money in a wallet is already the owner's 80% share. Commission is taken
 * per booking at completion, so nothing is deducted here.
 */

/** Saturday, 9am India. */
const SCHEDULE = process.env.WEEKLY_PAYOUT_CRON || '0 9 * * 6';
const TZ = process.env.WEEKLY_PAYOUT_TZ || 'Asia/Kolkata';

/**
 * Below this, the balance stays in the wallet and waits for a week that
 * clears it. A bank transfer has a fixed cost and an admin has to make it by
 * hand, so moving tiny amounts costs more than it pays.
 */
const MIN_PAYOUT = Number(process.env.MIN_PAYOUT || 100);

const money = (v) => Math.round(Number(v || 0) * 100) / 100;

/**
 * Pay one owner. Returns the request, or null with a reason.
 *
 * The lock and the status guard are the same shape the old per-owner request
 * used: the balance is read and moved inside one transaction, so an earning
 * landing mid-sweep cannot be paid twice or lost.
 */
async function payOneOwner(user) {
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;

      // A batch that ran twice, or a request left open from before this job
      // existed, must not produce a second one.
      const open = await tx.payout_requests.findFirst({
        where: { user_id: user.id, status: 'requested' },
      });
      if (open) return { skipped: 'already has an open payout' };

      const fresh = await tx.users.findUnique({
        where: { id: user.id },
        select: { balance: true, bank_account_number: true, bank_ifsc: true, bank_account_name: true },
      });
      // Re-read rather than trust the row the sweep selected: minutes may have
      // passed, and a refund could have taken the balance back down.

      // The sweep's filter is `not: null`, which lets an empty string through
      // -- and an empty string is exactly what a half-filled form saves. The
      // app's own eligibility check uses plain truthiness, so without this the
      // two disagree: the owner is told they are in the run and the run hands
      // an admin a row with no name or no IFSC to send to. Checked here with
      // the same truthiness the app uses.
      if (!fresh.bank_account_number || !fresh.bank_ifsc || !fresh.bank_account_name) {
        return { skipped: 'bank details incomplete' };
      }

      const amount = Math.floor(Number(fresh.balance || 0) * 100) / 100;
      if (amount < MIN_PAYOUT) return { skipped: `below ₹${MIN_PAYOUT}` };

      await tx.users.update({ where: { id: user.id }, data: { balance: { decrement: amount } } });

      return {
        request: await tx.payout_requests.create({
          data: {
            user_id: user.id,
            amount,
            status: 'requested',
            bank_account_name: fresh.bank_account_name,
            bank_account_last4: String(fresh.bank_account_number).slice(-4),
            bank_ifsc: fresh.bank_ifsc,
          },
        }),
      };
    });
  } catch (err) {
    logger.error(`Weekly payout failed for owner ${user.id}:`, err);
    return { failed: err.message };
  }
}

/**
 * The run itself. Exported so it can be triggered by hand for a missed week
 * or from a script, without waiting for Saturday.
 */
async function runWeeklyPayouts() {
  const started = Date.now();

  // Do nothing at all unless somebody can finish the job.
  //
  // This run does not send money. It moves the balance out of the owner's
  // wallet and leaves a 'requested' row for an admin to pay by hand. Only a
  // user with role ADMIN can mark one paid or reject it back into the wallet,
  // so with no admin account the rows can be neither paid nor returned: every
  // eligible owner's wallet reads zero, their app says the money is on its
  // way, and nothing can move it either direction.
  //
  // That is the same trap the old Request Payout button set, sprung
  // automatically on everyone at once instead of one owner at a time. So the
  // run refuses to start. Balances stay where they are, owners keep seeing
  // their real earnings, and next Saturday picks it all up once an admin
  // exists. Doing nothing is recoverable; draining wallets into rows nobody
  // can action is not.
  const adminCount = await prisma.users.count({ where: { role: 'ADMIN' } });
  if (adminCount === 0) {
    logger.error(
      'Weekly payout run ABORTED: no ADMIN account exists, so nothing could be paid out ' +
      'or returned. No balance has been touched. Create an admin user and the next run ' +
      'will include everyone who is owed.'
    );
    return { paid: 0, skipped: 0, failed: 0, total: 0, aborted: 'no admin account' };
  }

  // Only owners who can actually be paid: verified, with a bank account that
  // passed the Cashfree name match, and enough in the wallet to be worth a
  // transfer. Everyone else simply rolls over to next week.
  const owners = await prisma.users.findMany({
    where: {
      verification_status: 'approved',
      // All three, not just the account number. A transfer needs the IFSC to
      // reach the branch and the holder's name to pass the bank's name check --
      // a mismatch is the usual reason a payout bounces. An owner missing any
      // of them is skipped and keeps their balance, rather than being handed to
      // an admin as a row that cannot be sent.
      bank_account_number: { not: null },
      bank_ifsc: { not: null },
      bank_account_name: { not: null },
      balance: { gte: MIN_PAYOUT },
    },
    select: { id: true, balance: true },
  });

  let paid = 0, skipped = 0, failed = 0, total = 0;

  for (const owner of owners) {
    const out = await payOneOwner(owner);
    if (out.request) {
      paid += 1;
      total += Number(out.request.amount);
      NotificationService.sendPushNotification(owner.id, {
        title: 'Weekly payout on its way 💸',
        body: `₹${money(out.request.amount).toFixed(2)} is being sent to your bank account. It usually lands within 2 working days.`,
        data: { type: 'payout_requested', requestId: out.request.id },
      }).catch((e) => logger.warn(`Payout notice to ${owner.id} failed: ${e.message}`));
    } else if (out.failed) {
      failed += 1;
    } else {
      skipped += 1;
    }
  }

  logger.info(
    `Weekly payout run: ${paid} owner(s), ₹${money(total).toFixed(2)} total, ` +
    `${skipped} skipped, ${failed} failed, ${Date.now() - started}ms`,
  );

  if (paid > 0) {
    prisma.users.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
      .then((admins) => Promise.all(admins.map((a) => NotificationService.sendPushNotification(a.id, {
        title: 'Weekly payouts ready',
        body: `${paid} owner${paid > 1 ? 's' : ''} to pay, ₹${money(total).toFixed(2)} in total.`,
        data: { type: 'payout_batch_ready', count: paid },
      }))))
      .catch((e) => logger.warn(`Admin payout-batch notice failed: ${e.message}`));
  }

  return { paid, skipped, failed, total: money(total) };
}

const startWeeklyPayoutJob = () => {
  cron.schedule(SCHEDULE, async () => {
    try {
      await runWeeklyPayouts();
    } catch (err) {
      // A thrown run means nobody was paid this week. It is logged loudly
      // rather than retried: the next run is seven days away, and a partial
      // retry against a half-swept batch is worse than a late one.
      logger.error('Weekly payout run failed:', err);
    }
  }, { timezone: TZ });

  logger.info(`Weekly payout job scheduled: ${SCHEDULE} (${TZ}), minimum ₹${MIN_PAYOUT}`);
};

module.exports = startWeeklyPayoutJob;
module.exports.runWeeklyPayouts = runWeeklyPayouts;
module.exports.MIN_PAYOUT = MIN_PAYOUT;
