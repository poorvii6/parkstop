const express = require('express');
const multer = require('multer');
const { authenticate, authorize } = require('../middleware/auth');
const C = require('../controllers/ownerVerificationController');

const router = express.Router();

// Images are held in memory only long enough to send to Cashfree / Cloudinary.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpe?g|png|webp)$/.test(file.mimetype)) return cb(new Error('Only JPG, PNG or WebP images are allowed'));
    cb(null, true);
  },
});
const single = (field) => (req, res, next) =>
  imageUpload.single(field)(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 8 MB).' : err.message });
    next();
  });

// Public: the page DigiLocker redirects back to (no data on it).
router.get('/aadhaar/return', C.aadhaarReturnPage);

// Owner
router.get('/', authenticate, authorize('SPOTTER'), C.getStatus);
router.post('/aadhaar/start', authenticate, authorize('SPOTTER'), C.startAadhaar);
router.post('/aadhaar/complete', authenticate, authorize('SPOTTER'), C.completeAadhaar);
router.post('/pan', authenticate, authorize('SPOTTER'), C.verifyPan);
router.post('/selfie', authenticate, authorize('SPOTTER'), single('image'), C.verifySelfie);
router.post('/bank', authenticate, authorize('SPOTTER'), C.verifyBank);
router.post('/property', authenticate, authorize('SPOTTER'), single('document'), C.uploadProperty);
router.post('/submit', authenticate, authorize('SPOTTER'), C.submit);

// Admin
router.get('/admin/list', authenticate, authorize('ADMIN'), C.adminList);
router.get('/admin/:userId', authenticate, authorize('ADMIN'), C.adminDetail);
router.post('/admin/:userId/approve', authenticate, authorize('ADMIN'), C.adminApprove);
router.post('/admin/:userId/reject', authenticate, authorize('ADMIN'), C.adminReject);

module.exports = router;
