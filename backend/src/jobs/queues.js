const logger = require('../utils/logger');

// Three separate conditions force the in-memory queue. Report WHICH one, rather
// than assuming: previously this always claimed "REDIS_URL unset", which would
// send you hunting a variable that was actually set fine while USE_MOCK_QUEUE
// was the real cause.
const mockReasons = [];
if (process.env.NODE_ENV === 'test') mockReasons.push('NODE_ENV=test');
if (!process.env.REDIS_URL) mockReasons.push('REDIS_URL is not set');
if (process.env.USE_MOCK_QUEUE === 'true') mockReasons.push('USE_MOCK_QUEUE=true');

const useMockQueue = mockReasons.length > 0;
const mockReason = mockReasons.join(' + ');

let notificationQueue;
let payoutQueue;

if (useMockQueue) {
  // In production this is a MONEY risk, not a convenience: the mock queue runs
  // payouts inline with the HTTP request and does not retry. A transient
  // RazorpayX failure therefore falls straight through to the manual-review
  // path, where the real queue would have retried 3x with backoff.
  if (process.env.NODE_ENV === 'production') {
    logger.error(
      `🚨 PAYOUT QUEUE DEGRADED (${mockReason}): payouts run inline with NO ` +
      'retry. Fix the cause above to restore durable queues.'
    );
  } else {
    logger.info(`Using mock in-memory queues (${mockReason})`);
  }

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

  // `family: 0` lets ioredis resolve both IPv4 and IPv6. Railway's private
  // network (redis.railway.internal) is IPv6-only, so without this a
  // REDIS_PRIVATE_URL connection fails with ENOTFOUND while the public URL
  // works — a confusing failure that looks like bad credentials.
  const connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
    family: 0
  });

  connection.on('error', (err) => {
    logger.error('Payout/notification queue Redis error:', err.message);
  });
  connection.on('ready', () => {
    logger.info('Payout/notification queues connected to Redis (BullMQ active)');
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

/**
 * Which queue implementation is live. Surfaced on /health so the degraded mode
 * is observable from outside the process instead of being buried in boot logs.
 *   'bullmq' -> durable, retries 3x with exponential backoff
 *   'inline' -> runs synchronously, NO retry, NO durability
 */
const queueMode = useMockQueue ? 'inline' : 'bullmq';

module.exports = { notificationQueue, payoutQueue, queueMode, mockReason };
