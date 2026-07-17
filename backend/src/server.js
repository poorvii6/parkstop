const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('./config/env');
const db = require('./config/database');
const { initializeSocket } = require('./config/socket');
const logger = require('./utils/logger');
const { errorHandler, notFound } = require('./middleware/errorHandler');

const authRoutes = require('./routes/auth');
const spotRoutes = require('./routes/spots');
const bookingRoutes = require('./routes/bookings');
const locationRoutes = require('./routes/locations');
const startBookingExpiryJob = require('./services/bookingExpiryService');
const analyticsRoutes = require('./routes/analytics'); 
const chatbotRoutes = require('./routes/chatbot');
const paymentRoutes = require('./routes/payments');
const mapRoutes = require('./routes/maps');
const savedRoutes = require('./routes/saved_spots');
const payoutRoutes = require('./routes/payouts');
const reviewRoutes = require('./routes/reviews');
const disputeRoutes = require('./routes/disputes');
const bookingsSimpleRoutes = require('./routes/bookingsSimple');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

initializeSocket(server);

// Security
if (process.env.NODE_ENV === 'production') {
  app.use(helmet());
} else {
  // Disable CSP and HSTS in development to allow inline scripts/CDNs and avoid forcing HTTPS
  app.use(helmet({
    contentSecurityPolicy: false,
    hsts: false
  }));
}
app.use(compression());

// Rate limiting
// General API limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // 100 requests per window
  message: { success: false, message: 'Too many requests, please try again later.' },
  skip: () => process.env.IGNORE_RATE_LIMITS === 'true'
});

// Strict limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                   // 10 login attempts per 15 min
  message: { success: false, message: 'Too many login attempts, please try again later.' },
  skip: () => process.env.IGNORE_RATE_LIMITS === 'true'
});

app.use(limiter);
app.use('/api/v1/auth/login', authLimiter);
app.use('/api/v1/auth/register', authLimiter);

// CORS (mobile-safe)
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000', 'http://localhost:8081', 'http://localhost:8080'];

app.use(cors({
  origin: (origin, callback) => {
    // Mobile apps and some server-to-server requests don't send an origin
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1 && process.env.NODE_ENV === 'production') {
      logger.warn(`[CORS Blocked] Origin: ${origin} is not in allowedOrigins (${allowedOrigins.join(', ')})`);
      const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
}));

// Body parsing with limits
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Logging
if (config.env === 'production') {
  app.use(morgan('combined', { stream: logger.stream }));
} else {
  app.use(morgan('dev'));
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const prisma = require('./config/prisma');
    await prisma.$queryRaw`SELECT 1`;
    
    res.json({
      success: true,
      environment: config.env,
      database: 'connected',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      database: 'disconnected',
      error: error.message
    });
  }
});

const API_PREFIX = '/api/v1';

app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/spots`, spotRoutes);
app.use(`${API_PREFIX}/bookings`, bookingRoutes);
app.use(`${API_PREFIX}/locations`, locationRoutes);
app.use(`${API_PREFIX}/analytics`, analyticsRoutes);
app.use(`${API_PREFIX}/chatbot`, chatbotRoutes);
app.use(`${API_PREFIX}/payments`, paymentRoutes);
app.use(`${API_PREFIX}/maps`, mapRoutes);
app.use(`${API_PREFIX}/saved-spots`, savedRoutes);
app.use(`${API_PREFIX}/payouts`, payoutRoutes);
app.use(`${API_PREFIX}/reviews`, reviewRoutes);
app.use(`${API_PREFIX}/disputes`, disputeRoutes);
app.use(`${API_PREFIX}/bookings-simple`, bookingsSimpleRoutes);

// Serve the ParkStop landing page at root URL
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(notFound);
app.use(errorHandler);


const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, '0.0.0.0', async () => {
    logger.info(`🚀 Server running on port ${PORT}`);
    if (!process.env.OLA_MAPS_API_KEY) {
      logger.warn('⚠️  OLA_MAPS_API_KEY not set — maps search/routing will use public Nominatim/OSRM fallback (rate-limited, not production-grade)');
    }

    try {
      const prisma = require('./config/prisma');
      await prisma.$connect();
      logger.info('✅ Database connected (Prisma)');
    } catch (error) {
      logger.error('❌ Database connection failed:', error);
      process.exit(1);
    }

    startBookingExpiryJob();
  });
}


module.exports = { app, server };
// Nodemon trigger reload to load new env variables
