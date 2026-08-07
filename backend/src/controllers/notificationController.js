const prisma = require('../config/prisma');
const logger = require('../utils/logger');

/**
 * In-app notification history + quiet-hours preferences.
 * Push delivery itself lives in services/notificationService.js; this exposes
 * the stored history and the user's notification settings.
 */
class NotificationController {
  // GET /notifications — the user's recent notifications + unread count.
  static async list(req, res) {
    try {
      const items = await prisma.notifications.findMany({
        where: { user_id: req.user.id },
        orderBy: { created_at: 'desc' },
        take: 50,
      });
      const unread = await prisma.notifications.count({
        where: { user_id: req.user.id, read: false },
      });
      res.json({ success: true, data: { items, unread } });
    } catch (error) {
      logger.error('List notifications error:', error);
      res.status(500).json({ success: false, message: 'Failed to load notifications' });
    }
  }

  // POST /notifications/read — mark all (or a given list of ids) as read.
  static async markRead(req, res) {
    try {
      const { ids } = req.body || {};
      const where = { user_id: req.user.id, read: false };
      if (Array.isArray(ids) && ids.length) {
        where.id = { in: ids.map((n) => parseInt(n)).filter((n) => !Number.isNaN(n)) };
      }
      await prisma.notifications.updateMany({ where, data: { read: true } });
      res.json({ success: true });
    } catch (error) {
      logger.error('Mark notifications read error:', error);
      res.status(500).json({ success: false, message: 'Failed to update notifications' });
    }
  }

  // GET /notifications/preferences — current quiet-hours window.
  static async getPreferences(req, res) {
    try {
      const u = await prisma.users.findUnique({
        where: { id: req.user.id },
        select: { quiet_hours_start: true, quiet_hours_end: true },
      });
      res.json({
        success: true,
        data: {
          quiet_hours_start: u?.quiet_hours_start ?? null,
          quiet_hours_end: u?.quiet_hours_end ?? null,
        },
      });
    } catch (error) {
      logger.error('Get notification prefs error:', error);
      res.status(500).json({ success: false, message: 'Failed to load preferences' });
    }
  }

  // PUT /notifications/preferences — set quiet hours (0-23; null/empty disables).
  static async updatePreferences(req, res) {
    try {
      const norm = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = parseInt(v);
        if (Number.isNaN(n)) return null;
        return Math.max(0, Math.min(23, n));
      };
      const quiet_hours_start = norm(req.body?.quiet_hours_start);
      const quiet_hours_end = norm(req.body?.quiet_hours_end);
      await prisma.users.update({
        where: { id: req.user.id },
        data: { quiet_hours_start, quiet_hours_end },
      });
      res.json({ success: true, data: { quiet_hours_start, quiet_hours_end } });
    } catch (error) {
      logger.error('Update notification prefs error:', error);
      res.status(500).json({ success: false, message: 'Failed to save preferences' });
    }
  }
}

module.exports = NotificationController;
