const logger = require('../../utils/logger');
const prisma = require('../../config/prisma');

/**
 * 🏦 PAYOUT SERVICE
 * Handles RazorpayX Payouts API for paying Spotters their earnings.
 *
 * Flow:
 * 1. createContact()      → Register Spotter as a RazorpayX Contact
 * 2. createFundAccount()  → Link their UPI ID or bank account
 * 3. createPayout()       → Transfer money to the Spotter
 *
 * API Docs: https://razorpay.com/docs/api/x/payouts/
 */
class PayoutService {

  constructor() {
    this.baseUrl = 'https://api.razorpay.com/v1';
    this.accountNumber = process.env.RAZORPAY_ACCOUNT_NUMBER;
  }

  /**
   * Get auth headers for RazorpayX API (Basic Auth)
   */
  _getAuthHeaders() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const credentials = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    return {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * 👤 CREATE CONTACT
   * Registers a Spotter as a "contact" in RazorpayX.
   * This is required before creating a fund account.
   *
   * @param {Object} user - The Spotter's user record
   * @returns {string} contactId - RazorpayX contact ID
   */
  async createContact(user) {
    try {
      const response = await fetch(`${this.baseUrl}/contacts`, {
        method: 'POST',
        headers: this._getAuthHeaders(),
        body: JSON.stringify({
          name: user.full_name || user.name,
          email: user.email,
          contact: user.phone,
          type: 'vendor',
          reference_id: `spotter_${user.id}`,
          notes: {
            platform: 'ParkStop',
            user_id: user.id.toString(),
            role: 'spotter'
          }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        logger.error('RazorpayX Create Contact Error:', data);
        throw new Error(data.error?.description || 'Failed to create RazorpayX contact');
      }

      // Save contact ID to user record
      await prisma.users.update({
        where: { id: user.id },
        data: { razorpay_contact_id: data.id }
      });

      logger.info(`RazorpayX Contact created for user ${user.id}: ${data.id}`);
      return data.id;
    } catch (error) {
      logger.error('PayoutService.createContact error:', error);
      throw error;
    }
  }

  /**
   * 🏦 CREATE FUND ACCOUNT
   * Links a UPI ID or bank account to the contact.
   *
   * @param {string} contactId - RazorpayX contact ID
   * @param {Object} accountDetails - { type: 'upi'|'bank', upi_id, account_number, ifsc, name }
   * @param {number} userId - The Spotter's user ID
   * @returns {string} fundAccountId - RazorpayX fund account ID
   */
  async createFundAccount(contactId, accountDetails, userId) {
    try {
      const payload = {
        contact_id: contactId,
        account_type: accountDetails.type === 'upi' ? 'vpa' : 'bank_account'
      };

      if (accountDetails.type === 'upi') {
        payload.vpa = {
          address: accountDetails.upi_id
        };
      } else {
        payload.bank_account = {
          name: accountDetails.name,
          ifsc: accountDetails.ifsc,
          account_number: accountDetails.account_number
        };
      }

      const response = await fetch(`${this.baseUrl}/fund_accounts`, {
        method: 'POST',
        headers: this._getAuthHeaders(),
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        logger.error('RazorpayX Create Fund Account Error:', data);
        throw new Error(data.error?.description || 'Failed to create fund account');
      }

      // Save fund account ID and payout details to user record
      const updateData = {
        razorpay_fund_account_id: data.id,
        payout_mode: accountDetails.type
      };

      if (accountDetails.type === 'upi') {
        updateData.upi_id = accountDetails.upi_id;
      } else {
        updateData.bank_account_number = accountDetails.account_number;
        updateData.bank_ifsc = accountDetails.ifsc;
        updateData.bank_account_name = accountDetails.name;
      }

      await prisma.users.update({
        where: { id: userId },
        data: updateData
      });

      logger.info(`RazorpayX Fund Account created for user ${userId}: ${data.id}`);
      return data.id;
    } catch (error) {
      logger.error('PayoutService.createFundAccount error:', error);
      throw error;
    }
  }

  /**
   * 💸 CREATE PAYOUT
   * Actually transfers money to the Spotter's linked account.
   *
   * @param {Object} params
   * @param {string} params.fundAccountId - RazorpayX fund account ID
   * @param {number} params.amount - Amount in rupees (not paise)
   * @param {string} params.mode - 'UPI', 'IMPS', or 'NEFT'
   * @param {string} params.narration - Description shown in bank statement
   * @param {number} params.userId - Spotter's user ID
   * @param {number} params.bookingId - Associated booking ID
   * @returns {Object} payout record
   */
  async createPayout({ fundAccountId, amount, mode = 'UPI', narration, userId, bookingId }) {
    try {
      if (!this.accountNumber) {
        logger.warn('RAZORPAY_ACCOUNT_NUMBER not set — skipping live payout, crediting balance only');
        return this._createLocalPayout(userId, bookingId, amount, mode, narration);
      }

      const response = await fetch(`${this.baseUrl}/payouts`, {
        method: 'POST',
        headers: this._getAuthHeaders(),
        body: JSON.stringify({
          account_number: this.accountNumber,
          fund_account_id: fundAccountId,
          amount: Math.round(Number(amount) * 100), // Convert to paise
          currency: 'INR',
          mode: mode,
          purpose: 'payout',
          queue_if_low_balance: true,
          reference_id: `booking_${bookingId}_${Date.now()}`,
          narration: narration || `ParkStop earnings - Booking #${bookingId}`
        })
      });

      const data = await response.json();

      if (!response.ok) {
        logger.error('RazorpayX Create Payout Error:', data);
        // Fall back to local balance credit
        return this._createLocalPayout(userId, bookingId, amount, mode, narration, data.error?.description);
      }

      // Record payout in database
      const payout = await prisma.payouts.create({
        data: {
          user_id: userId,
          booking_id: bookingId,
          amount: parseFloat(amount),
          razorpay_payout_id: data.id,
          status: data.status || 'processing',
          mode: mode,
          purpose: 'payout',
          narration: narration || `ParkStop earnings - Booking #${bookingId}`
        }
      });

      logger.info(`Payout created: ₹${amount} to user ${userId} for booking ${bookingId} — ${data.id}`);
      return payout;
    } catch (error) {
      logger.error('PayoutService.createPayout error:', error);
      // Fallback: at minimum credit the balance
      return this._createLocalPayout(userId, bookingId, amount, mode, narration, error.message);
    }
  }

  /**
   * 📝 CREATE LOCAL PAYOUT RECORD (Fallback)
   * When RazorpayX is unavailable, we record the payout locally
   * and credit the Spotter's in-app balance. Can be settled manually later.
   */
  async _createLocalPayout(userId, bookingId, amount, mode, narration, failureReason = null) {
    const payout = await prisma.payouts.create({
      data: {
        user_id: userId,
        booking_id: bookingId,
        amount: parseFloat(amount),
        status: failureReason ? 'failed_queued' : 'balance_credited',
        mode: mode || 'UPI',
        purpose: 'payout',
        narration: narration || `ParkStop earnings - Booking #${bookingId}`,
        failure_reason: failureReason
      }
    });

    // Always credit in-app balance as fallback
    await prisma.users.update({
      where: { id: userId },
      data: { balance: { increment: parseFloat(amount) } }
    });

    logger.info(`Local payout recorded: ₹${amount} credited to user ${userId} balance (booking ${bookingId})`);
    return payout;
  }

  /**
   * 📊 GET PAYOUT STATUS
   * Check the status of a payout from RazorpayX.
   */
  async getPayoutStatus(payoutId) {
    try {
      const response = await fetch(`${this.baseUrl}/payouts/${payoutId}`, {
        method: 'GET',
        headers: this._getAuthHeaders()
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error?.description || 'Failed to fetch payout status');
      }

      return data;
    } catch (error) {
      logger.error('PayoutService.getPayoutStatus error:', error);
      throw error;
    }
  }

  /**
   * 🔄 SETUP SPOTTER PAYOUT ACCOUNT
   * Complete flow: create contact → create fund account.
   * Called when a Spotter saves their UPI/bank details.
   *
   * @param {number} userId - Spotter's user ID
   * @param {Object} accountDetails - { type, upi_id, account_number, ifsc, name }
   * @returns {Object} { contactId, fundAccountId }
   */
  async setupPayoutAccount(userId, accountDetails) {
    try {
      const user = await prisma.users.findUnique({ where: { id: userId } });
      if (!user) throw new Error('User not found');

      // Step 1: Create or reuse contact
      let contactId = user.razorpay_contact_id;
      if (!contactId) {
        contactId = await this.createContact(user);
      }

      // Step 2: Create fund account
      const fundAccountId = await this.createFundAccount(contactId, accountDetails, userId);

      return { contactId, fundAccountId };
    } catch (error) {
      logger.error('PayoutService.setupPayoutAccount error:', error);
      throw error;
    }
  }

  /**
   * 💰 PROCESS BOOKING PAYOUT
   * Called after a booking is completed.
   * Calculates commission and pays the Spotter.
   *
   * @param {number} bookingId - The completed booking ID
   * @param {number} spotterEarning - Amount the Spotter earns
   * @param {number} spotterId - Spotter's user ID
   */
  async processBookingPayout(bookingId, spotterEarning, spotterId) {
    try {
      const spotter = await prisma.users.findUnique({ where: { id: spotterId } });
      if (!spotter) {
        logger.error(`Spotter ${spotterId} not found for payout`);
        return null;
      }

      const narration = `ParkStop earnings - Booking #${bookingId}`;

      // If Spotter has a fund account, do a real payout
      if (spotter.razorpay_fund_account_id) {
        return await this.createPayout({
          fundAccountId: spotter.razorpay_fund_account_id,
          amount: spotterEarning,
          mode: spotter.payout_mode === 'bank' ? 'IMPS' : 'UPI',
          narration,
          userId: spotterId,
          bookingId
        });
      }

      // Otherwise, just credit their in-app balance
      logger.info(`Spotter ${spotterId} has no payout account — crediting balance`);
      return await this._createLocalPayout(spotterId, bookingId, spotterEarning, 'balance', narration);
    } catch (error) {
      logger.error(`processBookingPayout failed for booking ${bookingId}:`, error);
      // Ensure balance is credited even if payout fails
      try {
        await prisma.users.update({
          where: { id: spotterId },
          data: { balance: { increment: parseFloat(spotterEarning) } }
        });
      } catch (balanceError) {
        logger.error(`CRITICAL: Failed to credit balance for spotter ${spotterId}:`, balanceError);
      }
      return null;
    }
  }
}

module.exports = new PayoutService();
