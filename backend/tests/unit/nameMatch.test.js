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
  transliterationKey,
  STRONG_KEY_LENGTH,
  CLOSE_EDIT_DISTANCE,
  editDistance,
  nameSpellingMatch,
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
 * ONE NAME, TWO SPELLINGS — and the specification for the rule, both ways.
 *
 * In Bengaluru a name written two ways is the NORMAL case, not the edge case.
 * When a conflicting surname was first made to block, every pair in the first
 * list below came out NO_MATCH, which would have meant an admin overriding
 * NO_MATCH on most honest submissions — the keystroke-not-a-signal problem,
 * recreated in the person check by the fix for the tenant check.
 *
 * BOTH LISTS ARE HERE ON PURPOSE. A rule like this is only meaningful as a
 * pair of boundaries, and the first version of it was tuned to six examples
 * and then failed on seven common Karnataka surnames that were not among them.
 * Whoever changes `transliterationKey` next needs to see what it is for in
 * both directions, in one place, without having to guess which cases mattered.
 */
const SAME_NAME = [
  // The seven that a pattern-by-pattern rule missed. Gowda, Reddy and Shetty
  // are three of the commonest surnames in Karnataka.
  ['PAVAN GOWDA', 'PAVAN GOUDA', 'w/u'],
  ['SRINIVAS REDDY', 'SRINIVAS REDDI', 'terminal y/i'],
  ['RAVI SHETTY', 'RAVI SHETTI', 'terminal y/i'],
  ['GANESH NAIK', 'GANESH NAYAK', 'i/ay'],
  ['ASIF SYED', 'ASIF SAYED', 'inserted interior vowel'],
  ['CHANDRASHEKAR N', 'CHANDRASHEKHAR N', 'dropped h'],
  ['SIDDARTH RAO', 'SIDDHARTH RAO', 'dropped h'],
  // Terminal -a is a real Kannada ending.
  ['RAMESHA KUMAR', 'RAMESH KUMAR', 'terminal a'],
  ['SURESHA KUMAR', 'SURESH KUMAR', 'terminal a'],
  ['VENKATESHA RAO', 'VENKATESH RAO', 'terminal a'],
  ['MANJUNATHA SHETTY', 'MANJUNATH SHETTY', 'terminal a'],
  ['LAKSHMANA RAO', 'LAXMAN RAO', 'ksh/x and terminal a'],
  ['KRISHNAPPA GOWDA', 'KRISHNA GOWDA', '-appa suffix'],
  ['MOHAMMAD ALI', 'MOHAMMED ALI', 'doubled consonant, interior vowel'],
];

const DIFFERENT_PEOPLE = [
  // A LEADING letter is never optional. This is the pair that kills a lazy
  // fix: two edits apart and different people, while LAKSHMANA/LAXMAN is four
  // edits apart and the same name — so no distance threshold can separate the
  // two lists.
  ['ANITA SHARMA', 'SUNITA SHARMA', 'leading letter'],
  ['RAMESH KUMAR', 'RAMESH GUPTA', 'different surname'],
  ['SURESH BABU', 'SURESH NAIR', 'different surname'],
  ['ANITA SHARMA', 'ANITA VERMA', 'different surname'],
  ['RAJESH KUMAR', 'RAMESH KUMAR', 'a consonant that disagrees'],
  ['RAM', 'RAJ', 'too short to be evidence'],
  // THE FEMININE FORMS. Deleting a terminal -i, -u or -e made these read as
  // spelling variants, which is two different people being told they are one.
  // Only a terminal -A is deleted.
  ['RAMESH KUMAR', 'RAMESH KUMARI', 'feminine form'],
  ['SUNIL KUMAR', 'SUNIL KUMARI', 'feminine form'],
  ['ARUN DEV', 'ARUN DEVI', 'feminine form'],
  ['SURESH BABU', 'SURESH BABA', 'terminal u is not terminal a'],
];

describe('a name spelled two ways is the same name', () => {
  test.each(SAME_NAME)('%s and %s are one name (%s)', (a, b) => {
    const r = compareNames(a, b);

    // Flagged for the human reading the document...
    expect(r.verdict).toBe(NAME_MATCH.MODERATE_PARTIAL);
    expect(r.via_variant).toBe(true);
    expect(REVIEW_NAME_MATCH).toContain(r.verdict);
    // ...never blocked, and never a clean pass either.
    expect(GOOD_NAME_MATCH).not.toContain(r.verdict);
  });

  test.each(DIFFERENT_PEOPLE)('%s and %s are different people (%s)', (a, b) => {
    const r = compareNames(a, b);

    expect(r.verdict).toBe(NAME_MATCH.NONE);
    expect(GOOD_NAME_MATCH).not.toContain(r.verdict);
    expect(REVIEW_NAME_MATCH).not.toContain(r.verdict);
  });

  test('a terminal A is deleted, and i/u/e are not', () => {
    // The one rule that needed care, stated on its own because it is the
    // boundary between the two lists above.
    expect(sameNameDifferentSpelling('RAMESHA', 'RAMESH')).toBe(true);
    expect(sameNameDifferentSpelling('MANJUNATHA', 'MANJUNATH')).toBe(true);
    expect(sameNameDifferentSpelling('LAKSHMANA', 'LAKSHMAN')).toBe(true);

    expect(sameNameDifferentSpelling('KUMARI', 'KUMAR')).toBe(false);
    expect(sameNameDifferentSpelling('DEVI', 'DEV')).toBe(false);
    expect(sameNameDifferentSpelling('BABU', 'BABA')).toBe(false);
    expect(sameNameDifferentSpelling('LATHE', 'LATH')).toBe(false);
  });

  test('a leading character is never optional', () => {
    expect(sameNameDifferentSpelling('ANITA', 'SUNITA')).toBe(false);
    expect(sameNameDifferentSpelling('ESH', 'RESH')).toBe(false);
    expect(sameNameDifferentSpelling('RAM', 'SRAM')).toBe(false);
    expect(sameNameDifferentSpelling('OMANA', 'KOMANA')).toBe(false);
  });

  test('a consonant that disagrees is a different name', () => {
    expect(sameNameDifferentSpelling('RAJESH', 'RAMESH')).toBe(false);
    expect(sameNameDifferentSpelling('RAJESHA', 'RAMESH')).toBe(false);
    expect(sameNameDifferentSpelling('SHARMA', 'VERMA')).toBe(false);
    expect(sameNameDifferentSpelling('GUPTA', 'GUPTE')).toBe(false);
  });

  test('a token too short to carry evidence is never a variant', () => {
    // A two-character key says almost nothing, so it is not allowed to say it.
    expect(sameNameDifferentSpelling('RA', 'RE')).toBe(false);
    expect(sameNameDifferentSpelling('AB', 'AB')).toBe(false);
    expect(sameNameDifferentSpelling('R', 'RAMESH')).toBe(false);
    expect(sameNameDifferentSpelling('RAMESH', 'R')).toBe(false);
  });

  /**
   * THE COLLISION TABLE — where the key over-merges, written down.
   *
   * A key is a lossy reduction, so distinct names WILL share one. The question
   * is not whether that happens but whether it happens anywhere dangerous,
   * and the only way to answer it is to run a corpus through and look.
   *
   * A PREVIOUS VERSION OF THIS COMMENT CLAIMED "every wrong merge sits at a
   * two-character key". That was false, and the counterexample was already in
   * this file's own corpus:
   *
   *   SINGH / SANGHA   key SNG, three characters, two different surnames
   *
   * So the floor measures two things now: how short the key is AND how far
   * apart the original spellings are. One character differing is what a
   * spelling difference looks like (Gowda/Gouda); two is a leap
   * (Gowda/Gudda, Singh/Sangha). See the confidence floor in nameMatch.js.
   *
   * THE CLAIM THAT IS ACTUALLY TRUE, and the only one worth relying on: no
   * over-merge is ever a CLEAN PASS. Every one lands on
   * MODERATE_PARTIAL_MATCH, which is outside GOOD_NAME_MATCH, so a human is
   * always reading the document with both names printed side by side. The
   * strong/weak label is advice on top of that, not the safety property.
   *
   * These are kept as tests so the next person changing the rules sees the
   * cost as well as the benefit, and finds out immediately if a change makes
   * the over-merging worse.
   */
  describe('the collision table: where the key over-merges', () => {
    /** Distinct spellings that share a key and SHOULD — real variants. */
    const RIGHTLY_MERGED = [
      ['BHAT', 'BHATT'], ['DEEPA', 'DIPA'], ['GEETHA', 'GITA'], ['POOJA', 'PUJA'],
      ['SEETHA', 'SITA'], ['SHIVA', 'SIVA'], ['GOWDA', 'GOUDA'], ['NAIK', 'NAYAK'],
      ['SYED', 'SAYED'], ['PAVAN', 'PAWAN'], ['AHMED', 'AHMAD'], ['LAKSHMI', 'LAXMI'],
      ['RAHMAN', 'REHMAN'], ['HEGDE', 'HEGADE'], ['SHASTRI', 'SASTRI'],
      ['PARVATHI', 'PARVATI'], ['FATIMA', 'FATHIMA'], ['SHEKAR', 'SHEKHAR'],
      ['DSOUZA', 'DESOUZA'], ['SWAMY', 'SWAMI'], ['GOWRI', 'GAURI'],
      ['PRAVEEN', 'PRAVIN'], ['DEEPAK', 'DIPAK'], ['SATISH', 'SATHISH'],
      // Terminal -u off a long stem, and q/k.
      ['BASAVARAJ', 'BASAVARAJU'], ['MUNIRAJ', 'MUNIRAJU'], ['NAGARAJ', 'NAGARAJU'],
      ['FAROOQ', 'FARUKH'], ['FAROOQ', 'FARUK'], ['TARIQ', 'TARIK'],
      ['RAFIQ', 'RAFIK'], ['QADIR', 'KADIR'],
    ];

    /**
     * Distinct names that share a key and SHOULD NOT, where the floor at
     * least LABELS the agreement as weak — a short key reached after more
     * than one substitution.
     *
     * Recorded, not accepted. If a rule change separates one of these, move
     * it out: that is an improvement.
     */
    const WRONGLY_MERGED_BUT_FLAGGED_WEAK = [
      ['KHAN', 'KHANNA', 'different surnames entirely'],
      ['SYED', 'SUDHA', 'a surname and a given name'],
      ['JAYA', 'JAI', 'related but not the same name'],
      ['RAI', 'ROY', 'arguably one surname, arguably two'],
      ['DEV', 'DEVAPPA', 'the -appa form of a different root'],
      ['SINGH', 'SANGHA', 'two Punjabi surnames — the counterexample that broke the old floor'],
      ['GOWDA', 'GUDDA', 'two characters apart, not one'],
      ['KARAN', 'KARUNA', 'masculine given name against a feminine one'],
    ];

    /**
     * THE HONEST LIMIT. Distinct names that share a key AND read as strong,
     * because they differ by a single character exactly as Gowda/Gouda does.
     *
     * No measure available here separates them: the interior-vowel rule is
     * what makes Syed/Sayed and Naik/Nayak work, and it is the same rule that
     * flattens Karan/Kiran and Patil/Patel. Choosing to keep interior vowels
     * would lose more than it saved.
     *
     * They are not dangerous and they are not hidden — the verdict is still
     * MODERATE_PARTIAL_MATCH, outside GOOD_NAME_MATCH, so an admin reads the
     * document with both names in front of them. They are written down here
     * so nobody later believes the floor catches everything.
     */
    const WRONGLY_MERGED_AND_READS_STRONG = [
      ['KARAN', 'KIRAN', 'two given names, one interior vowel apart'],
      ['ANIL', 'ANILA', 'masculine and feminine, one terminal -a apart'],
      ['PATIL', 'PATEL', 'Karnataka and Gujarat surnames, one interior vowel apart'],
      ['ABDUL', 'ABDULLA', 'rescued by a four-character key; arguably two names'],
    ];

    test.each(RIGHTLY_MERGED)('%s and %s share a key, correctly', (a, b) => {
      expect(transliterationKey(a)).toBe(transliterationKey(b));
      expect(sameNameDifferentSpelling(a, b)).toBe(true);
    });

    test.each(WRONGLY_MERGED_BUT_FLAGGED_WEAK)('%s and %s merge wrongly but weakly (%s)', (a, b) => {
      const m = nameSpellingMatch(a, b);
      expect(m.same).toBe(true);
      expect(m.strong).toBe(false);
    });

    test.each(WRONGLY_MERGED_AND_READS_STRONG)('%s and %s merge wrongly and read strong (%s)', (a, b) => {
      const m = nameSpellingMatch(a, b);
      expect(m.same).toBe(true);
      // Recorded as the limit. If a change makes one of these weak or
      // separate, that is an improvement — move it.
      expect(m.strong).toBe(true);
      expect(m.distance).toBeLessThanOrEqual(2);
    });

    test('NO over-merge is ever a clean pass — the claim that actually holds', () => {
      // The safety property. Weak labelling is advice on top of this.
      for (const [a, b] of [...WRONGLY_MERGED_BUT_FLAGGED_WEAK, ...WRONGLY_MERGED_AND_READS_STRONG]) {
        const r = compareNames(`${a} Kumar`, `${b} Kumar`);

        expect(r.verdict).toBe(NAME_MATCH.MODERATE_PARTIAL);
        expect(GOOD_NAME_MATCH).not.toContain(r.verdict);
        expect(REVIEW_NAME_MATCH).toContain(r.verdict);
        // And the admin is always shown both names, whatever the label says.
        expect(r.tokens_a).toContain(a);
        expect(r.tokens_b).toContain(b);
      }
    });

    test('a weak label says why, and a strong one does not cry wolf', () => {
      const weak = compareNames('SINGH Kumar', 'SANGHA Kumar');
      expect(weak.weak_variant).toBe(true);
      expect(explainNameMatch(weak)).toMatch(/WEAK/);
      expect(explainNameMatch(weak)).toMatch(/more than one character differs/i);

      for (const [a, b] of [['RAMESHA', 'RAMESH'], ['REDDY', 'REDDI'], ['SIDDARTH', 'SIDDHARTH']]) {
        const r = compareNames(`${a} Kumar`, `${b} Kumar`);
        expect(r.via_variant).toBe(true);
        expect(r.weak_variant).toBe(false);
        expect(explainNameMatch(r)).not.toMatch(/WEAK/);
      }
    });

    test('the floor is both measures, and neither alone', () => {
      expect(STRONG_KEY_LENGTH).toBe(4);
      expect(CLOSE_EDIT_DISTANCE).toBe(1);

      // One character apart is strong however short the key — this is what
      // keeps Gowda/Gouda, Syed/Sayed and Reddy/Reddi uncaveated.
      for (const [a, b] of [['GOWDA', 'GOUDA'], ['SYED', 'SAYED'], ['REDDY', 'REDDI']]) {
        const m = nameSpellingMatch(a, b);
        expect(m.distance).toBe(1);
        expect(m.strong).toBe(true);
      }

      // A long key is strong however far apart — this is what keeps
      // Lakshmana/Laxman and Krishna/Krishnappa uncaveated.
      for (const [a, b] of [['LAKSHMANA', 'LAXMAN'], ['KRISHNA', 'KRISHNAPPA']]) {
        const m = nameSpellingMatch(a, b);
        expect(m.distance).toBeGreaterThan(CLOSE_EDIT_DISTANCE);
        expect(m.key.length).toBeGreaterThanOrEqual(STRONG_KEY_LENGTH);
        expect(m.strong).toBe(true);
      }

      // Neither — short key AND several substitutions — is weak.
      for (const [a, b] of [['SINGH', 'SANGHA'], ['GOWDA', 'GUDDA'], ['KHAN', 'KHANNA']]) {
        const m = nameSpellingMatch(a, b);
        expect(m.distance).toBeGreaterThan(CLOSE_EDIT_DISTANCE);
        expect(m.key.length).toBeLessThan(STRONG_KEY_LENGTH);
        expect(m.strong).toBe(false);
      }
    });

    test('w is a glide only when it closes a syllable', () => {
      // An earlier collision table caught this: collapsing every W and V to U
      // turned RAVI into R-A-U-I, whose interior is all vowels, so RAVI, RAI
      // and ROY all reduced to one key. Ravi is a given name; Rai and Roy are
      // surnames.
      expect(sameNameDifferentSpelling('RAVI', 'RAI')).toBe(false);
      expect(sameNameDifferentSpelling('RAVI', 'ROY')).toBe(false);
      // Gowda keeps its glide: o-w-d, w followed by a consonant.
      expect(sameNameDifferentSpelling('GOWDA', 'GOUDA')).toBe(true);
      // Pawan keeps its consonant: a-w-a, w between two vowels.
      expect(sameNameDifferentSpelling('PAVAN', 'PAWAN')).toBe(true);
      expect(sameNameDifferentSpelling('VISHWA', 'VISHVA')).toBe(true);
    });

    test('edit distance weighs an agreement, it never makes one', () => {
      // Stated because using it to MATCH would be the mistake the whole key
      // exists to avoid: Lakshmana/Laxman is four edits apart and the same
      // name, Anita/Sunita is two apart and different people.
      expect(editDistance('LAKSHMANA', 'LAXMAN')).toBeGreaterThan(editDistance('ANITA', 'SUNITA'));
      expect(sameNameDifferentSpelling('LAKSHMANA', 'LAXMAN')).toBe(true);
      expect(sameNameDifferentSpelling('ANITA', 'SUNITA')).toBe(false);

      expect(editDistance('', '')).toBe(0);
      expect(editDistance('ABC', 'ABC')).toBe(0);
      expect(editDistance('ABC', '')).toBe(3);
      expect(editDistance('KITTEN', 'SITTING')).toBe(3);
    });
  });

  test('the key is what two spellings agree on, and it is inspectable', () => {
    // Shown because a reviewer looking at a flagged name should be able to see
    // WHY the two were considered the same.
    expect(transliterationKey('GOWDA')).toBe(transliterationKey('GOUDA'));
    expect(transliterationKey('REDDY')).toBe(transliterationKey('REDDI'));
    expect(transliterationKey('NAYAK')).toBe(transliterationKey('NAIK'));
    expect(transliterationKey('CHANDRASHEKHAR')).toBe(transliterationKey('CHANDRASHEKAR'));
    expect(transliterationKey('LAXMAN')).toBe(transliterationKey('LAKSHMANA'));
    expect(transliterationKey('KRISHNAPPA')).toBe(transliterationKey('KRISHNA'));

    expect(transliterationKey('KUMAR')).not.toBe(transliterationKey('KUMARI'));
    expect(transliterationKey('ANITA')).not.toBe(transliterationKey('SUNITA'));

    // A short token is never reduced to nothing.
    expect(transliterationKey('A')).toBe('A');
    expect(transliterationKey('RA')).toBe('RA');
    expect(transliterationKey('')).toBe('');
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
