const User = require('../models/User');
const logger = require('../utils/logger');
const prisma = require('../config/prisma');
const admin = require('../config/firebase');

class AuthController {

  /**
   * SEND OTP
   */
  static async sendOTP(req, res) {
    try {
      const { email } = req.body;
      const { generateOTP, sendEmailOTP } = require('../services/otpService');

      const code = generateOTP(email);
      await sendEmailOTP(email, code);

      return res.status(200).json({
        success: true,
        message: 'Verification OTP code sent to Gmail successfully'
      });
    } catch (err) {
      logger.error('Error sending email OTP:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP verification email'
      });
    }
  }

  /**
   * VERIFY OTP
   */
  static async verifyOTP(req, res) {
    try {
      const { email, code } = req.body;
      const { verifyOTP, generateOTPToken } = require('../services/otpService');

      const isValid = verifyOTP(email, code);
      if (!isValid) {
        return res.status(400).json({
          success: false,
          message: 'Invalid or expired Gmail OTP verification code'
        });
      }

      const otpToken = generateOTPToken(email);

      return res.status(200).json({
        success: true,
        message: 'Gmail verified successfully',
        otp_token: otpToken
      });
    } catch (err) {
      logger.error('Error verifying email OTP:', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to verify Gmail OTP code'
      });
    }
  }

  /**
   * REGISTER
   */
  static async register(req, res) {
    try {
      const { email, name, phone, role, firebase_token, otp_token } = req.body;

      // Verify Gmail OTP Token (unless running automated test suites)
      const isTest = process.env.NODE_ENV === 'test' || process.env.IGNORE_RATE_LIMITS === 'true';
      if (!isTest) {
        const { validateOTPToken } = require('../services/otpService');
        if (!otp_token || !validateOTPToken(email, otp_token)) {
          return res.status(400).json({
            success: false,
            message: 'Gmail email address verification is required. Invalid or expired OTP token.'
          });
        }
      }

      const normalizedRole = role ? role.toUpperCase() : '';
      if (!['FINDER', 'SPOTTER'].includes(normalizedRole)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role'
        });
      }

      let firebaseUid;
      let regEmail = email;
      let regName = name || (email ? email.split('@')[0] : '');

      if (!firebase_token && isTest) {
        firebaseUid = `mock_uid_${email.replace(/[@.]/g, '_')}`;
      } else {
        if (!firebase_token) {
          return res.status(400).json({
            success: false,
            message: 'Firebase authentication token is required'
          });
        }

        let decoded;
        try {
          decoded = await admin.auth.verifyIdToken(firebase_token);
        } catch (tokenErr) {
          logger.error('Firebase token verification failed in register:', tokenErr);
          return res.status(400).json({
            success: false,
            message: 'Invalid Firebase authentication token'
          });
        }

        firebaseUid = decoded.uid;
        regEmail = decoded.email || email;
        regName = decoded.name || name || regEmail.split('@')[0];
      }

      if (!regEmail) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      const existing = await prisma.users.findFirst({
        where: {
          OR: [
            { firebase_uid: firebaseUid },
            { email: regEmail }
          ]
        }
      });

      if (existing) {
        // Build the update data for existing user
        const updateData = {};
        if (!existing.firebase_uid) {
          updateData.firebase_uid = firebaseUid;
        }

        // If registering with a different role, update role and flags
        if (normalizedRole !== existing.role) {
          updateData.role = normalizedRole;
          if (normalizedRole === 'FINDER') {
            updateData.is_finder_registered = true;
          } else if (normalizedRole === 'SPOTTER') {
            updateData.is_spotter_registered = true;
          }
        }

        let finalUser = existing;
        if (Object.keys(updateData).length > 0) {
          finalUser = await prisma.users.update({
            where: { id: existing.id },
            data: updateData,
            select: {
              id: true,
              email: true,
              full_name: true,
              phone: true,
              role: true,
              created_at: true,
              firebase_uid: true,
              is_finder_registered: true,
              is_spotter_registered: true
            }
          });
        }

        return res.status(200).json({
          success: true,
          message: 'User registered successfully',
          data: {
            user: { ...finalUser, name: finalUser.full_name }
          }
        });
      }

      const user = await prisma.users.create({
        data: {
          email: regEmail,
          full_name: regName,
          name: regName,
          phone: phone || '',
          role: normalizedRole,
          firebase_uid: firebaseUid,
          is_finder_registered: normalizedRole === 'FINDER',
          is_spotter_registered: normalizedRole === 'SPOTTER'
        },
        select: {
          id: true,
          email: true,
          full_name: true,
          phone: true,
          role: true,
          created_at: true,
          firebase_uid: true,
          is_finder_registered: true,
          is_spotter_registered: true
        }
      });

      res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: {
          user: { ...user, name: user.full_name }
        }
      });

    } catch (error) {
      logger.error('Register error:', error);
      res.status(500).json({
        success: false,
        message: 'Error registering user: ' + error.message
      });
    }
  }

  /**
   * 🔑 LOGIN (E2E Test / Mock login fallback)
   */
  static async login(req, res) {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
      }

      const user = await prisma.users.findUnique({
        where: { email: email.toLowerCase() }
      });

      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid email or password'
        });
      }

      const jwt = require('jsonwebtoken');
      const token = jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          name: user.full_name || user.name,
          firebase_uid: user.firebase_uid || `mock_uid_${user.email.replace(/[@.]/g, '_')}`
        },
        process.env.JWT_SECRET || 'jwt_default_secret_key',
        { expiresIn: '24h' }
      );

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        data: {
          user: { ...user, name: user.full_name },
          access_token: token,
          refresh_token: 'mock_refresh_token'
        }
      });
    } catch (error) {
      logger.error('Mock login error:', error);
      return res.status(500).json({
        success: false,
        message: 'Login failed: ' + error.message
      });
    }
  }

  /**
   * 🌐 SOCIAL LOGIN / PROFILE SYNC
   */
  static async socialLogin(req, res) {
    try {
      const { email, name, token, role } = req.body;

      if (!token) {
        return res.status(400).json({
          success: false,
          message: 'Firebase authentication token is required'
        });
      }

      let decoded;
      try {
        decoded = await admin.auth.verifyIdToken(token);
      } catch (tokenErr) {
        logger.error('Firebase token verification failed in socialLogin:', tokenErr);
        return res.status(400).json({
          success: false,
          message: 'Invalid Firebase authentication token'
        });
      }

      const firebaseUid = decoded.uid;
      const verifiedEmail = decoded.email || email;
      const verifiedName = decoded.name || name || verifiedEmail?.split('@')[0] || '';

      if (!verifiedEmail) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      let user = await prisma.users.findUnique({
        where: { firebase_uid: firebaseUid }
      });

      if (!user) {
        // Fallback email link
        user = await prisma.users.findUnique({
          where: { email: verifiedEmail }
        });
      }

      if (user) {
        // Build the update data for existing user
        const updateData = {};
        
        // Link firebase_uid if not set
        if (user.firebase_uid !== firebaseUid) {
          updateData.firebase_uid = firebaseUid;
        }

        // If a specific role is requested and differs from their current role, update it
        if (role && role.toUpperCase() !== user.role) {
          const targetRole = role.toUpperCase();
          updateData.role = targetRole;
          if (targetRole === 'FINDER') {
            updateData.is_finder_registered = true;
          } else if (targetRole === 'SPOTTER') {
            updateData.is_spotter_registered = true;
          }
        }

        // If there's anything to update, run the update query
        if (Object.keys(updateData).length > 0) {
          user = await prisma.users.update({
            where: { id: user.id },
            data: updateData
          });
        }
      } else {
        // Create user if they don't exist yet
        const normalizedRole = role ? role.toUpperCase() : 'FINDER';
        user = await prisma.users.create({
          data: {
            email: verifiedEmail,
            full_name: verifiedName,
            name: verifiedName,
            phone: '',
            role: normalizedRole,
            firebase_uid: firebaseUid,
            is_finder_registered: normalizedRole === 'FINDER',
            is_spotter_registered: normalizedRole === 'SPOTTER'
          }
        });
      }

      const stats = await User.getStats(user.id, user.role);

      res.json({
        success: true,
        message: 'Profile synchronized successfully',
        data: {
          user: { ...user, name: user.full_name },
          stats
        }
      });

    } catch (error) {
      logger.error('Profile synchronization error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to synchronize profile: ' + error.message
      });
    }
  }

  /**
   * LOGOUT (stateless, so we just return success)
   */
  static async logout(req, res) {
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  }

  /**
   * GET PROFILE
   */
  static async getProfile(req, res) {
    try {
      const user = await User.findById(req.user.id);
      const stats = await User.getStats(req.user.id, req.user.role);

      res.json({
        success: true,
        data: { user, stats }
      });
    } catch (error) {
      logger.error('Get profile error:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching profile'
      });
    }
  }

  /**
   * UPDATE PROFILE
   */
  static async updateProfile(req, res) {
    try {
      const user = await User.update(req.user.id, req.body);
      res.json({
        success: true,
        message: 'Profile updated',
        data: user
      });
    } catch (error) {
      logger.error('Update profile error:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating profile'
      });
    }
  }

  /**
   * 🔄 SWITCH ROLE (Finder <=> Spotter)
   */
  static async switchRole(req, res) {
    try {
      const { newRole, registrationDetails } = req.body;
      if (!['FINDER', 'SPOTTER'].includes(newRole.toUpperCase())) {
        return res.status(400).json({ success: false, message: 'Invalid role' });
      }

      const user = await prisma.users.findUnique({
        where: { id: req.user.id }
      });

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const isRegistered = newRole.toUpperCase() === 'FINDER' ? user.is_finder_registered : user.is_spotter_registered;

      if (!isRegistered && !registrationDetails) {
        return res.json({
          success: false,
          registrationRequired: true,
          message: `${newRole.charAt(0).toUpperCase() + newRole.slice(1)} registration is required.`
        });
      }

      const updateData = { role: newRole.toUpperCase() };
      if (newRole.toUpperCase() === 'FINDER') {
        updateData.is_finder_registered = true;
      } else {
        updateData.is_spotter_registered = true;
      }

      if (registrationDetails) {
        const { address, dob, phone, upi_id, bank_account_number, bank_ifsc, bank_account_name, payout_mode } = registrationDetails;
        if (address) updateData.address = address;
        if (dob) updateData.dob = dob;
        if (phone) updateData.phone = phone;
        if (upi_id) updateData.upi_id = upi_id;
        if (bank_account_number) updateData.bank_account_number = bank_account_number;
        if (bank_ifsc) updateData.bank_ifsc = bank_ifsc;
        if (bank_account_name) updateData.bank_account_name = bank_account_name;
        if (payout_mode) updateData.payout_mode = payout_mode;
      }

      const updatedUser = await prisma.users.update({
        where: { id: req.user.id },
        data: updateData
      });

      res.json({
        success: true,
        message: `Successfully switched to ${newRole} mode`,
        data: {
          user: updatedUser,
          role: updatedUser.role
        }
      });
    } catch (error) {
      logger.error('Switch role error:', error);
      res.status(500).json({ success: false, message: 'Failed to switch role' });
    }
  }

  /**
   * 📲 UPDATE PUSH TOKEN
   */
  static async updatePushToken(req, res) {
    try {
      const { push_token } = req.body;
      await prisma.users.update({
        where: { id: req.user.id },
        data: { push_token }
      });

      res.json({
        success: true,
        message: 'Push token updated successfully'
      });
    } catch (error) {
      logger.error('Update push token error:', error);
      res.status(500).json({ success: false, message: 'Failed to update push token' });
    }
  }
}

module.exports = AuthController;