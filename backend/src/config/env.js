require('dotenv').config();

const config = {
  // Server
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',

  // Database
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    name: process.env.DB_NAME || 'smart_parking',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    max: 20, // connection pool size
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'default-secret-change-this',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'refresh-secret',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  // API
  apiPrefix: process.env.API_PREFIX || '/api/v1',

  // Socket.io
  socket: {
    corsOrigin: process.env.SOCKET_CORS_ORIGIN 
      ? process.env.SOCKET_CORS_ORIGIN.split(',') 
      : ['http://localhost:19000', 'http://localhost:8081', 'http://localhost:19006'],
  },

  // OTP
  otp: {
    length: parseInt(process.env.OTP_LENGTH, 10) || 6,
    expiryMinutes: parseInt(process.env.OTP_EXPIRY_MINUTES, 10) || 10,
  },

  // Firebase (for push notifications)
  firebase: {
    serverKey: process.env.FIREBASE_SERVER_KEY || '',
  },

  // Razorpay
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    accountNumber: process.env.RAZORPAY_ACCOUNT_NUMBER,
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 900000, // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    filePath: process.env.LOG_FILE_PATH || 'logs/app.log',
  },
};

// Validate critical configuration
function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';

  // FATAL: App will not start without these
  const required = [
    'DATABASE_URL',
    'JWT_SECRET',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
  ];

  // FATAL in production only, warning in development
  const requiredInProduction = [
    'FIREBASE_SERVICE_ACCOUNT_JSON',
  ];

  // WARNING: App starts but features will be degraded
  const recommended = [
    { name: 'CLOUDINARY_CLOUD_NAME', feature: 'Image uploads' },
    { name: 'CLOUDINARY_API_KEY', feature: 'Image uploads' },
    { name: 'CLOUDINARY_API_SECRET', feature: 'Image uploads' },
    { name: 'OLA_MAPS_API_KEY', feature: 'Maps search/routing (falls back to Nominatim/OSRM)' },
    { name: 'STRIPE_SECRET_KEY', feature: 'Stripe payments' },
    { name: 'RAZORPAY_ACCOUNT_NUMBER', feature: 'Razorpay payouts' },
  ];

  const missing = [];

  for (const envVar of required) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  for (const envVar of requiredInProduction) {
    if (!process.env[envVar]) {
      if (isProduction) {
        missing.push(envVar);
      } else {
        console.warn(`⚠️  ${envVar} is not set — required in production`);
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      `Copy .env.example to .env and fill in the values`
    );
  }

  // Validate JWT secret length
  if (process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }

  // Warn about missing recommended vars
  for (const { name, feature } of recommended) {
    if (!process.env[name]) {
      console.warn(`⚠️  ${name} is not set — ${feature} will be unavailable`);
    }
  }

  console.log('✅ Environment variables validated');
}

validateEnv();

module.exports = config;