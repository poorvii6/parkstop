import React, { useState } from 'react';
import { Modal, StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, SafeAreaView, Platform, Linking, Alert } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';

interface RazorpayCheckoutProps {
  visible: boolean;
  orderId: string;
  amount: number; // in paise or rupees? The backend returns the amount in paise from Razorpay, but let's confirm
  currency: string;
  keyId: string;
  onSuccess: (data: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }) => void;
  onCancel: () => void;
  onFailure: (error: string) => void;
}

export default function RazorpayCheckout({
  visible,
  orderId,
  amount,
  currency,
  keyId,
  onSuccess,
  onCancel,
  onFailure,
}: RazorpayCheckoutProps) {
  const [loading, setLoading] = useState(true);

  // HTML source that loads Razorpay checkout.js and opens the payment dialog
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
      <style>
        body {
          background-color: #0f172a;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          height: 100vh;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          color: #ffffff;
        }
        .spinner {
          width: 50px;
          height: 50px;
          border: 3px solid rgba(255,255,255,0.1);
          border-radius: 50%;
          border-top-color: #6366f1;
          animation: spin 1s ease-in-out infinite;
          margin-bottom: 20px;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .loading-text {
          font-size: 16px;
          font-weight: 600;
          letter-spacing: -0.025em;
          color: #94a3b8;
        }
      </style>
    </head>
    <body>
      <div id="loader-container" style="display: flex; flex-direction: column; align-items: center;">
        <div class="spinner"></div>
        <div class="loading-text">Connecting to Secure Gateway...</div>
      </div>

      <script>
        const options = {
          "key": "${keyId}",
          "amount": "${amount}", // Amount is in paise
          "currency": "${currency}",
          "name": "ParkStop",
          "description": "Secure Parking Reservation",
          "order_id": "${orderId}",
          "handler": function (response) {
            const data = {
              status: 'success',
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_signature: response.razorpay_signature
            };
            window.ReactNativeWebView.postMessage(JSON.stringify(data));
          },
          "prefill": {
            "name": "ParkStop User",
            "email": "user@parkstop.com"
          },
          "theme": {
            "color": "#6366f1"
          },
          "modal": {
            "ondismiss": function () {
              const data = { status: 'cancelled' };
              window.ReactNativeWebView.postMessage(JSON.stringify(data));
            }
          }
        };

        const rzp = new Razorpay(options);

        rzp.on('payment.failed', function (response) {
          const data = {
            status: 'failed',
            reason: response.error.description || 'Payment failed'
          };
          window.ReactNativeWebView.postMessage(JSON.stringify(data));
        });

        // Open Razorpay automatically when script loads
        setTimeout(() => {
          try {
            document.getElementById('loader-container').style.display = 'none';
            rzp.open();
          } catch (err) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              status: 'failed',
              reason: err.message || 'Failed to open Razorpay'
            }));
          }
        }, 1000);
      </script>
    </body>
    </html>
  `;

  const handleMessage = (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.status === 'success') {
        onSuccess({
          razorpay_payment_id: data.razorpay_payment_id,
          razorpay_order_id: data.razorpay_order_id,
          razorpay_signature: data.razorpay_signature,
        });
      } else if (data.status === 'cancelled') {
        onCancel();
      } else if (data.status === 'failed') {
        onFailure(data.reason || 'Payment execution failed');
      }
    } catch (e) {
      onFailure('Failed to process webview message');
    }
  };

  const onShouldStartLoadWithRequest = (request: any) => {
    const { url } = request;
    if (
      url.startsWith('upi://') ||
      url.startsWith('gpay://') ||
      url.startsWith('paytmmp://') ||
      url.startsWith('phonepe://') ||
      url.startsWith('tez://')
    ) {
      Linking.openURL(url).catch(() => {
        Alert.alert('Error', 'Payment app not found');
      });
      return false;
    }
    return true;
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onCancel}
    >
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onCancel} style={styles.closeButton} activeOpacity={0.7}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Secure Payment</Text>
          <View style={{ width: 40 }} />
        </View>

        <View style={styles.webviewContainer}>
          <WebView
            source={{ html: htmlContent }}
            originWhitelist={['*']}
            onMessage={handleMessage}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            style={{ flex: 1, backgroundColor: '#0f172a' }}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  header: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    backgroundColor: '#0f172a',
  },
  closeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  webviewContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#0f172a',
  },
  loader: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0f172a',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loaderText: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '600',
  },
});
