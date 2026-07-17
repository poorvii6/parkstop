# Smoke Test — Booking Settlement Refactor

Purpose: verify, against the **real Railway database**, that a completed booking settles
correctly after the `BookingSettlementService` refactor. The unit tests prove the logic;
this proves the live wiring.

We use the **cash flow** because it exercises settlement end-to-end without a payment gateway:
on checkout it should mark the booking `paid`, record the commission split, and deduct the
platform fee from the Spotter's wallet.

---

## Step 1 — Deploy the new code to Railway

The app currently talks to the **old** code on Railway. Ship the refactor first:

```bash
cd "/Users/pavangowdag/Downloads/parkstop/parkstop"
git add backend/src/services/payments/BookingSettlementService.js \
        backend/src/controllers/bookingController.js \
        backend/tests/unit/ \
        backend/README.md frontend/README.md README.md
git commit -m "refactor: centralize booking settlement into one service + add unit tests"
git push
```

Railway auto-deploys on push. Wait for the deploy to go green, then confirm the server is up:

```bash
curl https://<your-railway-domain>/health
# expect: {"success":true,"database":"connected", ...}
```

No database migration is needed — this change is code-only.

---

## Step 2 — Note the Spotter's starting wallet balance

Open a database query console (Railway → your Postgres service → **Data**/Query tab, or
`psql "$DATABASE_URL"` locally) and record the Spotter's current balance:

```sql
SELECT id, name, email, balance
FROM users
WHERE role = 'spotter'
ORDER BY id;
```

Pick the Spotter account you'll test with and write down its `id` and `balance`.

---

## Step 3 — Run one cash booking through the app

Using a Finder account and the test Spotter's spot:

1. **Finder:** find the spot, start a booking, and set payment mode to **Cash**.
2. **Finder:** note the price shown and the **check-in OTP**.
3. **Spotter:** enter the check-in OTP → booking becomes **active**.
4. **Spotter:** complete/checkout the booking as **cash** (enter the checkout OTP if prompted).

---

## Step 4 — Verify settlement in the database

Find the booking you just created:

```sql
SELECT id, status, payment_mode, payment_status,
       total_price, platform_fee, spotter_earning
FROM bookings
ORDER BY id DESC
LIMIT 1;
```

**Expected:**

- `status` = `completed`
- `payment_mode` = `cash`
- `payment_status` = `paid`
- `platform_fee` and `spotter_earning` are both set (not null/0)
- `platform_fee + spotter_earning` = `total_price`

Then re-check the Spotter's wallet:

```sql
SELECT id, balance FROM users WHERE id = <spotter_id>;
```

**Expected:** `balance` decreased by exactly `platform_fee` versus Step 2
(for cash, the Spotter keeps the cash and owes the platform its cut).

✅ If both match, the cash settlement path is verified live.

---

## Step 5 (optional) — Online payout path

If you have Razorpay/Stripe test mode wired up:

1. Make a booking with payment mode **Online** and complete payment.
2. Check in / check out as above.
3. Confirm a payout is created for the Spotter:

```sql
SELECT id, user_id, booking_id, amount, status
FROM payouts
ORDER BY id DESC
LIMIT 3;
```

**Expected:** a payout row for the Spotter with a healthy `status` (queued/processing/paid),
**not** `failed_needs_retry`. A `failed_needs_retry` row means the payout worker or Redis
connection needs a look — but note the Spotter's earnings are still safe (credited to wallet
as fallback).

---

## Step 6 (optional) — Confirm the gap we closed

The refactor's headline fix: a Finder self-checkout must **not** pay the Spotter before the
Finder's money is collected. To confirm, create an **online, unpaid** booking and have the
**Finder end the session** (self-checkout). Then:

```sql
SELECT id, payment_status, spotter_earning FROM bookings ORDER BY id DESC LIMIT 1;
SELECT id, booking_id, status FROM payouts ORDER BY id DESC LIMIT 1;
```

**Expected:** the booking's `spotter_earning` may be recorded, but there is **no payout**
queued/sent for that booking (because it was never paid). Before the fix, this would have
paid the Spotter real money the platform never collected.

---

## Cleanup

Test rows are safe to leave, or remove them by booking id:

```sql
DELETE FROM bookings WHERE id = <test_booking_id>;
```
