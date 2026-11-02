/**
 * useNavBackground — navigation that keeps going when ParkStop is not on screen.
 *
 *   mini-map       while a route is active, pressing Home shrinks ParkStop into
 *                  a floating picture-in-picture window (Android). `inPip` tells
 *                  the screen to switch to its compact layout.
 *   notification   a "ParkStop is navigating" notification keeps GPS and voice
 *                  running when the app is minimised or the screen is locked,
 *                  and shows the next turn. Tapping it opens ParkStop.
 *
 * Both are no-ops until the app is rebuilt with modules/parkstop-nav.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, Dimensions, Platform } from 'react-native';
import ParkstopNav from '../modules/parkstop-nav';
import { formatDistance, formatDuration } from '../components/finder/NavigationOverlay';
import type { NavPhase, NavProgress } from './useInAppNavigation';

export function useNavBackground({
  active,
  phase,
  progress,
  rerouting,
  destinationTitle,
}: {
  active: boolean;
  phase: NavPhase;
  progress: NavProgress | null;
  rerouting: boolean;
  destinationTitle?: string;
}) {
  const [inPip, setInPip] = useState(false);
  const titleRef = useRef(destinationTitle);
  titleRef.current = destinationTitle;

  // Start/stop the mini-map permission and the navigation notification.
  useEffect(() => {
    if (!active) return;
    ParkstopNav.setNavigationActive(true);
    const dest = titleRef.current;
    ParkstopNav.startNotification('ParkStop navigation', dest ? `To ${dest}` : 'Starting route…');
    return () => {
      ParkstopNav.setNavigationActive(false);
      ParkstopNav.stopNotification();
    };
  }, [active]);

  // Keep the notification showing the next turn.
  const last = useRef({ title: '', text: '', at: 0 });
  useEffect(() => {
    if (!active) return;
    let title: string;
    let text: string;
    const dest = destinationTitle;
    if (phase === 'arrived') {
      title = 'You have arrived';
      text = dest || 'Your destination';
    } else if (rerouting) {
      title = 'Finding a new route…';
      text = dest ? `To ${dest}` : '';
    } else if (progress) {
      const what = progress.nextStep ? progress.nextStep.instruction : `Arrive at ${dest || 'your destination'}`;
      title = `${formatDistance(progress.distanceToNextM)} · ${what}`;
      text = `${formatDuration(progress.remainingS)} · ${formatDistance(progress.remainingM)} left${dest ? ` · to ${dest}` : ''}`;
    } else {
      return;
    }
    const prev = last.current;
    if (title === prev.title && text === prev.text) return;
    // Only the distance to the same turn changed: refresh at most every 2 s
    // (saves battery). Anything else — a new turn, re-routing, arrival — goes
    // out immediately.
    const turnPart = (t: string) => (t.includes(' · ') ? t.slice(t.indexOf(' · ') + 3) : null);
    const sameTurn = turnPart(title) !== null && turnPart(title) === turnPart(prev.title);
    if (sameTurn && Date.now() - prev.at < 2000) return;
    last.current = { title, text, at: Date.now() };
    ParkstopNav.updateNotification(title, text);
  }, [active, phase, progress, rerouting, destinationTitle]);

  // Track whether we are currently the floating mini-map.
  useEffect(() => {
    if (!active || Platform.OS !== 'android' || !ParkstopNav.available) {
      setInPip(false);
      return;
    }
    const check = () => setInPip(ParkstopNav.isInPictureInPicture());
    const appSub = AppState.addEventListener('change', check);
    const dimSub = Dimensions.addEventListener('change', check);
    const iv = setInterval(check, 1000);
    check();
    return () => {
      appSub.remove();
      dimSub.remove();
      clearInterval(iv);
      setInPip(false);
    };
  }, [active]);

  return { inPip };
}
