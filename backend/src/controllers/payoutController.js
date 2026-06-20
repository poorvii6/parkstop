const PayoutService = require('../services/payments/PayoutService');
const logger = require('../utils/logger');
const prisma = require('../config/prisma');

class PayoutController {

  /**
   * 🏦 SETUP PAYOUT ACCOUNT
   * Spotter saves their UPI ID or bank account details.
   * Creates a RazorpayX Contact + Fund Account.
   */
  static async setupPayoutAccount(req, res) {
    try {
      if (req.user.role !== 'spotter') {
        return res.status(403).json({ success: false, message: 'Only spotters can set up payout accounts' });
      }

      const { type, upi_id, account_number, ifsc, name } = req.body;

      if (!type || !['upi', 'bank'].includes(type)) {
        return res.status(400).json({ success: false, message: 'Payout type must be "upi" or "bank"' });
      }

      if (type === 'upi' && !upi_id) {
        return res.status(400).json({ success: false, message: 'UPI ID is required' });
      }

      if (type === 'bank' && (!account_number || !ifsc || !name)) {
        return res.status(400).json({ success: false, message: 'Account number, IFSC, and account holder name are required' });
      }

      // Validate UPI ID format (basic check)
      if (type === 'upi' && !upi_id.includes('@')) {
        return res.status(400).json({ success: false, message: 'Invalid UPI ID format. Example: name@upi' });
      }

      // Validate IFSC format (11 chars, first 4 alpha, 5th is 0, last 6 alphanumeric)
      if (type === 'bank' && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase())) {
        return res.status(400).json({ success: false, message: 'Invalid IFSC code format' });
      }

      const result = await PayoutService.setupPayoutAccount(req.user.id, {
        type,
        upi_id: upi_id || null,
        account_number: account_number || null,
        ifsc: ifsc ? ifsc.toUpperCase() : null,
        name: name || null
      });

      res.json({
        success: true,
        message: `Payout account set up successfully via ${type.toUpperCase()}`,
        data: {
          contactId: result.contactId,
          fundAccountId: result.fundAccountId,
          type
        }
      });
    } catch (error) {
      logger.error('Setup Payout Account error:', error);
      res.status(500).json({
        success: false,
        message: error.message || 'Failed to set up payout account'
      });
    }
  }

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

  /**
   * 🔄 UPDATE PAYOUT DETAILS
   * Spotter updates their UPI ID or bank details.
   */
  static async updatePayoutDetails(req, res) {
    try {
      if (req.user.role !== 'spotter') {
        return res.status(403).json({ success: false, message: 'Only spotters can update payout details' });
      }

      const { type, upi_id, account_number, ifsc, name } = req.body;

      // Save basic details even without RazorpayX
      const updateData = {};

      if (type === 'upi' && upi_id) {
        if (!upi_id.includes('@')) {
          return res.status(400).json({ success: false, message: 'Invalid UPI ID format' });
        }
        updateData.upi_id = upi_id;
        updateData.payout_mode = 'upi';
      } else if (type === 'bank' && account_number && ifsc && name) {
        updateData.bank_account_number = account_number;
        updateData.bank_ifsc = ifsc.toUpperCase();
        updateData.bank_account_name = name;
        updateData.payout_mode = 'bank';
      } else {
        return res.status(400).json({ success: false, message: 'Incomplete payout details' });
      }

      await prisma.users.update({
        where: { id: req.user.id },
        data: updateData
      });

      // If RazorpayX is configured, update the fund account too
      const user = await prisma.users.findUnique({ where: { id: req.user.id } });
      if (user.razorpay_contact_id && process.env.RAZORPAY_ACCOUNT_NUMBER) {
        try {
          await PayoutService.createFundAccount(user.razorpay_contact_id, {
            type,
            upi_id: upi_id || null,
            account_number: account_number || null,
            ifsc: ifsc || null,
            name: name || null
          }, req.user.id);
        } catch (err) {
          logger.warn('RazorpayX fund account update failed (non-critical):', err.message);
        }
      }

      res.json({
        success: true,
        message: 'Payout details updated successfully'
      });
    } catch (error) {
      logger.error('Update Payout Details error:', error);
      res.status(500).json({ success: false, message: 'Failed to update payout details' });
    }
  }
}

module.exports = PayoutController;
