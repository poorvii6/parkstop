const express = require('express');
const { body } = require('express-validator');
const ChatbotController = require('../controllers/chatbotController');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validator');

const router = express.Router();

/**
 * 🤖 AI Agent - Ask Question
 */
router.post(
  '/ask',
  authenticate,
  [
    body('prompt').isString().notEmpty().withMessage('Prompt is required'),
    validate
  ],
  ChatbotController.askQuestion
);

module.exports = router;
