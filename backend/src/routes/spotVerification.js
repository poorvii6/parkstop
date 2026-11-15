const express = require('express');
const multer = require('multer');
const { param, body } = require('express-validator');

const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');
const C = require('../controllers/spotVerificationController');
const { SPOT_DOC_TYPES, RELATIONSHIPS } = require('../constants/spotVerification');

const router = express.Router();

/**
 * Held in memory only long enough to send to Cloudinary, same as the
 * per-person documents. Nothing is ever written to disk.
 *
 * PDFs ARE ACCEPTED, and that is not a convenience. A khata certificate,
 * encumbrance certificate or BBMP tax receipt comes off the Karnataka portals
 * as a PDF. While only images were allowed, every honest owner had to
 * screenshot one — and a screenshot is different bytes every single time, so
 * doc_sha256 matched nothing and the duplicate-document check was defeated by
 * the normal path rather than by anyone attacking it. A re-downloaded PDF is
 * far more likely to be byte-identical. It is also simply easier for an admin
 * to read a name off.
 *
 * 15 MB because a multi-page scanned deed is bigger than a photo, and a
 * refusal at the upload step is the one failure an owner cannot work around.
 */
const DOC_MIME = /^(image\/(jpe?g|png|webp)|application\/pdf)$/;
const MAX_DOC_BYTES = 15 * 1024 * 1024;

const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOC_BYTES },
  fileFilter: (req, file, cb) => {
    if (!DOC_MIME.test(file.mimetype)) {
      return cb(new Error('Please upload a PDF, or a JPG, PNG or WebP photo.'));
    }
    cb(null, true);
  },
});
const single = (field) => (req, res, next) =>
  docUpload.single(field)(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is too large (max 15 MB).'
          : err.message,
      });
    }
    next();
  });

const spotId = () => param('spotId').isInt().withMessage('Spot id must be a number');

/**
 * ADMIN — the queue and the backlog.
 *
 * Declared before `/:spotId` so "queue" and "backlog" are not read as spot ids.
 */
router.get('/admin/queue', authenticate, authorize('ADMIN'), C.adminQueue);
router.get('/admin/backlog', authenticate, authorize('ADMIN'), C.adminBacklog);
router.get('/admin/:spotId', authenticate, authorize('ADMIN'), [spotId(), validate], C.adminDetail);

/**
 * ADMIN — the desk review.
 *
 * `check` runs the two checks and stores what they found, deciding nothing. A
 * POST because it costs an external geocode and writes to the row.
 */
router.post(
  '/admin/:spotId/check',
  authenticate,
  authorize('ADMIN'),
  [
    spotId(),
    body('name_on_document')
      .optional()
      .isString().withMessage('The name must be text')
      .trim()
      .isLength({ max: 150 }).withMessage('The name must be 150 characters or fewer'),
    body('noc_names_owner')
      .optional()
      .isBoolean({ strict: true }).withMessage('noc_names_owner must be true or false'),
    validate,
  ],
  C.adminCheck
);

router.post(
  '/admin/:spotId/desk',
  authenticate,
  authorize('ADMIN'),
  [
    spotId(),
    body('decision')
      .isIn(['pass', 'reject'])
      .withMessage('Decision must be pass or reject'),
    body('name_on_document')
      .optional()
      .isString().withMessage('The name must be text')
      .trim()
      .isLength({ min: 2, max: 150 }).withMessage('The name must be 2 to 150 characters'),
    /**
     * For a rented spot: the admin has read the consent letter and confirms it
     * names this owner. Strict, like record_found on the field route — "does
     * the letter name them?" has two answers and no default, and a missing
     * field must not read as yes.
     */
    body('noc_names_owner')
      .optional()
      .isBoolean({ strict: true }).withMessage('noc_names_owner must be true or false'),
    // Both are free text an owner or an auditor will read, so they are bounded
    // but not otherwise shaped.
    body('reason')
      .optional()
      .isString().withMessage('The reason must be text')
      .trim()
      .isLength({ max: 500 }).withMessage('The reason must be 500 characters or fewer'),
    body('override_reason')
      .optional()
      .isString().withMessage('The override reason must be text')
      .trim()
      .isLength({ max: 500 }).withMessage('The override reason must be 500 characters or fewer'),
    validate,
  ],
  C.adminDeskDecision
);

/**
 * ADMIN — the field check, and the only route that can make a spot live.
 *
 * `record_found` is validated as a real boolean rather than coerced: "was the
 * record there?" has two answers and no default, and a missing field must not
 * read as either.
 */
router.post(
  '/admin/:spotId/field',
  authenticate,
  authorize('ADMIN'),
  [
    spotId(),
    body('record_found')
      .isBoolean({ strict: true })
      .withMessage('record_found must be true or false'),
    body('office')
      .isString().withMessage('The office must be text')
      .trim()
      .isLength({ min: 3, max: 120 }).withMessage('Record which office was checked (3 to 120 characters)'),
    body('reference')
      .optional()
      .isString().withMessage('The reference must be text')
      .trim()
      .isLength({ max: 100 }).withMessage('The reference must be 100 characters or fewer'),
    body('notes')
      .optional()
      .isString().withMessage('The notes must be text')
      .trim()
      .isLength({ max: 1000 }).withMessage('The notes must be 1000 characters or fewer'),
    body('reason')
      .optional()
      .isString().withMessage('The reason must be text')
      .trim()
      .isLength({ max: 500 }).withMessage('The reason must be 500 characters or fewer'),
    validate,
  ],
  C.adminFieldDecision
);

/**
 * OWNER — submit a document for one spot, and see where it stands.
 *
 * Body validators as on the spot write path: anything present must be the
 * right shape, and the field that was wrong is named. The controller checks
 * them again, because it is reachable from the tests and from stages 2 and 3.
 */
router.post(
  '/:spotId/document',
  authenticate,
  authorize('SPOTTER', 'ADMIN'),
  single('document'),
  [
    spotId(),
    body('doc_type')
      .isIn(SPOT_DOC_TYPES)
      .withMessage(`Document type must be one of: ${SPOT_DOC_TYPES.join(', ')}`),
    body('address')
      .isString().withMessage('Address must be text')
      .trim()
      .isLength({ min: 10, max: 300 })
      .withMessage('Enter the full address printed on the document (10 to 300 characters)'),
    body('relationship')
      .optional()
      .isIn(Object.values(RELATIONSHIPS))
      .withMessage('Relationship must be owner or tenant'),
    validate,
  ],
  C.uploadDocument
);

/**
 * The landlord's no-objection letter, for a rented spot. A separate upload,
 * because it is a separate document about a different person.
 */
router.post(
  '/:spotId/landlord-noc',
  authenticate,
  authorize('SPOTTER', 'ADMIN'),
  single('document'),
  [
    spotId(),
    body('landlord_name')
      .isString().withMessage("The landlord's name must be text")
      .trim()
      .isLength({ min: 2, max: 150 })
      .withMessage("Enter the landlord's name (2 to 150 characters)"),
    validate,
  ],
  C.uploadLandlordNoc
);

router.post(
  '/:spotId/submit',
  authenticate,
  authorize('SPOTTER', 'ADMIN'),
  [spotId(), validate],
  C.submit
);

router.get(
  '/:spotId',
  authenticate,
  authorize('SPOTTER', 'ADMIN'),
  [spotId(), validate],
  C.getOne
);

module.exports = router;
