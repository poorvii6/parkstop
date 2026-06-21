class SpotterDriver {
  constructor(apiClient) {
    this.apiClient = apiClient;
    this.state = 'idle';
  }

  // Verify check-in OTP to activate booking
  async verifyCheckInOTP(bookingId, otpCode) {
    const response = await this.apiClient.post('/bookings/verify-otp', {
      bookingId,
      otp: otpCode
    });
    return response;
  }

  // Verify check-out OTP (complete booking)
  async verifyCheckOutOTP(bookingId, checkoutOtp) {
    const response = await this.apiClient.post('/bookings/verify-checkout-otp', {
      bookingId,
      otp: checkoutOtp
    });
    return response;
  }

  // Complete booking directly (PUT /bookings/:id/complete)
  async completeBookingDirectly(bookingId, checkoutOtp) {
    const response = await this.apiClient.put(`/bookings/${bookingId}/complete`, {
      otp: checkoutOtp
    });
    return response;
  }

  // Fetch spotter wallet details & profile
  async getWalletDetails() {
    const response = await this.apiClient.get('/auth/profile');
    if (!response.ok) {
      throw new Error(`Failed to fetch profile: ${JSON.stringify(response.data)}`);
    }
    return {
      balance: parseFloat(response.data.data.user.balance),
      user: response.data.data.user
    };
  }

  // Request withdrawal of earnings
  async withdrawEarnings(amount, methodId) {
    const response = await this.apiClient.post('/payments/withdraw', {
      amount: parseFloat(amount),
      methodId: parseInt(methodId)
    });
    return response;
  }
}

module.exports = SpotterDriver;
