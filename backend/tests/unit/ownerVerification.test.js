/**
 * Owner verification — the rules that decide who may list parking and get paid.
 *   npx jest tests/unit/ownerVerification.test.js
 */
jest.mock('../../src/config/prisma', () => ({
  owner_verifications: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  users: { update: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  $transaction: jest.fn((ops) => Promise.all(ops)),
}));
jest.mock('../../src/services/cashfreeVerification', () => {
  class VerificationError extends Error { constructor(m, o = {}) { super(m); this.status = o.status || 502; this.code = o.code; } }
  return {
    VerificationError,
    createDigilockerUrl: jest.fn(), getDigilockerStatus: jest.fn(), getDigilockerAadhaar: jest.fn(),
    verifyPan: jest.fn(), verifyBankAccount: jest.fn(), faceLiveness: jest.fn(), faceMatch: jest.fn(),
  };
});
jest.mock('../../src/services/notificationService', () => ({ sendPushNotification: jest.fn().mockResolvedValue() }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), url: jest.fn(() => 'https://signed'), uploader: { upload_stream: jest.fn(), destroy: jest.fn() } } }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const prisma = require('../../src/config/prisma');
const cf = require('../../src/services/cashfreeVerification');
const C = require('../../src/controllers/ownerVerificationController');
const { hasRole } = require('../../src/utils/roles');

const resMock = () => { const r = {}; r.status = jest.fn(() => r); r.json = jest.fn(() => r); r.set = jest.fn(() => r); r.send = jest.fn(() => r); return r; };
const req = (body = {}, extra = {}) => ({ user: { id: 7, role: 'FINDER', is_spotter_registered: true }, body, params: {}, query: {}, get: () => 'api.test', ...extra });
const AADHAAR_DONE = { id: 1, user_id: 7, status: 'in_progress', aadhaar_name: 'POORVI H K', aadhaar_verified_at: new Date(), digilocker_verification_id: 'PS_7_DL', attempts: {}, flags: [] };
let rec;

beforeEach(() => {
  jest.clearAllMocks();
  rec = { ...AADHAAR_DONE };
  prisma.owner_verifications.findUnique.mockImplementation(async () => rec);
  prisma.owner_verifications.findFirst.mockResolvedValue(null);
  prisma.owner_verifications.update.mockImplementation(async ({ data }) => { rec = { ...rec, ...data }; return rec; });
  prisma.users.update.mockResolvedValue({});
});

describe('hasRole (one account can be driver AND owner)', () => {
  it('lets a registered owner use owner routes while in driver mode', () => {
    expect(hasRole({ role: 'FINDER', is_spotter_registered: true }, 'SPOTTER')).toBe(true);
  });
  it('blocks owner routes for someone who never became an owner', () => {
    expect(hasRole({ role: 'FINDER', is_spotter_registered: false }, 'SPOTTER')).toBe(false);
  });
  it('lets an owner book parking as a driver', () => {
    expect(hasRole({ role: 'SPOTTER', is_finder_registered: true }, 'FINDER')).toBe(true);
  });
  it('admin only by role', () => {
    expect(hasRole({ role: 'SPOTTER', is_spotter_registered: true }, 'ADMIN')).toBe(false);
    expect(hasRole({ role: 'ADMIN' }, 'ADMIN')).toBe(true);
  });
});

describe('Aadhaar via DigiLocker', () => {
  it('refuses to save anything until DigiLocker says AUTHENTICATED', async () => {
    cf.getDigilockerStatus.mockResolvedValue({ status: 'PENDING' });
    const res = resMock();
    await C.completeAadhaar(req(), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(cf.getDigilockerAadhaar).not.toHaveBeenCalled();
  });
  it('keeps only the last 4 digits of Aadhaar', async () => {
    cf.getDigilockerStatus.mockResolvedValue({ status: 'AUTHENTICATED' });
    cf.getDigilockerAadhaar.mockResolvedValue({ httpStatus: 200, status: 'SUCCESS', name: 'POORVI H K', uid: 'xxxxxxxx5678', dob: '01-01-2004', split_address: { state: 'Karnataka', pincode: '560001' } });
    const res = resMock();
    await C.completeAadhaar(req(), res);
    const saved = prisma.owner_verifications.update.mock.calls[0][0].data;
    expect(saved.aadhaar_last4).toBe('5678');
    expect(JSON.stringify(saved)).not.toMatch(/photo|xml/i);
  });
  it('handles consent denied', async () => {
    cf.getDigilockerStatus.mockResolvedValue({ status: 'CONSENT_DENIED' });
    const res = resMock();
    await C.completeAadhaar(req(), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('PAN', () => {
  it('needs Aadhaar first', async () => {
    rec = { ...rec, aadhaar_verified_at: null };
    const res = resMock();
    await C.verifyPan(req({ pan: 'ABCPV1234D' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(cf.verifyPan).not.toHaveBeenCalled();
  });
  it('rejects a business PAN', async () => {
    const res = resMock();
    await C.verifyPan(req({ pan: 'ABCCD8000T' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
  it('rejects when the PAN name does not match Aadhaar', async () => {
    cf.verifyPan.mockResolvedValue({ valid: true, pan_status: 'VALID', name_match_result: 'NO_MATCH', registered_name: 'SOMEONE ELSE' });
    const res = resMock();
    await C.verifyPan(req({ pan: 'ABCPV1234D' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(rec.pan_verified_at).toBeUndefined();
  });
  it('blocks a PAN already used by another owner', async () => {
    prisma.owner_verifications.findFirst.mockResolvedValue({ user_id: 99 });
    const res = resMock();
    await C.verifyPan(req({ pan: 'ABCPV1234D' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(cf.verifyPan).not.toHaveBeenCalled();
  });
  it('saves only a masked PAN when it matches', async () => {
    cf.verifyPan.mockResolvedValue({ valid: true, pan_status: 'VALID', name_match_result: 'DIRECT_MATCH', registered_name: 'POORVI H K', aadhaar_seeding_status: 'Y' });
    const res = resMock();
    await C.verifyPan(req({ pan: 'ABCPV1234D' }), res);
    expect(rec.pan_masked).toBe('ABXXXXXX4D');
    expect(JSON.stringify(rec)).not.toContain('ABCPV1234D');
  });
  it('stops after 5 attempts in a day', async () => {
    rec = { ...rec, attempts: { pan: [1, 2, 3, 4, 5].map(() => Date.now()) } };
    const res = resMock();
    await C.verifyPan(req({ pan: 'ABCPV1234D' }), res);
    expect(res.status).toHaveBeenCalledWith(429);
  });
});

describe('Selfie', () => {
  const file = { buffer: Buffer.from('img'), mimetype: 'image/jpeg' };
  it('rejects a non-live photo before face match', async () => {
    cf.faceLiveness.mockResolvedValue({ status: 'REAL_FACE_NOT_DETECTED', liveness: false });
    const res = resMock();
    await C.verifySelfie(req({}, { file }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(cf.faceMatch).not.toHaveBeenCalled();
  });
  it('rejects a selfie that does not match Aadhaar', async () => {
    cf.faceLiveness.mockResolvedValue({ status: 'SUCCESS', liveness: true, liveness_score: 0.9 });
    cf.getDigilockerAadhaar.mockResolvedValue({ status: 'SUCCESS', photo_link: Buffer.from('a').toString('base64') });
    cf.faceMatch.mockResolvedValue({ status: 'SUCCESS', face_match_result: 'NO', face_match_score: 0.2 });
    const res = resMock();
    await C.verifySelfie(req({}, { file }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(rec.selfie_verified_at).toBeUndefined();
  });
  it('passes a live, matching selfie', async () => {
    cf.faceLiveness.mockResolvedValue({ status: 'SUCCESS', liveness: true, liveness_score: 0.9 });
    cf.getDigilockerAadhaar.mockResolvedValue({ status: 'SUCCESS', photo_link: Buffer.from('a').toString('base64') });
    cf.faceMatch.mockResolvedValue({ status: 'SUCCESS', face_match_result: 'YES', face_match_score: 0.92 });
    const res = resMock();
    await C.verifySelfie(req({}, { file }), res);
    expect(rec.selfie_verified_at).toBeInstanceOf(Date);
  });
});

describe('Bank', () => {
  it('rejects an account in someone else\'s name', async () => {
    cf.verifyBankAccount.mockResolvedValue({ account_status: 'VALID', name_match_result: 'NO_MATCH', name_at_bank: 'OTHER PERSON' });
    const res = resMock();
    await C.verifyBank(req({ account_number: '026291800001191', ifsc: 'YESB0000262' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(prisma.users.update).not.toHaveBeenCalled();
  });
  it('a verified account becomes the payout account', async () => {
    cf.verifyBankAccount.mockResolvedValue({ account_status: 'VALID', name_match_result: 'DIRECT_MATCH', name_at_bank: 'POORVI H K', bank_name: 'YES BANK' });
    const res = resMock();
    await C.verifyBank(req({ account_number: '026291800001191', ifsc: 'YESB0000262' }), res);
    expect(prisma.users.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ bank_account_number: '026291800001191', bank_ifsc: 'YESB0000262', payout_mode: 'bank' }),
    }));
    expect(rec.bank_last4).toBe('1191');
  });
});

describe('Submit and admin review', () => {
  const allDone = () => ({ ...AADHAAR_DONE, pan_verified_at: new Date(), selfie_verified_at: new Date(), bank_verified_at: new Date(), property_uploaded_at: new Date() });
  it('cannot submit with steps missing', async () => {
    const res = resMock();
    await C.submit(req(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].missing).toEqual(['pan', 'selfie', 'bank', 'property']);
  });
  it('submit sets pending on both tables', async () => {
    rec = allDone();
    const res = resMock();
    await C.submit(req(), res);
    expect(rec.status).toBe('pending');
    expect(prisma.users.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { verification_status: 'pending' } });
  });
  it('no edits while under review', async () => {
    rec = { ...allDone(), status: 'pending' };
    const res = resMock();
    await C.verifyPan(req({ pan: 'ABCPV1234D' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
  it('admin approve only for a submitted, complete verification', async () => {
    rec = { ...allDone(), status: 'in_progress' };
    const res = resMock();
    await C.adminApprove(req({}, { user: { id: 1, role: 'ADMIN' }, params: { userId: '7' } }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
  it('admin approve sets approved', async () => {
    rec = { ...allDone(), status: 'pending' };
    const res = resMock();
    await C.adminApprove(req({}, { user: { id: 1, role: 'ADMIN' }, params: { userId: '7' } }), res);
    expect(rec.status).toBe('approved');
    expect(prisma.users.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { verification_status: 'approved' } });
  });
  it('admin reject needs a reason', async () => {
    rec = { ...allDone(), status: 'pending' };
    const res = resMock();
    await C.adminReject(req({ reason: '' }, { user: { id: 1, role: 'ADMIN' }, params: { userId: '7' } }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
