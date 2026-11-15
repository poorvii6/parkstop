#!/usr/bin/env node
/**
 * The grandfathered spots, and what will stop each one passing. READ ONLY.
 *
 *   cd backend && node scripts/grandfathered-report.js            # local
 *   railway run node backend/scripts/grandfathered-report.js      # production
 *
 * Grandfathered spots were already live in the finder when per-spot
 * verification shipped. Writing `approved` on them would have recorded a check
 * nobody performed, so they keep their own status: visible, honestly labelled
 * as unchecked, and deliberately OFF the 48-hour clock, because nobody
 * promised them 48 hours.
 *
 * They are the backlog. This prints the surprises in advance rather than one
 * spot at a time — for each one: who owns it, what they have submitted, what
 * is missing, and every reason it will fail if it is pushed through as it
 * stands.
 *
 * It WRITES NOTHING. No requireLocalDb guard, because there is nothing to
 * guard; it is safe against production by construction. Every number comes
 * from SpotVerificationPolicy, so it cannot disagree with what the queue and
 * the owner's screen say.
 */
const prisma = require('../src/config/prisma');
const Policy = require('../src/services/SpotVerificationPolicy');
const { labelForDocType } = require('../src/constants/propertyDocTypes');
const { resolveDatabaseUrl } = require('./lib/require-local-db');

function target() {
  try {
    const u = new URL(resolveDatabaseUrl());
    return `${u.hostname}:${u.port || 5432}/${u.pathname.slice(1)}`;
  } catch {
    return '(unknown)';
  }
}

/**
 * Everything that will stop this spot reaching `approved`, in the order the
 * flow hits it. Derived from the record, never from a status alone.
 */
function blockers({ record, spot, owner, duplicateOf }) {
  const out = [];

  // 1. What the OWNER still has to supply, from the one function `submit`
  //    refuses with.
  for (const gap of Policy.submissionGaps(record, spot)) {
    out.push({ who: 'owner', what: gap.message });
  }

  // 2. A place is verified in a PERSON's name. No verified person, no name to
  //    compare the document against — and this one does not yield to an
  //    override.
  if (owner?.verification_status !== 'approved') {
    out.push({
      who: 'us',
      what: `The owner is not verified (${owner?.verification_status || 'not started'}). `
        + 'The desk review refuses this and there is no override.',
      hard: true,
    });
  } else if (!owner?.aadhaar_name) {
    out.push({
      who: 'us',
      what: 'The owner is approved but has no Aadhaar name stored, so there is nothing '
        + 'to compare the document against.',
      hard: true,
    });
  }

  // 3. A tenant needs the landlord's consent AND an admin confirming the
  //    letter names them. The second is not visible until review.
  if (Policy.isTenantSubmission(record)) {
    out.push({
      who: 'us',
      what: 'Rented. At the desk review the document is compared to the LANDLORD\'s name, '
        + 'and you must confirm the consent letter names this owner.',
    });
  }

  // 4. The same file already verifying somewhere else.
  if (duplicateOf?.length) {
    out.push({
      who: 'us',
      what: `The same document is on spot(s) ${duplicateOf.map((d) => d.spot_id).join(', ')}. `
        + 'Same address is fine (several bays); a different address is refused.',
    });
  }

  // 5. A document naming a dead holder needs a named transfer document. Only
  //    readable by eye, so it is a warning rather than a finding.
  if (record.name_on_document && /\b(LATE|LT)\b/i.test(record.name_on_document)) {
    out.push({
      who: 'us',
      what: 'The recorded name begins LATE — a deceased holder. Needs a named transfer '
        + 'document (khata transfer, succession certificate, partition deed, probated will).',
    });
  }

  return out;
}

(async () => {
  console.log(`Database: ${target()}  — READ ONLY, nothing is written.\n`);

  const rows = await prisma.spot_verifications.findMany({
    where: { grandfathered_at: { not: null } },
    orderBy: { spot_id: 'asc' },
    include: {
      parking_spots: {
        select: {
          id: true, title: true, address: true, latitude: true, longitude: true,
          created_at: true, is_active: true, spot_verification_status: true,
          users: {
            select: {
              id: true, full_name: true, name: true, email: true, phone: true,
              verification_status: true,
              owner_verification: { select: { aadhaar_name: true } },
            },
          },
        },
      },
    },
  });

  if (!rows.length) {
    console.log('No grandfathered spots. The backlog is empty.');
    await prisma.$disconnect();
    return;
  }

  // Same-file reuse across the whole set, in one query rather than per row.
  const hashes = rows.map((r) => r.doc_sha256).filter(Boolean);
  const sharing = hashes.length
    ? await prisma.spot_verifications.findMany({
      where: { doc_sha256: { in: hashes } },
      select: { spot_id: true, doc_sha256: true, claimed_address: true },
    })
    : [];

  console.log(`${rows.length} grandfathered spot(s). All are VISIBLE to drivers and unchecked.\n`);

  let ready = 0;
  for (const r of rows) {
    const spot = r.parking_spots;
    const u = spot?.users;
    const owner = u ? { ...u, aadhaar_name: u.owner_verification?.aadhaar_name || null } : null;
    const duplicateOf = sharing.filter((s) => s.doc_sha256 === r.doc_sha256 && s.spot_id !== r.spot_id);
    const found = blockers({ record: r, spot, owner, duplicateOf });
    if (!found.length) ready += 1;

    console.log('─'.repeat(74));
    console.log(`SPOT #${r.spot_id}  ${spot?.title || '(untitled)'}`);
    console.log(`  owner        ${owner?.full_name || owner?.name || '(unknown)'}  <${owner?.email || '?'}>`
      + `${owner?.phone ? `  ${owner.phone}` : ''}`);
    console.log(`  person check ${owner?.verification_status || 'not started'}`
      + `${owner?.aadhaar_name ? `  (Aadhaar name: ${owner.aadhaar_name})` : '  (no Aadhaar name)'}`);
    console.log(`  listed       ${spot?.created_at ? new Date(spot.created_at).toISOString().slice(0, 10) : '?'}`
      + `   active: ${spot?.is_active}   drivers see: ${spot?.spot_verification_status}`);
    console.log(`  listing addr ${spot?.address || '(none)'}`);
    console.log(`  pin          ${spot?.latitude ?? '—'}, ${spot?.longitude ?? '—'}`);
    console.log('');
    console.log(`  holds it as  ${r.relationship ? (r.relationship === 'tenant' ? 'TENANT (rented)' : 'owner-occupied') : '(not stated yet)'}`);
    console.log(`  document     ${r.doc_public_id ? (labelForDocType(r.doc_type) || r.doc_type) : 'NONE UPLOADED'}`
      + `${r.doc_format ? ` (${r.doc_format})` : ''}`);
    console.log(`  claimed addr ${r.claimed_address || '(none given)'}`);
    if (r.relationship === 'tenant' || r.landlord_name || r.landlord_noc_public_id) {
      console.log(`  landlord     ${r.landlord_name || '(no name)'}`
        + `   letter: ${r.landlord_noc_public_id ? 'uploaded' : 'MISSING'}`);
    }
    console.log(`  status       ${r.status}   submitted: ${r.submitted_at ? new Date(r.submitted_at).toISOString() : 'never'}`);
    if (r.rejection_reason) console.log(`  last reason  ${r.rejection_reason}`);

    console.log('');
    if (!found.length) {
      console.log('  ✓ Nothing known will stop this one. It still needs a desk review and a');
      console.log('    field visit — those are judgements, not data.');
    } else {
      console.log(`  WILL NOT PASS AS IT STANDS (${found.length}):`);
      for (const b of found) {
        const tag = b.hard ? 'HARD ' : b.who === 'owner' ? 'OWNER' : 'US   ';
        console.log(`    [${tag}] ${b.what}`);
      }
    }
    console.log('');
  }

  console.log('─'.repeat(74));
  console.log('SUMMARY');
  console.log(`  ${rows.length} grandfathered, ${ready} with no known blocker, ${rows.length - ready} with at least one.`);
  console.log('  OWNER = you have to go back to them for something.');
  console.log('  US    = something for the reviewer to do or confirm.');
  console.log('  HARD  = no override exists; it cannot pass until it is fixed.');
  console.log('');
  console.log('  Nothing here has been changed. Work them through the admin queue:');
  console.log('  Admin home > Spot verifications > Backlog.');

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('\nReport failed:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});
