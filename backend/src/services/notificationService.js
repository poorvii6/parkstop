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

  /**
   * Poll Expo push receipts (best-effort) and prune any tokens that come back
   * as DeviceNotRegistered. Receipts may not be ready instantly, so this is a
   * light follow-up; ticket-level errors are already handled at send time.
   */
  static async checkReceipts(receiptIdToToken) {
    const ids = Object.keys(receiptIdToToken);
    if (ids.length === 0) return;
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const json = await res.json();
      const receipts = json?.data || {};
      for (const [receiptId, receipt] of Object.entries(receipts)) {
        if (receipt?.status === 'error' && receipt?.details?.error === 'DeviceNotRegistered') {
          await this.pruneToken(receiptIdToToken[receiptId]);
        }
      }
    } catch (e) {
      logger.warn(`Receipt check failed: ${e.message}`);
    }
  }

  /**
   * Send a push notification to ALL of a user's devices via Expo Push Service.
   * Handles dead-token pruning (ticket + receipt level) so delivery stays clean.
   */
  static async sendPushNotification(userId, { title, body, data }) {
    try {
      const tokens = await this.getUserPushTokens(userId);
      if (tokens.length === 0) {
        logger.info(`No valid push token registered for user ${userId}`);
        return;
      }

      // One message per device (Expo accepts an array in a single request).
      const messages = tokens.map((to) => ({
        to,
        title,
        body,
        data: data || {},
        sound: 'default',
        priority: 'high',
        channelId: 'default',
      }));

      logger.info(`Sending push to user ${userId} across ${tokens.length} device(s)...`);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(messages),
      });
      const result = await response.json();

      // Expo returns a ticket per message, in the same order we sent them.
      const tickets = Array.isArray(result?.data) ? result.data : [];
      const receiptIdToToken = {};
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i];
        const token = tokens[i];
        if (ticket?.status === 'error') {
          logger.warn(`Push ticket error for user ${userId}: ${ticket?.message}`);
          if (ticket?.details?.error === 'DeviceNotRegistered') {
            await this.pruneToken(token); // token is dead — stop sending to it
          }
        } else if (ticket?.status === 'ok' && ticket?.id) {
          receiptIdToToken[ticket.id] = token;
        }
      }

      // Best-effort receipt follow-up to catch failures that surface later.
      // (For production scale, move this to a scheduled job ~15 min later.)
      if (Object.keys(receiptIdToToken).length > 0) {
        setTimeout(() => {
          this.checkReceipts(receiptIdToToken).catch(() => {});
        }, 8000);
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
}

module.exports = NotificationService;