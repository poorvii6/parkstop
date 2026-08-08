import { useEffect, useRef } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { ONLINE_EVENT } from '../utils/networkStatus';

/**
 * Re-run `refetch` whenever connectivity is restored (ONLINE_EVENT is fired by
 * the API client's reconnect probe). Drop this into any screen that loads server
 * data and it will refresh automatically after an offline stretch — no manual
 * pull-to-refresh, no stale data.
 *
 * Uses a ref so the latest callback is always invoked without re-subscribing on
 * every render.
 */
export function useOnlineRefresh(refetch: () => void): void {
  const ref = useRef(refetch);
  ref.current = refetch;

  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(ONLINE_EVENT, () => {
      try { ref.current?.(); } catch {}
    });
    return () => sub.remove();
  }, []);
}
