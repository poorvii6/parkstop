/**
 * cashfreeVerification.js — Cashfree Secure ID (Verification Suite) client.
 *
 * Used ONLY for spot-owner verification: DigiLocker Aadhaar, PAN, bank account,
 * face liveness and face match. There is no mock mode: if the keys are missing
 * the call fails with a clear error, and nobody is ever marked verified without
 * a real Cashfree response.
 *
 * Environment:
 *   CASHFREE_VRS_CLIENT_ID      Secure ID client id ("TEST..." = sandbox keys)
 *   CASHFREE_VRS_CLIENT_SECRET  Secure ID client secret
 *   CASHFREE_VRS_PUBLIC_KEY     PEM public key for 2FA signature (x-cf-signature).
 *                               Needed because Railway has no fixed IP to whitelist.
 *   CASHFREE_VRS_ENV            optional: "sandbox" | "production". If unset, it is
 *                               worked out from the keys themselves (secret
 *                               "..._test_..." or id "TEST..." => sandbox), so test
 *                               keys can never be sent to production or vice versa.
 */
const crypto = require('crypto');
const logger = require('../utils/logger');

const TIMEOUT_MS = 25000;

class VerificationError extends Error {
  constructor(message, { status = 502, code = 'VERIFICATION_FAILED', details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function config() {
  const clientId = process.env.CASHFREE_VRS_CLIENT_ID;
  const clientSecret = process.env.CASHFREE_VRS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new VerificationError('Identity verification is not configured on the server yet.', {
      status: 503, code: 'NOT_CONFIGURED',
    });
  }
  const explicit = (process.env.CASHFREE_VRS_ENV || '').toLowerCase();
  let env;
  if (explicit === 'production' || explicit === 'sandbox') env = explicit;
  else if (/_test_/i.test(clientSecret) || /^TEST/i.test(clientId)) env = 'sandbox';
  else if (/_prod_/i.test(clientSecret)) env = 'production';
  else {
    throw new VerificationError('Identity verification keys are set, but it is unclear if they are test or live keys. Set CASHFREE_VRS_ENV to "sandbox" or "production".', {
      status: 503, code: 'NOT_CONFIGURED',
    });
  }
  const base = env === 'sandbox' ? 'https://sandbox.cashfree.com/verification' : 'https://api.cashfree.com/verification';
  return { clientId, clientSecret, env, base };
}

/** RSA-OAEP(SHA-1) of "clientId.epochSeconds", base64 — per Cashfree 2FA docs. */
function signature(clientId) {
  let pem = process.env.CASHFREE_VRS_PUBLIC_KEY;
  if (!pem) return null;
  pem = pem.replace(/\\n/g, '\n').trim();
  const data = Buffer.from(`${clientId}.${Math.floor(Date.now() / 1000)}`);
  return crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    data
  ).toString('base64');
}

function headers(extra = {}) {
  const { clientId, clientSecret } = config();
  const h = { 'x-client-id': clientId, 'x-client-secret': clientSecret, ...extra };
  const sig = signature(clientId);
  if (sig) h['x-cf-signature'] = sig;
  return h;
}

async function request(method, path, { json, form, query, apiVersion } = {}) {
  const { base } = config();
  const url = new URL(base + path);
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));

  const h = headers(apiVersion ? { 'x-api-version': apiVersion } : {});
  let body;
  if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form; // fetch sets the multipart boundary itself

  let res;
  try {
    res = await fetch(url, { method, headers: h, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    logger.error(`Cashfree VRS ${method} ${path} network error: ${err.message}`);
    throw new VerificationError('The verification service did not respond. Please try again.', { status: 504, code: 'UPSTREAM_TIMEOUT' });
  }

  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }

  if (!res.ok) {
    const msg = data?.message || `Verification service error (${res.status})`;
    logger.error(`Cashfree VRS ${method} ${path} -> ${res.status}: ${msg}`);
    if (res.status === 401 || res.status === 403) {
      throw new VerificationError('Identity verification is not set up correctly on the server (keys or security key).', { status: 503, code: 'UPSTREAM_AUTH' });
    }
    if (res.status === 422) {
      throw new VerificationError('Identity verification is temporarily unavailable. Please try again later.', { status: 503, code: 'UPSTREAM_BALANCE' });
    }
    if (res.status === 429) {
      throw new VerificationError('Too many attempts. Please wait a minute and try again.', { status: 429, code: 'UPSTREAM_RATE_LIMIT' });
    }
    throw new VerificationError(msg, { status: res.status >= 500 ? 502 : 400, code: data?.code || 'UPSTREAM_ERROR', details: data });
  }
  return { status: res.status, data };
}

function imagePart(buffer, mimetype, filename) {
  return new Blob([buffer], { type: mimetype || 'image/jpeg' });
}

module.exports = {
  VerificationError,
  config,
  signature,

  /** Start DigiLocker: returns { url, reference_id, status }. URL lasts 10 min. */
  async createDigilockerUrl(verificationId, redirectUrl) {
    const { data } = await request('POST', '/digilocker', {
      json: { verification_id: verificationId, document_requested: ['AADHAAR'], redirect_url: redirectUrl, user_flow: 'signup' },
    });
    return data;
  },

  /** PENDING | AUTHENTICATED | EXPIRED | CONSENT_DENIED */
  async getDigilockerStatus(verificationId) {
    const { data } = await request('GET', '/digilocker', { query: { verification_id: verificationId } });
    return data;
  },

  /** Aadhaar from DigiLocker. status SUCCESS | AADHAAR_NOT_LINKED. HTTP 202 = not ready yet. */
  async getDigilockerAadhaar(verificationId) {
    const { status, data } = await request('GET', '/digilocker/document/AADHAAR', { query: { verification_id: verificationId } });
    return { httpStatus: status, ...data };
  },

  async verifyPan(pan, name) {
    const { data } = await request('POST', '/pan', { json: { pan, name }, apiVersion: '2022-09-13' });
    return data;
  },

  async verifyBankAccount(bankAccount, ifsc, name) {
    const { data } = await request('POST', '/bank-account/sync', { json: { bank_account: bankAccount, ifsc, name } });
    return data;
  },

  async faceLiveness(verificationId, buffer, mimetype) {
    const form = new FormData();
    form.append('verification_id', verificationId);
    form.append('image', imagePart(buffer, mimetype), 'selfie.jpg');
    const { data } = await request('POST', '/face-liveness', { form, apiVersion: '2024-12-01' });
    return data;
  },

  async faceMatch(verificationId, firstBuffer, secondBuffer, threshold = 0.75) {
    const form = new FormData();
    form.append('verification_id', verificationId);
    form.append('first_image', imagePart(firstBuffer, 'image/jpeg'), 'aadhaar.jpg');
    form.append('second_image', imagePart(secondBuffer, 'image/jpeg'), 'selfie.jpg');
    form.append('threshold', String(threshold));
    const { data } = await request('POST', '/face-match', { form });
    return data;
  },
};
