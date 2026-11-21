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
 * The shortest stem that may lose a terminal -u.
 *
 * BASAVARAJU -> BASAVARAJ (9) qualifies; BABU -> BAB (3) does not, which is
 * what keeps BABU and BABA apart. See step 7 of transliterationKey.
 */
const MIN_STEM_FOR_TERMINAL_U = 5;

/**
 * A TRANSLITERATION KEY: one name reduced to the sounds it is made of, so that
 * two English spellings of the same Indian name produce the same string.
 *
 * WHY A KEY AND NOT A LIST OF PATTERNS. The first version of this matched
 * patterns case by case and was tuned to six examples. Ten common Karnataka
 * surnames that were not among those six then failed — Gowda/Gouda,
 * Reddy/Reddi, Shetty/Shetti, Naik/Nayak, Syed/Sayed,
 * Chandrashekar/Chandrashekhar, Siddarth/Siddharth — and Gowda, Reddy and
 * Shetty are three of the commonest surnames in the state. Normalising both
 * sides to a key and comparing keys handles the whole class instead of the
 * examples somebody happened to write down.
 *
 * WHY NOT EDIT DISTANCE. The ordering runs the wrong way, so no threshold can
 * separate the two sets:
 *
 *   LAKSHMANA / LAXMAN     4 edits apart, and the SAME name
 *   ANITA     / SUNITA     2 edits apart, and DIFFERENT people
 *
 * THE COLLAPSES, applied in this order to both sides. Order matters where
 * noted, because an earlier step can hide what a later one looks for.
 *
 *   1. W, V -> U        Gowda/Gouda, and v/w are one sound here
 *   2. Y -> I           Reddy/Reddi, Shetty/Shetti, Nayak/Naik
 *   3. KSH -> X         Lakshmana/Laxman. BEFORE step 4, which would eat the H
 *   4. consonant+H -> consonant   Chandrashekar/Chandrashekhar,
 *                       Siddarth/Siddharth, Ramesh/Rames, Krishna/Krisna
 *   5. strip -APPA/-ANNA   Krishnappa/Krishna. BEFORE step 6, which would turn
 *                       APPA into APA and leave nothing to find
 *   6. doubled consonant -> single   Reddy/Redy, Mohammad/Mohamad
 *   7. TERMINAL A deleted
 *   8. interior vowels deleted   Syed/Sayed, Naik/Nayak, Mohammad/Mohammed
 *
 * STEP 7 IS ONLY EVER AN 'A', AND THAT BOUNDARY IS THE WHOLE POINT. A terminal
 * -a is a real Kannada ending: Ramesha, Manjunatha, Lakshmana, Venkatesha are
 * the same names as Ramesh, Manjunath, Laxman, Venkatesh. A terminal -i, -u or
 * -e is NOT decoration, it is usually the FEMININE form or a different name
 * outright. Deleting those made Kumar/Kumari, Dev/Devi and Babu/Baba read as
 * spelling variants of each other, which is two different people being told
 * they are one.
 *
 * STEP 8 KEEPS THE FIRST AND LAST CHARACTERS. Nothing here may drop or insert
 * a LEADING character, which is exactly what Anita/Sunita would need, and
 * keeping the last character is what preserves the step-7 distinction.
 */
function transliterationKey(token) {
  let s = String(token || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';

  /**
   * 1. W and V, and they are NOT the same problem.
   *
   * The first version collapsed both to U, and that was wrong in a way the
   * collision table caught: it turned RAVI into R-A-U-I, whose interior is
   * then all vowels, so RAVI, RAI and ROY all reduced to the same key. Ravi
   * is a given name and Rai and Roy are surnames.
   *
   * W is a glide only when it CLOSES a syllable — after a vowel and not
   * followed by one. That is Gowda/Gouda (o-w-d), and there it becomes U.
   *
   * Between two vowels it is a consonant: Pavan/Pawan (a-w-a), where
   * collapsing to U would strip the sound out entirely and leave P_N. So
   * everywhere else W and V are ONE consonant (Pavan/Pawan, Vishwa/Vishva)
   * and keep their consonant weight through step 8.
   */
  s = s.replace(/([AEIOU])W(?![AEIOU])/g, '$1U');
  s = s.replace(/W/g, 'V');

  // 2. Y is a glide, written I as often as not: Reddy/Reddi, Nayak/Naik.
  //    Doing it here also means step 8 treats it as the vowel it is.
  s = s.replace(/Y/g, 'I');

  // 3. Farooq / Farukh / Faruk, Tariq / Tarik, Qadir / Kadir. Q spells the
  //    same sound as K in every Indian name rendered in English, and the
  //    consonant+H rule already reduces KH to K — so without this, FARUKH
  //    became FARUK while FAROOQ stayed FAROOQ.
  s = s.replace(/Q/g, 'K');

  // 4. Laxman and Lakshman are the same man. Before the H rule, which would
  //    turn KSH into KS and leave no cluster to recognise.
  s = s.replace(/KSH/g, 'X');

  // 4. An H after a consonant is decoration, and inconsistently written:
  //    Chandrashekar/Chandrashekhar, Siddarth/Siddharth, Bharat/Barat.
  s = s.replace(/([^AEIOU])H/g, '$1');

  // 5. -appa / -anna are Kannada suffixes on a given name: Krishna becomes
  //    Krishnappa. Before step 6, which would make APPA into APA.
  const suffix = s.match(/^(.{3,})(APPA|ANNA)$/);
  if (suffix) [, s] = suffix;

  // 6. Reddy / Redy, Mohammad / Mohamad, Siddique / Sidique.
  s = s.replace(/([^AEIOU])\1+/g, '$1');

  /**
   * 7. A terminal A always; a terminal U only off a LONG stem.
   *
   * -a is a real Kannada ending and is always dropped: Ramesha/Ramesh,
   * Manjunatha/Manjunath, Venkatesha/Venkatesh.
   *
   * -u is the awkward one, and the first version of this just left it out
   * without saying so. It IS a real ending — Basavaraju/Basavaraj,
   * Muniraju/Muniraj, Nagaraju/Nagaraj are everywhere in Karnataka — but
   * dropping it unconditionally merges BABU with BABA, and Babu and Baba are
   * different people.
   *
   * The stem length separates them. Strip -u only when at least five
   * characters remain, so BASAVARAJU (stem BASAVARAJ, nine) qualifies and
   * BABU (stem BAB, three) does not. Short stems are where the feminine and
   * diminutive forms live — Babu, Guru, Ramu, Manju — and a five-character
   * stem is long enough that an -u on the end is an ending rather than the
   * name itself.
   *
   * The cost, stated rather than hidden: RAMU/RAMA and MANJU/MANJA stay
   * separate, which is an override each. That is the feminine-forms side of
   * the trade, chosen deliberately — telling two people they are one is worse
   * than asking a human about two spellings.
   *
   * -i and -e are never dropped: Kumar/Kumari, Dev/Devi, Lath/Lathe.
   */
  if (s.length > 2 && s.endsWith('A')) s = s.slice(0, -1);
  else if (s.endsWith('U') && s.length - 1 >= MIN_STEM_FOR_TERMINAL_U) s = s.slice(0, -1);

  // 8. Interior vowels are optional in these spellings: Syed/Sayed,
  //    Naik/Nayak, Mohammad/Mohammed. First and last are kept — the first
  //    because a leading letter is never optional, the last because that is
  //    what keeps step 7's distinction alive.
  if (s.length <= 2) return s;
  const middle = [...s.slice(1, -1)].filter((c) => !VOWELS.has(c)).join('');
  return s[0] + middle + s[s.length - 1];
}

/** The shortest token this will treat as a spelling variant of another. */
const MIN_VARIANT_LENGTH = 3;

/**
 * THE CONFIDENCE FLOOR: how much is this agreement actually worth?
 *
 * A key is a lossy reduction, so two different names can reach the same one.
 * The first version of this floor measured only the key's LENGTH, on the
 * claim that "every wrong merge sits at a two-character key" — and that claim
 * was false, with the counterexample sitting in this repo's own test corpus:
 *
 *   SINGH / SANGHA   key SNG, three characters, and two different surnames
 *
 * Three characters made it read to a reviewer as an ordinary spelling match
 * with no caveat. Lowering the threshold to three is not the fix either: that
 * would label REDDY/REDDI and SIDDARTH/SIDDHARTH weak, and those are
 * genuinely one name.
 *
 * So the floor measures BOTH, and the second measure is the one that
 * separates them — HOW FAR APART THE ORIGINALS ARE:
 *
 *   GOWDA / GOUDA    1 edit   one character differs. A spelling.
 *   GOWDA / GUDDA    2 edits  two differ. A leap.
 *   SINGH / SANGHA   2 edits  a leap.
 *   REDDY / REDDI    1 edit   a spelling.
 *
 * An agreement is STRONG when either the originals are within one edit — a
 * single character, which is what a spelling difference looks like — or the
 * key is long enough that a lot of the name survived to agree. Otherwise it
 * is weak: the match required several assumptions AND discarded most of the
 * name to get there.
 *
 * Weak does not block. Gowda/Gouda, Naik/Nayak and Syed/Sayed must still
 * merge, so the floor LABELS: the explanation says the two agree only on a
 * short skeleton after several substitutions, and the verdict stays
 * MODERATE_PARTIAL_MATCH, which already means a human reads the document.
 * An over-merge lands on a flagged verdict, never on a clean pass — which is
 * why this is a tightening and not a blocker.
 *
 * WHAT IT STILL CANNOT SEE, and this is the honest limit: two different names
 * one character apart are indistinguishable from one name spelled two ways.
 * KARAN/KIRAN and ANIL/ANILA differ by a single character exactly as
 * GOWDA/GOUDA does, so they merge and they read as strong. No measure
 * available here separates them, and they are recorded in the collision table
 * rather than papered over.
 */
const STRONG_KEY_LENGTH = 4;

/**
 * Within this many edits, two spellings are close enough that the agreement
 * stands on its own however short the key is.
 */
const CLOSE_EDIT_DISTANCE = 1;

/**
 * Levenshtein distance, capped — we only ever ask "is this within one or two?"
 *
 * Deliberately NOT used to decide whether two names match: the ordering runs
 * the wrong way for that (LAKSHMANA/LAXMAN is four edits apart and the same
 * name, ANITA/SUNITA is two apart and different people). It is used only to
 * weigh an agreement the KEY has already made, which is a different question.
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Are these two tokens one name spelled two ways, and how much is that worth?
 *
 * Keys agreeing, and nothing else — no distance, no partial credit. Initials
 * and tokens under three characters are excluded outright.
 *
 * @returns {{same: boolean, key: string|null, strong: boolean, distance: number|null}}
 */
function nameSpellingMatch(a, b) {
  const left = String(a || '').toUpperCase().replace(/[^A-Z]/g, '');
  const right = String(b || '').toUpperCase().replace(/[^A-Z]/g, '');
  const none = { same: false, key: null, strong: false, distance: null };

  if (left.length < MIN_VARIANT_LENGTH || right.length < MIN_VARIANT_LENGTH) return none;
  if (isInitial(left) || isInitial(right)) return none;

  const keyA = transliterationKey(left);
  const keyB = transliterationKey(right);
  if (!keyA || !keyB || keyA.length < 2) return none;
  if (keyA !== keyB) return none;

  // How much had to be assumed to get here, and how much survived to agree.
  const distance = editDistance(left, right);
  const strong = distance <= CLOSE_EDIT_DISTANCE || keyA.length >= STRONG_KEY_LENGTH;

  return { same: true, key: keyA, strong, distance };
}

/** Are these two tokens one name spelled two ways? */
const sameNameDifferentSpelling = (a, b) => nameSpellingMatch(a, b).same;

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
  /** A variant that matched only on a short, low-information key. */
  let weakVariant = false;
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
      // A two-character key has thrown away most of the name, so the match is
      // recorded as weak and said to be weak. See the confidence floor above.
      if (!nameSpellingMatch(token, spare[variant]).strong) weakVariant = true;
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
    /**
     * That variant match rested on a two-character key, which is weak
     * evidence — most of the name was discarded to reach it. Still
     * MODERATE_PARTIAL_MATCH, so a human already has to read the document;
     * this tells them how much the machine's agreement is worth.
     */
    weak_variant: weakVariant,
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
        const base = 'These look like the same name spelled two ways (a trailing vowel, w/v, '
          + 'y/i, q/k, an h after a consonant, ksh/x, a doubled consonant or an -appa '
          + 'ending). Ordinary on Indian documents — read the document and decide.';
        return result.weak_variant
          ? `${base} WEAK: more than one character differs AND they agree only on a short `
            + 'skeleton, which many different names share. Treat this as little more than a '
            + 'coincidence and read the names themselves.'
          : base;
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
  transliterationKey,
  STRONG_KEY_LENGTH,
  CLOSE_EDIT_DISTANCE,
  MIN_STEM_FOR_TERMINAL_U,
  editDistance,
  nameSpellingMatch,
  sameNameDifferentSpelling,
  compareNames,
  explainNameMatch,
};
