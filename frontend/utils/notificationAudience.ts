export type Audience = 'finder' | 'spotter' | undefined;

// Notification types that are relevant to ONLY one side of the marketplace.
const FINDER_ONLY = new Set(['booking_confirmed']);
const SPOTTER_ONLY = new Set(['new_booking', 'finder_nearby', 'booking_cancelled']);

/**
 * Whether a notification of `type` should appear in the given interface.
 * A dual-role user (both finder and spotter) shares one notification history,
 * so the inbox/bell must hide the other side's notifications based on which
 * interface opened it. Unknown/untyped notifications show everywhere.
 */
export function belongsToAudience(type: string | null | undefined, audience: Audience): boolean {
  if (!audience) return true;   // no context → show everything
  if (!type) return true;       // unknown type → show everywhere
  if (audience === 'finder') return !SPOTTER_ONLY.has(type);
  return !FINDER_ONLY.has(type); // spotter
}
