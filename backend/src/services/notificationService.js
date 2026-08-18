const logger = require('../utils/logger');
const { emitToUser } = require('../config/socket');
const prisma = require('../config/prisma');

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
   * Collect every valid Expo push token for a user (all their devices).
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

    // De-duplicate and keep only well-formed Expo tokens.
    return [...new Set(tokens)].filter((t) => typeof t === 'string' && t.startsWith('ExponentPushToken['));
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

  /** Delete a token that Expo told us is no longer valid (uninstalled app, etc.). */
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
   * POST JSON to Expo with ONE retry on a transient failure (network blip,
   * Expo hiccup). Without this a single failed fetch silently dropped the push.
   */
  static async expoPost(url, payload) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload),
        });
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1000)); // brief backoff, then retry once
      }
    }
    throw lastErr;
  }

  /**
   * Durably schedule a receipt check. Expo receipts may not be ready for several
   * minutes, and a bare setTimeout dies if the server restarts — so when a real
   * (BullMQ) queue is available we enqueue a DELAYED job; otherwise we fall back
   * to an in-process timer.
   */
  static scheduleReceiptCheck(receiptIdToToken) {
    if (!receiptIdToToken || Object.keys(receiptIdToToken).length === 0) return;
    try {
      const { notificationQueue, queueMode } = require('../jobs/queues');
      if (queueMode === 'bullmq' && notificationQueue?.add) {
        notificationQueue.add('check-receipts', { receiptIdToToken }, { delay: 90000 }).catch(() => {});
        return;
      }
    } catch (_) {
      // queue not available — fall through to the timer
    }
    setTimeout(() => { this.checkReceipts(receiptIdToToken).catch(() => {}); }, 15000);
  }

  /**
   * Poll Expo push receipts and prune any tokens that come back as
   * DeviceNotRegistered. Ticket-level errors are already handled at send time;
   * this catches failures that only surface later.
   */
  static async checkReceipts(receiptIdToToken) {
    const ids = Object.keys(receiptIdToToken || {});
    if (ids.length === 0) return;
    try {
      // getReceipts accepts up to 1000 ids per request.
      for (const idChunk of this.chunk(ids, 1000)) {
        const json = await this.expoPost('https://exp.host/--/api/v2/push/getReceipts', { ids: idChunk });
        const receipts = json?.data || {};
        for (const [receiptId, receipt] of Object.entries(receipts)) {
          if (receipt?.status === 'error' && receipt?.details?.error === 'DeviceNotRegistered') {
            await this.pruneToken(receiptIdToToken[receiptId]);
          }
        }
      }
    } catch (e) {
      logger.warn(`Receipt check failed: ${e.message}`);
    }
  }

  /**
   * Send a push notification to ALL of a user's devices via Expo Push Service.
   * Chunks at Expo's 100-per-request limit, retries transient send failures,
   * and prunes dead tokens (ticket + receipt level) so delivery stays clean.
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

      logger.info(`Sending push to user ${userId} across ${tokens.length} device(s)...`);

      const receiptIdToToken = {};
      // Expo accepts up to 100 messages per request — chunk to stay within it.
      for (const tokenChunk of this.chunk(tokens, 100)) {
        const messages = tokenChunk.map((to) => ({
          to,
          title,
          body,
          data: data || {},
          sound: 'default',
          priority: 'high',
          channelId: 'default',
        }));

        let result;
        try {
          result = await this.expoPost('https://exp.host/--/api/v2/push/send', messages);
        } catch (e) {
          logger.error(`Expo push send failed for user ${userId} after retry: ${e.message}`);
          continue; // don't let one failed chunk abort the rest
        }

        // Expo returns a ticket per message, in the same order we sent them.
        const tickets = Array.isArray(result?.data) ? result.data : [];
        for (let i = 0; i < tickets.length; i++) {
          const ticket = tickets[i];
          const token = tokenChunk[i];
          if (ticket?.status === 'error') {
            logger.warn(`Push ticket error for user ${userId}: ${ticket?.message}`);
            if (ticket?.details?.error === 'DeviceNotRegistered') {
              await this.pruneToken(token); // token is dead — stop sending to it
            }
          } else if (ticket?.status === 'ok' && ticket?.id) {
            receiptIdToToken[ticket.id] = token;
          }
        }
      }

      // Durable follow-up to catch failures that surface after the ticket.
      this.scheduleReceiptCheck(receiptIdToToken);
    } catch (error) {
      logger.error(`Error sending push notification to user ${userId}:`, error);
    }
  }

  /**
   * Notify spotter of new booking
   */
  static async notifyNewBooking(spotterId, booking) {
    // 1. Emit direct socket event that spotter expects
    emitToUser(spotterId, 'booking:new', booking);

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
   * Notify spotter that finder is nearby
   */
  static async notifyFinderNearby(spotterId, booking, distance) {
    const finderName = booking.finder_name || 'A driver';
    const formattedDist = Number(distance).toFixed(1);

    await this.sendNotification(spotterId, {
      title: 'Finder Nearby',
      message: `${finderName} is ${formattedDist}km away`,
      type: 'finder_nearby',
      data: { bookingId: booking.id },
    });

    await this.sendPushNotification(spotterId, {
      title: 'Driver is Nearby! 📍',
      body: `${finderName} is ${formattedDist}km away. Prepare for arrival.`,
      data: { bookingId: booking.id, type: 'finder_nearby' },
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