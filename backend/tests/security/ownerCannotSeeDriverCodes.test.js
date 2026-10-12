/**
 * The driver's entry and exit codes are theirs to hand over at the gate.
 * An owner who can read them could check a driver in or out on their own.
 *
 *   npx jest tests/security/ownerCannotSeeDriverCodes.test.js
 */
jest.mock('../../src/config/prisma', () => ({
  bookings: { findMany: jest.fn() },
}));
jest.mock('../../src/services/paymentService', () => ({}));
jest.mock('../../src/config/socket', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const { emitToUser } = require('../../src/config/socket');
const Booking = require('../../src/models/Booking');
const NotificationService = require('../../src/services/notificationService');

const row = { id: 1, status: 'reserved', otp_code: '111111', checkout_otp: '222222', total_price: 40 };

test('forOwner removes both codes and keeps everything else', () => {
  const v = Booking.forOwner(row);
  expect(v.otp_code).toBeUndefined();
  expect(v.checkout_otp).toBeUndefined();
  expect(v.total_price).toBe(40);
  expect(row.otp_code).toBe('111111'); // original untouched
});

test("the owner's booking list has no codes", async () => {
  prisma.bookings.findMany.mockResolvedValue([row, { ...row, id: 2 }]);
  const list = await Booking.findBySpotter(9);
  for (const b of list) {
    expect(b).not.toHaveProperty('otp_code');
    expect(b).not.toHaveProperty('checkout_otp');
  }
});

test('the live "new booking" event to the owner has no codes', async () => {
  jest.spyOn(NotificationService, 'sendNotification').mockResolvedValue();
  jest.spyOn(NotificationService, 'sendPushNotification').mockResolvedValue();
  await NotificationService.notifyNewBooking(9, row);
  const payload = emitToUser.mock.calls.find((c) => c[1] === 'booking:new')[2];
  expect(payload).not.toHaveProperty('otp_code');
  expect(payload).not.toHaveProperty('checkout_otp');
  expect(payload.id).toBe(1);
});
