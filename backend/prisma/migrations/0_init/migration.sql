-- CreateTable
CREATE TABLE "bookings" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "spot_id" INTEGER,
    "start_time" TIMESTAMP(6) NOT NULL,
    "end_time" TIMESTAMP(6),
    "status" VARCHAR(20) DEFAULT 'active',
    "total_price" DECIMAL(10,2),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "hours" DECIMAL NOT NULL DEFAULT 1,
    "otp_code" VARCHAR(10),
    "otp_expires_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "actual_end_time" TIMESTAMP(6),
    "otp_attempts" INTEGER DEFAULT 0,
    "platform_fee" DECIMAL(10,2) DEFAULT 0,
    "spotter_earning" DECIMAL(10,2) DEFAULT 0,
    "vehicle_type" VARCHAR(20) DEFAULT 'car',
    "vehicle_subtype" VARCHAR(50),
    "payment_id" VARCHAR(100),
    "payment_method_id" INTEGER,
    "payment_status" VARCHAR(20) DEFAULT 'pending',
    "payment_mode" VARCHAR(20) DEFAULT 'online',
    "checkout_otp" VARCHAR(10),
    "slot_name" VARCHAR(50),
    "advance_fee" DECIMAL(10,2) DEFAULT 0,
    "amount_paid" DECIMAL(10,2) DEFAULT 0,
    "refund_amount" DECIMAL(10,2),
    "refund_status" VARCHAR(20),
    "refund_id" VARCHAR(100),
    "refunded_at" TIMESTAMP(6),
    "cancellation_reason" VARCHAR(30),

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parking_spots" (
    "id" SERIAL NOT NULL,
    "spotter_id" INTEGER,
    "title" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "price_per_hour" DECIMAL(10,2) NOT NULL,
    "latitude" DECIMAL(10,8),
    "longitude" DECIMAL(11,8),
    "is_available" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "address" TEXT,
    "base_price" DECIMAL,
    "total_slots" INTEGER DEFAULT 1,
    "available_slots" INTEGER DEFAULT 1,
    "location_type" VARCHAR(20),
    "is_active" BOOLEAN DEFAULT true,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(6),
    "amenities" JSONB DEFAULT '[]',
    "bike_slots" INTEGER DEFAULT 0,
    "car_slots" INTEGER DEFAULT 1,
    "images" JSONB DEFAULT '[]',
    "slot_names" JSONB DEFAULT '[]',

    CONSTRAINT "parking_spots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "provider" VARCHAR(50) NOT NULL,
    "provider_method_id" VARCHAR(255) NOT NULL,
    "method_type" VARCHAR(20) NOT NULL,
    "last4" VARCHAR(4),
    "brand" VARCHAR(50),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "firebase_uid" VARCHAR(128),
    "role" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "phone" VARCHAR(20),
    "full_name" VARCHAR(255),
    "stripe_account_id" VARCHAR(255),
    "payout_provider" VARCHAR(20) DEFAULT 'stripe',
    "push_token" TEXT,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "balance" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "address" VARCHAR(255),
    "dob" VARCHAR(20),
    "upi_id" VARCHAR(50),
    "bank_account_number" VARCHAR(20),
    "bank_ifsc" VARCHAR(15),
    "bank_account_name" VARCHAR(100),
    "razorpay_contact_id" VARCHAR(50),
    "razorpay_fund_account_id" VARCHAR(50),
    "cashfree_vendor_id" VARCHAR(60),
    "cashfree_vendor_status" VARCHAR(30),
    "payout_mode" VARCHAR(20) DEFAULT 'upi',
    "is_finder_registered" BOOLEAN NOT NULL DEFAULT true,
    "is_spotter_registered" BOOLEAN NOT NULL DEFAULT false,
    "quiet_hours_start" INTEGER,
    "quiet_hours_end" INTEGER,
    "verification_status" TEXT,
    "otp_auth_times" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "platform" VARCHAR(20),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "type" VARCHAR(40),
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "booking_id" INTEGER,
    "amount" DECIMAL(10,2) NOT NULL,
    "razorpay_payout_id" VARCHAR(100),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "mode" VARCHAR(20) NOT NULL DEFAULT 'UPI',
    "purpose" VARCHAR(50) DEFAULT 'payout',
    "narration" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_requests" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "bank_account_name" VARCHAR(100),
    "bank_account_last4" VARCHAR(4),
    "bank_ifsc" VARCHAR(15),
    "reference" VARCHAR(100),
    "note" VARCHAR(300),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(6),
    "processed_by" INTEGER,

    CONSTRAINT "payout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawals" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "payment_method_id" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_spots" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "spot_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_spots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" SERIAL NOT NULL,
    "booking_id" INTEGER NOT NULL,
    "reviewer_id" INTEGER NOT NULL,
    "spotter_id" INTEGER NOT NULL,
    "spot_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_otps" (
    "email" VARCHAR(150) NOT NULL,
    "code" VARCHAR(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_otps_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" SERIAL NOT NULL,
    "booking_id" INTEGER NOT NULL,
    "raised_by" INTEGER NOT NULL,
    "reason" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "owner_verifications" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'not_started',
    "digilocker_verification_id" VARCHAR(50),
    "aadhaar_name" VARCHAR(150),
    "aadhaar_last4" VARCHAR(4),
    "aadhaar_dob" VARCHAR(20),
    "aadhaar_gender" VARCHAR(10),
    "aadhaar_state" VARCHAR(60),
    "aadhaar_pincode" VARCHAR(10),
    "aadhaar_verified_at" TIMESTAMP(6),
    "pan_masked" VARCHAR(10),
    "pan_hash" VARCHAR(64),
    "pan_registered_name" VARCHAR(150),
    "pan_name_match" VARCHAR(30),
    "pan_aadhaar_linked" VARCHAR(4),
    "pan_verified_at" TIMESTAMP(6),
    "liveness_score" DOUBLE PRECISION,
    "face_match_score" DOUBLE PRECISION,
    "selfie_verified_at" TIMESTAMP(6),
    "bank_last4" VARCHAR(4),
    "bank_ifsc" VARCHAR(11),
    "bank_name" VARCHAR(100),
    "bank_name_at_bank" VARCHAR(150),
    "bank_name_match" VARCHAR(30),
    "bank_verified_at" TIMESTAMP(6),
    "property_doc_type" VARCHAR(30),
    "property_doc_public_id" VARCHAR(255),
    "property_address" VARCHAR(300),
    "property_uploaded_at" TIMESTAMP(6),
    "flags" JSONB,
    "attempts" JSONB,
    "submitted_at" TIMESTAMP(6),
    "reviewed_at" TIMESTAMP(6),
    "reviewed_by" INTEGER,
    "rejection_reason" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bookings_user_id_idx" ON "bookings"("user_id");

-- CreateIndex
CREATE INDEX "bookings_spot_id_idx" ON "bookings"("spot_id");

-- CreateIndex
CREATE INDEX "bookings_status_idx" ON "bookings"("status");

-- CreateIndex
CREATE INDEX "bookings_spot_id_status_idx" ON "bookings"("spot_id", "status");

-- CreateIndex
CREATE INDEX "bookings_user_id_status_idx" ON "bookings"("user_id", "status");

-- CreateIndex
CREATE INDEX "bookings_created_at_idx" ON "bookings"("created_at");

-- CreateIndex
CREATE INDEX "parking_spots_spotter_id_idx" ON "parking_spots"("spotter_id");

-- CreateIndex
CREATE INDEX "parking_spots_is_active_idx" ON "parking_spots"("is_active");

-- CreateIndex
CREATE INDEX "parking_spots_is_available_idx" ON "parking_spots"("is_available");

-- CreateIndex
CREATE INDEX "parking_spots_latitude_longitude_idx" ON "parking_spots"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "parking_spots_location_type_idx" ON "parking_spots"("location_type");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_push_token_idx" ON "users"("push_token");

-- CreateIndex
CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

-- CreateIndex
CREATE INDEX "device_tokens_user_id_idx" ON "device_tokens"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_idx" ON "notifications"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_idx" ON "notifications"("user_id", "read");

-- CreateIndex
CREATE INDEX "payouts_user_id_idx" ON "payouts"("user_id");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_booking_id_key" ON "payouts"("booking_id");

-- CreateIndex
CREATE INDEX "payout_requests_user_id_idx" ON "payout_requests"("user_id");

-- CreateIndex
CREATE INDEX "payout_requests_status_idx" ON "payout_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "saved_spots_user_id_spot_id_key" ON "saved_spots"("user_id", "spot_id");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_booking_id_key" ON "reviews"("booking_id");

-- CreateIndex
CREATE INDEX "reviews_spotter_id_idx" ON "reviews"("spotter_id");

-- CreateIndex
CREATE INDEX "reviews_spot_id_idx" ON "reviews"("spot_id");

-- CreateIndex
CREATE INDEX "email_otps_expires_at_idx" ON "email_otps"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "disputes_booking_id_key" ON "disputes"("booking_id");

-- CreateIndex
CREATE INDEX "disputes_status_idx" ON "disputes"("status");

-- CreateIndex
CREATE INDEX "disputes_booking_id_idx" ON "disputes"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "owner_verifications_user_id_key" ON "owner_verifications"("user_id");

-- CreateIndex
CREATE INDEX "owner_verifications_status_idx" ON "owner_verifications"("status");

-- CreateIndex
CREATE INDEX "owner_verifications_pan_hash_idx" ON "owner_verifications"("pan_hash");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "parking_spots"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "parking_spots" ADD CONSTRAINT "parking_spots_spotter_id_fkey" FOREIGN KEY ("spotter_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_requests" ADD CONSTRAINT "payout_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_spots" ADD CONSTRAINT "saved_spots_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "parking_spots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_spots" ADD CONSTRAINT "saved_spots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_spotter_id_fkey" FOREIGN KEY ("spotter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_spot_id_fkey" FOREIGN KEY ("spot_id") REFERENCES "parking_spots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_fkey" FOREIGN KEY ("raised_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "owner_verifications" ADD CONSTRAINT "owner_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

