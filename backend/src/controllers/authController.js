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
      const { newRole, registrationDetails } = req.body;
      if (!['finder', 'spotter'].includes(newRole)) {
        return res.status(400).json({ success: false, message: 'Invalid role' });
      }

      const user = await prisma.users.findUnique({
        where: { id: req.user.id }
      });

      if (!user) {
        return res.status(404).json({ success: false, message: 'User not found' });
      }

      const isRegistered = newRole === 'finder' ? user.is_finder_registered : user.is_spotter_registered;

      if (!isRegistered && !registrationDetails) {
        return res.json({
          success: false,
          registrationRequired: true,
          message: `${newRole.charAt(0).toUpperCase() + newRole.slice(1)} registration is required.`
        });
      }

      const updateData = { role: newRole };
      if (newRole === 'finder') {
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

  /**
   * 🌐 SOCIAL LOGIN (Google / Apple)
   */
  static async socialLogin(req, res) {
    try {
      const { email, name, provider, token } = req.body;
      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      console.log(`[SOCIAL LOGIN] Provider: ${provider}, Email: ${email}`);

      let user = await User.findByEmail(email);

      if (!user) {
        // Create user if not exists
        const randomPassword = `OAUTH_MOCK_${Math.random().toString(36).slice(-8)}_${Date.now()}`;
        user = await User.create({
          email,
          password: randomPassword,
          name: name || email.split('@')[0],
          phone: '',
          role: 'finder' // default to finder
        });
      }

      // Generate access token
      const accessToken = jwt.sign(
        {
          id: user.id,
          role: user.role,
          name: user.full_name || user.name
        },
        config.jwt.secret,
        { expiresIn: '24h' }
      );

      // Generate refresh token
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
        message: 'Social login successful',
        data: {
          user,
          access_token: accessToken,
          refresh_token: refreshToken
        }
      });

    } catch (error) {
      logger.error('Social login error:', error);
      res.status(500).json({
        success: false,
        message: 'Error authenticating with social provider: ' + error.message
      });
    }
  }

  /**
   * 🌐 GET /auth/social/mock-login
   * Renders the mock HTML sign-in page for Google/Apple
   */
  static async renderMockOAuth(req, res) {
    try {
      const { provider, redirect_uri } = req.query;
      if (!provider || !redirect_uri) {
        return res.status(400).send('Provider and redirect_uri query params are required.');
      }

      const isGoogle = provider.toLowerCase() === 'google';
      const logoSymbol = isGoogle ? '🌐' : '';
      const providerName = isGoogle ? 'Google' : 'Apple';

      const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Sign in with ${providerName}</title>
          <style>
              * { box-sizing: border-box; margin: 0; padding: 0; }
              body { 
                  background-color: #0f172a; 
                  color: #f8fafc; 
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  min-height: 100vh;
                  padding: 16px;
              }
              .card {
                  width: 100%;
                  max-width: 400px;
                  background-color: #1e293b;
                  border: 1px solid rgba(255,255,255,0.08);
                  border-radius: 24px;
                  padding: 32px;
                  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                  text-align: center;
              }
              .logo {
                  font-size: 40px;
                  margin-bottom: 12px;
                  display: inline-block;
              }
              h1 {
                  font-size: 24px;
                  font-weight: 800;
                  color: #ffffff;
                  letter-spacing: -0.5px;
              }
              .subtitle {
                  font-size: 14px;
                  color: #94a3b8;
                  margin-top: 6px;
                  margin-bottom: 32px;
              }
              .subtitle span {
                  color: #6366f1;
                  font-weight: 600;
              }
              .section-title {
                  color: #64748b;
                  font-size: 10px;
                  font-weight: 800;
                  text-transform: uppercase;
                  letter-spacing: 1px;
                  text-align: left;
                  margin-bottom: 10px;
              }
              .profile-btn {
                  width: 100%;
                  display: flex;
                  align-items: center;
                  gap: 14px;
                  padding: 14px;
                  background-color: rgba(255,255,255,0.03);
                  border: 1px solid rgba(255,255,255,0.06);
                  border-radius: 16px;
                  color: #ffffff;
                  font-size: 15px;
                  cursor: pointer;
                  text-align: left;
                  transition: all 0.2s ease;
                  margin-bottom: 12px;
              }
              .profile-btn:hover {
                  background-color: rgba(255,255,255,0.06);
                  border-color: rgba(255,255,255,0.1);
              }
              .avatar {
                  width: 40px;
                  height: 40px;
                  border-radius: 20px;
                  background-color: #6366f1;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  font-weight: 800;
                  font-size: 14px;
                  color: #ffffff;
              }
              .avatar.green {
                  background-color: #10b981;
              }
              .profile-details {
                  flex-grow: 1;
              }
              .profile-name {
                  font-weight: 800;
                  font-size: 14px;
              }
              .profile-email {
                  font-size: 12px;
                  color: #94a3b8;
                  margin-top: 2px;
              }
              .divider {
                  display: flex;
                  align-items: center;
                  margin: 24px 0;
              }
              .divider-line {
                  flex-grow: 1;
                  height: 1px;
                  background-color: rgba(255,255,255,0.08);
              }
              .divider-text {
                  color: #64748b;
                  font-size: 9px;
                  font-weight: 800;
                  margin: 0 12px;
                  text-transform: uppercase;
                  letter-spacing: 1px;
              }
              .input-group {
                  display: flex;
                  flex-direction: column;
                  gap: 10px;
                  margin-bottom: 16px;
              }
              .text-input {
                  width: 100%;
                  background-color: rgba(255,255,255,0.02);
                  border: 1px solid rgba(255,255,255,0.08);
                  border-radius: 16px;
                  padding: 14px 16px;
                  color: #ffffff;
                  font-size: 14px;
                  font-weight: 600;
                  transition: border-color 0.2s ease;
              }
              .text-input:focus {
                  border-color: #6366f1;
                  outline: none;
              }
              .submit-btn {
                  width: 100%;
                  background-color: #6366f1;
                  border: none;
                  border-radius: 16px;
                  padding: 16px;
                  color: #ffffff;
                  font-size: 15px;
                  font-weight: 800;
                  cursor: pointer;
                  transition: background-color 0.2s ease;
                  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
              }
              .submit-btn:hover {
                  background-color: #4f46e5;
              }
              .submit-btn:active {
                  background-color: #4338ca;
              }
          </style>
      </head>
      <body>
          <div class="card">
              <div class="logo">${logoSymbol}</div>
              <h1>Sign in with ${providerName}</h1>
              <p class="subtitle">to continue to <span>ParkStop</span></p>
              
              <form action="/api/v1/auth/social/mock-login" method="POST">
                  <input type="hidden" name="provider" value="${provider}">
                  <input type="hidden" name="redirect_uri" value="${redirect_uri}">

                  <p class="section-title">Choose a test account</p>
                  
                  <button type="submit" name="selected_profile" value="${isGoogle ? 'alex.jones@gmail.com|Alex Jones' : 'alex.jones@icloud.com|Alex Jones'}" class="profile-btn">
                      <div class="avatar">AJ</div>
                      <div class="profile-details">
                          <div class="profile-name">Alex Jones</div>
                          <div class="profile-email">${isGoogle ? 'alex.jones@gmail.com' : 'alex.jones@icloud.com'}</div>
                      </div>
                  </button>

                  <button type="submit" name="selected_profile" value="${isGoogle ? 'sarah.parker@gmail.com|Sarah Parker' : 'sarah.parker@icloud.com|Sarah Parker'}" class="profile-btn">
                      <div class="avatar green">SP</div>
                      <div class="profile-details">
                          <div class="profile-name">Sarah Parker</div>
                          <div class="profile-email">${isGoogle ? 'sarah.parker@gmail.com' : 'sarah.parker@icloud.com'}</div>
                      </div>
                  </button>

                  <div class="divider">
                      <div class="divider-line"></div>
                      <div class="divider-text">Or type manual email</div>
                      <div class="divider-line"></div>
                  </div>

                  <div class="input-group">
                      <input type="text" name="custom_name" placeholder="Full Name" class="text-input">
                      <input type="email" name="custom_email" placeholder="email@example.com" class="text-input">
                  </div>

                  <button type="submit" name="action" value="custom" class="submit-btn">
                      Continue
                  </button>
              </form>
          </div>
      </body>
      </html>
      `;
      res.send(html);
    } catch (error) {
      logger.error('Render mock OAuth error:', error);
      res.status(500).send('Failed to render OAuth page: ' + error.message);
    }
  }

  /**
   * 🌐 POST /auth/social/mock-login
   * Processes mock OAuth submission and redirects to custom app scheme deep link
   */
  static async handleMockOAuthSubmit(req, res) {
    try {
      const { provider, redirect_uri, selected_profile, custom_email, custom_name, action } = req.body;
      if (!provider || !redirect_uri) {
        return res.status(400).send('Provider and redirect_uri are required.');
      }

      let email = '';
      let name = '';

      if (action === 'custom') {
        email = custom_email;
        name = custom_name || email.split('@')[0];
      } else if (selected_profile) {
        const parts = selected_profile.split('|');
        email = parts[0];
        name = parts[1];
      }

      if (!email || !email.includes('@')) {
        return res.status(400).send('A valid email is required.');
      }

      console.log(`[SOCIAL LOGIN REDIRECT] Provider: ${provider}, Email: ${email}`);

      let user = await User.findByEmail(email);

      if (!user) {
        const randomPassword = `OAUTH_MOCK_${Math.random().toString(36).slice(-8)}_${Date.now()}`;
        user = await User.create({
          email,
          password: randomPassword,
          name: name || email.split('@')[0],
          phone: '',
          role: 'finder'
        });
      }

      // Generate access token
      const accessToken = jwt.sign(
        {
          id: user.id,
          role: user.role,
          name: user.full_name || user.name
        },
        config.jwt.secret,
        { expiresIn: '24h' }
      );

      // Generate refresh token
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

      // Redirect back to the mobile app deep link scheme!
      // Format: parkstop://auth-callback?access_token=...&user_role=...
      const redirectUrl = `${redirect_uri}?access_token=${accessToken}&user_role=${user.role}`;
      console.log(`[REDIRECTING TO APP] ${redirectUrl}`);
      res.redirect(redirectUrl);

    } catch (error) {
      logger.error('Mock OAuth login error:', error);
      res.status(500).send('OAuth Authentication Failed: ' + error.message);
    }
  }

}

module.exports = AuthController;