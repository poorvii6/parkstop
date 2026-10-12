const socketIO = require('socket.io');
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

  // Socket.io authentication: the same rules as the REST API.
  //  - a valid Firebase ID token,
  //  - resolved to a ParkStop user by uid, or by email ONLY when Firebase has
  //    verified that email (otherwise anyone could claim someone else's email
  //    and receive their live booking events),
  //  - from a sign-in that passed the email code.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error('Authentication error: No token provided'));
    }

    try {
      const admin = require('./firebase');
      const { resolveUserFromFirebase } = require('../services/authUserService');
      const { isOtpSessionVerified } = require('../services/otpSession');

      const decoded = await admin.auth.verifyIdToken(token);
      const user = await resolveUserFromFirebase(decoded);
      if (!user) return next(new Error('Authentication error: Unknown user'));
      if (!isOtpSessionVerified(user, decoded)) {
        return next(new Error('Authentication error: Email code required'));
      }

      socket.userId = user.id;
      socket.userRole = user.role;
      return next();
    } catch (error) {
      logger.warn('Socket authentication failed:', error.message);
      return next(new Error('Authentication error: Invalid token'));
    }
  });

  // Each user only ever joins their own room. Events for a booking are sent to
  // the driver's and the owner's rooms directly, so there are no shared rooms
  // a stranger could join.
  io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id} (User: ${socket.userId})`);
    socket.join(`user:${socket.userId}`);

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

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized. Call initializeSocket first.');
  }
  return io;
};

module.exports = {
  initializeSocket,
  emitToUser,
  getIO,
};