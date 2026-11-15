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
  'M/S', 'MESSRS', 'LATE', 'SAINT', 'ST',
]);

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

  for (const token of shorter) {
    const exact = spare.indexOf(token);
    if (exact !== -1) {
      spare.splice(exact, 1);
      matched += 1;
      continue;
    }
    // An initial on either side may stand for a full token.
    const expands = spare.findIndex((other) =>
      (isInitial(token) && other.startsWith(token)) || (isInitial(other) && token.startsWith(other)));
    if (expands !== -1) {
      spare.splice(expands, 1);
      matched += 1;
      viaInitial = true;
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

  let verdict;
  if (sameSet && !viaInitial) {
    verdict = NAME_MATCH.DIRECT;
  } else if (matched === shorter.length && shorter.length >= 2) {
    // Everything we were given matches; the other name just says more, or
    // spells out an initial.
    verdict = NAME_MATCH.GOOD_PARTIAL;
  } else if (conflicting > 0) {
    verdict = NAME_MATCH.NONE;
  } else if (matched / total >= 0.5) {
    // Containment only: one name is a subset of the other. Weak — a lone
    // "Ramesh" names a great many people — so it is flagged for the human who
    // is already reading the document, and not blocked.
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
    /** Parts of the shorter name that the longer one contradicts. */
    conflicting,
  };
}

/** One line an admin can read next to the two names. */
function explainNameMatch(result) {
  switch (result.verdict) {
    case NAME_MATCH.DIRECT:
      return 'The names are the same.';
    case NAME_MATCH.GOOD_PARTIAL:
      return result.via_initial
        ? 'Every part we were given matches, with an initial standing for a full name.'
        : 'Every part of the shorter name matches; the other name carries more parts.';
    case NAME_MATCH.MODERATE_PARTIAL:
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
  normalizeName,
  compareNames,
  explainNameMatch,
};
