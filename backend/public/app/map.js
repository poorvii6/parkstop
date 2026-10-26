/* Map: real vector map (MapLibre + CARTO tiles) when the network allows it,
 * otherwise a drawn map of Bengaluru built from the same coordinates.
 * Exposes window.PSMap.MapView as a Preact component. */
(function () {
  const { h } = window.preact;
  const { useEffect, useRef, useState } = window.preactHooks;
  const html = window.htm.bind(h);

  // Map style comes from the ParkStop server (/maps/style): Ola Maps when the
  // server has a key, CARTO otherwise — the same source the mobile app uses.
  const CARTO = {
    dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    light: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  };
  const styleCache = {};
  async function styleFor(theme) {
    if (styleCache[theme]) return styleCache[theme];
    let out = { url: CARTO[theme], apiKey: null };
    try {
      const base = (window.PS_API_BASE || '/api/v1');
      const r = await fetch(`${base}/maps/style?theme=${theme}`);
      const j = await r.json();
      if (j && j.data && j.data.styleUrl) out = { url: j.data.styleUrl, apiKey: j.data.apiKey || null };
    } catch (e) {}
    styleCache[theme] = out;
    return out;
  }
  const withKey = (apiKey) => (url) => {
    if (apiKey && url.indexOf('olamaps.io') !== -1 && url.indexOf('api_key=') === -1) {
      return { url: url + (url.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + apiKey };
    }
    return { url };
  };

  // ---- drawn fallback map ----
  const B = { n: 13.085, s: 12.82, w: 77.53, e: 77.775 };
  const VW = 1000, VH = Math.round(1000 * ((B.n - B.s) / (B.e - B.w)));
  const px = (p) => [((p.lng - B.w) / (B.e - B.w)) * VW, ((B.n - p.lat) / (B.n - B.s)) * VH];
  const P = (lat, lng) => px({ lat, lng });
  const ORR = [[13.0358, 77.597], [13.043, 77.620], [13.022, 77.664], [13.006, 77.690], [12.956, 77.701], [12.928, 77.678], [12.917, 77.623], [12.913, 77.600], [12.925, 77.548], [12.965, 77.512 + 0.02], [13.03, 77.538], [13.0358, 77.597]];
  const ROADS = [
    [[12.9757, 77.6050], [12.9719, 77.6412], [12.9600, 77.6800], [12.9857, 77.7286]], // Old Airport Rd to Whitefield
    [[12.9757, 77.6050], [12.9350, 77.6150], [12.9000, 77.6350], [12.8452, 77.6602]], // Hosur Rd
    [[12.9757, 77.6050], [13.0000, 77.5900], [13.0358, 77.5970], [13.0800, 77.5960]], // Bellary Rd
    [[12.9757, 77.6050], [13.0031, 77.5700], [13.0300, 77.5400]], // Tumkur Rd side
    [[12.9757, 77.6050], [12.9250, 77.5838], [12.8800, 77.5700]], // Kanakapura side
    [[12.9719, 77.6412], [13.0100, 77.6400], [13.0359, 77.6430], [13.0800, 77.6500]], // Hennur Rd
  ];
  const LAKES = [[12.983, 77.622, 9, 7], [12.938, 77.666, 22, 10], [13.045, 77.590, 10, 8], [12.958, 77.590, 6, 5]];
  const path = (pts) => pts.map((p, i) => { const [x, y] = P(p[0], p[1]); return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1); }).join(' ');

  function Fallback({ spots, selectedId, user, focus, onSelect, areas }) {
    // Zoom to the focus point; the whole city when nothing is focused.
    const target = focus ? { c: px(focus), w: focus.zoom >= 15 ? 300 : 460 } : { c: [VW / 2, VH / 2], w: VW };
    const [vb, setVb] = useState(target);
    const raf = useRef(0);
    useEffect(() => {
      const from = vb, to = target, t0 = performance.now(), dur = 650;
      cancelAnimationFrame(raf.current);
      const step = (t) => {
        const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        setVb({ c: [from.c[0] + (to.c[0] - from.c[0]) * e, from.c[1] + (to.c[1] - from.c[1]) * e], w: from.w + (to.w - from.w) * e });
        if (k < 1) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
      return () => cancelAnimationFrame(raf.current);
    }, [focus && focus.lat, focus && focus.lng, focus && focus.zoom]);
    const hgt = vb.w * (VH / VW) * 0.9;
    const box = `${vb.c[0] - vb.w / 2} ${vb.c[1] - hgt / 2} ${vb.w} ${hgt}`;
    const s = vb.w / VW; // scale factor so labels stay readable when zoomed
    return html`<div class="fallback">
      <svg viewBox=${box} preserveAspectRatio="xMidYMid slice" role="img" aria-label="Map of Bengaluru with parking spots">
        <rect x="-500" y="-500" width=${VW + 1000} height=${VH + 1000} fill="var(--lane)" />
        ${Array.from({ length: 30 }, (_, i) => html`<line x1=${i * 40} y1="-200" x2=${i * 40} y2=${VH + 200} stroke="var(--line)" stroke-width=${0.6 * s} opacity="0.5" />`)}
        ${Array.from({ length: 34 }, (_, i) => html`<line x1="-200" y1=${i * 40} x2=${VW + 200} y2=${i * 40} stroke="var(--line)" stroke-width=${0.6 * s} opacity="0.5" />`)}
        ${LAKES.map(([la, ln, rx, ry]) => { const [x, y] = P(la, ln); return html`<ellipse cx=${x} cy=${y} rx=${rx} ry=${ry} fill="var(--sign)" opacity="0.18" />`; })}
        <path d=${path(ORR)} fill="none" stroke="var(--ink-3)" stroke-width=${4 * s} opacity="0.55" stroke-linejoin="round" />
        ${ROADS.map((r) => html`<path d=${path(r)} fill="none" stroke="var(--ink-3)" stroke-width=${2.4 * s} opacity="0.45" stroke-linejoin="round" />`)}
        ${areas.map((a) => { const [x, y] = px(a); return html`<text x=${x} y=${y + 26 * s} text-anchor="middle" font-size=${13 * s} font-weight="600" fill="var(--ink-3)" style="font-family:var(--body)">${a.name}</text>`; })}
        ${user && (() => { const [x, y] = px(user); return html`<g><circle cx=${x} cy=${y} r=${16 * s} fill="var(--sign)" opacity="0.2" /><circle cx=${x} cy=${y} r=${6.5 * s} fill="var(--sign)" stroke="#fff" stroke-width=${2.5 * s} /></g>`; })()}
        ${spots.map((sp) => {
          const [x, y] = px(sp); if (x < -50 || x > VW + 50 || y < -50 || y > VH + 50) return null; const on = sp.id === selectedId; const w = (sp.rate >= 100 ? 58 : 50) * s, hh = 22 * s;
          return html`<g style="cursor:pointer" onClick=${() => onSelect(sp.id)} opacity=${sp.free > 0 ? 1 : 0.55}>
            <line x1=${x} y1=${y} x2=${x} y2=${y - 8 * s} stroke=${on ? 'var(--signal)' : 'var(--ink-3)'} stroke-width=${2 * s} />
            <rect x=${x - w / 2} y=${y - 8 * s - hh} width=${w} height=${hh} rx=${7 * s} fill=${on ? 'var(--signal)' : 'var(--kerb)'} stroke=${on ? 'var(--signal)' : 'var(--line)'} stroke-width=${1.5 * s} />
            <rect x=${x - w / 2 + 5 * s} y=${y - 8 * s - hh + 4.5 * s} width=${13 * s} height=${13 * s} rx=${3 * s} fill=${on ? 'var(--signal-ink)' : 'var(--sign)'} />
            <text x=${x - w / 2 + 11.5 * s} y=${y - 8 * s - hh + 14.8 * s} text-anchor="middle" font-size=${10 * s} font-weight="800" fill=${on ? 'var(--signal)' : '#fff'}>P</text>
            <text x=${x - w / 2 + 22 * s} y=${y - 8 * s - hh + 15.5 * s} font-size=${12 * s} font-weight="700" fill=${on ? 'var(--signal-ink)' : 'var(--ink)'} style="font-family:var(--display)">₹${sp.rate}</text>
          </g>`;
        })}
      </svg>
    </div>`;
  }

  function themeNow() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }

  function MapView(props) {
    const { spots, selectedId, user, focus, onSelect, onPick, pick } = props;
    const pickMarker = useRef(null);
    const onPickRef = useRef(onPick); onPickRef.current = onPick;
    const el = useRef(null);
    const map = useRef(null);
    const markers = useRef({});
    const youMarker = useRef(null);
    const [mode, setMode] = useState(window.maplibregl ? 'loading' : 'svg');
    const [theme, setTheme] = useState(themeNow());

    useEffect(() => {
      const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
      const on = () => setTheme(themeNow());
      mq && mq.addEventListener && mq.addEventListener('change', on);
      const mo = new MutationObserver(on);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => { mq && mq.removeEventListener && mq.removeEventListener('change', on); mo.disconnect(); };
    }, []);

    // Create the real map; fall back to the drawn map if tiles cannot load.
    useEffect(() => {
      if (mode === 'svg' || !el.current || !window.maplibregl) return;
      let done = false, timer = null, cancelled = false;
      const giveUp = () => { if (done) return; done = true; try { map.current && map.current.remove(); } catch (e) {} map.current = null; markers.current = {}; youMarker.current = null; pickMarker.current = null; setMode('svg'); };
      styleFor(theme).then((st) => {
        if (cancelled || !el.current) return;
        let m;
        try {
          const c = focus || user || { lat: 12.9716, lng: 77.5946 };
          m = new window.maplibregl.Map({ container: el.current, style: st.url, transformRequest: withKey(st.apiKey), center: [c.lng, c.lat], zoom: focus && focus.zoom ? focus.zoom : 12.5, attributionControl: { compact: true }, fadeDuration: 0 });
        } catch (e) { giveUp(); return; }
        map.current = m;
        timer = setTimeout(giveUp, 12000);
        m.on('load', () => { if (done) return; done = true; clearTimeout(timer); setMode('gl'); });
        m.on('error', () => { if (!done) { clearTimeout(timer); giveUp(); } });
        m.on('click', (e) => { if (onPickRef.current) onPickRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng }); });
        m.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
      });
      return () => { cancelled = true; clearTimeout(timer); };
    }, [mode === 'svg']);

    // Theme change on the real map
    useEffect(() => {
      if (mode !== 'gl' || !map.current) return;
      styleFor(theme).then((st) => { try { map.current.setTransformRequest && map.current.setTransformRequest(withKey(st.apiKey)); map.current.setStyle(st.url); } catch (e) {} });
    }, [theme]);

    // Picked location (adding a spot)
    useEffect(() => {
      if (mode !== 'gl' || !map.current) return;
      if (!pick) { if (pickMarker.current) { pickMarker.current.remove(); pickMarker.current = null; } return; }
      if (!pickMarker.current) {
        const d = document.createElement('div');
        d.innerHTML = '<div class="pinm on"><div class="tag"><i>P</i>Here</div><div class="stem"></div></div>';
        pickMarker.current = new window.maplibregl.Marker({ element: d, anchor: 'bottom' }).setLngLat([pick.lng, pick.lat]).addTo(map.current);
      } else pickMarker.current.setLngLat([pick.lng, pick.lat]);
    }, [mode, pick && pick.lat, pick && pick.lng]);

    // Markers
    useEffect(() => {
      if (mode !== 'gl' || !map.current) return;
      const seen = {};
      spots.forEach((sp) => {
        seen[sp.id] = true;
        let mk = markers.current[sp.id];
        if (!mk) {
          const d = document.createElement('div');
          d.addEventListener('click', (e) => { e.stopPropagation(); onSelect(sp.id); });
          mk = new window.maplibregl.Marker({ element: d, anchor: 'bottom' }).setLngLat([sp.lng, sp.lat]).addTo(map.current);
          markers.current[sp.id] = mk;
        }
        const d = mk.getElement();
        // Our pin lives in a child so MapLibre keeps its own class and positioning on the outer element.
        d.innerHTML = `<div class="pinm${sp.id === selectedId ? ' on' : ''}${sp.free > 0 ? '' : ' full'}"><div class="tag"><i>P</i>₹${sp.rate}</div><div class="stem"></div></div>`;
        d.setAttribute('role', 'button');
        d.setAttribute('aria-label', `${sp.title}, ₹${sp.rate} an hour`);
        d.style.zIndex = sp.id === selectedId ? 5 : 1;
      });
      Object.keys(markers.current).forEach((k) => { if (!seen[k]) { markers.current[k].remove(); delete markers.current[k]; } });
      if (!user && youMarker.current) { youMarker.current.remove(); youMarker.current = null; }
      if (user) {
        if (!youMarker.current) {
          const y = document.createElement('div'); y.className = 'youdot'; y.title = 'You are here';
          youMarker.current = new window.maplibregl.Marker({ element: y }).setLngLat([user.lng, user.lat]).addTo(map.current);
        } else youMarker.current.setLngLat([user.lng, user.lat]);
      }
    }, [mode, spots, selectedId, user && user.lat, user && user.lng]);

    // Camera
    useEffect(() => {
      if (mode !== 'gl' || !map.current || !focus) return;
      map.current.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom || 13.2, speed: 1.4, essential: true });
    }, [mode, focus && focus.lat, focus && focus.lng, focus && focus.zoom]);

    return html`<div class="mapwrap">
      ${mode !== 'svg' && html`<div class="map" ref=${el}></div>`}
      ${mode === 'svg' && html`<${Fallback} ...${props} />`}
      ${mode === 'svg' && html`<div class="mapnote">Live map could not load · showing Bengaluru overview</div>`}
    </div>`;
  }

  window.PSMap = { MapView };
})();
