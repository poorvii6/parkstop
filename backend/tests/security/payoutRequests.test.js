/**
 * Owner payouts: the Saturday run, and an admin paying by hand.
 *
 * Owners no longer ask for a payout. Every Saturday weeklyPayoutService sweeps
 * each eligible wallet into a 'requested' row, and an admin sends the bank
 * transfer and marks it paid. Money rules under test:
 *   - the run does nothing at all while no admin account exists;
 *   - only a verified owner with complete bank details is swept;
 *   - the whole balance leaves the wallet once, under a row lock;
 *   - never a second row while one is open, and never below the minimum;
 *   - an admin can mark a request paid OR reject it, exactly once;
 *   - rejecting puts the money back in the wallet.
 *
 *   npx jest tests/security/payoutRequests.test.js
 */
const mockTx = {
  $executeRaw: jest.fn(),
  users: { findUnique: jest.fn(), update: jest.fn() },
  payout_requests: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
};
jest.mock('../../src/config/prisma', () => ({
  $transaction: jest.fn((fn) => fn(mockTx)),
  users: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
  payout_requests: { findMany: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
}));
jest.mock('../../src/services/notificationService', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(),
}));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const C = require('../../src/controllers/payoutRequestController');

const makeRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

const VERIFIED = {
  balance: 850.5, verification_status: 'approved',
  bank_account_number: '123456789012', bank_ifsc: 'HDFC0001234', bank_account_name: 'Poorvi',
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.users.findUnique.mockResolvedValue(VERIFIED);
  mockTx.users.findUnique.mockResolvedValue(VERIFIED);
  mockTx.payout_requests.findFirst.mockResolvedValue(null);
  mockTx.payout_requests.create.mockImplementation(async ({ data }) => ({ id: 1, created_at: new Date(), ...data }));
});

const owner = { user: { id: 7, role: 'SPOTTER' }, body: {} };

const Weekly = require('../../src/services/weeklyPayoutService');

// The run reads eligible owners, then (after paying) the admin list for the
// batch notice. Each test sets the first; the second is always empty.
const sweep = (...owners) => {
  prisma.users.findMany.mockResolvedValueOnce(owners).mockResolvedValue([]);
  return Weekly.runWeeklyPayouts();
};

describe('the Saturday payout run', () => {
  beforeEach(() => { prisma.users.count.mockResolvedValue(1); });

  test('moves the whole balance out of the wallet into one request', async () => {
    const out = await sweep({ id: 7, balance: 850.5 });
    expect(out.paid).toBe(1);
    expect(mockTx.users.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { balance: { decrement: 850.5 } } });
    const data = mockTx.payout_requests.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ user_id: 7, amount: 850.5, status: 'requested', bank_account_last4: '9012' });
  });

  test('the owner row is locked before the balance is read', async () => {
    await sweep({ id: 7, balance: 850.5 });
    expect(mockTx.$executeRaw.mock.invocationCallOrder[0])
      .toBeLessThan(mockTx.users.findUnique.mock.invocationCallOrder[0]);
  });

  test('does nothing at all while no admin account exists', async () => {
    // Nobody could pay the rows or reject them back, so no wallet is touched.
    prisma.users.count.mockResolvedValue(0);
    const out = await sweep({ id: 7, balance: 850.5 });
    expect(out.aborted).toBeTruthy();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.users.update).not.toHaveBeenCalled();
  });

  test('only verified owners with complete bank details are selected', async () => {
    await sweep();
    const where = prisma.users.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      verification_status: 'approved',
      bank_account_number: { not: null },
      bank_ifsc: { not: null },
      bank_account_name: { not: null },
    });
  });

  test('a blank name on the account is skipped and keeps the balance', async () => {
    // `not: null` lets an empty string through; the run re-checks after the lock.
    mockTx.users.findUnique.mockResolvedValue({ ...VERIFIED, bank_account_name: '' });
    const out = await sweep({ id: 7, balance: 850.5 });
    expect(out.paid).toBe(0);
    expect(mockTx.users.update).not.toHaveBeenCalled();
    expect(mockTx.payout_requests.create).not.toHaveBeenCalled();
  });

  test('an owner with a request still open is not swept again', async () => {
    mockTx.payout_requests.findFirst.mockResolvedValue({ id: 3, status: 'requested' });
    const out = await sweep({ id: 7, balance: 850.5 });
    expect(out.paid).toBe(0);
    expect(mockTx.users.update).not.toHaveBeenCalled();
  });

  test('a balance that dropped below the minimum is left for next week', async () => {
    mockTx.users.findUnique.mockResolvedValue({ ...VERIFIED, balance: 40 });
    const out = await sweep({ id: 7, balance: 850.5 });
    expect(out.paid).toBe(0);
    expect(mockTx.payout_requests.create).not.toHaveBeenCalled();
  });
});

describe('what the owner is shown', () => {
  test('an owner missing the name on the account is told to add it', async () => {
    prisma.users.findUnique.mockResolvedValue({ ...VERIFIED, bank_account_name: null });
    prisma.payout_requests.findMany.mockResolvedValue([]);
    const res = makeRes();
    await C.myRequests(owner, res);
    expect(res.body.data.eligible).toBe(false);
    expect(res.body.data.blocked_reason).toMatch(/name on the account/i);
  });

  test('a ready owner is told when the next payout is', async () => {
    prisma.payout_requests.findMany.mockResolvedValue([]);
    const res = makeRes();
    await C.myRequests(owner, res);
    expect(res.body.data.eligible).toBe(true);
    expect(new Date(res.body.data.next_payout_at).getUTCDay()).toBe(6);
  });
});

describe('admin marks paid / rejects', () => {
  const admin = (body) => ({ user: { id: 1, role: 'ADMIN' }, params: { id: '5' }, body });

  test('paid needs a bank reference', async () => {
    const res = makeRes();
    await C.adminMarkPaid(admin({ reference: '' }), res);
    expect(res.statusCode).toBe(400);
    expect(prisma.payout_requests.updateMany).not.toHaveBeenCalled();
  });

  test('paid only moves a request that is still open', async () => {
    prisma.payout_requests.updateMany.mockResolvedValue({ count: 1 });
    prisma.payout_requests.findUnique.mockResolvedValue({ id: 5, user_id: 7, amount: 850.5, status: 'paid' });
    const res = makeRes();
    await C.adminMarkPaid(admin({ reference: 'UTR123456789' }), res);
    expect(res.body.success).toBe(true);
    expect(prisma.payout_requests.updateMany.mock.calls[0][0].where).toEqual({ id: 5, status: 'requested' });
  });

  test('marking paid twice is refused', async () => {
    prisma.payout_requests.updateMany.mockResolvedValue({ count: 0 });
    const res = makeRes();
    await C.adminMarkPaid(admin({ reference: 'UTR123456789' }), res);
    expect(res.statusCode).toBe(409);
  });

  test('reject puts the money back in the wallet, once', async () => {
    mockTx.payout_requests.updateMany.mockResolvedValue({ count: 1 });
    mockTx.payout_requests.findUnique.mockResolvedValue({ id: 5, user_id: 7, amount: '850.50', status: 'rejected' });
    const res = makeRes();
    await C.adminReject(admin({ reason: 'Bank account closed' }), res);
    expect(res.body.success).toBe(true);
    expect(mockTx.users.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { balance: { increment: 850.5 } } });
  });

  test('rejecting an already handled request refunds nothing', async () => {
    mockTx.payout_requests.updateMany.mockResolvedValue({ count: 0 });
    const res = makeRes();
    await C.adminReject(admin({ reason: 'Bank account closed' }), res);
    expect(res.statusCode).toBe(409);
    expect(mockTx.users.update).not.toHaveBeenCalled();
  });
});
