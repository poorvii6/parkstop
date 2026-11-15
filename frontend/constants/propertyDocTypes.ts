/**
 * What counts as proof that someone holds the place they are listing — the
 * app's copy of backend/src/constants/propertyDocTypes.js.
 *
 * It is a copy because a chip list has to render before any request is made,
 * and a static six-item list is not worth a network round trip to fetch. What
 * stops it drifting is not this comment: backend/tests/unit/propertyDocTypes
 * .test.js reads THIS FILE, extracts the keys, and fails if they disagree with
 * the server's. Edit one and the other is a failing test, not a silent bug —
 * which is the whole point, because three hand-maintained copies of this list
 * are how an electricity bill came to be offered as proof of ownership.
 *
 * Read that file for why utility bills were removed and what happens to a
 * document already stored under one. The short version: a utility bill proves
 * you pay for power at an address, not that you own the land.
 */

/** Proof that a property record names this person. */
export const OWNERSHIP = 'ownership';
/** Proof only that they rent it. Needs the landlord's document and consent. */
export const TENANCY = 'tenancy';

export type PropertyDocType = {
  key: string;
  label: string;
  proves: typeof OWNERSHIP | typeof TENANCY;
};

export const PROPERTY_DOC_TYPES: PropertyDocType[] = [
  { key: 'khata_certificate', label: 'Khata certificate', proves: OWNERSHIP },
  { key: 'sale_deed', label: 'Sale deed', proves: OWNERSHIP },
  // Splits joint or ancestral property between family members — the ownership
  // document for a driveway on a divided family plot, which is a large share
  // of older Bengaluru housing.
  { key: 'partition_deed', label: 'Partition deed', proves: OWNERSHIP },
  { key: 'property_tax', label: 'Property tax receipt', proves: OWNERSHIP },
  { key: 'encumbrance_certificate', label: 'Encumbrance certificate', proves: OWNERSHIP },
  // BBMP paperwork other than the khata: allotment letter, possession
  // certificate, betterment charges receipt. A khata IS a BBMP document, so
  // these two chips overlap and an owner may tap either; the khata keeps its
  // own entry because it is the common case.
  { key: 'bbmp_papers', label: 'BBMP document', proves: OWNERSHIP },
  { key: 'rent_agreement', label: 'Rent agreement', proves: TENANCY },
  // There are more ownership forms still (BDA allotment, gift deed, court
  // decree, society share certificate). The label says what this is for; it
  // is not a slot for a utility bill.
  { key: 'other', label: 'Other ownership document', proves: OWNERSHIP },
];

/**
 * What can carry ownership from a dead holder to the person in front of us.
 *
 * An inherited khata still in a dead parent's name is ordinary in Bengaluru,
 * so a document naming a LATE holder cannot simply be refused — that would
 * leave honest heirs with no route at all. But it is cleared by NAMING the
 * document the reviewer is holding, not by writing a note: a note is a
 * keystroke, whereas "I am looking at a succession certificate" is a
 * statement of fact that can be checked later and that someone has put their
 * name to. Same distinction as the consent-letter confirmation.
 *
 * Mirrors INHERITANCE_DOC_TYPES in backend/src/constants/propertyDocTypes.js
 * and is checked against it by the same drift test.
 */
export const INHERITANCE_DOC_TYPES: { key: string; label: string }[] = [
  { key: 'khata_transfer', label: 'Khata transfer / mutation in the heir\'s name' },
  { key: 'succession_certificate', label: 'Succession certificate' },
  { key: 'partition_deed', label: 'Partition deed between the heirs' },
  { key: 'probated_will', label: 'Probated will' },
];

/** The types that mean the submitter is a tenant and needs the landlord's NOC. */
export const TENANCY_DOC_TYPE_KEYS: string[] = PROPERTY_DOC_TYPES
  .filter((d) => d.proves === TENANCY)
  .map((d) => d.key);

export const isTenancyDoc = (key?: string | null): boolean =>
  !!key && TENANCY_DOC_TYPE_KEYS.includes(key);

/**
 * Human text for a stored type, including one that is no longer offered.
 *
 * Falls back to the raw string so a legacy `electricity_bill` row reads as
 * something rather than as an empty space on a screen.
 */
export function labelForDocType(key?: string | null): string | null {
  if (!key) return null;
  return PROPERTY_DOC_TYPES.find((d) => d.key === key)?.label
    || INHERITANCE_DOC_TYPES.find((d) => d.key === key)?.label
    || String(key);
}
