// Shared type definitions for the Finder experience.
// Extracted from app/finder/index.tsx as the first step of breaking that file up.

export type Spot = {
  id: string;
  title: string;
  lat: number;
  lng: number;
  price: number;
  available: boolean;
  location_type?: string;
  available_slots?: number;
  /**
   * KNOWN BUG, logged 6 Nov 2026, deliberately not fixed yet: declared
   * `number`, but a string at runtime. Both nearby-fetch sites in
   * `app/finder/index.tsx` build it with
   * `sp.distance ? parseFloat(sp.distance).toFixed(1) : undefined`, and
   * `.toFixed()` returns a string. tsc does not catch it because those map
   * callbacks are typed `(sp: any)`, so the built object is never checked
   * against Spot.
   *
   * Fixing it is a decision, not a typo: either keep the 1-decimal rounding
   * and type this `string`, or store the raw number and round at the render
   * site. Check every reader of `distance` before changing it — arithmetic on
   * what is currently a string would start silently coercing.
   */
  distance?: number;
  images?: string[];
};

export type PricingBreakdown = {
  id?: string;
  time: number;
  location: number;
  demand: number;
  finalPrice: number;
  multiplier: number;
};

export type AppStep =
  | 'vehicle_select'
  | 'home'
  | 'spot_booking'
  | 'booking_confirm' // booked: PIN + Google Maps, waiting for check-in
  | 'active_parking'
  | 'checkout_verification'
  | 'awaiting_owner'
  | 'payment'
  | 'receipt';
