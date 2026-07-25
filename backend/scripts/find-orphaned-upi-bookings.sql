-- Orphaned online bookings — possible UPI payments that were never credited.
--
-- CONTEXT: the old UPI flow deep-linked a peer-to-peer transfer to a hardcoded
-- VPA, then asked the server to confirm with a fake signature. In production the
-- server (correctly) refused, so if a user actually completed that transfer the
-- money left their account while the booking stayed unpaid.
--
-- This finds bookings that look like that: the user chose online payment, an
-- order was created, but the booking was never marked paid.
--
-- Run against production (read-only):
--   psql "$DATABASE_URL" -f find-orphaned-upi-bookings.sql
--
-- Interpreting results:
--   - No rows            -> nobody was left out of pocket. Nothing to do.
--   - Rows present       -> check each user's claim against the VPA's statement
--                           for a transfer of `total_price` near `created_at`.
--                           Refund any that match.
--   - Rows with tiny/zero amounts, or only your own test account, are almost
--     certainly your own testing rather than real users.

SELECT
  b.id                                  AS booking_id,
  b.created_at,
  b.status,
  b.payment_status,
  b.payment_mode,
  b.total_price,
  u.id                                  AS user_id,
  u.email,
  u.phone,
  s.title                               AS spot_title
FROM bookings b
JOIN users u          ON u.id = b.user_id
LEFT JOIN parking_spots s ON s.id = b.spot_id
WHERE b.payment_mode = 'online'
  AND b.payment_status IS DISTINCT FROM 'paid'
ORDER BY b.created_at DESC;

-- Summary: how many, and how much money is potentially unaccounted for.
SELECT
  COUNT(*)                    AS orphaned_bookings,
  COALESCE(SUM(total_price), 0) AS total_at_risk
FROM bookings
WHERE payment_mode = 'online'
  AND payment_status IS DISTINCT FROM 'paid';
