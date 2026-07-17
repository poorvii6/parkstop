const { calculateDistance, estimateArrivalTime } = require('../utils/helpers');

class MapService {
  /**
   * Calculate distance between two points
   */
  static calculateDistance(lat1, lon1, lat2, lon2) {
    return calculateDistance(lat1, lon1, lat2, lon2);
  }

  /**
   * Estimate arrival time
   */
  static estimateArrival(distance, speed = 40) {
    return estimateArrivalTime(distance, speed);
  }

  /**
   * Check if finder is near destination
   */
  static isNearby(finderLat, finderLng, spotLat, spotLng, thresholdKm = 0.5) {
    const distance = this.calculateDistance(finderLat, finderLng, spotLat, spotLng);
    return distance <= thresholdKm;
  }
}

module.exports = MapService;