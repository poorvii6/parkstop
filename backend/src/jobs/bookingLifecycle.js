const db = require('../config/database');
const logger = require('../utils/logger');

const Booking = require('../models/Booking');

function startLifecycleJob() {
  setInterval(async () => {
    try {
      logger.info('Running booking lifecycle job...');

      // 1. Expire OTP bookings safely (releases spot!)
      const expiredBookings = await db.query(`
        SELECT id FROM bookings
        WHERE status = 'reserved'
          AND otp_expires_at < NOW()
      `);
      
      for (const row of expiredBookings.rows) {
        try {
          await Booking.expire(row.id);
          logger.info(`System automatically expired booking ${row.id}`);
        } catch(err) {
          logger.error(`Failed to expire booking ${row.id}:`, err);
        }
      }

      // 2. Overstay Monitoring (Flag bookings 20+ mins past end_time)
      const overstayBookings = await db.query(`
        SELECT id, user_id FROM bookings
        WHERE status = 'active'
          AND end_time + interval '20 minutes' < NOW()
          AND (payment_status != 'flagged_overstay' OR payment_status IS NULL)
      `);

      for (const row of overstayBookings.rows) {
        try {
          await db.query(`
            UPDATE bookings 
            SET payment_status = 'flagged_overstay' 
            WHERE id = $1
          `, [row.id]);
          logger.warn(`Booking ${row.id} flagged for overstay charges (20+ mins past limit)`);
          // Note: In production, this would trigger a notification to the user/spotter
        } catch (err) {
          logger.error(`Failed to flag overstay for booking ${row.id}:`, err);
        }
      }

    } catch (error) {
      logger.error('Lifecycle job error:', error);
    }
  }, 60000); // every 1 min
}

module.exports = startLifecycleJob;