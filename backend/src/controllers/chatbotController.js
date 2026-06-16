const logger = require('../utils/logger');

class ChatbotController {
  
  static async askQuestion(req, res) {
    try {
      const { prompt } = req.body;
      const role = req.user.role; // 'finder' or 'spotter'
      const userName = req.user.full_name || 'User';

      if (!prompt) {
        return res.status(400).json({ success: false, message: 'Please provide a prompt' });
      }

      // 🧠 Keyword Help Bot Engine
      const input = prompt.toLowerCase();
      let reply = '';
      let action = null;

      if (role === 'spotter') {
        if (input.includes('fee') || input.includes('platform') || input.includes('cut') || input.includes('percentage')) {
          reply = `Hello ${userName}. The platform fee is 15%. This means you keep 85% of all earnings generated from your parking spot. It will be automatically deducted when you complete a booking.`;
        } else if (input.includes('otp') || input.includes('verify') || input.includes('arrive')) {
          reply = `When a Finder arrives, ask them for their 6-digit OTP code, then use the Verify OTP feature in the app to activate the booking!`;
        } else if (input.includes('complete') || input.includes('leave') || input.includes('end')) {
          reply = `When the vehicle leaves your parking spot, simply tap the "Complete Booking" button. The system will calculate how long they stayed from start to finish and pay you for the exact duration.`;
        } else if (input.includes('analytics') || input.includes('earnings') || input.includes('money')) {
          reply = `You can view your detailed earnings by visiting your Analytics Dashboard. It provides a breakdown of your revenue per spot!`;
        } else {
          reply = `Hi ${userName}, I'm your Spotter Keyword Help Bot. I answer queries based on keywords. You can ask me about Platform Fees ('fee'), OTP verification ('otp'), or completing a booking ('complete'). How can I help you today?`;
        }

      } else {
        // Finder Intents
        if (input.includes('yes') || input.includes('route') || input.includes('go') || input.includes('sure') || input.includes('ok')) {
          reply = "Understood. Rerouting to the alternative spot 0.2 miles away. Closing help chat...";
          action = 'ROUTE_TO_SPOT';
        } else if (input.includes('no') || input.includes('cancel') || input.includes('stop')) {
          reply = "Understood. Search paused. Let me know if you'd like to look for other spots.";
        } else if (input.includes('where') || input.includes('far') || input.includes('distance')) {
          reply = "The alternative spot is just 0.2 miles away from your original destination, which is roughly a 2-minute drive. Should I route you there?";
        } else if (input.includes('price') || input.includes('cost') || input.includes('much')) {
          reply = "The rate for this premium spot is $5.00 per hour. Would you like me to secure it and route you there?";
        } else if (input.includes('hi') || input.includes('hello')) {
          reply = "Hello! I am your Keyword Help Bot. You can ask me about routing/distance ('where'), prices ('price'), or extending reservations ('extend').";
        } else if (input.includes('extend') || input.includes('late')) {
          reply = `Running late? No problem, ${userName}! You can extend your booking seamlessly. Just use the 'Extend Booking' option on your active reservation to buy more time.`;
        } else {
          reply = `I am a Keyword Help Bot and can answer specific queries. For parking navigation, say 'yes' to route, or ask about the 'price' or 'distance'.`;
        }
      }

      // Simulate a small "typing/thinking" delay to make it feel human
      setTimeout(() => {
        res.json({
          success: true,
          data: {
            bot_type: 'keyword_help_bot',
            role_context: role,
            reply: reply,
            action: action
          }
        });
      }, 500);

    } catch (error) {
      logger.error('Chatbot error:', error);
      res.status(500).json({
        success: false,
        message: 'Smart Assistant failed to respond',
        error: error.message
      });
    }
  }
}

module.exports = ChatbotController;
