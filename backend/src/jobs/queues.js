const logger = require('../utils/logger');

// Check if we should use mock in-memory queues (useful for testing or local development without Redis)
const useMockQueue = process.env.NODE_ENV === 'test' || !process.env.REDIS_URL || process.env.USE_MOCK_QUEUE === 'true';

let notificationQueue;
let payoutQueue;

if (useMockQueue) {
  logger.info('Using mock in-memory queues (Redis/BullMQ bypassed)');

  notificationQueue = {
    add: async (name, data) => {
      logger.info(`[Mock Queue] Adding notification job: ${name}`);
      const NotificationService = require('../services/notificationService');
      try {
        await NotificationService.sendPushNotification(data.userId, {
          title: data.title,
          body: data.body,
          data: data.data
        });
      } catch (err) {
        logger.error(`[Mock Queue] Error processing notification: ${err.message}`);
      }
      return { id: `mock_job_${Date.now()}` };
    }
  };

  payoutQueue = {
    add: async (name, data) => {
      logger.info(`[Mock Queue] Adding payout job: ${name}`);
      const PayoutService = require('../services/payments/PayoutService');
      try {
        await PayoutService.processBookingPayout(data.bookingId, data.spotterEarning, data.spotterId);
      } catch (err) {
        logger.error(`[Mock Queue] Error processing payout: ${err.message}`);
      }
      return { id: `mock_job_${Date.now()}` };
    }
  };
} else {
  const { Queue, Worker } = require('bullmq');
  const IORedis = require('ioredis');

  const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null
  });

  notificationQueue = new Queue('notifications', { connection });
  payoutQueue = new Queue('payouts', { connection });

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
}

module.exports = { notificationQueue, payoutQueue };
