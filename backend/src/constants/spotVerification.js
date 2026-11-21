/**
 * Per-spot property verification: the states, and the one definition of which
 * of them a driver may see.
 *
 * Owner verification approves a PERSON — Aadhaar, PAN, selfie, bank. It says
 * nothing about a PLACE. The property document an owner uploads at
 * owner_verifications.property_* is never compared to any spot they list, so
 * an owner could upload their own electricity bill and list a driveway three
 * kilometres away. Each spot is now verified in its own right: a document for
 * that address, in that person's name, read by an admin (desk) and confirmed
 * against the local record by our team (field).
 *
 * WHAT 'approved' MEANS, exactly, so nobody later reads it as more: a person
 * whose identity we checked submitted a document in their name for an address
 * near this pin, an admin read it, and our team found the record at the
 * regional office. It does not mean the document is genuine — a good forgery
 * passes a desk review, which is the whole reason the field check exists — and
 * it does not mean the owner is allowed to let the space (society rules,
 * municipal permission).
 */
const { Prisma } = require('@prisma/client');

const { PROPERTY_DOC_TYPE_KEYS, TENANCY_DOC_TYPE_KEYS, labelForDocType } = require('./propertyDocTypes');

const SPOT_VERIFICATION_STATUS = {
  /** A spot with no document uploaded yet. Where every new spot starts. */
  NOT_STARTED: 'not_started',
  /** Document uploaded, not submitted for review. */
  IN_PROGRESS: 'in_progress',
  /** Submitted. Waiting for an admin to read the document. The clock runs. */
  DESK_PENDING: 'desk_pending',
  /** Desk review passed. Waiting for the field check. Still not visible. */
  DESK_APPROVED: 'desk_approved',
  /** Desk AND field both passed. Visible and bookable. */
  APPROVED: 'approved',
  /** Sent back to the owner with a reason, from either stage. */
  REJECTED: 'rejected',
  /**
   * Live before per-spot verification existed.
   *
   * Six spots were visible in the finder on the day this shipped. Writing
   * 'approved' on them would record a check nobody performed, which is the
   * one thing this feature exists to stop. They stay visible under their own
   * status, they are listed in a backlog an admin works through, and they are
   * deliberately NOT on the 48-hour clock, because nobody was promised 48
   * hours for them. When the backlog is empty, this status disappears and
   * VISIBLE_STATUSES loses one entry.
   */
  GRANDFATHERED: 'grandfathered',
};

const ALL_SPOT_VERIFICATION_STATUSES = Object.values(SPOT_VERIFICATION_STATUS);

/**
 * The gate. One list, read by every path that shows a spot to a driver:
 * findNearby, findAbsoluteNearest, findAvailable, the saved-spots list and
 * Booking.create.
 *
 * A NULL status is not in it, so a row that somehow misses the backfill is
 * invisible rather than visible — the safe direction for a column that
 * decides whether a stranger is sent to someone's driveway.
 */
const VISIBLE_SPOT_STATUSES = [
  SPOT_VERIFICATION_STATUS.APPROVED,
  SPOT_VERIFICATION_STATUS.GRANDFATHERED,
];

/** Waiting on a human. These are what the clock and the queue are about. */
const AWAITING_REVIEW_STATUSES = [
  SPOT_VERIFICATION_STATUS.DESK_PENDING,
  SPOT_VERIFICATION_STATUS.DESK_APPROVED,
];

/**
 * Documents an owner may submit for a spot.
 *
 * No longer a mirror of the per-person list — it IS the per-person list, read
 * from constants/propertyDocTypes.js, which both flows and both apps share.
 * It used to be a copy, and the copy is how a utility bill came to be
 * acceptable proof of ownership here. See that file for what was removed.
 */
const SPOT_DOC_TYPES = PROPERTY_DOC_TYPE_KEYS;

/** How the submitter holds the place. A tenant needs the landlord's consent. */
const RELATIONSHIPS = { OWNER: 'owner', TENANT: 'tenant' };

/**
 * A tenancy document needs an NOC (stage 3).
 *
 * Derived from the shared list rather than written out, so adding a tenancy
 * document type cannot leave the consent rule behind.
 */
const TENANT_DOC_TYPES = TENANCY_DOC_TYPE_KEYS;

// ───────────────────────────── the gate switch ─────────────────────────────

/** The Railway variable. */
const GATE_VARIABLE = 'SPOT_VERIFICATION_GATE';
/** The ONLY value that turns it on. Anything else, including unset, is off. */
const GATE_ON_VALUE = 'on';

/**
 * THE ONE PLACE THE FLAG IS READ. Nothing else in the codebase may look at
 * process.env.SPOT_VERIFICATION_GATE — everything asks the questions below
 * instead, and gets a domain answer rather than a boolean.
 *
 * WHY THERE IS A FLAG AT ALL. Railway deploys from main, so merging makes the
 * gate live on the server the moment the branch lands. But the owner's upload
 * screen needs a native rebuild (expo-document-picker), and app releases do
 * not land at the same instant a server deploy does. In the gap, an owner on
 * the installed build would submit a spot, watch it go invisible, and have no
 * screen to fix it with — the gate with no door, arriving through the release
 * gap instead of through the code.
 *
 * So: DEFAULT OFF. Merging to main changes no behaviour. Then the app ships,
 * then this one variable is set, and stages 1-4b apply.
 *
 * WHAT 'OFF' MEANS, exactly. Precisely the behaviour on the commit before
 * stage 1 (3d8e04f):
 *
 *   - a spot's own verification status hides NOTHING from drivers, and does
 *     not stop a booking
 *   - the pin freeze is keyed on the OWNER being approved, which is what it
 *     was keyed on before stage 1
 *   - the owner is promised no 48 hours, because there is nothing to promise:
 *     the spot is already live
 *
 * WHAT 'OFF' DOES NOT MEAN. The feature is not disabled. Every endpoint
 * works, submissions are recorded, the desk and field reviews decide, the
 * admin queue lists, the clock is still measured for admins. Only the
 * CONSEQUENCES FOR DRIVERS AND OWNERS are held back, so the whole flow can be
 * exercised end to end before anybody is subject to it.
 *
 * GRANDFATHERED SPOTS ARE UNAFFECTED EITHER WAY. They are visible with the
 * gate on and visible with it off.
 *
 * A function rather than a constant read at load time, so a test can exercise
 * both states in one run. The off path is the one about to be in production,
 * so a suite that only ran with the gate on would be testing the wrong thing.
 */
const isSpotGateEnabled = () =>
  String(process.env[GATE_VARIABLE] || '').trim().toLowerCase() === GATE_ON_VALUE;

/**
 * May a driver see a spot in this state?
 *
 * With the gate off the question does not apply, so the answer is yes — the
 * spot's own verification is not what decides visibility, exactly as before
 * stage 1. The owner still has to be approved; that check is separate and
 * older and is untouched by this flag.
 */
const isVisibleToDrivers = (status) =>
  !isSpotGateEnabled() || VISIBLE_SPOT_STATUSES.includes(status);

/**
 * The driver-visibility filter as a Prisma `where` fragment — spread into a
 * query rather than written out at each call site, so the gate's shape is
 * decided here and not in four models.
 *
 * `{}` when the gate is off: no clause, so nothing is filtered out.
 */
const driverVisibilityWhere = () => (isSpotGateEnabled()
  ? { spot_verification_status: { in: VISIBLE_SPOT_STATUSES } }
  : {});

/**
 * The same filter for the raw finder queries, as a composable SQL fragment.
 *
 * `Prisma.empty` when the gate is off, which removes the clause and renumbers
 * the remaining parameters correctly — a filter that is absent rather than
 * one that is widened, so a row with a NULL status is visible too. That
 * matters: `= ANY(array)` is false for NULL, so merely putting every status
 * in the list would still hide a row that somehow missed the backfill, and
 * "off" has to mean no change at all.
 */
const driverVisibilitySql = () => (isSpotGateEnabled()
  ? Prisma.sql`AND parking_spots.spot_verification_status = ANY(${VISIBLE_SPOT_STATUSES})`
  : Prisma.empty);

/**
 * Whether the pin is fixed, given the spot's driver-visible status.
 *
 * Two reasons to freeze it, and they are different:
 *
 *   - the spot is LIVE. The pin is what a driver navigates to, so moving it
 *     relocates a listing people are already being sent to.
 *   - the spot is AWAITING REVIEW. The desk check measures the distance from
 *     the document's address to this pin; if the pin could move after that
 *     measurement, the check it passed was about somewhere else.
 *
 * Everything else is free: a spot that has not been submitted, and a rejected
 * one — which is what makes "your pin is in the wrong place" a rejection the
 * owner can actually act on.
 */
const isPinFrozen = (status) =>
  isSpotGateEnabled()
  && (VISIBLE_SPOT_STATUSES.includes(status) || AWAITING_REVIEW_STATUSES.includes(status));

/**
 * Why this pin cannot be moved, or null if it can.
 *
 * ONE function for the whole decision, because the rule is genuinely
 * DIFFERENT in the two states and the caller must not be the place that
 * chooses between them:
 *
 *   gate ON   keyed on the SPOT. Frozen while it is live to drivers or
 *             waiting on a review — the desk check measures the document's
 *             address against this pin, so a pin that could move after the
 *             measurement would mean the check passed about somewhere else.
 *   gate OFF  keyed on the OWNER being approved, which is exactly what it was
 *             keyed on before stage 1 (ParkingSpot.js at 3d8e04f). Restoring
 *             the old rule rather than leaving the pin free, because "off"
 *             means no change — not fewer protections than before.
 *
 * Returns the sentence as well as the reason, so the two states cannot drift
 * into telling an owner something that is true of the other one.
 */
function pinFreezeReason({ spotStatus, ownerApproved }) {
  if (!isSpotGateEnabled()) {
    if (!ownerApproved) return null;
    return {
      code: 'OWNER_APPROVED',
      message: 'This spot cannot be moved now that your account is verified, because drivers '
        + 'are already navigating to it. List the new location as a new spot, or contact '
        + 'ParkStop support to move this one.',
    };
  }

  if (AWAITING_REVIEW_STATUSES.includes(spotStatus)) {
    return {
      code: 'UNDER_REVIEW',
      message: 'This spot cannot be moved while we are checking its address. The address you '
        + 'sent us is being checked against this pin. Wait for the result, or contact '
        + 'ParkStop support.',
    };
  }
  if (VISIBLE_SPOT_STATUSES.includes(spotStatus)) {
    return {
      code: 'LIVE',
      message: 'This spot cannot be moved while it is live on ParkStop, because drivers are '
        + 'already navigating to it. List the new location as a new spot, or contact '
        + 'ParkStop support to move this one.',
    };
  }
  return null;
}

/**
 * What to tell an owner the moment they are approved as a PERSON.
 *
 * This lives here, next to pinFreezeReason and for the same reason: the true
 * sentence is different in the two gate states, and the caller must not be
 * what chooses between them.
 *
 * The old message said "Your parking spots are now visible to drivers on
 * ParkStop." That was true before per-spot verification, and it is still true
 * with the gate OFF. With the gate ON it is wrong in the worst way: the owner
 * reads it, opens the app, and finds every spot hidden, because the finder now
 * needs the owner approved AND each spot's own document check.
 *
 * @param {object}  arg
 * @param {number}  arg.spotsNeedingVerification  how many of this owner's
 *   spots are not yet visible to drivers. Counted by the caller, which is the
 *   only side with the database. Ignored when the gate is off.
 * @param {number}  arg.totalSpots  how many spots they have at all.
 * @returns {{ title: string, body: string }}
 */
function ownerApprovedMessage({ spotsNeedingVerification = 0, totalSpots = 0 } = {}) {
  if (!isSpotGateEnabled()) {
    // Unchanged, because with the gate off nothing about a spot's own status
    // affects whether a driver sees it. Promising the per-spot check here
    // would send the owner looking for a step that does not apply to them.
    return {
      title: 'You are verified ✅',
      body: 'Your parking spots are now visible to drivers on ParkStop.',
    };
  }

  // Approved as a person, and nothing of theirs is waiting. Either they have
  // no spots yet, or every one is already approved or grandfathered.
  if (spotsNeedingVerification === 0) {
    return {
      title: 'You are verified ✅',
      body: totalSpots > 0
        ? 'You are verified as a person, and your spots are visible to drivers on ParkStop.'
        : 'You are verified as a person. Add a spot and send its ownership document, and we '
          + 'will check it within 48 hours.',
    };
  }

  const n = spotsNeedingVerification;
  const them = n === 1 ? 'it' : 'them';
  const spot = n === 1 ? 'spot' : 'spots';
  const needs = n === totalSpots ? `Your ${n === 1 ? 'spot' : `${n} spots`}` : `${n} of your ${spot}`;

  return {
    title: 'You are verified as a person ✅',
    body: `${needs} still ${n === 1 ? 'needs' : 'need'} a separate document check before `
      + `drivers can see ${them}. Send ${n === 1 ? 'its ownership document' : 'the ownership document for each'} `
      + 'and we will check it within 48 hours.',
  };
}

module.exports = {
  SPOT_VERIFICATION_STATUS,
  ALL_SPOT_VERIFICATION_STATUSES,
  VISIBLE_SPOT_STATUSES,
  AWAITING_REVIEW_STATUSES,
  SPOT_DOC_TYPES,
  RELATIONSHIPS,
  TENANT_DOC_TYPES,
  GATE_VARIABLE,
  GATE_ON_VALUE,
  isSpotGateEnabled,
  isVisibleToDrivers,
  driverVisibilityWhere,
  driverVisibilitySql,
  isPinFrozen,
  pinFreezeReason,
  ownerApprovedMessage,
  // Re-exported so a screen or controller that already imports the spot
  // constants does not need a second require to turn a type into words.
  labelForDocType,
};
