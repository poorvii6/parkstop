# ParkStop — Frontend (Mobile & Web)

Cross-platform app for the ParkStop parking marketplace, built with React Native and Expo.
Runs on **iOS, Android, and web** from a single codebase.

**Stack:** React Native 0.81, React 19, Expo SDK 54, expo-router (file-based routing),
TypeScript, MapLibre GL + Google Maps, Firebase (auth & push), Stripe + Razorpay SDKs,
Socket.IO client.

---

## Prerequisites

- **Node.js 20+**
- The **ParkStop backend** running and reachable (see `../backend/README.md`)
- For device testing: the **Expo Go** app, or a development build
- For native builds: Xcode (iOS) and/or Android Studio

---

## Setup

```bash
cd frontend

# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    Fill in the values. At minimum set EXPO_PUBLIC_API_URL to your backend
#    (e.g. http://localhost:3000/api/v1) plus the Firebase web config.

# 3. Start the dev server
npm run dev        # = npx expo start
```

From the Expo dev server you can open the app in:

- **Expo Go** (scan the QR code) — quickest, limited native modules
- an **Android emulator** (`npm run android`)
- an **iOS simulator** (`npm run ios`)
- the **web browser** (`npm run web`)

> Some features (background location, native Stripe, MapLibre) require a **development build**
> rather than Expo Go. See the [Expo development builds guide](https://docs.expo.dev/develop/development-builds/introduction/).

---

## Environment variables

Frontend env vars **must** be prefixed with `EXPO_PUBLIC_` to be readable in the app. The
template in [`.env.example`](.env.example) documents each one. Key variables:

- `EXPO_PUBLIC_API_URL` — **[REQUIRED]** the backend base URL (`.../api/v1`)
- `EXPO_PUBLIC_FIREBASE_*` — **[REQUIRED]** Firebase web config for auth
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` — for Google sign-in
- `EXPO_PUBLIC_STRIPE_KEY` — Stripe publishable key

---

## Scripts

| Command           | What it does                          |
| ----------------- | ------------------------------------- |
| `npm run dev`     | Start the Expo dev server             |
| `npm run android` | Open on an Android emulator/device    |
| `npm run ios`     | Open on an iOS simulator/device       |
| `npm run web`     | Run in the browser                    |
| `npm run build`   | Export the web build                  |

---

## Project structure

```
frontend/
├── app/                     # Screens — file-based routes (expo-router)
│   ├── _layout.tsx          # Root layout / navigation
│   ├── index.tsx            # Entry / splash
│   ├── welcome.tsx          # Onboarding
│   ├── login.tsx            # Auth
│   ├── register.tsx
│   ├── role-selection.tsx   # Choose Finder / Spotter
│   ├── finder/              # Finder (driver) experience — map, booking, checkout
│   ├── spotter/             # Spotter (owner) experience — spots, verify, payouts, support
│   └── admin/               # Admin views
├── components/              # Reusable UI (maps, search, themed primitives)
├── services/                # API client, Firebase, notifications, location, offline cache
├── hooks/                   # Custom hooks (location tracking, theming, color scheme)
├── constants/               # Theme & design tokens
└── assets/                  # Images, icons, fonts
```

Routing is **file-based**: files under `app/` become routes automatically. Folders like
`finder/` and `spotter/` group each role's screens.

---

## Talking to the backend

- **REST** requests go through the shared Axios client (`services/`), using
  `EXPO_PUBLIC_API_URL` and attaching the Firebase ID token as a `Bearer` header.
- **Realtime** uses the Socket.IO client, connecting to the same host with the `/api/v1`
  suffix stripped, for live booking and location events.

---

## Troubleshooting

- **Network request failed / can't reach API** — on a physical device, `localhost` points at
  the phone, not your computer. Use your machine's LAN IP (or an ngrok/tunnel URL) in
  `EXPO_PUBLIC_API_URL`.
- **Env changes not picked up** — restart the Expo dev server after editing `.env`.
- **Native module missing in Expo Go** — build a development build instead.
