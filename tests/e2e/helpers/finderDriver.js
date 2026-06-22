class FinderDriver {
  constructor(apiClient, installedApps = []) {
    this.apiClient = apiClient;
    this.installedApps = installedApps; // Array of installed UPI apps (e.g. ['gpay', 'phonepe'])
    this.simulateUrlLaunchFailure = false; // Simulate deep link launch failures
    
    // Client states: 'idle', 'spot_selected', 'checkout_initiated', 'fallback_modal_visible', 'receipt_view'
    this.state = 'idle';
    this.currentBooking = null;
    this.checkoutDetails = null;
    this.selectedUpiApp = null;
    this.fallbackModalBranding = null;
  }

  setInstalledApps(apps) {
    this.installedApps = apps;
  }

  reset() {
    this.state = 'idle';
    this.currentBooking = null;
    this.checkoutDetails = null;
    this.selectedUpiApp = null;
    this.fallbackModalBranding = null;
  }

  // Simulator transitions:

  // 1. Select spot and create booking
  async reserveSpot(spotId, startTime, endTime, options = {}) {
    const bookingPayload = {
      spot_id: spotId,
      start_time: startTime,
      end_time: endTime,
      vehicle_type: options.vehicle_type || 'car',
      vehicle_subtype: options.vehicle_subtype || null,
      payment_mode: options.payment_mode || 'online'
    };

    const response = await this.apiClient.post('/bookings', bookingPayload);
    if (!response.ok) {
      throw new Error(`Failed to reserve spot: ${JSON.stringify(response.data)}`);
    }

    this.currentBooking = response.data.data;
    this.state = 'spot_selected';
    return this.currentBooking;
  }

  // 2. Click "Pay" to trigger checkout session ( Razorpay Order creation)
  async initiateCheckout() {
    if (this.state !== 'spot_selected' || !this.currentBooking) {
      throw new Error('No active reservation to checkout');
    }

    const response = await this.apiClient.post('/payments/checkout', {
      bookingId: this.currentBooking.id
    });

    if (!response.ok) {
      throw new Error(`Failed to initiate checkout: ${JSON.stringify(response.data)}`);
    }

    this.checkoutDetails = response.data;
    this.state = 'checkout_initiated';
    return this.checkoutDetails;
  }

  // 3. Simulates clicking on a UPI payment button (e.g., GPay, PhonePe, Paytm, generic)
  async selectUpiPayment(upiApp) {
    if (this.state !== 'checkout_initiated' || !this.checkoutDetails) {
      throw new Error('Checkout must be initiated first');
    }

    this.selectedUpiApp = upiApp;

    // Simulate Linking.canOpenURL() check
    const isAppInstalled = this.installedApps.includes(upiApp);

    if (isAppInstalled && !this.simulateUrlLaunchFailure) {
      // Format the deep link URL
      const deepLink = this.formatUpiDeepLink(upiApp);
      
      // Simulate app launch, user approving payment, and API verification callback
      const mockPaymentId = `pay_deep_${Math.random().toString(36).substring(2, 9)}`;
      
      const verifyResponse = await this.apiClient.post('/payments/razorpay/verify', {
        bookingId: this.currentBooking.id,
        razorpay_order_id: this.checkoutDetails.order_id,
        razorpay_payment_id: mockPaymentId,
        razorpay_signature: 'mock_upi_intent'
      });

      if (verifyResponse.ok) {
        this.state = 'receipt_view';
        return {
          type: 'deep_link',
          url: deepLink,
          success: true,
          data: verifyResponse.data
        };
      } else {
        throw new Error(`Deep link payment verification failed: ${JSON.stringify(verifyResponse.data)}`);
      }
    } else {
      // If app is not installed, transition to fallback modal with custom branding styles
      this.state = 'fallback_modal_visible';
      this.fallbackModalBranding = this.getFallbackBranding(upiApp);
      return {
        type: 'fallback_modal',
        branding: this.fallbackModalBranding
      };
    }
  }

  // Helper to format UPI Deep Link
  formatUpiDeepLink(upiApp) {
    const amount = (this.checkoutDetails.amount / 100).toFixed(2);
    const orderId = this.checkoutDetails.order_id;
    const payeeUpi = 'spotter@upi';
    const payeeName = 'John Spotter';
    
    const params = new URLSearchParams({
      pa: payeeUpi,
      pn: payeeName,
      am: amount,
      tr: orderId,
      cu: 'INR',
      tn: `Parking spot booking #${this.currentBooking.id}`
    });

    switch (upiApp) {
      case 'gpay':
        return `gpay://upi/pay?${params.toString()}`;
      case 'phonepe':
        return `phonepe://upi/pay?${params.toString()}`;
      case 'paytm':
        return `paytmmp://upi/pay?${params.toString()}`;
      default:
        return `upi://pay?${params.toString()}`;
    }
  }

  // Helper to get fallback branding style mock (colors, logos, etc.)
  getFallbackBranding(upiApp) {
    switch (upiApp) {
      case 'gpay':
        return {
          appName: 'Google Pay',
          themeColor: '#4285F4',
          logoAsset: 'gpay_logo_vector.png',
          buttonLabel: 'Simulate Google Pay Success',
          cancelLabel: 'Go Back'
        };
      case 'phonepe':
        return {
          appName: 'PhonePe',
          themeColor: '#5F259F',
          logoAsset: 'phonepe_logo_vector.png',
          buttonLabel: 'Simulate PhonePe Success',
          cancelLabel: 'Go Back'
        };
      case 'paytm':
        return {
          appName: 'Paytm',
          themeColor: '#00BAF2',
          logoAsset: 'paytm_logo_vector.png',
          buttonLabel: 'Simulate Paytm Success',
          cancelLabel: 'Go Back'
        };
      default:
        return {
          appName: 'Generic UPI',
          themeColor: '#097969',
          logoAsset: 'upi_logo_vector.png',
          buttonLabel: 'Simulate UPI Success',
          cancelLabel: 'Go Back'
        };
    }
  }

  // 4. Simulate user deciding to complete the payment in the fallback modal
  async completeFallbackPayment() {
    if (this.state !== 'fallback_modal_visible') {
      throw new Error('Fallback modal is not currently open');
    }

    const mockPaymentId = `pay_fallback_${Math.random().toString(36).substring(2, 9)}`;

    const verifyResponse = await this.apiClient.post('/payments/razorpay/verify', {
      bookingId: this.currentBooking.id,
      razorpay_order_id: this.checkoutDetails.order_id,
      razorpay_payment_id: mockPaymentId,
      razorpay_signature: 'mock_upi_intent'
    });

    if (verifyResponse.ok) {
      this.state = 'receipt_view';
      this.fallbackModalBranding = null;
      return {
        success: true,
        data: verifyResponse.data
      };
    } else {
      throw new Error(`Fallback payment verification failed: ${JSON.stringify(verifyResponse.data)}`);
    }
  }

  // 5. Simulate user deciding to cancel the payment in the fallback modal
  cancelFallbackPayment() {
    if (this.state !== 'fallback_modal_visible') {
      throw new Error('Fallback modal is not currently open');
    }

    this.state = 'checkout_initiated';
    this.fallbackModalBranding = null;
    return {
      success: true,
      state: this.state
    };
  }

  // 6. Simulate receipt details view
  getReceipt() {
    if (this.state !== 'receipt_view' || !this.currentBooking) {
      throw new Error('No receipt available (payment not completed)');
    }
    
    return {
      bookingId: this.currentBooking.id,
      amountPaid: (this.checkoutDetails.amount / 100).toFixed(2),
      status: 'paid',
      selectedApp: this.selectedUpiApp,
      receiptNo: `REC-${this.currentBooking.id}-${Date.now()}`
    };
  }
}

module.exports = FinderDriver;
