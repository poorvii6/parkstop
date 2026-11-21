/**
 * What an owner is told the moment they are approved as a PERSON.
 *
 * THE BUG: the message was a fixed string — "Your parking spots are now
 * visible to drivers on ParkStop." That was written before per-spot
 * verification. With the gate ON the finder needs the owner approved AND each
 * spot's own document check, so the owner read that sentence, opened the app,
 * and found every spot hidden.
 *
 * It is not simply wrong, though: with the gate OFF it is still exactly true,
 * and the gate ships off. So the message cannot just be reworded — it has to
 * depend on the gate, which is why it lives in the constants module beside
 * pinFreezeReason rather than in the controller.
 *
 * The flag is read at call time, so each test sets it and the module needs no
 * reloading between them.
 *
 *   npx jest tests/unit/ownerApprovedMessage.test.js
 */

const { ownerApprovedMessage, GATE_VARIABLE } = require('../../src/constants/spotVerification');

const withGate = (value, fn) => {
  const before = process.env[GATE_VARIABLE];
  if (value === undefined) delete process.env[GATE_VARIABLE];
  else process.env[GATE_VARIABLE] = value;
  try { return fn(); } finally {
    if (before === undefined) delete process.env[GATE_VARIABLE];
    else process.env[GATE_VARIABLE] = before;
  }
};

const gateOn = (arg) => withGate('on', () => ownerApprovedMessage(arg));
const gateOff = (arg) => withGate(undefined, () => ownerApprovedMessage(arg));

describe('ownerApprovedMessage — gate OFF', () => {
  it('keeps the old promise, because off means nothing changed', () => {
    const m = gateOff({ spotsNeedingVerification: 0, totalSpots: 3 });
    expect(m.body).toBe('Your parking spots are now visible to drivers on ParkStop.');
  });

  it('says it even if spots look unverified, because the status is not consulted', () => {
    // With the gate off a spot's own status hides nothing. Mentioning a
    // per-spot check would send the owner looking for a step that does not
    // apply to them.
    const m = gateOff({ spotsNeedingVerification: 5, totalSpots: 5 });
    expect(m.body).toBe('Your parking spots are now visible to drivers on ParkStop.');
    expect(m.body).not.toMatch(/document check|48 hours/i);
  });

  it('is also true for the other off values', () => {
    for (const v of ['off', 'OFF', '', 'true', '1', 'yes']) {
      const m = withGate(v, () => ownerApprovedMessage({ spotsNeedingVerification: 2, totalSpots: 2 }));
      expect(m.body).toBe('Your parking spots are now visible to drivers on ParkStop.');
    }
  });
});

describe('ownerApprovedMessage — gate ON', () => {
  it('does NOT promise the spots are visible when some are waiting', () => {
    // The whole point. This assertion is the regression.
    const m = gateOn({ spotsNeedingVerification: 2, totalSpots: 2 });
    expect(m.body).not.toMatch(/now visible to drivers/i);
  });

  it('says verified as a person, and that each spot needs its own check', () => {
    const m = gateOn({ spotsNeedingVerification: 2, totalSpots: 2 });
    expect(m.title).toMatch(/as a person/i);
    expect(m.body).toMatch(/separate document check/i);
    expect(m.body).toMatch(/48 hours/);
  });

  it('counts the spots that are actually waiting', () => {
    expect(gateOn({ spotsNeedingVerification: 2, totalSpots: 2 }).body).toMatch(/Your 2 spots still need/);
    expect(gateOn({ spotsNeedingVerification: 1, totalSpots: 1 }).body).toMatch(/Your spot still needs/);
  });

  it('distinguishes some-of-them from all-of-them', () => {
    // An owner with four driveways, two of them already approved, is not told
    // that all four are waiting.
    expect(gateOn({ spotsNeedingVerification: 2, totalSpots: 4 }).body).toMatch(/2 of your spots/);
    expect(gateOn({ spotsNeedingVerification: 4, totalSpots: 4 }).body).toMatch(/Your 4 spots/);
  });

  it('gets its singulars and plurals right', () => {
    const one = gateOn({ spotsNeedingVerification: 1, totalSpots: 1 }).body;
    expect(one).toMatch(/needs a separate document check before drivers can see it\./);
    const many = gateOn({ spotsNeedingVerification: 3, totalSpots: 3 }).body;
    expect(many).toMatch(/need a separate document check before drivers can see them\./);
  });

  it('tells an owner with nothing waiting that their spots ARE visible', () => {
    // Every spot already approved or grandfathered. Telling this owner to send
    // documents would be a dead end — there is nothing to send.
    const m = gateOn({ spotsNeedingVerification: 0, totalSpots: 3 });
    expect(m.body).toMatch(/verified as a person/i);
    expect(m.body).toMatch(/visible to drivers/i);
    expect(m.body).not.toMatch(/48 hours/);
  });

  it('tells an owner with no spots yet what to do next', () => {
    const m = gateOn({ spotsNeedingVerification: 0, totalSpots: 0 });
    expect(m.body).toMatch(/Add a spot/i);
    expect(m.body).toMatch(/48 hours/);
    expect(m.body).not.toMatch(/visible to drivers/i);
  });
});

describe('ownerApprovedMessage — shape', () => {
  it('always returns a title and a body that a push can carry', () => {
    const cases = [
      gateOff({}), gateOn({}),
      gateOn({ spotsNeedingVerification: 1, totalSpots: 1 }),
      gateOn({ spotsNeedingVerification: 9, totalSpots: 20 }),
      ownerApprovedMessage(),
    ];
    for (const m of cases) {
      expect(typeof m.title).toBe('string');
      expect(typeof m.body).toBe('string');
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.body.length).toBeGreaterThan(0);
      // Push bodies get truncated by the OS well before this, but a runaway
      // template would show up here.
      expect(m.body.length).toBeLessThan(240);
    }
  });

  it('survives being called with nothing', () => {
    expect(() => ownerApprovedMessage()).not.toThrow();
  });
});
