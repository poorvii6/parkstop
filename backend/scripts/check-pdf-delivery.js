#!/usr/bin/env node
/**
 * Does this Cloudinary account actually DELIVER a private PDF?
 *
 *   cd backend && node scripts/check-pdf-delivery.js
 *
 * WHY THIS SCRIPT EXISTS. Owners submit khata certificates, encumbrance
 * certificates and BBMP receipts as PDFs, and the admin review screen shows
 * them through a signed, authenticated URL. But Cloudinary ships with "PDF and
 * ZIP files delivery" TURNED OFF on accounts created after early 2021 — a
 * security setting, because a PDF can carry active content. With it off the
 * UPLOAD still succeeds and only the DELIVERY 403s, so nothing fails until an
 * admin opens a real submission in production and sees nothing.
 *
 * Every test in this repo mocks Cloudinary, which is correct — a test suite
 * must not depend on an external account — but it means NOTHING here proves
 * delivery works. This does, by doing the real thing once.
 *
 * WHAT IT DOES, in order:
 *   1. builds a tiny valid one-page PDF in memory
 *   2. uploads it privately (type: authenticated), exactly as a real
 *      submission is uploaded
 *   3. fetches the signed PDF URL and the signed page-1 JPEG preview
 *   4. reports the HTTP status of each
 *   5. DELETES the upload, whatever happened
 *
 * It writes one throwaway asset to parkstop/_delivery-check and removes it. It
 * reads no owner data and prints no credentials.
 *
 * IF IT REPORTS 401/403: open the Cloudinary Console > Settings > Security and
 * tick "PDF and ZIP files delivery", then run this again. There is no API for
 * that setting, which is why a human has to do it once.
 */
require('dotenv').config();

const cloudinary = require('cloudinary').v2;

const FOLDER = 'parkstop/_delivery-check';

/**
 * A minimal, VALID one-page PDF, with a correct xref table.
 *
 * Built rather than committed, so no binary fixture lives in the repo — and
 * the offsets are computed because Cloudinary rasterises with Ghostscript,
 * which is stricter about a broken xref than a desktop PDF reader is.
 */
function tinyPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] '
      + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null, // the content stream, built below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const text = 'BT /F1 12 Tf 18 60 Td (ParkStop delivery check) Tj ET';
  objects[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefAt}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** HEAD the URL and report what came back, without following into a body. */
async function statusOf(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    return { status: res.status, type: res.headers.get('content-type') || '' };
  } catch (err) {
    return { status: 0, type: '', error: err.message };
  }
}

(async () => {
  const { CLOUDINARY_CLOUD_NAME: cloud, CLOUDINARY_API_KEY: key, CLOUDINARY_API_SECRET: secret } = process.env;

  if (!cloud || !key || !secret) {
    console.error('✗ Cloudinary is not configured in this environment.');
    console.error('  Needs CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.');
    console.error('  These live in Railway variables — run this where they are set,');
    console.error('  or copy them into backend/.env locally. Do not paste them anywhere else.');
    process.exit(2);
  }

  cloudinary.config({ cloud_name: cloud, api_key: key, api_secret: secret });
  // The cloud name is not a secret and identifies which account was checked.
  console.log(`Cloudinary account: ${cloud}\n`);

  let publicId = null;
  try {
    console.log('1. Uploading a tiny private PDF (type: authenticated)…');
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: FOLDER, type: 'authenticated', resource_type: 'image', format: 'pdf' },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      stream.end(tinyPdf());
    });
    publicId = uploaded.public_id;
    console.log(`   uploaded. format=${uploaded.format} pages=${uploaded.pages ?? 'n/a'}`);
    if (uploaded.format !== 'pdf') {
      console.log('   ⚠️  Cloudinary did not record this as a PDF, which means the upload');
      console.log('       path is wrong rather than the delivery setting.');
    }

    // Exactly the two URLs signedDocUrls builds for the admin screen.
    const base = { type: 'authenticated', resource_type: 'image', sign_url: true, secure: true };
    const fileUrl = cloudinary.url(publicId, { ...base, format: 'pdf' });
    const previewUrl = cloudinary.url(publicId, { ...base, format: 'jpg', page: 1 });

    console.log('\n2. Fetching the signed PDF URL (what "open the document" uses)…');
    const file = await statusOf(fileUrl);
    console.log(`   HTTP ${file.status} ${file.type}`);

    console.log('\n3. Fetching the signed page-1 JPEG (what the screen shows inline)…');
    const preview = await statusOf(previewUrl);
    console.log(`   HTTP ${preview.status} ${preview.type}`);

    const ok = file.status === 200 && preview.status === 200;
    console.log(`\n${'─'.repeat(64)}`);
    if (ok) {
      console.log('✓ PDF DELIVERY WORKS on this account.');
      console.log('  Both the signed PDF and the rasterised page-1 preview returned 200.');
      console.log('  An admin opening a PDF submission will see it.');
    } else if ([401, 403].includes(file.status) || [401, 403].includes(preview.status)) {
      console.log('✗ PDF DELIVERY IS BLOCKED on this account.');
      console.log('  The upload succeeded and the delivery was refused, which is the');
      console.log('  default for newer Cloudinary accounts.');
      console.log('\n  FIX (once, by hand — there is no API for it):');
      console.log('    Cloudinary Console > Settings > Security');
      console.log('    > tick "PDF and ZIP files delivery" > Save');
      console.log('  Then run this script again.');
    } else {
      console.log('? INCONCLUSIVE — neither a clean 200 nor a clean 403.');
      console.log(`  PDF: ${file.status}${file.error ? ` (${file.error})` : ''}`);
      console.log(`  Preview: ${preview.status}${preview.error ? ` (${preview.error})` : ''}`);
      console.log('  A 404 usually means the upload did not land; a 0 means this machine');
      console.log('  could not reach Cloudinary at all.');
    }
    console.log('─'.repeat(64));
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error(`\n✗ Could not complete the check: ${err.message}`);
    process.exitCode = 2;
  } finally {
    // Always clean up. This asset has no purpose beyond the check above.
    if (publicId) {
      try {
        await cloudinary.uploader.destroy(publicId, { type: 'authenticated', resource_type: 'image' });
        console.log(`\nCleaned up: removed ${publicId}`);
      } catch (err) {
        console.error(`\n⚠️  Could not delete the test upload ${publicId}: ${err.message}`);
        console.error('   Remove it by hand from the Media Library if it is still there.');
      }
    }
  }
})();
