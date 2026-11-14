const express = require('express');
const multer = require('multer');
const { param, body } = require('express-validator');

const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validator');
const C = require('../controllers/spotVerificationController');
const { SPOT_DOC_TYPES, RELATIONSHIPS } = require('../constants/spotVerification');

const router = express.Router();

// Held in memory only long enough to send to Cloudinary, same as the
// per-person documents.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpe?g|png|webp)$/.test(file.mimetype)) {
      return cb(new Error('Only JPG, PNG or WebP images are allowed'));
    }
    cb(null, true);
  },
});
const single = (field) => (req, res, next) =>
  imageUpload.single(field)(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 8 MB).' : err.message,
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
