/**
 * roles.js — what a user is ALLOWED to do, independent of which screen
 * (driver or owner) they currently have open.
 *
 * Before: one `users.role` column held the "current mode". Opening the driver
 * screen flipped it to FINDER, so an owner's next spot request got
 * "Access denied. Allowed: SPOTTER, ADMIN". Capabilities now come from the
 * registration flags, so one account can be both a driver and an owner.
 */
function hasRole(user, role) {
  if (!user) return false;
  const want = String(role || '').toUpperCase();
  const current = String(user.role || '').toUpperCase();
  if (want === 'ADMIN') return current === 'ADMIN';
  if (want === 'SPOTTER') return current === 'SPOTTER' || user.is_spotter_registered === true;
  if (want === 'FINDER') return current === 'FINDER' || user.is_finder_registered !== false;
  return current === want;
}

function hasAnyRole(user, roles) {
  return roles.some((r) => hasRole(user, r));
}

module.exports = { hasRole, hasAnyRole };
