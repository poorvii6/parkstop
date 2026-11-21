/**
 * What counts as proof that someone holds the place they are listing.
 *
 * ONE list. Until 15 Nov 2026 there were three hand-maintained copies of the
 * same six strings — the per-spot document, the per-person KYC property step,
 * and the labels the app rendered — and that is exactly how the per-spot flow
 * came to offer an electricity bill as proof of ownership: stage 1 copied the
 * KYC list without re-reading it.
 *
 * ELECTRICITY AND WATER BILLS WERE REMOVED. The reason is worth keeping,
 * because the list looks arbitrary otherwise: a utility bill in your name
 * proves you pay for power or water at an address. It says nothing about who
 * owns the land. A tenant, a lodger, a caretaker or the previous occupant's
 * relative can all produce one, so accepting it meant the desk review was
 * comparing a verified Aadhaar name against a document that never claimed to
 * name an owner in the first place.
 *
 * Every type below either names a holder on a property record — khata, sale
 * deed, tax receipt, encumbrance certificate — or is a TENANCY document, which
 * is not ownership proof and is only accepted alongside the landlord's
 * ownership document and written consent. `proves` is what says which, and
 * the tenant-consent rule in stage 3 is derived from it rather than from a
 * second list that could disagree.
 *
 * NOTHING RE-VALIDATES A STORED DOCUMENT. A row submitted under a type that
 * has since been removed keeps its value, still renders (labelForDocType falls
 * back to the raw string rather than a blank), and can still be decided by an
 * admin. The owner simply cannot choose one again, so a resubmission after a
 * rejection has to use a real one.
 */

/** Proof that a property record names this person. */
const OWNERSHIP = 'ownership';
/** Proof only that they rent it. Needs the landlord's document and consent. */
const TENANCY = 'tenancy';

const PROPERTY_DOC_TYPES = [
  { key: 'khata_certificate', label: 'Khata certificate', proves: OWNERSHIP },
  { key: 'sale_deed', label: 'Sale deed', proves: OWNERSHIP },
  /**
   * Splits joint or ancestral property between family members, and is the
   * ownership document for a driveway on a divided family plot — which is a
   * large share of older Bengaluru housing. Registered, so the field check can
   * find it at the sub-registrar's office like a sale deed.
   */
  { key: 'partition_deed', label: 'Partition deed', proves: OWNERSHIP },
  { key: 'property_tax', label: 'Property tax receipt', proves: OWNERSHIP },
  { key: 'encumbrance_certificate', label: 'Encumbrance certificate', proves: OWNERSHIP },
  /**
   * BBMP paperwork other than the khata: allotment letter, possession
   * certificate, betterment charges receipt.
   *
   * NOTE THE OVERLAP, because it will show up in the queue: a khata
   * certificate is itself a BBMP document, and an owner holding one can
   * reasonably tap either chip. The khata has its own entry above because it
   * is the common case and the admin screen benefits from knowing it is a
   * khata; this one is for the rest. If the split turns out to confuse
   * owners, the fix is to merge them, not to add a third.
   */
  { key: 'bbmp_papers', label: 'BBMP document', proves: OWNERSHIP },
  { key: 'rent_agreement', label: 'Rent agreement', proves: TENANCY },
  /**
   * The escape hatch, and deliberately narrow in its wording: there are more
   * ownership forms still (BDA allotment, gift deed, court decree, a society
   * share certificate). An admin reads the document either way. It is NOT a
   * slot for a utility bill — the label says what it is for.
   */
  { key: 'other', label: 'Other ownership document', proves: OWNERSHIP },
];

/** Just the keys, for validators and `isIn` checks. */
const PROPERTY_DOC_TYPE_KEYS = PROPERTY_DOC_TYPES.map((d) => d.key);

/**
 * What can carry ownership from a dead holder to the person in front of us.
 *
 * An inherited khata still in a dead parent's name is ordinary in Bengaluru,
 * so a document naming a LATE holder cannot simply be refused — that would
 * leave honest heirs with no route at all. But it cannot be waved through on a
 * free-text note either.
 *
 * So the admin NAMES THE DOCUMENT THEY ARE HOLDING, from this list. That is
 * the same distinction the NOC confirmation draws: a note is a keystroke,
 * whereas "I am looking at a succession certificate" is a statement of fact
 * that can be wrong, can be checked later, and someone has put their name to.
 */
const INHERITANCE_DOC_TYPES = [
  { key: 'khata_transfer', label: 'Khata transfer / mutation in the heir\'s name' },
  { key: 'succession_certificate', label: 'Succession certificate' },
  { key: 'partition_deed', label: 'Partition deed between the heirs' },
  { key: 'probated_will', label: 'Probated will' },
];

const INHERITANCE_DOC_TYPE_KEYS = INHERITANCE_DOC_TYPES.map((d) => d.key);

/**
 * The types that mean the submitter is a tenant.
 *
 * Derived, not written out again. Stage 3 refuses a submission with one of
 * these unless the landlord's consent letter and name are both present —
 * whatever the owner ticked, because a rent agreement IS a tenant's document.
 */
const TENANCY_DOC_TYPE_KEYS = PROPERTY_DOC_TYPES
  .filter((d) => d.proves === TENANCY)
  .map((d) => d.key);

/**
 * Human text for a stored type, including one that is no longer offered.
 *
 * Falls back to the raw string so a legacy `electricity_bill` row reads as
 * something rather than as an empty space on an admin's screen.
 *
 * @param {string|null|undefined} key
 * @returns {string|null}
 */
function labelForDocType(key) {
  if (!key) return null;
  return PROPERTY_DOC_TYPES.find((d) => d.key === key)?.label
    || INHERITANCE_DOC_TYPES.find((d) => d.key === key)?.label
    || String(key);
}

module.exports = {
  OWNERSHIP,
  TENANCY,
  PROPERTY_DOC_TYPES,
  PROPERTY_DOC_TYPE_KEYS,
  TENANCY_DOC_TYPE_KEYS,
  INHERITANCE_DOC_TYPES,
  INHERITANCE_DOC_TYPE_KEYS,
  labelForDocType,
};
