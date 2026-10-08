/**
 * Test keys must go to Cashfree's test server and live keys to the live
 * server — sending a test secret to production fails with
 * "client secret belongs to test environment".
 */
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const cf = require('../../src/services/cashfreeVerification');

const SAVED = { ...process.env };
afterEach(() => { process.env = { ...SAVED }; });
const set = (id, secret, env) => {
  process.env.CASHFREE_VRS_CLIENT_ID = id;
  process.env.CASHFREE_VRS_CLIENT_SECRET = secret;
  if (env) process.env.CASHFREE_VRS_ENV = env; else delete process.env.CASHFREE_VRS_ENV;
};

describe('Cashfree verification environment', () => {
  it('a _test_ secret goes to sandbox even if the id has no TEST prefix', () => {
    set('116182603a439383661', 'cfsk_ma_test_abc123');
    expect(cf.config().env).toBe('sandbox');
    expect(cf.config().base).toBe('https://sandbox.cashfree.com/verification');
  });
  it('a TEST id goes to sandbox', () => {
    set('TEST116182603a', 'whatever');
    expect(cf.config().env).toBe('sandbox');
  });
  it('a _prod_ secret goes to production', () => {
    set('116182603a', 'cfsk_ma_prod_abc123');
    expect(cf.config().base).toBe('https://api.cashfree.com/verification');
  });
  it('unclear keys refuse to guess', () => {
    set('116182603a', 'plainsecret');
    expect(() => cf.config()).toThrow(/CASHFREE_VRS_ENV/);
  });
  it('CASHFREE_VRS_ENV wins when set', () => {
    set('116182603a', 'plainsecret', 'sandbox');
    expect(cf.config().env).toBe('sandbox');
  });
  it('missing keys give a clear error', () => {
    delete process.env.CASHFREE_VRS_CLIENT_ID;
    expect(() => cf.config()).toThrow(/not configured/);
  });
});
