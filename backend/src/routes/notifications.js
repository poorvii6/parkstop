const express = require('express');
const NotificationController = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// In-app notification history
router.get('/', authenticate, NotificationController.list);
router.post('/read', authenticate, NotificationController.markRead);

// Quiet-hours preferences
router.get('/preferences', authenticate, NotificationController.getPreferences);
router.put('/preferences', authenticate, NotificationController.updatePreferences);

module.exports = router;
