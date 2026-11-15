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
    // "S Kumar" is not Rajesh Kumar. The S cannot stand for RAJESH, so it is a
    // part of the name that CONTRADICTS rather than one that merely says less,
    // and it blocks. Was MODERATE_PARTIAL until 15 Nov 2026, which did not
    // block — see the conflict note in compareNames.
    expect(verdict('S Kumar', 'Rajesh Kumar')).toBe(NAME_MATCH.NONE);
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
  test('a shared surname is not enough: the given names contradict', () => {
    // This used to be MODERATE_PARTIAL_MATCH, which is in REVIEW_NAME_MATCH
    // and does NOT block a desk pass. So a document naming Suresh Kumar
    // verified a spot for Rajesh Kumar with no override and no note — and
    // Kumar is one of the commonest surnames in India, so the hole was wide.
    //
    // It is NO_MATCH now. Not an outright refusal: an admin who has read the
    // document can still pass it with a written reason, which is recorded
    // against the spot. What changed is that someone has to say why.
    expect(verdict('Suresh Kumar', 'Rajesh Kumar')).toBe(NAME_MATCH.NONE);
  });

  test('a contradicted name reports how many parts disagree', () => {
    expect(compareNames('Suresh Kumar', 'Rajesh Kumar').conflicting).toBe(1);
    expect(compareNames('Amit Sharma', 'Rajesh Kumar').conflicting).toBe(2);
  });

  test('a name that only says less does not contradict, and is not blocked', () => {
    // The distinction the old code could not make. "Ramesh" agrees with
    // "Ramesh Kumar" as far as it goes; "Ramesh Gupta" does not.
    const short = compareNames('Ramesh', 'Ramesh Kumar');
    expect(short.conflicting).toBe(0);
    expect(short.verdict).toBe(NAME_MATCH.MODERATE_PARTIAL);

    const conflict = compareNames('Ramesh Gupta', 'Ramesh Kumar');
    expect(conflict.conflicting).toBe(1);
    expect(conflict.verdict).toBe(NAME_MATCH.NONE);
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
    // A contradicted name says so, and says how much of it disagrees.
    expect(explainNameMatch(compareNames('Suresh Kumar', 'Rajesh Kumar'))).toMatch(/contradict/i);
    expect(explainNameMatch(compareNames('Suresh Kumar', 'Rajesh Kumar'))).toMatch(/different people/i);
    // A name that merely says less reads differently, and shows the count.
    expect(explainNameMatch(compareNames('Ramesh', 'Ramesh Kumar'))).toMatch(/1 of 2 parts match/);
    expect(explainNameMatch(compareNames('Amit Sharma', 'Rajesh Kumar'))).toMatch(/contradict|do not look like/i);
  });
});
