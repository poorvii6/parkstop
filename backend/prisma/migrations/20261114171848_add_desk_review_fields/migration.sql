-- AlterTable
ALTER TABLE "spot_verifications" ADD COLUMN     "address_match_verdict" VARCHAR(20),
ADD COLUMN     "desk_override_reason" VARCHAR(500),
ADD COLUMN     "geocode_precision" VARCHAR(20),
ADD COLUMN     "geocode_uncertainty_m" INTEGER;
