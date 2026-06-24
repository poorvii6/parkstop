/**
 * Retrieve environment variables safely and throw an error if a secret is missing.
 * @param {string} key - The environment variable key.
 * @returns {string} The environment variable value.
 */
const getSecret = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Secret ${key} not found in environment`);
  }
  return value;
};

module.exports = { getSecret };
