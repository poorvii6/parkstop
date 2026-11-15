/**
 * The 48-hour promise, as pure functions.
 *
 * We tell an owner their spot will be live within 48 hours of submitting it.
 * A promise nobody measures is one we break quietly, so the wait is computed
 * here — no database, no clock of its own, every input passed in — and the
 * admin queue and the owner's own screen both read it. One definition, so the
 * number the owner is shown and the number the queue sorts by cannot disagree.
 *
 * Same shape as BookingRefundPolicy and for the same reason: rules that can be
 * tested exhaustively, and a service above that only moves data around.
 */
const {
  SPOT_VERIFICATION_STATUS,
  AWAITING_REVIEW_STATUSES,
  isVisibleToDrivers,
  isPinFrozen,
} = require('../constants/spotVerification');
const { FINE_PRECISIONS } = require('./geocoding');
const { GOOD_NAME_MATCH, REVIEW_NAME_MATCH } = require('./nameMatch');

/** What we promise the owner. */
const SLA_HOURS = 48;

/**
 * When a submission becomes "at risk".
 *
 * 36 hours leaves 12 to act, which is a working day in the regional offices
 * the field check depends on. The boundary is inclusive: a submission sitting
 * at exactly 36.0 hours is flagged, because rounding a promise down is how it
 * gets broken.
 */
const AT_RISK_HOURS = 36;

const HOUR_MS = 60 * 60 * 1000;

/** ok -> at_risk -> overdue, plus "the clock is not running". */
const SLA = {
  NOT_WAITING: 'not_waiting',
  OK: 'ok',
  AT_RISK: 'at_risk',
  OVERDUE: 'overdue',
};

/**
 * How long this submission has been waiting on us, and whether that is still
 * inside the promise.
 *
 * The clock runs from submitted_at until the spot is decided — through BOTH
 * stages, not just the desk, because the owner was promised a live spot and a
 * desk pass does not make it live. It does not run for:
 *
 *   - a spot that has not been submitted (nothing promised yet),
 *   - a decided spot: approved, rejected, or sent back,
 *   - a GRANDFATHERED spot that is still sitting there unsubmitted. Those were
 *     live before any of this existed and nobody promised them 48 hours;
 *     counting them would open the feature with a queue full of breaches that
 *     mean nothing. They are chased through a separate backlog list instead.
 *
 * Once a grandfathered owner DOES submit, the clock runs like anyone else's.
 * Being an early listing is a reason we never promised them 48 hours, not a
 * reason to owe them less once they have done what we asked.
 *
 * @param {object}        args
 * @param {string}        args.status       the spot's verification status
 * @param {Date|string|null} args.submittedAt
 * @param {Date}          [args.now]
 * @returns {{sla: string, waiting_hours: number|null, hours_left: number|null, overdue_by_hours: number|null}}
 */
function waitFor({ status, submittedAt, now = new Date() }) {
  const idle = { sla: SLA.NOT_WAITING, waiting_hours: null, hours_left: null, overdue_by_hours: null };

  if (!AWAITING_REVIEW_STATUSES.includes(status)) return idle;
  if (!submittedAt) return idle;

  const submitted = new Date(submittedAt).getTime();
  if (!Number.isFinite(submitted)) return idle;

  // A submitted_at in the future means a clock disagreed somewhere, not that
  // the owner has negative patience. Treat it as just submitted.
  const waitingHours = Math.max(0, (now.getTime() - submitted) / HOUR_MS);
  const waiting = round1(waitingHours);

  const sla = waiting >= SLA_HOURS ? SLA.OVERDUE
    : waiting >= AT_RISK_HOURS ? SLA.AT_RISK
      : SLA.OK;

  return {
    sla,
    waiting_hours: waiting,
    hours_left: round1(Math.max(0, SLA_HOURS - waitingHours)),
    overdue_by_hours: waiting >= SLA_HOURS ? round1(waitingHours - SLA_HOURS) : null,
  };
}

/**
 * Does the document's address agree with the pin?
 *
 * The bands are 150 m and 1 km, as agreed. What matters as much is WHAT THE
 * ADDRESS RESOLVED TO, because the distance is otherwise meaningless:
 *
 *   - a full building address in Bengaluru comes back as the STREET, because
 *     Nominatim drops house numbers. 120 m from a street centroid is nothing.
 *   - "Indiranagar, Bengaluru" comes back as a suburb 4.4 km across. Being
 *     800 m from the middle of it says nothing at all about a driveway — and
 *     neither does being 2 km from it.
 *   - a bill-style address with no commas comes back as nothing.
 *
 * So a coarse hit is allowed its own size before any distance counts, and can
 * never read as CONFIRMATION however close the pin is — only as unverifiable,
 * or, if the pin is far outside the area entirely, as a mismatch. A fine hit
 * gets the bands as written.
 *
 * Nothing here decides anything. An admin reads the document; this tells them
 * what the numbers are worth.
 */
const ADDRESS_VERDICT = {
  /** Close, and the address resolved precisely enough for that to mean it. */
  CONSISTENT: 'consistent',
  /** Far enough to look at, close enough to be ordinary. */
  REVIEW: 'review',
  /** Beyond anything the imprecision can explain. */
  MISMATCH: 'mismatch',
  /** Resolved, but only to an area the pin sits inside. Proves nothing. */
  UNVERIFIABLE: 'unverifiable',
  /** Nothing came back. Never a pass on its own. */
  UNRESOLVED: 'unresolved',
};

/** Within this, a precise hit counts as agreeing with the pin. */
const ADDRESS_CONSISTENT_M = 150;
/** Beyond this, a precise hit is a mismatch rather than something to look at. */
const ADDRESS_REVIEW_M = 1000;

/**
 * @param {object} args
 * @param {number|null} args.metres       pin to geocoded point
 * @param {string|null} args.precision    see geocoding.PRECISION
 * @param {number|null} args.uncertaintyM the size of the thing that was found
 */
function addressVerdictFor({ metres, precision, uncertaintyM }) {
  if (metres === null || metres === undefined || !Number.isFinite(Number(metres))) {
    return {
      verdict: ADDRESS_VERDICT.UNRESOLVED,
      metres: null,
      beyond_m: null,
      explanation: 'The address on the document could not be found on the map, so there is nothing to compare the pin against.',
    };
  }

  const d = Number(metres);
  const fine = FINE_PRECISIONS.includes(precision);
  // A coarse hit is allowed its own radius before any of the distance counts
  // against the owner. A fine hit gets no allowance.
  const allowance = fine ? 0 : Math.max(0, Number(uncertaintyM) || 0);
  const beyond = Math.max(0, d - allowance);

  let verdict;
  if (beyond <= ADDRESS_CONSISTENT_M) {
    verdict = fine ? ADDRESS_VERDICT.CONSISTENT : ADDRESS_VERDICT.UNVERIFIABLE;
  } else if (beyond <= ADDRESS_REVIEW_M) {
    verdict = ADDRESS_VERDICT.REVIEW;
  } else {
    verdict = ADDRESS_VERDICT.MISMATCH;
  }

  const explanations = {
    [ADDRESS_VERDICT.CONSISTENT]: `The address resolves to within ${Math.round(d)} m of the pin.`,
    [ADDRESS_VERDICT.UNVERIFIABLE]: `The address only resolves to a ${precision} about ${Math.round(allowance)} m across, and the pin is inside it. The distance neither confirms nor contradicts anything — read the document.`,
    [ADDRESS_VERDICT.REVIEW]: fine
      ? `The pin is ${Math.round(d)} m from the address. Ordinary for a street-level result, worth a look.`
      : `The pin is ${Math.round(d)} m from the middle of a ${precision}, which is ${Math.round(beyond)} m outside it.`,
    [ADDRESS_VERDICT.MISMATCH]: fine
      ? `The pin is ${Math.round(d)} m from the address — too far to be the same place.`
      : `The pin is ${Math.round(beyond)} m outside the ${precision} this address resolves to.`,
  };

  return { verdict, metres: Math.round(d), beyond_m: Math.round(beyond), explanation: explanations[verdict] };
}

/**
 * Are these two typed addresses the same place, for the purpose of deciding
 * whether one document may cover both spots?
 *
 * Deliberately crude, and deliberately crude in the SAFE direction. It is only
 * ever used to answer "has this exact file already been submitted somewhere
 * else?", and the consequence of saying "not the same" is that an admin is
 * asked to look. The consequence of a clever normaliser mistakenly saying
 * "same" is a document silently covering a second address, so near-misses must
 * fall on the side of asking.
 *
 * So: case, punctuation and runs of whitespace are ignored, and nothing else
 * is. No abbreviation expansion, no "Rd" for "Road", no transliteration. Two
 * spellings of one address read as two addresses here, which is the right
 * failure.
 */
function sameClaimedAddress(a, b) {
  const flatten = (v) => String(v || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

  const left = flatten(a);
  const right = flatten(b);
  // Two blanks are not a match. Nothing is known about either.
  if (!left || !right) return false;
  return left === right;
}

/**
 * May this spot go live? Both stages, or neither.
 *
 * A pure function rather than an implicit consequence of the status machine,
 * because "a desk pass AND a field pass" is the whole promise of the feature
 * and it should be checkable in one place. The controller asserts it before
 * anything writes `approved`, so a future second path to that status cannot
 * skip a stage by accident.
 *
 * `field_record_found` must be exactly true. Null is "nobody has looked yet",
 * which is not a pass, and the difference matters: a spot whose field check
 * has not happened must not be one boolean coercion away from being live.
 */
function deskAndFieldPassed(record) {
  const deskPassed = !!record?.desk_reviewed_at && record?.status !== SPOT_VERIFICATION_STATUS.REJECTED;
  const fieldPassed = record?.field_record_found === true && !!record?.field_checked_at;
  return deskPassed && fieldPassed;
}

/**
 * WHOSE NAME the ownership document is supposed to carry.
 *
 * An owner's document names the owner, and is checked against their verified
 * Aadhaar name. A TENANT's ownership document names their LANDLORD — that is
 * what stage 3 asks a tenant to submit, and it is correct — so checking it
 * against the tenant's Aadhaar name asks the wrong question and gets the wrong
 * answer every single time.
 *
 * It was doing exactly that until 15 Nov 2026: a correct tenant submission
 * (khata "Ramesh Gupta", owner "Priya Nair") came out NO_MATCH, raised
 * NAME_NO_MATCH and demanded an override. Every tenant, every time. The note
 * on deskPassBlockers below says why that is dangerous in its own words — an
 * override that is always required is not a signal, it is a keystroke — and an
 * admin trained to click through NAME_NO_MATCH is an admin who will click
 * through it on a forged OWNER submission too.
 *
 * So for a tenant the document is compared to the landlord's name instead, and
 * a second question is asked that nobody was asking at all: does the consent
 * letter actually name this owner? We cannot read the letter, so an admin must
 * say. For an owner, nothing changes.
 */
const NAME_CHECKED_AGAINST = {
  AADHAAR: 'aadhaar_name',
  LANDLORD: 'landlord_name',
};

/**
 * What stands in the way of passing a desk review.
 *
 * Both of the original two yield to an admin who says why in writing: a name
 * that does not look like the same person, and an address that is either
 * somewhere else or nowhere at all.
 *
 * UNVERIFIABLE and REVIEW deliberately do NOT block. Most legitimate Indian
 * addresses resolve only to a locality — it is what the geocoder does — so
 * blocking on that would mean an override on nearly every pass, and an
 * override that is always required is not a signal, it is a keystroke.
 *
 * @param {object} args
 * @param {string|null} args.nameVerdict
 * @param {string}      args.addressVerdict
 * @param {string}      [args.checkedAgainst]  see NAME_CHECKED_AGAINST
 * @param {boolean}     [args.isTenant]
 * @param {boolean|null}[args.nocNamesOwner]   admin's answer; tenants only
 */
function deskPassBlockers({
  nameVerdict,
  addressVerdict,
  checkedAgainst = NAME_CHECKED_AGAINST.AADHAAR,
  isTenant = false,
  nocNamesOwner = null,
}) {
  const blockers = [];

  if (!GOOD_NAME_MATCH.includes(nameVerdict) && !REVIEW_NAME_MATCH.includes(nameVerdict)) {
    blockers.push(checkedAgainst === NAME_CHECKED_AGAINST.LANDLORD
      ? {
        code: 'LANDLORD_NAME_NO_MATCH',
        message: 'The name on the ownership document does not look like the landlord who signed the consent letter.',
      }
      : {
        code: 'NAME_NO_MATCH',
        message: 'The name on the document does not look like the same person as the verified Aadhaar name.',
      });
  }

  /**
   * The letter has to name the owner, and only a human can tell us.
   *
   * Without this the tenant path held a letter nobody had read against the
   * person claiming it: an owner could submit their landlord's genuine khata
   * plus a consent letter written for somebody else entirely — a previous
   * tenant, say — and both documents would be real.
   *
   * It does not yield to an override, because there is nothing to weigh. The
   * admin is looking at the letter. Either it names this owner or it does not.
   */
  if (isTenant && nocNamesOwner !== true) {
    blockers.push({
      code: 'NOC_DOES_NOT_NAME_OWNER',
      message: nocNamesOwner === false
        ? 'The consent letter does not name this owner, so it does not permit them to let this space.'
        : 'Confirm that the consent letter names this owner and this address.',
      final: true,
    });
  }

  if (addressVerdict === ADDRESS_VERDICT.MISMATCH) {
    blockers.push({
      code: 'ADDRESS_MISMATCH',
      message: 'The address on the document is too far from this spot to be the same place.',
    });
  }
  if (addressVerdict === ADDRESS_VERDICT.UNRESOLVED) {
    blockers.push({
      code: 'ADDRESS_UNRESOLVED',
      message: 'The address on the document could not be found on the map, so it cannot be checked against the pin.',
    });
  }

  return blockers;
}

/**
 * The blockers an override cannot clear.
 *
 * Most blockers are judgment calls an admin may take responsibility for in
 * writing. A few are not: they are missing facts, and no amount of reasoning
 * supplies them.
 */
const unoverridableBlockers = (blockers) => blockers.filter((b) => b.final === true);

/**
 * What a DRIVER may see, given the record — the value cached on
 * parking_spots.spot_verification_status.
 *
 * It is not a blind copy of `status`, and the difference is the promise that
 * nothing live disappears quietly. A spot that was already in the finder when
 * this feature shipped moves through in_progress and desk_pending like any
 * other, and a driver may see neither — so copying the status across would
 * take a working listing off the map the moment its owner did as we asked.
 *
 * So: a verdict governs once there is one, and until then a grandfathered spot
 * stays grandfathered. The only way such a spot leaves the finder is a
 * rejection, which the owner is shown with a reason.
 *
 * @param {{status: string, grandfathered_at?: Date|string|null}} record
 */
function driverVisibleStatusFor(record) {
  const S = SPOT_VERIFICATION_STATUS;
  const status = record?.status;

  if (status === S.APPROVED || status === S.REJECTED) return status;
  if (record?.grandfathered_at) return S.GRANDFATHERED;
  return status;
}

/**
 * What the owner is told, in plain words.
 *
 * Kept next to the clock so the state and the sentence cannot drift apart.
 * "Under review" never promises a time it cannot keep: once we are past 48
 * hours it says so rather than counting down from a deadline already missed.
 */
function ownerMessageFor({ status, submittedAt, now = new Date() }) {
  const S = SPOT_VERIFICATION_STATUS;
  const wait = waitFor({ status, submittedAt, now });

  switch (status) {
    case S.NOT_STARTED:
      return 'Add a document for this address to get this spot verified. Drivers cannot see it yet.';
    case S.IN_PROGRESS:
      return 'Your document is saved. Submit it for review to get this spot live.';
    case S.DESK_PENDING:
      if (wait.sla === SLA.OVERDUE) {
        return 'Under review. This is taking longer than the 48 hours we promised — we are on it.';
      }
      return `Under review. Expected live within ${Math.max(1, Math.ceil(wait.hours_left))} hour(s).`;
    case S.DESK_APPROVED:
      // A different thing is happening now, and saying so is the difference
      // between "nobody has looked at this" and "somebody is on their way to
      // an office about it".
      if (wait.sla === SLA.OVERDUE) {
        return 'Your document has been checked. Our team is confirming the record locally, and this is taking longer than the 48 hours we promised.';
      }
      return `Your document has been checked. Our team is confirming the record locally — expected live within ${Math.max(1, Math.ceil(wait.hours_left))} hour(s).`;
    case S.APPROVED:
      return 'Verified. Drivers can see and book this spot.';
    case S.REJECTED:
      return 'We could not verify this spot. See what to fix, then submit it again.';
    case S.GRANDFATHERED:
      // Honest about where it stands: visible, not yet checked.
      return 'Live on ParkStop. We still need to check this address — we will ask you for a document.';
    default:
      return 'Drivers cannot see this spot yet.';
  }
}

/**
 * One spot's verification state as its OWNER sees it.
 *
 * Here rather than in the controller because two screens read it — the
 * per-spot endpoint and the inventory list on the owner's dashboard — and an
 * owner being told two different things about the same spot is exactly the
 * confusion this feature is supposed to remove. No admin names, no document
 * ids, no internal flags.
 *
 * @param {object} spot    id, title and the cached spot_verification_status
 * @param {object} record  the spot_verifications row (may be a bare {status})
 */
function ownerSummary(spot, record, now = new Date()) {
  const status = record?.status || spot?.spot_verification_status || SPOT_VERIFICATION_STATUS.NOT_STARTED;
  const submittedAt = record?.submitted_at || null;
  const visible = spot?.spot_verification_status ?? driverVisibleStatusFor({ status, grandfathered_at: record?.grandfathered_at });
  const wait = waitFor({ status, submittedAt, now });

  return {
    spot_id: spot?.id,
    title: spot?.title,
    status,
    /** What drivers see right now, which is not always the same thing. */
    visible_to_drivers: visible,
    is_live: isVisibleToDrivers(visible),
    message: ownerMessageFor({ status, submittedAt, now }),
    document: record?.doc_public_id
      ? { doc_type: record.doc_type, address: record.claimed_address, relationship: record.relationship }
      : null,
    submitted_at: submittedAt,
    waiting_hours: wait.waiting_hours,
    hours_left: wait.hours_left,
    promised_hours: SLA_HOURS,
    rejection_reason: status === SPOT_VERIFICATION_STATUS.REJECTED ? (record?.rejection_reason || null) : null,
    pin_locked: isPinFrozen(visible),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = {
  SLA,
  SLA_HOURS,
  AT_RISK_HOURS,
  ADDRESS_VERDICT,
  ADDRESS_CONSISTENT_M,
  ADDRESS_REVIEW_M,
  NAME_CHECKED_AGAINST,
  waitFor,
  addressVerdictFor,
  sameClaimedAddress,
  deskPassBlockers,
  unoverridableBlockers,
  deskAndFieldPassed,
  driverVisibleStatusFor,
  ownerMessageFor,
  ownerSummary,
};
