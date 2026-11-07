const logger = require('../utils/logger');
const { emitToUser } = require('../config/socket');
const prisma = require('../config/prisma');
const firebase = require('../config/firebase');

class NotificationService {
  /**
   * Send push notification via Socket.io (In-app WebSocket)
   */
  static async sendNotification(userId, notification) {
    try {
      emitToUser(userId, 'notification', notification);
      logger.info(`Notification sent to user ${userId} via socket: ${notification.title}`);
    } catch (error) {
      logger.error('Error sending socket notification:', error);
    }
  }

  /**
   * Collect every valid push token for a user (all their devices).
   * Falls back to the legacy users.push_token if the device_tokens table has
   * nothing yet (e.g. right after deploy, before the app re-registers).
   */
  static async getUserPushTokens(userId) {
    const uid = parseInt(userId);
    let tokens = [];
    try {
      const rows = await prisma.device_tokens.findMany({
        where: { user_id: uid },
        select: { token: true },
      });
      tokens = rows.map((r) => r.token);
    } catch (e) {
      logger.warn(`device_tokens lookup failed for user ${userId}: ${e.message}`);
    }

    if (tokens.length === 0) {
      const user = await prisma.users.findUnique({
        where: { id: uid },
        select: { push_token: true },
      });
      if (user?.push_token) tokens = [user.push_token];
    }

    // De-duplicate, then drop any token left over from the Expo push
    // service. Those are Expo's own identifiers, meaningless to Firebase, so
    // they are deleted here rather than sent and rejected: every device
    // registers a real FCM token the next time the app opens, so the change
    // of provider heals itself without a migration.
    const unique = [...new Set(tokens)].filter((t) => typeof t === 'string' && t.length > 0);
    const stale = unique.filter((t) => t.startsWith('ExponentPushToken[') || t.startsWith('ExpoPushToken['));
    for (const t of stale) await this.pruneToken(t);
    return unique.filter((t) => !stale.includes(t));
  }

  /** Save a notification to history so the user can see missed ones in-app. */
  static async persistNotification(userId, { title, body, data }) {
    try {
      await prisma.notifications.create({
        data: {
          user_id: parseInt(userId),
          title: title || '',
          body: body || null,
          type: data?.type || null,
          data: data || undefined,
        },
      });
    } catch (e) {
      // Table may not exist yet (pre-migration) — never block delivery on this.
      logger.warn(`persistNotification skipped for user ${userId}: ${e.message}`);
    }
  }

  /**
   * True if the user is currently within their configured quiet hours, so we
   * suppress the push (history + socket still fire). Uses IST, the app's user
   * base; a prefs lookup failure never blocks delivery.
   */
  static async isUserQuiet(userId) {
    try {
      const u = await prisma.users.findUnique({
        where: { id: parseInt(userId) },
        select: { quiet_hours_start: true, quiet_hours_end: true },
      });
      const s = u?.quiet_hours_start;
      const e = u?.quiet_hours_end;
      if (s == null || e == null || s === e) return false;
      const istHour = new Date(Date.now() + (5 * 60 + 30) * 60000).getUTCHours();
      // Handles overnight ranges (e.g. 22 -> 7).
      return s < e ? (istHour >= s && istHour < e) : (istHour >= s || istHour < e);
    } catch (_) {
      return false;
    }
  }

  /** Delete a token Firebase reports as dead (app uninstalled, data cleared). */
  static async pruneToken(token) {
    try {
      await prisma.device_tokens.deleteMany({ where: { token } });
      // also clear the legacy column if it points at this dead token
      await prisma.users.updateMany({ where: { push_token: token }, data: { push_token: null } });
      logger.info(`Pruned dead push token: ${token}`);
    } catch (e) {
      logger.warn(`Failed to prune token ${token}: ${e.message}`);
    }
  }

  /** Split an array into fixed-size chunks. */
  static chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /**
   * Send a push notification to ALL of a user's devices via Firebase Cloud
   * Messaging.
   *
   * FCM is the only route to an Android phone, so this talks to it directly
   * rather than through a middleman: fewer parties handling the message, one
   * less service that can be down, and no extra credential — the same Firebase
   * service account that verifies sign-ins sends these.
   *
   * Unlike the receipt-polling it replaces, FCM reports a dead token in the
   * send response, so pruning happens immediately and there is nothing to
   * follow up later.
   */
  static async sendPushNotification(userId, { title, body, data }) {
    try {
      // Always record to history (best-effort), even if the push is suppressed.
      await this.persistNotification(userId, { title, body, data });

      // Respect quiet hours: skip the actual push (the in-app socket + history
      // still deliver it, so nothing is lost — it just won't buzz the phone).
      if (await this.isUserQuiet(userId)) {
        logger.info(`Quiet hours active for user ${userId} — push suppressed (saved to history).`);
        return;
      }

      const tokens = await this.getUserPushTokens(userId);
      if (tokens.length === 0) {
        logger.info(`No valid push token registered for user ${userId}`);
        return;
      }

      const messaging = firebase.messaging;
      if (!messaging) {
        logger.warn(`Firebase messaging unavailable — push to user ${userId} skipped (saved to history).`);
        return;
      }

      // FCM requires every data value to be a string.
      const payload = {};
      for (const [k, v] of Object.entries(data || {})) {
        payload[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }

      logger.info(`Sending push to user ${userId} across ${tokens.length} device(s)...`);

      // FCM accepts up to 500 tokens per multicast.
      for (const tokenChunk of this.chunk(tokens, 500)) {
        let res;
        try {
          res = await messaging.sendEachForMulticast({
            tokens: tokenChunk,
            notification: { title, body },
            data: payload,
            android: {
              priority: 'high',
              notification: { channelId: 'default', sound: 'default' },
            },
          });
        } catch (e) {
          logger.error(`FCM send failed for user ${userId}: ${e.message}`);
          continue; // don't let one failed chunk abort the rest
        }

        // One response per token, in the order sent.
        for (let i = 0; i < res.responses.length; i++) {
          const r = res.responses[i];
          if (r.success) continue;
          const code = r.error?.code || 'unknown';
          logger.warn(`Push failed for user ${userId} (${code}): ${r.error?.message || ''}`);
          // These mean the token will never work again, as opposed to a
          // transient failure worth retrying on the next notification.
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token' ||
            code === 'messaging/invalid-argument'
          ) {
            await this.pruneToken(tokenChunk[i]);
          }
        }
      }
    } catch (error) {
      logger.error(`Error sending push notification to user ${userId}:`, error);
    }
  }

  /**
   * Notify spotter of new booking
   */
  static async notifyNewBooking(spotterId, booking) {
    // 1. Emit direct socket event that spotter expects
    // Without the driver's entry/exit codes (see Booking.forOwner).
    const { otp_code, checkout_otp, ...ownerView } = booking || {};
    emitToUser(spotterId, 'booking:new', ownerView);

    // 2. Emit generic socket notification
    const finderName = booking.finder_name || 'A driver';
    await this.sendNotification(spotterId, {
      title: 'New Booking',
      message: `${finderName} booked your spot`,
      type: 'new_booking',
      data: { bookingId: booking.id },
    });

    // 3. Send system push notification (Do not expose OTP to the Spotter)
    await this.sendPushNotification(spotterId, {
      title: 'New Booking Request 🚗',
      body: `${finderName} booked your spot. Open the app to view details.`,
      data: { bookingId: booking.id, type: 'new_booking' },
    });
  }

  /**
   * Tell the owner a booking has been PAID.
   *
   * The owner needs this for two reasons. First, it is their money arriving
   * and they should not have to go looking for it. Second, it stops a double
   * charge: a driver can settle in the app at any point in a live booking,
   * and an owner who does not know that will hold up their own QR at the end.
   * createBookingQr does refuse an already-paid booking, but the two can race
   * -- a QR raised just before the app payment lands stays scannable, and the
   * second payment is money taken against a booking that has nothing left to
   * pay. Knowing early is what stops the QR being raised at all.
   *
   * @param {object} booking  needs id, total_price, advance_fee, hours,
   *                          start_time, end_time, slot_name
   * @param {object} spot     for the title
   * @param {number} amount   what was actually collected, in rupees
   */
  static async notifyBookingPaid(spotterId, booking, spot, amount) {
    if (!spotterId) return;

    const paid = Number(amount || 0).toFixed(2);
    const where = [spot?.title, booking?.slot_name].filter(Boolean).join(' · ') || 'your spot';

    // The window they are being paid for, in the owner's own terms.
    const fmt = (d) => {
      if (!d) return null;
      try {
        return new Date(d).toLocaleString('en-IN', {
          day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
        });
      } catch { return null; }
    };
    const from = fmt(booking?.start_time);
    const to = fmt(booking?.actual_end_time || booking?.end_time);
    const when = from && to ? `${from} to ${to}` : from || '';

    try {
      emitToUser(spotterId, 'booking:paid', {
        bookingId: booking?.id,
        amount: Number(paid),
        slot_name: booking?.slot_name || null,
        spot_title: spot?.title || null,
        start_time: booking?.start_time || null,
        end_time: booking?.actual_end_time || booking?.end_time || null,
      });
    } catch (e) {
      logger.warn(`booking:paid emit failed for booking ${booking?.id}: ${e?.message}`);
    }

    await this.sendNotification(spotterId, {
      title: 'Payment received',
      message: `\u20b9${paid} paid for ${where}${when ? ` (${when})` : ''}. Do not ask for payment again.`,
      type: 'booking_paid',
      data: { bookingId: booking?.id, amount: Number(paid) },
    });

    await this.sendPushNotification(spotterId, {
      title: `Paid \u20b9${paid} \ud83d\udcb0`,
      body: `${where}${when ? ` · ${when}` : ''} is settled. No need to collect anything.`,
      data: { bookingId: booking?.id, type: 'booking_paid', amount: Number(paid) },
    });
  }

  /**
   * Notify finder that booking is confirmed
   */
  static async notifyBookingConfirmed(finderId, booking) {
    const otp = booking.otp_code || booking.otp || '';
    
    await this.sendNotification(finderId, {
      title: 'Booking Confirmed',
      message: `Your parking spot is reserved. OTP: ${otp}`,
      type: 'booking_confirmed',
      data: { bookingId: booking.id, otp },
    });

    await this.sendPushNotification(finderId, {
      title: 'Parking Spot Reserved! ✅',
      body: `Your reservation is confirmed. Open the app to view your check-in OTP.`,
      data: { bookingId: booking.id, otp, type: 'booking_confirmed' },
    });
  }

  /**
   * Warn the finder that their reservation is about to lapse.
   *
   * Until now a hold simply vanished: the sweep flipped it to 'expired' and
   * released the slot, and the first the rider knew of it was arriving and
   * finding their OTP rejected. One nudge before the deadline turns a silent
   * failure into a decision they can still act on.
   */
  static async notifyBookingExpiringSoon(finderId, booking, minutesLeft) {
    await this.sendNotification(finderId, {
      title: 'Reservation expiring soon',
      message: `Check in within ${minutesLeft} minutes or your spot will be released.`,
      type: 'booking_expiring_soon',
      data: { bookingId: booking.id, minutesLeft },
    });

    await this.sendPushNotification(finderId, {
      title: 'Your spot is about to be released ⏳',
      body: `Check in within ${minutesLeft} minutes to keep this parking spot.`,
      data: { bookingId: booking.id, minutesLeft, type: 'booking_expiring_soon' },
    });
  }

  /**
   * Tell the finder their reservation has lapsed and the spot is back in the
   * pool, so they stop driving towards a spot that is no longer theirs.
   */
  static async notifyBookingExpired(finderId, booking, claimableRefund = 0) {
    // If they prepaid, the refund is the more important half of this message —
    // it is money they are owed and have to ask for, so burying it would mean
    // most people never claim.
    const hasRefund = Number(claimableRefund) > 0;

    await this.sendNotification(finderId, {
      title: 'Reservation expired',
      message: hasRefund
        ? `Your hold ran out and the spot was released. You can claim a ₹${claimableRefund} refund.`
        : 'Your hold ran out and the spot has been released.',
      type: 'booking_expired',
      data: { bookingId: booking.id, claimableRefund: Number(claimableRefund) || 0 },
    });

    await this.sendPushNotification(finderId, {
      title: 'Reservation expired',
      body: hasRefund
        ? `The spot was released. Tap to claim your ₹${claimableRefund} refund.`
        : 'Your hold ran out and the spot has been released. Tap to find another.',
      data: {
        bookingId: booking.id,
        claimableRefund: Number(claimableRefund) || 0,
        type: 'booking_expired',
      },
    });
  }
}

module.exports = NotificationService;