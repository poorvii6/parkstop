/**
 * realtime.ts — authenticated Socket.IO connection.
 *
 * The backend authenticates sockets with the SAME Firebase ID token used by the
 * REST API. Connecting without it is silently rejected, which is why realtime
 * events (new bookings, payout status) never arrived before.
 */
import { io, Socket } from 'socket.io-client';
// Use the SHARED, already-initialized auth instance (configured with
// AsyncStorage persistence). Calling getAuth() here would create a second,
// unconfigured instance and can throw during module load.
import { auth } from './firebase';
import apiClient from '../api/client';

let socket: Socket | null = null;

const socketUrl = () => (apiClient.defaults.baseURL || '').replace('/api/v1', '');

/**
 * Returns a connected, authenticated socket (shared across screens).
 * Safe to call repeatedly — the same instance is reused.
 */
export async function getSocket(): Promise<Socket | null> {
  try {
    const user = auth?.currentUser;
    if (!user) return null;

    if (socket?.connected) return socket;
    if (socket) {
      socket.connect();
      return socket;
    }

    socket = io(socketUrl(), {
      transports: ['websocket'],
      // Called on every connect AND reconnect, so a reconnect after the
      // one-hour token lifetime still sends a valid token.
      auth: (cb: (data: object) => void) => {
        const current = auth?.currentUser;
        if (!current) return cb({});
        current.getIdToken().then((token: string) => cb({ token })).catch(() => cb({}));
      },
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    socket.on('connect_error', (err) => {
      console.log('[Realtime] connect_error:', err.message);
    });

    return socket;
  } catch (e) {
    console.log('[Realtime] setup failed:', (e as any)?.message);
    return null;
  }
}

/**
 * Subscribe to an event; returns an unsubscribe function.
 * Handles the async connection internally so callers stay simple.
 */
export function onRealtime(event: string, handler: (payload: any) => void) {
  let active = true;
  let bound: Socket | null = null;

  getSocket().then((s) => {
    if (!s || !active) return;
    bound = s;
    s.on(event, handler);
  });

  return () => {
    active = false;
    bound?.off(event, handler);
  };
}

export function disconnectRealtime() {
  socket?.disconnect();
  socket = null;
}
