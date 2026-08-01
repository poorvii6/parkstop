/**
 * CashfreeAdapter — Cashfree Payments + Easy Split (marketplace split-at-source).
 *
 * Why this exists: Razorpay Route / RazorpayX were denied for our sole-proprietor
 * account, so we cannot split or pay out through Razorpay. Cashfree Easy Split IS
 * enabled on our account (validated in scripts/cashfree-test.js) and does exactly
 * what we need — the finder pays once, and Cashfree settles 80% to the spotter's
 * vendor account and retains 20% for ParkStop, automatically.
 *
 * Env vars:
 *   CASHFREE_APP_ID      — client id (x-client-id)
 *   CASHFREE_SECRET_KEY  — client secret (x-client-secret)
 *   CASHFREE_ENV         — "sandbox" (default) or "production"
 *
 * API version pinned to 2023-08-01 (the shapes verified against the sandbox).
 */
const crypto = require('crypto');
const logger = require('../../utils/logger');

const API_VERSION = '2023-08-01';

function baseUrl() {
  return (process.env.CASHFREE_ENV || 'sandbox').toLowerCase() === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';
}

function headers() {
  return {
    'x-client-id': process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'x-api-version': API_VERSION,
    'Content-Type': 'application/json',
  };
}

async function request(method, path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.message || `Cashfree ${method} ${path} failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

class CashfreeAdapter {
  /**
   * CREATE ORDER (optionally with an 80/20 split to a vendor).
   * Returns the payment_session_id the app uses to open Cashfree checkout.
   *
   * @param {Object} p
   * @param {number} p.amount            order amount in rupees (server-computed)
   * @param {string} p.orderId           our unique order id (idempotency)
   * @param {Object} p.customer          { id, phone, email }
   * @param {Array}  [p.splits]          [{ vendorId, percentage }] — spotter's share
   * @param {string} [p.returnUrl]
   * @param {string} [p.notifyUrl]       our webhook URL
   */
  async createOrder({ amount, orderId, customer, splits, returnUrl, notifyUrl }) {
    try {
      const body = {
        order_id: orderId,
        order_amount: Number(Number(amount).toFixed(2)),
        order_currency: 'INR',
        customer_details: {
          customer_id: String(customer.id),
          customer_phone: String(customer.phone || '9999999999'),
          customer_email: customer.email || undefined,
        },
        order_meta: {
          return_url: returnUrl || undefined,
          notify_url: notifyUrl || undefined,
        },
        order_note: 'ParkStop booking',
      };
      if (Array.isArray(splits) && splits.length) {
        body.order_splits = splits.map((s) => ({
          vendor_id: s.vendorId,
          percentage: s.percentage,
        }));
      }
      const order = await request('POST', '/orders', body);
      return {
        cfOrderId: order.cf_order_id,
        orderId: order.order_id,
        paymentSessionId: order.payment_session_id,
        amount: order.order_amount,
        currency: order.order_currency,
        splits: order.order_splits || [],
      };
    } catch (error) {
      logger.error('Cashfree createOrder error:', error?.message, error?.body || '');
      throw error;
    }
  }

  /** Fetch an order's current status (used to confirm payment server-side). */
  async getOrder(orderId) {
    return request('GET', `/orders/${orderId}`);
  }

  /**
   * CREATE / UPSERT an Easy Split VENDOR (a spotter payee).
   * Schema verified against the sandbox: kyc_details needs account_type,
   * a business_type from Cashfree's fixed list, and pan; plus bank OR upi.
   *
   * @param {Object} v
   * @param {string} v.vendorId
   * @param {string} v.name
   * @param {string} v.email
   * @param {string} v.phone
   * @param {string} v.pan
   * @param {string} [v.businessType='Miscellaneous']
   * @param {Object} [v.bank]   { accountNumber, accountHolder, ifsc }
   * @param {Object} [v.upi]    { vpa }
   * @param {boolean}[v.verifyAccount=true]
   */
  async createVendor(v) {
    try {
      const body = {
        vendor_id: v.vendorId,
        status: 'ACTIVE',
        name: v.name,
        email: v.email,
        phone: String(v.phone),
        verify_account: v.verifyAccount !== false,
        dashboard_access: false,
        kyc_details: {
          account_type: 'Individual',
          business_type: v.businessType || 'Miscellaneous',
          pan: v.pan,
        },
      };
      if (v.upi && v.upi.vpa) {
        body.upi = { vpa: v.upi.vpa, account_holder: v.name };
      } else if (v.bank) {
        body.bank = {
          account_number: v.bank.accountNumber,
          account_holder: v.bank.accountHolder || v.name,
          ifsc: v.bank.ifsc,
        };
      }
      return await request('POST', '/easy-split/vendors', body);
    } catch (error) {
      logger.error('Cashfree createVendor error:', error?.message, error?.body || '');
      throw error;
    }
  }

  /** Fetch a vendor (to check ACTIVE vs IN_BANK_VALIDATION status). */
  async getVendor(vendorId) {
    return request('GET', `/easy-split/vendors/${vendorId}`);
  }

  /**
   * VERIFY WEBHOOK SIGNATURE.
   * Cashfree signs webhooks as: base64( HMAC-SHA256( timestamp + rawBody, secret ) ).
   * Pass the RAW request body string (not the parsed object) and the two headers
   * x-webhook-signature and x-webhook-timestamp.
   */
  verifyWebhookSignature(rawBody, signature, timestamp) {
    try {
      const payload = `${timestamp}${rawBody}`;
      const expected = crypto
        .createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
        .update(payload)
        .digest('base64');
      const a = Buffer.from(expected);
      const b = Buffer.from(signature || '');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (error) {
      logger.error('Cashfree webhook signature error:', error?.message);
      return false;
    }
  }
}

module.exports = new CashfreeAdapter();
