/**
 * Owner payout requests (paid by hand by an admin).
 *
 * Money rules under test:
 *   - only a verified owner with a verified bank account can request;
 *   - the whole balance leaves the wallet once, at request time;
 *   - only one open request at a time, and a minimum amount;
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
  users: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
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

describe('owner requests a payout', () => {
  test('moves the whole balance out of the wallet into one request', async () => {
    const res = makeRes();
    await C.requestPayout(owner, res);
    expect(res.body.success).toBe(true);
    expect(mockTx.users.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { balance: { decrement: 850.5 } } });
    const data = mockTx.payout_requests.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ user_id: 7, amount: 850.5, status: 'requested', bank_account_last4: '9012' });
  });

  test('the owner row is locked before the balance is read', async () => {
    await C.requestPayout(owner, makeRes());
    expect(mockTx.$executeRaw.mock.invocationCallOrder[0])
      .toBeLessThan(mockTx.users.findUnique.mock.invocationCallOrder[0]);
  });

  test('an unverified owner cannot request', async () => {
    prisma.users.findUnique.mockResolvedValue({ ...VERIFIED, verification_status: 'pending' });
    const res = makeRes();
    await C.requestPayout(owner, res);
    expect(res.statusCode).toBe(403);
    expect(mockTx.users.update).not.toHaveBeenCalled();
  });

  test('an owner with no verified bank account cannot request', async () => {
    prisma.users.findUnique.mockResolvedValue({ ...VERIFIED, bank_account_number: null });
    const res = makeRes();
    await C.requestPayout(owner, res);
    expect(res.statusCode).toBe(403);
  });

  test('a second request while one is open is refused', async () => {
    mockTx.payout_requests.findFirst.mockResolvedValue({ id: 3, status: 'requested' });
    const res = makeRes();
    await C.requestPayout(owner, res);
    expect(res.statusCode).toBe(409);
    expect(mockTx.users.update).not.toHaveBeenCalled();
  });

  test('below the minimum is refused', async () => {
    mockTx.users.findUnique.mockResolvedValue({ ...VERIFIED, balance: 40 });
    const res = makeRes();
    await C.requestPayout(owner, res);
    expect(res.statusCode).toBe(400);
    expect(mockTx.payout_requests.create).not.toHaveBeenCalled();
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
