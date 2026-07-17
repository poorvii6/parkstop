class CommissionService {

  /**
   * ✅ CALCULATE COMMISSION
   */
  static calculateCommission(totalPrice, locationType = 'urban') {

    // ✅ Safety: ensure valid number
    const price = Number(totalPrice);
    if (!price || price <= 0) {
      return {
        commissionRate: 0,
        platformFee: 0,
        spotterEarning: 0
      };
    }

    let commissionRate = 0.20; // default 20%

    /**
     * 📍 LOCATION-BASED COMMISSION
     */
    if (locationType === 'premium') {
      commissionRate = 0.25;
    } else if (locationType === 'rural') {
      commissionRate = 0.15;
    }

    /**
     * 💰 PRICE-BASED ADJUSTMENTS
     * (Priority rules — override location if needed)
     */
    if (price > 2000) {
      commissionRate = 0.30;
    } else if (price < 200) {
      commissionRate = 0.15;
    }

    /**
     * 🧮 FINAL CALCULATION
     */
    const platformFee = Number((price * commissionRate).toFixed(2));
    const spotterEarning = Number((price - platformFee).toFixed(2));

    return {
      commissionRate,
      platformFee,
      spotterEarning
    };
  }
}

module.exports = CommissionService;