const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class Location {
  /**
   * ✅ CREATE OR UPDATE USER LOCATION
   */
  static async createOrUpdate({ user_id, latitude, longitude }) {
    try {
      // We use upsert or find then create/update. 
      // Since a user usually has only one "current" location record:
      const existing = await prisma.locations.findFirst({
        where: { user_id: parseInt(user_id) }
      });

      if (existing) {
        return await prisma.locations.update({
          where: { id: existing.id },
          data: {
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude),
            updated_at: new Date()
          }
        });
      } else {
        return await prisma.locations.create({
          data: {
            user_id: parseInt(user_id),
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude)
          }
        });
      }
    } catch (error) {
      logger.error('Error in Location.createOrUpdate:', error);
      throw error;
    }
  }

  /**
   * ✅ FIND BY USER ID
   */
  static async findByUser(userId) {
    try {
      return await prisma.locations.findFirst({
        where: { user_id: parseInt(userId) },
        orderBy: { updated_at: 'desc' }
      });
    } catch (error) {
      logger.error('Error in Location.findByUser:', error);
      throw error;
    }
  }
}

module.exports = Location;
