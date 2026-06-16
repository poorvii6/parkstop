import apiClient from '../api/client';

export interface RazorpayOrderResponse {
  success: boolean;
  order_id: string;
  amount: number;
  currency: string;
  key_id: string;
}

export interface RazorpayVerifyRequest {
  bookingId: number;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface RazorpayVerifyResponse {
  success: boolean;
  message: string;
  paymentId: string;
}

class RazorpayService {
  /**
   * Create a Razorpay order via the backend
   * @param bookingId The ID of the booking to pay for
   */
  async createOrder(bookingId: number): Promise<RazorpayOrderResponse> {
    try {
      const response = await apiClient.post<RazorpayOrderResponse>('/payments/razorpay/create-order', {
        bookingId,
      });
      return response.data;
    } catch (error: any) {
      console.error('Error creating Razorpay order:', error);
      throw new Error(
        error.response?.data?.message || 'Failed to initiate Razorpay checkout session'
      );
    }
  }

  /**
   * Verify the Razorpay payment signature via the backend
   * @param verificationData The signature data returned by Razorpay
   */
  async verifyPayment(verificationData: RazorpayVerifyRequest): Promise<RazorpayVerifyResponse> {
    try {
      const response = await apiClient.post<RazorpayVerifyResponse>(
        '/payments/razorpay/verify',
        verificationData
      );
      return response.data;
    } catch (error: any) {
      console.error('Error verifying Razorpay payment:', error);
      throw new Error(
        error.response?.data?.message || 'Failed to verify payment with the server'
      );
    }
  }
}

export default new RazorpayService();
