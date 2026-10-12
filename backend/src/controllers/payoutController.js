const logger = require('../utils/logger');
const prisma = require('../config/prisma');

class PayoutController {

  /**
   * 📊 GET PAYOUT ACCOUNT STATUS
   * Check if Spotter has set up their payout account.
   */
  static async getAccountStatus(req, res) {
    try {
      const user = await prisma.users.findUnique({
        where: { id: req.user.id },
        select: {
          upi_id: true,
          bank_account_number: true,
          bank_ifsc: true,
          bank_account_name: true,
          razorpay_contact_id: true,
          razorpay_fund_account_id: true,
          payout_mode: true,
          balance: true
        }
      });

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const isSetup = !!(user.razorpay_fund_account_id || user.upi_id || user.bank_account_number);

      // Mask sensitive data
      const maskedAccount = user.bank_account_number
        ? '****' + user.bank_account_number.slice(-4)
        : null;

      res.json({
        success: true,
        data: {
          is_setup: isSetup,
          payout_mode: user.payout_mode,
          upi_id: user.upi_id,
          bank_account: maskedAccount,
          bank_ifsc: user.bank_ifsc,
          bank_account_name: user.bank_account_name,
          has_razorpay_account: !!user.razorpay_fund_account_id,
          balance: user.balance
        }
      });
    } catch (error) {
      logger.error('Get Account Status error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch payout account status' });
    }
  }

  /**
   * 📜 GET PAYOUT HISTORY
   * Spotter views their payout history.
   */
  static async getPayoutHistory(req, res) {
    try {
      const payouts = await prisma.payouts.findMany({
        where: { user_id: req.user.id },
        orderBy: { created_at: 'desc' },
        take: 50
      });

      res.json({
        success: true,
        data: payouts.map(p => ({
          id: p.id,
          amount: p.amount,
          status: p.status,
          mode: p.mode,
          narration: p.narration,
          booking_id: p.booking_id,
          razorpay_payout_id: p.razorpay_payout_id,
          failure_reason: p.failure_reason,
          created_at: p.created_at
        }))
      });
    } catch (error) {
      logger.error('Get Payout History error:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch payout history' });
    }
  }

}

module.exports = PayoutController;
