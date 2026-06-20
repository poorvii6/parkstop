const prisma = require('../config/prisma');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

class User {

  static async create({ email, password, name, phone, role }) {
    try {
      const hashedPassword = await bcrypt.hash(password, 10);

      const user = await prisma.users.create({
        data: {
          email,
          password: hashedPassword,
          full_name: name,
          name: name, // Maintain both for compatibility
          phone,
          role
        },
        select: {
          id: true,
          email: true,
          full_name: true,
          phone: true,
          role: true,
          created_at: true
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
        balance: true
      }
    });
    if (!user) return null;
    return { ...user, name: user.full_name };
  }

  static async verifyPassword(plainPassword, hashedPassword) {
    return bcrypt.compare(plainPassword, hashedPassword);
  }

  static async update(id, updates) {
    const { name, phone, address, dob, upi_id, bank_account_number, bank_ifsc, bank_account_name, payout_mode } = updates;
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
        balance: true
      }
    });

    return { ...user, name: user.full_name };
  }

  static async changePassword(id, oldPassword, newPassword) {
    const user = await prisma.users.findUnique({
      where: { id: parseInt(id) },
      select: { id: true, password: true }
    });

    if (!user) throw new Error('User not found');

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) throw new Error('Current password is incorrect');

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.users.update({
      where: { id: parseInt(id) },
      data: { password: hashedPassword }
    });

    return true;
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