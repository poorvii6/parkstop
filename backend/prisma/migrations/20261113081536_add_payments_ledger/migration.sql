-- CreateTable
CREATE TABLE "payments" (
    "id" SERIAL NOT NULL,
    "booking_id" INTEGER NOT NULL,
    "razorpay_payment_id" VARCHAR(100) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "arrears_cleared" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(20) NOT NULL DEFAULT 'captured',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_razorpay_payment_id_key" ON "payments"("razorpay_payment_id");

-- CreateIndex
CREATE INDEX "payments_booking_id_idx" ON "payments"("booking_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

