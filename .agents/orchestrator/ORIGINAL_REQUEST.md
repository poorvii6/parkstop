# Original User Request

## 2026-06-21T03:09:59Z

Satisfy the user request recorded in c:\Users\chilly\Desktop\smart-parking-app1 (1)\smart-parking-app1\ORIGINAL_REQUEST.md.
Replace payment emojis with authentic vector/image logos and implement a simulated fallback payment modal when UPI apps are not installed or fail to launch.

### R1. Brand-Accurate Logos
Replace the emojis for Google Pay, PhonePe, Paytm, and generic UPI in the payment selector modal with authentic, clean vector SVGs or high-resolution images matching their official branding.

### R2. UPI Launch Fallback & Mock Simulator
Check if the selected UPI app (Google Pay, PhonePe, or Paytm) is installed using `Linking.canOpenURL()`. If it is installed, launch the app directly. If it is NOT installed (or if launching fails), display a styled, app-specific mock checkout modal within the app (e.g. Google Pay styling, PhonePe styling) presenting a "Complete Mock Payment" button and a "Cancel" button.

### R3. In-App Wallet Updates
Ensure that simulated payments successfully interact with the backend to mark the booking as `paid`, trigger spotter payouts, and transition to the booking receipt screen.
