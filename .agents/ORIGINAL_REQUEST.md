# Original User Request

## Initial Request — 2026-06-21T03:09:37Z

Replace payment emojis with authentic vector/image logos and implement a simulated fallback payment modal when UPI apps are not installed or fail to launch.

Working directory: c:\Users\chilly\Desktop\smart-parking-app1 (1)\smart-parking-app1
Integrity mode: development

## Requirements

### R1. Brand-Accurate Logos
Replace the emojis for Google Pay, PhonePe, Paytm, and generic UPI in the payment selector modal with authentic, clean vector SVGs or high-resolution images matching their official branding.

### R2. UPI Launch Fallback & Mock Simulator
Check if the selected UPI app (Google Pay, PhonePe, or Paytm) is installed using `Linking.canOpenURL()`. If it is installed, launch the app directly. If it is NOT installed (or if launching fails), display a styled, app-specific mock checkout modal within the app (e.g. Google Pay styling, PhonePe styling) presenting a "Complete Mock Payment" button and a "Cancel" button.

### R3. In-App Wallet Updates
Ensure that simulated payments successfully interact with the backend to mark the booking as `paid`, trigger spotter payouts, and transition to the booking receipt screen.

## Acceptance Criteria

### UI / Presentation
- [ ] Payment selector shows correct logos for Google Pay, PhonePe, Paytm, and UPI.
- [ ] Fallback modal is styled to resemble the selected payment app's branding.

### Functionality
- [ ] Tapping a payment method opens the real app if installed; otherwise, it opens the mock simulator screen.
- [ ] Completing the mock payment updates the booking status to paid and navigates to the receipt.
