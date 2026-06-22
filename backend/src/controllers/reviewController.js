const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class ReviewController {

  // POST /reviews — Finder submits review after booking completes
  static async createReview(req, res) {
    try {
      const { booking_id, rating, comment } = req.body;
      const finderId = req.user.id;

      if (req.user.role.toLowerCase() !== 'finder') {
        return res.status(403).json({ success: false, message: 'Only finders can leave reviews' });
      }

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ success: false, message: 'Rating must be between 1 and 5' });
      }

      // Verify this booking belongs to this finder and is completed
      const booking = await prisma.bookings.findFirst({
        where: { id: parseInt(booking_id), user_id: finderId, status: 'completed' },
        include: { parking_spots: true }
      });

      if (!booking) {
        return res.status(404).json({ success: false, message: 'Completed booking not found' });
      }

      // Check if already reviewed
      const existing = await prisma.reviews.findUnique({ where: { booking_id: parseInt(booking_id) } });
      if (existing) {
        return res.status(400).json({ success: false, message: 'You have already reviewed this booking' });
      }

      const review = await prisma.reviews.create({
        data: {
          booking_id: parseInt(booking_id),
          reviewer_id: finderId,
          spotter_id: booking.parking_spots.spotter_id,
          spot_id: booking.spot_id,
          rating: parseInt(rating),
          comment: comment || null
        }
      });

      res.status(201).json({ success: true, data: review });
    } catch (error) {
      logger.error('Create review error:', error);
      res.status(500).json({ success: false, message: 'Failed to submit review' });
    }
  }

  // GET /reviews/spot/:spotId — Get reviews for a spot
  static async getSpotReviews(req, res) {
    try {
      const { spotId } = req.params;
      const reviews = await prisma.reviews.findMany({
        where: { spot_id: parseInt(spotId) },
        include: { reviewer: { select: { name: true, full_name: true } } },
        orderBy: { created_at: 'desc' },
        take: 20
      });

      const avg = await prisma.reviews.aggregate({
        where: { spot_id: parseInt(spotId) },
        _avg: { rating: true },
        _count: true
      });

      res.json({
        success: true,
        data: {
          reviews,
          average_rating: avg._avg.rating ? Number(avg._avg.rating.toFixed(1)) : null,
          total_reviews: avg._count
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch reviews' });
    }
  }
}

module.exports = ReviewController;
