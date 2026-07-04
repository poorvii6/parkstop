const logger = require('../utils/logger');

class ChatbotController {

  static async askQuestion(req, res) {
    try {
      const { prompt } = req.body;
      const role = req.user.role;
      const userName = req.user.full_name || req.user.name || 'User';

      if (!prompt) {
        return res.status(400).json({ success: false, message: 'Please provide a prompt' });
      }

      const systemPrompt = role.toLowerCase() === 'spotter'
        ? `You are ParkStop's helpful assistant for Spotters (parking space owners) in India.
           Help them with: listing spots, understanding earnings (platform takes 15-30% commission based on location type), 
           OTP verification process, payout setup via UPI or bank, managing bookings, and app features.
           Be concise, friendly, and India-aware (use ₹ for currency). Max 2-3 sentences per reply.`
        : `You are ParkStop's helpful assistant for Finders (drivers looking for parking) in India.
           Help them with: finding spots on the map, booking process, OTP check-in, payment (Razorpay UPI/card or cash), 
           extending bookings, cancellation policy, and navigating to spots.
           Be concise, friendly, and India-aware (use ₹ for currency). Max 2-3 sentences per reply.`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }]
        })
      });

      if (!response.ok) {
        throw new Error('AI service unavailable');
      }

      const data = await response.json();
      const reply = data.content?.[0]?.text || 'I could not process that. Please try again.';

      res.json({
        success: true,
        data: { reply, role_context: role }
      });

    } catch (error) {
      logger.error('Chatbot error:', error);
      // Graceful fallback so the app doesn't break
      res.json({
        success: true,
        data: {
          reply: 'I am having trouble connecting right now. Please check the Help section or contact support.',
          role_context: req.user?.role
        }
      });
    }
  }
}

module.exports = ChatbotController;
