/**
 * cashfreeController — Cashfree Payments + Easy Split endpoints.
 *
 * Flow (the secure, split-at-source model):
 *   1. Finder taps pay -> createCheckout: we compute the amount server-side,
 *      look up the spotter's Cashfree vendor, and create an order that splits
 *      80% to the spotter and retains 20% for ParkStop. Returns the
 *      payment_session_id the app uses to open Cashfree UPI checkout.
 *   2. Finder pays via their UPI app (GPay/PhonePe/Paytm) -> Cashfree captures
 *      and settles the split automatically to the real accounts.
 *   3. Cashfree calls our webhook -> we mark the booking paid. We do NOT touch
 *      internal wallets here: Cashfree already moved the real money, so crediting
 *      wallets too would double-count.
 *
 * Spotters become "vendors" via onboardVendor (their PAN + bank/UPI).
 */
const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const Cashfree = require('../services/payments/CashfreeAdapter');

// Our platform fee. Spotter (vendor) receives the remainder.
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 20);

class CashfreeController {
  /**
   * CREATE CHECKOUT (Finder) — returns a payment_session_id + split info.
   */
  static async createCheckout(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can pay for a booking' });
      }

      const bookingId = Number(req.body.bookingId);
      if (!bookingId) {
        return res.status(400).json({ success: false, message: 'bookingId is required' });
      }

      const booking = await prisma.bookings.findUnique({
        where: { id: bookingId },
        include: { parking_spots: true },
      });
      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found' });
      }
      if (booking.user_id !== req.user.id) {
        return res.status(403).json({ success: false, message: 'This booking is not yours' });
      }
      if (booking.payment_status === 'paid') {
        return res.status(400).json({ success: false, message: 'This booking is already paid' });
      }

      // Server-computed amount — the finder can never set their own price.
      const amount = Number(booking.total_price);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid booking amount' });
      }

      // Look up the spotter's Cashfree vendor to split 80% to them.
      const spotterId = booking.parking_spots?.spotter_id;
      const spotter = spotterId
        ? await prisma.users.findUnique({ where: { id: spotterId }, select: { cashfree_vendor_id: true } })
        : null;

      const vendorPct = 100 - PLATFORM_FEE_PERCENT;
      const splits = spotter?.cashfree_vendor_id
        ? [{ vendorId: spotter.cashfree_vendor_id, percentage: vendorPct }]
        : [];

      if (!splits.length) {
        // No vendor yet: still collect (100% to ParkStop) so the finder isn't
        // blocked, but flag it so we know this booking needs manual settlement.
        logger.warn(`Cashfree checkout for booking ${bookingId}: spotter ${spotterId} has no vendor — collecting 100% to ParkStop.`);
      }

      const finder = await prisma.users.findUnique({
        where: { id: req.user.id },
        select: { id: true, phone: true, email: true },
      });

      // bookingId is encoded in the order id so the webhook can reconcile it
      // without an extra DB column.
      const orderId = `ps_${bookingId}_${Date.now()}`;

      const order = await Cashfree.createOrder({
        amount,
        orderId,
        customer: { id: finder.id, phone: finder.phone, email: finder.email },
        splits,
        notifyUrl: process.env.CASHFREE_WEBHOOK_URL || undefined,
      });

      return res.json({
        success: true,
        data: {
          payment_session_id: order.paymentSessionId,
          order_id: order.orderId,
          cf_order_id: order.cfOrderId,
          amount: order.amount,
          mode: (process.env.CASHFREE_ENV || 'sandbox').toLowerCase(),
          split: splits.length > 0,
          vendor_percentage: splits.length ? vendorPct : null,
        },
      });
    } catch (error) {
      logger.error('Cashfree createCheckout error:', error?.message, error?.body || '');
      return res.status(500).json({ success: false, message: error?.message || 'Failed to start checkout' });
    }
  }

  /**
   * WEBHOOK (no auth — verified by HMAC signature).
   */
  static async webhook(req, res) {
    try {
      const signature = req.headers['x-webhook-signature'];
      const timestamp = req.headers['x-webhook-timestamp'];
      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});

      if (!Cashfree.verifyWebhookSignature(raw, signature, timestamp)) {
        logger.warn('Cashfree webhook: invalid signature');
        return res.status(401).json({ success: false, message: 'Invalid signature' });
      }

      const evt = req.body || {};
      const orderId = evt?.data?.order?.order_id;
      const payStatus = evt?.data?.payment?.payment_status;

      if (orderId && (payStatus === 'SUCCESS' || evt?.type === 'PAYMENT_SUCCESS_WEBHOOK')) {
        const m = /^ps_(\d+)_/.exec(orderId);
        if (m) {
          const bookingId = parseInt(m[1], 10);
          // Cashfree already split & settled the real money to the vendor and to
          // ParkStop. We only record the booking as paid — no wallet changes.
          await prisma.bookings.updateMany({
            where: { id: bookingId, payment_status: { not: 'paid' } },
            data: { payment_status: 'paid', payment_mode: 'online', updated_at: new Date() },
          });
          logger.info(`Cashfree webhook: booking ${bookingId} marked paid (order ${orderId}).`);
        }
      }

      // Always 200 so Cashfree stops retrying once received.
      return res.json({ success: true });
    } catch (error) {
      logger.error('Cashfree webhook error:', error?.message);
      return res.status(200).json({ success: true });
    }
  }

  /**
   * VERIFY PAYMENT (Finder) — confirmation WITHOUT relying on the webhook.
   * The app calls this right after checkout; we fetch the order from Cashfree and
   * mark the booking paid if it's PAID. This works even when dashboard webhooks
   * are gated behind account activation (as they are for a pre-launch account).
   */
  static async verifyPayment(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can verify a payment' });
      }
      const orderId = req.body.orderId;
      if (!orderId) {
        return res.status(400).json({ success: false, message: 'orderId is required' });
      }

      const order = await Cashfree.getOrder(orderId);
      const status = order?.order_status; // ACTIVE | PAID | EXPIRED | TERMINATED
      const paid = status === 'PAID';

      if (paid) {
        const m = /^ps_(\d+)_/.exec(orderId);
        const bookingId = m ? parseInt(m[1], 10) : Number(req.body.bookingId) || null;
        if (bookingId) {
          // Only ever touch the caller's own booking.
          await prisma.bookings.updateMany({
            where: { id: bookingId, user_id: req.user.id, payment_status: { not: 'paid' } },
            data: { payment_status: 'paid', payment_mode: 'online', updated_at: new Date() },
          });
        }
      }

      return res.json({ success: true, data: { status, paid } });
    } catch (error) {
      logger.error('Cashfree verifyPayment error:', error?.message, error?.body || '');
      return res.status(500).json({ success: false, message: error?.message || 'Failed to verify payment' });
    }
  }

  /**
   * ONBOARD VENDOR (Spotter) — creates/updates the spotter's Easy Split vendor.
   */
  static async onboardVendor(req, res) {
    try {
      if (!req.user.role || req.user.role.toLowerCase() !== 'spotter') {
        return res.status(403).json({ success: false, message: 'Only spotters can set up payouts' });
      }

      const { pan, upi_id, account_number, ifsc, name } = req.body;
      if (!pan || !/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(String(pan).trim())) {
        return res.status(400).json({ success: false, message: 'A valid PAN is required' });
      }

      const user = await prisma.users.findUnique({ where: { id: req.user.id } });
      const vendorId = `spotter_${req.user.id}`;

      const payload = {
        vendorId,
        name: user.full_name || user.name,
        email: user.email,
        phone: user.phone || '9999999999',
        pan: String(pan).trim().toUpperCase(),
      };
      if (upi_id) {
        if (!String(upi_id).includes('@')) {
          return res.status(400).json({ success: false, message: 'Invalid UPI ID' });
        }
        payload.upi = { vpa: upi_id };
      } else if (account_number && ifsc) {
        payload.bank = { accountNumber: account_number, ifsc: String(ifsc).toUpperCase(), accountHolder: name || user.name };
      } else {
        return res.status(400).json({ success: false, message: 'Provide a UPI ID or bank account + IFSC' });
      }

      const result = await Cashfree.createVendor(payload);

      await prisma.users.update({
        where: { id: req.user.id },
        data: {
          cashfree_vendor_id: vendorId,
          cashfree_vendor_status: result?.status || 'CREATED',
        },
      });

      return res.json({
        success: true,
        message: 'Payout account submitted',
        data: { vendor_id: vendorId, status: result?.status || 'CREATED' },
      });
    } catch (error) {
      logger.error('Cashfree onboardVendor error:', error?.message, error?.body || '');
      // Surface Cashfree's own validation message if present.
      const msg = error?.body?.message || error?.message || 'Failed to set up payout account';
      return res.status(400).json({ success: false, message: msg });
    }
  }

  /**
   * VENDOR STATUS (Spotter) — is their payout account active yet?
   */
  static async vendorStatus(req, res) {
    try {
      const user = await prisma.users.findUnique({
        where: { id: req.user.id },
        select: { cashfree_vendor_id: true, cashfree_vendor_status: true },
      });
      if (!user?.cashfree_vendor_id) {
        return res.json({ success: true, data: { is_setup: false } });
      }
      let live = null;
      try {
        const v = await Cashfree.getVendor(user.cashfree_vendor_id);
        live = v?.status || null;
        if (live && live !== user.cashfree_vendor_status) {
          await prisma.users.update({ where: { id: req.user.id }, data: { cashfree_vendor_status: live } });
        }
      } catch (e) { /* non-fatal — fall back to stored status */ }

      return res.json({
        success: true,
        data: {
          is_setup: true,
          vendor_id: user.cashfree_vendor_id,
          status: live || user.cashfree_vendor_status,
          is_active: (live || user.cashfree_vendor_status) === 'ACTIVE',
        },
      });
    } catch (error) {
      logger.error('Cashfree vendorStatus error:', error?.message);
      return res.status(500).json({ success: false, message: 'Failed to fetch vendor status' });
    }
  }
}

module.exports = CashfreeController;
