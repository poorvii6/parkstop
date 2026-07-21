const IORedis = require('ioredis');
const logger = require('./logger');

let redis = null;
if (process.env.REDIS_URL && process.env.NODE_ENV !== 'test') {
  try {
    // family: 0 — Railway's private network is IPv6-only; see jobs/queues.js.
    redis = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      family: 0
    });
    redis.on('error', (err) => {
      logger.error('Login tracker Redis error:', err);
    });
  } catch (err) {
    logger.error('Login tracker Redis connection failed:', err);
  }
}

const memoryStore = new Map();

class LoginTracker {
  static async getAttempts(email) {
    const key = `attempts:${email}`;
    if (redis) {
      try {
        const count = await redis.get(key);
        return count ? parseInt(count, 10) : 0;
      } catch (err) {
        logger.error('Redis getAttempts error, falling back to memory:', err);
      }
    }
    const data = memoryStore.get(key);
    if (data && data.expiry > Date.now()) {
      return data.count;
    }
    return 0;
  }

  static async incrementAttempts(email) {
    const key = `attempts:${email}`;
    if (redis) {
      try {
        const count = await redis.incr(key);
        await redis.expire(key, 86400); // 24 hours
        return count;
      } catch (err) {
        logger.error('Redis incrementAttempts error, falling back to memory:', err);
      }
    }
    const data = memoryStore.get(key) || { count: 0, expiry: Date.now() + 86400000 };
    data.count += 1;
    data.expiry = Date.now() + 86400000;
    memoryStore.set(key, data);
    return data.count;
  }

  static async clearAttempts(email) {
    const key = `attempts:${email}`;
    const lockKey = `lockout:${email}`;
    if (redis) {
      try {
        await redis.del(key);
        await redis.del(lockKey);
        return;
      } catch (err) {
        logger.error('Redis clearAttempts error:', err);
      }
    }
    memoryStore.delete(key);
    memoryStore.delete(lockKey);
  }

  static async getLockoutTime(email) {
    const key = `lockout:${email}`;
    if (redis) {
      try {
        const expiry = await redis.get(key);
        return expiry ? parseInt(expiry, 10) : null;
      } catch (err) {
        logger.error('Redis getLockoutTime error, falling back to memory:', err);
      }
    }
    const expiry = memoryStore.get(key);
    if (expiry && expiry > Date.now()) {
      return expiry;
    }
    return null;
  }

  static async setLockout(email, durationMs) {
    const key = `lockout:${email}`;
    const expiry = Date.now() + durationMs;
    if (redis) {
      try {
        await redis.set(key, expiry, 'PX', durationMs);
        return;
      } catch (err) {
        logger.error('Redis setLockout error, falling back to memory:', err);
      }
    }
    memoryStore.set(key, expiry);
  }
}

const sendLockoutEmail = async (email) => {
  const resetLink = `https://parkstop.app/reset-password?email=${encodeURIComponent(email)}`;
  logger.warn(`[SECURITY] Account locked out for ${email}. Reset Link sent: ${resetLink}`);
  // Mock sending email - in production, integrate a mail provider
};

module.exports = {
  LoginTracker,
  sendLockoutEmail
};
