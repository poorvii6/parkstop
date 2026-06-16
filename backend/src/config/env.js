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
if (config.env === 'production') {
  if (config.jwt.secret === 'default-secret-change-this') {
    throw new Error('JWT_SECRET must be set in production');
  }
  if (!config.database.password || config.database.password === 'password') {
    throw new Error('Database password must be set in production');
  }
}

module.exports = config;