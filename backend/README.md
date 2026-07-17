# ParkStop — Backend API

REST + WebSocket API server for the ParkStop parking marketplace.

**Stack:** Node.js 20+, Express, PostgreSQL (Prisma ORM), Socket.IO, Redis + BullMQ,
Firebase Admin (auth & push), Razorpay + Stripe (payments/payouts), Cloudinary (images),
Winston (logging).

---

## Prerequisites

- **Node.js 20+**
- **PostgreSQL 14+** — a reachable database and its `DATABASE_URL`
- **Redis** — required for the BullMQ payout/job queues
- A **Firebase** service account (for verifying ID tokens and sending push notifications)

---

## Setup

```bash
cd backend

# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    Open .env and fill in the values. See the file for what each variable does —
#    variables tagged [REQUIRED] will stop the app from starting if missing.

# 3. Apply the database schema
npm run dev        # runs `prisma db push` then starts the server with nodemon
#    — or, for a clean production-style migration:
npm run migrate:deploy
```

The server starts on **http://localhost:3000** (override with `PORT`).
Check it's alive: `GET /health` returns database connectivity status.

---

## Environment variables

All configuration is via `.env` (never commit it). The template in
[`.env.example`](.env.example) documents every variable with a tag:

- **[REQUIRED]** — the app throws on startup if missing (`DATABASE_URL`, `JWT_SECRET`,
  `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`).
- **[REQUIRED IN PRODUCTION]** — a warning in dev, fatal in prod
  (`FIREBASE_SERVICE_ACCOUNT_JSON`).
- **[RECOMMENDED]** — the app runs but the related feature degrades (Cloudinary, Stripe,
  Ola Maps, Razorpay payouts).
- **[OPTIONAL]** — sensible defaults.

Validation happens in `src/config/env.js` at startup.

---

## Scripts

| Command                   | What it does                                                    |
| ------------------------- | -------------------------------------------------------------- |
| `npm run dev`             | `prisma db push` + start with nodemon (hot reload)             |
| `npm start`               | `prisma migrate deploy` + start (production)                   |
| `npm run migrate:create`  | Create a new Prisma migration (`prisma migrate dev`)           |
| `npm run migrate:deploy`  | Apply pending migrations                                       |
| `npm run migrate:status`  | Show migration status                                          |
| `npm run seed`            | Seed the database                                              |
| `npm test`                | Run the Jest unit tests                                        |
| `npm run test:e2e`        | Run the end-to-end test runner                                 |

---

## Project structure

```
backend/
├── prisma/
│   └── schema.prisma        # Database schema (source of truth)
├── database/
│   └── migrations/          # SQL migrations
├── src/
│   ├── server.js            # App entry point: middleware, routes, startup
│   ├── config/              # env, database, prisma, socket, firebase
│   ├── routes/              # Express routers (one per resource)
│   ├── controllers/         # Request handlers
│   ├── models/              # Data-access classes (Booking, ParkingSpot, User, Location)
│   ├── services/            # Business logic (pricing, commission, payments, payouts,
│   │   │                    #   notifications, OTP)
│   │   └── payments/        # Stripe & Razorpay adapters, PayoutService
│   ├── middleware/          # auth (RBAC), validation, rate limiting, error handling, upload
│   ├── jobs/                # BullMQ queues + booking lifecycle workers
│   ├── utils/               # logger, token service, helpers, secrets
│   └── generated/           # Prisma client (generated — do not edit or commit)
└── tests/                   # Unit + e2e tests
```

---

## API overview

All routes are prefixed with **`/api/v1`**. Protected routes expect a Firebase ID token:
`Authorization: Bearer <token>`.

| Route group          | Purpose                                          |
| -------------------- | ------------------------------------------------ |
| `/auth`              | Registration, login, account linking             |
| `/spots`             | Create / list / search parking spots             |
| `/bookings`          | Booking lifecycle (create, verify OTP, complete) |
| `/bookings-simple`   | Simplified booking endpoints                      |
| `/locations`         | Live location updates                            |
| `/payments`          | Charges, refunds, payment methods                |
| `/payouts`           | Spotter payouts & payout setup                    |
| `/saved-spots`       | Finder's saved/favorite spots                     |
| `/reviews`           | Post-booking reviews & ratings                    |
| `/disputes`          | Raise and resolve booking disputes                |
| `/analytics`         | Spotter/admin analytics                           |
| `/maps`              | Search & routing (Ola Maps, OSRM fallback)        |
| `/chatbot`           | In-app assistant                                  |

Rate limiting: 100 requests / 15 min globally; 10 / 15 min on auth endpoints.
Security middleware: Helmet, CORS allowlist, 10 kb body limit, `trust proxy`.

---

## Realtime & background jobs

- **Socket.IO** (`src/config/socket.js`) emits per-user events: new bookings, live driver
  location, and payout status.
- **BullMQ + Redis** (`src/jobs/`) process payouts asynchronously with a
  `failed_needs_retry` fallback so earnings are never silently lost.
- **node-cron** drives booking expiry (`src/services/bookingExpiryService.js`).

---

## Testing

```bash
npm test            # Jest unit tests (tests/unit)
npm run test:e2e    # end-to-end runner
```

> Test coverage is currently thin relative to the payment-critical nature of the app.
> Expanding coverage around the booking and payout flows is a priority — see the project roadmap.
