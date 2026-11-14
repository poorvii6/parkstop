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
    case S.DESK_APPROVED:
      if (wait.sla === SLA.OVERDUE) {
        return 'Under review. This is taking longer than the 48 hours we promised — we are on it.';
      }
      return `Under review. Expected live within ${Math.max(1, Math.ceil(wait.hours_left))} hour(s).`;
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
  waitFor,
  driverVisibleStatusFor,
  ownerMessageFor,
  ownerSummary,
};
