-- AlterTable
ALTER TABLE "parking_spots" ADD COLUMN     "spot_verification_status" VARCHAR(20) DEFAULT 'not_started';

-- CreateTable
CREATE TABLE "spot_verifications" (
    "id" SERIAL NOT NULL,
    "spot_id" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'not_started',
    "doc_type" VARCHAR(30),
    "doc_public_id" VARCHAR(255),
    "claimed_address" VARCHAR(300),
    "relationship" VARCHAR(10),
    "landlord_name" VARCHAR(150),
    "landlord_noc_public_id" VARCHAR(255),
    "submitted_at" TIMESTAMP(6),
    "grandfathered_at" TIMESTAMP(6),
    "name_on_document" VARCHAR(150),
    "name_match" VARCHAR(30),
    "geocoded_lat" DECIMAL(10,8),
    "geocoded_lng" DECIMAL(11,8),
    "geocode_source" VARCHAR(20),
    "address_match_metres" INTEGER,
    "desk_reviewed_by" INTEGER,
    "desk_reviewed_at" TIMESTAMP(6),
    "field_office" VARCHAR(120),
    "field_record_found" BOOLEAN,
    "field_reference" VARCHAR(100),
    "field_notes" VARCHAR(1000),
    "field_checked_by" INTEGER,
    "field_checked_at" TIMESTAMP(6),
    "rejection_reason" VARCHAR(500),
    "review_log" JSONB DEFAULT '[]',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spot_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spot_verifications_spot_id_key" ON "spot_verifications"("spot_id");

-- CreateIndex
CREATE INDEX "spot_verifications_status_idx" ON "spot_verifications"("status");

-- CreateIndex
CREATE INDEX "spot_verifications_submitted_at_idx" ON "spot_verifications"("submitted_at");

-- CreateIndex
CREATE INDEX "parking_spots_spot_verification_status_idx" ON "parking_spots"("spot_verification_status");

-- AddForeignKey
ALTER TABLE "spot_verifications" ADD CONSTRAINT "spot_verifications_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "parking_spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===========================================================================
-- DATA MIGRATION -- placing the spots that already exist.
--
-- This is in the same file as the ALTER on purpose. The finder's new condition
-- is `spot_verification_status IN ('approved','grandfathered')`, so between
-- adding the column and filling it, every live spot would be invisible. Prisma
-- runs a migration file in one transaction and `migrate deploy` runs before
-- `node src/server.js`, so no request is ever served against a half-filled
-- column.
--
-- ADD COLUMN ... DEFAULT already wrote 'not_started' on every existing row,
-- which is the right answer for all but the live ones:
--
--   live now (active, not deleted, owner approved) -> grandfathered, stays
--     visible. NOT 'approved': nobody checked these addresses, and writing
--     'approved' would record a check that never happened, which is the one
--     thing this feature exists to prevent. They are visible, they are in the
--     admin backlog, and they are deliberately off the 48-hour clock because
--     nobody promised them 48 hours.
--   active but owner not approved -> not_started. Already invisible today
--     (findNearby filters on the owner), so nothing changes for them.
--   inactive or deleted -> not_started.
--
-- Production when this was written: 16 spots, 6 live (2 owners), 1 active with
-- an unapproved owner, 9 inactive or deleted, 0 open bookings.
-- ===========================================================================

UPDATE "parking_spots" s
   SET "spot_verification_status" = 'grandfathered'
  FROM "users" u
 WHERE u."id" = s."spotter_id"
   AND s."is_active" = true
   AND s."deleted_at" IS NULL
   AND u."verification_status" = 'approved';

-- One record per spot, mirroring the status just written. Grandfathered rows
-- are stamped with grandfathered_at -- which is what keeps them visible while
-- their review is in flight, since desk_pending is not a status a driver may
-- see -- and carry a log entry saying why they are visible without a check, so
-- the state is still explicable to whoever reads it next year.
INSERT INTO "spot_verifications" ("spot_id", "status", "grandfathered_at", "review_log")
SELECT
  s."id",
  COALESCE(s."spot_verification_status", 'not_started'),
  CASE WHEN s."spot_verification_status" = 'grandfathered' THEN now() ELSE NULL END,
  CASE WHEN s."spot_verification_status" = 'grandfathered'
    THEN jsonb_build_array(jsonb_build_object(
           'at',     to_jsonb(now()),
           'stage',  'backfill',
           'action', 'grandfathered',
           'note',   'Live in the finder when per-spot verification shipped. Needs a desk and field check.'
         ))
    ELSE '[]'::jsonb
  END
FROM "parking_spots" s;
