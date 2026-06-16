const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class AnalyticsController {

  static async getSpotterAnalytics(req, res) {
    try {
      const { spotterId } = req.params;

      if (req.user.role !== 'spotter' || req.user.id != spotterId) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }

      const summaryResult = await prisma.$queryRaw`
        SELECT 
          COUNT(b.id) FILTER (WHERE b.status = 'completed') AS total_completed_bookings,
          COUNT(b.id) AS total_bookings,
          COALESCE(SUM(b.total_price) FILTER (WHERE b.status = 'completed'),0) AS total_revenue,
          COALESCE(SUM(b.spotter_earning) FILTER (WHERE b.status = 'completed'),0) AS total_earnings,
          COALESCE(SUM(b.platform_fee) FILTER (WHERE b.status = 'completed'),0) AS total_platform_commission,
          COALESCE(SUM(b.spotter_earning) FILTER (
            WHERE b.status = 'completed' AND DATE(b.created_at) = CURRENT_DATE
          ),0) AS today_earnings,
          COALESCE(SUM(b.hours) FILTER (WHERE b.status = 'completed'),0) AS total_hours
         FROM bookings b
         JOIN parking_spots ps ON b.spot_id = ps.id
         WHERE ps.spotter_id = ${parseInt(spotterId)}
      `;

      const spotBreakdown = await prisma.$queryRaw`
        SELECT 
          ps.id AS spot_id,
          ps.location_type,
          COUNT(b.id) FILTER (WHERE b.status = 'completed') AS total_bookings,
          COALESCE(SUM(b.spotter_earning),0) AS total_earnings
         FROM bookings b
         JOIN parking_spots ps ON b.spot_id = ps.id
         WHERE ps.spotter_id = ${parseInt(spotterId)}
         AND b.status = 'completed'
         GROUP BY ps.id, ps.location_type
         ORDER BY total_earnings DESC
      `;

      res.json({
        success: true,
        data: {
          summary: summaryResult[0],
          spot_breakdown: spotBreakdown
        }
      });

    } catch (error) {
      logger.error("Analytics Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch analytics",
        error: error.message
      });
    }
  }

  static async getPlatformAnalytics(req, res) {
    try {
      const summary = await prisma.$queryRaw`
        SELECT
          COUNT(id) FILTER (WHERE status = 'completed') AS total_completed_bookings,
          COUNT(id) AS total_bookings,
          COALESCE(SUM(total_price),0) AS total_revenue,
          COALESCE(SUM(platform_fee),0) AS platform_earnings,
          COALESCE(SUM(spotter_earning),0) AS spotter_payout
        FROM bookings
      `;

      const monthlyRevenue = await prisma.$queryRaw`
        SELECT
          DATE_TRUNC('month', created_at) AS month,
          COALESCE(SUM(platform_fee),0) AS platform_revenue
        FROM bookings
        WHERE status = 'completed'
        GROUP BY month
        ORDER BY month
      `;

      res.json({
        success: true,
        data: {
          summary: summary[0],
          monthly_revenue: monthlyRevenue
        }
      });

    } catch (error) {
      logger.error("Platform analytics error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch platform analytics"
      });
    }
  }

  static async getTopSpotters(req, res) {
    try {
      const result = await prisma.$queryRaw`
        SELECT 
          ps.spotter_id,
          COUNT(b.id) AS total_bookings,
          COALESCE(SUM(b.spotter_earning),0) AS total_earnings,
          COALESCE(SUM(b.platform_fee),0) AS platform_revenue
        FROM bookings b
        JOIN parking_spots ps ON b.spot_id = ps.id
        WHERE b.status = 'completed'
        GROUP BY ps.spotter_id
        ORDER BY total_earnings DESC
        LIMIT 10
      `;

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      logger.error("Top spotters error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch top spotters"
      });
    }
  }
}

module.exports = AnalyticsController;