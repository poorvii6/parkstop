/**
 * BUG 4: PayoutService.processBookingPayout is not idempotent per booking, and
 * two independent triggers can call it for the same online booking -> the
 * spotter is paid twice. Uses the REAL PayoutService with prisma mocked.
 */
jest.mock('../../src/config/prisma', () => ({
  users: { findUnique: jest.fn(), update: jest.fn() },
  payouts: { create: jest.fn(), findFirst: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const PayoutService = require('../../src/services/payments/PayoutService');

beforeEach(() => jest.clearAllMocks());

test('paying out the same booking twice must credit the spotter only once', async () => {
  // Spotter with no RazorpayX fund account -> local wallet-credit path.
  prisma.users.findUnique.mockResolvedValue({ id: 8, razorpay_fund_account_id: null, payout_mode: 'upi' });
  prisma.payouts.create.mockResolvedValue({ id: 1 });
  prisma.users.update.mockResolvedValue({});
  // First call: no prior payout exists. Second call: the first payout now exists.
  prisma.payouts.findFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 1, booking_id: 55, status: 'balance_credited' });

  await PayoutService.processBookingPayout(55, 80, 8); // trigger A (payment capture)
  await PayoutService.processBookingPayout(55, 80, 8); // trigger B (checkout settlement)

  const balanceCredits = prisma.users.update.mock.calls
    .filter(c => c[0]?.data?.balance?.increment !== undefined).length;
  expect(balanceCredits).toBe(1); // secure: second call is a no-op
});
