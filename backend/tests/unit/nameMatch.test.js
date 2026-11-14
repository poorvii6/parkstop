/**
 * Comparing a name typed off a document against the verified Aadhaar name.
 *
 * There was nothing to reuse: GOOD_NAME_MATCH / REVIEW_NAME_MATCH only
 * classify a verdict Cashfree returns for PAN and bank checks, and Cashfree
 * has no endpoint that compares two arbitrary strings. So this comparator is
 * new, and it emits the same four verdicts so one policy covers both.
 *
 * Built for Indian documents: honorifics, unexpanded initials, relationship
 * markers, and either name order. Pure, so it is pinned exhaustively here.
 *
 *   npx jest tests/unit/nameMatch.test.js
 */
const {
  NAME_MATCH,
  GOOD_NAME_MATCH,
  REVIEW_NAME_MATCH,
  normalizeName,
  compareNames,
  explainNameMatch,
} = require('../../src/services/nameMatch');

const verdict = (a, b) => compareNames(a, b).verdict;

describe('normalising a name', () => {
  test('case, spacing and punctuation do not matter', () => {
    expect(normalizeName('  rajesh   KUMAR.  ')).toEqual(['RAJESH', 'KUMAR']);
  });

  test('honorifics are dropped', () => {
    expect(normalizeName('Shri Rajesh Kumar')).toEqual(['RAJESH', 'KUMAR']);
    expect(normalizeName('Smt. Sunita Devi')).toEqual(['SUNITA', 'DEVI']);
    expect(normalizeName('Dr Rajesh Kumar')).toEqual(['RAJESH', 'KUMAR']);
  });

  test('accents are folded, so a transliteration still matches', () => {
    expect(normalizeName('Rajésh Kumār')).toEqual(['RAJESH', 'KUMAR']);
  });

  test('dots in initials split them into separate tokens', () => {
    expect(normalizeName('R.K. Sharma')).toEqual(['R', 'K', 'SHARMA']);
  });

  test('a relationship marker ends the name', () => {
    // Everything after S/O is a father's name, not the holder's.
    expect(normalizeName('Rajesh Kumar S/O Ramesh Kumar')).toEqual(['RAJESH', 'KUMAR']);
    expect(normalizeName('Sunita W/O Rajesh Kumar')).toEqual(['SUNITA']);
  });

  test('a middle initial is NOT read as a relationship marker', () => {
    // "RAJESH S KUMAR": the S is an initial. Only a marker followed by another
    // marker letter ("S O") ends the name.
    expect(normalizeName('Rajesh S Kumar')).toEqual(['RAJESH', 'S', 'KUMAR']);
  });

  test('digits and symbols from a bad scan are discarded', () => {
    expect(normalizeName('RAJESH KUMAR 12345 ***')).toEqual(['RAJESH', 'KUMAR']);
  });
});

describe('the same person', () => {
  test('identical names are a direct match', () => {
    expect(verdict('Rajesh Kumar', 'Rajesh Kumar')).toBe(NAME_MATCH.DIRECT);
  });

  test('so are the same names typed differently', () => {
    expect(verdict('  rajesh kumar ', 'RAJESH KUMAR')).toBe(NAME_MATCH.DIRECT);
    expect(verdict('Shri Rajesh Kumar', 'Rajesh Kumar')).toBe(NAME_MATCH.DIRECT);
  });

  test('order is ignored, because these documents print it either way', () => {
    expect(verdict('Kumar Rajesh', 'Rajesh Kumar')).toBe(NAME_MATCH.DIRECT);
  });

  test('a marker and what follows it are ignored', () => {
    expect(verdict('Rajesh Kumar S/O Ramesh Kumar', 'Rajesh Kumar')).toBe(NAME_MATCH.DIRECT);
  });
});

describe('an initial standing for a name is good, but never direct', () => {
  test('"R Kumar" against "Rajesh Kumar"', () => {
    const r = compareNames('R Kumar', 'Rajesh Kumar');

    expect(r.verdict).toBe(NAME_MATCH.GOOD_PARTIAL);
    expect(r.via_initial).toBe(true);
  });

  test('"R.K. Sharma" against "Rajesh Kumar Sharma"', () => {
    expect(verdict('R.K. Sharma', 'Rajesh Kumar Sharma')).toBe(NAME_MATCH.GOOD_PARTIAL);
  });

  test('the initial has to be the right letter', () => {
    // "S Kumar" is not Rajesh Kumar; one token matches out of two.
    expect(verdict('S Kumar', 'Rajesh Kumar')).toBe(NAME_MATCH.MODERATE_PARTIAL);
  });

  test('never DIRECT, because an initial could be any number of people', () => {
    expect(verdict('R Kumar', 'Rajesh Kumar')).not.toBe(NAME_MATCH.DIRECT);
  });
});

describe('a name that says more, or less', () => {
  test('a missing middle name is good', () => {
    expect(verdict('Rajesh Kumar', 'Rajesh Kumar Sharma')).toBe(NAME_MATCH.GOOD_PARTIAL);
    expect(verdict('Rajesh Kumar Sharma', 'Rajesh Kumar')).toBe(NAME_MATCH.GOOD_PARTIAL);
  });

  test('a single first name against a full name is not evidence', () => {
    // One token of three. An admin can still pass it with a written reason.
    expect(verdict('Rajesh', 'Rajesh Kumar Sharma')).toBe(NAME_MATCH.NONE);
  });
});

describe('a different person', () => {
  test('a shared surname alone is only moderate, and a human decides', () => {
    // Kumar is one of the commonest surnames in India, so this must not read
    // as confirmation -- and must not be refused outright either.
    expect(verdict('Suresh Kumar', 'Rajesh Kumar')).toBe(NAME_MATCH.MODERATE_PARTIAL);
  });

  test('nothing in common is no match', () => {
    expect(verdict('Amit Sharma', 'Rajesh Kumar')).toBe(NAME_MATCH.NONE);
  });

  test('a blank name on either side is no match', () => {
    expect(verdict('', 'Rajesh Kumar')).toBe(NAME_MATCH.NONE);
    expect(verdict('Rajesh Kumar', null)).toBe(NAME_MATCH.NONE);
    expect(verdict('   ', 'Rajesh Kumar')).toBe(NAME_MATCH.NONE);
  });

  test('an owner with no verified Aadhaar name cannot be matched against', () => {
    // This is what blocks a desk pass when the person was never verified.
    expect(verdict('Rajesh Kumar', undefined)).toBe(NAME_MATCH.NONE);
  });
});

describe('the policy lists the verdicts are in', () => {
  test('good enough to proceed, and flagged for a human, are separate', () => {
    expect(GOOD_NAME_MATCH).toEqual([NAME_MATCH.DIRECT, NAME_MATCH.GOOD_PARTIAL]);
    expect(REVIEW_NAME_MATCH).toEqual([NAME_MATCH.MODERATE_PARTIAL]);
    expect(GOOD_NAME_MATCH).not.toContain(NAME_MATCH.NONE);
    expect(REVIEW_NAME_MATCH).not.toContain(NAME_MATCH.NONE);
  });

  test('they are the same strings Cashfree returns, so one policy covers both', () => {
    // ownerVerificationController imports these for the PAN and bank steps.
    expect(NAME_MATCH.DIRECT).toBe('DIRECT_MATCH');
    expect(NAME_MATCH.GOOD_PARTIAL).toBe('GOOD_PARTIAL_MATCH');
    expect(NAME_MATCH.MODERATE_PARTIAL).toBe('MODERATE_PARTIAL_MATCH');
    expect(NAME_MATCH.NONE).toBe('NO_MATCH');
  });
});

describe('what the admin reads next to the two names', () => {
  test('each verdict gets a sentence, and the moderate one shows the count', () => {
    expect(explainNameMatch(compareNames('Rajesh Kumar', 'Rajesh Kumar'))).toMatch(/the same/i);
    expect(explainNameMatch(compareNames('R Kumar', 'Rajesh Kumar'))).toMatch(/initial/i);
    expect(explainNameMatch(compareNames('Suresh Kumar', 'Rajesh Kumar'))).toMatch(/1 of 2 parts match/);
    expect(explainNameMatch(compareNames('Amit Sharma', 'Rajesh Kumar'))).toMatch(/do not look like/i);
  });
});
