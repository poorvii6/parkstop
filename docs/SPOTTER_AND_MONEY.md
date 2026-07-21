# ParkStop — Spotter Dashboard & Money Flow

How the Spotter side works, and exactly how money moves between the Finder,
the Spotter, and ParkStop.

Written from the code as of July 2026. Key files are cited so this can be
checked rather than trusted.

---

## Part 1 — The Spotter Dashboard

### Screens

| Route | Purpose |
|---|---|
| `/spotter` | Home. Stats, wallet/dues, revenue chart, inventory, payout history |
| `/spotter/verify` | The working screen — check drivers in and out via OTP |
| `/spotter/earnings` | Itemised breakdown of earnings and fees |
| `/spotter/spots` | Create and manage parking spots |
| `/spotter/payout-setup` | Link a UPI ID / bank account to receive money |

### How the dashboard loads

`useSpotterDashboard` (`frontend/hooks/useSpotterDashboard.ts`) owns all data
loading. It fires on three triggers:

1. **Screen focus** — every time the dashboard becomes visible
2. **Pull to refresh**
3. **Realtime events** — `booking:new`, `booking:cancelled`, `payout:pending`
   arrive over Socket.IO and refresh immediately

The realtime path matters: without it a Spotter would have to manually refresh
to notice a booking, and a driver could be waiting at the gate meanwhile.

It calls `GET /spots/dashboard` → `ParkingSpot.getSpotterDashboard()`, which
returns:

| Field | Meaning | Window |
|---|---|---|
| `active_spots` | Count of spots with `is_active = true` | now |
| `earnings` | Sum of `spotter_earning` on completed bookings | **all time** |
| `revenue_trend` | 7 numbers, earnings per day | **rolling — index 6 is today** |
| `balance` | Wallet. Negative = dues owed | now |
| `occupancy_rate` | Slots taken vs. total | now |
| `surge_factor` | Average demand multiplier across active spots | now |
| `inventory` | Active spots + slot counts | now |
| `payout_history` | Last 5 payouts | — |

> **Note on `revenue_trend`:** it's a *rolling* window ending today, not
> Monday–Sunday. `RevenueChart` derives its labels from real dates for this
> reason. (It previously hardcoded `Mon…Sun`, so every label was wrong unless
> today happened to be Sunday.)

### Offline behaviour

A failed fetch sets `loadFailed` and shows a "Couldn't sync" banner with the
last successful sync time. This is deliberate: the fetch error used to be
swallowed, which rendered ₹0 earnings and 0 spots — indistinguishable from
genuinely having earned nothing. **A network failure must never look like
real money data.**

---

## Part 2 — The commission engine

`backend/src/services/CommissionService.js`. This is the only place the split
is decided.

### Base rate — by location

| Location type | Rate |
|---|---|
| `premium` | 25% |
| `urban` (default) | 20% |
| `rural` | 15% |

### Override — by price

Price rules **override** location entirely:

| Booking total | Rate |
|---|---|
| > ₹2,000 | 30% |
| ₹200 – ₹2,000 | location rate above |
| < ₹200 | 15% |

```
platformFee    = round(total × rate, 2)
spotterEarning = round(total − platformFee, 2)
```

**Worked example.** ₹100 booking at an urban spot: ₹100 < ₹200, so the price
rule wins → 15%, not 20%. Platform ₹15, Spotter ₹85.

### Known sharp edges

- **Cliff at the boundaries.** A ₹199 booking is charged 15% (fee ₹29.85,
  spotter keeps ₹169.15). A ₹201 booking is charged 20% (fee ₹40.20, spotter
  keeps ₹160.80). *The Spotter earns less on the larger booking.* Same cliff at
  ₹2,000. A tapered/marginal rate would remove this.
- **Rates are hardcoded.** Changing commission requires a code deploy.
- **No GST handling.** The platform fee is treated as net revenue.

---

## Part 3 — How money actually moves

The single most important rule, enforced in
`BookingSettlementService.settleCompletedBooking()`:

> **Never pay a Spotter before the money is actually collected.**

Online bookings only settle when `payment_status === 'paid'`. This closed a
real bug where payouts could be queued for bookings that were never paid.

There are **four** ways a booking ends, and each moves money differently.

---

### Path A — Online payment (the happy path)

Driver pays in-app via Razorpay. Money lands with ParkStop first.

```
Driver pays ₹100  ──►  ParkStop (holds full ₹100)
                            │
                  checkout + OTP verified
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
    ParkStop keeps ₹20           Payout queued: ₹80 → Spotter
      (platform fee)              (RazorpayX → their UPI/bank)
```

- Booking updated with `platform_fee` and `spotter_earning`
- A job is pushed to `payoutQueue` (BullMQ)
- The worker calls `PayoutService.processBookingPayout()` → RazorpayX Payouts
  API → money to the Spotter's linked account
- **Wallet effect: positive.** The Spotter is *owed* money.

---

### Path B — Cash payment

Driver hands cash to the Spotter. Money never touches ParkStop, so the fee
has to flow *backwards*.

```
Driver pays ₹100 cash  ──►  Spotter (holds ALL ₹100)
                                  │
                        checkout ("Cash collected")
                                  │
                    Spotter wallet −= ₹20  (fee now OWED)
```

- `balance: { decrement: platformFee }` on the Spotter
- **Wallet effect: negative.** The Spotter *owes* ParkStop.
- The Spotter already has their ₹80 — it's in their pocket, in cash

This sign inversion is the single most confusing thing about the system, and
the reason `/spotter/earnings` exists.

---

### Path C — Unpaid / arrears

Driver leaves without paying. `checkoutUnpaid` protects the Spotter and
chases the driver:

```
Spotter wallet  += ₹80   (paid their share regardless — not their fault)
Finder wallet   −= ₹100  (full amount becomes a debt)
booking.payment_status = 'unpaid_arrears'
```

The driver's debt is collected on their **next** booking:
`create-order` adds `arrears` to the amount charged
(`paymentController.js` — `finalAmountToCharge = total_price + arrears`).

> ⚠️ Note ParkStop absorbs its own ₹20 fee here — the Spotter is credited ₹80
> but nothing was collected. Recovery happens when the Finder next pays.

---

### Path D — Settlement failure

If any of the above throws, `handleSettlementFailure` runs so earnings are
never silently lost:

1. Write a `payouts` row with `status: 'failed_needs_retry'` for manual review
2. **Credit the Spotter's wallet anyway** as a fallback
3. Emit `payout:pending` over the socket so the app explains the delay

---

## Part 4 — The wallet, in plain terms

One number: `users.balance`.

| Balance | Meaning |
|---|---|
| **Positive** | ParkStop owes the Spotter (online earnings, arrears credits, failed-payout fallbacks) |
| **Negative** | The Spotter owes ParkStop (accumulated cash-booking fees) |

### Dues are deducted, not billed

There is no invoice. The fee is deducted from the wallet the moment a cash
booking is checked out. The dashboard shows the running total as "Dues".

### The −₹500 cutoff

`ParkingSpot.js` filters spot listings on `u.balance >= -500`. Once a Spotter
owes more than ₹500, **their spots stop appearing to drivers entirely.** They
keep operating existing bookings but get no new ones until they pay.

The dashboard warns at this point: *"Spots hidden! Clear to reactivate."*

### Clearing dues

`POST /payments/create-dues-order` → Razorpay → `POST /payments/verify-dues`
→ balance credited back toward zero → spots become visible again.

---

## Part 5 — Check-in / check-out

Both directions use a 6-digit OTP compared with `crypto.timingSafeEqual`
(constant-time, so the comparison itself leaks nothing).

```
Driver books ──► check-in OTP issued
     │
Arrives, shows OTP ──► Spotter enters it ──► parked, timer starts
     │
Leaves, shows checkout OTP ──► Spotter enters it
     │
     └──► booking completed ──► settlement runs (Path A/B/C above)
```

The Spotter chooses the payment path at checkout — "Cash collected" triggers
Path B, an already-paid online booking follows Path A, and "unpaid" triggers
Path C.

---

## Part 6 — Full worked example

Urban spot, ₹500 booking, **online** payment.

| Step | Platform | Spotter wallet | Spotter cash |
|---|---|---|---|
| Driver pays ₹500 | +₹500 held | 0 | 0 |
| Commission (₹500 → 20%) | fee ₹100 | — | — |
| Payout queued | −₹400 | — | — |
| RazorpayX transfers | **keeps ₹100** | — | **+₹400 to bank** |

Same booking, **cash**:

| Step | Platform | Spotter wallet | Spotter cash |
|---|---|---|---|
| Driver pays ₹500 cash | 0 | 0 | +₹500 |
| Commission | — | — | — |
| Checkout "cash collected" | **owed ₹100** | **−₹100** | +₹500 |
| Spotter clears dues | **+₹100** | 0 | +₹500 |

Net position is identical (₹100 platform / ₹400 spotter) — only the direction
of travel differs.

---

## Part 7 — Verification status

**Unit tested and green** (124 backend tests):

- Commission split across all location tiers and price bands
- Cash checkout wallet deduction
- Arrears credit/debit
- Settlement gating on `payment_status === 'paid'`
- Settlement-failure fallback

**Verified once in production:** booking #76 — ₹5.00 = ₹0.75 + ₹4.25 (15% band).

**Not yet verified end-to-end** (needs two real accounts):

- [ ] Cash checkout → dues appear → clear dues → spots reappear
- [ ] Arrears carried onto a driver's next booking
- [ ] Online payout actually landing in a Spotter's bank via RazorpayX

---

## Appendix — Infrastructure

### Payout queue: confirm `REDIS_URL` is set

`jobs/queues.js` falls back to an in-memory queue when `REDIS_URL` is unset.
Payouts still execute, but **inline with the HTTP request and with no retry** —
the BullMQ path retries 3× with exponential backoff. A transient RazorpayX
failure would therefore drop straight to the manual-review path unnecessarily.

**How to check which mode you're in:**

```bash
curl https://<your-railway-domain>/health
```

```jsonc
// Healthy
{ "success": true, "database": "connected", "payout_queue": "bullmq" }

// Degraded — payouts have no retry
{ "success": true, "payout_queue": "inline",
  "degraded": ["payout_queue: running inline with no retry (REDIS_URL unset)"] }
```

**How to fix it on Railway:**

1. In your project → **New → Database → Add Redis**
2. Open the backend service → **Variables → New Variable → Add Reference**
3. Select the Redis service's `REDIS_URL`
4. Redeploy; `/health` should now report `"payout_queue": "bullmq"`

The app also logs an error line at boot in production when this is degraded,
and `REDIS_URL` is listed in `.env.example`.

> Until this is confirmed, treat every payout as unretried. Nothing is *lost*
> when it fails — `handleSettlementFailure` still credits the Spotter's wallet
> and files a `failed_needs_retry` payout — but it needs manual attention that
> a retry would have avoided.
