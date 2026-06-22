const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const logger = require('../utils/logger');

const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});

// Queues
const notificationQueue = new Queue('notifications', { connection });
const payoutQueue = new Queue('payouts', { connection });

// Notification Worker
new Worker('notifications', async job => {
  const { userId, title, body, data } = job.data;
  const NotificationService = require('../services/notificationService');
  await NotificationService.sendPushNotification(userId, { title, body, data });
}, { connection });

// Payout Worker
new Worker('payouts', async job => {
  const { bookingId, spotterEarning, spotterId } = job.data;
  const PayoutService = require('../services/payments/PayoutService');
  await PayoutService.processBookingPayout(bookingId, spotterEarning, spotterId);
}, { connection, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

module.exports = { notificationQueue, payoutQueue };
