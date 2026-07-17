const jwt = require('jsonwebtoken');

class TokenService {

  static generateAccessToken(user) {
    return jwt.sign(
      {
        id: user.id,
        role: user.role
      },
      process.env.JWT_ACCESS_SECRET,
      {
        expiresIn: process.env.ACCESS_TOKEN_EXPIRY
      }
    );
  }

  static generateRefreshToken(user) {
    return jwt.sign(
      {
        id: user.id
      },
      process.env.JWT_REFRESH_SECRET,
      {
        expiresIn: process.env.REFRESH_TOKEN_EXPIRY
      }
    );
  }

}

module.exports = TokenService;