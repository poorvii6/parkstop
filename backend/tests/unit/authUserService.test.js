/**
 * Unit tests for resolveUserFromFirebase — the auth account-resolution logic.
 *
 * Prisma and the logger are mocked, so these run with NO database. Run with:
 *   npx jest tests/unit/authUserService.test.js
 *
 * The security-critical behavior: an existing account may be linked to a Firebase
 * identity by email ONLY when Firebase has verified that email. An unverified
 * email must NEVER auto-link (that would be an account-takeover vector).
 */

jest.mock('../../src/config/prisma', () => ({
  users: { findUnique: jest.fn(), update: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const prisma = require('../../src/config/prisma');
const { resolveUserFromFirebase } = require('../../src/services/authUserService');

const existingUser = { id: 42, email: 'poo@example.com', role: 'finder', firebase_uid: 'uid-123' };

beforeEach(() => {
  jest.clearAllMocks();
});

test('returns the user matched directly by firebase_uid (no email lookup)', async () => {
  prisma.users.findUnique.mockResolvedValueOnce(existingUser);

  const result = await resolveUserFromFirebase({ uid: 'uid-123', email: 'poo@example.com' });

  expect(result).toBe(existingUser);
  // Only the uid lookup ran; no email fallback, no linking.
  expect(prisma.users.findUnique).toHaveBeenCalledTimes(1);
  expect(prisma.users.update).not.toHaveBeenCalled();
});

test('links an existing account by email when the email is VERIFIED', async () => {
  prisma.users.findUnique
    .mockResolvedValueOnce(null)          // no uid match
    .mockResolvedValueOnce(existingUser); // email match
  const linked = { ...existingUser, firebase_uid: 'new-uid' };
  prisma.users.update.mockResolvedValueOnce(linked);

  const result = await resolveUserFromFirebase({
    uid: 'new-uid', email: 'poo@example.com', email_verified: true,
  });

  expect(prisma.users.update).toHaveBeenCalledWith({
    where: { id: 42 },
    data: { firebase_uid: 'new-uid' },
  });
  expect(result).toBe(linked);
});

test('does NOT link when the email is UNVERIFIED (the security fix)', async () => {
  prisma.users.findUnique.mockResolvedValueOnce(null); // no uid match

  const result = await resolveUserFromFirebase({
    uid: 'attacker-uid', email: 'poo@example.com', email_verified: false,
  });

  expect(result).toBeNull();
  // Never even looked up by email, never linked.
  expect(prisma.users.findUnique).toHaveBeenCalledTimes(1);
  expect(prisma.users.update).not.toHaveBeenCalled();
});

test('does NOT link when email_verified is absent (treated as unverified)', async () => {
  prisma.users.findUnique.mockResolvedValueOnce(null);

  const result = await resolveUserFromFirebase({
    uid: 'attacker-uid', email: 'poo@example.com', // no email_verified field
  });

  expect(result).toBeNull();
  expect(prisma.users.update).not.toHaveBeenCalled();
});

test('returns null for a verified email with no matching account', async () => {
  prisma.users.findUnique
    .mockResolvedValueOnce(null)  // no uid match
    .mockResolvedValueOnce(null); // no email match

  const result = await resolveUserFromFirebase({
    uid: 'uid-x', email: 'nobody@example.com', email_verified: true,
  });

  expect(result).toBeNull();
  expect(prisma.users.update).not.toHaveBeenCalled();
});

test('returns null for a token with no email (e.g. phone auth) and no uid match', async () => {
  prisma.users.findUnique.mockResolvedValueOnce(null);

  const result = await resolveUserFromFirebase({ uid: 'phone-uid' });

  expect(result).toBeNull();
  expect(prisma.users.findUnique).toHaveBeenCalledTimes(1);
});

test('returns null for a missing/invalid token', async () => {
  expect(await resolveUserFromFirebase(null)).toBeNull();
  expect(await resolveUserFromFirebase({})).toBeNull();
  expect(prisma.users.findUnique).not.toHaveBeenCalled();
});
