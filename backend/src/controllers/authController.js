const User = require('../models/User');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../utils/logger');
const prisma = require('../config/prisma');

class AuthController {

  /**
   * REGISTER
   */
  static async register(req, res) {
    try {

      const { email, password, name, phone, role } = req.body;

      if (!['finder', 'spotter'].includes(role)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role'
        });
      }

      const existing = await User.findByEmail(email);

      if (existing) {
        return res.status(400).json({
          success: false,
          message: 'Email already exists'
        });
      }

      const user = await User.create({
        email,
        password,
        name,
        phone,
        role
      });

      delete user.password;

      res.status(201).json({
        success: true,
        message: 'User registered successfully',
        data: user
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
   * LOGIN
   */
  static async login(req, res) {
    try {

      const { email, password } = req.body;
      console.log('[LOGIN ATTEMPT]', { email, password });

      const user = await User.findByEmail(email);

      if (!user) {
        console.log(`[LOGIN FAILED] User not found for email: ${email}`);
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      const isValid = await User.verifyPassword(password, user.password);

      if (!isValid) {
        console.log(`[LOGIN FAILED] Password mismatch for email: ${email}`);
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials'
        });
      }

      /**
       * Generate Access Token
       */
      const accessToken = jwt.sign(
        {
          id: user.id,
          role: user.role,
          name: user.full_name || user.name
        },
        config.jwt.secret,
        { expiresIn: '24h' }
      );

      /**
       * Generate Refresh Token
       */
      const refreshToken = jwt.sign(
        {
          id: user.id
        },
        config.jwt.refreshSecret,
        { expiresIn: '7d' }
      );

      const refreshExpiry = new Date();
      refreshExpiry.setDate(refreshExpiry.getDate() + 7);

      await prisma.users.update({
        where: { id: user.id },
        data: {
          refresh_token: refreshToken,
          refresh_token_expires: refreshExpiry
        }
      });

      delete user.password;

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          user,
          access_token: accessToken,
          refresh_token: refreshToken
        }
      });

    } catch (error) {

      logger.error('Login error:', error);

      res.status(500).json({
        success: false,
        message: 'Error logging in'
      });

    }
  }

  /**
   * REFRESH ACCESS TOKEN
   */
  static async refreshToken(req, res) {
  try {

    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        message: 'Refresh token required'
      });
    }

    const decoded = jwt.verify(refresh_token, config.jwt.refreshSecret);

    const user = await prisma.users.findFirst({
      where: {
        id: decoded.id,
        refresh_token: refresh_token
      }
    });

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid refresh token'
      });
    }

    // 🔴 CHECK EXPIRY (IMPORTANT FIX)
    if (user.refresh_token_expires < new Date()) {
      return res.status(401).json({
        success: false,
        message: 'Refresh token expired'
      });
    }

    const newAccessToken = jwt.sign(
      {
        id: user.id,
        role: user.role
      },
      config.jwt.secret,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      data: {
        access_token: newAccessToken
      }
    });

  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Invalid or expired refresh token'
    });
  }
}

  /**
   * LOGOUT
   */
  static async logout(req, res) {

    try {

      await prisma.users.update({
        where: { id: req.user.id },
        data: { refresh_token: null }
      });

      res.json({
        success: true,
        message: "Logged out successfully"
      });

    } catch (error) {

      res.status(500).json({
        success: false,
        message: "Logout failed"
      });

    }

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
   * CHANGE PASSWORD
   */
  static async changePassword(req, res) {
    try {
      const { oldPassword, newPassword } = req.body;

      if (!oldPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Both current and new passwords are required'
        });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'New password must be at least 6 characters'
        });
      }

      await User.changePassword(req.user.id, oldPassword, newPassword);

      res.json({
        success: true,
        message: 'Password changed successfully'
      });

    } catch (error) {
      logger.error('Change password error:', error);
      res.status(400).json({
        success: false,
        message: error.message || 'Error changing password'
      });
    }
  }

  /**
   * 🔄 SWITCH ROLE (Finder <=> Spotter)
   */
  static async switchRole(req, res) {
    try {
      const { newRole } = req.body;
      if (!['finder', 'spotter'].includes(newRole)) {
        return res.status(400).json({ success: false, message: 'Invalid role' });
      }

      const updatedUser = await prisma.users.update({
        where: { id: req.user.id },
        data: { role: newRole }
      });

      // Generate a new token with the updated role
      const newAccessToken = jwt.sign(
        {
          id: updatedUser.id,
          role: updatedUser.role,
          name: updatedUser.full_name || updatedUser.name
        },
        config.jwt.secret,
        { expiresIn: '24h' }
      );

      res.json({
        success: true,
        message: `Successfully switched to ${newRole} mode`,
        data: {
          user: updatedUser,
          access_token: newAccessToken,
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
      if (!push_token) {
        return res.status(400).json({ success: false, message: 'Push token is required' });
      }

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