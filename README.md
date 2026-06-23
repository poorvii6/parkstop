# ParkStop — Peer-to-Peer Parking Marketplace

India's smart parking marketplace connecting drivers with private parking space owners.

## What it does
- **Finders** (drivers) search for nearby parking, book by the hour, and pay via UPI/card or cash
- **Spotters** (space owners) list their driveways/garages and earn money from idle space
- Real-time OTP check-in/checkout, surge pricing, instant Razorpay payouts to Spotters

## Tech Stack
**Backend:** Node.js, Express, PostgreSQL, Prisma ORM, Socket.io, Razorpay, JWT Auth  
**Frontend:** React Native (Expo), MapLibre GL, TypeScript  
**Infrastructure:** Railway (backend + DB), Cloudinary (images)

## Local Setup

### Backend
```bash
cd backend
cp .env.example .env   # fill in your values
npm install
npx prisma db push
npm run dev
```

### Frontend
```bash
cd frontend
npm install
cp .env.example .env   # set EXPO_PUBLIC_API_URL
npx expo start
```

## Architecture
- REST API at `/api/v1`
- WebSocket for real-time spot availability and booking notifications
- Atomic transactions prevent double-bookings
- Uber-style demand-based surge pricing
- Razorpay Payouts API for automatic Spotter earnings

## License
MIT
