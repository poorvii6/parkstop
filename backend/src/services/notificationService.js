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
   * Send push notification via Expo Push Service
   */
  static async sendPushNotification(userId, { title, body, data }) {
    try {
      const user = await prisma.users.findUnique({
        where: { id: parseInt(userId) },
        select: { push_token: true }
      });

      if (!user || !user.push_token) {
        logger.info(`No push token registered for user ${userId}`);
        return;
      }

      const expoToken = user.push_token;
      if (!expoToken.startsWith('ExponentPushToken[')) {
        logger.warn(`Invalid Expo Push Token format for user ${userId}: ${expoToken}`);
        return;
      }

      logger.info(`Sending push notification to user ${userId} (${expoToken})...`);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          to: expoToken,
          title,
          body,
          data: data || {},
          sound: 'default',
          priority: 'high',
        }),
      });

      const result = await response.json();
      logger.info(`Expo push notification result for user ${userId}: ${JSON.stringify(result)}`);
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

    // 3. Send system push notification
    const otp = booking.otp_code || booking.otp || '';
    await this.sendPushNotification(spotterId, {
      title: 'New Booking Request 🚗',
      body: `${finderName} booked your spot. OTP: ${otp}`,
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
      body: `Your reservation is confirmed. OTP: ${otp}`,
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