const LOCATION_TYPES = {
  URBAN: 'urban',
  SUBURBAN: 'suburban',
  RURAL: 'rural'
};

const VALID_LOCATION_TYPES = Object.values(LOCATION_TYPES);

/**
 * Normalizes and validates location type.
 * @param {string} input - The input location type.
 * @returns {string} The normalized location type.
 */
function normalizeLocationType(input) {
  if (!input) return LOCATION_TYPES.URBAN;
  const normalized = input.toLowerCase().trim();

  if (!VALID_LOCATION_TYPES.includes(normalized)) {
    throw new Error(
      `Invalid location type: ${input}. Valid types: ${VALID_LOCATION_TYPES.join(', ')}`
    );
  }

  return normalized;
}

module.exports = {
  LOCATION_TYPES,
  VALID_LOCATION_TYPES,
  normalizeLocationType
};
