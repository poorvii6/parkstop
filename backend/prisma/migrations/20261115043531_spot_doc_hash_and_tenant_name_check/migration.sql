-- AlterTable
ALTER TABLE "spot_verifications" ADD COLUMN     "doc_sha256" VARCHAR(64),
ADD COLUMN     "landlord_noc_sha256" VARCHAR(64),
ADD COLUMN     "name_checked_against" VARCHAR(20),
ADD COLUMN     "noc_names_owner" BOOLEAN;
