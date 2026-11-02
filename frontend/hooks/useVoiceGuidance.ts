/**
 * useVoiceGuidance — spoken turn-by-turn directions, like Google Maps.
 *
 * For every turn it speaks up to three times:
 *   early   "In 400 metres, turn left onto Solur Road"   (skipped on short steps)
 *   near    "In 100 metres, turn left onto Solur Road"
 *   now     "Turn left onto Solur Road"
 * plus "Starting route…" at the start, "Route updated" after a re-route, and
 * "You have arrived…" at the end. Early/near distances stretch with speed so a
 * fast driver hears the turn in time.
 *
 * Needs the expo-speech native module. If the installed app was built before
 * it was added, voice is simply unavailable (voiceAvailable = false).
 */
import { useEffect, useRef } from 'react';
import type { NavPhase, NavProgress } from './useInAppNavigation';
import type { NavRoute } from '../utils/directions';

let Speech: {
  speak: (text: string, opts?: any) => void;
  stop: () => Promise<void> | void;
} | null = null;
try { Speech = require('expo-speech'); } catch { Speech = null; }

export const voiceAvailable = !!Speech;

const VOICE = { language: 'en-IN', rate: 1.0, pitch: 1.0 };

function say(text: string, interrupt = false) {
  if (!Speech) return;
  try {
    if (interrupt) Speech.stop();
    Speech.speak(text, VOICE);
  } catch { /* speech engine unavailable — stay silent */ }
}

function stopSpeaking() {
  try { Speech?.stop(); } catch {}
}

/** 437 -> "450 metres", 82 -> "80 metres", 1530 -> "1.5 kilometres" */
export function spokenDistance(m: number): string {
  if (m >= 950) {
    const km = Math.round(m / 100) / 10;
    return `${km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)} kilometre${km === 1 ? '' : 's'}`;
  }
  const n = m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10);
  return `${n} metres`;
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

export function useVoiceGuidance({
  enabled,
  phase,
  route,
  routeVersion,
  progress,
  speedKmh,
  destinationTitle,
  isBookedSpot,
}: {
  enabled: boolean;
  phase: NavPhase;
  route: NavRoute | null;
  routeVersion: number;
  progress: NavProgress | null;
  speedKmh: number | null;
  destinationTitle?: string;
  isBookedSpot: boolean;
}) {
  // Which prompts have been spoken for which step, per route version.
  const spoken = useRef<Set<string>>(new Set());
  const lastVersion = useRef(0);
  const startedVersion = useRef(0);
  const arrivedSaid = useRef(false);

  // New navigation session or re-route.
  useEffect(() => {
    if (routeVersion === lastVersion.current) return;
    const isReroute = startedVersion.current !== 0 && phase === 'navigating';
    lastVersion.current = routeVersion;
    spoken.current = new Set();
    if (!route || phase !== 'navigating') return;
    if (isReroute) {
      if (enabled) say('Route updated.', true);
      return;
    }
    startedVersion.current = routeVersion;
    arrivedSaid.current = false;
    if (!enabled) return;
    const first = route.steps[0];
    const where = destinationTitle ? ` to ${destinationTitle}` : '';
    say(`Starting route${where}.${first ? ' ' + first.instruction + '.' : ''}`, true);
  }, [routeVersion, route, phase, enabled, destinationTitle]);

  // Turn prompts as the driver approaches each maneuver.
  useEffect(() => {
    if (!enabled || phase !== 'navigating' || !progress) return;
    const v = routeVersion;
    const kmh = speedKmh ?? 0;
    const nearM = kmh > 50 ? 300 : kmh > 30 ? 200 : 120;
    const earlyM = kmh > 50 ? 1000 : 500;
    const d = progress.distanceToNextM;

    if (progress.nextStep) {
      const key = `${v}:${progress.nextIndex}`;
      const text = progress.nextStep.instruction;
      const thenText = progress.thenStep ? `, then ${lowerFirst(progress.thenStep.instruction)}` : '';
      if (d <= 35) {
        if (!spoken.current.has(`${key}:now`)) {
          spoken.current.add(`${key}:now`).add(`${key}:near`).add(`${key}:early`);
          const note = progress.nextStep.note ? ` ${progress.nextStep.note}.` : '';
          say(`${text}${thenText}.${note}`, true);
        }
      } else if (d <= nearM) {
        if (!spoken.current.has(`${key}:near`)) {
          spoken.current.add(`${key}:near`).add(`${key}:early`);
          say(`In ${spokenDistance(d)}, ${lowerFirst(text)}${thenText}.`);
        }
      } else if (d <= earlyM && d > nearM + 150) {
        if (!spoken.current.has(`${key}:early`)) {
          spoken.current.add(`${key}:early`);
          say(`In ${spokenDistance(d)}, ${lowerFirst(text)}.`);
        }
      }
      return;
    }

    // No turns left: only the destination ahead.
    const key = `${v}:dest`;
    if (d <= nearM && d > 40 && !spoken.current.has(key)) {
      spoken.current.add(key);
      say(`In ${spokenDistance(d)}, your destination is ahead.`);
    }
  }, [enabled, phase, progress, speedKmh, routeVersion]);

  // Arrival.
  useEffect(() => {
    if (phase !== 'arrived' || arrivedSaid.current) return;
    arrivedSaid.current = true;
    if (!enabled) return;
    const where = destinationTitle ? ` at ${destinationTitle}` : '';
    say(`You have arrived${where}.${isBookedSpot ? ' Show your check-in PIN to the owner.' : ''}`, true);
  }, [phase, enabled, destinationTitle, isBookedSpot]);

  // Navigation ended: reset, and cut off anything mid-sentence.
  useEffect(() => {
    if (phase === 'idle') {
      startedVersion.current = 0;
      arrivedSaid.current = false;
      stopSpeaking();
    }
  }, [phase]);

  // Muted mid-sentence.
  useEffect(() => {
    if (!enabled) stopSpeaking();
  }, [enabled]);
}
