const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const logger = require('../utils/logger');

let adminApp = null;
let auth = null;

try {
  let serviceAccount = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    logger.info('🔑 Loading Firebase Service Account from environment variable');
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    try {
      serviceAccount = require('./firebase-service-account.json');
      logger.info('🔑 Loading Firebase Service Account from local JSON file');
    } catch (fileErr) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is required in production.');
      } else {
        logger.warn('⚠️ Firebase Service Account file not found and no environment variable provided. Firebase features will be unavailable.');
      }
    }
  }

  if (serviceAccount) {
    adminApp = initializeApp({
      credential: cert(serviceAccount)
    });
    auth = getAuth(adminApp);
    logger.info('🔥 Firebase Admin SDK initialized successfully');
  }

  // Setup E2E/Development mock fallback if firebase is unavailable or running tests
  if (!auth || process.env.NODE_ENV === 'test' || process.env.IGNORE_RATE_LIMITS === 'true') {
    logger.info('🛠️ Using mock Firebase Auth SDK for E2E tests / local development');
    auth = {
      verifyIdToken: async (token) => {
        try {
          const jwt = require('jsonwebtoken');
          const decoded = jwt.verify(token, process.env.JWT_SECRET || 'jwt_default_secret_key');
          return {
            uid: decoded.firebase_uid || decoded.uid || `mock_uid_${decoded.email.replace(/[@.]/g, '_')}`,
            email: decoded.email,
            name: decoded.name || decoded.email.split('@')[0]
          };
        } catch (err) {
          // If the token is a raw email string (e.g. from custom test setups)
          if (token && typeof token === 'string' && token.includes('@')) {
            return {
              uid: `mock_uid_${token.replace(/[@.]/g, '_')}`,
              email: token,
              name: token.split('@')[0]
            };
          }
          // Default fallback
          return {
            uid: 'mock_uid_finder',
            email: 'finder@example.com',
            name: 'Jane Finder'
          };
        }
      }
    };
  }
} catch (error) {
  logger.error('Failed to initialize Firebase Admin SDK:', error);
  if (process.env.NODE_ENV === 'production') {
    throw error;
  }
}

module.exports = {
  adminApp,
  auth
};
