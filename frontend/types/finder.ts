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
  | 'booking_confirm'
  | 'navigating'
  | 'en_route'
  | 'arriving'
  | 'active_parking'
  | 'checkout_verification'
  | 'payment'
  | 'receipt';
