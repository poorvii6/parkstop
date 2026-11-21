/**
 * Unit tests for signedDocUrls — the admin document preview.
 *
 * THE BUG: `preview_url` carried no transformation. For a photo it was the
 * untouched original; for a PDF it was `pg_1` at the page's native resolution.
 * A document may be up to MAX_DOC_BYTES (15MB, routes/spotVerification.js) and
 * arrives straight off a phone camera at full sensor resolution — the picker
 * sets quality 0.8 but never resizes — and the upload applies no incoming
 * transformation. The admin screen then drew all of that into an <Image> 260pt
 * tall. That download is the several-second wait before a document appears.
 *
 * THE FIX: the preview is width-limited and quality-auto. `url` is untouched,
 * so "open full size" still gets the original.
 *
 * WHAT MUST NOT CHANGE: the preview is a private document. It stays on the
 * `authenticated` delivery type and stays signed. Cloudinary signs the
 * transformation as part of the URL, so a sized preview is a distinct signed
 * resource — its signature cannot be edited into a request for anything else.
 * The checks below are mostly about that, not about the sizing.
 *
 * Cloudinary is NOT mocked here: the point is the real URL the SDK builds.
 * It is configured with throwaway credentials, and nothing is fetched.
 * Runs with NO database.
 *   npx jest tests/unit/spotVerificationController.docPreview.test.js
 */

jest.mock('../../src/config/prisma', () => ({
  spot_verifications: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  parking_spots: { findUnique: jest.fn(), update: jest.fn() },
  users: { findMany: jest.fn() },
  $transaction: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../src/services/notificationService', () => ({
  sendPushNotification: jest.fn().mockResolvedValue(undefined),
}));

// Throwaway config, set before the controller is required. The real secret is
// never involved and no request is made — only URL construction is tested.
require('cloudinary').v2.config({
  cloud_name: 'test-cloud',
  api_key: '000000000000000',
  api_secret: 'test-secret-not-a-real-one',
});

const { signedDocUrls, PREVIEW_MAX_WIDTH } = require('../../src/controllers/spotVerificationController');

const ID = 'parkstop/spot-docs/abc123';
const SIGNATURE = /\/s--[^/]+--\//;
/** The transformation segment of a Cloudinary URL, if there is one. */
const transformOf = (url) => (url.match(/\/s--[^/]+--\/([^/]*)\/v1\//) || [])[1] || '';
const signatureOf = (url) => (url.match(/\/s--([^/]+)--\//) || [])[1];

describe('signedDocUrls', () => {
  it('returns nulls for a document that was never uploaded', () => {
    expect(signedDocUrls(null)).toEqual({ url: null, preview_url: null, format: null, is_pdf: false });
  });

  describe.each([
    ['photo', 'jpg', false],
    ['PDF', 'pdf', true],
  ])('%s', (_label, format, expectPdf) => {
    const r = () => signedDocUrls(ID, format);

    it('reports whether it is a PDF', () => {
      expect(r().is_pdf).toBe(expectPdf);
      expect(r().format).toBe(format);
    });

    /* ── privacy: the part that must never regress ──────────────── */

    it('delivers the preview over the authenticated type', () => {
      // NOT /image/upload/ — that would be world-readable to anyone with the
      // public_id, which is the whole reason these are uploaded authenticated.
      expect(r().preview_url).toContain('/image/authenticated/');
      expect(r().preview_url).not.toContain('/image/upload/');
    });

    it('signs the preview', () => {
      expect(r().preview_url).toMatch(SIGNATURE);
    });

    it('signs the original too, and over https', () => {
      expect(r().url).toMatch(SIGNATURE);
      expect(r().url).toContain('/image/authenticated/');
      expect(r().url.startsWith('https://')).toBe(true);
      expect(r().preview_url.startsWith('https://')).toBe(true);
    });

    it("gives the preview its own signature, not the original's", () => {
      // The signature covers the transformation. A reviewer who somehow
      // captured a preview URL cannot strip the w_1200 off it to get the
      // full-resolution original — the signature stops matching.
      expect(signatureOf(r().preview_url)).not.toBe(signatureOf(r().url));
    });

    /* ── the actual fix ────────────────────────────────────────── */

    it('width-limits the preview without upscaling a small scan', () => {
      const t = transformOf(r().preview_url);
      expect(t).toContain(`w_${PREVIEW_MAX_WIDTH}`);
      // c_limit, not c_scale/c_fill: a 400px scan is left at 400px rather
      // than being blown up, and nothing is cropped away from a document an
      // admin has to read.
      expect(t).toContain('c_limit');
    });

    it('lets Cloudinary pick the compression', () => {
      expect(transformOf(r().preview_url)).toContain('q_auto');
    });

    it('leaves the original untransformed, so "full size" means full size', () => {
      expect(transformOf(r().url)).toBe('');
    });
  });

  describe('PDF specifics', () => {
    const r = () => signedDocUrls(ID, 'pdf');

    it('still rasterises page 1 to a jpg for the inline <Image>', () => {
      // React Native's <Image> cannot draw a PDF, so this conversion is load
      // bearing, not an optimisation. The sizing must not have displaced it.
      expect(transformOf(r().preview_url)).toContain('pg_1');
      expect(r().preview_url.endsWith('.jpg')).toBe(true);
    });

    it('keeps the original as the pdf', () => {
      expect(r().url.endsWith('.pdf')).toBe(true);
    });

    it('does not ask for f_auto on the page raster', () => {
      // The explicit .jpg is the point on this branch; f_auto alongside an
      // explicit format is a contradiction.
      expect(transformOf(r().preview_url)).not.toContain('f_auto');
    });
  });

  describe('photo specifics', () => {
    it('allows a modern format where the client takes one', () => {
      expect(transformOf(signedDocUrls(ID, 'jpg').preview_url)).toContain('f_auto');
    });

    it('treats an unknown format as a photo rather than a PDF', () => {
      expect(signedDocUrls(ID, undefined).is_pdf).toBe(false);
      expect(signedDocUrls(ID, 'PNG').is_pdf).toBe(false);
    });

    it('is case insensitive about pdf', () => {
      expect(signedDocUrls(ID, 'PDF').is_pdf).toBe(true);
    });
  });
});
