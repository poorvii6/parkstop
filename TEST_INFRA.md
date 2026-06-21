# E2E Testing Infrastructure

This document outlines the design, architecture, and usage of the End-to-End (E2E) testing framework implemented for the Smart Parking Application.

---

## Architecture Overview

The E2E testing framework is designed to test backend APIs, client-side integrations (using simulated state drivers), payment status flows, and boundary conditions. It is built completely from scratch without external heavy test frameworks, utilizing Node.js's built-in `node:test` runner and native `fetch` module.

```
tests/e2e/
├── cases/
│   ├── tier1_feature.test.js      # Feature coverage tests (deep links, fallback UI, completion)
│   ├── tier2_boundary.test.js     # Boundary cases (missing apps, URL failure, duplicate payments)
│   ├── tier3_combination.test.js  # Combinatorial pairwise configurations
│   └── tier4_workload.test.js     # Real-world workloads (concurrency, dynamic pricing, cash wallet changes)
├── helpers/
│   ├── api.js                     # API client wrapper using native fetch & JWT maintenance
│   ├── db.js                      # Database reset and seeding helper via Prisma
│   ├── finderDriver.js            # Simulated finder mobile client state machine & deep linking
│   └── spotterDriver.js           # Simulated spotter mobile client state machine
└── runner.js                      # Orchestrator (starts DB push, server, runs tests, stops server)
```

---

## Component Details

### 1. Database Helper (`helpers/db.js`)
Handles database clean-ups and seeding to ensure tests execute in a clean environment.
- **Reset**: Deletes records from dependent Postgres tables in correct order (`bookings`, `saved_spots`, `payouts`, `withdrawals`, `payment_methods`, `locations`, `parking_spots`, `users`).
- **Seed**: Populates a finder user (`finder@example.com`), a spotter user (`spotter@example.com`), a payment method for the finder, and a parking spot owned by the spotter.

### 2. API Helper (`helpers/api.js`)
A fetch-based REST client that simplifies HTTP operations.
- Automatically handles content types and manages a persistent Authorization token header when updated via `setToken(token)`.

### 3. Finder Driver (`helpers/finderDriver.js`)
An asynchronous client simulator representing mobile state transitions:
- **States**: `idle`, `spot_selected`, `checkout_initiated`, `fallback_modal_visible`, `receipt_view`.
- **UPI Deep Link Formatting**: Automatically formats deep link URLs (Google Pay, PhonePe, Paytm, generic) with payment query arguments: `pa`, `pn`, `am`, `tr`, `cu`, `tn`.
- **Fallback Modal Styling**: Mimics app branding: GPay (Blue theme, logo name), PhonePe (Purple theme), Paytm (Light Blue theme), UPI (Green theme).
- **Simulations**: Supports simulating app installation checking (`installedApps`) and deep link URL launch failure (`simulateUrlLaunchFailure`) to test fallback modal scenarios.

### 4. Spotter Driver (`helpers/spotterDriver.js`)
An asynchronous client simulator representing spotter dashboard transitions:
- Manages check-in OTP validation, check-out OTP validation, wallet balance fetching, and withdrawal requests.

---

## Test Suites (Tiers 1-4)

### Tier 1: Feature Coverage (`cases/tier1_feature.test.js`)
- Validates deep link string structures.
- Tests correct fallback modal styles (AppName, colors, labels) when specific apps are missing.
- Tests user decision paths (Cancel vs Complete) in fallback modals.
- Verifies that successful payment flow updates the DB correctly and generates a formatted receipt object.

### Tier 2: Boundary Cases (`cases/tier2_boundary.test.js`)
- Tests missing apps config (all apps trigger fallback).
- Tests URL launch failures (deep link fail triggers fallback).
- Tests user cancel decisions (returns state machine back to selection).
- Tests API endpoint boundaries (invalid IDs, missing parameters, bad signature rejection).
- Tests duplicate payments (verifying idempotency/graceful success response).

### Tier 3: Pairwise Combinations (`cases/tier3_combination.test.js`)
Tests a matrix of:
- **Installed apps** (`[]`, `['gpay']`, `['phonepe', 'paytm']`)
- **Selected UPI apps** (`'gpay'`, `'phonepe'`, `'paytm'`, `'generic'`)
- **Fallback actions** (`'complete'`, `'cancel'`)
Ensures the state machine transitions to `receipt_view` (deep link/fallback complete) or `checkout_initiated` (fallback cancel) correctly under all conditions.

### Tier 4: Real-world Workloads (`cases/tier4_workload.test.js`)
- **Concurrency**: Simulates multiple parallel finder bookings and checkouts resolving concurrently without race conditions.
- **Dynamic Pricing Surge**: Asserts that active bookings increase occupancy, which dynamically adjusts prices upwards (demand multiplier surge).
- **Cash Platform Fee wallet update**: Asserts that when a booking is checked out via cash, the backend sets the payment as paid and decrements the calculated platform fee from the spotter's wallet balance.

---

## Running the Tests

To run the entire E2E suite, execute the orchestrator script:

```bash
node tests/e2e/runner.js
```

The orchestrator will:
1. Run `npx prisma db push` to verify schema synchrony.
2. Spawn the backend server process on port `3000`.
3. Wait and poll the server `/health` check until it is online.
4. Reset and seed the database.
5. Run the native Node test runner on all `*.test.js` files.
6. Gracefully shut down the server process and return the test runner's exit code.
