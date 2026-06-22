const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class DisputeController {

  static async createDispute(req, res) {
    try {
      const { booking_id, reason, description } = req.body;
      const userId = req.user.id;

      const booking = await prisma.bookings.findFirst({
        where: {
          id: parseInt(booking_id),
          OR: [
            { user_id: userId },
            { parking_spots: { spotter_id: userId } }
          ]
        }
      });

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Booking not found or not authorized' });
      }

      // Check if already disputed
      const existing = await prisma.disputes.findUnique({ where: { booking_id: parseInt(booking_id) } });
      if (existing) {
        return res.status(400).json({ success: false, message: 'A dispute has already been raised for this booking' });
      }

      // Store dispute in a new table (add to schema)
      const dispute = await prisma.disputes.create({
        data: {
          booking_id: parseInt(booking_id),
          raised_by: userId,
          reason,
          description,
          status: 'open'
        }
      });

      res.status(201).json({
        success: true,
        message: 'Dispute raised. Our team will review within 24 hours.',
        data: dispute
      });
    } catch (error) {
      logger.error('Create dispute error:', error);
      res.status(500).json({ success: false, message: 'Failed to raise dispute' });
    }
  }
}

module.exports = DisputeController;
