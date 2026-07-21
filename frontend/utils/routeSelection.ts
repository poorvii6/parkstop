/**
 * Route selection — decides which of the provider's candidate routes to draw.
 *
 * Why this exists as its own module: the finder previously picked a route in
 * three different places with three different rules (two of them just took
 * `routes[0]` blindly), so the route you saw depended on which code path
 * happened to run. This is now the single rule.
 *
 * WHAT "BEST" MEANS HERE
 * ----------------------
 * Routing providers optimise for TIME. That is why a 12km motorway loop can be
 * returned in preference to a 6km direct road: it is 90 seconds quicker, but to
 * a driver it just looks like the app is sending them the long way round.
 *
 * So instead of taking the fastest outright, we take the SHORTEST route among
 * those that are not meaningfully slower than the fastest. A small time penalty
 * is worth a large distance saving; a large time penalty is not.
 */

export type RouteLike = {
  distance: number; // metres
  duration: number; // seconds
  [k: string]: any;
};

/**
 * How much slower than the fastest route a candidate may be before we stop
 * considering it. 20% of a 20-minute drive is 4 minutes — noticeable but
 * acceptable if it saves real distance.
 */
export const SLOWER_TOLERANCE = 1.2;

/**
 * A candidate must also save a worthwhile amount of distance to justify being
 * chosen over the fastest option. Below this, prefer the fastest — swapping
 * routes to save 50 metres is churn, not an improvement.
 */
export const MIN_DISTANCE_SAVING_M = 300;

const isUsable = (r: any): r is RouteLike =>
  !!r &&
  Number.isFinite(r.distance) &&
  Number.isFinite(r.duration) &&
  r.distance >= 0 &&
  r.duration >= 0 &&
  Array.isArray(r.geometry?.coordinates) &&
  r.geometry.coordinates.length >= 2;

/**
 * Pick the route to display.
 *
 * @returns the chosen route, or null when nothing usable was returned.
 */
export function pickBestRoute<T extends RouteLike>(routes: T[] | null | undefined): T | null {
  if (!Array.isArray(routes)) return null;

  const usable = routes.filter(isUsable) as T[];
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  // Fastest route: the provider's own objective, and our reference point.
  const fastest = usable.reduce((a, b) => (b.duration < a.duration ? b : a));

  // Candidates that are not meaningfully slower than the fastest.
  const acceptable = usable.filter((r) => r.duration <= fastest.duration * SLOWER_TOLERANCE);

  // Of those, the shortest on the ground.
  const shortest = acceptable.reduce((a, b) => (b.distance < a.distance ? b : a));

  // Only switch away from the fastest if the distance saving is worth having.
  if (fastest.distance - shortest.distance >= MIN_DISTANCE_SAVING_M) return shortest;
  return fastest;
}

/**
 * The routes to draw as muted, tappable alternatives.
 *
 * Must be derived by EXCLUDING the chosen route by identity — not by
 * `routes.slice(1)`. That old approach assumed the chosen route was always
 * `routes[0]`, so as soon as selection picked anything else the primary was
 * ALSO drawn underneath as a grey alternative, while the provider's first route
 * silently vanished from the list.
 */
export function otherRoutes<T extends RouteLike>(
  routes: T[] | null | undefined,
  chosen: T | null
): T[] {
  if (!Array.isArray(routes) || !chosen) return [];
  return routes.filter((r) => r !== chosen && isUsable(r));
}
