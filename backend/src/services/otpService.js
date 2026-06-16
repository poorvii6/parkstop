const config = require('../config/env');
const { generateOTP } = require('../utils/helpers');
const logger = require('../utils/logger');

class OTPService {
  /**
   * Generate new OTP
   */
  static generate() {
    return generateOTP(config.otp.length);
  }

  /**
   * Get OTP expiry time
   */
  static getExpiryTime() {
    return new Date(Date.now() + config.otp.expiryMinutes * 60 * 1000);
  }

  /**
   * Check if OTP is expired
   */
  static isExpired(expiryTime) {
    return new Date() > new Date(expiryTime);
  }

  /**
   * Verify OTP
   */
  static verify(inputOTP, storedOTP, expiryTime) {
    if (this.isExpired(expiryTime)) {
      logger.warn('OTP expired');
      return false;
    }

    if (inputOTP !== storedOTP) {
      logger.warn('OTP mismatch');
      return false;
    }

    return true;
  }
}

module.exports = OTPService;