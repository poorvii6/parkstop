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

/** Documents an owner may submit for a spot. Mirrors the per-person list. */
const SPOT_DOC_TYPES = [
  'electricity_bill',
  'property_tax',
  'rent_agreement',
  'sale_deed',
  'water_bill',
  'other',
];

/** How the submitter holds the place. A tenant needs the landlord's consent. */
const RELATIONSHIPS = { OWNER: 'owner', TENANT: 'tenant' };

/** A rent agreement is a tenant's document, and needs an NOC (stage 3). */
const TENANT_DOC_TYPES = ['rent_agreement'];

const isVisibleToDrivers = (status) => VISIBLE_SPOT_STATUSES.includes(status);

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
  VISIBLE_SPOT_STATUSES.includes(status) || AWAITING_REVIEW_STATUSES.includes(status);

module.exports = {
  SPOT_VERIFICATION_STATUS,
  ALL_SPOT_VERIFICATION_STATUSES,
  VISIBLE_SPOT_STATUSES,
  AWAITING_REVIEW_STATUSES,
  SPOT_DOC_TYPES,
  RELATIONSHIPS,
  TENANT_DOC_TYPES,
  isVisibleToDrivers,
  isPinFrozen,
};
