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
