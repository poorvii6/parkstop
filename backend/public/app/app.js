(function () {
  const { h, render } = window.preact;
  const { useState, useEffect, useMemo, useRef, useCallback } = window.preactHooks;
  const html = window.htm.bind(h);
  const { api, auth, authMessage, onRealtime, connectRealtime, disconnectRealtime, loadRazorpay, num } = window.PSApi;
  const { MapView } = window.PSMap;

  // ---------------- helpers ----------------
  const inr = (n) => { const v = num(n); return '₹' + v.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: v % 1 ? 2 : 0 }); };
  const time = (t) => (t ? new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '—');
  const dateShort = (t) => (t ? new Date(t).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—');
  const dateTime = (t) => (t ? `${dateShort(t)}, ${time(t)}` : '—');
  const ago = (t) => { if (!t) return ''; const m = Math.round((Date.now() - new Date(t).getTime()) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const hh = Math.round(m / 60); if (hh < 24) return hh + ' h ago'; return Math.round(hh / 24) + ' d ago'; };
  const pad = (n) => String(n).padStart(2, '0');
  const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`; };
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
  const initials = (n) => String(n || '?').trim().split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
  const ts = (t) => (t ? new Date(t).getTime() : 0);
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }, del(k) { try { localStorage.removeItem(k); } catch (e) {} } };
  const firstName = (u) => String((u && (u.full_name || u.name)) || '').split(' ')[0] || 'there';
  const OPEN = ['reserved', 'active', 'checkout_pending'];

  /** The booking the driver must deal with first (same rule as the app). */
  function openBookingOf(list) {
    const now = Date.now();
    return (list || []).find((b) => {
      if (b.status === 'active' || b.status === 'checkout_pending') return true;
      if (b.status === 'completed') return b.payment_mode !== 'cash' && b.payment_status !== 'paid';
      if (b.status === 'reserved') return !b.otp_expires_at || ts(b.otp_expires_at) > now - 60000;
      return false;
    }) || null;
  }

  const AREAS = [
    { name: 'MG Road', lat: 12.9757, lng: 77.6050 }, { name: 'Indiranagar', lat: 12.9719, lng: 77.6412 },
    { name: 'Koramangala', lat: 12.9352, lng: 77.6245 }, { name: 'HSR Layout', lat: 12.9116, lng: 77.6474 },
    { name: 'Jayanagar', lat: 12.9250, lng: 77.5838 }, { name: 'Malleshwaram', lat: 13.0031, lng: 77.5700 },
    { name: 'Hebbal', lat: 13.0358, lng: 77.5970 }, { name: 'Whitefield', lat: 12.9698, lng: 77.7500 },
    { name: 'Electronic City', lat: 12.8452, lng: 77.6602 }, { name: 'Hennur', lat: 13.0359, lng: 77.6430 },
  ];
  const HOME = { name: 'MG Road, Bengaluru', lat: 12.9757, lng: 77.6050 };

  // ---------------- icons ----------------
  const I = {
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.3-4.3', bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0',
    car: 'M5 13l1.6-4.6A2 2 0 0 1 8.5 7h7a2 2 0 0 1 1.9 1.4L19 13M4 13h16v4H4zM7 17v2M17 17v2', shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z M9 12l2 2 4-4',
    nav: 'M3 11l18-8-8 18-2-8z', check: 'M5 12l5 5 9-10', plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6 6 18', back: 'M15 6l-6 6 6 6',
    key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v2h3v-2h2.1A4 4 0 0 1 15 7z', moon: 'M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z', out: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
    locate: 'M12 2v3M12 19v3M2 12h3M19 12h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', refresh: 'M4 4v6h6M20 20v-6h-6M5 10a7 7 0 0 1 12-3l3 3M19 14a7 7 0 0 1-12 3l-3-3',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4', swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
    google: 'M21 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5a4.3 4.3 0 0 1-1.9 2.8v2.3h3A9 9 0 0 0 21 12.2zM12 21a8.8 8.8 0 0 0 6.1-2.2l-3-2.3a5.5 5.5 0 0 1-8.2-2.9H3.8v2.4A9 9 0 0 0 12 21zM6.9 13.6a5.4 5.4 0 0 1 0-3.4V7.8H3.8a9 9 0 0 0 0 8.2zM12 6.6a4.9 4.9 0 0 1 3.5 1.4l2.6-2.6A8.8 8.8 0 0 0 3.8 7.8l3.1 2.4A5.4 5.4 0 0 1 12 6.6z',
  };
  const Icon = ({ n, size = 18 }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${I[n]} /></svg>`;

  // ---------------- toasts ----------------
  let pushToast = () => {};
  const toast = (msg, kind) => pushToast(msg, kind);
  function Toasts() {
    const [list, setList] = useState([]);
    useEffect(() => { pushToast = (msg, kind) => { const id = Math.random(); setList((l) => [...l.slice(-3), { id, msg, kind }]); setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 4200); }; }, []);
    return html`<div class="toasts" role="status" aria-live="polite">${list.map((t) => html`<div class=${'toast ' + (t.kind || '')}>${t.msg}</div>`)}</div>`;
  }
  /** Run a server call; show its message if it fails. Returns null on failure. */
  async function attempt(fn, okMsg) {
    try { const r = await fn(); if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg); return r; }
    catch (e) { toast(e.message || 'Something went wrong. Please try again.', 'bad'); return null; }
  }
  function useNow(ms) { const [n, set] = useState(Date.now()); useEffect(() => { const t = setInterval(() => set(Date.now()), ms || 1000); return () => clearInterval(t); }, [ms]); return n; }
  /** Load data, keep it fresh on an interval and on realtime events. */
  function useLive(loader, deps, opts) {
    opts = opts || {};
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const ref = useRef(loader); ref.current = loader;
    const reload = useCallback(async () => {
      try { const d = await ref.current(); setData(d); setError(null); return d; }
      catch (e) { setError(e.message || 'Could not load'); return null; }
    }, []);
    useEffect(() => {
      reload();
      const t = opts.every ? setInterval(reload, opts.every) : null;
      const offs = (opts.events || []).map((ev) => onRealtime(ev, () => reload()));
      return () => { t && clearInterval(t); offs.forEach((f) => f()); };
    }, deps || []);
    return [data, reload, error, setData];
  }
  const Busy = ({ label }) => html`<div class="empty"><div class="spinner"></div>${label || 'Loading…'}</div>`;
  const ErrorBox = ({ msg, retry }) => html`<div class="empty">${msg}${retry && html`<div><button class="btn sm" style="margin-top:10px" onClick=${retry}>Try again</button></div>`}</div>`;

  // ---------------- spot photo ----------------
  function SpotPhoto({ sp, cls }) {
    const img = Array.isArray(sp.images) && sp.images.find((x) => typeof x === 'string' && x.indexOf('http') === 0);
    if (img) return html`<div class=${'photo ' + (cls || '')}><img src=${img} alt="" loading="lazy" /></div>`;
    const hue = (Number(sp.id) * 47) % 360;
    const lines = Math.max(2, Math.min(num(sp.total_slots) || 4, 6));
    return html`<div class=${'photo ' + (cls || '')} style=${`background: linear-gradient(160deg, hsl(${hue} 22% 26%), hsl(${(hue + 40) % 360} 18% 13%))`}>
      <svg class="bays" viewBox="0 0 120 80" preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y="0" width="120" height="80" fill="rgba(0,0,0,0.18)" />
        ${Array.from({ length: lines + 1 }, (_, i) => html`<line x1=${10 + (i * 100) / lines} y1="22" x2=${4 + (i * 112) / lines} y2="80" stroke="rgba(255,255,255,0.55)" stroke-width="1.4" />`)}
        <line x1="10" y1="22" x2="110" y2="22" stroke="rgba(255,255,255,0.55)" stroke-width="1.4" />
        <rect x="8" y="5" width="12" height="12" rx="2" fill="#2160e0" stroke="#fff" stroke-width="1" />
        <text x="14" y="14.5" text-anchor="middle" font-size="9" font-weight="800" fill="#fff" font-family="Archivo, Arial">P</text>
      </svg>
    </div>`;
  }

  // ---------------- place search (server: Google Places / Ola / OSM) ----------------
  function PlaceSearch({ near, onPick, placeholder, id }) {
    const [q, setQ] = useState('');
    const [res, setRes] = useState([]);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const seq = useRef(0);
    useEffect(() => {
      if (q.trim().length < 3) { setRes([]); return; }
      const my = ++seq.current;
      const t = setTimeout(async () => {
        setBusy(true);
        try {
          const r = await api.get(`/maps/search?q=${encodeURIComponent(q.trim())}&lat=${near.lat}&lon=${near.lng}`);
          if (my === seq.current) setRes(Array.isArray(r.data) ? r.data.slice(0, 6) : []);
        } catch (e) { if (my === seq.current) setRes([]); }
        if (my === seq.current) setBusy(false);
      }, 350);
      return () => clearTimeout(t);
    }, [q]);
    const label = (r) => r.display_name || (r.address && [r.address.name, r.address.city].filter(Boolean).join(', ')) || r.name || 'Place';
    const choose = async (r) => {
      setOpen(false); setQ(label(r).split(',')[0]);
      let lat = Number(r.lat), lng = Number(r.lon != null ? r.lon : r.lng);
      if ((!lat || !lng) && r.place_id) {
        try { const d = await api.get(`/maps/place-details?place_id=${encodeURIComponent(r.place_id)}`); if (d.data) { lat = Number(d.data.lat); lng = Number(d.data.lon); } } catch (e) {}
      }
      if (!lat || !lng) {
        try { const g = await api.get(`/maps/geocode?q=${encodeURIComponent(label(r))}`); if (g.data) { lat = Number(g.data.lat); lng = Number(g.data.lon); } } catch (e) {}
      }
      if (!lat || !lng) { toast('Could not find that place on the map. Try another name.', 'bad'); return; }
      onPick({ lat, lng, name: label(r).split(',')[0], address: label(r) });
    };
    return html`<div class="searchbox">
      <${Icon} n="search" />
      <input id=${id || 'search'} class="input" placeholder=${placeholder || 'Where are you going?'} value=${q} autocomplete="off"
        onInput=${(e) => { setQ(e.target.value); setOpen(true); }} onFocus=${() => setOpen(true)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); if (res[0]) choose(res[0]); } if (e.key === 'Escape') setOpen(false); }} />
      ${open && q.trim().length >= 3 && html`<div class="suggest">
        ${busy && !res.length ? html`<div class="faint" style="padding:10px 12px;font-size:13px">Searching…</div>` : null}
        ${!busy && !res.length ? html`<div class="faint" style="padding:10px 12px;font-size:13px">No places found</div>` : null}
        ${res.map((r) => html`<button type="button" onClick=${() => choose(r)}><${Icon} n="nav" size=${15} /><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label(r)}</span></button>`)}
      </div>`}
    </div>`;
  }
  /** Live GPS position from the browser (null until the first fix or if blocked). */
  function useGps() {
    const [pos, setPos] = useState(null);
    const [status, setStatus] = useState('waiting'); // waiting | ok | blocked | unsupported
    useEffect(() => {
      if (!navigator.geolocation) { setStatus('unsupported'); return; }
      const id = navigator.geolocation.watchPosition(
        (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, name: 'your location' }); setStatus('ok'); },
        () => setStatus('blocked'),
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
      return () => navigator.geolocation.clearWatch(id);
    }, []);
    return [pos, status];
  }
  function locateMe() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Your browser cannot share location.'));
      navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, name: 'your location' }),
        () => reject(new Error('Location is blocked. Allow location for this site, or search for a place.')), { enableHighAccuracy: true, timeout: 10000 });
    });
  }

  // ---------------- top bar ----------------
  const ROLE_LABEL = { driver: 'Driver', owner: 'Spot owner', admin: 'Admin' };
  function Notifications({ onClose }) {
    const [data, reload] = useLive(() => api.get('/notifications').then((r) => r.data), []);
    useEffect(() => { if (data && data.unread) api.post('/notifications/read', {}).catch(() => {}); }, [data && data.unread]);
    return html`<div class="drawer" role="dialog" aria-label="Notifications">
      <div class="card-h"><h2>Notifications</h2><button class="iconbtn" style="width:30px;height:30px" onClick=${onClose} aria-label="Close"><${Icon} n="x" size=${16} /></button></div>
      ${!data ? html`<${Busy} />` : data.items.length ? data.items.map((n) => html`<div class="note-item"><b>${n.title}</b>${n.body}<br /><small>${ago(n.created_at)}</small></div>`) : html`<div class="empty">No notifications yet.</div>`}
    </div>`;
  }
  function TopBar({ user, view, go, signOut }) {
    const [open, setOpen] = useState(null);
    const [unread, setUnread] = useState(0);
    useEffect(() => {
      let alive = true;
      const load = () => api.get('/notifications').then((r) => alive && setUnread(r.data.unread || 0)).catch(() => {});
      load(); const t = setInterval(load, 30000);
      const offs = ['booking:new', 'booking:checkout_requested', 'booking:checkedin', 'booking:checkout_confirmed', 'booking:paid'].map((e) => onRealtime(e, load));
      return () => { alive = false; clearInterval(t); offs.forEach((f) => f()); };
    }, []);
    const isAdmin = String(user.role).toUpperCase() === 'ADMIN';
    const toggleTheme = () => {
      const r = document.documentElement; const cur = r.getAttribute('data-theme');
      const sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      const next = cur ? (cur === 'dark' ? 'light' : 'dark') : (sysLight ? 'dark' : 'light');
      r.setAttribute('data-theme', next); ls.set('ps-theme', next); setOpen(null);
    };
    const views = isAdmin ? ['admin'] : ['driver', 'owner'];
    return html`<header class="topbar">
      <a class="brand" href="#/" onClick=${(e) => { e.preventDefault(); go(isAdmin ? 'admin' : view); }}><span class="psign">P</span>ParkStop</a>
      ${views.length > 1 && html`<nav class="roles" aria-label="Switch mode">${views.map((r) => html`<button aria-pressed=${view === r} onClick=${() => go(r)}>${ROLE_LABEL[r]}</button>`)}</nav>`}
      <div class="spacer"></div>
      <button class="iconbtn" aria-label=${`Notifications, ${unread} unread`} onClick=${() => { setOpen(open === 'notes' ? null : 'notes'); setUnread(0); }}>
        <${Icon} n="bell" />${unread ? html`<span class="badge">${unread > 9 ? '9+' : unread}</span>` : null}
      </button>
      <div class="who" style="position:relative">
        <button class="iconbtn" style="width:auto;padding:0 10px 0 4px;gap:8px;display:flex" onClick=${() => setOpen(open === 'menu' ? null : 'menu')} aria-label="Account menu">
          <span class="avatar">${initials(user.full_name || user.name || user.email)}</span><div style="text-align:left"><b>${user.full_name || user.name || user.email}</b><small>${isAdmin ? 'Admin' : ROLE_LABEL[view]}</small></div>
        </button>
        ${open === 'menu' && html`<div class="menu">
          <div class="faint" style="padding:8px 12px;font-size:12.5px;word-break:break-all">${user.email}</div>
          <button onClick=${toggleTheme}><${Icon} n="moon" />Switch light / dark</button>
          <hr />
          <button onClick=${() => { setOpen(null); signOut(); }}><${Icon} n="out" />Sign out</button>
        </div>`}
      </div>
      ${open === 'notes' && html`<${Notifications} onClose=${() => setOpen(null)} />`}
    </header>`;
  }

  // ---------------- sign in / create account ----------------
  function HeroCanvas() {
    const ref = useRef(null);
    useEffect(() => {
      const c = ref.current; if (!c) return;
      const draw = () => {
        const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        c.width = r.width * dpr; c.height = r.height * dpr;
        const g = c.getContext('2d'); g.scale(dpr, dpr);
        const light = getComputedStyle(document.documentElement).getPropertyValue('color-scheme').includes('light');
        g.strokeStyle = light ? 'rgba(18,21,27,0.10)' : 'rgba(236,238,242,0.08)'; g.lineWidth = 2;
        const bw = 64, rows = [r.height * 0.58, r.height * 0.84];
        rows.forEach((y, ri) => { g.beginPath(); g.moveTo(0, y); g.lineTo(r.width, y); g.stroke(); for (let x = (ri ? 32 : 0); x < r.width + bw; x += bw) { g.beginPath(); g.moveTo(x, y - 86); g.lineTo(x, y); g.stroke(); } });
        const hx = Math.floor(r.width * 0.80 / bw) * bw, hy = rows[0];
        g.fillStyle = light ? 'rgba(232,86,26,0.12)' : 'rgba(255,107,44,0.16)'; g.fillRect(hx + 2, hy - 86, bw - 4, 84);
        g.strokeStyle = light ? 'rgba(232,86,26,0.9)' : 'rgba(255,107,44,0.9)'; g.strokeRect(hx + 2, hy - 86, bw - 4, 84);
      };
      draw(); window.addEventListener('resize', draw);
      return () => window.removeEventListener('resize', draw);
    }, []);
    return html`<canvas ref=${ref} aria-hidden="true"></canvas>`;
  }

  function CodeInput({ value, onChange, autoFocus }) {
    const refs = useRef([]);
    const digits = Array.from({ length: 6 }, (_, i) => value[i] || '');
    useEffect(() => { if (autoFocus && refs.current[0]) refs.current[0].focus(); }, []);
    const setAt = (i, v) => {
      const d = v.replace(/\D/g, '');
      if (d.length > 1) { const s = d.slice(0, 6); onChange(s); const k = Math.min(5, s.length - 1); refs.current[k] && refs.current[k].focus(); return; }
      const arr = digits.slice(); arr[i] = d; onChange(arr.join('').slice(0, 6));
      if (d && i < 5) refs.current[i + 1].focus();
    };
    return html`<div class="otp" role="group" aria-label="6-digit code">
      ${digits.map((d, i) => html`<input id=${'otp' + i} inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label=${'Digit ' + (i + 1)} value=${d}
        ref=${(x) => (refs.current[i] = x)} onInput=${(e) => setAt(i, e.target.value)}
        onKeyDown=${(e) => { if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1].focus(); }} />`)}
    </div>`;
  }

  /** Email code step. verify(code) does the server call; resend() asks for a new code. */
  function OtpStep({ email, verify, resend, onBack, title, note }) {
    const [code, setCode] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const [wait, setWait] = useState(60);
    useEffect(() => { const t = setInterval(() => setWait((w) => (w > 0 ? w - 1 : 0)), 1000); return () => clearInterval(t); }, []);
    const submit = async (e) => {
      e && e.preventDefault();
      if (code.length !== 6) { setErr('Enter all 6 digits from the email.'); return; }
      setBusy(true); setErr('');
      try { await verify(code); }
      catch (ex) { setErr(ex.message || 'That code did not work.'); if (ex.status === 429) setWait(0); setCode(''); }
      setBusy(false);
    };
    useEffect(() => { if (code.length === 6 && !busy) submit(); }, [code]);
    return html`<form class="panel" onSubmit=${submit} style="gap:16px">
      <button type="button" class="back" onClick=${onBack}><${Icon} n="back" />Back</button>
      <div><h2 style="font-size:24px">${title || 'Check your email'}</h2><p class="muted">We sent a 6-digit code to <b>${email}</b>. ${note || 'Every sign-in needs a new code.'}</p></div>
      <${CodeInput} value=${code} onChange=${(v) => { setCode(v); setErr(''); }} autoFocus=${true} />
      ${err && html`<p class="error">${err}</p>`}
      <button class="btn primary block" type="submit" disabled=${busy}>${busy ? 'Checking…' : 'Verify and continue'}</button>
      <p class="note">Did not get it? Check spam.${' '}
        ${wait > 0 ? html`<span>You can ask for a new code in ${wait}s.</span>` : html`<button type="button" class="linkbtn" onClick=${async () => { try { await resend(); setWait(60); toast('New code sent'); } catch (ex) { toast(ex.message, 'bad'); } }}>Send a new code</button>`}
      </p>
    </form>`;
  }

  function Field({ label, id, children, hint }) {
    return html`<div class="field"><label for=${id}>${label}</label>${children}${hint ? html`<small class="faint" style="font-size:12px">${hint}</small>` : null}</div>`;
  }

  function SignIn({ flow, onDone, switchTo }) {
    const [email, setEmail] = useState('');
    const [pw, setPw] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [otp, setOtp] = useState(null); // { email, token }
    const startOtp = async (fbUser, role) => {
      const r = await api.post('/auth/social-login', role ? { email: fbUser.email, token: await auth.token(), role } : { email: fbUser.email, token: await auth.token() });
      if (!(r.requires_otp && r.pending_login_token)) throw new Error(r.message || 'Could not start email verification. Please try again.');
      setOtp({ email: (r.data && r.data.user && r.data.user.email) || fbUser.email, token: r.pending_login_token });
    };
    const fail = async (e) => { flow.end(); await auth.signOut().catch(() => {}); setErr(e.code ? authMessage(e) : (e.message || 'Sign-in failed.')); };
    const submit = async (e) => {
      e.preventDefault(); setErr('');
      if (!email || !pw) { setErr('Enter your email and password.'); return; }
      setBusy(true); flow.begin();
      try { const u = await auth.signIn(email.trim(), pw); await startOtp(u); } catch (ex) { await fail(ex); }
      setBusy(false);
    };
    const google = async () => {
      setErr(''); setBusy(true); flow.begin();
      try { const u = await auth.google(); await startOtp(u); } catch (ex) { await fail(ex); }
      setBusy(false);
    };
    if (otp) return html`<${OtpStep} email=${otp.email}
      onBack=${async () => { setOtp(null); flow.end(); await auth.signOut().catch(() => {}); }}
      resend=${async () => { const r = await api.post('/auth/social-login', { email: otp.email, token: await auth.token() }); setOtp({ ...otp, token: r.pending_login_token }); }}
      verify=${async (code) => { const r = await api.post('/auth/login/verify-otp', { email: otp.email, code, pending_login_token: otp.token }); await onDone(r.data && r.data.user); }} />`;
    return html`<form class="panel" onSubmit=${submit} style="gap:14px">
      <div><p class="eyebrow">Welcome back</p><h2 style="font-size:26px;margin-top:6px">Sign in to ParkStop</h2></div>
      <${Field} label="Email" id="si-email"><input id="si-email" class="input" type="email" autocomplete="email" value=${email} onInput=${(e) => setEmail(e.target.value)} /><//>
      <${Field} label="Password" id="si-pw"><input id="si-pw" class="input" type="password" autocomplete="current-password" value=${pw} onInput=${(e) => setPw(e.target.value)} /><//>
      ${err && html`<p class="error">${err}</p>`}
      <button class="btn primary block" type="submit" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
      <div class="or"><span>or</span></div>
      <button class="btn block" type="button" onClick=${google} disabled=${busy}><${Icon} n="google" />Continue with Google</button>
      <div class="inline" style="justify-content:space-between">
        <button type="button" class="linkbtn" onClick=${async () => { if (!email) { setErr('Type your email first, then tap Forgot password.'); return; } try { await auth.resetPassword(email.trim()); toast('Password reset link sent to ' + email.trim()); } catch (ex) { setErr(authMessage(ex)); } }}>Forgot password?</button>
        <span class="muted" style="font-size:14px">New here? <button type="button" class="linkbtn" onClick=${switchTo}>Create an account</button></span>
      </div>
    </form>`;
  }

  function Register({ flow, onDone, switchTo }) {
    const [f, setF] = useState({ name: '', email: '', phone: '', pw: '', pw2: '', role: 'FINDER', agree: false });
    const set = (k, v) => setF({ ...f, [k]: v });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [stage, setStage] = useState('form'); // form | code | google-code
    const [pending, setPending] = useState(null);
    const check = () => {
      if (f.name.trim().length < 2) return 'Please enter your full name.';
      if (!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(f.email.trim())) return 'Please use a Gmail address (ending in @gmail.com).';
      if (!/^(?:\+91|91)?[6-9]\d{9}$/.test(f.phone.replace(/\s/g, ''))) return 'Please enter a valid 10-digit Indian mobile number.';
      if (f.pw.length < 6) return 'Password must be at least 6 characters.';
      if (f.pw !== f.pw2) return 'The two passwords do not match.';
      if (!f.agree) return 'Please accept the Terms and Privacy Policy.';
      return '';
    };
    const sendCode = async (e) => {
      e && e.preventDefault();
      const m = check(); if (m) { setErr(m); return; }
      setErr(''); setBusy(true);
      try { await api.post('/auth/send-otp', { email: f.email.trim() }); setStage('code'); } catch (ex) { setErr(ex.message); }
      setBusy(false);
    };
    const finish = async (code) => {
      const v = await api.post('/auth/verify-otp', { email: f.email.trim(), code });
      if (!v.otp_token) throw new Error('Could not verify the code. Please try again.');
      flow.begin();
      let fbUser = null;
      try {
        fbUser = await auth.signUp(f.email.trim(), f.pw);
        const token = await auth.token();
        try {
          const r = await api.post('/auth/register', { name: f.name.trim(), email: f.email.trim(), phone: f.phone.replace(/\s/g, ''), role: f.role, firebase_token: token, otp_token: v.otp_token });
          await onDone(r.data && r.data.user, f.role === 'SPOTTER' ? 'owner' : 'driver');
        } catch (be) { try { await fbUser.delete(); } catch (x) {} throw be; }
      } catch (ex) { flow.end(); await auth.signOut().catch(() => {}); setStage('form'); setErr(ex.code ? authMessage(ex) : ex.message); }
    };
    const google = async () => {
      setErr(''); setBusy(true); flow.begin();
      try {
        const u = await auth.google();
        const r = await api.post('/auth/social-login', { email: u.email, token: await auth.token(), role: f.role });
        if (!(r.requires_otp && r.pending_login_token)) throw new Error(r.message || 'Could not start email verification.');
        setPending({ email: u.email, token: r.pending_login_token }); setStage('google-code');
      } catch (ex) { flow.end(); await auth.signOut().catch(() => {}); setErr(ex.code ? authMessage(ex) : ex.message); }
      setBusy(false);
    };
    if (stage === 'code') return html`<${OtpStep} email=${f.email.trim()} title="Verify your Gmail" note="Enter it to create your account."
      onBack=${() => setStage('form')} resend=${() => api.post('/auth/send-otp', { email: f.email.trim() })} verify=${finish} />`;
    if (stage === 'google-code') return html`<${OtpStep} email=${pending.email}
      onBack=${async () => { setStage('form'); flow.end(); await auth.signOut().catch(() => {}); }}
      resend=${async () => { const r = await api.post('/auth/social-login', { email: pending.email, token: await auth.token(), role: f.role }); setPending({ ...pending, token: r.pending_login_token }); }}
      verify=${async (code) => { const r = await api.post('/auth/login/verify-otp', { email: pending.email, code, pending_login_token: pending.token }); await onDone(r.data && r.data.user, f.role === 'SPOTTER' ? 'owner' : 'driver'); }} />`;
    return html`<form class="panel" onSubmit=${sendCode} style="gap:12px">
      <div><p class="eyebrow">Join ParkStop</p><h2 style="font-size:26px;margin-top:6px">Create your account</h2></div>
      <div class="field"><label>I want to</label>
        <div class="seg">${[['FINDER', 'Find parking'], ['SPOTTER', 'Rent out my spot']].map(([k, t]) => html`<button type="button" aria-pressed=${f.role === k} onClick=${() => set('role', k)}>${t}</button>`)}</div></div>
      <${Field} label="Full name" id="rg-name"><input id="rg-name" class="input" autocomplete="name" value=${f.name} onInput=${(e) => set('name', e.target.value)} /><//>
      <div class="form-grid">
        <${Field} label="Gmail address" id="rg-email"><input id="rg-email" class="input" type="email" autocomplete="email" placeholder="you@gmail.com" value=${f.email} onInput=${(e) => set('email', e.target.value)} /><//>
        <${Field} label="Mobile number" id="rg-phone"><input id="rg-phone" class="input" inputmode="tel" autocomplete="tel" placeholder="98765 43210" value=${f.phone} onInput=${(e) => set('phone', e.target.value)} /><//>
        <${Field} label="Password" id="rg-pw"><input id="rg-pw" class="input" type="password" autocomplete="new-password" value=${f.pw} onInput=${(e) => set('pw', e.target.value)} /><//>
        <${Field} label="Confirm password" id="rg-pw2"><input id="rg-pw2" class="input" type="password" autocomplete="new-password" value=${f.pw2} onInput=${(e) => set('pw2', e.target.value)} /><//>
      </div>
      <label class="check"><input type="checkbox" checked=${f.agree} onChange=${(e) => set('agree', e.target.checked)} /> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></span></label>
      ${err && html`<p class="error">${err}</p>`}
      <button class="btn primary block" type="submit" disabled=${busy}>${busy ? 'Sending code…' : 'Continue'}</button>
      <div class="or"><span>or</span></div>
      <button class="btn block" type="button" onClick=${google} disabled=${busy}><${Icon} n="google" />Sign up with Google</button>
      <p class="muted" style="font-size:14px;text-align:center">Already have an account? <button type="button" class="linkbtn" onClick=${switchTo}>Sign in</button></p>
    </form>`;
  }

  function Gate({ flow, onDone }) {
    const [mode, setMode] = useState((location.hash || '').indexOf('register') !== -1 ? 'register' : 'signin');
    const [stats, setStats] = useState(null);
    useEffect(() => { api.get(`/spots/nearby?lat=${HOME.lat}&lng=${HOME.lng}&radius=25`, { noSessionCheck: true }).then((r) => setStats(r.data || [])).catch(() => {}); }, []);
    const bays = stats ? stats.reduce((a, s) => a + num(s.total_slots), 0) : null;
    return html`<main class="gate">
      <section class="gate-hero">
        <${HeroCanvas} />
        <div class="brand" style="font-size:22px"><span class="psign">P</span>ParkStop</div>
        <div style="display:flex;flex-direction:column;gap:18px">
          <h1>Spare bays, <em>booked by the hour.</em></h1>
          <p class="lede">Rent out an empty driveway or basement bay, or book one before you arrive. Verified owners, a PIN at the gate, and online payment when you leave.</p>
        </div>
        <div class="gate-stats">
          <div><b class="num">${stats ? stats.length : '—'}</b><span>verified spots in Bengaluru</span></div>
          <div><b class="num">${bays === null ? '—' : bays}</b><span>bays you can book</span></div>
          <div><b class="num">24×7</b><span>book anytime</span></div>
        </div>
      </section>
      <section class="gate-side">
        ${mode === 'signin' ? html`<${SignIn} flow=${flow} onDone=${onDone} switchTo=${() => setMode('register')} />` : html`<${Register} flow=${flow} onDone=${onDone} switchTo=${() => setMode('signin')} />`}
      </section>
    </main>`;
  }


  // ---------------- becoming / confirming a spot owner ----------------
  const ss = { get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }, del(k) { try { sessionStorage.removeItem(k); } catch (e) {} } };
  const ownerOkKey = (u) => 'ps-owner-ok:' + (u && u.id);
  const ageOn = (dob) => { const d = new Date(dob); if (isNaN(d)) return 0; const n = new Date(); let a = n.getFullYear() - d.getFullYear(); if (n.getMonth() < d.getMonth() || (n.getMonth() === d.getMonth() && n.getDate() < d.getDate())) a--; return a; };

  /**
   * Shown before the spot-owner screens open.
   * needDetails: first time as an owner — collect owner details (sent with switch-role).
   * needCode: confirm it is really the account holder with a fresh email code.
   */
  function OwnerGate({ user, needDetails, needCode, onDone, onCancel }) {
    const [step, setStep] = useState(needDetails ? 'details' : 'code');
    const [f, setF] = useState({ phone: user.phone || '', dob: '', address: user.address || '', own: false, terms: false });
    const set = (k, v) => setF({ ...f, [k]: v });
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const [pending, setPending] = useState(null);

    const finish = async () => {
      setBusy(true); setErr('');
      try {
        const body = { newRole: 'SPOTTER' };
        if (needDetails) body.registrationDetails = { phone: f.phone.replace(/\s/g, ''), dob: f.dob, address: f.address.trim() };
        const r = await api.post('/auth/switch-role', body);
        await onDone(r.data && r.data.user, needDetails);
      } catch (e) { setErr(e.message); setBusy(false); }
    };
    const askCode = async () => {
      const r = await api.post('/auth/social-login', { email: user.email, token: await auth.token() });
      if (!r.pending_login_token) throw new Error(r.message || 'Could not send the code. Please try again.');
      setPending(r.pending_login_token);
    };
    useEffect(() => {
      if (step !== 'code' || pending) return;
      askCode().catch((e) => setErr(e.message));
    }, [step]);

    const submitDetails = (e) => {
      e.preventDefault(); setErr('');
      if (!/^(?:\+91|91)?[6-9]\d{9}$/.test(f.phone.replace(/\s/g, ''))) return setErr('Enter a valid 10-digit Indian mobile number.');
      if (!f.dob) return setErr('Enter your date of birth.');
      if (ageOn(f.dob) < 18) return setErr('You must be 18 or older to rent out a parking space.');
      if (f.address.trim().length < 15) return setErr('Enter your full home address, with area and PIN code.');
      if (!f.own) return setErr('Please confirm you own this space or have permission to rent it out.');
      if (!f.terms) return setErr('Please accept the ParkStop owner terms.');
      if (needCode) setStep('code'); else finish();
    };

    const side = step === 'details'
      ? html`<form class="panel" onSubmit=${submitDetails} style="gap:12px">
          <button type="button" class="back" onClick=${onCancel}><${Icon} n="back" />Back</button>
          <div><p class="eyebrow">Step 1 of ${needCode ? 2 : 1} · Owner details</p><h2 style="font-size:24px;margin-top:6px">Become a spot owner</h2>
            <p class="muted" style="font-size:14px">We need a few details before you can list a space. Next you will verify your identity (Aadhaar, PAN, selfie, bank and property proof) before drivers can see your spots.</p></div>
          <${Field} label="Name on your account" id="ow-name"><input id="ow-name" class="input" value=${user.full_name || user.name || ''} disabled /><//>
          <div class="form-grid">
            <${Field} label="Mobile number" id="ow-phone"><input id="ow-phone" class="input" inputmode="tel" placeholder="98765 43210" value=${f.phone} onInput=${(e) => set('phone', e.target.value)} /><//>
            <${Field} label="Date of birth" id="ow-dob"><input id="ow-dob" class="input" type="date" max=${new Date().toISOString().slice(0, 10)} value=${f.dob} onInput=${(e) => set('dob', e.target.value)} /><//>
          </div>
          <${Field} label="Home address" id="ow-addr" hint="Your own address, as on your ID. You add each parking space's address later."><textarea id="ow-addr" class="input" rows="3" placeholder="House no., street, area, city, PIN code" value=${f.address} onInput=${(e) => set('address', e.target.value)}></textarea><//>
          <label class="check"><input type="checkbox" checked=${f.own} onChange=${(e) => set('own', e.target.checked)} /> <span>I own the parking space, or I have the owner's permission to rent it out.</span></label>
          <label class="check"><input type="checkbox" checked=${f.terms} onChange=${(e) => set('terms', e.target.checked)} /> <span>I agree to the ParkStop <a href="/terms" target="_blank" rel="noopener">owner terms</a>, including the 20% platform fee on each parking.</span></label>
          ${err && html`<p class="error">${err}</p>`}
          <button class="btn primary block" type="submit" disabled=${busy}>${busy ? 'Saving…' : needCode ? 'Continue' : 'Create my owner account'}</button>
        </form>`
      : html`<div class="stack" style="gap:14px">
          ${needDetails && html`<p class="eyebrow">Step 2 of 2 · Confirm it's you</p>`}
          ${pending ? html`<${OtpStep} email=${user.email} title="Confirm it's you"
              note=${needDetails ? 'Enter it to create your spot-owner account.' : 'Spot-owner screens show your earnings and bank details, so we confirm it is you first.'}
              onBack=${needDetails ? () => setStep('details') : onCancel}
              resend=${askCode}
              verify=${async (code) => { await api.post('/auth/login/verify-otp', { email: user.email, code, pending_login_token: pending }); await finish(); }} />`
            : err ? html`<div class="panel"><p class="error">${err}</p><div class="inline"><button class="btn" onClick=${onCancel}>Back</button><button class="btn primary" onClick=${() => { setErr(''); askCode().catch((e) => setErr(e.message)); }}>Try again</button></div></div>`
            : html`<${Busy} label="Sending a code to your email…" />`}
          ${err && pending && html`<p class="error">${err}</p>`}
        </div>`;
    return html`<main class="gate"><section class="gate-hero"><${HeroCanvas} />
        <div class="brand" style="font-size:22px"><span class="psign">P</span>ParkStop</div>
        <div style="display:flex;flex-direction:column;gap:18px"><h1>${needDetails ? html`Rent out your <em>empty bay.</em>` : html`Owner mode, <em>secured.</em>`}</h1>
          <p class="lede">${needDetails ? 'List a driveway or basement bay, check cars in with a PIN, and get paid to your bank. Every owner is verified before drivers can book.' : 'Your owner dashboard has your earnings, payouts and bank details. We ask for a fresh email code before opening it.'}</p></div>
        <div></div></section>
      <section class="gate-side">${side}</section></main>`;
  }

  function RolePick({ user, onPick }) {
    const [busy, setBusy] = useState(null);
    const cards = [
      { r: 'driver', icon: 'car', t: 'I need parking', d: 'Find a verified spot, book a bay and pay when you leave.' },
      { r: 'owner', icon: 'key', t: 'I have a spot to rent', d: 'Check cars in with a PIN, confirm checkouts, get paid to your bank.' },
    ];
    return html`<main class="gate"><section class="gate-hero"><${HeroCanvas} />
        <div class="brand" style="font-size:22px"><span class="psign">P</span>ParkStop</div>
        <div><h1>Hi ${firstName(user)}, <em>where to?</em></h1></div><div></div></section>
      <section class="gate-side">
        <div><p class="eyebrow">Choose a mode</p><h2 style="font-size:26px;margin-top:6px">How are you using ParkStop today?</h2></div>
        ${cards.map((c) => html`<button class="rolecard" disabled=${!!busy} onClick=${async () => { setBusy(c.r); await onPick(c.r); setBusy(null); }}>
          <span class="ic"><${Icon} n=${c.icon} size=${22} /></span><span style="flex:1"><b>${c.t}</b><small>${c.d}</small></span>${busy === c.r ? html`<span class="spinner sm"></span>` : null}
        </button>`)}
        <p class="note">You can switch between driver and spot owner any time from the top bar.</p>
      </section></main>`;
  }

  // ---------------- driver ----------------
  const spotView = (sp) => ({
    ...sp, id: Number(sp.id), lat: num(sp.latitude), lng: num(sp.longitude),
    rate: Math.round(num(sp.dynamic_price || sp.price_per_hour)), free: num(sp.available_slots), total: num(sp.total_slots), distance: num(sp.distance),
  });

  function SpotCard({ sp, on, onClick }) {
    return html`<button class=${'spotcard' + (on ? ' on' : '')} onClick=${onClick}>
      <${SpotPhoto} sp=${sp} cls="thumb" />
      <div style="min-width:0">
        <h3>${sp.title}</h3>
        <div class="meta"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px">${sp.address || 'Bengaluru'}</span><span>${sp.distance.toFixed(1)} km</span></div>
        <div class="meta" style="margin-top:6px">${sp.free > 0 ? html`<span class="chip ok">${sp.free} of ${sp.total} free</span>` : html`<span class="chip bad">Full</span>`}${num(sp.surge_multiplier) > 1 ? html`<span class="chip warn">Busy pricing</span>` : null}</div>
      </div>
      <div class="price"><b>₹${sp.rate}</b><small>per hour</small></div>
    </button>`;
  }

  function SpotDetail({ sp, onBack, onBooked }) {
    const [slots, reloadSlots] = useLive(() => api.get(`/spots/${sp.id}/slots`).then((r) => r.data || []), [sp.id], { every: 15000 });
    const [slot, setSlot] = useState('');
    const [hours, setHours] = useState(2);
    const hasBike = num(sp.bike_slots) > 0;
    const hasCar = num(sp.car_slots) > 0 || !hasBike;
    const [vehicle, setVehicle] = useState(hasCar ? 'car' : 'bike');
    const [price, setPrice] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => { if (slots && (!slot || !slots.find((s) => s.name === slot && s.status === 'available'))) { const f = slots.find((s) => s.status === 'available'); setSlot(f ? f.name : ''); } }, [slots]);
    useEffect(() => {
      let alive = true; setPrice(null);
      const start = new Date(), end = new Date(start.getTime() + hours * 3600000);
      api.post('/bookings/calculate-price', { spot_id: sp.id, start_time: start.toISOString(), end_time: end.toISOString() })
        .then((r) => alive && setPrice(r.data)).catch(() => alive && setPrice({ total_price: sp.rate * hours }));
      return () => { alive = false; };
    }, [hours, sp.id]);
    const book = async () => {
      setBusy(true);
      const start = new Date(), end = new Date(start.getTime() + hours * 3600000);
      const r = await attempt(() => api.post('/bookings', { spot_id: sp.id, start_time: start.toISOString(), end_time: end.toISOString(), slot_name: slot || null, vehicle_type: vehicle }));
      setBusy(false);
      if (r && r.data) { toast(`Booked ${slot || 'a bay'}. Show PIN ${r.data.otp_code} at the gate.`); onBooked(r.data); }
      else reloadSlots();
    };
    const free = slots ? slots.filter((s) => s.status === 'available').length : sp.free;
    return html`<div class="side-body">
      <button class="back" onClick=${onBack}><${Icon} n="back" />All spots</button>
      <${SpotPhoto} sp=${sp} cls="detail-photo" />
      <div style="display:flex;flex-direction:column;gap:6px">
        <h2 style="font-size:22px">${sp.title}</h2>
        ${sp.address && html`<p class="muted" style="font-size:14px">${sp.address}</p>`}
        ${sp.description && html`<p style="font-size:14px">${sp.description}</p>`}
        <div class="inline"><span class="chip ok"><${Icon} n="shield" size=${13} />Verified owner</span>${(Array.isArray(sp.amenities) ? sp.amenities : []).map((f) => html`<span class="chip">${f}</span>`)}</div>
      </div>
      <div class="facts">
        <div class="fact"><b class="num">₹${sp.rate}</b><span>per hour now</span></div>
        <div class="fact"><b class="num">${free}/${sp.total}</b><span>bays free</span></div>
        <div class="fact"><b class="num">${sp.distance.toFixed(1)} km</b><span>away</span></div>
      </div>
      <div class="field"><label>Pick your bay</label>
        ${!slots ? html`<${Busy} label="Loading bays…" />` : html`<div class="bayrow">${slots.map((s) => html`<button class=${'bay' + (s.status !== 'available' ? ' taken' : '') + (slot === s.name ? ' on' : '')} disabled=${s.status !== 'available'} aria-pressed=${slot === s.name} onClick=${() => setSlot(s.name)}>${String(s.name).replace(/^Slot\s*/i, '')}<small>${s.status === 'available' ? (slot === s.name ? 'yours' : 'free') : s.status === 'occupied' ? 'parked' : 'booked'}</small></button>`)}</div>`}
      </div>
      <div class="field"><label>Vehicle</label>
        <div class="seg">${[['car', 'Car', hasCar], ['bike', 'Bike', hasBike]].map(([k, t, ok]) => html`<button aria-pressed=${vehicle === k} disabled=${!ok} onClick=${() => setVehicle(k)}>${t}</button>`)}</div></div>
      <div class="field"><label>How long? You pay only for the time you stay (at least 1 hour).</label>
        <div class="seg">${[1, 2, 3, 4, 6].map((x) => html`<button aria-pressed=${hours === x} onClick=${() => setHours(x)}>${x} h</button>`)}</div></div>
      <div class="panel" style="gap:10px">
        <div class="lines">
          <div><span class="muted">${hours} h at ₹${sp.rate}/h (estimate)</span><span class="num">${price ? inr(price.total_price) : '…'}</span></div>
          <div class="total"><span>Pay after you leave</span><span class="num">${price ? inr(price.total_price) : '…'}</span></div>
        </div>
        <button class="btn primary block" disabled=${busy || !free} onClick=${book}>${busy ? 'Booking…' : free ? `Book ${slot ? String(slot).replace(/^Slot\s*/i, 'bay ') : 'a bay'}` : 'No free bays'}</button>
        <p class="note">Free to cancel until the owner checks you in. Your bay is held for 30 minutes.</p>
      </div>
    </div>`;
  }

  function Ticket({ b, children }) {
    const sp = b.parking_spots || {};
    return html`<div class="ticket">
      <div class="ticket-top"><span class="eyebrow">ParkStop · Booking #${b.id}</span><h3 style="font-size:18px">${sp.title || 'Parking spot'}</h3>${sp.address && html`<span class="muted" style="font-size:13px">${sp.address}</span>`}</div>
      <div class="ticket-perf"></div>
      ${children}
      <div class="kv"><div><span>Bay</span><b>${String(b.slot_name || '—').replace(/^Slot\s*/i, '')}</b></div><div><span>Vehicle</span><b>${b.vehicle_type === 'bike' ? 'Bike' : 'Car'}</b></div><div><span>Rate</span><b>₹${Math.round(num(sp.price_per_hour))}/h</b></div></div>
    </div>`;
  }

  function PayButton({ b, user, amount, onPaid }) {
    const [busy, setBusy] = useState(false);
    const pay = async () => {
      setBusy(true);
      try {
        await loadRazorpay();
        const o = await api.post('/payments/razorpay/create-order', { bookingId: Number(b.id) });
        await new Promise((resolve) => {
          const rzp = new window.Razorpay({
            key: o.key_id, amount: o.amount, currency: o.currency || 'INR', order_id: o.order_id,
            name: 'ParkStop', description: `Parking · booking #${b.id}`,
            prefill: { name: user.full_name || user.name || '', email: user.email || '', contact: user.phone || '' },
            theme: { color: '#ff6b2c' },
            handler: async (resp) => {
              try {
                await api.post('/payments/razorpay/verify', { bookingId: Number(b.id), razorpay_order_id: resp.razorpay_order_id, razorpay_payment_id: resp.razorpay_payment_id, razorpay_signature: resp.razorpay_signature });
                toast('Payment confirmed. Thank you!'); onPaid(b.id);
              } catch (e) { toast(`${e.message} If money was taken, do not pay again — it will be confirmed or refunded automatically. Payment ID: ${resp.razorpay_payment_id}`, 'bad'); }
              resolve();
            },
            modal: { ondismiss: () => resolve() },
          });
          rzp.on('payment.failed', (r) => { toast((r && r.error && r.error.description) || 'Payment failed. You were not charged.', 'bad'); });
          rzp.open();
        });
      } catch (e) { toast(e.message || 'Could not start the payment.', 'bad'); }
      setBusy(false);
    };
    return html`<button class="btn primary block" disabled=${busy} onClick=${pay}>${busy ? 'Opening secure payment…' : `Pay ${inr(amount)}`}</button>`;
  }

  function BookingFlow({ b, user, reload, onPaid, onNavigate, atSpot }) {
    const now = useNow(1000);
    const sp = b.parking_spots || {};
    const [confirm, setConfirm] = useState(null);
    const [busy, setBusy] = useState(false);
    const [amount, setAmount] = useState(null);
    useEffect(() => { if (b.status === 'completed') api.get(`/bookings/${b.id}/checkout-amount`).then((r) => setAmount(r.data)).catch(() => setAmount({ total_amount: b.total_price, base_price: b.total_price, arrears: 0 })); }, [b.id, b.status, b.total_price]);
    const act = async (fn, msg) => { setBusy(true); await attempt(fn, msg); setBusy(false); setConfirm(null); reload(); };
    const lat = num(sp.latitude), lng = num(sp.longitude);

    if (b.status === 'reserved' && atSpot) {
      // Arrived: the only thing left to do is show the PIN. This screen moves on
      // by itself the moment the owner checks the car in.
      const left = ts(b.otp_expires_at) - now;
      return html`<div class="side-body">
        <p class="eyebrow">At the spot${left > 0 ? ` · bay held for ${mmss(left)}` : ''}</p>
        <h2 style="font-size:24px">Show this PIN at the gate</h2>
        <div class="gatepin">
          <span class="eyebrow">Check-in PIN</span>
          <div class="pin big">${b.otp_code || '······'}</div>
          <span class="muted" style="font-size:14px">${sp.title} · ${String(b.slot_name || 'your bay').replace(/^Slot\s*/i, 'bay ')}</span>
        </div>
        <div class="status"><span class="pulse"></span>Waiting for the owner to enter your PIN. This screen updates by itself.</div>
        <ol class="nextsteps">
          <li class="on"><b>Show the PIN</b><span>Tell the owner or show them this screen.</span></li>
          <li><b>Owner checks you in</b><span>Your parking time starts then.</span></li>
          <li><b>Park in ${String(b.slot_name || 'your bay').replace(/^Slot\s*/i, 'bay ')}</b><span>End the session here when you leave, then pay.</span></li>
        </ol>
        <div class="inline" style="justify-content:space-between">
          <button class="linkbtn" onClick=${onNavigate}>Directions again</button>
          ${confirm === 'cancel' ? null : html`<button class="linkbtn" style="color:var(--bad)" onClick=${() => setConfirm('cancel')}>Cancel booking</button>`}
        </div>
        ${confirm === 'cancel' && html`<div class="panel"><b>Cancel this booking?</b><p class="muted" style="font-size:14px">Your bay will be released for other drivers.</p>
            <div class="inline"><button class="btn" onClick=${() => setConfirm(null)}>Keep booking</button><button class="btn primary" disabled=${busy} onClick=${() => act(() => api.put(`/bookings/${b.id}/cancel`), (r) => r.message || 'Booking cancelled')}>Cancel booking</button></div></div>`}
      </div>`;
    }
    if (b.status === 'reserved') {
      const left = ts(b.otp_expires_at) - now;
      return html`<div class="side-body">
        <p class="eyebrow">${left > 0 ? `Booked · bay held for ${mmss(left)}` : 'Hold time is over'}</p>
        <${Ticket} b=${b}>
          <div class="ticket-pin"><div><span class="eyebrow">Check-in PIN</span><div class="pin">${b.otp_code || '······'}</div></div><span class="chip warn">Show at the gate</span></div>
        <//>
        <button class="btn blue block" onClick=${onNavigate}><${Icon} n="nav" />Navigate to the spot</button>
        <div class="status"><span class="pulse"></span>Waiting for the owner to check you in</div>
        ${confirm === 'cancel' ? html`<div class="panel"><b>Cancel this booking?</b><p class="muted" style="font-size:14px">Your bay will be released for other drivers.</p>
            <div class="inline"><button class="btn" onClick=${() => setConfirm(null)}>Keep booking</button><button class="btn primary" disabled=${busy} onClick=${() => act(() => api.put(`/bookings/${b.id}/cancel`), (r) => r.message || 'Booking cancelled')}>Cancel booking</button></div></div>`
          : html`<button class="btn danger" onClick=${() => setConfirm('cancel')}>Cancel booking</button>`}
      </div>`;
    }
    if (b.status === 'active') {
      const start = ts(b.start_time);
      const mins = Math.max(1, Math.ceil((now - start) / 60000));
      const billed = Math.max(1, mins / 60);
      const rate = num(b.hours) > 0 ? num(b.total_price) / num(b.hours) : num(sp.price_per_hour);
      const over = b.end_time && now > ts(b.end_time);
      return html`<div class="side-body">
        <p class="eyebrow">Parked · since ${time(b.start_time)}</p>
        <${Ticket} b=${b}>
          <div class="ticket-pin" style="flex-direction:column;align-items:flex-start;gap:8px">
            <span class="eyebrow">Time parked</span><div class="clock num">${hms(now - start)}</div>
            <div class="inline"><span class=${'chip ' + (over ? 'warn' : 'ok')}>${over ? 'Past your booked time · extra time is billed' : 'Booked until ' + time(b.end_time)}</span></div>
          </div>
        <//>
        <div class="panel" style="gap:8px"><div class="lines"><div><span class="muted">Bill so far (${mins} min, min. 1 h)</span><span class="num">${inr(Math.round(billed * rate * 100) / 100)}</span></div></div></div>
        <div class="inline">
          <button class="btn" style="flex:1" disabled=${busy} onClick=${() => act(() => api.put(`/bookings/${b.id}/extend`, { additionalMinutes: 30 }), 'Extended by 30 minutes')}>+30 min</button>
          <button class="btn" style="flex:1" disabled=${busy} onClick=${() => act(() => api.put(`/bookings/${b.id}/extend`, { additionalMinutes: 60 }), 'Extended by 1 hour')}>+1 hour</button>
        </div>
        ${confirm === 'end' ? html`<div class="panel"><b>End your session now?</b><p class="muted" style="font-size:14px">The meter stops now. The owner confirms your car has left, then you pay.</p>
            <div class="inline"><button class="btn" onClick=${() => setConfirm(null)}>Not yet</button><button class="btn primary" disabled=${busy} onClick=${() => act(() => api.post(`/bookings/${b.id}/request-checkout`), 'Meter stopped. Waiting for the owner.')}>End session</button></div></div>`
          : html`<button class="btn primary block" onClick=${() => setConfirm('end')}>End session</button>`}
      </div>`;
    }
    if (b.status === 'checkout_pending') {
      return html`<div class="side-body">
        <p class="eyebrow">Leaving · meter stopped at ${time(b.actual_end_time)}</p>
        <div class="panel" style="align-items:center;text-align:center;padding:26px 16px">
          <div class="spinner"></div>
          <h2 style="font-size:20px">Waiting for the owner to confirm</h2>
          <p class="muted" style="font-size:14px">They check that your bay is empty. If they do not answer in time, ParkStop confirms it for you.</p>
        </div>
        <button class="btn" disabled=${busy} onClick=${() => act(() => api.post(`/bookings/${b.id}/request-checkout`), 'Reminder sent to the owner')}>Remind the owner</button>
      </div>`;
    }
    // completed, not paid
    return html`<div class="side-body">
      <p class="eyebrow">Checkout confirmed</p>
      <h2 style="font-size:24px">Review and pay</h2>
      <div class="panel"><div class="lines">
        <div><span class="muted">Spot</span><span>${sp.title}</span></div>
        <div><span class="muted">Parked</span><span class="num">${time(b.start_time)} – ${time(b.actual_end_time)}</span></div>
        <div><span class="muted">Billed time</span><span class="num">${num(b.hours).toFixed(2)} h</span></div>
        <div><span class="muted">Parking</span><span class="num">${amount ? inr(amount.base_price) : '…'}</span></div>
        ${amount && num(amount.arrears) > 0 && html`<div><span class="muted">Earlier unpaid dues</span><span class="num">${inr(amount.arrears)}</span></div>`}
        <div class="total"><span>Total</span><span class="num">${amount ? inr(amount.total_amount) : '…'}</span></div>
      </div></div>
      ${amount && html`<${PayButton} b=${b} user=${user} amount=${amount.total_amount} onPaid=${onPaid} />`}
      <p class="note">UPI, cards and netbanking through Razorpay. You can book again once this is paid.</p>
    </div>`;
  }


  // ---------------- in-app navigation ----------------
  const R_EARTH = 6371000;
  const meters = (a, b) => { const t = Math.PI / 180; const dLat = (b[1] - a[1]) * t, dLng = (b[0] - a[0]) * t; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLng / 2) ** 2; return 2 * R_EARTH * Math.asin(Math.sqrt(x)); };
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' km' : Math.max(10, Math.round(m / 10) * 10) + ' m');
  const fmtMins = (s) => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  const TURN = {
    left: 'M15 19V11a3 3 0 0 0-3-3H6M9 4 5 8l4 4', right: 'M9 19V11a3 3 0 0 1 3-3h6M15 4l4 4-4 4',
    straight: 'M12 20V4M7 9l5-5 5 5', uturn: 'M8 20V9a4 4 0 0 1 8 0v4M12 9l4 4 4-4',
    round: 'M12 20v-6M12 14a4 4 0 1 0-4-4M8 10V5M5 8l3-3 3 3', arrive: 'M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 8v4',
  };
  const turnOf = (st) => {
    const m = String((st && (st.maneuver || st.instruction)) || '').toLowerCase();
    if (/arriv/.test(m)) return 'arrive';
    if (/u-?turn/.test(m)) return 'uturn';
    if (/roundabout|rotary/.test(m)) return 'round';
    if (/left/.test(m)) return 'left';
    if (/right/.test(m)) return 'right';
    return 'straight';
  };
  const TurnIcon = ({ kind, size }) => html`<svg width=${size || 34} height=${size || 34} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${TURN[kind] || TURN.straight} /></svg>`;

  /** Where the driver is on the route: nearest point, distances, current step. */
  function progressOn(route, here) {
    const c = route.coordinates;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < c.length; i++) { const d = meters(here, c[i]); if (d < bestD) { bestD = d; best = i; } }
    const cum = route._cum;
    const done = cum[best];
    const total = cum[cum.length - 1] || 1;
    const remaining = Math.max(0, total - done) + bestD;
    let next = null;
    for (const st of route.steps) { if (st._idx > best + 1 || (st._idx >= best && meters(here, st.location) > 25)) { next = st; break; } }
    if (!next) next = route.steps[route.steps.length - 1] || null;
    const toNext = next ? Math.max(0, (cum[next._idx] || total) - done) + bestD : remaining;
    return { offBy: bestD, idx: best, remaining, toNext, next, eta: (route.duration_s || 0) * (remaining / total) };
  }
  function prepareRoute(r) {
    const c = r.coordinates.map((p) => [Number(p[0]), Number(p[1])]);
    const cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + meters(c[i - 1], c[i]));
    const steps = (r.steps || []).filter((st) => Array.isArray(st.location) && isFinite(st.location[0])).map((st) => {
      let bi = 0, bd = Infinity; for (let i = 0; i < c.length; i++) { const d = meters(st.location, c[i]); if (d < bd) { bd = d; bi = i; } }
      return { ...st, _idx: bi };
    }).sort((a, b) => a._idx - b._idx);
    return { ...r, coordinates: c, _cum: cum, steps };
  }

  function Navigation({ b, gps, gpsStatus, onRoute, onExit, onArrive }) {
    const sp = b.parking_spots || {};
    const dest = [num(sp.longitude), num(sp.latitude)];
    const [route, setRoute] = useState(null);
    const [err, setErr] = useState('');
    const [voice, setVoice] = useState(() => ls.get('ps-voice') !== 'off');
    const fetching = useRef(false);
    const lastFetch = useRef(0);
    const spoken = useRef('');
    const here = gps ? [gps.lng, gps.lat] : null;

    const fetchRoute = async (why) => {
      if (!here || fetching.current) return;
      fetching.current = true; lastFetch.current = Date.now();
      try {
        const r = await api.get(`/maps/route?from=${here[1].toFixed(6)},${here[0].toFixed(6)}&to=${dest[1]},${dest[0]}`);
        const pr = prepareRoute(r.data);
        setRoute(pr); setErr('');
        if (why === 'reroute') toast('New route found');
      } catch (e) { setErr(e.message); }
      fetching.current = false;
    };
    useEffect(() => { if (here && !route) fetchRoute(); }, [!!here]);

    const prog = route && here ? progressOn(route, here) : null;
    const arrived = here && meters(here, dest) < 45;
    useEffect(() => { if (arrived) onArrive(); }, [arrived]);
    // Off the route for real (not GPS jitter): get a new one, at most every 15 s.
    const offRef = useRef({ prog: null, arrived: false, acc: 0 });
    offRef.current = { prog, arrived, acc: (gps && gps.accuracy) || 0 };
    useEffect(() => {
      const check = () => {
        const { prog: pg, arrived: ar, acc } = offRef.current;
        if (!pg || ar) return;
        const limit = Math.max(70, Math.min(250, acc) * 1.2);
        if (pg.offBy > limit && Date.now() - lastFetch.current > 10000) fetchRoute('reroute');
      };
      check();
      const t = setInterval(check, 3000);
      return () => clearInterval(t);
    }, [prog && Math.round(prog.offBy / 10)]);
    // Remaining route only (the part already driven disappears).
    useEffect(() => { onRoute(route ? (prog ? [here].concat(route.coordinates.slice(prog.idx + 1)) : route.coordinates) : null); }, [route, prog && prog.idx]);
    useEffect(() => () => onRoute(null), []);
    // Voice
    const say = (text) => { try { if (!voice || !window.speechSynthesis) return; window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-IN'; u.rate = 1; window.speechSynthesis.speak(u); } catch (e) {} };
    useEffect(() => {
      if (arrived) { if (spoken.current !== 'arrived') { spoken.current = 'arrived'; say('You have arrived. Show your PIN at the gate.'); } return; }
      if (!prog || !prog.next) return;
      const key = prog.next.instruction + prog.next._idx;
      if (spoken.current !== key) { spoken.current = key; say(`In ${fmtDist(prog.toNext)}, ${prog.next.instruction}`); }
    }, [arrived, prog && prog.next && prog.next._idx]);
    useEffect(() => () => { try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (e) {} }, []);

    if (!gps) return html`<div class="side-body">
      <button class="back" onClick=${onExit}><${Icon} n="back" />Back to booking</button>
      <div class="panel" style="text-align:center;align-items:center;padding:24px 16px">
        ${gpsStatus === 'blocked' || gpsStatus === 'unsupported'
          ? html`<h2 style="font-size:20px">Allow location to navigate</h2><p class="muted" style="font-size:14px">Click the lock icon in the address bar, set Location to Allow, then reload this page.</p>`
          : html`<div class="spinner"></div><h2 style="font-size:20px">Finding your location…</h2><p class="muted" style="font-size:14px">Allow location when your browser asks.</p>`}
      </div></div>`;

    const arrival = prog ? new Date(Date.now() + prog.eta * 1000) : null;
    return html`<div class="side-body nav">
      <div class="inline" style="justify-content:space-between">
        <button class="back" onClick=${onExit}><${Icon} n="back" />Back to booking</button>
        <button class="btn sm ghost" aria-pressed=${voice} onClick=${() => { const v = !voice; setVoice(v); ls.set('ps-voice', v ? 'on' : 'off'); if (!v) try { window.speechSynthesis.cancel(); } catch (e) {} }}>${voice ? 'Voice on' : 'Voice off'}</button>
      </div>
      ${arrived ? html`<div class="navcard arrived">
          <div class="turn"><${TurnIcon} kind="arrive" /></div>
          <div><b>You have arrived</b><span>${sp.title}</span></div>
        </div>
        <div class="ticket"><div class="ticket-pin"><div><span class="eyebrow">Show this PIN at the gate</span><div class="pin">${b.otp_code}</div></div></div></div>
        <button class="btn primary block" onClick=${onExit}>Continue</button>`
      : !route ? (err ? html`<div class="panel"><p class="error">${err}</p><button class="btn" onClick=${() => fetchRoute()}>Try again</button></div>` : html`<${Busy} label="Finding the best route…" />`)
      : html`
        <div class="navcard">
          <div class="turn"><${TurnIcon} kind=${turnOf(prog.next)} /></div>
          <div><b class="num">${fmtDist(prog.toNext)}</b><span>${prog.next ? prog.next.instruction : 'Continue to the spot'}</span></div>
        </div>
        <div class="navstats">
          <div><b class="num">${fmtMins(prog.eta)}</b><span>to go</span></div>
          <div><b class="num">${fmtDist(prog.remaining)}</b><span>left</span></div>
          <div><b class="num">${arrival ? time(arrival) : '—'}</b><span>arrival</span></div>
        </div>
        ${err && html`<p class="note">${err}</p>`}
        <div class="card"><div class="card-h"><h2 style="font-size:15px">Directions</h2><small class="faint">via ${route.provider === 'ola' ? 'Ola Maps' : 'OpenStreetMap'}</small></div>
          <div class="card-b navsteps">${route.steps.filter((st) => st._idx >= prog.idx).slice(0, 8).map((st, i) => html`<div class=${'navstep' + (i === 0 ? ' on' : '')}><${TurnIcon} kind=${turnOf(st)} size=${20} /><span class="grow">${st.instruction}</span><small class="faint num">${st.distance_m ? fmtDist(st.distance_m) : ''}</small></div>`)}</div></div>
        <div class="ticket"><div class="ticket-pin"><div><span class="eyebrow">Your PIN · ${String(b.slot_name || '').replace(/^Slot\s*/i, 'bay ')}</span><div class="pin" style="font-size:28px">${b.otp_code}</div></div></div></div>`}
    </div>`;
  }

  function Receipt({ b, onDone }) {
    const sp = b.parking_spots || {};
    return html`<div class="side-body">
      <div style="display:flex;justify-content:space-between;align-items:center"><p class="eyebrow">Receipt</p><span class="stamp">PAID</span></div>
      <h2 style="font-size:24px">Thanks for parking with ParkStop</h2>
      <div class="ticket"><div class="ticket-top"><span class="eyebrow">Booking #${b.id} · ${dateShort(b.actual_end_time || b.updated_at)}</span><h3 style="font-size:18px">${sp.title}</h3></div>
        <div class="ticket-perf"></div>
        <div class="card-b mono" style="font-size:13.5px"><div class="lines">
          <div><span>${String(b.slot_name || '').replace(/^Slot\s*/i, 'Bay ')}</span><span>${b.vehicle_type === 'bike' ? 'Bike' : 'Car'}</span></div>
          <div><span>${time(b.start_time)} – ${time(b.actual_end_time)}</span><span>${num(b.hours).toFixed(2)} h</span></div>
          ${b.payment_id && html`<div><span>Payment</span><span>${String(b.payment_id).slice(0, 18)}</span></div>`}
          <div class="total"><span>Total paid</span><span>${inr(b.total_price)}</span></div>
        </div></div></div>
      <button class="btn primary block" onClick=${onDone}>Find another spot</button>
    </div>`;
  }

  const STATUS_CHIP = { reserved: ['Booked', 'warn'], active: ['Parked', 'sig'], checkout_pending: ['Leaving', 'warn'], completed: ['Completed', 'ok'], cancelled: ['Cancelled', ''], expired: ['Expired', ''] };

  function Driver({ user }) {
    const [gps, gpsStatus] = useGps();
    const [navOn, setNavOn] = useState(false);
    // Bookings the driver has arrived at (kept across reloads).
    const [arrivedIds, setArrivedIds] = useState(() => { try { return JSON.parse(ls.get('ps-arrived') || '[]'); } catch (e) { return []; } });
    const markArrived = (id) => setArrivedIds((l) => { if (l.includes(String(id))) return l; const n = l.concat(String(id)).slice(-20); ls.set('ps-arrived', JSON.stringify(n)); return n; });
    const [navRoute, setNavRoute] = useState(null);
    const [center, setCenter] = useState(HOME);
    const followGps = useRef(true); // start the search at the real location until the user searches somewhere else
    const [focus, setFocus] = useState({ lat: center.lat, lng: center.lng, zoom: 13.4 });
    const [sel, setSel] = useState(null);
    const [vehicle, setVehicle] = useState('all');
    const [tab, setTab] = useState('find');
    const [receiptId, setReceiptId] = useState(null);
    const [nearby, reloadSpots, spotsErr] = useLive(() => api.get(`/spots/nearby?lat=${center.lat}&lng=${center.lng}&radius=10`), [center.lat, center.lng], { every: 30000 });
    const [bookings, reloadBookings, bookErr] = useLive(() => api.get('/bookings/my-bookings').then((r) => r.data || []), [], { every: 8000, events: ['booking:checkedin', 'booking:checkout_confirmed'] });
    const open = openBookingOf(bookings);
    const nearSpot = !!(open && gps && open.parking_spots && meters([gps.lng, gps.lat], [num(open.parking_spots.longitude), num(open.parking_spots.latitude)]) < 60);
    const atSpot = !!(open && (arrivedIds.includes(String(open.id)) || nearSpot));
    useEffect(() => { if (nearSpot && open) markArrived(open.id); }, [nearSpot, open && open.id]);
    // Tell the driver plainly when the owner moves the booking on.
    const lastStatus = useRef({});
    useEffect(() => {
      (bookings || []).forEach((bk) => {
        const prev = lastStatus.current[bk.id];
        if (prev && prev !== bk.status) {
          if (prev === 'reserved' && bk.status === 'active') { toast('You are checked in. Your parking time has started.'); setNavOn(false); setNavRoute(null); }
          if (prev === 'checkout_pending' && bk.status === 'completed') toast('The owner confirmed you have left. Please pay now.');
          if (prev === 'reserved' && bk.status === 'expired') toast('Your booking expired because check-in did not happen in time.', 'bad');
        }
        lastStatus.current[bk.id] = bk.status;
      });
    }, [bookings]);
    const spots = useMemo(() => ((nearby && nearby.data) || []).map(spotView).filter((sp) => vehicle === 'all' || (vehicle === 'bike' ? num(sp.bike_slots) > 0 : num(sp.car_slots) > 0 || num(sp.bike_slots) === 0)), [nearby, vehicle]);
    const selected = spots.find((x) => x.id === sel);
    const openSpot = open && open.parking_spots ? spotView({ ...open.parking_spots, distance: 0 }) : null;
    const mapSpots = openSpot ? [openSpot] : spots;
    const moveTo = (p) => { const c = { lat: p.lat, lng: p.lng, name: p.name || 'this place' }; setCenter(c); setSel(null); setFocus({ lat: p.lat, lng: p.lng, zoom: 13.6 }); };
    useEffect(() => {
      if (!gps || !followGps.current) return;
      followGps.current = false;
      moveTo(gps);
      if (gps.accuracy > 1500) toast(`Your device only knows your location roughly (about ${Math.round(gps.accuracy / 1000)} km). Turn on Windows location, or search your area.`, 'bad');
    }, [gps]);
    const locate = () => {
      if (gps) { moveTo(gps); return; }
      if (gpsStatus === 'blocked') { toast('Location is blocked. Click the lock icon in the address bar, allow Location, then reload.', 'bad'); return; }
      locateMe().then(moveTo).catch((e) => toast(e.message, 'bad'));
    };
    const choose = (id) => { if (open) return; const sp = spots.find((x) => x.id === id); setSel(id); setTab('find'); if (sp) setFocus({ lat: sp.lat, lng: sp.lng, zoom: 15.2 }); };
    useEffect(() => { if (openSpot) setFocus({ lat: openSpot.lat, lng: openSpot.lng, zoom: 15 }); }, [open && open.id]);
    const receipt = receiptId && bookings && bookings.find((b) => String(b.id) === String(receiptId));
    const history = (bookings || []).filter((b) => b !== open);

    let body;
    if (!bookings && !bookErr) body = html`<div class="side-body"><${Busy} /></div>`;
    else if (receipt && !openBookingOf([receipt])) body = html`<${Receipt} b=${receipt} onDone=${() => { setReceiptId(null); setSel(null); setFocus({ lat: center.lat, lng: center.lng, zoom: 13.4 }); reloadSpots(); }} />`;
    else if (open && navOn && open.status === 'reserved') body = html`<${Navigation} b=${open} gps=${gps} gpsStatus=${gpsStatus} onRoute=${setNavRoute} onArrive=${() => markArrived(open.id)} onExit=${() => { setNavOn(false); setNavRoute(null); }} />`;
    else if (open) body = html`<${BookingFlow} b=${open} user=${user} reload=${reloadBookings} onPaid=${(id) => { setReceiptId(id); reloadBookings(); }} onNavigate=${() => setNavOn(true)} atSpot=${atSpot} />`;
    else if (tab === 'history') body = html`<div class="side-body">${history.length ? history.map((b) => { const c = STATUS_CHIP[b.status] || [b.status, '']; return html`<div class="row-item"><div class="grow"><b>${(b.parking_spots && b.parking_spots.title) || 'Parking'}</b><small>${dateTime(b.created_at)} · ${String(b.slot_name || '').replace(/^Slot\s*/i, 'bay ')}</small></div><span class=${'chip ' + c[1]}>${c[0]}</span><span class="num" style="min-width:64px;text-align:right">${b.status === 'completed' ? inr(b.total_price) : '—'}</span></div>`; }) : html`<div class="empty">Your past parkings will appear here.</div>`}</div>`;
    else if (selected) body = html`<${SpotDetail} sp=${selected} onBack=${() => setSel(null)} onBooked=${() => { setSel(null); reloadBookings(); reloadSpots(); }} />`;
    else body = html`<div class="side-body">
      <div class="listhead"><span class="eyebrow">${nearby ? `${spots.length} verified spot${spots.length === 1 ? '' : 's'} near ${center.name}` : 'Finding spots…'}</span><button class="linkbtn" style="font-size:12.5px" onClick=${reloadSpots}>Refresh</button></div>
      ${nearby && nearby.message && spots.length > 0 && !/retrieved/i.test(nearby.message) ? html`<p class="note">${nearby.message}</p>` : null}
      ${spotsErr && !nearby ? html`<${ErrorBox} msg=${spotsErr} retry=${reloadSpots} />` : !nearby ? html`<${Busy} label="Finding verified spots…" />` : spots.length ? spots.map((sp) => html`<${SpotCard} sp=${sp} on=${sel === sp.id} onClick=${() => choose(sp.id)} />`) : html`<div class="empty">No verified spots within 10 km of ${center.name}. Try another area.</div>`}
    </div>`;

    return html`<main class="drive">
      <aside class="side" aria-label="Find parking">
        ${!open && !(receipt && !openBookingOf([receipt])) && html`<div class="side-head">
          <div class="inline" style="flex-wrap:nowrap;gap:8px">
            <div style="flex:1;min-width:0"><${PlaceSearch} near=${center} onPick=${(p) => { followGps.current = false; moveTo(p); }} placeholder="Where are you going? Try Koramangala" /></div>
            <button class="iconbtn" title="Use my location" aria-label="Use my location" onClick=${locate}><${Icon} n="locate" /></button>
          </div>
          <div class="inline" style="justify-content:space-between">
            <div class="seg" style="flex:1">${[['all', 'All'], ['car', 'Car'], ['bike', 'Bike']].map(([k, t]) => html`<button aria-pressed=${vehicle === k} onClick=${() => setVehicle(k)}>${t}</button>`)}</div>
            <div class="seg" style="flex:1">${[['find', 'Find'], ['history', 'History']].map(([k, t]) => html`<button aria-pressed=${tab === k} onClick=${() => { setTab(k); setSel(null); }}>${t}</button>`)}</div>
          </div>
        </div>`}
        ${body}
      </aside>
      <${MapView} spots=${mapSpots} selectedId=${openSpot ? openSpot.id : selected && selected.id} user=${gps} focus=${focus} onSelect=${choose} areas=${AREAS}
        route=${navOn && open && open.status === 'reserved' ? navRoute : null} follow=${navOn && open && open.status === 'reserved' && navRoute ? gps : null} />
    </main>`;
  }

  // ---------------- owner ----------------
  function BarChart({ values, labels, money, aria }) {
    const max = Math.max(money ? 100 : 4, ...values);
    const step = money ? (max > 2000 ? 1000 : max > 400 ? 200 : 50) : 1;
    const nice = Math.ceil(max / step) * step;
    const W = 560, H = 200, L = 48, Bt = 26, T = 18, bw = (W - L - 10) / values.length;
    const y = (v) => T + (H - T - Bt) * (1 - v / nice);
    const fmt = (t) => (money ? (t >= 1000 ? '₹' + (t / 1000).toFixed(t % 1000 ? 1 : 0) + 'k' : '₹' + t) : t);
    return html`<div class="chart"><svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${aria}>
      ${[0, nice / 2, nice].map((t) => html`<g><line x1=${L} x2=${W - 4} y1=${y(t)} y2=${y(t)} stroke="var(--line)" stroke-width="1" /><text x=${L - 8} y=${y(t) + 4} text-anchor="end" font-size="11" fill="var(--ink-3)">${fmt(Math.round(t))}</text></g>`)}
      ${values.map((v, i) => { const x = L + i * bw + bw * 0.2, w = bw * 0.6, last = i === values.length - 1; return html`<g>
        <rect x=${x} y=${y(v)} width=${w} height=${Math.max(0, y(0) - y(v))} rx="4" fill=${last ? 'var(--signal)' : 'var(--ink-3)'} opacity=${last ? 1 : 0.45}><title>${labels[i]}: ${money ? inr(v) : v}</title></rect>
        ${last && v > 0 && html`<text x=${x + w / 2} y=${y(v) - 6} text-anchor="middle" font-size="12" font-weight="700" fill="var(--ink)">${money ? inr(Math.round(v)) : v}</text>`}
        <text x=${x + w / 2} y=${H - 8} text-anchor="middle" font-size="11" fill=${last ? 'var(--ink)' : 'var(--ink-3)'} font-weight=${last ? 700 : 400}>${labels[i]}</text>
      </g>`; })}
    </svg></div>`;
  }
  const last7 = () => Array.from({ length: 7 }, (_, i) => { if (i === 6) return 'Today'; const d = new Date(); d.setDate(d.getDate() - (6 - i)); return d.toLocaleDateString('en-IN', { weekday: 'short' }); });

  function CheckInRow({ b, reload }) {
    const [pin, setPin] = useState('');
    const [busy, setBusy] = useState(false);
    const sp = b.parking_spots || {};
    const left = ts(b.otp_expires_at) - Date.now();
    return html`<div class="row-item" style="flex-wrap:wrap">
      <div class="grow"><b>Arriving · ${String(b.slot_name || 'a bay').replace(/^Slot\s*/i, 'bay ')}</b><small>${sp.title} · ${(b.users && b.users.full_name) || 'Driver'} · ${b.vehicle_type === 'bike' ? 'bike' : 'car'} · ${left > 0 ? `hold ends in ${Math.ceil(left / 60000)} min` : 'hold time over'}</small></div>
      <form class="inline" style="flex-wrap:nowrap" onSubmit=${async (e) => { e.preventDefault(); setBusy(true); const ok = await attempt(() => api.post('/bookings/verify-otp', { bookingId: Number(b.id), otp: pin }).catch((e) => { if (/^invalid otp$/i.test(e.message)) e.message = 'That PIN does not match. Ask the driver to show the PIN in their ParkStop app.'; throw e; }), 'Car checked in. The meter is running.'); setBusy(false); if (ok) { setPin(''); reload(); } }}>
        <input id=${'pin-' + b.id} class="input mono" style="width:132px;padding:8px 10px;letter-spacing:0.12em" inputmode="numeric" maxlength="6" placeholder="6-digit PIN" aria-label=${'Driver PIN for booking ' + b.id} value=${pin} onInput=${(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        <button class="btn sm primary" type="submit" disabled=${pin.length !== 6 || busy}>Check in</button>
      </form>
    </div>`;
  }

  function SpotForm({ initial, onSaved, onClose, near }) {
    const editing = !!initial;
    const [f, setF] = useState(() => ({
      title: initial ? initial.title : '', description: '', address: '', price: '',
      car: initial ? String(num(initial.car_slots) || '') : '2', bike: initial ? String(num(initial.bike_slots) || 0) : '0',
      lat: null, lng: null,
    }));
    const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
    // Location comes from the device GPS, like the mobile app: it starts on its own
    // when the form opens and follows the GPS until the owner moves the pin by hand.
    const [gpsState, setGpsState] = useState(editing ? 'off' : 'waiting'); // waiting | live | manual | blocked | off
    const [acc, setAcc] = useState(null);
    const follow = useRef(!editing);
    const watchId = useRef(null);
    const startGps = () => {
      if (!navigator.geolocation) { setGpsState('blocked'); return; }
      follow.current = true; setGpsState('waiting');
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
      watchId.current = navigator.geolocation.watchPosition((p) => {
        if (!follow.current) return;
        setF((x) => ({ ...x, lat: p.coords.latitude, lng: p.coords.longitude }));
        setAcc(p.coords.accuracy); setGpsState('live');
        setFocus({ lat: p.coords.latitude, lng: p.coords.longitude, zoom: 17 });
      }, () => setGpsState((g) => (g === 'live' || g === 'manual' ? g : 'blocked')), { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    };
    useEffect(() => { if (!editing) startGps(); return () => { if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current); }; }, []);
    const [files, setFiles] = useState([]);
    const [stage, setStage] = useState('');
    const addFiles = (list) => {
      const picked = Array.from(list || []);
      const ok = picked.filter((x) => x.type.indexOf('image/') === 0 && x.size <= 5 * 1024 * 1024);
      if (ok.length < picked.length) toast('Some files were skipped. Photos must be images under 5 MB.', 'bad');
      setFiles((cur) => { const next = cur.concat(ok).slice(0, 5); if (cur.length + ok.length > 5) toast('You can add up to 5 photos.', 'bad'); return next; });
    };
    const previews = useMemo(() => files.map((x) => URL.createObjectURL(x)), [files]);
    useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const [focus, setFocus] = useState({ lat: near.lat, lng: near.lng, zoom: 14 });
    // Moving the pin by hand stops following the GPS.
    const pick = (p) => { follow.current = false; setGpsState('manual'); setF((x) => ({ ...x, lat: p.lat, lng: p.lng })); };
    const setCoord = (k, v) => { follow.current = false; setGpsState('manual'); const n = parseFloat(v); setF((x) => ({ ...x, [k]: isNaN(n) ? null : n })); };
    const save = async (e) => {
      e.preventDefault(); setErr('');
      const car = parseInt(f.car || '0', 10), bike = parseInt(f.bike || '0', 10);
      if (!editing) {
        if (f.title.trim().length < 3) return setErr('Give the spot a name drivers will recognise.');
        if (f.lat === null || f.lng === null) return setErr(gpsState === 'blocked' ? 'Location is blocked. Allow location for this site (lock icon in the address bar), then tap Detect my location.' : 'Waiting for your location. Tap Detect my location.');
        if (f.address.trim().length < 5) return setErr('Enter the address of the parking space.');
        if (!(Number(f.price) > 0)) return setErr('Enter the price per hour.');
      }
      if (car + bike <= 0) return setErr('Add at least one bay.');
      setBusy(true);
      try {
        const payload = editing
          ? { title: f.title.trim() || undefined, price_per_hour: f.price ? Number(f.price) : undefined, address: f.address.trim() || undefined, description: f.description.trim() || undefined, total_slots: car + bike, car_slots: car, bike_slots: bike }
          : { title: f.title.trim(), description: f.description.trim(), price_per_hour: Number(f.price), latitude: f.lat, longitude: f.lng, address: f.address.trim() || undefined, total_slots: car + bike, car_slots: car, bike_slots: bike, images: [] };
        setStage('saving');
        const r = editing ? await api.put(`/spots/${initial.id}`, payload) : await api.post('/spots', payload);
        const id = editing ? initial.id : r.data && r.data.id;
        // Photos are optional. The spot is already saved; a failed photo upload never undoes it.
        let photoNote = '';
        if (files.length && id) {
          setStage('photos');
          const fd = new FormData(); files.slice(0, 5).forEach((x) => fd.append('images', x));
          try { await api.post(`/spots/${id}/images`, fd); photoNote = ` with ${files.length} photo${files.length === 1 ? '' : 's'}`; }
          catch (ie) { toast('Spot saved, but the photos did not upload. You can add them later with Edit.', 'bad'); }
        }
        toast((editing ? 'Spot updated' : 'Spot added') + photoNote);
        onSaved();
      } catch (ex) { setErr(ex.message); }
      setBusy(false); setStage('');
    };
    return html`<form class="card-b" style="border-top:1px solid var(--line)" onSubmit=${save}>
      <div class="form-grid">
        <div class="field" style="grid-column:1/-1"><label for="sp-title">Spot name drivers will see</label><input id="sp-title" class="input" placeholder="e.g. Hennur Cross Apartment Basement" value=${f.title} onInput=${(e) => set('title', e.target.value)} /></div>
        ${!editing && html`<div class="field" style="grid-column:1/-1"><label>Location (from your GPS)</label>
          <div class="gpsbar">
            <span class=${'pulse' + (gpsState === 'live' ? ' ok' : '')} style=${gpsState === 'blocked' ? 'background:var(--bad)' : gpsState === 'manual' ? 'background:var(--sign)' : ''}></span>
            <span class="grow">${gpsState === 'live' ? html`<b>Using your current location</b>${acc ? html` · accurate to about ${acc < 1000 ? Math.round(acc) + ' m' : (acc / 1000).toFixed(1) + ' km'}` : ''}`
              : gpsState === 'manual' ? html`<b>Pin set by you</b>`
              : gpsState === 'blocked' ? html`<b>Location is blocked.</b> Allow location for this site (lock icon in the address bar), then try again.`
              : html`<b>Detecting your location…</b>`}</span>
            <button type="button" class="btn sm" onClick=${startGps}><${Icon} n="locate" size=${15} />Detect my location</button>
          </div>
          <div class="form-grid">
            <div class="field"><label for="sp-lat">Latitude</label><input id="sp-lat" class="input mono" inputmode="decimal" value=${f.lat === null ? '' : f.lat.toFixed(6)} onChange=${(e) => setCoord('lat', e.target.value)} /></div>
            <div class="field"><label for="sp-lng">Longitude</label><input id="sp-lng" class="input mono" inputmode="decimal" value=${f.lng === null ? '' : f.lng.toFixed(6)} onChange=${(e) => setCoord('lng', e.target.value)} /></div>
          </div>
          ${acc && acc > 150 && gpsState === 'live' ? html`<p class="note">Laptops often know their location only roughly. Stand at the parking space when you add it, or click the map to put the pin exactly on your gate.</p>` : null}
          <div class="pickmap"><${MapView} spots=${[]} user=${null} focus=${focus} onSelect=${() => {}} onPick=${pick} pick=${f.lat !== null ? { lat: f.lat, lng: f.lng } : null} areas=${AREAS} /></div>
          <small class="faint" style="font-size:12px">Click the map if you need to move the pin.</small></div>`}
        <div class="field" style="grid-column:1/-1"><label for="sp-addr">Address</label><input id="sp-addr" class="input" placeholder=${editing ? 'Leave empty to keep the current address' : 'House / building, street, area, PIN code'} value=${f.address} onInput=${(e) => set('address', e.target.value)} /></div>
        <div class="field"><label for="sp-price">Price per hour (₹)</label><input id="sp-price" class="input num" type="number" min="1" max="10000" placeholder=${editing ? 'Keep current' : '40'} value=${f.price} onInput=${(e) => set('price', e.target.value)} /></div>
        <div class="field"><label for="sp-car">Car bays</label><input id="sp-car" class="input num" type="number" min="0" max="50" value=${f.car} onInput=${(e) => set('car', e.target.value)} /></div>
        <div class="field"><label for="sp-bike">Bike bays</label><input id="sp-bike" class="input num" type="number" min="0" max="50" value=${f.bike} onInput=${(e) => set('bike', e.target.value)} /></div>
        <div class="field" style="grid-column:1/-1"><label for="sp-desc">Directions for drivers (optional)</label><input id="sp-desc" class="input" placeholder="e.g. Enter from the back gate, basement level 1" value=${f.description} onInput=${(e) => set('description', e.target.value)} /></div>
        <div class="field" style="grid-column:1/-1"><label for="sp-photos">Photos <span class="faint" style="font-weight:500">(optional · up to 5)</span></label>
          <div class="photopick">
            ${previews.map((u, i) => html`<div class="ph"><img src=${u} alt=${'Photo ' + (i + 1)} /><button type="button" aria-label=${'Remove photo ' + (i + 1)} onClick=${() => setFiles(files.filter((_, j) => j !== i))}><${Icon} n="x" size=${14} /></button></div>`)}
            ${files.length < 5 && html`<label class="ph add"><input id="sp-photos" type="file" accept="image/*" multiple hidden onChange=${(e) => { addFiles(e.target.files); e.target.value = ''; }} /><${Icon} n="plus" /><span>Add photo</span></label>`}
          </div>
          <small class="faint" style="font-size:12px">Photos help drivers find your gate, but you can skip this and add them later.</small></div>
      </div>
      ${err && html`<p class="error">${err}</p>`}
      <div class="inline"><button class="btn primary" type="submit" disabled=${busy}>${stage === 'photos' ? 'Uploading photos…' : busy ? 'Saving…' : editing ? 'Save changes' : 'Add spot'}</button><button class="btn ghost" type="button" onClick=${onClose}>Cancel</button></div>
    </form>`;
  }

  function OwnerToday({ user, dash, bookings, reloadAll, payouts, go }) {
    const now = useNow(1000);
    const list = bookings || [];
    const leaving = list.filter((b) => b.status === 'checkout_pending');
    const arriving = list.filter((b) => b.status === 'reserved' && (!b.otp_expires_at || ts(b.otp_expires_at) > now - 60000));
    const parked = list.filter((b) => b.status === 'active');
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const open = payouts && payouts.open_request;
    const balance = dash ? num(dash.balance) : 0;
    const [busy, setBusy] = useState(false);
    const trend = (dash && dash.revenue_trend) || [0, 0, 0, 0, 0, 0, 0];
    return html`
      <div class="dash-head">
        <div><p class="eyebrow">Spot owner</p><h1>${greet}, ${firstName(user)}</h1></div>
        <div class="inline">${dash && html`<button class="toggle-pill" aria-pressed=${!!dash.global_online} onClick=${async () => { setBusy(true); await attempt(() => api.put('/spots/toggle-all', { online: !dash.global_online }), dash.global_online ? 'Your spots are now offline' : 'Your spots are live'); setBusy(false); reloadAll(); }} disabled=${busy}><span class="toggle" aria-hidden="true"></span>${dash.global_online ? 'Accepting bookings' : 'Offline'}</button>`}</div>
      </div>
      <section class="kpis">
        <div class="kpi"><span class="eyebrow">Wallet</span><b class="num">${dash ? inr(balance) : '…'}</b>
          <div class="row"><small class="faint">${open ? inr(open.amount) + ' on its way to your bank' : balance < 0 ? 'Platform dues to clear' : 'Ready to send to your bank'}</small>
          <button class="btn sm primary" disabled=${!payouts || !!open || !payouts.can_request || balance < num(payouts && payouts.min_amount)} title=${payouts && payouts.blocked_reason || ''} onClick=${async () => { const r = await attempt(() => api.post('/payouts/request', {}), (x) => x.message || 'Payout requested'); if (r) reloadAll(); }}>Request payout</button></div></div>
        <div class="kpi"><span class="eyebrow">Earned so far</span><b class="num">${dash ? inr(Math.round(num(dash.earnings))) : '…'}</b><small class="faint">${dash && num(dash.pending_earnings) > 0 ? inr(num(dash.pending_earnings)) + ' waiting for driver payment' : "after ParkStop's fee"}</small></div>
        <div class="kpi"><span class="eyebrow">Cars parked now</span><b class="num">${parked.length}</b><small class="faint">${arriving.length} arriving · ${leaving.length} leaving</small></div>
        <div class="kpi"><span class="eyebrow">Bays in use</span><b class="num">${dash ? num(dash.occupancy_rate) + '%' : '…'}</b><small class="faint">${dash ? `${dash.active_spots} live spot${dash.active_spots === 1 ? '' : 's'} · avg stay ${num(dash.avg_duration)} h` : ''}</small></div>
      </section>
      <section class="grid2">
        <div class="col">
          <div class=${'card' + (leaving.length || arriving.length ? ' need' : '')}>
            <div class="card-h"><h2>Needs you</h2><span class=${'chip ' + (leaving.length + arriving.length ? 'sig' : '')}>${leaving.length + arriving.length} waiting</span></div>
            <div class="card-b">
              ${leaving.map((b) => html`<div class="row-item" style="flex-wrap:wrap">
                <div class="grow"><b>Leaving · ${String(b.slot_name || 'bay').replace(/^Slot\s*/i, 'bay ')}</b><small>${(b.parking_spots || {}).title} · ${(b.users && b.users.full_name) || 'Driver'} · asked ${ago(b.actual_end_time || b.updated_at)}</small></div>
                <button class="btn sm primary" onClick=${async () => { const r = await attempt(() => api.post(`/bookings/${b.id}/confirm-checkout`), 'Confirmed. The driver can now pay.'); if (r) reloadAll(); }}>Car has left</button></div>`)}
              ${arriving.map((b) => html`<${CheckInRow} key=${b.id} b=${b} reload=${reloadAll} />`)}
              ${!bookings ? html`<${Busy} />` : !leaving.length && !arriving.length && html`<div class="empty">Nothing waiting. New bookings and checkouts appear here the moment they happen.</div>`}
            </div>
          </div>
          <div class="card"><div class="card-h"><h2>Parked now</h2></div><div class="card-b">
            ${parked.length ? parked.map((b) => html`<div class="row-item"><div class="grow"><b>${String(b.slot_name || 'Bay').replace(/^Slot\s*/i, 'Bay ')} · ${(b.parking_spots || {}).title}</b><small>${(b.users && b.users.full_name) || 'Driver'} · since ${time(b.start_time)} · until ${time(b.end_time)}</small></div><span class="num mono" style="font-size:13px">${hms(now - ts(b.start_time))}</span></div>`) : html`<div class="empty">No cars parked right now.</div>`}
          </div></div>
        </div>
        <div class="col">
          <div class="card"><div class="card-h"><h2>Earnings, last 7 days</h2><span class="faint num" style="font-size:13px">${inr(Math.round(trend.reduce((a, v) => a + num(v), 0)))} total</span></div>
            <div class="card-b"><${BarChart} values=${trend.map(num)} labels=${last7()} money=${true} aria="Earnings over the last 7 days" /></div></div>
          <div class="card"><div class="card-h"><h2>Recent activity</h2><button class="linkbtn" onClick=${() => go('earnings')}>All earnings</button></div><div class="card-b">
            ${list.slice(0, 6).map((b) => { const c = STATUS_CHIP[b.status] || [b.status, '']; return html`<div class="row-item"><div class="grow"><b>${(b.parking_spots || {}).title}</b><small>#${b.id} · ${(b.users && b.users.full_name) || 'Driver'} · ${ago(b.updated_at || b.created_at)}</small></div><span class=${'chip ' + c[1]}>${c[0]}</span><span class="num" style="min-width:60px;text-align:right">${b.status === 'completed' ? inr(b.spotter_earning) : '—'}</span></div>`; })}
            ${bookings && !list.length && html`<div class="empty">No bookings yet.</div>`}
          </div></div>
        </div>
      </section>`;
  }

  function OwnerSpots({ dash, reloadAll }) {
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState(null);
    const [del, setDel] = useState(null);
    const inv = (dash && dash.inventory) || [];
    const near = HOME;
    return html`
      <div class="dash-head"><div><p class="eyebrow">Spot owner</p><h1>Your spots</h1></div><button class="btn primary" onClick=${() => { setAdding(true); setEditing(null); }}><${Icon} n="plus" size=${16} />Add a spot</button></div>
      ${adding && html`<div class="card"><div class="card-h"><h2>New spot</h2></div><${SpotForm} near=${near} onClose=${() => setAdding(false)} onSaved=${() => { setAdding(false); reloadAll(); }} /></div>`}
      ${!dash ? html`<${Busy} />` : !inv.length ? html`<div class="card"><div class="empty">${dash.global_online === false ? 'Your spots are offline. Turn on “Accepting bookings” on the Today tab to see them here.' : 'You have not added a spot yet. Add your first one — it takes two minutes.'}</div></div>` : html`<div class="spotgrid">
        ${inv.map((sp) => html`<div class="card">
          <div class="card-h"><div style="min-width:0"><h2 style="font-size:16px">${sp.title}</h2><small class="faint">${sp.total_slots} bay${sp.total_slots === 1 ? '' : 's'} · ${num(sp.car_slots)} car · ${num(sp.bike_slots)} bike</small></div>
            <div class="inline" style="flex-wrap:nowrap"><button class="iconbtn" aria-label=${'Edit ' + sp.title} onClick=${() => { setEditing(sp.id); setAdding(false); }}><${Icon} n="edit" size=${16} /></button><button class="iconbtn" aria-label=${'Delete ' + sp.title} onClick=${() => setDel(sp.id)}><${Icon} n="trash" size=${16} /></button></div></div>
          <div class="card-b">
            <div class="minibays">${Array.from({ length: num(sp.total_slots) }, (_, i) => html`<span class=${i < num(sp.total_slots) - num(sp.available_slots) ? 's-active' : ''}>${i + 1}</span>`)}</div>
            <small class="faint">${num(sp.available_slots)} of ${sp.total_slots} free right now</small>
            ${del === sp.id && html`<div class="panel"><b>Delete this spot?</b><p class="muted" style="font-size:14px">Drivers will no longer see it. This cannot be undone.</p><div class="inline"><button class="btn" onClick=${() => setDel(null)}>Keep it</button><button class="btn primary" onClick=${async () => { const r = await attempt(() => api.del(`/spots/${sp.id}`), 'Spot deleted'); setDel(null); if (r) reloadAll(); }}>Delete</button></div></div>`}
          </div>
          ${editing === sp.id && html`<${SpotForm} initial=${sp} near=${near} onClose=${() => setEditing(null)} onSaved=${() => { setEditing(null); reloadAll(); }} />`}
        </div>`)}
      </div>`}`;
  }

  function OwnerEarnings({ payouts, reloadAll }) {
    const [days, setDays] = useState(30);
    const [data, reload, err] = useLive(() => api.get(`/spots/earnings-breakdown?days=${days}`).then((r) => r.data), [days]);
    const t = data && data.totals;
    return html`
      <div class="dash-head"><div><p class="eyebrow">Spot owner</p><h1>Earnings & payouts</h1></div>
        <div class="seg">${[7, 30, 90].map((d) => html`<button aria-pressed=${days === d} onClick=${() => setDays(d)}>${d} days</button>`)}</div></div>
      ${err && !data ? html`<${ErrorBox} msg=${err} retry=${reload} />` : null}
      <section class="kpis">
        <div class="kpi"><span class="eyebrow">Drivers paid</span><b class="num">${t ? inr(t.gross) : '…'}</b><small class="faint">${t ? t.bookings + ' parkings' : ''}</small></div>
        <div class="kpi"><span class="eyebrow">ParkStop fee</span><b class="num">${t ? inr(t.fees) : '…'}</b><small class="faint">platform commission</small></div>
        <div class="kpi"><span class="eyebrow">You earned</span><b class="num">${t ? inr(t.earnings) : '…'}</b><small class="faint">last ${days} days</small></div>
        <div class="kpi"><span class="eyebrow">Payout account</span><b class="num" style="font-size:20px">${payouts && payouts.requests[0] && payouts.requests[0].bank_account_last4 ? '••' + payouts.requests[0].bank_account_last4 : payouts && payouts.can_request ? 'Verified' : 'Not set'}</b><small class="faint">${payouts && payouts.blocked_reason ? payouts.blocked_reason : `Minimum payout ${inr(payouts ? payouts.min_amount : 100)}`}</small></div>
      </section>
      <section class="grid2">
        <div class="col"><div class="card"><div class="card-h"><h2>Every parking</h2>${data && data.items_truncated && html`<small class="faint">latest ${data.items_shown}</small>`}</div>
          <div class="table-wrap"><table><thead><tr><th>Booking</th><th>Spot</th><th>Date</th><th class="r">Paid</th><th class="r">Fee</th><th class="r">You get</th></tr></thead><tbody>
            ${(data ? data.items : []).map((it) => html`<tr><td class="mono">#${it.booking_id}</td><td>${it.spot_title}</td><td>${dateShort(it.date)}</td><td class="r num">${inr(it.total_price)}</td><td class="r num">${inr(it.platform_fee)}</td><td class="r num"><b>${inr(it.spotter_earning)}</b></td></tr>`)}
          </tbody></table>${data && !data.items.length && html`<div class="empty">No completed parkings in this period.</div>`}</div></div></div>
        <div class="col">
          <div class="card"><div class="card-h"><h2>By spot</h2></div><div class="card-b">${(data ? data.by_spot : []).map((s) => html`<div class="row-item"><div class="grow"><b>${s.spot_title}</b><small>${s.bookings} parkings · ${inr(s.gross)} paid</small></div><span class="num"><b>${inr(s.earnings)}</b></span></div>`)}${data && !data.by_spot.length && html`<div class="empty">Nothing yet.</div>`}</div></div>
          <div class="card"><div class="card-h"><h2>Payouts</h2></div><div class="card-b">
            ${payouts && payouts.requests.length ? payouts.requests.map((p) => html`<div class="row-item"><div class="grow"><b class="num">${inr(p.amount)}</b><small>${dateShort(p.created_at)} · bank ••${p.bank_account_last4}${p.reference ? ' · UTR ' + p.reference : ''}${p.note ? ' · ' + p.note : ''}</small></div>
              <span class=${'chip ' + (p.status === 'paid' ? 'ok' : p.status === 'requested' ? 'warn' : 'bad')}>${p.status === 'requested' ? 'On its way' : p.status === 'paid' ? 'Paid' : 'Not sent'}</span></div>`) : html`<div class="empty">No payouts yet. Request one from your wallet on the Today tab.</div>`}
          </div></div>
        </div>
      </section>`;
  }

  // ---- owner verification ----
  const DOC_TYPES = [['electricity_bill', 'Electricity bill'], ['property_tax', 'Property tax receipt'], ['rent_agreement', 'Rent agreement'], ['sale_deed', 'Sale deed'], ['water_bill', 'Water bill'], ['other', 'Other document']];
  function SelfieCapture({ onFile }) {
    const vid = useRef(null);
    const [stream, setStream] = useState(null);
    const [shot, setShot] = useState(null);
    const [err, setErr] = useState('');
    useEffect(() => () => { stream && stream.getTracks().forEach((t) => t.stop()); }, [stream]);
    const start = async () => {
      setErr('');
      try { const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 720, height: 720 } }); setStream(s); setTimeout(() => { if (vid.current) { vid.current.srcObject = s; vid.current.play(); } }, 0); }
      catch (e) { setErr('Camera is blocked. Allow camera for this site, or upload a fresh selfie photo instead.'); }
    };
    const take = () => {
      const v = vid.current; if (!v) return;
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob((blob) => { const file = new File([blob], 'selfie.jpg', { type: 'image/jpeg' }); setShot(URL.createObjectURL(blob)); onFile(file); stream.getTracks().forEach((t) => t.stop()); setStream(null); }, 'image/jpeg', 0.92);
    };
    return html`<div class="camera">
      ${stream ? html`<video ref=${vid} playsinline muted></video><button type="button" class="btn primary" onClick=${take}>Take selfie</button>`
        : shot ? html`<img src=${shot} alt="Your selfie" /><button type="button" class="btn" onClick=${start}>Retake</button>`
        : html`<div class="inline"><button type="button" class="btn primary" onClick=${start}>Open camera</button><label class="btn"><input type="file" accept="image/*" capture="user" hidden onChange=${(e) => { const f = e.target.files && e.target.files[0]; if (f) { setShot(URL.createObjectURL(f)); onFile(f); } }} />Upload a photo</label></div>`}
      ${err && html`<p class="error">${err}</p>`}
    </div>`;
  }
  function OwnerVerify({ reloadAll }) {
    const [v, reload, err] = useLive(() => api.get('/owner-verification').then((r) => r.data), []);
    const [open, setOpen] = useState(null);
    const [dl, setDl] = useState(null);
    const [pan, setPan] = useState('');
    const [bank, setBank] = useState({ acc: '', acc2: '', ifsc: '' });
    const [selfie, setSelfie] = useState(null);
    const [prop, setProp] = useState({ type: 'electricity_bill', address: '', file: null });
    const [busy, setBusy] = useState(false);
    const run = async (fn, msg) => { setBusy(true); const r = await attempt(fn, msg); setBusy(false); if (r) { await reload(); reloadAll(); setOpen(null); } return r; };
    if (!v) return err ? html`<${ErrorBox} msg=${err} retry=${reload} />` : html`<${Busy} />`;
    const locked = v.status === 'pending' || v.status === 'approved';
    const d = v.details || {};
    const steps = [
      { k: 'aadhaar', t: 'Aadhaar', done: v.steps.aadhaar, info: d.aadhaar && `${d.aadhaar.name} · ••${d.aadhaar.last4}`, why: 'Confirms who you are, through DigiLocker.' },
      { k: 'pan', t: 'PAN card', done: v.steps.pan, info: d.pan && d.pan.masked, why: 'Must be your personal PAN, in the same name.' },
      { k: 'selfie', t: 'Live selfie', done: v.steps.selfie, info: 'Face matched with Aadhaar', why: 'A fresh photo of you, matched to your Aadhaar photo.' },
      { k: 'bank', t: 'Bank account', done: v.steps.bank, info: d.bank && `${d.bank.bank_name || 'Bank'} ••${d.bank.last4}`, why: 'Your earnings are paid here. It must be in your name.' },
      { k: 'property', t: 'Property proof', done: v.steps.property, info: d.property && (DOC_TYPES.find((x) => x[0] === d.property.doc_type) || [0, 'Document'])[1], why: 'Shows you may rent out this space. Checked by our team.' },
    ];
    const statusChip = { approved: ['Verified', 'ok'], pending: ['Under review', 'warn'], rejected: ['Needs changes', 'bad'], in_progress: ['In progress', ''], not_started: ['Not started', ''] }[v.status] || [v.status, ''];
    const body = (k) => {
      if (k === 'aadhaar') return html`<div class="stack">
        <p class="muted" style="font-size:14px">DigiLocker opens in a new tab. Sign in there and tap <b>Allow</b> to share your Aadhaar. Then come back here.</p>
        ${dl ? html`<a class="btn blue" href=${dl} target="_blank" rel="noopener">Open DigiLocker</a>` : html`<button class="btn blue" disabled=${busy} onClick=${async () => { setBusy(true); const r = await attempt(() => api.post('/owner-verification/aadhaar/start')); setBusy(false); if (r && r.data) setDl(r.data.url); }}>Get DigiLocker link</button>`}
        <button class="btn primary" disabled=${busy || !dl} onClick=${() => run(() => api.post('/owner-verification/aadhaar/complete'), 'Aadhaar verified')}>I have finished in DigiLocker</button></div>`;
      if (k === 'pan') return html`<form class="stack" onSubmit=${(e) => { e.preventDefault(); run(() => api.post('/owner-verification/pan', { pan: pan.trim().toUpperCase() }), 'PAN verified'); }}>
        <input id="pan" class="input mono" maxlength="10" placeholder="ABCDE1234F" value=${pan} onInput=${(e) => setPan(e.target.value.toUpperCase())} />
        <button class="btn primary" disabled=${busy || pan.length !== 10}>Verify PAN</button></form>`;
      if (k === 'selfie') return html`<div class="stack"><${SelfieCapture} onFile=${setSelfie} />
        <button class="btn primary" disabled=${busy || !selfie} onClick=${() => { const fd = new FormData(); fd.append('image', selfie); run(() => api.post('/owner-verification/selfie', fd), 'Selfie verified'); }}>Check my selfie</button></div>`;
      if (k === 'bank') return html`<form class="stack" onSubmit=${(e) => { e.preventDefault(); if (bank.acc !== bank.acc2) { toast('The two account numbers do not match.', 'bad'); return; } run(() => api.post('/owner-verification/bank', { account_number: bank.acc.trim(), ifsc: bank.ifsc.trim().toUpperCase() }), 'Bank account verified'); }}>
        <input id="acc" class="input mono" inputmode="numeric" placeholder="Account number" value=${bank.acc} onInput=${(e) => setBank({ ...bank, acc: e.target.value.replace(/\s/g, '') })} />
        <input id="acc2" class="input mono" inputmode="numeric" placeholder="Type the account number again" value=${bank.acc2} onInput=${(e) => setBank({ ...bank, acc2: e.target.value.replace(/\s/g, '') })} />
        <input id="ifsc" class="input mono" maxlength="11" placeholder="IFSC, e.g. SBIN0001234" value=${bank.ifsc} onInput=${(e) => setBank({ ...bank, ifsc: e.target.value.toUpperCase() })} />
        <button class="btn primary" disabled=${busy || !bank.acc || bank.ifsc.length !== 11}>Verify bank account</button></form>`;
      return html`<form class="stack" onSubmit=${(e) => { e.preventDefault(); const fd = new FormData(); fd.append('doc_type', prop.type); fd.append('address', prop.address.trim()); fd.append('document', prop.file); run(() => api.post('/owner-verification/property', fd), 'Document uploaded'); }}>
        <select id="doctype" class="input" value=${prop.type} onChange=${(e) => setProp({ ...prop, type: e.target.value })}>${DOC_TYPES.map(([k2, t]) => html`<option value=${k2}>${t}</option>`)}</select>
        <input id="propaddr" class="input" placeholder="Full address of the parking space" value=${prop.address} onInput=${(e) => setProp({ ...prop, address: e.target.value })} />
        <input id="propfile" class="input" type="file" accept="image/*" onChange=${(e) => setProp({ ...prop, file: (e.target.files || [])[0] || null })} />
        <button class="btn primary" disabled=${busy || !prop.file || prop.address.trim().length < 10}>Upload document</button></form>`;
    };
    return html`
      <div class="dash-head"><div><p class="eyebrow">Spot owner</p><h1>Verification</h1></div><span class=${'chip ' + statusChip[1]}>${statusChip[0]}</span></div>
      ${v.status === 'rejected' && v.rejection_reason && html`<div class="banner bad"><b>Our team asked for changes:</b> ${v.rejection_reason}</div>`}
      ${v.status === 'pending' && html`<div class="banner"><b>Thanks — we are checking your details.</b> Your spots go live for drivers as soon as you are approved.</div>`}
      ${v.status === 'approved' && html`<div class="banner ok"><b>You are verified.</b> Your spots are visible to drivers and payouts go to your bank.</div>`}
      <div class="card"><div class="card-b" style="gap:0">
        ${steps.map((s, i) => html`<div class="vstep">
          <div class="vstep-h">
            <span class=${'vdot' + (s.done ? ' done' : '')}>${s.done ? html`<${Icon} n="check" size=${14} />` : i + 1}</span>
            <div class="grow"><b>${s.t}</b><small class="faint">${s.done ? s.info : s.why}</small></div>
            ${!locked && html`<button class="btn sm" onClick=${() => setOpen(open === s.k ? null : s.k)}>${open === s.k ? 'Close' : s.done ? 'Redo' : 'Start'}</button>`}
          </div>
          ${open === s.k && !locked && html`<div class="vstep-b">${body(s.k)}</div>`}
        </div>`)}
      </div></div>
      ${!locked && html`<button class="btn primary block" disabled=${!v.all_done || busy} onClick=${() => run(() => api.post('/owner-verification/submit'), 'Sent for review. We will notify you.')}>${v.all_done ? 'Submit for review' : 'Finish all 5 steps to submit'}</button>`}`;
  }

  function Owner({ user, me, reloadMe }) {
    const [tab, setTab] = useState(() => (/#\/owner\/(spots|earnings|verify)/.exec(location.hash) || [0, 'today'])[1]);
    const goTab = (t) => { setTab(t); history.replaceState(null, '', `#/owner/${t}`); };
    const [dash, reloadDash] = useLive(() => api.get('/spots/dashboard').then((r) => r.data), [], { every: 20000, events: ['booking:new', 'booking:paid'] });
    const [bookings, reloadBookings] = useLive(() => api.get('/bookings/spotter-bookings').then((r) => r.data || []), [], { every: 8000, events: ['booking:new', 'booking:checkout_requested', 'booking:cancelled', 'booking:paid'] });
    const [payouts, reloadPayouts] = useLive(() => api.get('/payouts/requests').then((r) => r.data), [], { every: 30000 });
    useEffect(() => onRealtime('booking:new', () => toast('New booking! A driver is on the way.')), []);
    useEffect(() => onRealtime('booking:checkout_requested', () => toast('A driver is leaving. Confirm the car has left.')), []);
    const [ver, reloadVer] = useLive(() => api.get('/owner-verification').then((r) => r.data), [], { every: 60000 });
    const reloadAll = () => { reloadDash(); reloadBookings(); reloadPayouts(); reloadVer(); reloadMe(); };
    const vs = ver ? ver.status : 'approved';
    const tabs = [['today', 'Today'], ['spots', 'Spots'], ['earnings', 'Earnings'], ['verify', 'Verification']];
    return html`<main class="dash"><div class="dash-in">
      <nav class="tabs" aria-label="Owner sections">${tabs.map(([k, t]) => html`<button aria-pressed=${tab === k} onClick=${() => goTab(k)}>${t}${k === 'verify' && vs !== 'approved' ? html`<i class="dotwarn"></i>` : null}</button>`)}</nav>
      ${vs !== 'approved' && tab !== 'verify' && html`<div class="banner"><b>${vs === 'pending' ? 'Your verification is under review.' : 'Drivers cannot see your spots yet.'}</b> ${vs === 'pending' ? 'Your spots go live as soon as our team approves you.' : 'Finish owner verification so your spots appear and you can get paid.'} ${vs !== 'pending' && html`<button class="linkbtn" onClick=${() => goTab('verify')}>Verify now</button>`}</div>`}
      ${tab === 'today' && html`<${OwnerToday} user=${user} dash=${dash} bookings=${bookings} payouts=${payouts} reloadAll=${reloadAll} go=${goTab} />`}
      ${tab === 'spots' && html`<${OwnerSpots} dash=${dash} reloadAll=${reloadAll} />`}
      ${tab === 'earnings' && html`<${OwnerEarnings} payouts=${payouts} reloadAll=${reloadAll} />`}
      ${tab === 'verify' && html`<${OwnerVerify} reloadAll=${reloadAll} />`}
    </div></main>`;
  }

  // ---------------- admin ----------------
  function AdminOverview() {
    const [data, reload, err] = useLive(() => api.get('/analytics/platform').then((r) => r.data), [], { every: 60000 });
    const [pv] = useLive(() => api.get('/owner-verification/admin/list?status=pending').then((r) => r.data || []), []);
    const [po] = useLive(() => api.get('/payouts/admin/requests?status=requested').then((r) => r.data || []), []);
    const s = (data && data.summary) || {};
    const months = ((data && data.monthly_revenue) || []).slice(-6);
    return html`
      <div class="dash-head"><div><p class="eyebrow">ParkStop admin</p><h1>Platform overview</h1></div><button class="btn sm" onClick=${reload}><${Icon} n="refresh" size=${15} />Refresh</button></div>
      ${err && !data ? html`<${ErrorBox} msg=${err} retry=${reload} />` : null}
      <section class="kpis">
        <div class="kpi"><span class="eyebrow">Completed parkings</span><b class="num">${data ? num(s.total_completed_bookings) : '…'}</b><small class="faint">${data ? num(s.total_bookings) + ' bookings in total' : ''}</small></div>
        <div class="kpi"><span class="eyebrow">Paid by drivers</span><b class="num">${data ? inr(Math.round(num(s.total_revenue))) : '…'}</b><small class="faint">all time</small></div>
        <div class="kpi"><span class="eyebrow">ParkStop commission</span><b class="num">${data ? inr(Math.round(num(s.platform_earnings))) : '…'}</b><small class="faint">owners earned ${data ? inr(Math.round(num(s.spotter_payout))) : '…'}</small></div>
        <div class="kpi"><span class="eyebrow">Waiting for you</span><b class="num">${pv && po ? pv.length + po.length : '…'}</b><small class="faint">${pv ? pv.length : '…'} verifications · ${po ? po.length : '…'} payouts</small></div>
      </section>
      <div class="card"><div class="card-h"><h2>Commission by month</h2></div><div class="card-b">
        ${months.length ? html`<${BarChart} values=${months.map((m) => Math.round(num(m.platform_revenue)))} labels=${months.map((m) => new Date(m.month).toLocaleDateString('en-IN', { month: 'short' }))} money=${true} aria="Commission by month" />` : html`<div class="empty">No completed parkings yet.</div>`}
      </div></div>`;
  }
  function AdminVerifications() {
    const [status, setStatus] = useState('pending');
    const [list, reload, err] = useLive(() => api.get(`/owner-verification/admin/list?status=${status}`).then((r) => r.data || []), [status]);
    const [sel, setSel] = useState(null);
    const [detail, setDetail] = useState(null);
    const [why, setWhy] = useState('');
    const [mode, setMode] = useState(null);
    useEffect(() => { setDetail(null); if (sel) api.get(`/owner-verification/admin/${sel}`).then((r) => setDetail(r.data)).catch((e) => toast(e.message, 'bad')); }, [sel]);
    const after = () => { setSel(null); setMode(null); setWhy(''); reload(); };
    return html`
      <div class="dash-head"><div><p class="eyebrow">ParkStop admin</p><h1>Owner verifications</h1></div>
        <div class="seg">${[['pending', 'To review'], ['in_progress', 'In progress'], ['approved', 'Approved'], ['rejected', 'Sent back']].map(([k, t]) => html`<button aria-pressed=${status === k} onClick=${() => { setStatus(k); setSel(null); }}>${t}</button>`)}</div></div>
      <section class="grid2">
        <div class="col"><div class="card"><div class="card-b">
          ${!list ? (err ? html`<${ErrorBox} msg=${err} retry=${reload} />` : html`<${Busy} />`) : list.length ? list.map((o) => html`<button class=${'row-item rowbtn' + (sel === o.user_id ? ' on' : '')} onClick=${() => setSel(o.user_id)}>
            <div class="grow"><b>${o.aadhaar_name || o.account_name || o.email}</b><small>${o.email}${o.submitted_at ? ' · submitted ' + ago(o.submitted_at) : ''}</small></div>
            ${o.flags.length ? html`<span class="chip warn">${o.flags.length} flag${o.flags.length > 1 ? 's' : ''}</span>` : null}</button>`) : html`<div class="empty">Nothing here.</div>`}
        </div></div></div>
        <div class="col">${sel && html`<div class="card"><div class="card-h"><h2>${detail ? (detail.aadhaar.name || detail.user.full_name) : 'Loading…'}</h2>${detail && html`<span class="chip">${detail.status}</span>`}</div>
          ${!detail ? html`<${Busy} />` : html`<div class="card-b">
            <div class="kvlist">
              <div><span>Account</span><b>${detail.user.full_name} · ${detail.user.email}${detail.user.phone ? ' · ' + detail.user.phone : ''}</b></div>
              <div><span>Aadhaar</span><b>${detail.aadhaar.verified_at ? `${detail.aadhaar.name} · ••${detail.aadhaar.last4} · ${detail.aadhaar.dob || ''} · ${detail.aadhaar.state || ''}` : 'Not done'}</b></div>
              <div><span>PAN</span><b>${detail.pan.verified_at ? `${detail.pan.masked} · ${detail.pan.registered_name} · match ${detail.pan.name_match} · Aadhaar-linked ${detail.pan.aadhaar_linked || '?'}` : 'Not done'}</b></div>
              <div><span>Selfie</span><b>${detail.selfie.verified_at ? `Liveness ${detail.selfie.liveness_score} · face match ${detail.selfie.face_match_score}` : 'Not done'}</b></div>
              <div><span>Bank</span><b>${detail.bank.verified_at ? `${detail.bank.bank_name || ''} ••${detail.bank.last4} · ${detail.bank.ifsc} · name at bank ${detail.bank.name_at_bank} (${detail.bank.name_match})` : 'Not done'}</b></div>
              <div><span>Property</span><b>${detail.property.uploaded_at ? `${(DOC_TYPES.find((x) => x[0] === detail.property.doc_type) || [0, detail.property.doc_type])[1]} · ${detail.property.address}` : 'Not done'}</b></div>
              <div><span>Spots</span><b>${(detail.user.parking_spots || []).map((p) => p.title).join(', ') || 'None yet'}</b></div>
            </div>
            ${detail.property.doc_url && html`<a href=${detail.property.doc_url} target="_blank" rel="noopener"><img class="docimg" src=${detail.property.doc_url} alt="Property document" /></a>`}
            ${(detail.flags || []).length > 0 && html`<div class="banner">${detail.flags.map((f) => html`<div><b>${f.code}</b> ${f.note || ''}</div>`)}</div>`}
            ${['pending', 'approved'].includes(detail.status) && (mode === 'reject' ? html`<form class="inline" onSubmit=${async (e) => { e.preventDefault(); if (await attempt(() => api.post(`/owner-verification/admin/${sel}/reject`, { reason: why }), 'Sent back to the owner')) after(); }}>
                <input id="why" class="input" style="flex:1;min-width:200px" placeholder="What should they fix?" value=${why} onInput=${(e) => setWhy(e.target.value)} />
                <button class="btn sm" type="submit">Send back</button><button class="btn sm ghost" type="button" onClick=${() => setMode(null)}>Cancel</button></form>`
              : html`<div class="inline">${detail.status === 'pending' && html`<button class="btn primary" onClick=${async () => { if (await attempt(() => api.post(`/owner-verification/admin/${sel}/approve`), 'Owner approved. Their spots are live.')) after(); }}>Approve owner</button>`}<button class="btn" onClick=${() => setMode('reject')}>Send back</button></div>`)}
          </div>`}</div>`}</div>
      </section>`;
  }
  function PayoutRow({ p, reload }) {
    const [mode, setMode] = useState(null);
    const [val, setVal] = useState('');
    return html`<div class="row-item" style="flex-direction:column;align-items:stretch;gap:10px">
      <div class="inline" style="justify-content:space-between"><div><b class="num" style="font-size:18px">${inr(p.amount)}</b><small>${p.owner.name} · ${p.owner.email} · requested ${ago(p.created_at)}</small></div>
        ${p.status === 'requested' && !mode ? html`<div class="inline"><button class="btn sm primary" onClick=${() => { setMode('paid'); setVal(''); }}>Mark paid</button><button class="btn sm" onClick=${() => { setMode('reject'); setVal(''); }}>Reject</button></div>`
          : p.status !== 'requested' && html`<span class=${'chip ' + (p.status === 'paid' ? 'ok' : 'bad')}>${p.status === 'paid' ? 'Paid · ' + (p.reference || '') : 'Rejected'}</span>`}</div>
      <div class="panel mono" style="padding:10px 12px;gap:2px;font-size:13px"><span class="eyebrow" style="font-family:var(--body)">Send to</span>
        <span>${p.pay_to.account_name || '—'}</span><span>A/c ${p.pay_to.account_number || '—'}</span><span>IFSC ${p.pay_to.ifsc || '—'}</span></div>
      ${mode && html`<form class="inline" onSubmit=${async (e) => { e.preventDefault(); const r = mode === 'paid' ? await attempt(() => api.post(`/payouts/admin/requests/${p.id}/paid`, { reference: val.trim() }), 'Marked paid. The owner has been told.') : await attempt(() => api.post(`/payouts/admin/requests/${p.id}/reject`, { reason: val.trim() }), 'Rejected. The money is back in their wallet.'); if (r) { setMode(null); reload(); } }}>
        <input id=${'pv-' + p.id} class="input" style="flex:1;min-width:180px" placeholder=${mode === 'paid' ? 'Bank reference (UTR)' : 'Reason, e.g. bank account closed'} value=${val} onInput=${(e) => setVal(e.target.value)} />
        <button class="btn sm primary" type="submit">${mode === 'paid' ? 'Confirm paid' : 'Reject'}</button><button class="btn sm ghost" type="button" onClick=${() => setMode(null)}>Cancel</button></form>`}
    </div>`;
  }
  function AdminPayouts() {
    const [status, setStatus] = useState('requested');
    const [list, reload, err] = useLive(() => api.get(`/payouts/admin/requests?status=${status}`).then((r) => r.data || []), [status], { every: 30000 });
    return html`
      <div class="dash-head"><div><p class="eyebrow">ParkStop admin</p><h1>Owner payouts</h1></div>
        <div class="seg">${[['requested', 'To send'], ['paid', 'Paid'], ['rejected', 'Rejected']].map(([k, t]) => html`<button aria-pressed=${status === k} onClick=${() => setStatus(k)}>${t}</button>`)}</div></div>
      <div class="card"><div class="card-b">
        ${!list ? (err ? html`<${ErrorBox} msg=${err} retry=${reload} />` : html`<${Busy} />`) : list.length ? list.map((p) => html`<${PayoutRow} key=${p.id} p=${p} reload=${reload} />`) : html`<div class="empty">No payouts here.</div>`}
        ${status === 'requested' && html`<p class="note">Send the money by IMPS or NEFT from the ParkStop bank account, then mark it paid with the UTR.</p>`}
      </div></div>`;
  }
  function Admin() {
    const [tab, setTab] = useState(() => (/#\/admin\/(verifications|payouts)/.exec(location.hash) || [0, 'overview'])[1]);
    const goTab = (t) => { setTab(t); history.replaceState(null, '', `#/admin/${t}`); };
    return html`<main class="dash"><div class="dash-in">
      <nav class="tabs" aria-label="Admin sections">${[['overview', 'Overview'], ['verifications', 'Verifications'], ['payouts', 'Payouts']].map(([k, t]) => html`<button aria-pressed=${tab === k} onClick=${() => goTab(k)}>${t}</button>`)}</nav>
      ${tab === 'overview' && html`<${AdminOverview} />`}
      ${tab === 'verifications' && html`<${AdminVerifications} />`}
      ${tab === 'payouts' && html`<${AdminPayouts} />`}
    </div></main>`;
  }

  // ---------------- app ----------------
  function Splash({ label }) {
    return html`<div class="splash"><div class="brand" style="font-size:26px"><span class="psign">P</span>ParkStop</div><div class="spinner"></div><p class="muted">${label || 'Loading…'}</p></div>`;
  }

  function App() {
    const [phase, setPhase] = useState('boot'); // boot | out | role | in
    const [me, setMe] = useState(null);
    const [view, setView] = useState(null); // driver | owner | admin
    const [ownerGate, setOwnerGate] = useState(null); // { needDetails, needCode, back }
    const freshRef = useRef(false);
    const flowRef = useRef(false);
    const phaseRef = useRef('boot'); phaseRef.current = phase;
    const flow = { begin: () => { flowRef.current = true; }, end: () => { flowRef.current = false; } };

    useEffect(() => { const th = ls.get('ps-theme'); if (th) document.documentElement.setAttribute('data-theme', th); }, []);

    const landOn = (u, preferred, fresh) => {
      if (String(u.role).toUpperCase() === 'ADMIN') { setView('admin'); setPhase('in'); return; }
      const want = preferred || ls.get('ps-web-view:' + u.id);
      const v = want === 'drive' ? 'driver' : want;
      // A sign-in that has just passed the email code counts as owner confirmation —
      // but only if the person goes straight to owner mode. Switching later asks again.
      freshRef.current = !!fresh;
      if (fresh && v === 'owner') ss.set(ownerOkKey(u), '1');
      if (v === 'owner' && !u.is_spotter_registered) { setOwnerGate({ needDetails: true, needCode: false, back: 'role' }); setPhase('owner-gate'); return; }
      if (v === 'owner' && !ss.get(ownerOkKey(u))) { setOwnerGate({ needDetails: false, needCode: true, back: 'role' }); setPhase('owner-gate'); return; }
      if (v === 'driver' || v === 'owner') { freshRef.current = false; setView(v); setPhase('in'); }
      else setPhase('role');
    };
    const signOut = async (msg) => {
      try { await api.post('/auth/logout', {}, { noSessionCheck: true }); } catch (e) {}
      disconnectRealtime(); flow.end();
      await auth.signOut().catch(() => {});
      if (me) ss.del(ownerOkKey(me));
      setMe(null); setView(null); setOwnerGate(null); setPhase('out');
      history.replaceState(null, '', '#/');
      if (msg) toast(msg, 'bad');
    };
    useEffect(() => { window.PSApi.setOnSessionLost(() => { if (phaseRef.current === 'in' || phaseRef.current === 'role') signOut('Your session ended. Please sign in again.'); }); }, []);

    useEffect(() => auth.onChange(async (u) => {
      if (flowRef.current) return; // a sign-in is in progress; it finishes itself
      if (!u) { if (phaseRef.current !== 'out') { setMe(null); setPhase('out'); } return; }
      if (phaseRef.current !== 'boot') return;
      try {
        const r = await api.get('/auth/profile', { noSessionCheck: true });
        setMe(r.data.user); connectRealtime(); landOn(r.data.user);
      } catch (e) {
        await auth.signOut().catch(() => {}); setPhase('out');
        if (e.status && e.status !== 401) toast(e.message, 'bad');
      }
    }), []);

    const onSignedIn = async (u, preferred) => {
      let user = u;
      try { const r = await api.get('/auth/profile', { noSessionCheck: true }); user = r.data.user; } catch (e) {}
      flow.end();
      if (!user) { await signOut('Could not load your account. Please sign in again.'); return; }
      setMe(user); connectRealtime(); toast(`Welcome, ${firstName(user)}`);
      landOn(user, preferred, true);
    };
    const reloadMe = async () => { try { const r = await api.get('/auth/profile'); setMe(r.data.user); } catch (e) {} };
    const enter = (v) => {
      freshRef.current = false;
      setView(v); setPhase('in');
      history.replaceState(null, '', v === 'driver' ? '#/drive' : v === 'owner' ? '#/owner' : '#/admin');
      window.scrollTo(0, 0);
    };
    const go = async (v) => {
      if (v === view && phase === 'in') return;
      if (v === 'owner') {
        const needDetails = !me.is_spotter_registered;
        const needCode = !ss.get(ownerOkKey(me)) && !(phase === 'role' && freshRef.current);
        if (needDetails || needCode) { setOwnerGate({ needDetails, needCode, back: phase === 'in' ? view : 'role' }); setPhase('owner-gate'); return; }
      }
      if (v === 'driver' || v === 'owner') {
        const r = await attempt(() => api.post('/auth/switch-role', { newRole: v === 'owner' ? 'SPOTTER' : 'FINDER' }));
        if (!r) return;
        if (r.data && r.data.user) setMe((m) => ({ ...m, ...r.data.user }));
        ls.set('ps-web-view:' + (me && me.id), v);
      }
      enter(v);
    };

    if (phase === 'boot') return html`<${Splash} label="Connecting to ParkStop…" />`;
    if (phase === 'out') return html`<${Gate} flow=${flow} onDone=${onSignedIn} /><${Toasts} />`;
    if (phase === 'role') return html`<${RolePick} user=${me} onPick=${go} /><${Toasts} />`;
    if (phase === 'owner-gate') return html`<${OwnerGate} user=${me} ...${ownerGate}
      onCancel=${() => { const b = ownerGate && ownerGate.back; setOwnerGate(null); if (b === 'driver') enter('driver'); else setPhase('role'); }}
      onDone=${async (u, first) => {
        ss.set(ownerOkKey(me), '1');
        try { const r = await api.get('/auth/profile'); setMe(r.data.user); } catch (e) { if (u) setMe((m) => ({ ...m, ...u })); }
        ls.set('ps-web-view:' + me.id, 'owner');
        setOwnerGate(null); enter('owner');
        if (first) { history.replaceState(null, '', '#/owner/verify'); toast('Owner account created. Next, verify your identity.'); } else toast('Owner mode unlocked');
      }} /><${Toasts} />`;
    return html`<${TopBar} user=${me} view=${view} go=${go} signOut=${() => signOut()} />
      ${view === 'driver' && html`<${Driver} user=${me} />`}
      ${view === 'owner' && html`<${Owner} user=${me} me=${me} reloadMe=${reloadMe} />`}
      ${view === 'admin' && html`<${Admin} />`}
      <${Toasts} />`;
  }

  render(html`<${App} />`, document.getElementById('app'));
})();
