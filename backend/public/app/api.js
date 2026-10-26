/* ParkStop web — connection to the real ParkStop server.
 * Same server, same Firebase project and same rules as the mobile app.
 * Exposes window.PSApi. */
(function () {
  const API = window.PS_API_BASE || '/api/v1';
  const FIREBASE = {
    apiKey: 'AIzaSyBzkuA20rExAVvmQgWUIc-NC88WVG43FI8',
    authDomain: 'parkstop-1bd22.firebaseapp.com',
    projectId: 'parkstop-1bd22',
    storageBucket: 'parkstop-1bd22.firebasestorage.app',
    messagingSenderId: '1004284557988',
    appId: '1:1004284557988:web:399f00601a0904e47c8431',
  };

  // ---------------- auth (Firebase) ----------------
  // window.__PS_FAKE_AUTH__ is only set by the automated browser tests.
  let auth = window.__PS_FAKE_AUTH__ || null;
  if (!auth) {
    const fb = window.firebase;
    const app = fb.apps.length ? fb.app() : fb.initializeApp(FIREBASE);
    const a = app.auth();
    a.setPersistence(fb.auth.Auth.Persistence.LOCAL).catch(() => {});
    auth = {
      current: () => a.currentUser,
      onChange: (cb) => a.onAuthStateChanged(cb),
      signIn: (email, pw) => a.signInWithEmailAndPassword(email, pw).then((c) => c.user),
      signUp: (email, pw) => a.createUserWithEmailAndPassword(email, pw).then((c) => c.user),
      google: () => { const p = new fb.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); return a.signInWithPopup(p).then((c) => c.user); },
      resetPassword: (email) => a.sendPasswordResetEmail(email),
      signOut: () => a.signOut(),
      token: (force) => (a.currentUser ? a.currentUser.getIdToken(!!force) : Promise.resolve(null)),
    };
  }

  /** Plain-English text for Firebase sign-in errors. */
  function authMessage(e) {
    const c = (e && e.code) || '';
    const map = {
      'auth/invalid-credential': 'Wrong email or password.',
      'auth/wrong-password': 'Wrong email or password.',
      'auth/user-not-found': 'No account with this email. Create one first.',
      'auth/invalid-email': 'Please enter a valid email address.',
      'auth/email-already-in-use': 'An account already exists with this email. Please sign in.',
      'auth/weak-password': 'Password must be at least 6 characters.',
      'auth/too-many-requests': 'Too many tries. Please wait a few minutes and try again.',
      'auth/network-request-failed': 'No internet connection. Check your network and try again.',
      'auth/popup-closed-by-user': 'Google sign-in was closed before it finished.',
      'auth/popup-blocked': 'Your browser blocked the Google pop-up. Allow pop-ups for this site and try again.',
      'auth/unauthorized-domain': 'Google sign-in is not enabled for this web address yet. Use email and password, or add this domain in Firebase.',
    };
    return map[c] || (e && e.message) || 'Something went wrong. Please try again.';
  }

  // ---------------- REST ----------------
  let onSessionLost = () => {};
  const HANDSHAKE = ['/auth/social-login', '/auth/register', '/auth/login', '/auth/send-otp', '/auth/verify-otp'];

  class ApiError extends Error {
    constructor(message, status, body) { super(message); this.status = status; this.body = body || {}; this.code = this.body.code; }
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    const headers = {};
    let token = null;
    try { token = await auth.token(); } catch (e) {}
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(API + path, { method, headers, body: payload });
      } catch (e) {
        throw new ApiError('Cannot reach ParkStop. Check your internet connection and try again.', 0);
      }
      // Railway wakes up from sleep with 502/503 — retry once.
      if ((res.status === 502 || res.status === 503) && attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      break;
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || data.success === false) {
      const msg = data.message || (data.errors && data.errors[0] && (data.errors[0].msg || data.errors[0].message)) || `Request failed (${res.status})`;
      if (res.status === 401 && !HANDSHAKE.some((h) => path.indexOf(h) === 0) && !opts.noSessionCheck) onSessionLost(msg);
      throw new ApiError(msg, res.status, data);
    }
    return data;
  }
  const api = {
    get: (p, o) => request('GET', p, undefined, o),
    post: (p, b, o) => request('POST', p, b === undefined ? {} : b, o),
    put: (p, b, o) => request('PUT', p, b === undefined ? {} : b, o),
    del: (p, o) => request('DELETE', p, undefined, o),
  };

  // ---------------- realtime (Socket.IO, same token as REST) ----------------
  let socket = null;
  const handlers = {};
  function connectRealtime() {
    if (socket || !window.io || !auth.current()) return;
    const origin = API.indexOf('http') === 0 ? API.replace(/\/api\/v1\/?$/, '') : window.location.origin;
    socket = window.io(origin, {
      transports: ['websocket'],
      auth: (cb) => { auth.token().then((t) => cb({ token: t })).catch(() => cb({})); },
      reconnection: true, reconnectionAttempts: 20, reconnectionDelay: 2000,
    });
    Object.keys(handlers).forEach((ev) => handlers[ev].forEach((fn) => socket.on(ev, fn)));
  }
  function onRealtime(ev, fn) {
    (handlers[ev] = handlers[ev] || []).push(fn);
    if (socket) socket.on(ev, fn);
    return () => { handlers[ev] = (handlers[ev] || []).filter((x) => x !== fn); if (socket) socket.off(ev, fn); };
  }
  function disconnectRealtime() { if (socket) { socket.disconnect(); socket = null; } }

  // ---------------- Razorpay checkout (web) ----------------
  let rzpLoading = null;
  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    if (rzpLoading) return rzpLoading;
    rzpLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.onload = () => resolve();
      s.onerror = () => { rzpLoading = null; reject(new Error('Could not load the payment window. Check your internet and try again.')); };
      document.head.appendChild(s);
    });
    return rzpLoading;
  }

  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v));

  window.PSApi = { api, auth, authMessage, ApiError, onRealtime, connectRealtime, disconnectRealtime, loadRazorpay, num, setOnSessionLost: (f) => { onSessionLost = f; } };
})();
