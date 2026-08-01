/**
 * cashfree-test.js — one-off probe to validate Cashfree SANDBOX access.
 *
 * It does NOT touch the ParkStop app or database. It just calls Cashfree's
 * sandbox to confirm:
 *   1) your test keys are valid (creates a plain order), and
 *   2) Easy Split is enabled on your account (creates a test vendor).
 *
 * Keys are read from environment variables so they are never committed.
 *
 * RUN (Windows PowerShell), from the backend folder:
 *   $env:CASHFREE_APP_ID="TEST....."; $env:CASHFREE_SECRET_KEY="cfsk_ma_test_....."; node scripts/cashfree-test.js
 */
const https = require('https');

const APP_ID = process.env.CASHFREE_APP_ID;
const SECRET = process.env.CASHFREE_SECRET_KEY;

if (!APP_ID || !SECRET) {
  console.error('\n[!] Set CASHFREE_APP_ID and CASHFREE_SECRET_KEY first, e.g. (PowerShell):');
  console.error('    $env:CASHFREE_APP_ID="TEST..."; $env:CASHFREE_SECRET_KEY="cfsk_ma_test_..."; node scripts/cashfree-test.js\n');
  process.exit(1);
}

const HOST = 'sandbox.cashfree.com';
const API_VERSION = '2023-08-01';

function call(path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: HOST,
        path,
        method: 'POST',
        headers: {
          'x-client-id': APP_ID,
          'x-client-secret': SECRET,
          'x-api-version': API_VERSION,
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => (chunks += d));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(chunks); } catch { parsed = chunks; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('\n================ 1) CREATE PLAIN ORDER (validates keys) ================');
  const order = await call('/pg/orders', {
    order_amount: 100.0,
    order_currency: 'INR',
    customer_details: {
      customer_id: 'finder_test_1',
      customer_phone: '9999999999',
      customer_email: 'finder@parkstop.app',
    },
    order_note: 'ParkStop Easy Split probe',
  });
  console.log('HTTP', order.status);
  console.log(JSON.stringify(order.body, null, 2));

  console.log('\n================ 2) CREATE EASY SPLIT VENDOR (validates Easy Split) ================');
  const vendor = await call('/pg/easy-split/vendors', {
    vendor_id: 'spotter_test_1',
    status: 'ACTIVE',
    name: 'Test Spotter',
    email: 'spotter@parkstop.app',
    phone: '8888888888',
    verify_account: false,
    dashboard_access: false,
    kyc_details: {
      account_type: 'Individual',
      business_type: 'Miscellaneous',
      pan: 'ABCDE1234F',
    },
    bank: {
      account_number: '00011020001772',
      account_holder: 'Test Spotter',
      ifsc: 'HDFC0000001',
    },
  });
  console.log('HTTP', vendor.status);
  console.log(JSON.stringify(vendor.body, null, 2));

  console.log('\n================ 3) CREATE ORDER WITH 80/20 SPLIT ================');
  const splitOrder = await call('/pg/orders', {
    order_amount: 100.0,
    order_currency: 'INR',
    customer_details: {
      customer_id: 'finder_test_2',
      customer_phone: '9999999999',
      customer_email: 'finder@parkstop.app',
    },
    order_splits: [{ vendor_id: 'spotter_test_1', percentage: 80 }],
    order_note: 'ParkStop 80/20 split test',
  });
  console.log('HTTP', splitOrder.status);
  console.log(JSON.stringify(splitOrder.body, null, 2));

  console.log('\n================ DONE ================');
  console.log('Copy BOTH sections above (HTTP codes + bodies) and paste them back.');
})();
