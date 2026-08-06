/**
 * OfflineBanner.tsx — app-wide connectivity banner.
 *
 * Mounted once in the root layout. Shows the shared Toast when the API client
 * decides we genuinely can't reach the server (OFFLINE_EVENT), and hides it as
 * soon as a request succeeds again (ONLINE_EVENT). The decision logic (grace
 * window, throttling) lives in utils/networkStatus so this stays dumb.
 */
import React, { useEffect, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { OFFLINE_EVENT, ONLINE_EVENT } from '../utils/networkStatus';
import Toast from './Toast';

export default function OfflineBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const offSub = DeviceEventEmitter.addListener(OFFLINE_EVENT, (msg: string) => {
      setMessage(msg);
    });
    const onSub = DeviceEventEmitter.addListener(ONLINE_EVENT, () => {
      setMessage(null); // connection restored — hide immediately
    });
    return () => {
      offSub.remove();
      onSub.remove();
    };
  }, []);

  return (
    <Toast
      message={message}
      kind="error"
      duration={4000}
      onHide={() => setMessage(null)}
    />
  );
}
