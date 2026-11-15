/**
 * Comparing two names, and what we do about the answer.
 *
 * WHY THIS EXISTS AT ALL. The brief said to reuse "the comparator the bank step
 * already uses". There isn't one. GOOD_NAME_MATCH and REVIEW_NAME_MATCH lived
 * in ownerVerificationController and only CLASSIFY a verdict that CASHFREE
 * returns from its PAN and bank APIs — Cashfree compares a name against a PAN
 * record or an account holder, and has no endpoint that compares two arbitrary
 * strings. So the classification and the vocabulary are reused, and moved here
 * so there is one copy; the string comparison itself is new, because it did not
 * exist.
 *
 * IT ADVISES, IT DOES NOT DECIDE. For PAN and bank the verdict gates
 * automatically, because the input came from a verified record. Here the input
 * is a name an admin typed off a photograph of a utility bill, so the verdict
 * is a cross-check shown to the human who is already reading the document. The
 * admin's decision is the decision. NO_MATCH is the one verdict that blocks a
 * desk pass, and even that yields to an explicit override with a note.
 *
 * Built for the names on Indian documents: honorifics (Shri, Smt), initials
 * that may or may not be expanded ("R Kumar" / "Rajesh Kumar"), relationship
 * tokens (S/O, W/O), and either order (a bill may print the surname first).
 * Order is therefore ignored, which is deliberate: on these documents it
 * carries no information.
 */

/** The vocabulary. Same strings Cashfree returns, so one policy covers both. */
const NAME_MATCH = {
  DIRECT: 'DIRECT_MATCH',
  GOOD_PARTIAL: 'GOOD_PARTIAL_MATCH',
  MODERATE_PARTIAL: 'MODERATE_PARTIAL_MATCH',
  NONE: 'NO_MATCH',
};

/** Good enough to proceed on. */
const GOOD_NAME_MATCH = [NAME_MATCH.DIRECT, NAME_MATCH.GOOD_PARTIAL];
/** Allowed, but flagged for a human. */
const REVIEW_NAME_MATCH = [NAME_MATCH.MODERATE_PARTIAL];

/** Dropped before comparing: they say nothing about who the person is. */
const HONORIFICS = new Set([
  'MR', 'MRS', 'MS', 'MISS', 'SHRI', 'SRI', 'SMT', 'SMT.', 'KUM', 'DR', 'PROF',
  'M/S', 'MESSRS', 'SAINT', 'ST',
]);

/**
 * "LATE RAMESH KUMAR" — the holder on this document is DEAD.
 *
 * This used to sit in HONORIFICS and be thrown away with the Shris and the
 * Smts, which made "LATE RAMESH KUMAR" against a verified "RAMESH KUMAR" come
 * back DIRECT_MATCH, explained as "The names are the same." They are not the
 * same: one of them is a deceased person.
 *
 * It matters here more than almost anywhere. An inherited khata still in a dead
 * parent's name is ordinary in Bengaluru, and sons very often carry the
 * father's name — so the one case where the document emphatically does NOT
 * establish that the applicant owns the place is also the case most likely to
 * score a perfect name match.
 *
 * It is still removed before the strings are compared, because the name itself
 * is worth comparing. What changed is that it is REPORTED: the verdict can
 * never be DIRECT, the explanation says so, and the desk review raises its own
 * blocker asking for the inheritance papers.
 */
const DECEASED_MARKERS = new Set(['LATE', 'LT']);

/**
 * Does this string name a holder recorded as deceased?
 *
 * Read off the raw value rather than the normalised tokens, because the marker
 * is exactly what normalising removes.
 */
function namesDeceasedHolder(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s/]/g, ' ')
    .split(/\s+/)
    .some((t) => DECEASED_MARKERS.has(t));
}

/**
 * Relationship markers on Indian documents: "S/O RAMESH" is son of Ramesh.
 *
 * The slash became a space during normalising, so "S/O" arrives as two tokens,
 * S then O. FIRST_HALVES are the letters that can start one; the second half is
 * always a lone O. That pair test is also what tells a marker from a middle
 * initial: in "RAJESH S KUMAR" the S is followed by KUMAR, not by O.
 */
const MARKER_FIRST_HALVES = new Set(['S', 'W', 'D', 'C']);
/** The same markers written without a slash. */
const MARKER_WORDS = new Set(['SO', 'WO', 'DO', 'CO', 'SON', 'WIFE', 'DAUGHTER']);

/**
 * Upper case, unaccented, punctuation-free tokens, with the noise removed.
 *
 * Slashes become spaces so "S/O" splits into tokens the relationship filter
 * can see; dots go so "R.K." becomes two initials rather than one word.
 */
function normalizeName(value) {
  const raw = String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s/]/g, ' ')
    .replace(/[/]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const tokens = [];
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i];
    if (HONORIFICS.has(t)) continue;
    // Removed from the comparison, but NOT forgotten — namesDeceasedHolder
    // reads it off the raw string and the verdict is capped because of it.
    if (DECEASED_MARKERS.has(t)) continue;

    // "RAJESH KUMAR S/O RAMESH KUMAR" — everything from the marker on names a
    // parent or spouse, not the holder, so the rest of the string goes.
    const isMarkerPair = MARKER_FIRST_HALVES.has(t) && raw[i + 1] === 'O';
    if (isMarkerPair || MARKER_WORDS.has(t)) break;

    tokens.push(t);
  }
  return tokens;
}

/** A single letter stands for a name we were not given in full. */
const isInitial = (token) => token.length === 1;

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

/**
 * One name, reduced to a shape that survives being spelled a different way.
 *
 * WHY THIS IS NOT EDIT DISTANCE. The pairs that must be treated as the same
 * name and the pair that must not are not separable by how many characters
 * differ — the ordering actively runs the wrong way:
 *
 *   LAKSHMANA / LAXMAN     4 edits apart, and the SAME name
 *   ANITA     / SUNITA     2 edits apart, and DIFFERENT people
 *
 * So a distance threshold that accepts Lakshmana would accept Anita/Sunita
 * several times over. The variation in Kannada, Tamil and Urdu names rendered
 * in English is not random noise; it is a small set of known substitutions.
 * Those are what this encodes, and nothing else.
 *
 * The rules, applied in this order to both sides:
 *
 *   1. X -> KSH        LAXMAN -> LAKSHMAN
 *   2. drop a trailing -APPA   KRISHNAPPA -> KRISHN   (Kannada suffix)
 *   3. SH -> S         RAMESH -> RAMES, KRISHNA -> KRISNA
 *   4. collapse doubled consonants   MOHAMMAD -> MOHAMAD
 *   5. drop a trailing vowel   RAMESHA -> RAMESH
 *
 * Order matters: -APPA is stripped before doubled consonants, or KRISHNAPPA
 * becomes KRISHNAPA and the suffix is no longer there to find.
 *
 * Step 5 is why RAMESHA/RAMESH and VENKATESHA/VENKATESH collapse together, and
 * it is safe because a trailing vowel is the single commonest optional
 * character in these transliterations. It is NOT safe in the other direction:
 * nothing here drops a LEADING character, which is exactly what would be
 * needed to make ANITA and SUNITA agree.
 */
function transliterationSkeleton(token) {
  let s = String(token || '').toUpperCase();

  // 1. Laxman and Lakshman are the same man.
  s = s.replace(/X/g, 'KSH');

  // 2. -appa / -anna are affectionate Kannada suffixes on a given name:
  //    Krishna becomes Krishnappa, Siddha becomes Siddappa. Only stripped
  //    when enough of a name is left to still be a name.
  const suffix = s.match(/^(.{3,})(APPA|ANNA)$/);
  if (suffix) [, s] = suffix;

  // 3. Krishna / Krisna, Shiva / Siva, Ramesh / Rames.
  s = s.replace(/SH/g, 'S');

  // 4. Mohammad / Mohamad, Siddique / Sidique.
  s = s.replace(/([BCDFGJKLMNPQRSTVWXZ])\1+/g, '$1');

  // 5. Ramesha / Ramesh, Venkatesha / Venkatesh, Lakshmana / Lakshman.
  //    Only a trailing vowel, and never the whole token.
  if (s.length > 2 && VOWELS.has(s[s.length - 1])) s = s.slice(0, -1);

  return s;
}

/**
 * Are these two tokens one name spelled two ways?
 *
 * The skeletons agreeing is the main test. The one extra allowance is a single
 * vowel swapped for another vowel at the same position — MOHAMMAD against
 * MOHAMMED, which is the commonest Urdu/Arabic rendering difference there is
 * and which no consonant rule can reach.
 *
 * That allowance is tightly bounded on purpose: same length, exactly one
 * differing position, and both characters must be vowels. It cannot insert,
 * delete or change a consonant, so it can never turn ANITA into SUNITA (a
 * leading insertion) or RAJESH into RAMESH (a consonant swap).
 */
function sameNameDifferentSpelling(a, b) {
  if (isInitial(a) || isInitial(b)) return false;

  const left = transliterationSkeleton(a);
  const right = transliterationSkeleton(b);
  if (!left || !right) return false;
  if (left === right) return true;

  if (left.length !== right.length) return false;

  let differing = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === right[i]) continue;
    // A consonant that disagrees is a different name, however close.
    if (!VOWELS.has(left[i]) || !VOWELS.has(right[i])) return false;
    differing += 1;
    if (differing > 1) return false;
  }
  return differing === 1;
}

/**
 * Compare two names.
 *
 * Order-independent token matching, with initials allowed to stand for a full
 * token beginning with the same letter. A name is only a DIRECT_MATCH when
 * both sides carry exactly the same set of full tokens — an initial is never
 * a direct match, because "R Kumar" could be any number of people.
 *
 * @returns {{verdict: string, matched: number, total: number,
 *   tokens_a: string[], tokens_b: string[], via_initial: boolean}}
 */
function compareNames(a, b) {
  const tokensA = normalizeName(a);
  const tokensB = normalizeName(b);

  const blank = {
    verdict: NAME_MATCH.NONE,
    matched: 0,
    total: Math.max(tokensA.length, tokensB.length),
    tokens_a: tokensA,
    tokens_b: tokensB,
    via_initial: false,
  };
  if (!tokensA.length || !tokensB.length) return blank;

  // Match the shorter name's tokens into the longer one, each at most once.
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const spare = [...longer];
  let matched = 0;
  let viaInitial = false;
  let viaVariant = false;
  /**
   * Full tokens that matched letter for letter.
   *
   * Counted because an initial standing for a name is not evidence of much.
   * "R K" against "RAJESH KRISHNA" matched everything it was given and used to
   * come out GOOD_PARTIAL_MATCH, which is in GOOD_NAME_MATCH — proceed, no
   * flag — on the strength of two single letters. Not one whole name agreed.
   */
  let exactFullMatches = 0;

  for (const token of shorter) {
    const exact = spare.indexOf(token);
    if (exact !== -1) {
      spare.splice(exact, 1);
      matched += 1;
      if (!isInitial(token)) exactFullMatches += 1;
      continue;
    }
    // An initial on either side may stand for a full token.
    const expands = spare.findIndex((other) =>
      (isInitial(token) && other.startsWith(token)) || (isInitial(other) && token.startsWith(other)));
    if (expands !== -1) {
      spare.splice(expands, 1);
      matched += 1;
      viaInitial = true;
      continue;
    }
    // One name, two spellings. Ramesha and Ramesh, Laxman and Lakshmana.
    const variant = spare.findIndex((other) => sameNameDifferentSpelling(token, other));
    if (variant !== -1) {
      spare.splice(variant, 1);
      matched += 1;
      viaVariant = true;
    }
  }

  const total = longer.length;
  const sameSet = matched === total && shorter.length === longer.length;

  /**
   * A token on the SHORTER side that nothing on the longer side could match.
   *
   * This is the difference between two things the old `matched / total >= 0.5`
   * test could not tell apart, and getting them confused was a way through the
   * desk review:
   *
   *   "Ramesh"       vs "Ramesh Kumar"  — CONTAINMENT. Everything the document
   *                                      gave us agrees; it just says less.
   *   "Ramesh Kumar" vs "Ramesh Gupta"  — CONFLICT. Each name carries a part
   *                                      the other contradicts. Different
   *                                      surnames are different people.
   *
   * Both used to come out MODERATE_PARTIAL_MATCH, which is in REVIEW_NAME_MATCH
   * and therefore does NOT block a desk pass. So a document in a different
   * person's name that happened to share one given name — and given names in
   * India are shared by millions — cleared the desk review with no override and
   * no note on the record. Suresh Babu/Suresh Nair, Anita Sharma/Anita Verma,
   * all of them straight through.
   *
   * A conflict is now NO_MATCH, which blocks. It still yields to an admin who
   * writes down why, which is the right outcome for a transliteration variant
   * (Ramesh/Ramesha, Laxman/Lakshmana): a human reading the document decides,
   * and the override is recorded against the spot.
   */
  const conflicting = shorter.length - matched;
  /** "LATE RAMESH KUMAR": the holder on one of these is recorded as dead. */
  const deceased = namesDeceasedHolder(a) || namesDeceasedHolder(b);

  let verdict;
  if (sameSet && !viaInitial && !viaVariant && !deceased) {
    verdict = NAME_MATCH.DIRECT;
  } else if (
    matched === shorter.length
    && shorter.length >= 2
    // At least one whole name has to agree letter for letter. Two initials
    // lining up is not a name match.
    && exactFullMatches >= 1
    // A spelling variant is a judgement for the human, never a clean pass.
    && !viaVariant
  ) {
    // Everything we were given matches; the other name just says more, or
    // spells out an initial.
    verdict = NAME_MATCH.GOOD_PARTIAL;
  } else if (conflicting > 0) {
    verdict = NAME_MATCH.NONE;
  } else if (matched / total >= 0.5) {
    // Everything agreed, but not cleanly: a different spelling, or only
    // initials, or one name simply saying less than the other. All of them are
    // ordinary on Indian documents and none of them is confirmation, so this
    // is flagged for the human who is already reading the document rather than
    // blocked. Blocking it would mean an override on most honest submissions,
    // and an override that is always required is not a signal.
    verdict = NAME_MATCH.MODERATE_PARTIAL;
  } else {
    verdict = NAME_MATCH.NONE;
  }

  return {
    verdict,
    matched,
    total,
    tokens_a: tokensA,
    tokens_b: tokensB,
    via_initial: viaInitial,
    /** At least one token matched only by being the same name spelled differently. */
    via_variant: viaVariant,
    /** Whole names that matched letter for letter. */
    exact_full_matches: exactFullMatches,
    /** Parts of the shorter name that the longer one contradicts. */
    conflicting,
    /** One side names a holder recorded as deceased. Never a DIRECT match. */
    deceased_holder: deceased,
  };
}

/** One line an admin can read next to the two names. */
function explainNameMatch(result) {
  // Said first and said plainly, whatever the rest of the comparison found.
  // A perfect name match on a dead holder is the most misleading result this
  // function can produce, so it never gets to speak first.
  if (result.deceased_holder) {
    return 'The document names a LATE holder — the person it names is recorded as deceased. '
      + 'However well the name matches, this does not show the applicant owns the property. '
      + 'Ask for the inheritance or khata-transfer papers.';
  }

  switch (result.verdict) {
    case NAME_MATCH.DIRECT:
      return 'The names are the same.';
    case NAME_MATCH.GOOD_PARTIAL:
      return result.via_initial
        ? 'Every part we were given matches, with an initial standing for a full name.'
        : 'Every part of the shorter name matches; the other name carries more parts.';
    case NAME_MATCH.MODERATE_PARTIAL:
      if (result.via_variant) {
        return 'These look like the same name spelled two ways (a trailing vowel, sh/s, ksh/x, '
          + 'a doubled consonant or an -appa ending). Ordinary on Indian documents — '
          + 'read the document and decide.';
      }
      if (result.via_initial && result.exact_full_matches === 0) {
        return 'Everything matched, but only through initials — not one whole name agreed. '
          + 'An initial fits a great many people.';
      }
      return `Only ${result.matched} of ${result.total} parts match, and nothing contradicts. `
        + 'A short name like this fits many people — read the document and decide.';
    default:
      return result.conflicting > 0
        ? `${result.conflicting} part(s) of the name on the document contradict the Aadhaar name. `
          + 'These look like different people.'
        : 'These do not look like the same name.';
  }
}

module.exports = {
  NAME_MATCH,
  GOOD_NAME_MATCH,
  REVIEW_NAME_MATCH,
  DECEASED_MARKERS,
  normalizeName,
  namesDeceasedHolder,
  transliterationSkeleton,
  sameNameDifferentSpelling,
  compareNames,
  explainNameMatch,
};
