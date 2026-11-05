const logger = require('../../utils/logger');
const prisma = require('../../config/prisma');

/**
 * 🏦 PAYOUT SERVICE
 *
 * Owner earnings go into their ParkStop wallet (users.balance). ParkStop then
 * pays wallets out to verified bank accounts BY HAND, through the admin screen
 * in payoutRequestController — the owner requests, an admin sends the transfer
 * and records the UTR.
 *
 * There is deliberately no automatic bank transfer here. RazorpayX Payouts are
 * not approved for ParkStop, and this file used to carry a full, unreachable
 * implementation of them: createContact, createFundAccount, createPayout,
 * getPayoutStatus, setupPayoutAccount and a _createLocalPayout fallback that
 * credited a wallet with none of the guards below. Nothing called any of it,
 * but it only needed RAZORPAY_ACCOUNT_NUMBER to be set and one call added for
 * real money to start leaving the account unchecked. It is gone; if RazorpayX
 * is ever approved, write it again deliberately, with guards.
 */
class PayoutService {

  /**
   * 💰 CREDIT AN OWNER FOR ONE PAID BOOKING
   *
   * Safe to call any number of times, from any path (payment webhook, checkout
   * confirmation, queue retry, the recovery sweep):
   *   - the booking row is locked first, so two callers cannot both pass the check;
   *   - the payout row and the wallet credit are written in ONE transaction, so
   *     there is never a credit without a record or a record without a credit;
   *   - any existing payout row for the booking means it is already done.
   *
   * payouts.booking_id is also UNIQUE, so even a caller that skipped all of
   * this could not write a second row.
   *
   * On failure it throws and changes nothing; the caller or the sweep retries.
   *
   * @returns the payout row (new or existing), or null when there is nothing to pay
   */
  async processBookingPayout(bookingId, spotterEarning, spotterId) {
    const id = parseInt(bookingId);
    const ownerId = parseInt(spotterId);
    const amount = Math.round(Number(spotterEarning) * 100) / 100;
    if (!id || !ownerId || !(amount > 0)) return null;

    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM bookings WHERE id = ${id} FOR UPDATE`;

      const existing = await tx.payouts.findFirst({ where: { booking_id: id } });
      if (existing) {
        logger.info(`Booking ${id} already credited (payout ${existing.id}, ${existing.status}) — skipping`);
        return existing;
      }

      const payout = await tx.payouts.create({
        data: {
          user_id: ownerId,
          booking_id: id,
          amount,
          status: 'balance_credited',
          mode: 'balance',
          purpose: 'payout',
          narration: `ParkStop earnings - Booking #${id}`,
        },
      });
      await tx.users.update({
        where: { id: ownerId },
        data: { balance: { increment: amount } },
      });

      logger.info(`Credited ₹${amount} to owner ${ownerId} for booking ${id}`);
      return payout;
    });
  }
}

module.exports = new PayoutService();
