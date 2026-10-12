const prisma = require('../config/prisma');
const logger = require('../utils/logger');

class User {

  static async create({ email, name, phone, role, firebase_uid }) {
    try {
      const user = await prisma.users.create({
        data: {
          email,
          full_name: name,
          name: name,
          phone: phone || '',
          role: role.toUpperCase(),
          firebase_uid,
          is_finder_registered: role.toUpperCase() === 'FINDER',
          is_spotter_registered: role.toUpperCase() === 'SPOTTER'
        },
        select: {
          id: true,
          email: true,
          full_name: true,
          phone: true,
          role: true,
          created_at: true,
          firebase_uid: true
        }
      });

      return { ...user, name: user.full_name };
    } catch (error) {
      logger.error('Error creating user:', error);
      throw error;
    }
  }

  static async findByEmail(email) {
    const user = await prisma.users.findUnique({
      where: { email }
    });
    if (!user) return null;
    return { ...user, name: user.full_name };
  }

  static async findById(id) {
    const user = await prisma.users.findUnique({
      where: { id: parseInt(id) },
      select: {
        id: true,
        email: true,
        full_name: true,
        phone: true,
        role: true,
        address: true,
        dob: true,
        created_at: true,
        balance: true,
        upi_id: true,
        bank_account_number: true,
        bank_ifsc: true,
        bank_account_name: true,
        payout_mode: true,
        is_finder_registered: true,
        is_spotter_registered: true,
        firebase_uid: true
      }
    });
    if (!user) return null;
    return { ...user, name: user.full_name };
  }

  static async update(id, updates) {
    const { name, phone, address, dob, upi_id, bank_account_number, bank_ifsc, bank_account_name, payout_mode, is_finder_registered, is_spotter_registered } = updates;
    const updateData = {};
    if (name) { updateData.full_name = name; updateData.name = name; }
    if (phone) updateData.phone = phone;
    if (address) updateData.address = address;
    if (dob) updateData.dob = dob;
    if (upi_id !== undefined) updateData.upi_id = upi_id;
    if (bank_account_number !== undefined) updateData.bank_account_number = bank_account_number;
    if (bank_ifsc !== undefined) updateData.bank_ifsc = bank_ifsc;
    if (bank_account_name !== undefined) updateData.bank_account_name = bank_account_name;
    if (payout_mode !== undefined) updateData.payout_mode = payout_mode;
    if (is_finder_registered !== undefined) updateData.is_finder_registered = is_finder_registered;
    if (is_spotter_registered !== undefined) updateData.is_spotter_registered = is_spotter_registered;

    const user = await prisma.users.update({
      where: { id: parseInt(id) },
      data: updateData,
      select: {
        id: true,
        email: true,
        full_name: true,
        phone: true,
        address: true,
        dob: true,
        role: true,
        upi_id: true,
        payout_mode: true,
        balance: true,
        is_finder_registered: true,
        is_spotter_registered: true,
        firebase_uid: true
      }
    });

    return { ...user, name: user.full_name };
  }

  static async getStats(userId, role) {
    try {
      const normalizedRole = role ? role.toLowerCase() : '';
      
      if (normalizedRole === 'finder') {
        const bookings = await prisma.bookings.findMany({
          where: { user_id: parseInt(userId) }
        });

        const total_spent = bookings
          .filter(b => b.status === 'completed')
          .reduce((sum, b) => sum + Number(b.total_price || 0), 0);

        return {
          total_bookings: bookings.length,
          completed_bookings: bookings.filter(b => b.status === 'completed').length,
          active_bookings: bookings.filter(b => b.status === 'active').length,
          cancelled_bookings: bookings.filter(b => b.status === 'cancelled').length,
          total_spent
        };
      }

      if (normalizedRole === 'spotter') {
        const spots = await prisma.parking_spots.findMany({
          where: { spotter_id: parseInt(userId) },
          include: {
            bookings: true
          }
        });

        let total_bookings = 0;
        let total_earnings = 0;

        spots.forEach(spot => {
          total_bookings += spot.bookings.length;
          total_earnings += spot.bookings
            .filter(b => b.status === 'completed')
            .reduce((sum, b) => sum + Number(b.total_price || 0), 0);
        });

        return {
          total_spots: spots.length,
          total_bookings,
          total_earnings
        };
      }

      return null;
    } catch (error) {
      logger.error('Error getting user stats:', error);
      throw error;
    }
  }
}

module.exports = User;