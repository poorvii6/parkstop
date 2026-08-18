-- Prepaid bookings: advance fee, prepaid floor, and the refund lifecycle.
--
-- Railway runs `npx prisma db push` on every deploy (see the start script), so
-- these columns land automatically from schema.prisma. This file exists as the
-- explicit record and as a fallback for a database where db push is not the
-- deploy path.
--
-- Every column is nullable or defaulted, so this is safe to run against a live
-- table with existing rows and needs no downtime.

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS advance_fee         DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_paid         DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_amount       DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS refund_status       VARCHAR(20),
  ADD COLUMN IF NOT EXISTS refund_id           VARCHAR(100),
  ADD COLUMN IF NOT EXISTS refunded_at         TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(30);

-- Existing bookings predate prepayment: nothing was collected up front, so the
-- floor is zero and checkout keeps billing them purely on actual time. Leaving
-- these NULL would be indistinguishable from "prepaid nothing" but would break
-- arithmetic that assumes a number.
UPDATE "bookings"
   SET amount_paid = 0
 WHERE amount_paid IS NULL;

UPDATE "bookings"
   SET advance_fee = 0
 WHERE advance_fee IS NULL;

-- Finding the no-shows a finder can still claim against is the one query the
-- refund flow runs on an unindexed column.
CREATE INDEX IF NOT EXISTS bookings_refund_status_idx
    ON "bookings" (refund_status)
 WHERE refund_status IS NOT NULL;
