import React from 'react';

// Mock StripeProvider for web to prevent bundler errors
export const StripeProvider = ({ children, publishableKey }: any) => {
  return React.createElement(React.Fragment, null, children);
};

// Mock useStripe for web since native UI components cannot be rendered
export const useStripe = () => {
  return {
    initPaymentSheet: async () => ({ error: { message: 'Stripe payments are not currently supported on the web version.' } }),
    presentPaymentSheet: async () => ({ error: { message: 'Stripe payments are not currently supported on the web version.' } }),
  };
};
