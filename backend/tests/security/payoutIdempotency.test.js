/**
 * An owner is credited for a booking AT MOST ONCE, however many paths fire:
 * the payment webhook, checkout confirmation, a queue retry, the recovery
 * sweep. Uses the REAL PayoutService with prisma mocked.
 *
 *   npx jest tests/security/payoutIdempotency.test.js
 */
const mockTx = {
  $executeRaw: jest.fn(),
  payouts: { findFirst: jest.fn(), create: jest.fn() },
  users: { update: jest.fn() },
};
jest.mock('../../src/config/prisma', () => ({
  $transaction: jest.fn((fn) => fn(mockTx)),
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const PayoutService = require('../../src/services/payments/PayoutService');

beforeEach(() => {
  jest.clearAllMocks();
  mockTx.payouts.create.mockResolvedValue({ id: 1 });
  mockTx.users.update.mockResolvedValue({});
});

const credits = () => mockTx.users.update.mock.calls.filter((c) => c[0]?.data?.balance?.increment !== undefined);

test('the same booking twice credits the owner once', async () => {
  mockTx.payouts.findFirst
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ id: 1, booking_id: 55, status: 'balance_credited' });

  await PayoutService.processBookingPayout(55, 80, 8);
  await PayoutService.processBookingPayout(55, 80, 8);

  expect(credits()).toHaveLength(1);
  expect(credits()[0][0]).toEqual({ where: { id: 8 }, data: { balance: { increment: 80 } } });
});

test('the booking row is locked before checking, inside the same transaction', async () => {
  mockTx.payouts.findFirst.mockResolvedValue(null);
  await PayoutService.processBookingPayout(55, 80, 8);
  const lockOrder = mockTx.$executeRaw.mock.invocationCallOrder[0];
  const checkOrder = mockTx.payouts.findFirst.mock.invocationCallOrder[0];
  expect(lockOrder).toBeLessThan(checkOrder);
});

test('an old failed-payout row also counts as done (it already credited the wallet)', async () => {
  mockTx.payouts.findFirst.mockResolvedValue({ id: 3, booking_id: 55, status: 'failed_needs_retry' });
  await PayoutService.processBookingPayout(55, 80, 8);
  expect(credits()).toHaveLength(0);
});

test('a database failure throws and credits nothing, so it can be retried', async () => {
  mockTx.payouts.findFirst.mockResolvedValue(null);
  mockTx.payouts.create.mockRejectedValue(new Error('db down'));
  await expect(PayoutService.processBookingPayout(55, 80, 8)).rejects.toThrow('db down');
  expect(credits()).toHaveLength(0);
});

test('nothing to pay → no-op', async () => {
  expect(await PayoutService.processBookingPayout(55, 0, 8)).toBeNull();
  expect(mockTx.payouts.findFirst).not.toHaveBeenCalled();
});
