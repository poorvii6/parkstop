const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./env');
const logger = require('../utils/logger');

let io = null;

const initializeSocket = (server) => {
  io = socketIO(server, {
    cors: {
      origin: config.socket.corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  async function emitPendingNotifications(userId) {
    // Optional enhancement: store undelivered notifications in DB and re-emit on reconnect
    // For now, just log
    logger.debug(`Checking pending notifications for user ${userId}`);
  }

  // Socket.io authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    // Primary: Firebase ID token — the same credential the REST API uses.
    // (Previously this only accepted legacy JWTs, so every Firebase-authenticated
    // client was rejected and no realtime events were ever delivered.)
    try {
      const admin = require('./firebase');
      const decoded = await admin.auth.verifyIdToken(token);
      const prisma = require('./prisma');
      let user = await prisma.users.findUnique({ where: { firebase_uid: decoded.uid } });
      if (!user && decoded.email) {
        user = await prisma.users.findUnique({ where: { email: decoded.email } });
      }
      if (user) {
        socket.userId = user.id;
        socket.userRole = user.role;
        return next();
      }
    } catch (fbErr) {
      // Not a Firebase token — fall through to the legacy JWT path.
    }

    // Fallback: legacy JWT (e2e tests / mock login)
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      socket.userId = decoded.id;
      socket.userRole = decoded.role;
      next();
    } catch (error) {
      logger.error('Socket authentication error:', error.message);
      next(new Error('Authentication error: Invalid token'));
    }
  });

  // Handle connections
  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (User: ${socket.userId})`);

    // Join user-specific room
    socket.join(`user:${socket.userId}`);

    // ADD: Handle reconnection — client sends its active booking ID on reconnect
    socket.on('reconnect:rejoin', ({ bookingId }) => {
      if (bookingId) {
        socket.join(`booking:${bookingId}`);
        logger.info(`User ${socket.userId} re-joined booking room ${bookingId} after reconnect`);
      }
      // Re-emit any pending notifications from DB
      emitPendingNotifications(socket.userId);
    });

    // Handle GPS location updates (from Finder)
    socket.on('location:update', (data) => {
      const { bookingId, latitude, longitude } = data;
      
      // Emit to all spotters monitoring this booking
      io.to(`booking:${bookingId}`).emit('location:updated', {
        bookingId,
        latitude,
        longitude,
        timestamp: new Date(),
      });

      logger.debug(`Location updated for booking ${bookingId}`);
    });

    // Join booking room (for Spotters to monitor specific bookings)
    socket.on('booking:monitor', (bookingId) => {
      socket.join(`booking:${bookingId}`);
      logger.info(`User ${socket.userId} monitoring booking ${bookingId}`);
    });

    // Leave booking room
    socket.on('booking:unmonitor', (bookingId) => {
      socket.leave(`booking:${bookingId}`);
      logger.info(`User ${socket.userId} stopped monitoring booking ${bookingId}`);
    });

    // Handle disconnection
    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: ${socket.id}`);
    });
  });

  logger.info('✅ Socket.io initialized');
  return io;
};

// Emit event to specific user
const emitToUser = (userId, event, data) => {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
};

// Emit event to booking room (all users monitoring that booking)
const emitToBooking = (bookingId, event, data) => {
  if (io) {
    io.to(`booking:${bookingId}`).emit(event, data);
  }
};

// Broadcast to all connected clients
const broadcast = (event, data) => {
  if (io) {
    io.emit(event, data);
  }
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized. Call initializeSocket first.');
  }
  return io;
};

module.exports = {
  initializeSocket,
  emitToUser,
  emitToBooking,
  broadcast,
  getIO,
};