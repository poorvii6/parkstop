/**
 * The property document list: what it accepts, and that there is only one of it.
 *
 * There were three hand-maintained copies of the same six strings until
 * 15 Nov 2026 — the per-spot document, the per-person KYC property step, and
 * the labels the app rendered. Nothing compared them, so stage 1 copied the
 * KYC list without re-reading it and an ELECTRICITY BILL became acceptable
 * proof that someone owns a driveway.
 *
 * The app still needs its own copy, because a chip list renders before any
 * request is made. So this file reads the frontend's TypeScript and compares
 * it to the server's: edit one and the other is a failing test rather than a
 * silent disagreement about what proof means.
 *
 *   npm run test:unit
 */
const fs = require('fs');
const path = require('path');

const {
  PROPERTY_DOC_TYPES,
  PROPERTY_DOC_TYPE_KEYS,
  TENANCY_DOC_TYPE_KEYS,
  INHERITANCE_DOC_TYPES,
  INHERITANCE_DOC_TYPE_KEYS,
  labelForDocType,
} = require('../../src/constants/propertyDocTypes');
const { SPOT_DOC_TYPES, TENANT_DOC_TYPES } = require('../../src/constants/spotVerification');
const { DOC_TYPES: OWNER_KYC_DOC_TYPES } = require('../../src/controllers/ownerVerificationController');

const FRONTEND_LIST = path.join(__dirname, '../../../frontend/constants/propertyDocTypes.ts');

/** The app's list, read out of its source rather than trusted. */
function frontendEntries() {
  const src = fs.readFileSync(FRONTEND_LIST, 'utf8');

  // Only the array literal, so a key named in a comment or a helper below it
  // cannot be mistaken for an entry.
  const block = src.match(/PROPERTY_DOC_TYPES:\s*PropertyDocType\[\]\s*=\s*\[([\s\S]*?)\n\];/);
  if (!block) throw new Error(`Could not find PROPERTY_DOC_TYPES in ${FRONTEND_LIST}`);

  const entries = [...block[1].matchAll(
    /\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)',\s*proves:\s*(OWNERSHIP|TENANCY)\s*\}/g
  )].map(([, key, label, proves]) => ({ key, label, proves: proves.toLowerCase() }));

  if (!entries.length) throw new Error(`Parsed no entries from ${FRONTEND_LIST}`);
  return entries;
}

/** The app's inheritance list, read out of its source rather than trusted. */
function frontendInheritance() {
  const src = fs.readFileSync(FRONTEND_LIST, 'utf8');

  const block = src.match(
    /INHERITANCE_DOC_TYPES:\s*\{\s*key:\s*string;\s*label:\s*string\s*\}\[\]\s*=\s*\[([\s\S]*?)\n\];/
  );
  if (!block) throw new Error(`Could not find INHERITANCE_DOC_TYPES in ${FRONTEND_LIST}`);

  const entries = [...block[1].matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'((?:[^'\\]|\\.)*)'\s*\}/g)]
    .map(([, key, label]) => ({ key, label: label.replace(/\\'/g, "'") }));

  if (!entries.length) throw new Error(`Parsed no inheritance entries from ${FRONTEND_LIST}`);
  return entries;
}

describe('what counts as proof of holding a property', () => {
  test('a utility bill is not proof of ownership, in either flow or the app', () => {
    // The bug this whole file exists for. A bill in your name proves you pay
    // for power at an address; it says nothing about who owns the land.
    for (const bad of ['electricity_bill', 'water_bill']) {
      expect(PROPERTY_DOC_TYPE_KEYS).not.toContain(bad);
      expect(SPOT_DOC_TYPES).not.toContain(bad);
      expect(OWNER_KYC_DOC_TYPES).not.toContain(bad);
      expect(frontendEntries().map((d) => d.key)).not.toContain(bad);
    }
  });

  test('the ownership documents a Bengaluru owner actually holds are accepted', () => {
    expect(PROPERTY_DOC_TYPE_KEYS).toEqual(expect.arrayContaining([
      'khata_certificate',
      'sale_deed',
      'partition_deed',
      'property_tax',
      'encumbrance_certificate',
      'bbmp_papers',
    ]));
  });

  test('everything offered except the rent agreement proves ownership', () => {
    // The screen tells the owner the document must be in their own name. That
    // sentence is only true if every chip but one is an ownership document.
    const notOwnership = PROPERTY_DOC_TYPES.filter((d) => d.proves !== 'ownership');
    expect(notOwnership.map((d) => d.key)).toEqual(['rent_agreement']);
  });

  test('a rent agreement is tenancy, not ownership', () => {
    const rent = PROPERTY_DOC_TYPES.find((d) => d.key === 'rent_agreement');
    expect(rent.proves).toBe('tenancy');
    expect(TENANCY_DOC_TYPE_KEYS).toEqual(['rent_agreement']);
  });

  test('nothing else is tenancy, so nothing else quietly needs an NOC', () => {
    const tenancy = PROPERTY_DOC_TYPES.filter((d) => d.proves === 'tenancy').map((d) => d.key);
    expect(tenancy).toEqual(TENANCY_DOC_TYPE_KEYS);
  });
});

describe('one list, not three', () => {
  test('the spot flow and the KYC flow accept exactly the same types', () => {
    expect(SPOT_DOC_TYPES).toEqual(PROPERTY_DOC_TYPE_KEYS);
    expect(OWNER_KYC_DOC_TYPES).toEqual(PROPERTY_DOC_TYPE_KEYS);
  });

  test("stage 3's tenant-consent rule is derived from it, not written out again", () => {
    expect(TENANT_DOC_TYPES).toEqual(TENANCY_DOC_TYPE_KEYS);
  });

  test('the app shows the same keys the server accepts, in the same order', () => {
    // Order matters because it is the order of the chips the owner taps.
    expect(frontendEntries().map((d) => d.key)).toEqual(PROPERTY_DOC_TYPE_KEYS);
  });

  test('the app shows the same labels and the same ownership/tenancy split', () => {
    expect(frontendEntries()).toEqual(
      PROPERTY_DOC_TYPES.map(({ key, label, proves }) => ({ key, label, proves }))
    );
  });
});

/**
 * What can carry ownership from a dead holder to the person in front of us.
 *
 * A reviewer picks from this list instead of writing a note, so the list is
 * the thing being asserted — an option the app offers that the server will
 * reject is a reviewer told their answer is invalid after they gave it.
 */
describe('the transfer documents behind a deceased holder', () => {
  test('the four agreed documents are the list', () => {
    expect(INHERITANCE_DOC_TYPE_KEYS).toEqual([
      'khata_transfer',
      'succession_certificate',
      'partition_deed',
      'probated_will',
    ]);
  });

  test('the app offers exactly what the server accepts, labels and all', () => {
    expect(frontendInheritance()).toEqual(
      INHERITANCE_DOC_TYPES.map(({ key, label }) => ({ key, label }))
    );
  });

  test('they are kept apart from the ownership documents', () => {
    // A partition deed is on BOTH lists, and means different things: proof of
    // ownership when the applicant is named on it, and proof of TRANSFER when
    // the holder on the ownership document is dead. The two lists are
    // validated by different fields, so the overlap is harmless — but nothing
    // else may cross over by accident.
    const overlap = INHERITANCE_DOC_TYPE_KEYS.filter((k) => PROPERTY_DOC_TYPE_KEYS.includes(k));
    expect(overlap).toEqual(['partition_deed']);
  });

  test('each has a label a reviewer can act on', () => {
    for (const t of INHERITANCE_DOC_TYPES) {
      expect(t.label.length).toBeGreaterThan(10);
      expect(t.label).not.toMatch(/_/);
    }
  });

  test('labelForDocType covers them too', () => {
    expect(labelForDocType('succession_certificate')).toBe('Succession certificate');
    expect(labelForDocType('probated_will')).toBe('Probated will');
  });
});

describe('a document stored under a type we no longer offer', () => {
  test('still reads as something rather than a blank', () => {
    // Nothing re-validates a stored row, so one of these may still be sitting
    // in production. An admin must be able to see what it was.
    expect(labelForDocType('electricity_bill')).toBe('electricity_bill');
    expect(labelForDocType('water_bill')).toBe('water_bill');
  });

  test('a current type reads as its label', () => {
    expect(labelForDocType('khata_certificate')).toBe('Khata certificate');
    expect(labelForDocType('encumbrance_certificate')).toBe('Encumbrance certificate');
  });

  test('nothing is null or empty', () => {
    expect(labelForDocType(null)).toBeNull();
    expect(labelForDocType(undefined)).toBeNull();
    expect(labelForDocType('')).toBeNull();
  });
});
