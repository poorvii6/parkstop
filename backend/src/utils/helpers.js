/**
 * Generate a random OTP code
 * @param {number} length - Length of OTP
 * @returns {string} OTP code
 */
const generateOTP = (length = 6) => {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * 10)];
  }
  return otp;
};

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in kilometers
 */
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Radius of Earth in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  
  return Math.round(distance * 100) / 100; // Round to 2 decimal places
};

/**
 * Convert degrees to radians
 * @param {number} degrees
 * @returns {number} Radians
 */
const toRadians = (degrees) => {
  return degrees * (Math.PI / 180);
};

/**
 * Estimate arrival time based on distance and average speed
 * @param {number} distance - Distance in kilometers
 * @param {number} averageSpeed - Average speed in km/h (default 40)
 * @returns {number} Estimated time in minutes
 */
const estimateArrivalTime = (distance, averageSpeed = 40) => {
  const hours = distance / averageSpeed;
  return Math.round(hours * 60);
};

/**
 * Format date to readable string
 * @param {Date|string} date
 * @returns {string} Formatted date
 */
const formatDate = (date) => {
  const d = new Date(date);
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

/**
 * Check if a date is within N minutes from now
 * @param {Date|string} date
 * @param {number} minutes
 * @returns {boolean}
 */
const isWithinMinutes = (date, minutes) => {
  const targetDate = new Date(date);
  const now = new Date();
  const diffMinutes = (targetDate - now) / (1000 * 60);
  return diffMinutes <= minutes && diffMinutes >= 0;
};

/**
 * Sanitize object by removing sensitive fields
 * @param {Object} obj
 * @param {Array<string>} fieldsToRemove
 * @returns {Object} Sanitized object
 */
const sanitizeObject = (obj, fieldsToRemove = ['password', 'otp']) => {
  const sanitized = { ...obj };
  fieldsToRemove.forEach((field) => {
    delete sanitized[field];
  });
  return sanitized;
};

/**
 * Generate a random string
 * @param {number} length
 * @returns {string}
 */
const generateRandomString = (length = 32) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/**
 * Validate email format
 * @param {string} email
 * @returns {boolean}
 */
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Validate phone number format
 * @param {string} phone
 * @returns {boolean}
 */
const isValidPhone = (phone) => {
  const phoneRegex = /^\+?[\d\s\-\(\)]+$/;
  return phoneRegex.test(phone) && phone.replace(/\D/g, '').length >= 10;
};

/**
 * Parse pagination parameters
 * @param {Object} query - Request query object
 * @returns {Object} Pagination parameters
 */
const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
};

module.exports = {
  generateOTP,
  calculateDistance,
  estimateArrivalTime,
  formatDate,
  isWithinMinutes,
  sanitizeObject,
  generateRandomString,
  isValidEmail,
  isValidPhone,
  parsePagination,
  toRadians,
};
