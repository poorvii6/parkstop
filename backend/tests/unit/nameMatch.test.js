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
  namesDeceasedHolder,
  transliterationSkeleton,
  sameNameDifferentSpelling,
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

/**
 * One name, two spellings.
 *
 * In Bengaluru this is the normal case, not the edge case. When a conflicting
 * surname was first made to block, these all came out NO_MATCH, which would
 * have meant an admin overriding NO_MATCH on most honest submissions — the
 * keystroke-not-a-signal problem, recreated in the person check by the fix for
 * the tenant check.
 *
 * They land in MODERATE_PARTIAL_MATCH: flagged for the human reading the
 * document, never blocked, and never a clean pass either.
 */
describe('a name spelled two ways is the same name', () => {
  const variants = [
    ['RAMESHA', 'RAMESH', 'trailing vowel'],
    ['SURESHA', 'SURESH', 'trailing vowel'],
    ['VENKATESHA', 'VENKATESH', 'trailing vowel'],
    ['KRISHNAPPA', 'KRISHNA', '-appa suffix'],
    ['LAKSHMANA', 'LAXMAN', 'ksh/x and a trailing vowel'],
    ['MOHAMMAD', 'MOHAMMED', 'doubled consonant and a vowel swap'],
  ];

  test.each(variants)('%s and %s are one name (%s)', (a, b) => {
    expect(sameNameDifferentSpelling(a, b)).toBe(true);
  });

  test.each(variants)('%s / %s is flagged, not blocked (%s)', (a, b) => {
    const r = compareNames(`${a} Kumar`, `${b} Kumar`);

    expect(r.verdict).toBe(NAME_MATCH.MODERATE_PARTIAL);
    expect(r.via_variant).toBe(true);
    expect(REVIEW_NAME_MATCH).toContain(r.verdict);
    // Flagged, but never mistaken for confirmation.
    expect(GOOD_NAME_MATCH).not.toContain(r.verdict);
  });

  test('ANITA SHARMA and SUNITA SHARMA stay NO_MATCH', () => {
    // The test that kills a lazy fix. ANITA/SUNITA is TWO edits apart and must
    // fail, while LAKSHMANA/LAXMAN is FOUR edits apart and must pass — so the
    // ordering by distance runs backwards and no distance threshold can
    // separate them. The rules are patterns, not a budget.
    const r = compareNames('ANITA SHARMA', 'SUNITA SHARMA');

    expect(r.verdict).toBe(NAME_MATCH.NONE);
    expect(sameNameDifferentSpelling('ANITA', 'SUNITA')).toBe(false);
  });

  test('a leading letter is never optional, which is what ANITA/SUNITA turns on', () => {
    // Nothing in the rules drops or inserts a LEADING character. Every rule
    // works on the tail or on a known consonant cluster.
    expect(sameNameDifferentSpelling('ANITA', 'SUNITA')).toBe(false);
    expect(sameNameDifferentSpelling('ESH', 'RESH')).toBe(false);
    expect(sameNameDifferentSpelling('RAM', 'SRAM')).toBe(false);
  });

  test('a consonant that disagrees is a different name, however close', () => {
    expect(sameNameDifferentSpelling('RAJESH', 'RAMESH')).toBe(false);
    expect(sameNameDifferentSpelling('RAJESHA', 'RAMESH')).toBe(false);
    expect(sameNameDifferentSpelling('BABU', 'NAIR')).toBe(false);
    expect(sameNameDifferentSpelling('SHARMA', 'VERMA')).toBe(false);
  });

  test('only ONE vowel may be swapped, and only for another vowel', () => {
    // The Mohammad/Mohammed allowance, bounded so it cannot grow into a
    // general edit-distance match.
    expect(sameNameDifferentSpelling('MOHAMMAD', 'MOHAMMED')).toBe(true);
    // Two vowels apart is not one spelling difference.
    expect(sameNameDifferentSpelling('MOHAMMAD', 'MUHAMMED')).toBe(false);
    // A vowel for a consonant is a different name.
    expect(sameNameDifferentSpelling('RAMAN', 'RAMEN')).toBe(true);
    expect(sameNameDifferentSpelling('RAMAN', 'RAMDN')).toBe(false);
  });

  test('an initial is never a spelling variant', () => {
    expect(sameNameDifferentSpelling('R', 'RAMESH')).toBe(false);
    expect(sameNameDifferentSpelling('RAMESH', 'R')).toBe(false);
  });

  test('the skeleton is shown so a reviewer can see why', () => {
    expect(transliterationSkeleton('LAXMAN')).toBe(transliterationSkeleton('LAKSHMANA'));
    expect(transliterationSkeleton('KRISHNAPPA')).toBe(transliterationSkeleton('KRISHNA'));
    // A short token is never reduced to nothing.
    expect(transliterationSkeleton('A')).toBe('A');
    expect(transliterationSkeleton('RA')).toBe('RA');
  });
});

/**
 * "LATE RAMESH KUMAR" — an inherited khata in a dead parent's name.
 *
 * LATE used to sit in HONORIFICS and be discarded with the Shris, so this came
 * back DIRECT_MATCH, explained as "The names are the same". It is the single
 * most misleading result the comparator could produce: an inherited khata is
 * ordinary here and sons often carry the father's name, so the document that
 * LEAST establishes current ownership scored the perfect match.
 */
describe('a document naming a deceased holder', () => {
  test('is never a DIRECT match, however well the name agrees', () => {
    const r = compareNames('LATE RAMESH KUMAR', 'RAMESH KUMAR');

    expect(r.deceased_holder).toBe(true);
    expect(r.verdict).not.toBe(NAME_MATCH.DIRECT);
  });

  test('never says "the names are the same"', () => {
    const text = explainNameMatch(compareNames('LATE RAMESH KUMAR', 'RAMESH KUMAR'));

    expect(text).not.toMatch(/the names are the same/i);
    expect(text).toMatch(/deceased/i);
    expect(text).toMatch(/inheritance|khata-transfer/i);
  });

  test('is detected through honorifics and punctuation', () => {
    expect(namesDeceasedHolder('Late Shri Ramesh Kumar')).toBe(true);
    expect(namesDeceasedHolder('LATE. RAMESH KUMAR')).toBe(true);
    expect(namesDeceasedHolder('lt ramesh kumar')).toBe(true);
    expect(namesDeceasedHolder('Ramesh Kumar')).toBe(false);
  });

  test('a name merely containing those letters is not a deceased marker', () => {
    // LATA is a name. LATEEF is a name. Only a whole token counts.
    expect(namesDeceasedHolder('Lata Mangeshkar')).toBe(false);
    expect(namesDeceasedHolder('Abdul Lateef')).toBe(false);
    expect(namesDeceasedHolder('Latesh Kumar')).toBe(false);
  });

  test('the name itself is still compared, so a wrong name is still wrong', () => {
    const r = compareNames('LATE MOHAN LAL', 'RAMESH KUMAR');

    expect(r.deceased_holder).toBe(true);
    expect(r.verdict).toBe(NAME_MATCH.NONE);
  });
});

/**
 * Initials are not names.
 *
 * "R K" against "RAJESH KRISHNA" matched everything it was given and came out
 * GOOD_PARTIAL_MATCH — which is in GOOD_NAME_MATCH, so: proceed, no flag. Two
 * single letters, and not one whole name agreed.
 */
describe('a match made entirely of initials', () => {
  test('R K against RAJESH KRISHNA is MODERATE at best', () => {
    const r = compareNames('R K', 'RAJESH KRISHNA');

    expect(r.exact_full_matches).toBe(0);
    expect(r.verdict).toBe(NAME_MATCH.MODERATE_PARTIAL);
    expect(GOOD_NAME_MATCH).not.toContain(r.verdict);
  });

  test('one whole name agreeing is enough for GOOD_PARTIAL', () => {
    const r = compareNames('RAMESH K', 'RAMESH KRISHNAPPA');

    expect(r.exact_full_matches).toBe(1);
    expect(r.verdict).toBe(NAME_MATCH.GOOD_PARTIAL);
  });

  test('R.K. Sharma keeps GOOD_PARTIAL, because SHARMA matched in full', () => {
    const r = compareNames('R.K. Sharma', 'Rajesh Kumar Sharma');

    expect(r.exact_full_matches).toBe(1);
    expect(r.verdict).toBe(NAME_MATCH.GOOD_PARTIAL);
  });

  test('the explanation says it was only initials', () => {
    expect(explainNameMatch(compareNames('R K', 'RAJESH KRISHNA')))
      .toMatch(/only through initials/i);
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
