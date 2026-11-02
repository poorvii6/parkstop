/**
 * useSpeedLimit — the speed limit of the road the driver is on, from Ola Maps
 * (through ParkStop's server, so the Ola key never sits in the app).
 *
 * Asks again every 150 m driven or every 30 s, whichever comes first, sending
 * the last few positions so Ola can tell which road (and direction) it is.
 * Returns null when the limit is unknown — the screen then hides the sign.
 */
import { useEffect, useRef, useState } from 'react';
import apiClient from '../api/client';

type Pt = { lat: number; lng: number };

const QUERY_EVERY_M = 150;
const QUERY_EVERY_MS = 30000;
const TRAIL_POINTS = 6;
const TRAIL_SPACING_M = 15;

function metres(a: Pt, b: Pt) {
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const dx = (b.lng - a.lng) * 111320 * cosLat;
  const dy = (b.lat - a.lat) * 110540;
  return Math.sqrt(dx * dx + dy * dy);
}

export function useSpeedLimit({ active, location }: { active: boolean; location: Pt | null }) {
  const [limit, setLimit] = useState<number | null>(null);
  const trail = useRef<Pt[]>([]);
  const lastQuery = useRef<{ at: number; pos: Pt } | null>(null);
  const inFlight = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  // Reset when navigation ends.
  useEffect(() => {
    if (active) return;
    setLimit(null);
    trail.current = [];
    lastQuery.current = null;
  }, [active]);

  useEffect(() => {
    if (!active || !location) return;
    const t = trail.current;
    const prev = t[t.length - 1];
    if (!prev || metres(prev, location) >= TRAIL_SPACING_M) {
      t.push(location);
      if (t.length > TRAIL_POINTS) t.shift();
    }

    const lq = lastQuery.current;
    const due = !lq || metres(lq.pos, location) >= QUERY_EVERY_M || Date.now() - lq.at >= QUERY_EVERY_MS;
    if (!due || inFlight.current) return;

    inFlight.current = true;
    lastQuery.current = { at: Date.now(), pos: location };
    const path = t.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
    apiClient
      .get(`/maps/speed-limit?path=${encodeURIComponent(path)}`)
      .then((res: any) => {
        if (!activeRef.current) return;
        const v = res?.data?.data?.speedLimit;
        setLimit(typeof v === 'number' && v > 0 ? v : null);
      })
      .catch(() => { /* non-critical: keep the last known limit */ })
      .finally(() => { inFlight.current = false; });
  }, [active, location]);

  return limit;
}
