# ParkStop — Peer-to-Peer Parking Marketplace

India's smart parking marketplace connecting drivers with private parking space owners —
"the Uber for parking spots."

- **Finders** (drivers) search for nearby parking on a live map, book by the hour, and pay
  via UPI/card or cash.
- **Spotters** (space owners) list their driveways/garages and earn money from idle space.
- Real-time OTP check-in/checkout, demand-based surge pricing, and instant Razorpay payouts
  to Spotters.

A single account can be registered as both a Finder and a Spotter. An internal **Admin** role
handles disputes and payouts that need manual review.

---

## Repository layout

This is a monorepo with two independent applications:

| Folder      | What it is                      | Stack                                            |
| ----------- | ------------------------------- | ------------------------------------------------ |
| `backend/`  | REST + WebSocket API server     | Node.js, Express, PostgreSQL (Prisma), Socket.IO |
| `frontend/` | Cross-platform mobile & web app | React Native, Expo, expo-router, TypeScript      |

---

## How the two halves fit together

```
┌────────────────────────┐         HTTPS  (REST /api/v1)       ┌────────────────────────┐
│      frontend/         │  ─────────────────────────────────▶ │       backend/         │
│  React Native + Expo   │                                     │   Express API server   │
│  (iOS / Android / web) │  ◀───────────────────────────────── │                        │
│                        │        WebSocket (Socket.IO)        │  • Auth (Firebase)     │
│  • Finder app          │     live location, booking events   │  • Bookings + OTP      │
│  • Spotter app         │                                     │  • Pricing / commission│
│  • Admin views         │                                     │  • Payments + payouts  │
└───────────┬────────────┘                                     └───────────┬────────────┘
            │ Firebase Auth (ID tokens)                                     │
            ▼                                                               ▼
      ┌───────────┐                                              ┌──────────────────┐
      │ Firebase  │                                              │   PostgreSQL     │
      └───────────┘                                              │  (via Prisma)    │
                                                                 └──────────────────┘

  External services: Razorpay & Stripe (payments/payouts), Cloudinary (image uploads),
  Ola Maps / OSRM (search & routing), Redis + BullMQ (background job queues)
```

- **Authentication** is handled by Firebase. The frontend signs the user in and sends the
  Firebase ID token as a `Bearer` token; the backend verifies it with the Firebase Admin SDK
  and maps it to a local Postgres `users` row.
- **Realtime** events (new bookings, live driver location, payout status) flow over Socket.IO.
- **Background jobs** (payouts, booking expiry) run through BullMQ + Redis and node-cron.
- **Atomic DB transactions with row locking** prevent double-booking a slot.

---

## The booking lifecycle

1. Finder selects a spot and time window; the backend calculates a price
   (base rate × dynamic multipliers) inside a locked transaction and reserves a slot.
2. Booking is created as `reserved` with a check-in OTP and a check-out OTP.
3. On arrival, the Finder shares the check-in OTP; the Spotter verifies it → `active`.
4. On departure, the check-out OTP (or a Finder self-checkout) completes the booking.
5. The platform commission is split off and the Spotter's earnings are paid out
   (online payout queued, or platform fee deducted for cash payments).
6. Edge cases handled: cancellation + refund, extension, expiry of unclaimed reservations,
   and an "arrears" flow if a Finder leaves without paying.

---

## Quick start

You need **two terminals** — one per app. Full details are in each folder's README.

```bash
# Terminal 1 — backend
cd backend
cp .env.example .env        # then fill in the values
npm install
npm run dev                 # pushes the Prisma schema and starts the API on :3000

# Terminal 2 — frontend
cd frontend
cp .env.example .env        # then fill in the values (point EXPO_PUBLIC_API_URL at the backend)
npm install
npm run dev                 # starts the Expo dev server
```

- **[backend/README.md](backend/README.md)** — API setup, database, scripts, environment.
- **[frontend/README.md](frontend/README.md)** — Expo setup, running on device/web, environment.

---

## Prerequisites

- **Node.js 20+**
- **PostgreSQL 14+** (a reachable `DATABASE_URL`)
- **Redis** (for background job queues)
- A **Firebase** project (Auth + an Admin service account)
- Accounts for the external services you want to enable: Razorpay and/or Stripe, Cloudinary,
  and optionally an Ola Maps key (falls back to public OSRM/Nominatim)

---

## Infrastructure

- **Backend + database:** Railway
- **Images:** Cloudinary
- **Push notifications & auth:** Firebase

---

## Repository hygiene

`node_modules/` and the generated Prisma client (`backend/src/generated/`) are ignored by git
and should **not** be committed. If they were committed before the ignore rules were added,
untrack them once (this keeps the files on disk, so the app keeps running):

```bash
git rm -r --cached backend/node_modules frontend/node_modules backend/src/generated
git commit -m "chore: stop tracking dependencies and generated code"
```

Secrets live in `.env` files (never committed). Each app ships a documented `.env.example`
as a template.

---

## License

MIT
