import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, Text, StyleSheet, Platform, TouchableOpacity, TextInput, Dimensions, Modal, Alert, ScrollView, Linking, Keyboard, ActivityIndicator, BackHandler, AppState, Image, Animated, KeyboardAvoidingView, DeviceEventEmitter } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import MapLibreView from '../../components/MapLibreView';
import GoogleNavigation from '../../components/GoogleNavigation';
import { useNavigation as useGoogleNav, TravelMode } from '@googlemaps/react-native-navigation-sdk';
import { prepareDestination, clearPreparedDestination } from '../../utils/navSession';
import { useStripe } from '../../components/StripeImports';
import RazorpayCheckout from '../../components/RazorpayCheckout';
import razorpayService from '../../services/razorpayService';
import { registerForPushNotificationsAsync, getCurrentPushToken } from '../../services/notifications';
import { onRealtime } from '../../services/realtime';
import { setCashfreeCallbacks, removeCashfreeCallbacks, payBookingWithCashfree, verifyCashfreePayment } from '../../services/cashfree';

import { io, Socket } from 'socket.io-client';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import WheelTimePicker from '../../components/WheelTimePicker';
import { Ionicons } from '@expo/vector-icons';
import { isNetworkError, ONLINE_EVENT } from '../../utils/networkStatus';
import { useOnlineRefresh } from '../../hooks/useOnlineRefresh';
import NotificationBell from '../../components/NotificationBell';
import { getDistanceKm } from '../../utils/geo';
import { BlueprintTheme, BlueprintColors } from '../../constants/BlueprintTheme';
import apiClient from '../../api/client';
import { startBackgroundLocation, stopBackgroundLocation, onBackgroundLocation } from '../../services/backgroundLocation';
import { saveLastLocation, loadLastLocation } from '../../services/lastLocation';
import { pickBestRoute, otherRoutes } from '../../utils/routeSelection';
import { Spot, PricingBreakdown, AppStep } from '../../types/finder';
import SkeletonCard from '../../components/SkeletonCard';

const { width } = Dimensions.get('window');

// Safe import — expo-pip only works on Android native builds
let ExpoPip: any = { useIsInPip: () => ({ isInPipMode: false }), isAvailable: () => false, enterPipMode: () => { } };
try { ExpoPip = require('expo-pip').default || require('expo-pip'); } catch (e) { /* Web/iOS fallback */ }

// Use the base URL from apiClient but strip the /api/v1 suffix for socket
const getSocketUrl = () => {
  const baseUrl = apiClient.defaults.baseURL || '';
  return baseUrl.replace('/api/v1', '');
};

const SOCKET_URL = getSocketUrl();

/**
 * Turn a routing step into a human action + icon.
 *
 * Module scope so BOTH the live navigation watcher and the reroute handler
 * can use it — the reroute needs it to show the first turn of the new route
 * immediately instead of leaving a "Calculating..." placeholder on screen.
 */
const parseManeuver = (s: any) => {
  if (!s?.maneuver) return { action: 'Head straight', icon: '⬆️' };
  const type = s.maneuver.type;
  const modifier = s.maneuver.modifier || '';
  const sName = s.name || '';
  let action = 'Head straight';
  let icon = '⬆️';
  if (type === 'turn' || type === 'end of road' || type === 'fork') {
    if (modifier.includes('sharp right')) { action = 'Sharp right'; icon = '↪️'; }
    else if (modifier.includes('slight right')) { action = 'Bear right'; icon = '↗️'; }
    else if (modifier.includes('right')) { action = 'Turn right'; icon = '➡️'; }
    else if (modifier.includes('sharp left')) { action = 'Sharp left'; icon = '↩️'; }
    else if (modifier.includes('slight left')) { action = 'Bear left'; icon = '↖️'; }
    else if (modifier.includes('left')) { action = 'Turn left'; icon = '⬅️'; }
    else if (modifier.includes('uturn')) { action = 'Make a U-turn'; icon = '↩️'; }
    else { action = 'Continue'; icon = '⬆️'; }
  } else if (type === 'roundabout' || type === 'rotary') {
    action = 'Enter roundabout'; icon = '🔄';
  } else if (type === 'merge') {
    if (modifier.includes('left')) { action = 'Merge left'; icon = '↖️'; }
    else if (modifier.includes('right')) { action = 'Merge right'; icon = '↗️'; }
    else { action = 'Merge'; icon = '↗️'; }
  } else if (type === 'depart') {
    action = 'Head ' + (modifier || 'straight'); icon = '⬆️';
  } else if (type === 'arrive') {
    action = 'Arriving at destination'; icon = '📍';
  } else if (type === 'new name' || type === 'continue') {
    action = sName ? `Continue on ${sName}` : 'Continue straight';
    icon = '⬆️';
  }
  return { action, icon };
};

export default function FinderDashboard() {
  const router = useRouter();
  const mapRef = useRef<any>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number, lng: number } | null>(null);
  // Viewport hint only — where the user was last session. Never used as the
  // user's actual position (see services/lastLocation.ts).
  const [viewportHint, setViewportHint] = useState<{ lat: number, lng: number } | null>(null);
  // Distinct from "permission denied": the app can hold permission while the
  // DEVICE's location toggle is off. That combination showed no banner at all,
  // leaving the user on a blank country-wide map with no way to recover.
  const [locationServicesOff, setLocationServicesOff] = useState(false);
  // True when the last nearby-spots fetch failed. Lets the UI say "couldn't
  // refresh" instead of silently implying there are no spots.
  const [nearbyFetchFailed, setNearbyFetchFailed] = useState(false);
  // Latest GPS uncertainty in metres. Passed to the map so off-route detection
  // can widen its threshold when the fix is poor instead of rerouting falsely.
  const [locationAccuracy, setLocationAccuracy] = useState<number>(0);
  const [step, setStep] = useState<AppStep>('home');
  const [navCountdown, setNavCountdown] = useState<number | null>(null);
  const [showUPIInline, setShowUPIInline] = useState(false);
  const [vehicleType, setVehicleType] = useState<string>('');
  const [vehicleSubType, setVehicleSubType] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<string>('');
  const [parkingHours, setParkingHours] = useState<number>(1);
  const [parkingMinutes, setParkingMinutes] = useState<number>(0);
  const [isLongParking, setIsLongParking] = useState(false);

  /* ── Booking window ──────────────────────────────────────────────────────
   * The rider picks when they arrive and when they leave. parkingHours and
   * parkingMinutes are DERIVED from that pair rather than chosen directly —
   * everything downstream (pricing, the active-session card, the booking
   * request) already reads them, so keeping them in sync means none of that
   * had to change. */
  const [bookingStart, setBookingStart] = useState<Date>(() => new Date());
  const [bookingEnd, setBookingEnd] = useState<Date>(() => new Date(Date.now() + 3600000));
  const [timePickerFor, setTimePickerFor] = useState<'start' | 'end' | null>(null);
  const [longStayDays, setLongStayDays] = useState<number>(0);

  /* ── Times are IST, whatever the phone says ───────────────────────────────
   *
   * ParkStop operates in one country and one timezone. A device set to the
   * wrong zone — or simply left on the timezone of somewhere the owner
   * travelled — would otherwise book a bay for the right clock time in the
   * wrong hour, and the rider would have no way of noticing: every screen
   * would agree with itself and disagree with the spot owner standing there.
   *
   * India has no daylight saving, so the offset is the fixed +5:30 and no
   * lookup table is needed.
   *
   * toIstWall returns a Date whose LOCAL getters read IST values, for display
   * and for hour/minute arithmetic. fromIstWall converts such a Date back to
   * the real instant to store or send. On a phone already set to IST both are
   * no-ops, so this costs nothing in the normal case. */
  const IST_OFFSET_MIN = 330;
  const toIstWall = (d: Date) =>
    new Date(d.getTime() + (IST_OFFSET_MIN + d.getTimezoneOffset()) * 60000);
  const fromIstWall = (d: Date) =>
    new Date(d.getTime() - (IST_OFFSET_MIN + d.getTimezoneOffset()) * 60000);

  /** Minutes between the chosen arrival and departure, floored at zero. */
  const windowMinutes = Math.max(
    0,
    Math.round((bookingEnd.getTime() - bookingStart.getTime()) / 60000)
  );

  /**
   * Why the chosen window is unusable, or '' when it is fine.
   *
   * Shown in place of the duration rather than as an alert, so the rider sees
   * the problem while they are still looking at the two times that caused it.
   */
  const bookingWindowError =
    windowMinutes <= 0
      ? 'Leaving must be after arriving'
      : windowMinutes < 15
      ? 'Minimum stay is 15 minutes'
      : '';

  /**
   * The advance-booking fee, mirroring the server's BookingRefundPolicy.
   *
   * Duplicated here ONLY to show the rider what they will be charged before
   * they commit; the server recomputes it and its answer is the one that
   * counts. Change the threshold or the amount in one place and you must
   * change the other.
   */
  const advanceFee =
    !isLongParking && bookingStart.getTime() - Date.now() >= 2 * 3600000 ? 50 : 0;

  /** "2:30 pm" in IST — matches how the rest of the app writes times. */
  const fmtClock = (d: Date) => {
    const w = toIstWall(d);
    const mm = w.getMinutes().toString().padStart(2, '0');
    const ampm = w.getHours() >= 12 ? 'pm' : 'am';
    return `${w.getHours() % 12 || 12}:${mm} ${ampm}`;
  };

  /**
   * "Today" / "Tomorrow" / "24 Aug", judged in IST so a late-evening booking
   * does not read as tomorrow just because the device thinks it is already
   * past midnight somewhere else.
   */
  const fmtDayLabel = (d: Date) => {
    const w = toIstWall(d);
    const midnight = toIstWall(new Date());
    midnight.setHours(0, 0, 0, 0);
    const days = Math.floor((w.getTime() - midnight.getTime()) / 86400000);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    return w.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };

  /**
   * Apply a picked arrival time.
   *
   * The picker returns hours and minutes with today's date attached. If that
   * lands in the past the rider meant tomorrow — nobody picks 9am at 10am
   * intending yesterday. The departure is carried along by the same shift so
   * the length of stay they had already chosen survives.
   */
  const applyStartTime = (picked: Date) => {
    // Resolve against IST *now*, NOT against whatever was chosen last time.
    //
    // Building on the previous value meant the date was sticky: pick a morning
    // time while it is afternoon and it correctly rolled to tomorrow — but then
    // picking an evening time kept tomorrow's date, because the roll only ever
    // went forwards and the base had already moved. There was no way back to
    // today short of restarting the booking. A chosen clock time now always
    // means the next time that clock reads it.
    const nowWall = toIstWall(new Date());
    const wall = new Date(nowWall);
    wall.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    if (wall.getTime() < nowWall.getTime() - 60000) wall.setDate(wall.getDate() + 1);

    const startInstant = fromIstWall(wall);
    const heldMinutes = Math.max(15, windowMinutes);
    setBookingStart(startInstant);
    setBookingEnd(new Date(startInstant.getTime() + heldMinutes * 60000));
  };

  /**
   * Apply a picked departure time. Rolls to the next day when it would land
   * before the arrival, which is how an overnight stay gets expressed with a
   * time-only picker.
   */
  const applyEndTime = (picked: Date) => {
    const startWall = toIstWall(bookingStart);
    const wall = new Date(startWall);
    wall.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
    if (wall.getTime() <= startWall.getTime()) wall.setDate(wall.getDate() + 1);
    setBookingEnd(fromIstWall(wall));
  };

  /** Long stay: keep the arrival, push departure out by whole days. */
  const applyLongStayDays = (days: number) => {
    setLongStayDays(days);
    if (days > 0) setBookingEnd(new Date(bookingStart.getTime() + days * 86400000));
  };

  const [calculatedPrice, setCalculatedPrice] = useState<number | null>(null);
  const [isCalculatingPrice, setIsCalculatingPrice] = useState(false);
  const [slotData, setSlotData] = useState<Array<{ name: string; status: string }>>([]);
  const [arrivalDetected, setArrivalDetected] = useState(false);
  const [simulatedLocation, setSimulatedLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number, longitude: number }[]>([]);
  const [altRoutes, setAltRoutes] = useState<Array<{ coords: Array<{ latitude: number; longitude: number }>; duration: number; distance: number; steps?: any[] }>>([]);

  // Set when the rider taps an alternative route. While it holds, background
  // refreshes must not replace their choice with the algorithm's preference.
  // Cleared whenever we legitimately pick a new route: new destination, or a
  // reroute after going off-route.
  const userSelectedRoute = useRef(false);
  const [currentRouteIndex, setCurrentRouteIndex] = useState(0);
  const [distanceInfo, setDistanceInfo] = useState({ km: '0', mins: '0' });
  const [currentInstruction, setCurrentInstruction] = useState({ turn: '', street: '', icon: '' });
  const [nextTurnPreview, setNextTurnPreview] = useState({ turn: '', icon: '' });
  const [trafficSegments, setTrafficSegments] = useState<Array<{ coords: Array<[number, number]>; congestion: 'low' | 'moderate' | 'heavy' | 'severe' }>>([]);
  const [speedLimit, setSpeedLimit] = useState<number | null>(null);
  const [laneGuidance, setLaneGuidance] = useState<Array<{ indications: string[]; valid: boolean }>>([]);
  const lastSpeedLimitFetch = useRef(0);
  const [mapStyleConfig, setMapStyleConfig] = useState<{ styleUrl?: string; apiKey?: string; provider?: string }>({});
  const [navLanguage, setNavLanguage] = useState<string>('en-IN');
  const lastSnapFetch = useRef(0);
  const lastLandmarkFetch = useRef(0);
  const landmarkCache = useRef<Map<string, string>>(new Map());
  const lastHapticTurn = useRef('');
  const routeStepsRef = useRef<any[]>([]);
  const ignoreNextQueryChange = useRef(false);
  /**
   * True from the moment a search is SUBMITTED until the user types again.
   *
   * `ignoreNextQueryChange` cannot cover this case. It is only consulted when
   * the autocomplete effect RE-RUNS, and submitting does not change
   * searchQuery — so the effect never re-runs, its already-scheduled debounce
   * timer is never cancelled, and that timer lands a second later and refills
   * the dropdown over the map. That is why the list stayed up after pressing
   * search: the results arriving were requested before the search, not after.
   */
  const searchSubmitted = useRef(false);
  const [chatOpen, setChatOpen] = useState(false);



  const { isInPipMode: isInPip } = ExpoPip.useIsInPip();
  // Real status-bar height for this device, rather than a hard-coded guess.
  // Used to sit the arrival card just under the status bar on any phone —
  // notch, punch-hole or neither.
  const insets = useSafeAreaInsets();

  // Ensure the backend's active role matches this dashboard so Finder actions
  // (price calculation, booking, cancel, etc.) are authorized. Finding requires
  // no registration, so this is safe and idempotent.
  useEffect(() => {
    apiClient.post('/auth/switch-role', { newRole: 'FINDER' }).catch(() => {});
  }, []);

  // Restore an in-progress booking on mount: if the user has a reserved/active
  // booking (their parking window is still running), keep guiding them to the
  // spot — even after leaving the screen or restarting the app.
  useEffect(() => {
    (async () => {
      try {
        const res = await apiClient.get('/bookings/my-bookings');
        if (!res.data?.success) return;
        const nowTs = Date.now();
        const activeBooking = (res.data.data || []).find((b: any) => {
          if (b.status === 'active') return true; // checked in — always resume
          // Reserved: only resume a CURRENT session (booked <2h ago, window
          // still open) — stale test/abandoned reservations must not draw a
          // route on a fresh app open.
          if (b.status !== 'reserved') return false;
          const created = b.created_at ? new Date(b.created_at).getTime() : 0;
          const ends = b.end_time ? new Date(b.end_time).getTime() : 0;
          return nowTs - created < 2 * 60 * 60 * 1000 && ends > nowTs;
        });
        if (!activeBooking?.parking_spots) return;
        // Never auto-draw a route on open — offer to resume instead. The
        // route/navigation only appears if the user taps "Resume".
        setResumableBooking(activeBooking);
        console.log(`[Booking] In-progress booking #${activeBooking.id} found — offering resume`);
      } catch {}
    })();
  }, []);

  const resumeBooking = () => {
    const b = resumableBooking;
    if (!b?.parking_spots) return;
    const sp = b.parking_spots;
    const spotObj = {
      id: sp.id.toString(),
      title: sp.title,
      lat: parseFloat(sp.latitude),
      lng: parseFloat(sp.longitude),
      price: parseFloat(sp.price_per_hour),
      available: true,
      available_slots: parseInt(sp.available_slots) || 1,
      images: Array.isArray(sp.images) ? sp.images : [],
    };
    setSpots((prev) => (prev.some((s) => s.id === spotObj.id) ? prev : [...prev, spotObj]));
    setSelectedSpotId(spotObj.id);
    setBookingDetails((prev: any) => prev || b);
    setResumableBooking(null);

    // Straight into navigation — NOT via 'booking_confirm'.
    //
    // booking_confirm exists to confirm a booking you are about to make, and it
    // runs the "navigation starts in 3…" countdown. Resuming is neither: the
    // booking already exists and the user has just explicitly asked to carry on
    // to it. Sending resume through that screen made them watch a confirmation
    // and a countdown for a decision they made minutes ago.
    setIsFollowing(true);
    setStep('en_route');
    startBackgroundLocation().catch(() => {});
  };

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      if (nextAppState === 'background' && ['en_route', 'navigating', 'arriving'].includes(step)) {
        if (ExpoPip.isAvailable()) {
          try { ExpoPip.enterPipMode({}); } catch (e) { console.log('PIP not supported'); }
        }
      }
    });
    return () => subscription.remove();
  }, [step]);
  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [messages, setMessages] = useState<{ text: string, sender: 'bot' | 'user' }[]>([{
    text: "How can I help you find parking today?", sender: 'bot'
  }]);
  const [chatInput, setChatInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [navigationData, setNavigationData] = useState({ speed: 0, heading: 0 });
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [searchedPlace, setSearchedPlace] = useState<{ lat: number, lng: number, title: string } | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const [isMuted, setIsMuted] = useState(false);
  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  const [deviceHeading, setDeviceHeading] = useState(0);
  // Refs for GPS tracking logic
  const lastAnimatedHeading = useRef(0);
  // Reference point for deriving heading from displacement when the GPS
  // heading is unusable (slow speeds, where Android often omits it).
  const lastHeadingPos = useRef<{ lat: number; lng: number } | null>(null);
  const lastRouteFetch = useRef(0);
  const lastRouteDest = useRef<string | null>(null);
  const lastRouteFetchPos = useRef<{ lat: number; lng: number } | null>(null);
  // Backoff after a failed route fetch, so retrying cannot become a 1/sec
  // hammer while the server is unhappy.
  const routeRetryAfter = useRef(0);
  const lastUpdateCoords = useRef({ lat: 0, lng: 0 });
  const lastRerouteTime = useRef(0);
  const lastVoiceInstruction = useRef('');
  const lastVoiceDistance = useRef(0);
  const isMutedRef = useRef(false);

  // Read inside the GPS watcher's closure, which cannot see React state.
  // Everything ParkStop used to announce — turns, rerouting, arrival — is now
  // spoken by Google, so ours must fall silent or the rider hears both voices
  // saying different things a second apart.
  const isGoogleNavRef = useRef(false);

  // Consecutive road-snapped fixes within the arrival radius. Reset whenever
  // the rider moves back out, so only a genuine stop counts.
  const googleArrivalHits = useRef(0);
  // Fallback confirmation timer for arrival — see the backstop below. Held in a
  // ref so it can be cancelled if the rider moves back out of the radius.
  const arrivalTimer = useRef<any>(null);
  useEffect(() => () => { if (arrivalTimer.current) clearTimeout(arrivalTimer.current); }, []);


  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);
  const [bookingDetails, setBookingDetails] = useState<{ 
    id: string; 
    otp: string; 
    total_price?: number; 
    totalPrice?: number; 
    pricing?: PricingBreakdown; 
    checkout_otp?: string; 
    checkoutOtp?: string; 
    started_at?: string; 
    created_at?: string; 
    updated_at?: string; 
    start_time?: string; 
    payment_mode?: string;
    basePrice?: number;
    arrears?: number;
    finalAmount?: number;
  } | null>(null);
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [hasLocationPermission, setHasLocationPermission] = useState(true);
  // Bumping this re-runs location initialization — lets users enable location
  // at ANY time (from the banner or system settings) without restarting.
  const [locationRetryTick, setLocationRetryTick] = useState(0);
  // An in-progress booking found on open; shown as a "Resume" card, never auto-routed.
  const [resumableBooking, setResumableBooking] = useState<any>(null);
  // Quality of the most recent GPS fix — used to reject wandering low-accuracy readings.
  const lastFixQuality = useRef<{ acc: number; t: number } | null>(null);
  // Consecutive in-geofence GPS fixes required before declaring arrival.
  const arrivalHits = useRef(0);

  // Alert the spotter once per booking when the driver gets close to the spot.
  const bookingIdRef = useRef<number | null>(null);
  const notifiedNearbyRef = useRef<number | null>(null);
  useEffect(() => {
    bookingIdRef.current = (bookingDetails as any)?.id ?? null;
  }, [bookingDetails]);
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  // Extension duration in MINUTES. Presets cover quick top-ups (5/10/20/30 min)
  // and hour blocks (60/120/180); customExtendText holds a manual entry.
  const [selectedExtendMinutes, setSelectedExtendMinutes] = useState(60);
  const [customExtendText, setCustomExtendText] = useState('');
  const [isExtending, setIsExtending] = useState(false);
  const [showPaymentMethodModal, setShowPaymentMethodModal] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<'online' | 'cash'>('online');

  // Default payment method to what was chosen at booking time
  useEffect(() => {
    if (step === 'payment' && bookingDetails?.payment_mode) {
      setSelectedPaymentMethod(bookingDetails.payment_mode === 'cash' ? 'cash' : 'online');
    }
  }, [step]);

  useEffect(() => {
    if (step !== 'active_parking') {
      setElapsedMinutes(0);
      return;
    }

    const startTimeStr = bookingDetails?.updated_at || bookingDetails?.started_at || bookingDetails?.start_time || bookingDetails?.created_at;
    const sessionStart = startTimeStr ? new Date(startTimeStr).getTime() : Date.now();

    const updateTimer = () => {
      const diffMs = Date.now() - sessionStart;
      const totalMins = Math.max(0, Math.floor(diffMs / 60000));
      setElapsedMinutes(totalMins);
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000); // update every second for live feel

    return () => clearInterval(interval);
  }, [step, bookingDetails]);

  /**
   * Keep the legacy duration pair in step with the chosen window.
   *
   * parkingHours / parkingMinutes are read in a dozen places — pricing, the
   * active-session card, the booking request. Rather than chase all of them,
   * the window remains the single thing the rider edits and these follow it.
   */
  useEffect(() => {
    setParkingHours(Math.floor(windowMinutes / 60));
    setParkingMinutes(windowMinutes % 60);
  }, [windowMinutes]);

  useEffect(() => {
    if (step !== 'spot_booking' || !selectedSpotId) return;
    if (bookingWindowError) return; // don't price a window that cannot be booked

    const hours = windowMinutes / 60;
    // Price the window the rider actually chose, rather than assuming the stay
    // begins now. A booking made at 10am for 2pm–6pm is four hours of parking,
    // not eight.
    const start = bookingStart;
    const end = bookingEnd;

    const delayDebounceFn = setTimeout(async () => {
      setIsCalculatingPrice(true);
      const spot = spots.find(s => s.id === selectedSpotId);
      try {
        const res = await apiClient.post('/bookings/calculate-price', {
          spot_id: parseInt(selectedSpotId, 10),
          start_time: start.toISOString(),
          end_time: end.toISOString(),
        });
        if (res.data.success) {
          setCalculatedPrice(res.data.data.total_price);
        }
      } catch (err: any) {
        console.warn('Dynamic price API failed, using local estimate', err?.response?.status);
        // Local fallback: base rate × hours (no surge)
        if (spot?.price_per_hour) {
          setCalculatedPrice(Number((spot.price_per_hour * hours).toFixed(2)));
        }
      } finally {
        setIsCalculatingPrice(false);
      }
    }, 500);

    return () => clearTimeout(delayDebounceFn);
  }, [step, selectedSpotId, bookingStart, bookingEnd, windowMinutes, bookingWindowError]);

  // Auto-start navigation countdown
  useEffect(() => {
    if (step === 'booking_confirm') {
      setNavCountdown(3);
    } else {
      setNavCountdown(null);
    }
  }, [step]);

  useEffect(() => {
    if (navCountdown === null || navCountdown <= 0) {
      if (navCountdown === 0 && step === 'booking_confirm') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // The map owns the navigation camera. Setting isFollowing + the
        // navigating step makes GoogleMapNative animate to its own NAV_ZOOM /
        // NAV_PITCH / heading, which is the single definition of that camera.
        //
        // This used to fire TWO camera moves of its own here. The first went to
        // the user at zoom 17 pitch 60; then centerRoute() immediately
        // overrode it with the MIDPOINT between user and spot at zoom 15, flat.
        // On a 30km trip that midpoint is 15km away, so navigation opened on a
        // flat, zoomed-out view of empty countryside with the rider off-screen
        // entirely — and the follow camera then had to drag it all the way back.
        // Neither move belonged here: a route overview is a preview, not the
        // camera you drive with.
        if (routeCoords.length > 0) {
          setSimulatedLocation({ lat: routeCoords[0].latitude, lng: routeCoords[0].longitude });
        }
        setIsFollowing(true);
        setStep('en_route');
        // Phase 3: Start background location + cache tiles
        startBackgroundLocation().catch(() => {});
        // Offline tile caching removed. It downloaded MapLibre offline packs
        // for a MapLibre map this app no longer renders — mobile data, storage
        // and battery spent on tiles that could never be displayed. Google's
        // SDK manages its own tile cache.
      }
      return;
    }
    const timer = setTimeout(() => setNavCountdown(prev => prev !== null ? prev - 1 : null), 1000);
    return () => clearTimeout(timer);
  }, [navCountdown]);

  const [isRazorpayVisible, setIsRazorpayVisible] = useState(false);
  const [razorpayOrder, setRazorpayOrder] = useState<{
    orderId: string;
    amount: number;
    currency: string;
    keyId: string;
  } | null>(null);
  const [isUPIModalVisible, setIsUPIModalVisible] = useState(false);
  const [isUPIProcessing, setIsUPIProcessing] = useState(false);
  // Preselect UPI in Razorpay Checkout when the user tapped a UPI app.
  const [preferUpiCheckout, setPreferUpiCheckout] = useState(false);

  // REMOVED: executeUPIVerification + the mock UPI simulator.
  //
  // They existed only to send `mock_upi_intent` — a fake signature that asked
  // the server to mark a booking paid with no money moving. The server now
  // refuses it outright, and the UPI flow goes through Razorpay Checkout, which
  // produces a real, verifiable payment against the order.

  const [spots, setSpots] = useState<Spot[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSlotLoading, setIsSlotLoading] = useState(false);
  const [slotLoadError, setSlotLoadError] = useState(false); // true when slots couldn't load due to being offline
  const [isNearbyLoading, setIsNearbyLoading] = useState(false);

  useEffect(() => {
    const backAction = () => {
      // 1. Navigation Steps: Prompt for exit, return to home on confirm
      if (['en_route', 'navigating', 'arriving'].includes(step)) {
        Alert.alert(
          'Exit Navigation',
          'Are you sure you want to exit navigation?',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Yes',
              onPress: () => {
                setStep('home');
                setSelectedSpotId(null);
                setRouteCoords([]);
                setSimulatedLocation(null);
                setArrivalDetected(false);
                setIsFollowing(false);
                if (userLocation) fetchNearbySpots(userLocation.lat, userLocation.lng);
              }
            }
          ]
        );
        return true;
      }

      // 2. Spot Booking: Return to home
      if (step === 'spot_booking') {
        setStep('home');
        setSelectedSpotId(null);
        setSlotData([]);
        setSelectedSlot('');
        return true;
      }

      // 3. Booking Confirm: Return to home
      if (step === 'booking_confirm') {
        setStep('home');
        setNavCountdown(null);
        return true;
      }

      // 4. Home Step: Go back to vehicle select or exit
      if (step === 'home') {
        Alert.alert('Exit App', 'Are you sure you want to exit ParkStop?', [
          { text: 'Cancel', onPress: () => null, style: 'cancel' },
          { text: 'YES', onPress: () => {
              if (Platform.OS === 'android') {
                BackHandler.exitApp();
              } else {
                router.replace('/role-selection');
              }
            } 
          },
        ]);
        return true;
      }

      // 5. Vehicle Select: Exit app
      if (step === 'vehicle_select') {
        Alert.alert('Exit App', 'Are you sure you want to exit ParkStop?', [
          { text: 'Cancel', onPress: () => null, style: 'cancel' },
          { text: 'YES', onPress: () => {
              if (Platform.OS === 'android') {
                BackHandler.exitApp();
              } else {
                router.replace('/role-selection');
              }
            } 
          },
        ]);
        return true;
      }

      return false;
    };

    const backHandler = BackHandler.addEventListener('hardwareBackPress', backAction);
    return () => backHandler.remove();
  }, [step, searchQuery]);

  useEffect(() => {
    let locationSub: Location.LocationSubscription | null = null;

    // Run for EVERY navigating state, not just 'en_route'.
    //
    // This watcher is what feeds navigationData.heading — and the map rotates
    // to that heading whenever isActiveNavigation is true, which the finder
    // defines as en_route OR navigating OR arriving. Gating the watcher on
    // en_route alone meant that in the other two states the heading froze at
    // its last value, so the map stopped turning with the rider and sat
    // north-up while they travelled south. Speed froze the same way, which
    // also pinned the speed-adaptive zoom.
    // NOT while Google is guiding.
    //
    // Google runs its own location engine during navigation, and it is the one
    // that matters: its fixes are road-snapped, so a stationary rider stays put
    // instead of wandering. Running our own high-accuracy watcher alongside it
    // means two consumers competing for the same GPS hardware and two different
    // answers about where the rider is — which is why the blue dot drifted
    // while standing still, something Google Maps itself does not do.
    //
    // Everything this watcher provided during navigation is now Google's:
    // position comes from setOnLocationChanged, arrival from setOnArrival,
    // rerouting and heading from the SDK. It still runs outside navigation,
    // where the app genuinely needs its own fixes.
    // `!arrivalDetected` matters as much as `!isGoogleNavigating` here.
    //
    // Navigation now ends at arrival, which flips isGoogleNavigating false —
    // and without this guard that alone would wake this legacy watcher up on
    // the check-in screen: a second GPS consumer, turn-by-turn instructions
    // recomputed from a finished route, and the app speaking directions at a
    // rider who has already parked. The trip is over; nothing here should run.
    if (
      !isGoogleNavigating &&
      !arrivalDetected &&
      ['en_route', 'navigating', 'arriving'].includes(step) &&
      selectedSpotId
    ) {
      const spot = spots.find(s => s.id === selectedSpotId);
      if (!spot) return;

      if (userLocation) {
        setSimulatedLocation(userLocation);
      }

      // Haversine distance in km (now defined outside useEffect)
      // Smooth heading with low-pass filter
      const smoothHeading = (newH: number, oldH: number, alpha: number = 0.3) => {
        let diff = ((newH - oldH + 540) % 360) - 180;
        return (oldH + diff * alpha + 360) % 360;
      };

      // Simple Kalman filter for GPS smoothing
      let kalmanLat = { estimate: 0, error: 1, initialized: false };
      let kalmanLng = { estimate: 0, error: 1, initialized: false };
      const kalmanUpdate = (state: typeof kalmanLat, measurement: number, accuracy: number) => {
        const measureNoise = Math.max(accuracy * 0.00001, 0.000005); // convert ~meters to ~degrees
        const processNoise = 0.000003; // process noise (movement uncertainty)
        if (!state.initialized) {
          state.estimate = measurement;
          state.error = measureNoise;
          state.initialized = true;
          return measurement;
        }
        state.error += processNoise;
        const gain = state.error / (state.error + measureNoise);
        state.estimate += gain * (measurement - state.estimate);
        state.error *= (1 - gain);
        return state.estimate;
      };

      const startRealTracking = async () => {
        try {
          locationSub = await Location.watchPositionAsync({
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 5,
          }, (loc) => {
            const gpsAccuracy = loc.coords.accuracy || 10;
            // Apply Kalman filter to smooth GPS jitter
            const smoothLat = kalmanUpdate(kalmanLat, loc.coords.latitude, gpsAccuracy);
            const smoothLng = kalmanUpdate(kalmanLng, loc.coords.longitude, gpsAccuracy);
            const coords = { lat: smoothLat, lng: smoothLng };
            setSimulatedLocation(coords);
            setUserLocation(coords);

            const rawSpeed = loc.coords.speed || 0;
            const speedKmh = rawSpeed * 3.6;
            // Idle GPS jitter reports phantom speeds of 2-6 km/h; require a
            // clearly-moving speed AND a reasonable GPS fix before showing it.
            const gpsOk = (loc.coords.accuracy || 99) < 30;
            const isMoving = gpsOk && speedKmh > 6;

            // Heading, best source first.
            //
            // GPS heading only when genuinely moving — below ~6 km/h Android
            // either omits it or reports noise. But keeping the LAST heading
            // whenever that test failed left the arrow pointing the wrong way
            // through every slow crawl, queue and junction, which on a bike in
            // town is most of the ride.
            //
            // So when GPS heading is unusable, derive the bearing from actual
            // displacement between fixes. Requires >8m of movement, comfortably
            // above the Kalman-smoothed jitter floor, so a stationary rider
            // does not spin the arrow.
            const gpsHeading =
              isMoving && loc.coords.heading != null && loc.coords.heading >= 0
                ? loc.coords.heading
                : null;

            if (gpsHeading != null) {
              lastAnimatedHeading.current = smoothHeading(gpsHeading, lastAnimatedHeading.current, 0.35);
            } else if (lastHeadingPos.current) {
              const p = lastHeadingPos.current;
              const dyM = (coords.lat - p.lat) * 110540;
              const dxM = (coords.lng - p.lng) * 111320 * Math.cos((coords.lat * Math.PI) / 180);
              const movedM = Math.sqrt(dxM * dxM + dyM * dyM);
              if (movedM > 8) {
                // atan2(east, north) -> compass bearing, 0 = north.
                const bearing = (Math.atan2(dxM, dyM) * 180) / Math.PI;
                lastAnimatedHeading.current = smoothHeading(
                  (bearing + 360) % 360,
                  lastAnimatedHeading.current,
                  0.35
                );
              }
            }

            // Only advance the reference once we have moved far enough to have
            // learned something; otherwise jitter would keep resetting it and
            // the 8m gate could never be met.
            if (
              !lastHeadingPos.current ||
              Math.abs(coords.lat - lastHeadingPos.current.lat) > 0.00007 ||
              Math.abs(coords.lng - lastHeadingPos.current.lng) > 0.00007
            ) {
              lastHeadingPos.current = { lat: coords.lat, lng: coords.lng };
            }

            setNavigationData({
              speed: isMoving ? rawSpeed : 0,
              heading: lastAnimatedHeading.current
            });

            // Calculate remaining distance along actual route
            const straightKm = getDistanceKm(coords.lat, coords.lng, spot.lat, spot.lng);

            // When the driver gets within ~300m, alert the spotter once so they
            // can prepare for arrival. Fires a single time per booking.
            if (straightKm < 0.3 && bookingIdRef.current && notifiedNearbyRef.current !== bookingIdRef.current) {
              notifiedNearbyRef.current = bookingIdRef.current;
              apiClient.post(`/bookings/${bookingIdRef.current}/notify-nearby`, { distance_km: Number(straightKm.toFixed(2)) }).catch(() => {});
            }

            const currentRoute = routeCoords;
            let remainingKm = straightKm * 1.3; // fallback
            let closestIdx = 0;
            if (currentRoute.length >= 2) {
              let closestDist = Infinity;
              for (let ri = 0; ri < currentRoute.length; ri++) {
                const d = getDistanceKm(coords.lat, coords.lng, currentRoute[ri].latitude, currentRoute[ri].longitude);
                if (d < closestDist) { closestDist = d; closestIdx = ri; }
              }
              let segDist = 0;
              for (let ri = closestIdx; ri < currentRoute.length - 1; ri++) {
                segDist += getDistanceKm(
                  currentRoute[ri].latitude, currentRoute[ri].longitude,
                  currentRoute[ri + 1].latitude, currentRoute[ri + 1].longitude
                );
              }
              if (segDist > 0.01) remainingKm = segDist;
            }

            // Traffic-adjusted ETA: sum remaining step durations instead of speed guessing
            let etaMins = 0;
            const stepsForEta = routeStepsRef.current;
            if (stepsForEta.length > 0) {
              // Sum duration from all remaining steps (already traffic-aware from Ola Maps)
              let sumDurationSec = 0;
              let foundCurrent = false;
              for (const st of stepsForEta) {
                // Count all remaining steps (they've been trimmed by the step-consumption logic)
                sumDurationSec += (st.duration || 0);
              }
              etaMins = Math.max(1, Math.ceil(sumDurationSec / 60));
            } else {
              // Fallback to speed-based estimate
              const avgSpeedKmh = speedKmh > 8 ? speedKmh : 25;
              etaMins = Math.max(1, Math.ceil((remainingKm / avgSpeedKmh) * 60));
            }

            setDistanceInfo({
              km: remainingKm.toFixed(1),
              mins: etaMins.toString()
            });

            // Periodic traffic re-fetch: every 60s, re-request route for updated traffic ETA
            const now = Date.now();
            if (now - lastRouteFetch.current > 60000 && remainingKm > 0.3) {
              lastRouteFetch.current = now;
              apiClient.get(`/maps/route?start=${coords.lng},${coords.lat}&end=${spot.lng},${spot.lat}&alternatives=true`)
                .then((rRes: any) => {
                  if (rRes.data.success) {
                    // Same selection rule as everywhere else — this used to
                    // take routes[0] blindly and could disagree with the route
                    // drawn by the main fetch.
                    const rRoute = pickBestRoute(rRes.data.data.routes || [], { trustProviderOrder: rRes.data.provider === 'google' });
                    if (rRoute?.legs?.[0]?.steps) {
                      routeStepsRef.current = rRoute.legs[0].steps;
                      // Free-flow for every segment, exactly as the main fetch
                      // reports it.
                      //
                      // This block used to derive congestion from
                      // step.distance / step.duration and paint anything under
                      // 25 km/h orange. But the field mask asks Google for
                      // staticDuration — the time with NO traffic — so that
                      // figure is free-flow speed, not congestion. Short steps
                      // (junction slip roads, roundabout arms) always come out
                      // slow, which is why orange blobs appeared at junctions
                      // on a completely clear road. The main fetch was fixed
                      // for this; this copy was missed, so the orange came
                      // back 60 seconds into every trip.
                      setTrafficSegments(
                        rRoute.legs[0].steps
                          .filter((s: any) => s.geometry?.coordinates?.length >= 2)
                          .map((s: any) => ({
                            coords: s.geometry.coordinates,
                            congestion: 'low' as const,
                          }))
                      );
                    }
                    // Never silently replace a route the rider chose.
                    //
                    // This refresh exists to keep the ETA honest, but it also
                    // overwrote routeCoords with whatever pickBestRoute
                    // returned. So after tapping an alternative, roughly a
                    // minute later the map snapped back to the route they had
                    // just rejected. Their choice stands until the destination
                    // changes or they go off-route and we genuinely reroute.
                    if (rRoute && !userSelectedRoute.current) {
                      setRouteCoords(rRoute.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })));
                    }
                  }
                })
                .catch(() => {});
            }

            // Speed limit fetch: every 30s
            if (now - lastSpeedLimitFetch.current > 30000) {
              lastSpeedLimitFetch.current = now;
              apiClient.get(`/maps/speed-limit?lat=${coords.lat}&lng=${coords.lng}`)
                .then((slRes: any) => {
                  if (slRes.data.success && slRes.data.data.speedLimit) {
                    setSpeedLimit(slRes.data.data.speedLimit);
                  }
                })
                .catch(() => {});
            }

            // ── Phase 4: Server-side snap-to-road (every 5s) ──
            if (now - lastSnapFetch.current > 5000) {
              lastSnapFetch.current = now;
              apiClient.post('/maps/snap-to-road', {
                points: [{ lat: coords.lat, lng: coords.lng }]
              }).then((snapRes: any) => {
                const snapped = snapRes.data?.data?.snapped;
                if (snapped?.length > 0 && snapped[0].lat && snapped[0].lng) {
                  setSimulatedLocation({ lat: snapped[0].lat, lng: snapped[0].lng });
                }
              }).catch(() => {});
            }

            // Turn-by-turn: consume steps and find the next meaningful maneuver
            const stepsArr = [...routeStepsRef.current];

            // Pop all steps whose maneuver point we've already passed (within 30m)
            while (stepsArr.length > 1) {
              const loc = stepsArr[0]?.maneuver?.location;
              if (!loc) break;
              const d = getDistanceKm(coords.lat, coords.lng, loc[1], loc[0]) * 1000;
              if (d < 30) { stepsArr.shift(); } else { break; }
            }
            routeStepsRef.current = stepsArr;

            // Helper: parse a maneuver step into action + icon

            // Find next meaningful turn (skip 'continue' / 'depart' / 'new name' steps)
            let displayStep = stepsArr[0];
            let displayDist = Infinity;
            let displayIdx = 0;
            for (let si = 0; si < stepsArr.length; si++) {
              const s = stepsArr[si];
              const t = s?.maneuver?.type || '';
              if (['turn', 'end of road', 'fork', 'roundabout', 'rotary', 'merge', 'arrive'].includes(t)) {
                displayStep = s;
                displayIdx = si;
                if (s.maneuver?.location) {
                  displayDist = getDistanceKm(coords.lat, coords.lng, s.maneuver.location[1], s.maneuver.location[0]) * 1000;
                }
                break;
              }
              if (si === 0 && s?.maneuver?.location) {
                displayDist = getDistanceKm(coords.lat, coords.lng, s.maneuver.location[1], s.maneuver.location[0]) * 1000;
              }
            }

            // Fallback: if no turn found, use first step
            if (displayStep?.maneuver?.location && displayDist === Infinity) {
              displayDist = getDistanceKm(coords.lat, coords.lng, displayStep.maneuver.location[1], displayStep.maneuver.location[0]) * 1000;
            }

            // Find the NEXT meaningful turn after the current one (for "then" preview)
            let nextStep: any = null;
            for (let si = displayIdx + 1; si < stepsArr.length; si++) {
              const t = stepsArr[si]?.maneuver?.type || '';
              if (['turn', 'end of road', 'fork', 'roundabout', 'rotary', 'merge', 'arrive'].includes(t)) {
                nextStep = stepsArr[si];
                break;
              }
            }

            if (displayStep?.maneuver) {
              const { action, icon } = parseManeuver(displayStep);
              const name = displayStep.name || '';

              // Distance text
              let distText = '';
              if (displayDist < 50) { distText = 'Now'; }
              else if (displayDist < 1000) { distText = `${Math.round(displayDist / 10) * 10} m`; }
              else { distText = `${(displayDist / 1000).toFixed(1)} km`; }

              const streetText = name
                ? (distText === 'Now' ? name : `${distText} · ${name}`)
                : distText;

              setCurrentInstruction({ turn: action, street: streetText, icon });

              // ── Phase 4: Landmark fetch for next turn ──
              if (now - lastLandmarkFetch.current > 15000 && displayStep?.maneuver?.location) {
                const turnLoc = displayStep.maneuver.location;
                const cacheKey = `${turnLoc[1].toFixed(4)},${turnLoc[0].toFixed(4)}`;
                if (!landmarkCache.current.has(cacheKey)) {
                  lastLandmarkFetch.current = now;
                  apiClient.get(`/maps/nearby-pois?lat=${turnLoc[1]}&lng=${turnLoc[0]}&radius=80`)
                    .then((poiRes: any) => {
                      const pois = poiRes.data?.data?.pois || [];
                      if (pois.length > 0) {
                        landmarkCache.current.set(cacheKey, pois[0].name);
                      }
                    }).catch(() => {});
                }
              }

              // Lane guidance: show lanes for the current/upcoming step
              if (displayStep?.lanes && displayStep.lanes.length > 0 && displayDist < 500) {
                setLaneGuidance(displayStep.lanes);
              } else {
                setLaneGuidance([]);
              }

              // Next-turn preview ("then turn left")
              if (nextStep && displayDist < 800) {
                const next = parseManeuver(nextStep);
                setNextTurnPreview({ turn: `Then ${next.action.toLowerCase()}`, icon: next.icon });
              } else {
                setNextTurnPreview({ turn: '', icon: '' });
              }

              // ── Voice navigation + haptics ──
              if (displayDist < Infinity) {
                // Voice at 500m, 200m, and 50m thresholds (don't repeat same tier)
                let voiceTier = 0;
                if (displayDist <= 50) voiceTier = 50;
                else if (displayDist <= 200) voiceTier = 200;
                else if (displayDist <= 500) voiceTier = 500;

                const voiceKey = `${action}@${voiceTier}`;
                if (voiceTier > 0 && voiceKey !== lastVoiceInstruction.current) {
                  lastVoiceInstruction.current = voiceKey;

                  // ── Phase 4: Haptic turn alert ──
                  const hapticKey = `${action}@${voiceTier}`;
                  if (hapticKey !== lastHapticTurn.current) {
                    lastHapticTurn.current = hapticKey;
                    if (voiceTier === 50) {
                      // Imminent turn: strong double-pulse
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                      setTimeout(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy), 150);
                    } else if (voiceTier === 200) {
                      // Approaching: medium pulse
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    } else {
                      // 500m warning: light pulse
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    }
                  }

                  if (!isMutedRef.current) {
                    // Build voice text
                    let voiceText = '';
                    if (voiceTier === 500) {
                      voiceText = `In ${Math.round(displayDist / 100) * 100} meters, ${action.toLowerCase()}`;
                    } else if (voiceTier === 200) {
                      voiceText = `In ${Math.round(displayDist / 50) * 50} meters, ${action.toLowerCase()}`;
                    } else {
                      voiceText = action;
                    }
                    if (name && voiceTier >= 200) voiceText += `, on ${name}`;

                    // Phase 4: Landmark enrichment ("turn left after the petrol pump")
                    if (displayStep?.maneuver?.location && voiceTier >= 200) {
                      const turnLoc = displayStep.maneuver.location;
                      const cacheKey = `${turnLoc[1].toFixed(4)},${turnLoc[0].toFixed(4)}`;
                      const landmark = landmarkCache.current.get(cacheKey);
                      if (landmark) {
                        voiceText += `, after ${landmark}`;
                      }
                    }

                    // Phase 4: Hindi/regional TTS — translate common instructions
                    const ttsLang = navLanguage;
                    if (ttsLang === 'hi-IN') {
                      // Hindi translations for common nav instructions
                      voiceText = voiceText
                        .replace(/Turn right/gi, 'Daayein mudhein')
                        .replace(/Turn left/gi, 'Baayein mudhein')
                        .replace(/Sharp right/gi, 'Tez daayein')
                        .replace(/Sharp left/gi, 'Tez baayein')
                        .replace(/Bear right/gi, 'Halka daayein')
                        .replace(/Bear left/gi, 'Halka baayein')
                        .replace(/Continue straight/gi, 'Seedha chalein')
                        .replace(/Head straight/gi, 'Seedha chalein')
                        .replace(/Make a U-turn/gi, 'U-turn lein')
                        .replace(/Enter roundabout/gi, 'Gol chakkar mein jaayein')
                        .replace(/In (\d+) meters/gi, '$1 meter mein')
                        .replace(/Arriving at destination/gi, 'Aap apni manzil par pahunch gaye hain')
                        .replace(/Rerouting/gi, 'Naya raasta dhundh rahe hain')
                        .replace(/You have arrived/gi, 'Aap pahunch gaye hain');
                    } else if (ttsLang === 'ta-IN') {
                      voiceText = voiceText
                        .replace(/Turn right/gi, 'Valathupuram thirumbavum')
                        .replace(/Turn left/gi, 'Idathupuram thirumbavum')
                        .replace(/Continue straight/gi, 'Neraaga sellavum')
                        .replace(/Head straight/gi, 'Neraaga sellavum');
                    } else if (ttsLang === 'te-IN') {
                      voiceText = voiceText
                        .replace(/Turn right/gi, 'Kudi vaipunaku thirugandi')
                        .replace(/Turn left/gi, 'Edama vaipunaku thirugandi')
                        .replace(/Continue straight/gi, 'Thinnaga vellandi');
                    } else if (ttsLang === 'kn-IN') {
                      voiceText = voiceText
                        .replace(/Turn right/gi, 'Balagade thirugiri')
                        .replace(/Turn left/gi, 'Edagade thirugiri')
                        .replace(/Continue straight/gi, 'Neravagi hogiri');
                    }

                    // Silent while Google is guiding — Google speaks the turns.
                    if (!isGoogleNavRef.current) {
                      Speech.speak(voiceText, { rate: 1.0, pitch: 1.0, language: ttsLang });
                    }
                  }
                }
              }
            }

            // Arrival detection — must be genuinely AT the spot:
            //  • within 25m straight-line of the spot (a real geofence, not a
            //    block away), AND
            //  • the GPS fix is trustworthy (accuracy better than 30m), AND
            //  • confirmed on 2 consecutive fixes so a single stray reading
            //    can't announce arrival early.
            // `remainingKm` is deliberately NOT used: it starts life as a
            // straight-line estimate (×1.3) and could trip arrival on its own.
            const gpsAcc = loc.coords.accuracy || 99;
            const withinGeofence = straightKm <= 0.025 && gpsAcc <= 30;
            arrivalHits.current = withinGeofence ? arrivalHits.current + 1 : 0;

            // Kept as a BACKSTOP behind Google's own arrival event.
            //
            // Google's setOnArrival is more accurate — it knows the route and
            // the destination geometry, not just a radius. But arrival gates
            // check-in, and check-in gates payment, so this is not a path to
            // leave with a single trigger while the Navigation SDK is still
            // Beta. Both set the same state and the !arrivalDetected guard
            // means whichever fires first wins; the other is a no-op.
            if (arrivalHits.current >= 2 && !arrivalDetected) {
              setArrivalDetected(true);
              setIsFollowing(false);
              if (!isMutedRef.current && !isGoogleNavRef.current) {
                const arrText = navLanguage === 'hi-IN' ? 'Aap apni manzil par pahunch gaye hain'
                  : 'You have arrived at your destination';
                Speech.speak(arrText, { rate: 1.0, pitch: 1.0, language: navLanguage });
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
              if (locationSub) {
                try { locationSub.remove(); } catch (e) {}
                locationSub = null;
              }
            }
          });
        } catch (e) {
          console.log("GPS Watch Error:", e); // background watcher; not user-facing
        }
      };

      startRealTracking();

      // Background location listener — merges BG updates when app is backgrounded
      const removeBgListener = onBackgroundLocation((bgCoords) => {
        setUserLocation({ lat: bgCoords.latitude, lng: bgCoords.longitude });
        setSimulatedLocation({ lat: bgCoords.latitude, lng: bgCoords.longitude });
        if (bgCoords.heading != null) {
          setNavigationData(prev => ({ ...prev, heading: bgCoords.heading || prev.heading }));
        }
      });

      return () => {
        if (locationSub) {
          try { locationSub.remove(); } catch (e) {}
        }
        removeBgListener();
        stopBackgroundLocation().catch(() => {});
        Speech.stop();
      };
    } else if (!['arriving'].includes(step)) {
      // Don't reset arrivalDetected when transitioning to 'arriving' (check-in flow)
      setArrivalDetected(false);
      arrivalHits.current = 0; // fresh geofence count for the next trip
      setSimulatedLocation(null);
      setDistanceInfo({ km: '0', mins: '0' });
      setTrafficSegments([]);
      setSpeedLimit(null);
      setLaneGuidance([]);
      Speech.stop();
      lastVoiceInstruction.current = '';
    }
  }, [step, selectedSpotId]);

  // Navigation Simulation disabled in favor of real-time GPS tracking
  useEffect(() => {
    if (['en_route', 'navigating', 'arriving'].includes(step) && routeCoords.length > 0) {
      console.log("[NAV] Navigation mode active. Waiting for GPS signal...");
    }
  }, [step, routeCoords]);
  // Only fetch route when a spot is selected (tapped or booked) — NOT on search alone.
  // Search just shows the pin + nearby spots; directions appear after selecting a spot.
  useEffect(() => {
    const now = Date.now();
    const destination = selectedSpotId
      ? spots.find(s => s.id === selectedSpotId)
      : null; // No fallback to searchedPlace — routes only for selected spots

    const isActiveNav = ['en_route', 'navigating', 'arriving'].includes(step);
    const destId = destination ? String(('id' in destination ? (destination as any).id : '') || `${destination.lat},${destination.lng}`) : null;
    const isNewDest = destId !== lastRouteDest.current;

    // During navigation, only refetch when the user has actually MOVED —
    // GPS jitter at rest (±2-5m) must not trigger a refetch loop that thrashes
    // the map and the server every few seconds.
    let movedEnough = true;
    if (isActiveNav && !isNewDest && userLocation && lastRouteFetchPos.current) {
      const dLat = (userLocation.lat - lastRouteFetchPos.current.lat) * 110540;
      const dLng = (userLocation.lng - lastRouteFetchPos.current.lng) * 111320;
      movedEnough = Math.sqrt(dLat * dLat + dLng * dLng) > 30; // meters
    }

    if (destination && userLocation && (isActiveNav || isNewDest) && (now - lastRouteFetch.current > 4000 || isNewDest) && movedEnough && now >= routeRetryAfter.current) {
      lastRouteFetch.current = now;
      lastRouteDest.current = destId;
      lastRouteFetchPos.current = { lat: userLocation.lat, lng: userLocation.lng };
      // A new destination means the rider's earlier route choice was about a
      // different journey; it must not carry over and block this one.
      if (isNewDest) userSelectedRoute.current = false;
      (async () => {
        try {
          console.log(`[API] Fetching route from ${userLocation.lat},${userLocation.lng} to ${destination.lat},${destination.lng}`);
          const isNav = ['en_route', 'navigating', 'arriving'].includes(step);
          // Alternatives are requested even while navigating. Previously this
          // was `alternatives=${!isNav}`, so during navigation the provider
          // returned exactly ONE route and there was nothing to choose from —
          // whatever detour it picked was what you drove. Responses are cached
          // server-side for 10 minutes and refetch is movement-gated, so the
          // extra candidates cost little.
          const res = await apiClient.get(`/maps/route?start=${userLocation.lng},${userLocation.lat}&end=${destination.lng},${destination.lat}&alternatives=true`);
          if (res.data.success) {
            const routes = res.data.data.routes || [];
            // Shortest sensible route, not merely the fastest — see
            // utils/routeSelection.ts for why those differ.
            const route = pickBestRoute(routes, { trustProviderOrder: res.data.provider === 'google' });
            if (!route) {
              // The server answered but gave nothing usable. Treat it as a
              // failure so the destination is un-marked and we try again,
              // rather than silently leaving the map with no route forever.
              throw new Error('no usable route in response');
            }
            console.log(`[API] Route found! ${route.geometry.coordinates.length} points. ${routes.length} alternatives. Best: ${(route.distance / 1000).toFixed(1)}km/${Math.ceil(route.duration / 60)}min`);

            // While navigating this effect refires every 30m of movement. If
            // the rider picked an alternative, that refire would quietly put
            // them back on the algorithm's route — the choice would survive
            // maybe half a minute of riding. Leave everything alone.
            //
            // Note the ETA is deliberately NOT refreshed here either: `route`
            // is the algorithm's pick, so its distance and duration describe a
            // road the rider is not on. Showing that under their chosen route
            // would be worse than showing a slightly stale figure. The live
            // ETA comes from the navigation watcher, which measures against
            // the route actually drawn.
            if (userSelectedRoute.current) return;

            setRouteCoords(route.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })));
            setDistanceInfo({ km: (route.distance / 1000).toFixed(1), mins: Math.ceil(route.duration / 60).toString() });
            if (route.legs?.[0]?.steps) {
              routeStepsRef.current = route.legs[0].steps;
              // Compute traffic segments from step-level speed data
              const steps = route.legs[0].steps;
              const segments: Array<{ coords: Array<[number, number]>; congestion: 'low' | 'moderate' | 'heavy' | 'severe' }> = [];
              for (const s of steps) {
                if (s.geometry?.coordinates && s.geometry.coordinates.length >= 2 && s.duration > 0) {
                  // NOT REAL TRAFFIC — every segment is reported as free-flowing.
                  //
                  // This used to derive congestion from step.distance /
                  // step.duration, but the Google field mask requests
                  // `staticDuration` — the time with NO traffic. So the figure
                  // was free-flow speed being labelled as congestion. Short
                  // manoeuvring steps (20m in 5s ~ 14 km/h) always scored as
                  // heavy, which is why turns painted orange and, with the old
                  // 45 km/h threshold, the entire route did.
                  //
                  // Inventing congestion is worse than showing none: it tells
                  // the rider a clear road is jammed. Real traffic colouring
                  // needs Google's travelAdvisory.speedReadingIntervals, which
                  // classifies stretches as SLOW / TRAFFIC_JAM against normal
                  // conditions. Until that is wired through, report free-flow
                  // so the route renders as a clean blue line.
                  const congestion: 'low' | 'moderate' | 'heavy' | 'severe' = 'low';
                  segments.push({ coords: s.geometry.coordinates, congestion });
                }
              }
              setTrafficSegments(segments);
              // Extract lane guidance for first meaningful step
              const firstLaneStep = steps.find((s: any) => s.lanes && s.lanes.length > 0);
              if (firstLaneStep) setLaneGuidance(firstLaneStep.lanes);
              else setLaneGuidance([]);
            }
            // Alternatives = everything EXCEPT the route we actually drew.
            // The old `routes.slice(1)` assumed the primary was always
            // routes[0]; once selection started choosing a different one, the
            // primary was ALSO painted underneath as a grey alternative while
            // the provider's first route disappeared from the list entirely.
            if (!isNav) {
              setAltRoutes(otherRoutes(routes, route).map((r: any) => ({
                coords: r.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })),
                duration: r.duration,
                distance: r.distance,
                // Carry the turn list with each alternative. Without it,
                // tapping an alternative drew the new line but left the turn
                // card reading from the old route's steps — so the app
                // confidently announced turns for a road you were no longer on.
                steps: r.legs?.[0]?.steps,
              })));
            } else {
              setAltRoutes([]);
            }
          }
        } catch (e) {
          // Un-mark the destination so the effect will try again.
          //
          // Previously this only logged. Because `lastRouteDest` was set
          // BEFORE the request, a single failed fetch (429, timeout, slow
          // response, or a response with no usable route) left the spot
          // permanently marked as "already routed" — so no route was ever
          // drawn for it and nothing retried. That is the "sometimes there is
          // no route" behaviour.
          console.log('[Route] fetch failed — will retry', e);
          lastRouteDest.current = null;
          routeRetryAfter.current = Date.now() + 4000; // bounded backoff
        }
      })();
    } else if (!destination) {
      setRouteCoords([]);
      setAltRoutes([]);
      // Forget which destination we routed to. Without this, cancelling a spot
      // and then re-selecting the SAME spot left isNewDest false, so no fetch
      // ran and the map sat there with no route — another source of the
      // "sometimes there's no route" behaviour.
      lastRouteDest.current = null;
      routeRetryAfter.current = 0;
    }
  }, [selectedSpotId, userLocation, spots, step]);


  // Fetch map style config (Ola Maps vector tiles or Carto fallback)
  useEffect(() => {
    apiClient.get('/maps/style')
      .then((res: any) => {
        if (res.data.success && res.data.data) {
          setMapStyleConfig(res.data.data);
        }
      })
      .catch(() => {}); // silently fallback to Carto defaults
  }, []);

  // Load the remembered viewport before anything else, so the map's very first
  // paint is the user's area rather than the whole of India.
  useEffect(() => {
    loadLastLocation().then((c) => { if (c) setViewportHint(c); });
  }, []);

  useEffect(() => {
    registerForPushNotificationsAsync();
    let watchSub: Location.LocationSubscription | null = null;
    let headingSub: any = null;
    (async () => {
      try {
        let { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setHasLocationPermission(false);
          return;
        }
        setHasLocationPermission(true);

        // Permission granted is NOT the same as location being available: the
        // device's own Location Services toggle can still be off, in which case
        // every position call throws "Current location is unavailable".
        const servicesOn = await Location.hasServicesEnabledAsync().catch(() => true);
        setLocationServicesOff(!servicesOn);

        // 1. Race multiple location strategies — whichever resolves first wins.
        //    Every strategy is made NON-THROWING first. Promise.race rejects as
        //    soon as ANY input rejects, so an immediate "location unavailable"
        //    error used to beat the 5s timeout and blow up the whole init —
        //    skipping the watcher, the heading, and the nearby-spot fetch.
        const getLocationFast = async (): Promise<{ lat: number; lng: number } | null> => {
          // Strategy A: Last known position — only if RECENT (≤30s). Stale
          // positions were placing the dot minutes behind the user.
          const lastKnown = Location.getLastKnownPositionAsync({ maxAge: 30000 })
            .then((loc) => (loc ? { lat: loc.coords.latitude, lng: loc.coords.longitude } : null))
            .catch(() => null);

          // Strategy B: Fresh position at Balanced (~100m, fast). Never Lowest —
          // cell-tower granularity put the dot kilometers off on open.
          const fresh = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
            .then((loc) => ({ lat: loc.coords.latitude, lng: loc.coords.longitude }))
            .catch(() => null);

          // Strategy C: Timeout so the app never hangs waiting on a fix.
          const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));

          // A *failure* must not win the race.
          //
          // Promise.race settles on the first promise to SETTLE, and resolving
          // to null counts. On a phone with no cached fix, getLastKnownPosition
          // returns null within milliseconds — so it won the race every time,
          // the fast Balanced attempt was abandoned mid-flight, and every cold
          // open fell through to the slow high-accuracy call below. Letting a
          // null-resolving strategy hang instead means only a real fix, or the
          // timeout, can decide this.
          const onlyIfFound = (p: Promise<{ lat: number; lng: number } | null>) =>
            p.then((v) => (v ? v : new Promise<{ lat: number; lng: number } | null>(() => {})));

          const result = await Promise.race([onlyIfFound(lastKnown), onlyIfFound(fresh), timeout]);
          if (result) return result;

          // Nothing won the race — wait for the slower high-accuracy attempt,
          // but never let it throw either.
          const fallback = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
            .then((l) => ({ lat: l.coords.latitude, lng: l.coords.longitude }))
            .catch(() => null);
          return fallback;
        };

        const coords = await getLocationFast();

        if (coords) {
          setLocationServicesOff(false);
          setUserLocation(coords);
          lastUpdateCoords.current = coords;
          saveLastLocation(coords);
          fetchNearbySpots(coords.lat, coords.lng);
        }
        // If coords is null we deliberately CONTINUE rather than bail: the
        // watcher below will deliver a position the moment GPS becomes
        // available, so the map recovers on its own without an app restart.

        // Refine in the background with the strongest GPS mode so the dot
        // settles on the user's true position within a few seconds of opening.
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.BestForNavigation })
          .then((l) => {
            const acc = l.coords.accuracy || 15;
            const q = lastFixQuality.current;

            // Apply the SAME accuracy gate the watcher below uses.
            //
            // BestForNavigation can take ten or twenty seconds to return. By
            // then the watcher has usually settled the dot on a good fix — and
            // this call was overwriting it unconditionally, including when what
            // it came back with was worse. The dot would look right, then jump
            // somewhere else a few seconds after opening and stay there. That
            // late jump is what reads as the GPS being inaccurate, and it was
            // the app's own doing rather than the sensor's.
            if (acc > 35 && q && q.acc < acc / 2 && Date.now() - q.t < 10000) return;

            const precise = { lat: l.coords.latitude, lng: l.coords.longitude };
            setUserLocation(precise);
            setLocationAccuracy(acc);
            lastUpdateCoords.current = precise;
            saveLastLocation(precise);
            lastFixQuality.current = { acc, t: Date.now() };
          })
          .catch(() => {});

        // 2. Continuous watch: strongest GPS, 1s/2m — with ACCURACY GATING.
        //    A reading with high uncertainty must not drag the dot away from a
        //    recent precise fix (that wander was the "inaccurate" feeling).
        //    Wrapped so a watcher failure cannot take down the heading
        //    subscription or anything after it.
        try {
          watchSub = await Location.watchPositionAsync({
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 2,
          }, (l) => {
            const acc = l.coords.accuracy || 99;
            const q = lastFixQuality.current;
            // Skip poor readings (>35m uncertainty) when we've had a clearly
            // better fix within the last 10 seconds.
            if (acc > 35 && q && q.acc < acc / 2 && Date.now() - q.t < 10000) return;
            lastFixQuality.current = { acc, t: Date.now() };
            setLocationAccuracy(acc);
            const newCoords = { lat: l.coords.latitude, lng: l.coords.longitude };
            setUserLocation(newCoords);
            saveLastLocation(newCoords);
            // A streaming fix proves services are on — clear any stale banner
            // and load spots if the initial attempt came back empty.
            setLocationServicesOff(false);
            if (!lastUpdateCoords.current) {
              lastUpdateCoords.current = newCoords;
              fetchNearbySpots(newCoords.lat, newCoords.lng);
            }
          });
        } catch (watchErr) {
          console.log('[Location] watch unavailable:', watchErr);
        }

        try {
          headingSub = await Location.watchHeadingAsync((h) => {
            setDeviceHeading(h.trueHeading);
          });
        } catch {
          // Compass unavailable on this device — navigation still works.
        }

        // NOTE: the initial camera move is deliberately NOT done here any more.
        // The old `setTimeout(800) -> animateCamera` raced both the map style
        // load and the camera mount; when it lost, animateCamera's ref guard
        // returned early and the map silently stayed on the country view. That
        // was the "map can't find me after granting permission" bug.
        // MapLibreNative now owns this (see positionOnFirstFix) and fires on
        // whichever of {map ready, first fix} completes last.

        // Guarded: with no fix there is nothing to search around. The watcher
        // above fetches spots itself once a position finally arrives.
        try {
          if (!coords) throw new Error('no-fix');
          const res = await apiClient.get(`/spots/nearby?lat=${coords.lat}&lng=${coords.lng}&radius=10`);
          if (res.data.success) {
            setSpots(res.data.data.map((sp: any) => ({
              id: sp.id.toString(),
              title: sp.title,
              lat: parseFloat(sp.latitude),
              lng: parseFloat(sp.longitude),
              price: parseFloat(sp.price_per_hour),
              available: parseInt(sp.available_slots) > 0,
              available_slots: parseInt(sp.available_slots) || 0,
              distance: sp.distance ? parseFloat(sp.distance).toFixed(1) : undefined,
              location_type: sp.location_type,
              images: Array.isArray(sp.images) ? sp.images : []
            })));
          }
        } catch (e: any) {
          if (e?.message !== 'no-fix') {
            console.log('Error fetching initial spots', e);
            setSpots([]);
          }
        }
      } catch (error) {
        console.log('[Location] Error during initialization:', error);
      }
    })();

    const newSocket = io(SOCKET_URL, { transports: ['websocket'] });
    setSocket(newSocket);
    newSocket.on('spot_update', (updatedSpot: Spot) => {
      setSpots(current => current.map(s => s.id === updatedSpot.id ? updatedSpot : s));
    });

    return () => {
      newSocket.disconnect();
      try {
        if (watchSub && typeof watchSub.remove === 'function') watchSub.remove();
      } catch (e) { console.log('watchSub remove ignored'); }
      try {
        if (headingSub && typeof headingSub.remove === 'function') headingSub.remove();
      } catch (e) { console.log('headingSub remove ignored'); }
    };
  }, [locationRetryTick]);

  // If the user enables location in system settings and returns to the app,
  // detect it on foreground and start tracking immediately (no restart needed).
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (s) => {
      if (s !== 'active') return;
      try {
        if (!hasLocationPermission) {
          const { status } = await Location.getForegroundPermissionsAsync();
          if (status === 'granted') {
            setHasLocationPermission(true);
            setLocationRetryTick((t) => t + 1);
          }
          return;
        }
        // Permission is already held — the user may have just come back from
        // switching the device location toggle on. Re-run acquisition so the
        // map recovers without them having to restart the app.
        if (locationServicesOff) {
          const on = await Location.hasServicesEnabledAsync().catch(() => false);
          if (on) {
            setLocationServicesOff(false);
            setLocationRetryTick((t) => t + 1);
          }
        }
      } catch {}
    });
    return () => sub.remove();
  }, [hasLocationPermission, locationServicesOff]);

  // Banner action: re-prompt in-app when possible; otherwise open settings.
  // Opens the DEVICE location panel, not the app's permission page. On Android
  // these are different screens: Linking.openSettings() lands on the app info
  // page, which has no master location toggle — useless for this failure.
  const openLocationSettings = async () => {
    try {
      if (Platform.OS === 'android') {
        // Built-in RN API — deliberately not expo-intent-launcher, which would
        // add a native dependency (and a rebuild) for a single intent.
        await Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS');
        return;
      }
      // iOS exposes no deep link to the location panel; app settings is the
      // closest reachable surface.
      await Linking.openSettings();
    } catch {
      Linking.openSettings().catch(() => {});
    }
  };

  const handleEnableLocation = async () => {
    try {
      const res = await Location.requestForegroundPermissionsAsync();
      if (res.status === 'granted') {
        setHasLocationPermission(true);
        setLocationRetryTick((t) => t + 1);
      } else if (!res.canAskAgain) {
        Linking.openSettings();
      }
    } catch {
      Linking.openSettings();
    }
  };

  // Load saved vehicle type from AsyncStorage, defaulting to Car Sedan to go straight to dashboard
  useEffect(() => {
    (async () => {
      try {
        const savedType = await AsyncStorage.getItem('parkstop_vehicle_type');
        const savedSubType = await AsyncStorage.getItem('parkstop_vehicle_subtype');
        if (savedType) {
          setVehicleType(savedType);
          setVehicleSubType(savedSubType || (savedType === 'bike' ? 'Standard' : ''));
          setStep('home');
        } else {
          setVehicleType('car');
          setVehicleSubType('Sedan');
          await AsyncStorage.setItem('parkstop_vehicle_type', 'car');
          await AsyncStorage.setItem('parkstop_vehicle_subtype', 'Sedan');
          setStep('home');
        }
      } catch (e) {
        console.log('Failed to load saved vehicle', e);
      }
    })();
  }, []);

  // Instant Nearby Discovery: Disabled to prevent covering the dashboard on load
  // useEffect(() => {
  //   const now = Date.now();
  //   if (userLocation && suggestions.length === 0 && searchQuery === '' && (now - lastNearbyFetch.current > 10000)) {
  //     lastNearbyFetch.current = now;
  //     (async () => {
  //       try {
  //         const res = await apiClient.get(`/maps/search?q=parking&lat=${userLocation.lat}&lon=${userLocation.lng}`);
  //         if (res.data.success) {
  //           setSuggestions(res.data.data.slice(0, 5));
  //         }
  //       } catch (e) {
  //         console.log("Initial nearby fetch failed");
  //       }
  //     })();
  //   }
  // }, [userLocation, searchQuery]);

  const sendChat = async () => {
    if (!chatInput.trim()) return;
    const promptText = chatInput;
    setMessages(m => [...m, { text: promptText, sender: 'user' }]);
    setChatInput('');
    try {
      const res = await apiClient.post('/chatbot/ask', { prompt: promptText });
      if (res.data.success) {
        setMessages(m => [...m, { text: res.data.data.reply, sender: 'bot' }]);
        if (res.data.data.action === 'ROUTE_TO_SPOT') {
          setTimeout(() => {
            setChatOpen(false);
            setStep('spot_booking');
            if (spots.length > 0) {
              setSelectedSpotId(spots[0].id);
              fetchSlots(spots[0].id);
              if (Platform.OS !== 'web') {
                mapRef.current?.animateCamera({
                  center: { latitude: spots[0].lat, longitude: spots[0].lng },
                  zoom: 15,
                  pitch: 0,
                  bearing: 0
                });
              }
            }
          }, 1500);
        }
      }
    } catch (e: any) {
      setMessages(m => [...m, { text: 'Chatbot currently offline. Please use the map to find a spot.', sender: 'bot' }]);
    }
  };

  const lastNearbyFetch = useRef({ t: 0, lat: 0, lng: 0 });
  const spotsLenRef = useRef(0);
  useEffect(() => { spotsLenRef.current = spots.length; }, [spots]);

  const fetchNearbySpots = async (lat: number | string, lon: number | string, radius: number = 10) => {
    // Throttle: identical-area refreshes within 5s are dropped (GPS ticks were
    // spamming this several times per second).
    const nLat = parseFloat(String(lat));
    const nLng = parseFloat(String(lon));
    const now = Date.now();
    const prev = lastNearbyFetch.current;
    const dLat = (nLat - prev.lat) * 110540;
    const dLng = (nLng - prev.lng) * 111320;
    if (now - prev.t < 5000 && Math.sqrt(dLat * dLat + dLng * dLng) < 30) return;
    lastNearbyFetch.current = { t: now, lat: nLat, lng: nLng };

    // Quiet refresh: only show the loading skeleton when there's nothing on
    // screen yet — background refreshes must not blink the list.
    if (spotsLenRef.current === 0) setIsNearbyLoading(true);
    try {
      const res = await apiClient.get(`/spots/nearby?lat=${lat}&lng=${lon}&radius=${radius}`);
      if (res.data.success) {
        setNearbyFetchFailed(false);
        setSpots(res.data.data.map((sp: any) => ({
          id: sp.id.toString(),
          title: sp.title,
          lat: parseFloat(sp.latitude),
          lng: parseFloat(sp.longitude),
          price: parseFloat(sp.price_per_hour),
          available: parseInt(sp.available_slots) > 0,
          available_slots: parseInt(sp.available_slots) || 0,
          distance: sp.distance ? parseFloat(sp.distance).toFixed(1) : undefined,
          location_type: sp.location_type,
          images: Array.isArray(sp.images) ? sp.images : []
        })));
      }
    } catch (e) {
      // Do NOT clear the list here. A rate limit, a timeout, or a moment of bad
      // signal would otherwise wipe every marker and render "No spots found" —
      // a network failure disguised as real data. Keep showing the last known
      // spots; they are far more useful than an empty screen that lies.
      console.log('Nearby spots fetch failed — keeping last known list', e);
      setNearbyFetchFailed(true);
    } finally {
      setIsNearbyLoading(false);
    }
  };

  // Refetch nearby spots the moment connectivity is restored, so the map isn't
  // left showing stale data after an offline stretch.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(ONLINE_EVENT, () => {
      if (userLocation) fetchNearbySpots(userLocation.lat, userLocation.lng);
    });
    return () => sub.remove();
  }, [userLocation]);

  // Step 7: Location Search via Nominatim
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    ignoreNextQueryChange.current = true;
    // Suppress the in-flight debounce as well as clearing what is on screen —
    // otherwise the request already in the air repopulates the list.
    searchSubmitted.current = true;
    setSuggestions([]);
    setSearchFocused(false);
    Keyboard.dismiss();

    // Support searching by Latitude, Longitude (e.g. 37.7749, -122.4194)
    const coordRegex = /^([-+]?\d+(\.\d+)?),\s*([-+]?\d+(\.\d+)?)$/;
    const coordMatch = searchQuery.trim().match(coordRegex);

    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lon = parseFloat(coordMatch[3]);
      const newRegion = {
        latitude: lat,
        longitude: lon,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02,
      };
      if (mapRef.current) {
        mapRef.current.animateCamera({
          center: { latitude: lat, longitude: lon },
          zoom: 11
        }, { duration: 1000 });
      }
      await fetchNearbySpots(lat, lon, 1000);
      setIsSearching(false);
      return;
    }

    try {
      const lat = userLocation?.lat || 0;
      const lon = userLocation?.lng || 0;
      const response = await apiClient.get(`/maps/search?q=${encodeURIComponent(searchQuery)}&lat=${lat}&lon=${lon}`);
      const data = response.data.data;

      if (data && data.length > 0) {
        // Prefer the authoritative CITY match (verified centroid) over any POI
        // so pressing Enter on a city name drops the pin at the city center.
        const top = data.find((d: any) => d.verified) || data[0];
        // Same rule as tapping a suggestion: NEVER use raw autocomplete
        // coordinates (location-biased). Resolve the top result through its
        // place_id; fall back to text geocoding. This was the second search
        // path (Enter key) that kept landing everything in Bangalore.
        let rLat = NaN;
        let rLon = NaN;
        // Resolve the top suggestion by its Ola place_id -> exact coordinate
        // (place-details). This is the accurate, Google-style path.
        if (top.place_id) {
          try {
            const det = await apiClient.get(`/maps/place-details?place_id=${encodeURIComponent(top.place_id)}`);
            if (det.data?.success && det.data.data) {
              rLat = parseFloat(det.data.data.lat);
              rLon = parseFloat(det.data.data.lon);
              console.log(`[Search] (submit) Resolved "${top.display_name}" via place_id -> ${rLat},${rLon}`);
            }
          } catch (err) {
            console.log('[Search] (submit) Place details failed:', (err as any)?.message);
          }
        }
        // Safety net only, if place-details is unavailable: the result's own
        // coordinate when valid, otherwise a plain text geocode.
        if ((isNaN(rLat) || isNaN(rLon) || !rLat || !rLon) && top.lat && top.lon && parseFloat(top.lat) !== 0) {
          rLat = parseFloat(top.lat);
          rLon = parseFloat(top.lon);
        }
        if (isNaN(rLat) || isNaN(rLon) || !rLat || !rLon) {
          try {
            const geo = await apiClient.get(`/maps/geocode?q=${encodeURIComponent(searchQuery)}`);
            if (geo.data?.success && geo.data.data) {
              rLat = parseFloat(geo.data.data.lat);
              rLon = parseFloat(geo.data.data.lon);
              console.log(`[Search] (submit) Resolved "${searchQuery}" via geocode -> ${rLat},${rLon}`);
            }
          } catch (err) {
            console.log('[Search] (submit) Geocode failed:', (err as any)?.message);
          }
        }
        if (isNaN(rLat) || isNaN(rLon) || !rLat || !rLon) {
          throw new Error('No results');
        }

        setSearchedPlace({ lat: rLat, lng: rLon, title: searchQuery });
        setStep('home');
        setIsFollowing(false); // stop following the user so the camera settles on the searched place
        if (mapRef.current) {
          mapRef.current.animateCamera({
            center: { latitude: rLat, longitude: rLon },
            zoom: (top && top.verified) ? 12 : 15
          }, { duration: 1200 });
        }
        await fetchNearbySpots(rLat, rLon, 1000);
        setIsSearching(false);
      } else {
        throw new Error("No results");
      }
    } catch (e) {
      console.log('Search API failed, trying Nominatim fallback...');
      try {
        const nomRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`, {
          headers: { 'User-Agent': 'SmartParkingApp/1.0 (Contact: admin@example.com)' }
        });
        const nomData = await nomRes.json();
        if (nomData && nomData.length > 0) {
          const { lat, lon, display_name } = nomData[0];
          setSearchedPlace({ lat: parseFloat(lat), lng: parseFloat(lon), title: searchQuery });
          setStep('home');
          if (mapRef.current) {
            mapRef.current.animateCamera({
              center: { latitude: parseFloat(lat), longitude: parseFloat(lon) },
              zoom: 13
            }, { duration: 1200 });
          }
          await fetchNearbySpots(parseFloat(lat), parseFloat(lon), 1000);
          setIsSearching(false);
          return;
        }
      } catch (nomErr) {
        console.log("Nominatim fallback failed");
        Alert.alert('Search unavailable', 'Location not found. Please try another search.');
      }
      setIsSearching(false);
    }
  };

  useEffect(() => {
    if (ignoreNextQueryChange.current) {
      ignoreNextQueryChange.current = false;
      return;
    }
    if (searchSubmitted.current) return;
    if (searchQuery.length < 2) {
      setSuggestions([]);
      return;
    }

    // Support searching by Latitude, Longitude (e.g. 37.7749, -122.4194) - don't suggest for coords
    const coordRegex = /^([-+]?\d+(\.\d+)?),\s*([-+]?\d+(\.\d+)?)$/;
    if (searchQuery.match(coordRegex)) {
      setSuggestions([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const lat = userLocation?.lat || 0;
        const lon = userLocation?.lng || 0;
        const response = await apiClient.get(`/maps/search?q=${encodeURIComponent(searchQuery)}&lat=${lat}&lon=${lon}`);
        if (response.data.success) {
          const results = response.data.data.map((item: any) => ({ ...item, isInternal: false }));
          const internalMatches = spots
            .filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase()))
            .map(s => ({
              display_name: s.title,
              lat: s.lat.toString(),
              lon: s.lng.toString(),
              type: 'parking_spot',
              isInternal: true,
              spotId: s.id
            }));
          // Re-checked HERE, not just before scheduling: this callback was
          // queued while the user was still typing, and by the time it
          // resolves they may have submitted. Applying results now would put
          // the dropdown back over the pin they just dropped.
          if (searchSubmitted.current) return;
          setSuggestions([...internalMatches, ...results]);
        }
      } catch (e) {
        console.log("Autocomplete error", e);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  const [recentSearches, setRecentSearches] = useState<any[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);

  // Load recent searches on mount
  useEffect(() => {
    AsyncStorage.getItem('parkstop_recent_searches_v2').then(data => {
      if (data) setRecentSearches(JSON.parse(data));
    }).catch(() => {});
  }, []);

  const saveRecentSearch = async (item: any) => {
    try {
      const existing = recentSearches.filter(r => r.display_name !== item.display_name);
      const updated = [item, ...existing].slice(0, 5);
      setRecentSearches(updated);
      await AsyncStorage.setItem('parkstop_recent_searches_v2', JSON.stringify(updated));
    } catch (e) {}
  };

  const selectSuggestion = async (item: any) => {
    let lat = parseFloat(item.lat);
    let lon = parseFloat(item.lon);
    const name = item.display_name;

    // Google-style resolution: ALWAYS resolve external selections through
    // their place_id via place-details — autocomplete-provided coordinates are
    // unreliable (location-biased, sometimes pointing at nearby lookalikes,
    // e.g. "Mumbai" landing in Bangalore). Only internal parking spots keep
    // their own coordinates. Fallbacks: provided coords, then text geocode.
    if (!item.isInternal) {
      // Exact, canonical resolution — like Google: resolve the place's own id
      // to its precise coordinate; if there's no id, geocode its name through
      // Ola (canonical) rather than trusting the biased autocomplete coordinate.
      let resolved = false;
      // Resolve the selected place by its Ola place_id -> exact coordinate.
      if (item.place_id) {
        try {
          const det = await apiClient.get(`/maps/place-details?place_id=${encodeURIComponent(item.place_id)}`);
          if (det.data?.success && det.data.data) {
            lat = parseFloat(det.data.data.lat);
            lon = parseFloat(det.data.data.lon);
            resolved = true;
            console.log(`[Search] Resolved "${name}" via place_id -> ${lat},${lon}`);
          }
        } catch (e) {
          console.log('[Search] Place details failed:', (e as any)?.message);
        }
      }
      // Safety net only, if place-details is unavailable: the result's own valid
      // coordinate, else a plain text geocode.
      if (!resolved && (!lat || !lon || isNaN(lat) || isNaN(lon))) {
        const geoQuery = (item.address?.name || (name || '').split(',')[0] || name).trim();
        try {
          const geo = await apiClient.get(`/maps/geocode?q=${encodeURIComponent(geoQuery)}`);
          if (geo.data?.success && geo.data.data) {
            lat = parseFloat(geo.data.data.lat);
            lon = parseFloat(geo.data.data.lon);
            console.log(`[Search] Resolved "${geoQuery}" via geocode -> ${lat},${lon}`);
          }
        } catch (e) {
          console.log('[Search] Geocode failed:', (e as any)?.message);
        }
      }
    }

    // If we still don't have a valid location, stop rather than flying to (0,0).
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
      Alert.alert('Location unavailable', 'Could not find the exact location for that place. Please try another search.');
      return;
    }

    saveRecentSearch(item);
    ignoreNextQueryChange.current = true;
    setSearchQuery((item.address?.name || (name || '').split(',')[0] || name).trim());
    setSuggestions([]);
    setIsSearching(false);
    setSearchFocused(false);
    Keyboard.dismiss();

    // First: show the destination pin on the map
    setSearchedPlace({ lat, lng: lon, title: (item.address?.name || (name || '').split(',')[0] || name).trim() });
    setStep('home');
    setIsFollowing(false);
    const isArea = !!item && (item.verified || ['city', 'town', 'village', 'state', 'administrative', 'suburb', 'municipality', 'district', 'county', 'region'].includes(String(item.type || '').toLowerCase()));
    if (mapRef.current) {
      mapRef.current.animateCamera({
        center: { latitude: lat, longitude: lon },
        zoom: isArea ? 12 : 16
      }, { duration: 1200 });
    }
    // Then: fetch all available spots in that area
    await fetchNearbySpots(lat, lon, 1000);
  };

  // "Directions" from the place card: draw the route to the EXACT place the
  // user searched (always accurate) — the nearby parking spots stay listed
  // for booking. No more auto-jumping to a spot that may be far away.
  const handleDirectionsToPlace = async () => {
    if (!searchedPlace || !userLocation) {
      Alert.alert('Location needed', 'We need your current location to show directions.');
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Directions to a searched place is a fresh journey — any route the rider
    // chose for a previous trip is irrelevant and must not hold here.
    userSelectedRoute.current = false;
    try {
      const res = await apiClient.get(`/maps/route?start=${userLocation.lng},${userLocation.lat}&end=${searchedPlace.lng},${searchedPlace.lat}&alternatives=true`);
      if (res.data?.success) {
        const route = pickBestRoute(res.data.data.routes || [], { trustProviderOrder: res.data.provider === 'google' });
        if (route && route.geometry?.coordinates?.length) {
          setRouteCoords(route.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })));
          setDistanceInfo({ km: (route.distance / 1000).toFixed(1), mins: Math.ceil(route.duration / 60).toString() });
          setIsFollowing(false);
          return;
        }
      }
      Alert.alert('No route', 'Could not find a route to that place right now.');
    } catch (e) {
      Alert.alert('Directions failed', 'Could not fetch directions right now. Please try again.');
    }
  };


  /**
   * True while Google's Navigation SDK owns the screen.
   *
   * Requires a selected spot as well as a navigating step: without a
   * destination the SDK has nothing to route to, and mounting NavigationView
   * with a null waypoint gives the rider a live map that never starts guiding
   * and never explains why.
   */
  // ── Pre-warm the route at booking confirmation ───────────────
  //
  // Computing a route is a network round-trip, and it only begins when the
  // destination reaches the SDK. Doing that when the navigation screen opens
  // meant the rider watched a blank banner while Google worked. Sending it at
  // booking confirmation means the route is computed while they finish paying,
  // so guidance appears almost immediately.
  //
  // Confirmation, not spot selection: Navigation SDK bills per destination sent
  // to it, so pre-warming on every spot someone merely looks at would charge
  // for browsing. Here it only ever fires for a booking that is going ahead.
  //
  // Guidance is NOT started — only the route is built.
  const { navigationController: googleNavController } = useGoogleNav();
  useEffect(() => {
    if (step !== 'booking_confirm' || !selectedSpotId) return;
    const spot = spots.find(s => s.id === selectedSpotId);
    if (!spot) return;
    prepareDestination(
      googleNavController,
      { lat: spot.lat, lng: spot.lng, title: spot.title },
      {
        routingOptions: {
          travelMode: TravelMode.TWO_WHEELER,
          avoidFerries: true,
          avoidTolls: false,
        },
        // MUST match GoogleNavigation's options exactly. When the pre-warm
        // succeeds, navigation skips its own setDestination — so anything set
        // only there would silently never apply. That includes Google's red
        // destination pin, which would have gone missing on precisely the
        // journeys this optimisation succeeds on.
        displayOptions: { showDestinationMarkers: true },
      }
    );
  }, [step, selectedSpotId, spots, googleNavController]);

  // NAVIGATION ENDS AT ARRIVAL — including the navigation VIEW.
  //
  // This used to stay true after the rider arrived, so the screen was still
  // Google's NavigationView long after the trip was over. That is the whole
  // reason the arrival screen kept breaking in new ways:
  //
  //   * Guidance had been stopped, so nothing owned the camera any more and no
  //     destination was left to frame — the SDK fell back to lat 0, lng 0,
  //     zoom 0 and showed the rider the Atlantic Ocean.
  //   * Google's own "Re-center" button and navigation chrome stayed on a
  //     screen that is not navigation, which is what made it look scattered.
  //   * Its layout is built for driving (full-bleed map, chrome at both
  //     edges), not for a check-in card.
  //
  // Dropping out of navigation on arrival hands the screen to the browsing
  // map, which already positions its camera on the rider, covers itself until
  // it has done so, and carries no driving chrome. It also lets the app's own
  // GPS watcher resume, which matters because Google stops feeding positions
  // once guidance is stopped.
  const isGoogleNavigating =
    ['en_route', 'navigating', 'arriving'].includes(step) &&
    !!selectedSpotId &&
    !arrivalDetected;

  // Is the arrival card on screen? The back control lives INSIDE that card
  // when it is, so the floating one must stand down — otherwise there are two
  // back buttons a few pixels apart.
  //
  // Deliberately not just `arrivalDetected`: that stays true through
  // active_parking, checkout and payment, and keying off it alone would strip
  // the back button from all of those screens.
  const arrivalCardVisible =
    ['navigating', 'en_route', 'arriving'].includes(step) && !isInPip && arrivalDetected;

  // Mirrored into a ref so the GPS watcher's closure can read it — that
  // callback is created once and never sees updated state.
  useEffect(() => { isGoogleNavRef.current = isGoogleNavigating; }, [isGoogleNavigating]);

  /**
   * Google reports arrival at the booked spot.
   *
   * Deliberately does the same work as the geofence backstop rather than
   * anything new, so there is exactly one definition of "arrived" for the
   * check-in and payment flow to depend on.
   */
  const handleGoogleArrival = useCallback(() => {
    if (arrivalDetected) return;
    setArrivalDetected(true);
    setIsFollowing(false);
    // No speech here: Google announces arrival itself, and speaking over it
    // produced two overlapping voices saying the same thing.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [arrivalDetected]);

  const recenterCamera = () => {
    setIsFollowing(true); // The map component will fly to userLocation automatically when isFollowing=true
  };

  useEffect(() => {
    let pollInterval: any;
    if (['arriving', 'checkout_verification', 'awaiting_owner'].includes(step) && bookingDetails?.id) {
      pollInterval = setInterval(async () => {
        try {
          const res = await apiClient.get('/bookings/my-bookings');
          if (res.data?.success) {
            const currentBooking = res.data.data.find((b: any) => String(b.id) === String(bookingDetails?.id));
            if (currentBooking) {
              if (step === 'arriving' && (currentBooking.status === 'active' || currentBooking.status === 'occupied')) {
                setBookingDetails({ ...bookingDetails, ...currentBooking });
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setStep('active_parking');
                clearInterval(pollInterval);
              } else if ((step === 'checkout_verification' || step === 'awaiting_owner') && currentBooking.status === 'completed') {
                setBookingDetails({ ...bookingDetails, ...currentBooking });
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setStep('payment');
                clearInterval(pollInterval);
              }
            }
          }
        } catch (e) {
          console.log("Error polling booking status", e);
        }
      }, 3000);
    }
    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [step, bookingDetails?.id]);

  // Instant check-in via socket (the 3s poll above is the fallback). When the
  // spotter verifies the entry OTP, the backend emits booking:checkedin to this
  // finder — advance straight to the active session with no wait.
  useEffect(() => {
    if (step !== 'arriving' || !bookingDetails?.id) return;
    const off = onRealtime('booking:checkedin', (b: any) => {
      if (String(b?.id) === String(bookingDetails?.id)) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setBookingDetails((prev: any) => (prev ? { ...prev, ...b } : b));
        setStep('active_parking');
      }
    });
    return () => off();
  }, [step, bookingDetails?.id]);

  // Owner confirmed the checkout -> unlock the payment screen instantly. Until
  // this arrives (or the poll sees 'completed'), the finder waits — payment is
  // strictly gated on the spot owner's confirmation.
  useEffect(() => {
    if (step !== 'awaiting_owner' || !bookingDetails?.id) return;
    const off = onRealtime('booking:checkout_confirmed', (b: any) => {
      if (String(b?.id) === String(bookingDetails?.id)) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setBookingDetails((prev: any) => (prev ? { ...prev, basePrice: b.total_price, finalAmount: b.total_price, ...b } : b));
        setStep('payment');
      }
    });
    return () => off();
  }, [step, bookingDetails?.id]);

  useEffect(() => {
    if (step === 'home' && searchedPlace === null && userLocation) {
      fetchNearbySpots(userLocation.lat, userLocation.lng);
    }
  }, [searchedPlace, step, userLocation]);

  const finishParking = async () => {
    // Left for manual simulation if needed, but the auto-poll handles the actual transition now.
    if (!bookingDetails?.id) return;
    setIsLoading(true);
    try {
      setStep('payment');
    } catch (e) {
      console.log('[finishParking]', e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExtendStay = async () => {
    if (!bookingDetails?.id) return;
    const minutes = Math.round(Number(selectedExtendMinutes));
    if (!Number.isFinite(minutes) || minutes <= 0) {
      Alert.alert('Pick a duration', 'Choose a preset or enter how many minutes to add.');
      return;
    }
    if (minutes > 1440) {
      Alert.alert('Too long', 'You can extend by at most 24 hours at a time.');
      return;
    }
    setIsExtending(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await apiClient.put(`/bookings/${bookingDetails.id}/extend`, {
        additionalMinutes: minutes
      });
      if (res.data.success) {
        Alert.alert("Success", "Stay extended successfully!");
        setBookingDetails(prev => prev ? {
          ...prev,
          hours: res.data.data.hours,
          totalPrice: res.data.data.total_price,
          end_time: res.data.data.end_time,
          updated_at: res.data.data.updated_at
        } : null);
        setExtendModalOpen(false);
      }
    } catch (e: any) {
      const errMsg = e.response?.data?.message || 'Failed to extend booking';
      Alert.alert("Extension Failed", errMsg);
    } finally {
      setIsExtending(false);
    }
  };

  const handleUPIPayment = async (app: 'gpay' | 'phonepe' | 'paytm' | 'upi') => {
    setIsUPIModalVisible(false);
    setIsLoading(true);
    try {
      // First update the payment mode on the backend
      const patchRes = await apiClient.patch(`/bookings/${bookingDetails?.id}/payment-mode`, {
        payment_mode: 'online'
      });

      if (!patchRes.data.success) {
        throw new Error('Failed to update payment mode');
      }

      setBookingDetails(prev => prev ? {
        ...prev,
        payment_mode: 'online'
      } : null);

      const res = await apiClient.post('/payments/checkout', { bookingId: Number(bookingDetails?.id) });
      if (!res.data.success || !res.data.order_id) {
        throw new Error('Failed to initiate secure checkout session');
      }
      
      // Hand off to Razorpay Checkout with UPI preselected.
      //
      // This previously built a RAW peer-to-peer UPI deep link to a hardcoded
      // VPA and then, 3.5s later, told the server the booking was paid using a
      // fake `mock_upi_intent` signature — without checking anything. Money
      // sent that way never touched the Razorpay ORDER, so Razorpay had no
      // record of it and the signature could never be verified. (Confirmed: no
      // UPI payment ever reached the Razorpay dashboard.)
      //
      // Checkout creates a real payment against the order and emits its own
      // upi:// intent, which RazorpayCheckout forwards to GPay/PhonePe/Paytm —
      // so the app-switch feel is preserved — and returns a genuine signature
      // that the backend verifies against order, amount and captured status.
      setRazorpayOrder({
        orderId: res.data.order_id,
        amount: res.data.amount,
        currency: res.data.currency || 'INR',
        keyId: res.data.key_id,
      });
      setPreferUpiCheckout(true);
      setIsRazorpayVisible(true);

    } catch (e: any) {
      Alert.alert('UPI Payment Error', e.message || 'Failed to process UPI payment');
      setIsLoading(false);
      setIsUPIProcessing(false);
    }
  };

  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const processPayment = async () => {
    if (!bookingDetails?.id) return;
    setIsLoading(true);

    try {
      // First update the payment mode on the backend based on user's checkout selection
      const patchRes = await apiClient.patch(`/bookings/${bookingDetails.id}/payment-mode`, {
        payment_mode: selectedPaymentMethod
      });

      if (!patchRes.data.success) {
        throw new Error('Failed to update payment mode');
      }

      setBookingDetails(prev => prev ? {
        ...prev,
        payment_mode: selectedPaymentMethod
      } : null);

      if (selectedPaymentMethod === 'cash') {
        // For cash, just proceed to receipt
        setStep('receipt');
        setIsLoading(false);
        return;
      }

      const res = await apiClient.post('/payments/checkout', { bookingId: Number(bookingDetails.id) });
      if (res.data.success) {
        if (res.data.provider === 'stripe' && res.data.clientSecret) {
          // Stripe flow
          const { error: initError } = await initPaymentSheet({
            merchantDisplayName: 'ParkStop',
            paymentIntentClientSecret: res.data.clientSecret,
            allowsDelayedPaymentMethods: true,
            defaultBillingDetails: {
              name: 'Finder User',
            }
          });

          if (initError) {
            Alert.alert('Payment Setup Error', initError.message);
            setIsLoading(false);
            return;
          }

          const { error: presentError } = await presentPaymentSheet();
          if (presentError) {
            Alert.alert('Payment Cancelled', presentError.message);
            setIsLoading(false);
            return;
          }

          // Verify Stripe Payment
          const paymentIntentId = res.data.clientSecret.split('_secret')[0];
          await apiClient.post('/payments/stripe/verify', {
            bookingId: Number(bookingDetails.id),
            paymentIntentId
          });

          // Proceed to receipt on successful Stripe payment
          setStep('receipt');
          setIsLoading(false);
        } else if (res.data.provider === 'razorpay' && res.data.order_id) {
          // Razorpay flow
          setRazorpayOrder({
            orderId: res.data.order_id,
            amount: res.data.amount, // backend returns amount in paise
            currency: res.data.currency || 'INR',
            keyId: res.data.key_id,
          });
          setIsRazorpayVisible(true);
        } else {
          throw new Error('Unsupported payment provider or missing credentials');
        }
      } else {
        throw new Error('Failed to initiate secure checkout session');
      }
    } catch (e: any) {
      Alert.alert('Payment Error', e.response?.data?.message || e.message || 'Failed to process payment');
      setIsLoading(false);
    }
  };

  const handleRazorpaySuccess = async (data: {
    razorpay_payment_id: string;
    razorpay_order_id: string;
    razorpay_signature: string;
  }) => {
    setIsRazorpayVisible(false);
    setPreferUpiCheckout(false);
    setIsLoading(true);
    try {
      const verification = await razorpayService.verifyPayment({
        bookingId: Number(bookingDetails?.id),
        razorpay_order_id: data.razorpay_order_id,
        razorpay_payment_id: data.razorpay_payment_id,
        razorpay_signature: data.razorpay_signature,
      });

      if (verification.success) {
        setStep('receipt');
      } else {
        Alert.alert('Verification Failed', 'Could not confirm payment signature. Please contact support.');
      }
    } catch (e: any) {
      Alert.alert('Verification Error', e.message || 'Failed to verify payment with server.');
    } finally {
      setIsLoading(false);
      setRazorpayOrder(null);
    }
  };

  const handleRazorpayCancel = () => {
    setIsRazorpayVisible(false);
    setPreferUpiCheckout(false);
    setRazorpayOrder(null);
    Alert.alert('Payment Cancelled', 'You cancelled the payment transaction.');
  };

  const handleRazorpayFailure = (error: string) => {
    setIsRazorpayVisible(false);
    setPreferUpiCheckout(false);
    setRazorpayOrder(null);
    Alert.alert('Payment Failed', error || 'Failed to complete transaction.');
  };

  // ── Cashfree UPI checkout (Easy Split: 80% spotter / 20% ParkStop) ──
  const cashfreeOrderRef = useRef<string | null>(null);

  const handleCashfreePay = async () => {
    if (!bookingDetails?.id) return;
    try {
      setIsLoading(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await apiClient.patch(`/bookings/${bookingDetails.id}/payment-mode`, { payment_mode: 'online' }).catch(() => {});
      cashfreeOrderRef.current = await payBookingWithCashfree(Number(bookingDetails.id));
    } catch (e: any) {
      Alert.alert('Payment Error', e?.response?.data?.message || e?.message || 'Could not start payment');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setCashfreeCallbacks({
      onSuccess: async (orderId: string) => {
        try {
          const paid = await verifyCashfreePayment(orderId, Number(bookingDetails?.id));
          if (paid) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            setStep('receipt');
          } else {
            Alert.alert('Payment pending', 'We could not confirm the payment yet. If money was debited it will reflect shortly.');
          }
        } catch (e: any) {
          Alert.alert('Verification error', e?.response?.data?.message || e?.message || 'Could not verify payment');
        }
      },
      onError: (msg: string) => {
        Alert.alert('Payment failed', msg);
      },
    });
    return () => removeCashfreeCallbacks();
  }, [bookingDetails?.id]);

  const isBottomPanelFull = ['arriving', 'active_parking', 'payment', 'receipt'].includes(step);
  // Route is visible during spot preview (the "blue line" when a spot is
  // selected), booking, and ALL navigation phases including final approach.
  const showRoute = ['spot_booking', 'booking_confirm', 'home', 'navigating', 'en_route', 'arriving'].includes(step);

  // The un-driven remainder of the route. Memoised because this slice copies
  // the whole coordinate array, and it sat inline in JSX — so it reallocated on
  // EVERY render of this (very large) screen, including the many renders that
  // have nothing to do with the route. Now it only rebuilds when the route or
  // the driver's progress along it actually changes.
  const visibleRouteCoords = useMemo(
    () => (showRoute
      ? routeCoords.slice(Math.min(currentRouteIndex, Math.max(0, routeCoords.length - 2)))
      : []),
    [showRoute, routeCoords, currentRouteIndex]
  );

  // A brand new route starts un-driven. Without this, progress from the
  // previous route would carry over and chop the head off the new one.
  useEffect(() => {
    setCurrentRouteIndex(0);
  }, [routeCoords]);

  // Consume the route behind the driver.
  //
  // `currentRouteIndex` existed and was read by visibleRouteCoords above, but
  // NOTHING ever advanced it — setCurrentRouteIndex was declared and never
  // called. So the index sat at 0 and the full line stayed drawn, including the
  // stretch already driven, which is why the blue route trailed behind instead
  // of being eaten up as you moved.
  useEffect(() => {
    if (!showRoute || !userLocation || routeCoords.length < 2) return;

    // Only scan a window AHEAD of the current position. A route can be many
    // thousands of points, this runs on every GPS tick, and a driver only ever
    // moves forward along it — so a full scan would be wasted work and could
    // also snap backwards where a route loops near itself.
    const WINDOW = 150;
    const start = Math.min(currentRouteIndex, routeCoords.length - 1);
    const end = Math.min(routeCoords.length - 1, start + WINDOW);

    // Metres per degree of longitude shrinks with latitude; without the cosine
    // term the nearest-point search skews east-west and picks the wrong vertex.
    const mPerLng = 111320 * Math.cos((userLocation.lat * Math.PI) / 180);

    let bestIdx = start;
    let bestSq = Infinity;
    for (let i = start; i <= end; i++) {
      const p = routeCoords[i];
      const dy = (p.latitude - userLocation.lat) * 110540;
      const dx = (p.longitude - userLocation.lng) * mPerLng;
      const sq = dy * dy + dx * dx;
      if (sq < bestSq) { bestSq = sq; bestIdx = i; }
    }

    // Monotonic: only ever move forward. GPS jitter must not un-consume road
    // the driver has already covered.
    if (bestIdx > currentRouteIndex) setCurrentRouteIndex(bestIdx);
  }, [userLocation, routeCoords, showRoute, currentRouteIndex]);

  // Removed welcome auto-transition


  // Fetch slot data when a spot is selected
  const fetchSlots = async (spotId: string) => {
    setIsSlotLoading(true);
    setSlotLoadError(false);
    setSlotData([]);
    try {
      const res = await apiClient.get(`/spots/${spotId}/slots`);
      if (res.data.success) setSlotData(res.data.data);
    } catch (err) {
      console.log("Fetch slots error:", err); // handled below
      setSlotData([]);
      // Distinguish "offline, couldn't load" from "genuinely no slots".
      if (isNetworkError(err)) setSlotLoadError(true);
    } finally {
      setIsSlotLoading(false);
    }
  };

  // If the slot picker failed while offline, auto-retry once connectivity returns.
  useOnlineRefresh(() => { if (selectedSpotId && slotLoadError) fetchSlots(selectedSpotId); });
  const handleCreateBooking = async (method: 'online' | 'cash') => {
    if (!selectedSpotId) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIsLoading(true);
    setSearchedPlace(null);
    setShowPaymentMethodModal(false);
    try {
      // The rider picked a window, so send that window. This used to send
      // `now` as the start regardless of what they chose, which is why the
      // start time was never really theirs to set.
      if (bookingWindowError) {
        Alert.alert('Check the times', bookingWindowError);
        setIsLoading(false);
        return;
      }
      if (isLongParking && longStayDays <= 0) {
        Alert.alert('How long?', 'Choose how many days you need the spot for.');
        setIsLoading(false);
        return;
      }

      // Pay-at-spot is settled in person, so the server refuses it beyond an
      // hour's lead. Say so here rather than letting the request fail.
      if (method === 'cash' && bookingStart.getTime() - Date.now() > 3600000) {
        Alert.alert(
          'Pay at spot is for soon-ish bookings',
          'Booking this far ahead needs online payment. Change the arrival time, or pay online.'
        );
        setIsLoading(false);
        return;
      }

      const start = bookingStart;
      const end = bookingEnd;

      const res = await apiClient.post('/bookings', {
        spot_id: parseInt(selectedSpotId, 10),
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        slot_name: selectedSlot,
        vehicle_type: vehicleType,
        vehicle_subtype: vehicleSubType,
        payment_mode: method
      });
      if (res.data.success) {
        setSearchedPlace(null);
        setBookingDetails({
          id: res.data.data.id.toString(),
          otp: res.data.data.otp_code.toString(),
          totalPrice: res.data.data.total_price,
          checkoutOtp: res.data.data.checkout_otp,
          created_at: res.data.data.created_at || new Date().toISOString(),
          start_time: res.data.data.start_time || new Date().toISOString(),
          payment_mode: res.data.data.payment_mode || method
        });
        setStep('booking_confirm');
      }
    } catch (e: any) { 
      const errMsg = e.response?.data?.message || 'Error';
      if (errMsg.toLowerCase().includes('slots') || errMsg.toLowerCase().includes('full')) {
        Alert.alert('Booking Failed', 'This parking spot is currently full and cannot be booked right now.');
      } else if (errMsg.toLowerCase().includes('balance') || errMsg.toLowerCase().includes('dues')) {
        Alert.alert('Spot Unavailable', 'This spot is temporarily unavailable.');
      } else {
        Alert.alert('Booking Failed', errMsg);
      }
    }
    finally { setIsLoading(false); }
  };

  // ONE back action, used by both the floating control and the copy that sits
  // inside the arrival card. Extracted rather than duplicated: this decides
  // what 'back' means for every step of the flow, and two drifting copies of
  // that is how a back button quietly stops tearing navigation down properly.
  const handleBackPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (step === 'home' && searchedPlace !== null) {
      setSearchedPlace(null);
      setSearchQuery('');
    } else if (['en_route', 'navigating', 'arriving'].includes(step)) {
      Alert.alert('Exit Navigation', 'Are you sure you want to exit navigation?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Yes, Exit', onPress: () => {
            setStep('home');
            setSelectedSpotId(null);
            setRouteCoords([]);
            setSimulatedLocation(null);
            setArrivalDetected(false);
            setCurrentInstruction({ turn: '', street: '', icon: '' });
            setTrafficSegments([]);
            setSpeedLimit(null);
            setLaneGuidance([]);
            if (userLocation) {
              fetchNearbySpots(userLocation.lat, userLocation.lng);
              if (mapRef.current) {
        mapRef.current.animateCamera({
          center: { latitude: userLocation.lat, longitude: userLocation.lng },
          zoom: 15
        }, { duration: 1000 });
              }
            }
          }
        }
      ]);
    } else if (['spot_booking', 'booking_confirm'].includes(step)) {
      setStep('home');
      setSelectedSpotId(null);
      setSlotData([]);
    } else if (step === 'active_parking') {
      // Stay on active parking — use End Session button
    } else if (step === 'checkout_verification') {
      setStep('active_parking');
    } else if (step === 'payment') {
      setStep('checkout_verification');
    } else {
      setStep('home');
    }
  };

  return (
    <SafeAreaView style={[BlueprintTheme.container, { backgroundColor: '#000' }]} edges={['top']}>
      


      {/* STARTING DIRECTLY AT VEHICLE SELECTION */}

      {/* STEP 2: VEHICLE SELECTION */}
      {step === 'vehicle_select' && (
        <LinearGradient colors={['#0f172a', '#1e1b4b']} style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '900', textAlign: 'center', marginBottom: 8, letterSpacing: -0.5 }}>What are you parking?</Text>
          <Text style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', marginBottom: 32, fontWeight: '500' }}>Tailoring the experience for your ride</Text>

          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
            {[
              { key: 'bike', icon: '🏍️', label: 'Two-Wheeler' },
              { key: 'car', icon: '🚗', label: 'Car' },
            ].map(v => (
              <TouchableOpacity
                key={v.key}
                activeOpacity={0.8}
                style={{
                  flex: 1, backgroundColor: vehicleType === v.key ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                  padding: 18, borderRadius: 20, alignItems: 'center',
                  borderWidth: 2, borderColor: vehicleType === v.key ? '#6366f1' : 'rgba(255,255,255,0.08)',
                }}
                onPress={() => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setVehicleType(v.key);
                  if (v.key === 'bike') setVehicleSubType('Standard');
                  else setVehicleSubType(''); 
                }}
              >
                <Text style={{ fontSize: 32, marginBottom: 8 }}>{v.icon}</Text>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>{v.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {vehicleType === 'car' && (
            <View style={{ marginBottom: 20 }}>
              <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '700', marginBottom: 12, textAlign: 'center', letterSpacing: 1.2 }}>SELECT CAR CATEGORY</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                {[
                  { label: 'Sedan', image: require('../../assets/images/vehicles/sedan.jpg') },
                  { label: 'SUV', image: require('../../assets/images/vehicles/suv.jpg') },
                  { label: 'Hatchback', image: require('../../assets/images/vehicles/hatchback.jpg') },
                  { label: 'Minivan', image: require('../../assets/images/vehicles/minivan.jpg') },
                ].map(t => (
                  <TouchableOpacity
                    key={t.label}
                    activeOpacity={0.7}
                    style={{
                      width: '47%', backgroundColor: vehicleSubType === t.label ? 'rgba(99,102,241,0.12)' : 'rgba(255,255,255,0.02)',
                      padding: 12, borderRadius: 16, alignItems: 'center',
                      borderWidth: 1.5, borderColor: vehicleSubType === t.label ? '#6366f1' : 'rgba(255,255,255,0.05)'
                    }}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setVehicleSubType(t.label);
                    }}
                  >
                    <Image source={t.image} style={{ width: 60, height: 32, marginBottom: 6, opacity: vehicleSubType === t.label ? 1 : 0.6 }} resizeMode="contain" />
                    <Text style={{ color: vehicleSubType === t.label ? '#fff' : '#94a3b8', fontWeight: '800', fontSize: 12 }}>{t.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {(vehicleType === 'bike' || (vehicleType === 'car' && vehicleSubType !== '')) && (
            <TouchableOpacity
              activeOpacity={0.9}
              style={{ 
                backgroundColor: '#6366f1', 
                paddingVertical: 16, borderRadius: 20, 
                alignItems: 'center', marginTop: 10,
              }}
              onPress={() => {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                AsyncStorage.setItem('parkstop_vehicle_type', vehicleType);
                AsyncStorage.setItem('parkstop_vehicle_subtype', vehicleSubType);
                setStep('home');
              }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Confirm Selection</Text>
            </TouchableOpacity>
          )}
        </LinearGradient>
      )}

      {/* STEP 3: HOME — MAP WITH NEARBY BOTTOM SHEET */}
      {step === 'home' && (
        <View style={{ flex: 1, backgroundColor: 'transparent' }} pointerEvents="box-none">
          {/* Search Bar */}
          <View style={{ position: 'absolute', top: Platform.OS === 'ios' ? 20 : 12, left: 16, right: 16, zIndex: 100 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#1E293B', borderRadius: 20, paddingHorizontal: 16, height: 52, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.15)', shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 15, elevation: 12 }}>
              <Ionicons name="search" size={18} color="#94a3b8" style={{ marginRight: 10 }} />
              <TextInput
                style={{ flex: 1, color: '#fff', fontSize: 15, fontWeight: '600' }}
                placeholder="Search for a destination..."
                placeholderTextColor="#94a3b8"
                value={searchQuery}
                onChangeText={(t) => {
                  // Typing means they are searching again, so suggestions are
                  // wanted once more.
                  searchSubmitted.current = false;
                  setSearchQuery(t);
                }}
                onSubmitEditing={handleSearch}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                returnKeyType="search"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => { searchSubmitted.current = false; setSearchQuery(''); setSuggestions([]); setSearchedPlace(null); setSearchFocused(false); }} style={{ padding: 6, marginRight: 6 }}>
                  <Text style={{ color: '#94a3b8', fontSize: 16 }}>✕</Text>
                </TouchableOpacity>
              )}
              {isSearching && <ActivityIndicator size="small" color="#6366f1" style={{ marginRight: 10 }} />}

              <View style={{ marginRight: 6 }}><NotificationBell color="#94a3b8" size={20} audience="finder" /></View>

              {/* Subtle Sign Out Button in Search Bar */}
              <TouchableOpacity 
                onPress={async () => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                  Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
                    { text: 'Cancel', style: 'cancel' },
                    { 
                      text: 'Sign Out', 
                      style: 'destructive',
                      onPress: async () => {
                        try { await apiClient.post('/auth/logout', { push_token: getCurrentPushToken() }); } catch(e) {}
                        await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role', 'is_dual_user']);
                        try {
                          const { auth } = require('../../services/firebase');
                          await auth.signOut();
                        } catch (err) {}
                        router.replace('/login');
                      }
                    }
                  ]);
                }}
                style={{ padding: 6, borderLeftWidth: 1, borderLeftColor: 'rgba(255,255,255,0.1)', paddingLeft: 12, marginLeft: 6 }}
              >
                <Ionicons name="log-out-outline" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {/* Search Suggestions / Recent Searches */}
            {(suggestions.length > 0 || (searchFocused && searchQuery.length === 0 && recentSearches.length > 0)) && (
              <View style={{ backgroundColor: '#0f172a', borderRadius: 20, paddingVertical: 8, marginTop: 8, maxHeight: 300, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, elevation: 20 }}>
                {searchQuery.length === 0 && recentSearches.length > 0 && suggestions.length === 0 && (
                  <View style={{ paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: '#64748b', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 }}>RECENT</Text>
                    <TouchableOpacity onPress={async () => { setRecentSearches([]); await AsyncStorage.removeItem('parkstop_recent_searches_v2'); }}>
                      <Text style={{ color: '#4285F4', fontSize: 12, fontWeight: '700' }}>Clear</Text>
                    </TouchableOpacity>
                  </View>
                )}
                <ScrollView style={{ maxHeight: 280 }} keyboardShouldPersistTaps="handled">
                  {(suggestions.length > 0 ? suggestions : recentSearches).map((item, idx) => {
                    const isInternal = item.isInternal;
                    const isRecent = suggestions.length === 0;
                    const distKm = item.distance != null && isFinite(item.distance) ? item.distance : null;
                    return (
                      <TouchableOpacity
                        key={idx}
                        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)' }}
                        onPress={() => selectSuggestion(item)}
                      >
                        <View style={{ width: 36, height: 36, backgroundColor: isInternal ? 'rgba(66,133,244,0.15)' : 'rgba(255,255,255,0.05)', borderRadius: 12, justifyContent: 'center', alignItems: 'center', marginRight: 12 }}>
                          <Ionicons name={isRecent ? 'time-outline' : isInternal ? 'car-outline' : 'location-outline'} size={18} color={isInternal ? '#4285F4' : '#94a3b8'} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }} numberOfLines={1}>{item.display_name?.split(',')[0] || item.display_name}</Text>
                          <Text style={{ color: '#64748b', fontSize: 12, marginTop: 2 }} numberOfLines={1}>{item.display_name}</Text>
                        </View>
                        {distKm !== null && (
                          <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '700', marginLeft: 8 }}>
                            {distKm < 1 ? `${Math.round(distKm * 1000)}m` : `${distKm.toFixed(1)}km`}
                          </Text>
                        )}
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            )}
          </View>

          {/* Google-style place card — after a place is selected, before a
              spot is chosen. Directions routes to the nearest parking (Option B). */}
          {searchedPlace && !selectedSpotId && suggestions.length === 0 && (
            <View style={{ position: 'absolute', top: Platform.OS === 'ios' ? 82 : 74, left: 16, right: 16, zIndex: 95, backgroundColor: '#0f172a', borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 16, elevation: 12 }}>
              <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(234,67,53,0.12)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                <Ionicons name="location" size={20} color="#EA4335" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }} numberOfLines={1}>{searchedPlace.title}</Text>
                <Text style={{ color: '#94a3b8', fontSize: 12, marginTop: 2 }} numberOfLines={1}>
                  {(() => {
                    let d = '';
                    if (userLocation) {
                      const R = 6371;
                      const dLat = (searchedPlace.lat - userLocation.lat) * Math.PI / 180;
                      const dLng = (searchedPlace.lng - userLocation.lng) * Math.PI / 180;
                      const a = Math.sin(dLat / 2) ** 2 + Math.cos(userLocation.lat * Math.PI / 180) * Math.cos(searchedPlace.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
                      const km = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
                      d = km < 1 ? `${Math.round(km * 1000)} m away` : `${km.toFixed(1)} km away`;
                    }
                    const open = spots.filter((s: any) => s.available);
                    // Cheapest rate in the area — the number someone searching
                    // a neighbourhood actually wants, alongside how many spots
                    // there are.
                    const cheapest = open.length
                      ? Math.min(...open.map((s: any) => Number(s.price) || 0))
                      : null;
                    const spotText = open.length
                      ? `${open.length} spot${open.length > 1 ? 's' : ''}${cheapest != null ? ` · from ₹${cheapest}/hr` : ''}`
                      : 'no parking here yet';
                    return [d, spotText].filter(Boolean).join(' • ');
                  })()}
                </Text>
              </View>
              {/* No Directions button.
                *
                * Searching a neighbourhood is a question about parking, not a
                * request to be driven to the middle of it. Routing to the
                * area's centre point sends the rider somewhere no spot exists,
                * and it is not what they asked for. Directions belong to a
                * chosen spot, which the list below provides. */}
              <View style={{ backgroundColor: 'rgba(26,115,232,0.15)', borderRadius: 22, paddingHorizontal: 14, paddingVertical: 8, marginLeft: 8 }}>
                <Text style={{ color: '#60a5fa', fontSize: 12, fontWeight: '800' }}>
                  {spots.filter((s: any) => s.available).length > 0 ? 'Pick a spot' : '—'}
                </Text>
              </View>
            </View>
          )}
          {/* Nearby Spots Bottom Sheet */}
          <View style={{ 
            position: 'absolute', bottom: 0, left: 0, right: 0, 
            maxHeight: '45%', backgroundColor: '#0f172a', 
            borderTopLeftRadius: 28, borderTopRightRadius: 28, 
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', 
            shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, 
            elevation: 20, zIndex: 50 
          }}>
            <View style={{ width: 40, height: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 2, alignSelf: 'center', marginTop: 12, marginBottom: 8 }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12, justifyContent: 'space-between' }}>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>Nearby Spots</Text>
                {vehicleType ? (
                  <View style={{ backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={{ fontSize: 11 }}>{vehicleType === 'bike' ? '🏍️' : '🚗'}</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '800' }}>{vehicleSubType || (vehicleType === 'bike' ? 'Bike' : 'Car')}</Text>
                  </View>
                ) : null}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981', marginRight: 6 }} />
                <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '700' }}>{spots.filter(s => s.available).length} available</Text>
              </View>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={{ paddingHorizontal: 16 }}>
              {isNearbyLoading ? (
                [1, 2, 3].map(idx => (
                  <View key={idx} style={{ backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 20, padding: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)' }}>
                    <SkeletonCard width={42} height={42} style={{ borderRadius: 14, marginRight: 12 }} />
                    <View style={{ flex: 1, gap: 6 }}>
                      <SkeletonCard width="75%" height={14} style={{ borderRadius: 7 }} />
                      <SkeletonCard width="45%" height={10} style={{ borderRadius: 5 }} />
                    </View>
                  </View>
                ))
              ) : spots.length > 0 ? (
                spots.map(spot => (
                  <TouchableOpacity
                    key={spot.id}
                    activeOpacity={0.8}
                    style={{ backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 20, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)', flexDirection: 'row', alignItems: 'center' }}
                    onPress={() => {
                      if (!spot.available) {
                        Alert.alert('Spot Full', 'This parking spot is currently full.');
                        return;
                      }
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                      setSelectedSpotId(spot.id);
                      setStep('spot_booking');
                      fetchSlots(spot.id);
                      if (mapRef.current) {
                        mapRef.current.animateCamera({ center: { latitude: spot.lat, longitude: spot.lng }, zoom: 17 }, { duration: 1000 });
                      }
                    }}
                  >
                    <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: 'rgba(99,102,241,0.08)', alignItems: 'center', justifyContent: 'center', marginRight: 12, borderWidth: 1, borderColor: 'rgba(99,102,241,0.1)' }}>
                      <Ionicons name="navigate-circle" size={22} color="#6366f1" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '900', marginBottom: 2 }}>{spot.title}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ color: '#10b981', fontWeight: '800', fontSize: 12 }}>₹{spot.price}<Text style={{ fontSize: 10, color: '#64748b' }}>/hr</Text></Text>
                        <View style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.15)', marginHorizontal: 6 }} />
                        <Ionicons name="location-outline" size={11} color="#94a3b8" style={{ marginRight: 2 }} />
                        <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '600' }}>{spot.distance} km</Text>
                      </View>
                    </View>
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      <View style={{ backgroundColor: (spot.available_slots ?? 0) > 0 ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1, borderColor: (spot.available_slots ?? 0) > 0 ? 'rgba(16,185,129,0.2)' : 'rgba(244,63,94,0.2)' }}>
                        <Text style={{ color: (spot.available_slots ?? 0) > 0 ? '#10b981' : '#f43f5e', fontWeight: '900', fontSize: 8, textTransform: 'uppercase' }}>
                          {(spot.available_slots ?? 0) > 0 ? 'Open' : 'Full'}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.15)" />
                    </View>
                  </TouchableOpacity>
                ))
              ) : (
                <View style={{ alignItems: 'center', paddingVertical: 30 }}>
                  {nearbyFetchFailed ? (
                    <>
                      <Ionicons name="cloud-offline-outline" size={30} color="#94a3b8" style={{ marginBottom: 8 }} />
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Couldn&apos;t load spots</Text>
                      <Text style={{ color: '#64748b', marginTop: 4, fontSize: 13, textAlign: 'center' }}>
                        Check your connection — this doesn&apos;t mean there are none nearby.
                      </Text>
                      <TouchableOpacity
                        onPress={() => { if (userLocation) fetchNearbySpots(userLocation.lat, userLocation.lng); }}
                        style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: 'rgba(66,133,244,0.18)', borderWidth: 1, borderColor: 'rgba(66,133,244,0.4)' }}
                        accessibilityRole="button"
                        accessibilityLabel="Retry loading nearby spots"
                      >
                        <Text style={{ color: '#4285F4', fontWeight: '800', fontSize: 12 }}>Try again</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <Text style={{ fontSize: 32, marginBottom: 8 }}>😕</Text>
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>No spots found</Text>
                      <Text style={{ color: '#64748b', marginTop: 4, fontSize: 13 }}>Try searching a different area</Text>
                    </>
                  )}
                </View>
              )}
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>

          {resumableBooking && !selectedSpotId && (
            <View style={{ position: 'absolute', bottom: 300, left: 20, right: 20, zIndex: 100, padding: 14, backgroundColor: 'rgba(15,23,42,0.96)', borderRadius: 18, borderWidth: 1, borderColor: 'rgba(66,133,244,0.35)', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Ionicons name="time-outline" size={22} color="#4285F4" />
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Booking in progress</Text>
                <Text style={{ color: '#94a3b8', fontSize: 12 }} numberOfLines={1}>{resumableBooking.parking_spots?.title}</Text>
              </View>
              <TouchableOpacity onPress={resumeBooking} style={{ backgroundColor: '#4285F4', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>Resume</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setResumableBooking(null)} style={{ padding: 6 }}>
                <Ionicons name="close" size={18} color="#94a3b8" />
              </TouchableOpacity>
            </View>
          )}
          {!hasLocationPermission && (
            <View style={{ position: 'absolute', bottom: 120, left: 20, right: 20, zIndex: 100, padding: 16, backgroundColor: 'rgba(239, 68, 68, 0.08)', borderRadius: 20, borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.2)', alignItems: 'center' }}>
              <Ionicons name="warning" size={24} color="#ef4444" style={{ marginBottom: 8 }} />
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800', marginBottom: 4 }}>Location is off</Text>
              <Text style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 10, textAlign: 'center' }}>Turn on location to see nearby parking and navigate.</Text>
              <TouchableOpacity onPress={handleEnableLocation} style={{ backgroundColor: '#ef4444', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 11 }}>Enable Location</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Permission is granted but the DEVICE's location toggle is off.
              Previously this state showed no banner at all — the user sat on a
              country-wide map with nothing to tap. Re-prompting for permission
              is useless here; only the OS location settings can fix it. */}
          {hasLocationPermission && locationServicesOff && !userLocation && (
            <View style={{ position: 'absolute', bottom: 120, left: 20, right: 20, zIndex: 100, padding: 16, backgroundColor: 'rgba(245, 158, 11, 0.08)', borderRadius: 20, borderWidth: 1, borderColor: 'rgba(245, 158, 11, 0.25)', alignItems: 'center' }}>
              <Ionicons name="location-outline" size={24} color="#f59e0b" style={{ marginBottom: 8 }} />
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800', marginBottom: 4 }}>Location services are off</Text>
              <Text style={{ color: '#cbd5e1', fontSize: 11, marginBottom: 10, textAlign: 'center' }}>
                ParkStop has permission, but your device&apos;s location is switched off.
              </Text>
              <TouchableOpacity
                onPress={openLocationSettings}
                style={{ backgroundColor: '#f59e0b', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}
                accessibilityRole="button"
                accessibilityLabel="Open device location settings"
              >
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 11 }}>Turn On Location</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Map Rendering Container */}
      {!['welcome', 'vehicle_select'].includes(step) && (
        <View
          style={styles.fullMapContainer}
          pointerEvents="auto"
        >
          {isGoogleNavigating ? (
            /* Google's own navigation owns the whole surface while guiding.
             * It is not an overlay on our map — it IS the map, with Google's
             * camera, chevron, turn cards, voice, lane guidance and rerouting.
             * Our map is unmounted underneath so two map surfaces are never
             * alive at once. */
            <GoogleNavigation
              destination={
                (() => {
                  const s = selectedSpotId ? spots.find((x) => x.id === selectedSpotId) : null;
                  return s ? { lat: s.lat, lng: s.lng, title: s.title } : null;
                })()
              }
              muted={isMuted}
              /* Speed for the trip sheet, replacing Google's own dial.
               *
               * navigationData.speed is already gated on a usable GPS fix and
               * a clearly-moving speed, so it reads exactly 0 while parked.
               * Google's speedometer had no such filter and sat at 10–20 km/h
               * on a stationary vehicle. */
              speedKmh={navigationData.speed * 3.6}
              /* The X on the trip sheet. Google's own footer cannot host a
               * control, so GoogleNavigation draws that sheet itself and this
               * is what its close button calls. */
              onExit={handleBackPress}
              /* ARRIVAL, from Google's own routing engine.
               *
               * This is a better signal than the geofence below it: that
               * compares two GPS points and needs a fix to arrive, so a rider
               * who has already stopped produces nothing and we fall back to a
               * timer. This number comes from the routing engine tracking the
               * route itself, and it keeps updating on approach — so the Check
               * In card appears as soon as Google says the spot is reached,
               * rather than after a confirmation wait.
               *
               * 25m rather than 0: the destination is a spot's centre point,
               * and a rider parked at it is metres away, not on top of it. */
              onRemaining={(meters) => {
                if (arrivalDetected) return;
                if (meters > 0 && meters <= 25) {
                  if (arrivalTimer.current) {
                    clearTimeout(arrivalTimer.current);
                    arrivalTimer.current = null;
                  }
                  handleGoogleArrival();
                }
              }}
              onArrive={handleGoogleArrival}
              /* Google's fixes are road-snapped, so this is a BETTER position
               * than our own watcher produced — it is where the rider actually
               * is on the road, not a raw sample that drifts against buildings.
               * Feeding it back keeps bookings and distance current while our
               * watcher is paused. */
              onLocation={(loc) => {
                setUserLocation(loc);

                // ARRIVAL BACKSTOP, on Google's own road-snapped fixes.
                //
                // Stopping our GPS watcher during guidance also removed the
                // geofence that used to detect arrival, leaving Google's event
                // as the only path. That event is the better detector, but it
                // has never fired in production and arrival gates check-in,
                // which gates payment — not a single point of failure worth
                // accepting while the SDK is still Beta.
                //
                // This costs nothing: it reuses positions Google is already
                // sending us, so there is no second GPS consumer and none of
                // the drift that caused.
                const spot = selectedSpotId ? spots.find(x => x.id === selectedSpotId) : null;
                if (!spot || arrivalDetected) return;
                const dLat = (loc.lat - spot.lat) * 110540;
                const dLng = (loc.lng - spot.lng) * 111320 * Math.cos((loc.lat * Math.PI) / 180);
                const metres = Math.sqrt(dLat * dLat + dLng * dLng);
                // Two consecutive fixes inside 30m, OR one fix and a short
                // wait.
                //
                // "Two consecutive fixes" alone had a hole that swallowed
                // check-in entirely: location updates are driven by MOVEMENT,
                // and a rider who has just parked stops moving. The first fix
                // inside the radius arrives, the second never does, the counter
                // sits at 1 forever — and because arrival gates check-in, which
                // gates payment, the whole booking stalls on a screen with no
                // button on it. That is exactly the "no Check In button" case.
                //
                // So the second fix is now only the FAST path. Once inside the
                // radius a timer also runs, and standing still for a few
                // seconds counts as arriving — which is, after all, what
                // parking is. Leaving the radius cancels it, so a rider merely
                // passing the spot still does not check in.
                if (metres <= 30) {
                  googleArrivalHits.current += 1;
                  // 10m is inside GPS's own margin of error — at that range the
                  // rider IS at the spot, so waiting for confirmation only adds
                  // a delay before the Check In card appears. This is the case
                  // that should feel instant, and normally is: the last fix
                  // before someone stops is the one that lands here.
                  if (metres <= 10 || googleArrivalHits.current >= 2) {
                    if (arrivalTimer.current) { clearTimeout(arrivalTimer.current); arrivalTimer.current = null; }
                    handleGoogleArrival();
                  } else if (!arrivalTimer.current) {
                    // 10-30m out, on a single fix. Short dwell rather than a
                    // long one: if they are driving past, the next fix lands
                    // outside 30m and cancels this; if they have parked, no
                    // further fix is coming and this is what confirms it.
                    //
                    // Deliberately not shorter. Arrival now also ENDS guidance,
                    // so firing it early would cut navigation off mid-approach
                    // — the cost of being wrong is much higher than a 2.5s wait.
                    arrivalTimer.current = setTimeout(() => {
                      arrivalTimer.current = null;
                      handleGoogleArrival();
                    }, 2500);
                  }
                } else {
                  googleArrivalHits.current = 0;
                  if (arrivalTimer.current) { clearTimeout(arrivalTimer.current); arrivalTimer.current = null; }
                }
              }}
              /* No onExit: the app's own back control (repositioned above
               * Google's footer during guidance) already owns leaving
               * navigation, including the confirmation prompt and the full
               * teardown of booking state. A second exit button was both
               * visual clutter and a second, weaker cleanup path. */
            />
          ) : (
          <MapLibreView
            ref={mapRef}
            viewportHint={viewportHint}
            markers={spots}
            routeCoords={visibleRouteCoords}
            altRoutes={showRoute ? altRoutes : []}
            onSelectAltRoute={(index: number) => {
              const alt = altRoutes[index];
              if (alt) {
                setRouteCoords(alt.coords);
                setDistanceInfo({ km: (alt.distance / 1000).toFixed(1), mins: Math.ceil(alt.duration / 60).toString() });
                setAltRoutes([]);

                // Everything derived from the OLD route has to go with it.
                // Previously only the line was swapped, so the discarded
                // route's traffic overlay stayed painted on the map (the
                // leftover marks) and its turn list kept driving the
                // instruction card.
                routeStepsRef.current = alt.steps || [];
                setTrafficSegments(
                  (alt.steps || [])
                    .filter((s: any) => s.geometry?.coordinates?.length >= 2)
                    .map((s: any) => ({ coords: s.geometry.coordinates, congestion: 'low' as const }))
                );
                setLaneGuidance([]);

                // This is a deliberate choice, not a suggestion — hold it.
                userSelectedRoute.current = true;
              }
            }}
            destination={(() => {
              if (selectedSpotId) {
                const s = spots.find(x => x.id === selectedSpotId);
                if (s) return { lat: s.lat, lng: s.lng };
              }
              if (showRoute && routeCoords && routeCoords.length > 0) {
                const last = routeCoords[routeCoords.length - 1];
                return { lat: last.latitude, lng: last.longitude };
              }
              return null;
            })()}
            distanceInfo={distanceInfo}
            searchedPlace={searchedPlace ?? null}
            onRecenter={recenterCamera}
            controlsBottomOffset={['spot_booking', 'booking_confirm'].includes(step) ? 470 : 260}
            isMuted={isMuted}
            onMapPress={(coords: [number, number]) => {
              fetchNearbySpots(coords[1], coords[0]);
            }}
            nextInstruction={currentInstruction.turn}
            speed={navigationData.speed}
            heading={['en_route', 'navigating', 'arriving'].includes(step) ? navigationData.heading : deviceHeading}
            userLocation={(simulatedLocation || userLocation) || undefined}
            locationAccuracy={locationAccuracy}
            isFollowing={isFollowing}
            onMapInteraction={() => setIsFollowing(false)}
            isActiveNavigation={['en_route', 'navigating', 'arriving'].includes(step)}
            trafficSegments={['en_route', 'navigating'].includes(step) ? trafficSegments : []}
            speedLimit={['en_route', 'navigating'].includes(step) ? speedLimit : null}
            mapStyleUrl={mapStyleConfig.provider === 'ola' ? mapStyleConfig.styleUrl : undefined}
            mapApiKey={mapStyleConfig.provider === 'ola' ? mapStyleConfig.apiKey : undefined}
            onMuteToggle={() => setIsMuted(!isMuted)}
            onOffRoute={(lat: number, lng: number) => {
              const now = Date.now();
              if (now - lastRerouteTime.current < 10000) return; // 10s cooldown
              lastRerouteTime.current = now;
              const dest = selectedSpotId ? spots.find(s => s.id === selectedSpotId) : null;
              if (!dest) return;

              // Claim the shared route-fetch state so the MAIN route effect
              // stands down. Both paths hit /maps/route independently, and the
              // server logs showed them firing a second apart from slightly
              // different origins — two routes racing, each overwriting the
              // other's geometry. That is what made the arrow jump around and
              // the line redraw mid-turn.
              lastRouteFetch.current = now;
              lastRouteFetchPos.current = { lat, lng };

              // The rider has left the route they picked, so that choice no
              // longer applies — otherwise the hold would block the reroute
              // and strand them on a line they are not driving.
              userSelectedRoute.current = false;

              console.log(`[NAV] Off-route detected at ${lat},${lng} — rerouting...`);
              // Google detects going off-route and announces its own reroute.
              if (!isMuted && !isGoogleNavRef.current) Speech.speak(navLanguage === 'hi-IN' ? 'Naya raasta dhundh rahe hain' : 'Rerouting', { rate: 1.1, pitch: 1.0, language: navLanguage });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              (async () => {
                try {
                  // Rerouting after going off-route: ask for candidates so the
                  // recovery route is also the shortest sensible one, rather
                  // than whatever the provider happens to return first.
                  const res = await apiClient.get(`/maps/route?start=${lng},${lat}&end=${dest.lng},${dest.lat}&alternatives=true`);
                  if (res.data.success) {
                    const route = pickBestRoute(res.data.data.routes || [], { trustProviderOrder: res.data.provider === 'google' });
                    if (route) {
                      setRouteCoords(route.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })));
                      setDistanceInfo({ km: (route.distance / 1000).toFixed(1), mins: Math.ceil(route.duration / 60).toString() });
                      if (route.legs?.[0]?.steps) routeStepsRef.current = route.legs[0].steps;
                      // Show the FIRST turn of the new route immediately rather
                      // than a placeholder. The old code blanked the banner to
                      // "Route updated" with an empty street, which the UI
                      // renders as "Calculating..." — and if step-matching then
                      // failed to produce anything, that placeholder stuck on
                      // screen for the rest of the drive with no instruction.
                      const firstStep = route.legs?.[0]?.steps?.[0];
                      if (firstStep?.maneuver) {
                        const { action, icon } = parseManeuver(firstStep);
                        const d = firstStep.distance || 0;
                        const distText = d < 50
                          ? 'Now'
                          : d < 1000
                            ? `${Math.round(d / 10) * 10} m`
                            : `${(d / 1000).toFixed(1)} km`;
                        const nm = firstStep.name || '';
                        setCurrentInstruction({
                          turn: action,
                          street: nm ? (distText === 'Now' ? nm : `${distText} · ${nm}`) : distText,
                          icon,
                        });
                      } else {
                        setCurrentInstruction({ turn: 'Route updated', street: '', icon: '🔄' });
                      }
                      setNextTurnPreview({ turn: '', icon: '' });
                      setIsFollowing(true);
                      console.log(`[NAV] Rerouted! ${route.geometry.coordinates.length} points`);
                    } else {
                      // Server answered but gave us nothing usable — treat it
                      // as a failure so the cooldown is released and we retry.
                      throw new Error('reroute returned no usable route');
                    }
                  } else {
                    throw new Error('reroute request unsuccessful');
                  }
                } catch (e) {
                  console.warn('[NAV] Reroute failed — will retry on next fix', e);
                  // Release the cooldown. It was claimed BEFORE the request, so
                  // leaving it set after a failure would strand the driver on a
                  // stale route for a further 10s — and if the failures persist
                  // (a network drop, or the 429 storm), they would never get a
                  // new route at all. Back off briefly instead of fully.
                  lastRerouteTime.current = Date.now() - 8000;
                }
              })();
            }}
            onMarkerPress={(id: string) => {
              const spot = spots.find(s => s.id === id);
              if (spot && !spot.available) {
                Alert.alert('Spot Full', 'This parking spot is currently full.');
                return;
              }
              setIsFollowing(false);
              setSelectedSpotId(id);
              fetchSlots(id);
              setStep('spot_booking');
              if (spot && mapRef.current) {
                // Center slightly BELOW the spot so the destination pin sits in
                // the upper half of the screen, above the half-height panel.
                mapRef.current.animateCamera({
                  center: { latitude: spot.lat - 0.0012, longitude: spot.lng },
                  zoom: 17
                }, { duration: 1000 });
              }
            }}
            onExit={() => {
              setStep('home');
              setSelectedSpotId(null);
              setSearchedPlace(null);
              setRouteCoords([]);
              setAltRoutes([]);
              setDistanceInfo({ km: '0', mins: '0' });
              setTrafficSegments([]);
              setSpeedLimit(null);
              setLaneGuidance([]);
              if (userLocation && mapRef.current) {
                mapRef.current.animateCamera({
                  center: { latitude: userLocation.lat, longitude: userLocation.lng },
                  zoom: 14
                });
              }
            }}
            hideControls={['spot_booking'].includes(step)}
          />
          )}

          {/* Floating OTP Badge — only on arrival, not during navigation */}
        </View>
      )}

      {/* Google Maps Style Instruction Banner */}

      {/* FLOATING BACK/HOME BUTTON — rendered AFTER map so it sits on top of WebView */}
      {/* NOT DURING GUIDANCE.
        *
        * Google Maps has no floating back arrow while navigating, and this was
        * the only ParkStop element on that screen — so it was also the only
        * thing making it look like something other than Google Maps.
        *
        * It also had nowhere safe to live. Google's chrome CHANGES SIZE as you
        * drive: a one-line instruction, a two-line one, and a "Then" card for
        * the following turn all stack downward from the top. Any fixed offset
        * is either too low (an obvious hole under a one-line banner) or too
        * high (sitting on top of the "Then" card, which is what happened). The
        * SDK exposes no way to ask how tall its header currently is, so there
        * is no offset that is correct in every frame.
        *
        * Exit is unaffected: the hardware back button already prompts
        * "Exit Navigation" and tears the trip down, which is exactly how
        * Google Maps behaves. */}
      {['spot_booking', 'en_route', 'navigating', 'arriving', 'booking_confirm', 'active_parking', 'checkout_verification', 'awaiting_owner', 'payment'].includes(step) && !arrivalCardVisible && !isGoogleNavigating && (
        <TouchableOpacity
          style={{
            position: 'absolute',
            // During guidance this sits in the empty right-hand end of Google's
            // header, beside the turn instruction — where a rider looking at
            // the instruction will already be looking. At the bottom it was
            // both far from the eye's focus and sitting on top of the street
            // name label.
            // BELOW Google's instruction block, not on it. Placing it top-right
            // put it directly over the road name — "Chikkaballapur Rd" was
            // partly hidden behind it, obscuring the one word that tells the
            // rider where they are being sent. Google keeps that whole banner
            // clear of controls for the same reason.
            //
            // ONCE ARRIVED, BACK TO THE TOP. Arrival stops guidance, so
            // Google's instruction banner is gone and the top-left is empty —
            // while this button, still parked at the mid-screen offset that
            // cleared that banner, ended up sitting on the corner of the
            // "You have arrived" card. Low is only correct while there is
            // something above it to avoid.
            //
            // Measured from the real status bar rather than a hard-coded
            // guess, so it lands the same distance under Google's banner on
            // any phone. 132 clears the primary instruction card; the old
            // fixed 196 was tuned to clear a two-line banner as well and left
            // an obvious hole between the banner and this button on the far
            // more common one-line case.
            ...(isGoogleNavigating && !arrivalDetected
              ? { top: insets.top + 132, left: 16 }
              : { top: insets.top + 8, left: 16 }),
            zIndex: 99999,
            // A white circular control on the map, matching Google's own
            // floating buttons, now that it sits on the map rather than on the
            // banner.
            backgroundColor: isGoogleNavigating ? '#ffffff' : 'rgba(15,23,42,0.95)',
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1.5,
            borderColor: 'rgba(255,255,255,0.2)',
            shadowColor: '#000',
            shadowOpacity: 0.5,
            shadowRadius: 10,
            elevation: 50,
          }}
          onPress={handleBackPress}
        >
          {/* Dark glyph on the white navigation button, white on the dark one
              used elsewhere — otherwise the arrow disappears into its own
              background during guidance. */}
          <Ionicons name="arrow-back" size={22} color={isGoogleNavigating ? '#3c4043' : '#fff'} />
        </TouchableOpacity>
      )}
      {/* Directions Banner / Arrival Banner
       *
       * During Google navigation only the ARRIVAL banner survives. Google draws
       * its own turn card, street name, lane guidance, distance and ETA, so
       * ours stacked on top of theirs — two instruction cards saying the same
       * thing, with Google's partially hidden behind ours.
       *
       * The arrival banner stays because it is not navigation: it carries
       * ParkStop's check-in, which gates the booking and the payment. */}
      {['navigating', 'en_route', 'arriving'].includes(step) && !isInPip &&
       (arrivalDetected || !isGoogleNavigating) && (
        arrivalDetected ? (
          /* ── Arrival banner with Check In button ── */
          <View style={{ position: 'absolute', top: insets.top + 8, left: 16, right: 16, backgroundColor: '#0f172a', borderRadius: 24, padding: 20, alignItems: 'center', shadowColor: '#10b981', shadowOpacity: 0.4, shadowRadius: 20, zIndex: 1000, borderWidth: 1.5, borderColor: 'rgba(16,185,129,0.4)' }}>
            {/* Back, ON the card rather than floating over the map beside it.
                A control with nothing to belong to reads as debris; sitting in
                the card's own corner it reads as part of the card. */}
            <TouchableOpacity
              onPress={handleBackPress}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ position: 'absolute', top: 12, left: 12, width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.07)' }}
            >
              <Ionicons name="arrow-back" size={19} color="#94a3b8" />
            </TouchableOpacity>
            <Text style={{ fontSize: 28, marginBottom: 8 }}>🎉</Text>
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900', marginBottom: 4 }}>You have arrived!</Text>
            <Text style={{ color: '#94a3b8', fontSize: 13, fontWeight: '500', marginBottom: 16 }} numberOfLines={1}>{spots.find(s => s.id === selectedSpotId)?.title || 'Parking Spot'}</Text>
            <TouchableOpacity
              activeOpacity={0.8}
              style={{ backgroundColor: '#10b981', paddingVertical: 16, borderRadius: 18, alignItems: 'center', width: '100%' }}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); setStep('arriving'); }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Check In</Text>
            </TouchableOpacity>
          </View>
        ) : (
          /* ── Turn-by-turn directions banner ── */
          <View style={{ position: 'absolute', top: 50, left: 16, right: 16, backgroundColor: '#1E293B', borderRadius: 24, padding: 16, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 20, zIndex: 1000, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ width: 52, height: 52, backgroundColor: '#1a73e8', borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
                <Text style={{ fontSize: 28 }}>{currentInstruction.icon || '⬆️'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }} numberOfLines={1}>{currentInstruction.turn || 'Head straight'}</Text>
                <Text style={{ color: '#94a3b8', fontSize: 13, fontWeight: '600', marginTop: 3 }} numberOfLines={1}>{currentInstruction.street || 'Calculating...'}</Text>
              </View>
            </View>
            {/* Lane guidance arrows */}
            {laneGuidance.length > 0 ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)', gap: 4 }}>
                {laneGuidance.map((lane, li) => {
                  const arrow = lane.indications?.includes('left') ? '←'
                    : lane.indications?.includes('slight_left') ? '↖'
                    : lane.indications?.includes('sharp_left') ? '↰'
                    : lane.indications?.includes('right') ? '→'
                    : lane.indications?.includes('slight_right') ? '↗'
                    : lane.indications?.includes('sharp_right') ? '↱'
                    : lane.indications?.includes('uturn') ? '↩'
                    : '↑';
                  return (
                    <View key={li} style={{
                      width: 28, height: 28, borderRadius: 6,
                      backgroundColor: lane.valid ? 'rgba(66,133,244,0.25)' : 'rgba(255,255,255,0.06)',
                      borderWidth: lane.valid ? 1.5 : 1,
                      borderColor: lane.valid ? '#4285F4' : 'rgba(255,255,255,0.1)',
                      alignItems: 'center', justifyContent: 'center'
                    }}>
                      <Text style={{ fontSize: 14, color: lane.valid ? '#4285F4' : '#64748b', fontWeight: '800' }}>{arrow}</Text>
                    </View>
                  );
                })}
              </View>
            ) : null}
            {/* Next-turn preview strip */}
            {nextTurnPreview.turn ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingTop: 10, paddingBottom: 2, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' }}>
                <Text style={{ fontSize: 16, marginRight: 8 }}>{nextTurnPreview.icon}</Text>
                <Text style={{ color: '#94a3b8', fontSize: 13, fontWeight: '700' }}>{nextTurnPreview.turn}</Text>
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: nextTurnPreview.turn ? 8 : 12, paddingTop: nextTurnPreview.turn ? 8 : 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)' }}>
              <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                  <Text style={{ color: '#10b981', fontSize: 16, fontWeight: '900' }}>{distanceInfo.km}</Text>
                  <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '700' }}>km</Text>
                </View>
                <View style={{ width: 1, height: 16, backgroundColor: 'rgba(255,255,255,0.08)' }} />
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{distanceInfo.mins}</Text>
                  <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '700' }}>min</Text>
                </View>
              </View>
              <TouchableOpacity
                onPress={() => {
                  const langs = ['en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'kn-IN'];
                  const idx = langs.indexOf(navLanguage);
                  setNavLanguage(langs[(idx + 1) % langs.length]);
                }}
                style={{ width: 36, height: 36, backgroundColor: navLanguage !== 'en-IN' ? 'rgba(66,133,244,0.2)' : 'rgba(255,255,255,0.06)', borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 8, borderWidth: navLanguage !== 'en-IN' ? 1 : 0, borderColor: '#4285F4' }}
              >
                <Text style={{ color: navLanguage !== 'en-IN' ? '#4285F4' : '#94a3b8', fontSize: 10, fontWeight: '900' }}>
                  {navLanguage === 'hi-IN' ? 'हि' : navLanguage === 'ta-IN' ? 'த' : navLanguage === 'te-IN' ? 'తె' : navLanguage === 'kn-IN' ? 'ಕ' : 'EN'}
                </Text>
              </TouchableOpacity>
              <View style={{ width: 44, height: 44, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '900' }}>{Math.round(navigationData.speed * 3.6)}</Text>
                <Text style={{ color: '#64748b', fontSize: 7, fontWeight: '800' }}>km/h</Text>
              </View>
            </View>
          </View>
        )
      )}

      {/* STEP 5: SPOT BOOKING BOTTOM SHEET */}
      {step === 'spot_booking' && (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '50%', backgroundColor: '#0f172a', borderTopLeftRadius: 28, borderTopRightRadius: 28, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 30, elevation: 20, zIndex: 1000, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
          <ScrollView showsVerticalScrollIndicator={false} style={{ padding: 20, paddingBottom: 32 }} bounces={false}>
            <View style={{ width: 40, height: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 2, alignSelf: 'center', marginBottom: 20 }} />

            {/* Spot Header */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: -0.5 }}>{spots.find(s => s.id === selectedSpotId)?.title}</Text>
                <Text style={{ color: '#94a3b8', fontSize: 13, marginTop: 4, fontWeight: '500' }}>Safe & monitored area</Text>
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity 
                  onPress={() => { setStep('home'); setSelectedSpotId(null); setSlotData([]); setSelectedSlot(''); }} 
                  style={{ backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Spot Images Carousel */}
            {(() => {
              const currentSpot = spots.find(s => s.id === selectedSpotId);
              if (currentSpot?.images && currentSpot.images.length > 0) {
                return (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexDirection: 'row', marginBottom: 16 }} contentContainerStyle={{ gap: 12 }}>
                    {currentSpot.images.map((img: string, idx: number) => (
                      <View key={idx} style={{ width: 140, height: 90, borderRadius: 14, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
                        <Image source={{ uri: img }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                      </View>
                    ))}
                  </ScrollView>
                );
              }
              return null;
            })()}

            {/* Spot Info Card */}
            <View style={{ backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 20, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)' }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <View>
                  <Text style={{ color: '#64748b', fontWeight: '700', fontSize: 10, textTransform: 'uppercase' }}>Hourly Rate</Text>
                  <Text style={{ color: '#fff', fontWeight: '900', fontSize: 18, marginTop: 2 }}>₹{spots.find(s => s.id === selectedSpotId)?.price}<Text style={{ fontSize: 11, color: '#94a3b8', fontWeight: '500' }}> / hr</Text></Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: '#64748b', fontWeight: '700', fontSize: 10, textTransform: 'uppercase' }}>Availability</Text>
                  <Text style={{ color: '#10b981', fontWeight: '900', fontSize: 18, marginTop: 2 }}>{spots.find(s => s.id === selectedSpotId)?.available_slots} Bay(s)</Text>
                </View>
              </View>
            </View>

            {/* Slot Selection */}
            <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '800', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Pick a Slot</Text>
            {isSlotLoading ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16, justifyContent: 'center' }}>
                {[1, 2, 3, 4, 5, 6].map(idx => (
                  <SkeletonCard key={idx} width="30%" height={60} style={{ borderRadius: 14 }} />
                ))}
              </View>
            ) : slotData.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
                {slotData.map(slot => {
                  const isAvailable = slot.status === 'available';
                  const isSelected = selectedSlot === slot.name;
                  return (
                    <TouchableOpacity
                      key={slot.name}
                      disabled={!isAvailable}
                      activeOpacity={0.8}
                      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSelectedSlot(slot.name); }}
                      style={{
                        width: '30%', height: 60,
                        backgroundColor: isSelected ? 'rgba(99,102,241,0.15)' : (isAvailable ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)'),
                        borderRadius: 14, alignItems: 'center', justifyContent: 'center',
                        borderWidth: 2, borderColor: isSelected ? '#6366f1' : (isAvailable ? 'rgba(255,255,255,0.08)' : 'transparent'),
                        opacity: isAvailable ? 1 : 0.4
                      }}
                    >
                      <Text style={{ color: isAvailable ? '#64748b' : '#475569', fontSize: 9, fontWeight: '800', marginBottom: 2 }}>SLOT</Text>
                      <Text style={{ color: isAvailable ? '#fff' : '#475569', fontSize: 16, fontWeight: '900' }}>{slot.name.split('_').pop()}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : slotLoadError ? (
              <View style={{ alignItems: 'center', paddingVertical: 20, paddingHorizontal: 16, marginBottom: 16, gap: 6 }}>
                <Ionicons name="cloud-offline-outline" size={26} color="#f59e0b" />
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>You're offline</Text>
                <Text style={{ color: '#94a3b8', fontSize: 12, textAlign: 'center' }}>Couldn't load slots. Check your connection.</Text>
                <TouchableOpacity
                  onPress={() => { if (selectedSpotId) fetchSlots(selectedSpotId); }}
                  activeOpacity={0.8}
                  style={{ marginTop: 6, paddingVertical: 8, paddingHorizontal: 20, borderRadius: 12, backgroundColor: 'rgba(245,158,11,0.15)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.4)' }}
                >
                  <Text style={{ color: '#f59e0b', fontWeight: '800', fontSize: 13 }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={{ alignItems: 'center', padding: 20, marginBottom: 16 }}>
                <Text style={{ color: '#94a3b8', fontSize: 13, fontWeight: '700' }}>No slots available</Text>
              </View>
            )}

            {/* Vehicle Type Selection (inline) */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '800', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Vehicle Type</Text>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: vehicleType === 'car' ? 12 : 0 }}>
                {[
                  { key: 'bike', icon: '🏍️', label: 'Two-Wheeler' },
                  { key: 'car', icon: '🚗', label: 'Car' },
                ].map(v => (
                  <TouchableOpacity
                    key={v.key}
                    activeOpacity={0.8}
                    style={{
                      flex: 1, backgroundColor: vehicleType === v.key ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                      paddingVertical: 12, borderRadius: 14, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 6,
                      borderWidth: 2, borderColor: vehicleType === v.key ? '#6366f1' : 'rgba(255,255,255,0.08)',
                    }}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setVehicleType(v.key);
                      if (v.key === 'bike') setVehicleSubType('Standard');
                      else setVehicleSubType('');
                      AsyncStorage.setItem('parkstop_vehicle_type', v.key);
                      if (v.key === 'bike') AsyncStorage.setItem('parkstop_vehicle_subtype', 'Standard');
                    }}
                  >
                    <Text style={{ fontSize: 18 }}>{v.icon}</Text>
                    <Text style={{ color: vehicleType === v.key ? '#fff' : '#94a3b8', fontSize: 13, fontWeight: '800' }}>{v.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {vehicleType === 'car' && (
                <View>
                  <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Car Category</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {[
                      { label: 'Sedan', image: require('../../assets/images/vehicles/sedan.jpg') },
                      { label: 'SUV', image: require('../../assets/images/vehicles/suv.jpg') },
                      { label: 'Hatchback', image: require('../../assets/images/vehicles/hatchback.jpg') },
                      { label: 'Minivan', image: require('../../assets/images/vehicles/minivan.jpg') },
                    ].map(t => (
                      <TouchableOpacity
                        key={t.label}
                        activeOpacity={0.7}
                        style={{
                          flex: 1, minWidth: '22%', backgroundColor: vehicleSubType === t.label ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                          paddingVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                          borderWidth: 1.5, borderColor: vehicleSubType === t.label ? '#6366f1' : 'rgba(255,255,255,0.06)'
                        }}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setVehicleSubType(t.label);
                          AsyncStorage.setItem('parkstop_vehicle_subtype', t.label);
                        }}
                      >
                        <Image source={t.image} style={{ width: 40, height: 20, marginBottom: 4, opacity: vehicleSubType === t.label ? 1 : 0.6 }} resizeMode="contain" />
                        <Text style={{ color: vehicleSubType === t.label ? '#fff' : '#94a3b8', fontWeight: '800', fontSize: 9 }}>{t.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              )}
            </View>

            {/* Duration Selection */}
            <View style={{ marginBottom: 16 }}>
              <View style={{ flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 3, marginBottom: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
                <TouchableOpacity 
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 9, backgroundColor: !isLongParking ? '#6366f1' : 'transparent', alignItems: 'center' }}
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsLongParking(false); }}
                >
                  <Text style={{ color: !isLongParking ? '#fff' : '#94a3b8', fontWeight: '900', fontSize: 12 }}>Pick Times</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 9, backgroundColor: isLongParking ? '#6366f1' : 'transparent', alignItems: 'center' }}
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsLongParking(true); }}
                >
                  <Text style={{ color: isLongParking ? '#fff' : '#94a3b8', fontWeight: '900', fontSize: 12 }}>Long Stay</Text>
                </TouchableOpacity>
              </View>

              {/* ── Pick Times ───────────────────────────────────────────────
                * Replaces the old hour/minute preset chips. A rider books a
                * window, not an abstract length: "2pm to 6pm" is the thing they
                * actually know, and the duration follows from it. The presets
                * also could not express a start time at all, which is why every
                * booking used to begin the moment you tapped Book.
                *
                * parkingHours / parkingMinutes are still derived and kept in
                * sync, because pricing, the active-session card and the booking
                * request all read them. */}
              {!isLongParking && (
                <View style={{ marginBottom: 16 }}>
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    {([
                      { key: 'start', label: 'Arriving', value: bookingStart },
                      { key: 'end', label: 'Leaving', value: bookingEnd },
                    ] as const).map(f => (
                      <TouchableOpacity
                        key={f.key}
                        activeOpacity={0.75}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setTimePickerFor(f.key);
                        }}
                        style={{
                          flex: 1,
                          backgroundColor: 'rgba(255,255,255,0.03)',
                          borderWidth: 1.5,
                          borderColor: timePickerFor === f.key ? '#6366f1' : 'rgba(255,255,255,0.08)',
                          borderRadius: 14,
                          paddingVertical: 12,
                          paddingHorizontal: 14,
                        }}
                      >
                        <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', marginBottom: 4 }}>
                          {f.label}
                        </Text>
                        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>
                          {fmtClock(f.value)}
                        </Text>
                        <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '700', marginTop: 2 }}>
                          {fmtDayLabel(f.value)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  {/* The derived length, so the rider can sanity-check the
                    * window they just picked without doing the arithmetic. */}
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                    <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>Duration</Text>
                    <Text style={{ color: bookingWindowError ? '#f87171' : '#22d3ee', fontSize: 14, fontWeight: '900' }}>
                      {bookingWindowError || `${parkingHours}h ${parkingMinutes.toString().padStart(2, '0')}m`}
                    </Text>
                  </View>

                  {/* Advance-booking fee, shown BEFORE payment rather than
                    * appearing as a surprise on the receipt. The threshold and
                    * amount mirror the server's BookingRefundPolicy — if you
                    * change one, change the other. */}
                  {advanceFee > 0 && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                      <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>
                        Advance booking fee
                      </Text>
                      <Text style={{ color: '#fbbf24', fontSize: 13, fontWeight: '900' }}>+₹{advanceFee}</Text>
                    </View>
                  )}

                  {/* Scrolling wheel rather than the platform picker. Android's
                    * draws a clock face in the system theme — a light grey
                    * dialog on a dark app, with a dial you have to aim at. */}
                  <WheelTimePicker
                    visible={timePickerFor !== null}
                    title={timePickerFor === 'end' ? 'Leaving (IST)' : 'Arriving (IST)'}
                    /* IST wall-clock, so the wheel shows the same hour the
                     * spot owner will be standing there for. */
                    value={toIstWall(timePickerFor === 'end' ? bookingEnd : bookingStart)}
                    onCancel={() => setTimePickerFor(null)}
                    onConfirm={(picked) => {
                      const which = timePickerFor;
                      setTimePickerFor(null);
                      if (which === 'start') applyStartTime(picked);
                      else if (which === 'end') applyEndTime(picked);
                    }}
                  />
                </View>
              )}

              {/* ── Long Stay ────────────────────────────────────────────────
                * A number of days rather than a typed DD-MM-YYYY end date. The
                * old field accepted anything and silently produced NaN on a
                * mistyped date, which then priced the booking at zero. */}
              {isLongParking && (
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ color: '#64748b', marginBottom: 8, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' }}>How many days?</Text>
                  <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                    {[1, 2, 3, 7, 15, 30].map(d => (
                      <TouchableOpacity
                        key={d}
                        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); applyLongStayDays(d); }}
                        style={{
                          flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center',
                          backgroundColor: longStayDays === d ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                          borderWidth: 2, borderColor: longStayDays === d ? '#6366f1' : 'rgba(255,255,255,0.08)',
                        }}
                      >
                        <Text style={{ color: '#fff', fontWeight: '900', fontSize: 13 }}>{d}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput
                    style={{ backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', padding: 14, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', fontSize: 15, fontWeight: '600' }}
                    placeholder="Or type the number of days"
                    placeholderTextColor="#475569"
                    keyboardType="numeric"
                    value={longStayDays ? String(longStayDays) : ''}
                    onChangeText={(v) => {
                      const n = parseInt(v.replace(/[^0-9]/g, ''), 10);
                      applyLongStayDays(Number.isFinite(n) && n > 0 ? Math.min(n, 90) : 0);
                    }}
                  />
                  {longStayDays > 0 && (
                    <Text style={{ color: '#64748b', fontSize: 12, fontWeight: '700', marginTop: 10 }}>
                      {fmtClock(bookingStart)} {fmtDayLabel(bookingStart)} → {fmtClock(bookingEnd)} {fmtDayLabel(bookingEnd)}
                    </Text>
                  )}
                </View>
              )}

            </View>

            {/* Price + Confirm */}
            <View style={{ marginTop: 16 }}>
              <View style={{ backgroundColor: 'rgba(16,185,129,0.05)', padding: 14, borderRadius: 20, marginBottom: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(16,185,129,0.1)' }}>
                <View>
                  <Text style={{ color: '#10b981', fontSize: 10, fontWeight: '900', textTransform: 'uppercase' }}>Total Price</Text>
                  {isCalculatingPrice ? (
                    <ActivityIndicator size="small" color="#10b981" style={{ marginTop: 4, alignSelf: 'flex-start' }} />
                  ) : (
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginTop: 2 }}>
                      ₹{calculatedPrice !== null ? calculatedPrice.toFixed(2) : (isLongParking ? '---' : ((parkingHours + (parkingMinutes / 60)) * (spots.find(s => s.id === selectedSpotId)?.price || 0)).toFixed(2))}
                    </Text>
                  )}
                </View>
                <View style={{ padding: 8, backgroundColor: 'rgba(16,185,129,0.1)', borderRadius: 10 }}>
                  <Text style={{ fontSize: 18 }}>💸</Text>
                </View>
              </View>

              <TouchableOpacity 
                activeOpacity={0.9}
                style={{ backgroundColor: selectedSlot ? '#6366f1' : 'rgba(99,102,241,0.4)', paddingVertical: 16, borderRadius: 18, alignItems: 'center', marginBottom: 20 }} 
                onPress={() => {
                  if (!selectedSlot) {
                    Alert.alert('Select a Slot', 'Please select a parking slot before confirming.');
                    return;
                  }
                  if (!vehicleType) {
                    Alert.alert('Select Vehicle', 'Please select your vehicle type (Car or Two-Wheeler) before booking.');
                    return;
                  }
                  if (vehicleType === 'car' && !vehicleSubType) {
                    Alert.alert('Select Car Category', 'Please select your car category (Sedan, SUV, etc.).');
                    return;
                  }
                  if (!selectedSpotId) return;
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  handleCreateBooking('online');
                }}
              >
                <Text style={{ color: selectedSlot ? '#fff' : 'rgba(255,255,255,0.6)', fontSize: 16, fontWeight: '900' }}>
                  {isLoading ? 'Reserving...' : 'Confirm Reservation'}
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      )}

      {/* STEPS 4b onward: Map-based overlays */}
      {!['welcome', 'vehicle_select', 'home', 'spot_booking'].includes(step) && (
        <>

          {/* Hidden while Google is guiding: this sheet sits across the bottom
            * and would bury Google's own ETA / distance / arrival-time footer.
            * It returns the moment arrival is detected, because from then on it
            * is carrying check-in rather than trip information. */}
          {step === 'en_route' && !isInPip && (arrivalDetected || !isGoogleNavigating) && (
            <>

              <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#0f172a', borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingBottom: 40, paddingTop: 20, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 30, elevation: 30, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
                <View style={{ width: 48, height: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, alignSelf: 'center', marginBottom: 20 }} />
                
                {arrivalDetected ? (
                  <View style={{ paddingHorizontal: 24 }}>
                    {/* Spot name */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(16,185,129,0.12)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                        <Ionicons name="location" size={18} color="#10b981" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }} numberOfLines={1}>{spots.find(s => s.id === selectedSpotId)?.title || 'Parking Spot'}</Text>
                        <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '500', marginTop: 2 }}>Slot {selectedSlot?.split('_').pop() || '—'} · Booking #{bookingDetails?.id}</Text>
                      </View>
                    </View>

                    {/* PIN */}
                    <View style={{ backgroundColor: 'rgba(16,185,129,0.06)', paddingVertical: 16, paddingHorizontal: 20, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(16,185,129,0.15)', marginBottom: 16, alignItems: 'center' }}>
                      <Text style={{ fontSize: 9, color: '#10b981', fontWeight: '800', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 1.5 }}>Check-in PIN</Text>
                      <Text selectable={true} style={{ fontSize: 32, fontWeight: '900', color: '#fff', letterSpacing: 6 }}>{bookingDetails?.otp}</Text>
                    </View>

                    {/* Check In + Close */}
                    <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
                      <TouchableOpacity
                        activeOpacity={0.8}
                        style={{ flex: 1, backgroundColor: '#10b981', paddingVertical: 16, borderRadius: 18, alignItems: 'center', shadowColor: '#10b981', shadowOpacity: 0.3, shadowRadius: 10, elevation: 5 }}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          setStep('arriving');
                        }}
                      >
                        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Check In</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        activeOpacity={0.8}
                        style={{ backgroundColor: 'rgba(255,255,255,0.05)', paddingHorizontal: 20, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setStep('home');
                          setSelectedSpotId(null);
                          setRouteCoords([]);
                          setSimulatedLocation(null);
                          setArrivalDetected(false);
                          setCurrentInstruction({ turn: '', street: '', icon: '' });
                          if (userLocation) {
                            fetchNearbySpots(userLocation.lat, userLocation.lng);
                            if (mapRef.current) {
                              mapRef.current.animateCamera({
                                center: { latitude: userLocation.lat, longitude: userLocation.lng },
                                zoom: 15
                              }, { duration: 1000 });
                            }
                          }
                        }}
                      >
                        <Ionicons name="close" size={24} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  </View>
                ) : (
                  <>
                    {/* Destination info */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 16 }}>
                      <View style={{ width: 36, height: 36, borderRadius: 10, backgroundColor: 'rgba(99,102,241,0.12)', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                        <Ionicons name="navigate" size={18} color="#818cf8" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }} numberOfLines={1}>{spots.find(s => s.id === selectedSpotId)?.title || 'Destination'}</Text>
                        <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '500', marginTop: 1 }}>Slot {selectedSlot?.split('_').pop() || '—'}</Text>
                      </View>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', paddingHorizontal: 20 }}>
                      <View style={{ alignItems: 'center' }}>
                        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '900' }}>{distanceInfo.km}</Text>
                        <Text style={{ color: '#64748b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase', marginTop: 2 }}>km</Text>
                      </View>
                      <View style={{ width: 1, height: 40, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                      <View style={{ alignItems: 'center' }}>
                        <Text style={{ color: '#10b981', fontSize: 28, fontWeight: '900' }}>{distanceInfo.mins}</Text>
                        <Text style={{ color: '#64748b', fontSize: 12, fontWeight: '800', textTransform: 'uppercase', marginTop: 2 }}>min</Text>
                      </View>
                      <View style={{ width: 1, height: 40, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                      <TouchableOpacity
                        activeOpacity={0.8}
                        style={{ backgroundColor: '#f43f5e', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 16, shadowColor: '#f43f5e', shadowOpacity: 0.2, shadowRadius: 10 }}
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          Alert.alert('Exit Navigation', 'Are you sure you want to stop navigating?', [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Yes, Exit', onPress: () => {
                                setStep('home');
                                setSelectedSpotId(null);
                                setRouteCoords([]);
                                setSimulatedLocation(null);
                                setArrivalDetected(false);
                                setCurrentInstruction({ turn: '', street: '', icon: '' });
                                if (userLocation) {
                                  fetchNearbySpots(userLocation.lat, userLocation.lng);
                                  if (mapRef.current) {
                                    mapRef.current.animateCamera({
                                      center: { latitude: userLocation.lat, longitude: userLocation.lng },
                                      zoom: 15
                                    }, { duration: 1000 });
                                  }
                                }
                              }
                            }
                          ]);
                        }}
                      >
                        <Ionicons name="close" size={24} color="#fff" />
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </View>


            </>
          )}

          {step !== 'en_route' && !isInPip && (
            <View style={[styles.bottomPanelContainer, isBottomPanelFull && { bottom: 0, left: 0, right: 0 }]}>
              <View style={[BlueprintTheme.glassCard, isBottomPanelFull && { borderRadius: 0, borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingBottom: 40 }]}>
                {step === 'booking_confirm' && (
                  <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                    <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: '#10b981', justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}>
                      <Ionicons name="checkmark" size={50} color="#fff" />
                    </View>
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4, letterSpacing: -0.5 }}>Confirmed!</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 20, textAlign: 'center' }}>Spot reserved and ready.</Text>

                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, width: '100%', marginBottom: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 }}>
                        <View>
                          <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 2 }}>ID</Text>
                          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>#{bookingDetails?.id}</Text>
                        </View>
                        <View style={{ alignItems: 'flex-end' }}>
                          <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 2 }}>SLOT</Text>
                          <Text style={{ color: '#6366f1', fontSize: 16, fontWeight: '900' }}>{selectedSlot?.split('_').pop()}</Text>
                        </View>
                      </View>

                      <View style={{ backgroundColor: 'rgba(16,185,129,0.05)', padding: 14, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(16,185,129,0.1)' }}>
                        <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '800', marginBottom: 6 }}>PIN ON ARRIVAL</Text>
                        <Text style={{ color: '#64748b', fontSize: 13, fontWeight: '600' }}>Your check-in PIN will appear when you arrive</Text>
                      </View>
                    </View>
                    {navCountdown !== null && (
                      <View style={{ alignItems: 'center', marginBottom: 16 }}>
                        <Text style={{ color: '#94a3b8', fontSize: 13, fontWeight: '600' }}>Starting navigation in</Text>
                        <Text style={{ color: '#6366f1', fontSize: 36, fontWeight: '900', marginTop: 4 }}>{navCountdown}</Text>
                        <TouchableOpacity onPress={() => setNavCountdown(null)} style={{ marginTop: 8 }}>
                          <Text style={{ color: '#f43f5e', fontSize: 13, fontWeight: '700' }}>Cancel auto-start</Text>
                        </TouchableOpacity>
                      </View>
                    )}

                    <TouchableOpacity 
                      activeOpacity={0.9}
                      style={{ 
                        backgroundColor: '#6366f1', 
                        paddingVertical: 18, borderRadius: 20, 
                        width: '100%', alignItems: 'center',
                      }} 
                      onPress={() => {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        // No camera work here — the map owns the navigation
                        // camera. See the countdown handler for why the two
                        // moves that used to be here (user @ zoom 17, then the
                        // route midpoint @ zoom 15 flat) fought each other and
                        // opened navigation on empty countryside.
                        if (routeCoords.length > 0) {
                          setSimulatedLocation({ lat: routeCoords[0].latitude, lng: routeCoords[0].longitude });
                        }
                        setIsFollowing(true);
                        setStep('en_route');
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Start Navigation</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {step === 'arriving' && (
                  <View style={{ paddingVertical: 10 }}>
                    {/* Spot name header */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
                      <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(16,185,129,0.12)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                        <Ionicons name="location" size={20} color="#10b981" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: -0.3 }} numberOfLines={1}>{spots.find(s => s.id === selectedSpotId)?.title || 'Parking Spot'}</Text>
                        <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '500', marginTop: 2 }}>Show PIN to the spot owner to check in</Text>
                      </View>
                    </View>

                    {/* PIN display — large and prominent */}
                    <View style={{ backgroundColor: 'rgba(16,185,129,0.06)', padding: 24, borderRadius: 24, alignItems: 'center', borderWidth: 1.5, borderColor: 'rgba(16,185,129,0.15)', marginBottom: 16 }}>
                      <Text style={{ fontSize: 10, color: '#10b981', fontWeight: '800', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 2 }}>Check-in PIN</Text>
                      <Text selectable={true} style={{ fontSize: 48, fontWeight: '900', color: '#fff', letterSpacing: 10 }}>{bookingDetails?.otp}</Text>
                    </View>

                    {/* Booking ID and Slot */}
                    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                      <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 14, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                        <Text style={{ fontSize: 9, color: '#64748b', fontWeight: '800', marginBottom: 4, textTransform: 'uppercase' }}>Booking ID</Text>
                        <Text style={{ fontSize: 18, fontWeight: '900', color: '#fff' }}>#{bookingDetails?.id}</Text>
                      </View>
                      <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 14, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
                        <Text style={{ fontSize: 9, color: '#64748b', fontWeight: '800', marginBottom: 4, textTransform: 'uppercase' }}>Slot</Text>
                        <Text style={{ fontSize: 18, fontWeight: '900', color: '#6366f1' }}>{selectedSlot?.split('_').pop()}</Text>
                      </View>
                    </View>

                    {/* Waiting for host */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 14, backgroundColor: 'rgba(99,102,241,0.06)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(99,102,241,0.12)' }}>
                      <ActivityIndicator size="small" color="#818cf8" />
                      <Text style={{ color: '#818cf8', fontWeight: '700', fontSize: 13 }}>Waiting for host to verify...</Text>
                    </View>
                  </View>
                )}

                {step === 'active_parking' && (
                  <View style={{ paddingVertical: 10 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: -0.5 }}>Active Session</Text>
                        <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '500', marginTop: 3 }} numberOfLines={1}>{spots.find(s => s.id === selectedSpotId)?.title || 'Parking Spot'}</Text>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <View style={{ backgroundColor: 'rgba(16,185,129,0.1)', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(16,185,129,0.15)' }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981' }} />
                            <Text style={{ color: '#10b981', fontWeight: '800', fontSize: 10 }}>LIVE</Text>
                          </View>
                        </View>
                        <View style={{ backgroundColor: 'rgba(255,255,255,0.05)', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
                          <Text style={{ color: '#64748b', fontSize: 8, fontWeight: '800', marginBottom: 1 }}>SLOT</Text>
                          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900' }}>{selectedSlot?.split('_').pop()}</Text>
                        </View>
                      </View>
                    </View>

                    <View style={{ backgroundColor: 'rgba(255,255,255,0.02)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', marginBottom: 20 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center' }}>
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', marginBottom: 6 }}>Duration</Text>
                          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '900' }}>{isLongParking ? 'Long' : `${Math.floor(elapsedMinutes / 60)}h ${(elapsedMinutes % 60).toString().padStart(2, '0')}m`}</Text>
                        </View>
                        <View style={{ width: 1, height: 40, backgroundColor: 'rgba(255,255,255,0.06)' }} />
                        <View style={{ alignItems: 'center' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '800', textTransform: 'uppercase', marginBottom: 6 }}>Est. Cost</Text>
                          <Text style={{ color: '#10b981', fontSize: 26, fontWeight: '900' }}>₹{(() => {
                            const spot = spots.find(s => s.id === selectedSpotId);
                            const rate = spot?.price || 0;
                            const cost = (elapsedMinutes / 60) * rate;
                            return cost < 1 ? rate.toFixed(0) : cost.toFixed(0);
                          })()}</Text>
                        </View>
                      </View>

                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.04)' }}>
                        <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '600' }}>Rate: ₹{spots.find(s => s.id === selectedSpotId)?.price || 0}/hr</Text>
                        <Text style={{ color: 'rgba(255,255,255,0.1)' }}>·</Text>
                        <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '600' }}>Booked: {parkingHours}h {parkingMinutes > 0 ? `${parkingMinutes}m` : ''}</Text>
                      </View>
                    </View>

                    <View style={{ flexDirection: 'row', gap: 12 }}>
                      <TouchableOpacity 
                        activeOpacity={0.9}
                        style={{ 
                          flex: 1,
                          backgroundColor: 'rgba(255,255,255,0.06)', 
                          paddingVertical: 18, borderRadius: 20, 
                          alignItems: 'center',
                          borderWidth: 1,
                          borderColor: 'rgba(255,255,255,0.1)'
                        }} 
                        onPress={() => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          setExtendModalOpen(true);
                        }}
                      >
                        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Extend Stay</Text>
                      </TouchableOpacity>

                      <TouchableOpacity 
                        activeOpacity={0.9}
                        style={{ 
                          flex: 1,
                          backgroundColor: '#f43f5e', 
                          paddingVertical: 18, borderRadius: 20, 
                          alignItems: 'center',
                        }} 
                        onPress={async () => {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                          const spot = spots.find(s => s.id === selectedSpotId);
                          const currentLoc = simulatedLocation || userLocation;
                          
                          if (spot && currentLoc) {
                            const dist = getDistanceKm(spot.lat, spot.lng, currentLoc.lat, currentLoc.lng) * 1000;
                            if (dist > 250) { 
                               Alert.alert("Geofence Warning", "Too far from spot. Return to verify checkout.");
                               return;
                            }
                          }

                          if (!bookingDetails?.id) return;
                          setIsLoading(true);
                          try {
                            // Fetch checkout amount first, then show checkout verification
                            const amtRes = await apiClient.get(`/bookings/${bookingDetails.id}/checkout-amount`);
                            if (amtRes.data?.success) {
                              setBookingDetails(prev => prev ? {
                                ...prev,
                                basePrice: amtRes.data.data.base_price,
                                arrears: amtRes.data.data.arrears || 0,
                                finalAmount: amtRes.data.data.total_amount,
                              } : prev);
                            }
                            setStep('checkout_verification');
                          } catch (e: any) {
                            Alert.alert('Error', e.response?.data?.message || 'Unable to fetch checkout details.');
                          } finally {
                            setIsLoading(false);
                          }
                        }}
                      >
                        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>End Session</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {step === 'checkout_verification' && (
                  <View style={{ paddingVertical: 10 }}>
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4, letterSpacing: -0.5 }}>Ready to Check Out</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 20, fontWeight: '500', lineHeight: 18 }}>
                      Review your total, then request checkout — the spot owner confirms you've left, and your payment opens right after.
                    </Text>

                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 16 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(16,185,129,0.08)', padding: 16, borderRadius: 20, borderWidth: 1.5, borderColor: 'rgba(16,185,129,0.2)', marginBottom: 16 }}>
                        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(16,185,129,0.15)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                          <Ionicons name="car-outline" size={22} color="#10b981" />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: '#10b981', fontWeight: '800', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 2 }}>Checking out</Text>
                          <Text style={{ color: '#fff', fontWeight: '900', fontSize: 15 }} numberOfLines={1}>{spots.find(s => s.id === selectedSpotId)?.title || 'Your parking spot'}</Text>
                          <Text style={{ color: '#64748b', fontSize: 9, fontWeight: '800', letterSpacing: 1, marginTop: 4 }}>BOOKING ID — SHOW TO OWNER</Text>
                          <Text selectable={true} style={{ color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: 0.5 }}>#{bookingDetails?.id}</Text>
                        </View>
                      </View>

                      <View style={{ gap: 10 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 13, fontWeight: '600' }}>Base Price</Text>
                          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>₹{Number(bookingDetails?.basePrice || bookingDetails?.totalPrice || 0).toFixed(2)}</Text>
                        </View>
                        {(bookingDetails?.arrears || 0) > 0 && (
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Text style={{ color: '#f43f5e', fontSize: 13, fontWeight: '800' }}>Arrears</Text>
                            <Text style={{ color: '#f43f5e', fontSize: 16, fontWeight: '900' }}>₹{Number(bookingDetails?.arrears || 0).toFixed(2)}</Text>
                          </View>
                        )}
                        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)' }} />
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>Total</Text>
                          <Text style={{ color: '#6366f1', fontSize: 24, fontWeight: '900' }}>₹{Number(bookingDetails?.finalAmount || bookingDetails?.totalPrice || 0).toFixed(2)}</Text>
                        </View>
                      </View>
                    </View>

                    <TouchableOpacity
                      activeOpacity={0.9}
                      disabled={isLoading}
                      style={{ backgroundColor: '#6366f1', paddingVertical: 18, borderRadius: 20, alignItems: 'center', marginBottom: 10 }}
                      onPress={async () => {
                        if (!bookingDetails?.id) return;
                        setIsLoading(true);
                        try {
                          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
                          const res = await apiClient.post(`/bookings/${bookingDetails.id}/request-checkout`);
                          if (res.data?.success) {
                            setBookingDetails(prev => prev ? { ...prev, ...res.data.data } : prev);
                            setStep('awaiting_owner');
                          }
                        } catch (e: any) {
                          Alert.alert('Checkout Failed', e.response?.data?.message || 'Unable to request checkout.');
                        } finally {
                          setIsLoading(false);
                        }
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{isLoading ? 'Sending…' : 'Request Checkout'}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      activeOpacity={0.8}
                      style={{ paddingVertical: 12, alignItems: 'center' }}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setStep('active_parking');
                      }}
                    >
                      <Text style={{ color: '#94a3b8', fontWeight: '700', fontSize: 14 }}>Go Back</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {step === 'awaiting_owner' && (
                  <View style={{ paddingVertical: 10 }}>
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4, letterSpacing: -0.5 }}>Waiting for Owner</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 20, fontWeight: '500', lineHeight: 18 }}>
                      We've asked the spot owner to confirm you've left. Your payment opens the moment they confirm.
                    </Text>

                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 22, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 16, alignItems: 'center' }}>
                      <ActivityIndicator color="#6366f1" size="large" />
                      <Text style={{ color: '#cbd5e1', fontSize: 14, fontWeight: '800', marginTop: 14 }}>Awaiting owner confirmation…</Text>
                      <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '700', marginTop: 6 }}>Booking #{bookingDetails?.id}</Text>
                    </View>

                    <TouchableOpacity
                      activeOpacity={0.9}
                      style={{ backgroundColor: 'rgba(255,255,255,0.06)', paddingVertical: 16, borderRadius: 18, alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }}
                      onPress={async () => {
                        if (!bookingDetails?.id) return;
                        try {
                          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                          await apiClient.post(`/bookings/${bookingDetails.id}/request-checkout`);
                          Alert.alert('Owner nudged', "We've re-notified the spot owner to confirm your checkout.");
                        } catch (e: any) {
                          Alert.alert('Could not nudge', e.response?.data?.message || 'Please try again.');
                        }
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>Nudge owner</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      activeOpacity={0.8}
                      style={{ paddingVertical: 12, alignItems: 'center' }}
                      onPress={() => {
                        Alert.alert(
                          'Owner not responding?',
                          "If the owner can't confirm your checkout, contact ParkStop support and we'll sort it out. You won't be charged extra for the delay.",
                          [
                            { text: 'Close', style: 'cancel' },
                            { text: 'Contact support', onPress: () => Linking.openURL('mailto:support@parkstop.app?subject=Checkout%20not%20confirmed%20-%20Booking%20%23' + (bookingDetails?.id || '')) }
                          ]
                        );
                      }}
                    >
                      <Text style={{ color: '#94a3b8', fontWeight: '700', fontSize: 13 }}>Owner not responding? Report a problem</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {step === 'payment' && (
                  <View style={{ paddingVertical: 10 }}>
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 16, letterSpacing: -0.5 }}>Review & Pay</Text>
                    
                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 20 }}>
                      <View style={{ gap: 12 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: '#94a3b8', fontWeight: '600', fontSize: 13 }}>Stay</Text>
                          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>{isLongParking ? 'Long' : `${parkingHours}h ${parkingMinutes}m`}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: '#94a3b8', fontWeight: '600', fontSize: 13 }}>Rate</Text>
                          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>₹{spots.find(s => s.id === selectedSpotId)?.price}/hr</Text>
                        </View>
                        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 4 }} />
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Base Price</Text>
                          <Text style={{ color: '#6366f1', fontSize: 18, fontWeight: '900' }}>₹{Number(bookingDetails?.basePrice || bookingDetails?.totalPrice || 0).toFixed(2)}</Text>
                        </View>
                        {(bookingDetails?.arrears || 0) > 0 && (
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                            <Text style={{ color: '#f43f5e', fontSize: 14, fontWeight: '800' }}>Previous Arrears</Text>
                            <Text style={{ color: '#f43f5e', fontSize: 16, fontWeight: '900' }}>₹{Number(bookingDetails?.arrears || 0).toFixed(2)}</Text>
                          </View>
                        )}
                        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 8 }} />
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ color: '#fff', fontSize: 20, fontWeight: '900' }}>Total Due</Text>
                          <Text style={{ color: '#6366f1', fontSize: 28, fontWeight: '900' }}>₹{Number(bookingDetails?.finalAmount || bookingDetails?.totalPrice || 0).toFixed(2)}</Text>
                        </View>
                      </View>
                    </View>

                    <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '800', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Select Payment Method</Text>
                    <View style={{ flexDirection: 'row', gap: 12, marginBottom: 20 }}>
                      <TouchableOpacity 
                        style={{
                          flex: 1,
                          backgroundColor: selectedPaymentMethod === 'online' ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                          padding: 16,
                          borderRadius: 16,
                          borderWidth: 2,
                          borderColor: selectedPaymentMethod === 'online' ? '#6366f1' : 'transparent',
                          alignItems: 'center',
                          gap: 6
                        }}
                        onPress={() => {
                          Haptics.selectionAsync();
                          setSelectedPaymentMethod('online');
                        }}
                      >
                        <Text style={{ fontSize: 22 }}>💳</Text>
                        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Online Payment</Text>
                      </TouchableOpacity>

                      <TouchableOpacity 
                        style={{
                          flex: 1,
                          backgroundColor: selectedPaymentMethod === 'cash' ? 'rgba(16,185,129,0.15)' : 'rgba(255,255,255,0.03)',
                          padding: 16,
                          borderRadius: 16,
                          borderWidth: 2,
                          borderColor: selectedPaymentMethod === 'cash' ? '#10b981' : 'transparent',
                          alignItems: 'center',
                          gap: 6
                        }}
                        onPress={() => {
                          Haptics.selectionAsync();
                          setSelectedPaymentMethod('cash');
                        }}
                      >
                        <Text style={{ fontSize: 22 }}>💵</Text>
                        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Pay Cash</Text>
                      </TouchableOpacity>
                    </View>

                    {selectedPaymentMethod === 'cash' && (
                      <View style={{ backgroundColor: 'rgba(16,185,129,0.1)', padding: 12, borderRadius: 12, marginBottom: 16 }}>
                        <Text style={{ color: '#10b981', fontSize: 13, fontWeight: '800', textAlign: 'center' }}>
                          💵 Please hand over cash to the spot owner.
                        </Text>
                      </View>
                    )}

                    <TouchableOpacity 
                      activeOpacity={0.9}
                      style={{ 
                        backgroundColor: selectedPaymentMethod === 'cash' ? '#10b981' : '#6366f1', 
                        paddingVertical: 18, borderRadius: 20, 
                        alignItems: 'center',
                      }} 
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        if (selectedPaymentMethod === 'online') {
                          handleCashfreePay();
                        } else {
                          processPayment();
                        }
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>
                        {isLoading ? 'Processing...' : (selectedPaymentMethod === 'cash' ? 'Complete Checkout' : 'Pay with UPI')}
                      </Text>
                    </TouchableOpacity>

                    {showUPIInline && selectedPaymentMethod === 'online' && (
                      <View style={{ marginTop: 16 }}>
                        <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '800', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Choose Payment Method</Text>
                        {[
                          { key: 'gpay', name: 'Google Pay', sub: 'Pay directly via GPay', color: '#1A73E8', icon: 'G' },
                          { key: 'phonepe', name: 'PhonePe', sub: 'Instant UPI via PhonePe', color: '#5f259f', icon: 'पे' },
                          { key: 'paytm', name: 'Paytm', sub: 'Pay using Paytm wallet/UPI', color: '#00baf2', icon: 'P' },
                          { key: 'upi', name: 'Other UPI App', sub: 'Pay via any UPI app', color: '#16a34a', icon: 'U' },
                        ].map(app => (
                          <TouchableOpacity
                            key={app.key}
                            style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}
                            onPress={() => handleUPIPayment(app.key as any)}
                          >
                            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: app.color, justifyContent: 'center', alignItems: 'center', marginRight: 12 }}>
                              <Text style={{ color: '#fff', fontWeight: '900', fontSize: 14 }}>{app.icon}</Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>{app.name}</Text>
                              <Text style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 1 }}>{app.sub}</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.3)" />
                          </TouchableOpacity>
                        ))}
                        <TouchableOpacity
                          style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 16, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}
                          onPress={() => { setShowUPIInline(false); processPayment(); }}
                        >
                          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: '#6366f1', justifyContent: 'center', alignItems: 'center', marginRight: 12 }}>
                            <Ionicons name="card" size={20} color="#fff" />
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>Debit / Credit Card</Text>
                            <Text style={{ color: 'rgba(255,255,255,0.3)', fontSize: 11, marginTop: 1 }}>Cards, Netbanking & Wallets</Text>
                          </View>
                          <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.3)" />
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )}

                {step === 'receipt' && (
                  <View style={{ paddingVertical: 10 }}>
                    <View style={{ alignItems: 'center', marginBottom: 20 }}>
                      <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#10b981', justifyContent: 'center', alignItems: 'center', marginBottom: 12 }}>
                        <Ionicons name="checkmark" size={36} color="#fff" />
                      </View>
                      <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: -0.5 }}>Payment Complete</Text>
                    </View>

                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 20 }}>
                      <View style={{ gap: 10 }}>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '600' }}>Booking ID</Text>
                          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>#{bookingDetails?.id}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '600' }}>Spot</Text>
                          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }} numberOfLines={1}>{spots.find(s => s.id === selectedSpotId)?.title || '—'}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '600' }}>Slot</Text>
                          <Text style={{ color: '#6366f1', fontSize: 12, fontWeight: '800' }}>{selectedSlot?.split('_').pop() || '—'}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '600' }}>Duration</Text>
                          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>{isLongParking ? 'Long Term' : `${parkingHours}h ${parkingMinutes > 0 ? `${parkingMinutes}m` : ''}`}</Text>
                        </View>
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                          <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '600' }}>Payment</Text>
                          <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>{bookingDetails?.payment_mode === 'cash' ? 'Cash' : 'Online'}</Text>
                        </View>
                        <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 4 }} />
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Amount Paid</Text>
                          <Text style={{ color: '#10b981', fontSize: 22, fontWeight: '900' }}>₹{Number(bookingDetails?.finalAmount || bookingDetails?.totalPrice || bookingDetails?.total_price || 0).toFixed(2)}</Text>
                        </View>
                      </View>
                    </View>

                    <TouchableOpacity
                      activeOpacity={0.9}
                      style={{ backgroundColor: '#6366f1', paddingVertical: 18, borderRadius: 20, width: '100%', alignItems: 'center' }}
                      onPress={() => {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        setStep('home');
                        setSelectedSpotId(null);
                        setBookingDetails(null);
                        setSelectedSlot('');
                        // Reset the window rather than the derived duration —
                        // the effect above recomputes hours/minutes from it.
                        setBookingStart(new Date());
                        setBookingEnd(new Date(Date.now() + 3600000));
                        setIsLongParking(false);
                        setLongStayDays(0);
                        setShowUPIInline(false);
                        setArrivalDetected(false);
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Back to Home</Text>
                    </TouchableOpacity>
                  </View>
                )}

              </View>
            </View>
          )}
        </>
      )}

      {step !== 'home' && (
        <TouchableOpacity style={styles.chatFab} onPress={() => setChatOpen(true)}>
          <Text style={styles.chatFabText}>💬</Text>
        </TouchableOpacity>
      )}

      {/* Upfront Payment Modal removed - Payment selection is now done at checkout */}



      {/* 📱 MOCK SIMULATOR MODAL */}

      {/* 🔄 UPI PROCESSING OVERLAY */}
      <Modal visible={isUPIProcessing} transparent animationType="fade">
        <View style={[styles.chatModalBg, { justifyContent: 'center', alignItems: 'center' }]}>
          <View style={[BlueprintTheme.glassCard, { padding: 30, borderRadius: 24, alignItems: 'center', gap: 16, width: width * 0.8 }]}>
            <ActivityIndicator size="large" color={BlueprintColors.primaryAccent} />
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', textAlign: 'center' }}>Opening Payment Application...</Text>
            <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12, textAlign: 'center', lineHeight: 18 }}>Please complete the transaction in Google Pay/PhonePe and return to ParkStop.</Text>
          </View>
        </View>
      </Modal>

      {/* 💳 RAZORPAY CHECKOUT MODAL */}
      {razorpayOrder && (
        <RazorpayCheckout
          visible={isRazorpayVisible}
          orderId={razorpayOrder.orderId}
          amount={razorpayOrder.amount}
          currency={razorpayOrder.currency}
          keyId={razorpayOrder.keyId}
          preferUpi={preferUpiCheckout}
          onSuccess={handleRazorpaySuccess}
          onCancel={handleRazorpayCancel}
          onFailure={handleRazorpayFailure}
        />
      )}

      {/* 🧾 PRICING POLICY MODAL */}
      <Modal visible={priceModalOpen} transparent animationType="fade">
        <View style={styles.chatModalBg}>
          <View style={[styles.priceModal, BlueprintTheme.glassCard]}>
            <Text style={styles.panelTitle}>Pricing Policy</Text>
            <ScrollView style={{ flex: 1, marginBottom: 20 }}>
              <Text style={styles.policyTitle}>1. Dynamic Pricing</Text>
              <Text style={styles.policyText}>Rates are adjusted in real-time based on local demand and peak hours. You will always be charged the rate active at the time of your reservation.</Text>

              <Text style={styles.policyTitle}>2. Commission Split</Text>
              <Text style={styles.policyText}>ParkStop takes a variable commission (15%-25%) to maintain the platform. 80% of your payment goes directly to the local spot owner.</Text>

              <Text style={styles.policyTitle}>3. Grace Period</Text>
              <Text style={styles.policyText}>You have a 5-minute grace period upon arrival. Cancellations made within 2 minutes of reservation are free.</Text>
            </ScrollView>
            <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={() => setPriceModalOpen(false)}>
              <Text style={BlueprintTheme.buttonPrimaryText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={chatOpen} transparent animationType="slide" onRequestClose={() => setChatOpen(false)}>
        <KeyboardAvoidingView 
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.chatModalBg}
        >
          <TouchableOpacity 
            style={StyleSheet.absoluteFill} 
            activeOpacity={1} 
            onPress={() => setChatOpen(false)} 
          />
          <View style={[styles.chatModal, BlueprintTheme.glassCard]}>
            <View style={styles.chatHeader}>
              <Text style={styles.chatTitle}>ParkStop AI</Text>
              <TouchableOpacity onPress={() => setChatOpen(false)}><Text style={styles.chatClose}>Close</Text></TouchableOpacity>
            </View>
            <ScrollView style={styles.chatBody}>
              {messages.map((m, i) => (
                <View key={i} style={[styles.chatBubble, m.sender === 'user' ? styles.chatUser : styles.chatBot]}>
                  <Text style={[styles.chatText, { color: '#FFFFFF' }]}>{m.text}</Text>
                </View>
              ))}
            </ScrollView>
            <View style={styles.chatInputRow}>
              <TextInput style={styles.chatInput} placeholder="Ask something..." placeholderTextColor={BlueprintColors.textSecondary} value={chatInput} onChangeText={setChatInput} onSubmitEditing={sendChat} />
              <TouchableOpacity style={styles.sendBtn} onPress={sendChat}><Text style={{ color: BlueprintColors.primaryAccent, fontWeight: '700' }}>Send</Text></TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={extendModalOpen} transparent animationType="slide">
        <View style={styles.chatModalBg}>
          <View style={[styles.chatModal, BlueprintTheme.glassCard, { height: 500, padding: 24, borderRadius: 32 }]}>
            <View style={styles.chatHeader}>
              <Text style={styles.chatTitle}>Extend Your Stay</Text>
              <TouchableOpacity onPress={() => setExtendModalOpen(false)}>
                <Text style={styles.chatClose}>Cancel</Text>
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 6 }}>
              <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16, fontWeight: '500' }}>
                Add time to your session. Pick a preset or enter your own.
              </Text>

              <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Quick top-up</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                {[5, 10, 20, 30].map(m => {
                  const active = !customExtendText && selectedExtendMinutes === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setCustomExtendText(''); setSelectedExtendMinutes(m); }}
                      style={{ flex: 1, height: 54, borderRadius: 16, backgroundColor: active ? '#6366f1' : 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: active ? '#6366f1' : 'rgba(255,255,255,0.08)' }}
                    >
                      <Text style={{ color: '#fff', fontWeight: '900', fontSize: 15 }}>{m}m</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Hours</Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
                {[1, 2, 3].map(h => {
                  const mins = h * 60;
                  const active = !customExtendText && selectedExtendMinutes === mins;
                  return (
                    <TouchableOpacity
                      key={h}
                      onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setCustomExtendText(''); setSelectedExtendMinutes(mins); }}
                      style={{ flex: 1, height: 54, borderRadius: 16, backgroundColor: active ? '#6366f1' : 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: active ? '#6366f1' : 'rgba(255,255,255,0.08)' }}
                    >
                      <Text style={{ color: '#fff', fontWeight: '900', fontSize: 15 }}>{h}h</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={{ color: '#64748b', fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 8 }}>Custom (minutes)</Text>
              <TextInput
                value={customExtendText}
                onChangeText={(t) => {
                  const clean = t.replace(/[^0-9]/g, '').slice(0, 4);
                  setCustomExtendText(clean);
                  const n = Number(clean);
                  if (Number.isFinite(n) && n > 0) setSelectedExtendMinutes(n);
                }}
                keyboardType="number-pad"
                placeholder="e.g. 45"
                placeholderTextColor="#64748b"
                style={{ height: 52, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 2, borderColor: customExtendText ? '#6366f1' : 'rgba(255,255,255,0.08)', color: '#fff', fontSize: 16, fontWeight: '800', paddingHorizontal: 16, marginBottom: 16 }}
              />

              <View style={{ backgroundColor: 'rgba(99,102,241,0.08)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(99,102,241,0.2)', padding: 14 }}>
                {(() => {
                  const mins = Math.round(Number(selectedExtendMinutes) || 0);
                  const rate = spots.find(s => s.id === selectedSpotId)?.price || 0;
                  const addCost = (mins / 60) * rate;
                  const label = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ''}`.trim() : `${mins}m`;
                  return (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <View>
                        <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' }}>Adding</Text>
                        <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>{mins > 0 ? label : '—'}</Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' }}>Approx. cost</Text>
                        <Text style={{ color: '#a5b4fc', fontSize: 18, fontWeight: '900' }}>₹{addCost.toFixed(0)}</Text>
                      </View>
                    </View>
                  );
                })()}
              </View>
            </ScrollView>

            <TouchableOpacity
              disabled={isExtending}
              onPress={handleExtendStay}
              style={[BlueprintTheme.buttonPrimary, { width: '100%', height: 52, borderRadius: 16, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 14 }]}
            >
              {isExtending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={BlueprintTheme.buttonPrimaryText}>Confirm Extension</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>



    </SafeAreaView>
  );
}

const darkMapStyle = [
  { "elementType": "geometry", "stylers": [{ "color": "#0B0E14" }] },
  { "elementType": "labels.text.fill", "stylers": [{ "color": "#94A3B8" }] },
  { "elementType": "labels.text.stroke", "stylers": [{ "color": "#0B0E14" }] },
  { "featureType": "road", "elementType": "geometry", "stylers": [{ "color": "#1E293B" }] },
  { "featureType": "water", "elementType": "geometry", "stylers": [{ "color": "#0F172A" }] }
];

const styles = StyleSheet.create({
  header: { display: 'none' }, // Removed parkstop header to save space
  fullMapContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  miniMapContainer: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 140,
    height: 180,
    borderRadius: 20,
    overflow: 'hidden',
    zIndex: 9999,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.5,
    shadowRadius: 15,
    elevation: 10,
  },
  logoText: { color: '#fff', fontSize: 24, fontWeight: '900', letterSpacing: -1 },
  exitBtn: {
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  exitText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  mapContainer: { flex: 1, backgroundColor: '#000' },
  mapElement: { flex: 1 },
  floatingSearchContainer: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 76,
    zIndex: 100,
  },
  searchBarWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1E293B',
    borderRadius: 20,
    paddingHorizontal: 16,
    height: 58,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 15,
    elevation: 12,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  searchIconPrefix: { fontSize: 18, marginRight: 12 },
  searchBar: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '600' },
  clearSearchBtn: { padding: 8 },
  searchLoader: { width: 20, height: 20, borderRadius: 10, borderTopWidth: 2, borderColor: BlueprintColors.primaryAccent, marginLeft: 10 },
  markerContainer: { backgroundColor: BlueprintColors.primaryAccent, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 2, borderColor: '#FFFFFF' },

  markerText: { color: '#FFFFFF', fontWeight: '800', fontSize: 12 },
  bottomPanelContainer: { position: 'absolute', bottom: 20, left: 20, right: 20, zIndex: 10 },
  panelTitle: { fontSize: 22, fontWeight: '900', color: '#FFFFFF', marginBottom: 16 },
  spotCard: { backgroundColor: 'rgba(255,255,255,0.03)', padding: 16, borderRadius: 20, marginRight: 12, minWidth: 160, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  activeSpotCard: { borderColor: BlueprintColors.primaryAccent, backgroundColor: 'rgba(255,107,44,0.1)' },
  spotOwner: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  spotDetails: { fontSize: 13, color: BlueprintColors.textSecondary, marginTop: 4 },
  statusText: { fontSize: 12, fontWeight: '700', marginTop: 8 },
  descText: { color: BlueprintColors.textSecondary, fontSize: 14, padding: 10 },
  routingHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  pricingBreakdownCard: { backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 20, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  priceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  priceMainLabel: { color: BlueprintColors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  priceValue: { color: '#FFFFFF', fontSize: 20, fontWeight: '800' },
  multiplierRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  badge: { backgroundColor: 'rgba(255,107,44,0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  badgeText: { color: BlueprintColors.primaryAccent, fontSize: 11, fontWeight: '800' },
  pricingDisclaimer: { color: BlueprintColors.textSecondary, fontSize: 10, fontStyle: 'italic' },
  navOverlay: { position: 'absolute', top: -110, left: 20, right: 20, zIndex: 10 },
  navBannerInline: { backgroundColor: BlueprintColors.success, padding: 16, borderRadius: 20, flexDirection: 'row', alignItems: 'center', gap: 12, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 10, elevation: 5 },
  filterContainer: { marginTop: 12, paddingBottom: 5 },
  filterChip: {
    backgroundColor: '#1E293B',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    marginRight: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
  },
  filterChipText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  suggestionsContainer: {
    backgroundColor: '#0f172a',
    borderRadius: 28,
    paddingVertical: 12,
    marginTop: 12,
    maxHeight: 420,
    zIndex: 1000,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 15 },
    shadowOpacity: 0.6,
    shadowRadius: 25,
    elevation: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 18,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
  },
  suggestionIconCircle: {
    width: 44,
    height: 44,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  suggestionIcon: { fontSize: 20 },
  suggestionTitle: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: -0.2 },
  suggestionSub: { color: '#64748b', fontSize: 13, marginTop: 4, fontWeight: '500' },
  enRouteOverlay: {
    position: 'absolute',
    top: 60,
    left: 20,
    right: 20,
    zIndex: 10,
  },
  debugOverlay: {
    position: 'absolute',
    top: 50,
    left: 20,
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 8,
    borderRadius: 10,
    zIndex: 1000,
  },
  debugText: {
    color: '#00ff00',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  enRouteBanner: {
    backgroundColor: '#1E293B',
    padding: 20,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#4285F4',
    shadowColor: '#4285F4',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 15,
    elevation: 20,
  },
  recenterBtn: {
    position: 'absolute',
    bottom: 250, // Move it higher up so it doesn't overlap with panel
    right: 20,
    zIndex: 9999,
    backgroundColor: BlueprintColors.primaryAccent, // Make it more visible (Blue)
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 10,
  },
  otpSection: { marginBottom: 24 },
  otpRow: { flexDirection: 'row', gap: 12 },
  otpItem: { flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 16, borderRadius: 20, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' },
  infoLabel: { fontSize: 10, color: BlueprintColors.textSecondary, fontWeight: '800', marginBottom: 6 },
  otpValue: { fontSize: 22, fontWeight: '900', color: '#FFFFFF', letterSpacing: 2 },
  paymentContainer: { paddingVertical: 10 },
  receiptLine: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  receiptLabel: { color: BlueprintColors.textSecondary, fontSize: 14, fontWeight: '600' },
  receiptValue: { color: '#fff', fontSize: 14, fontWeight: '700' },
  receiptContainer: { alignItems: 'stretch' },
  successIcon: { alignSelf: 'center', backgroundColor: 'rgba(16, 185, 129, 0.1)', width: 80, height: 80, borderRadius: 40, justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  chatFab: { position: 'absolute', bottom: 30, right: 20, width: 60, height: 60, borderRadius: 30, backgroundColor: BlueprintColors.primaryAccent, justifyContent: 'center', alignItems: 'center', shadowColor: BlueprintColors.primaryAccent, shadowOpacity: 0.4, shadowRadius: 15, elevation: 8 },
  chatFabText: { fontSize: 24 },
  chatModalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end', padding: 20 },
  chatModal: { height: Dimensions.get('window').height * 0.7, padding: 24, borderRadius: 32 },
  priceModal: { padding: 32, borderRadius: 32, maxHeight: '80%' },
  chatHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20, alignItems: 'center' },
  chatTitle: { fontSize: 20, fontWeight: '900', color: '#FFFFFF' },
  chatClose: { color: BlueprintColors.textSecondary, fontWeight: '700' },
  chatBody: { flex: 1 },
  chatBubble: { padding: 14, borderRadius: 20, marginBottom: 12, maxWidth: '85%' },
  chatBot: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.05)', borderBottomLeftRadius: 4 },
  chatUser: { alignSelf: 'flex-end', backgroundColor: BlueprintColors.primaryAccent, borderBottomRightRadius: 4 },
  chatText: { fontSize: 15, lineHeight: 22 },
  chatInputRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  chatInput: { flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 16, borderRadius: 16, color: '#FFFFFF', fontSize: 15 },
  sendBtn: { padding: 10 },
  backBadge: { backgroundColor: 'rgba(255,107,44,0.1)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, marginRight: 12 },
  backBadgeText: { color: BlueprintColors.primaryAccent, fontWeight: '800', fontSize: 13 },
  policyTitle: { color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 16, marginBottom: 4 },
  policyText: { color: BlueprintColors.textSecondary, fontSize: 14, lineHeight: 20 },
  navIconCircle: {
    width: 60,
    height: 60,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navStats: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    alignItems: 'center',
  },
  navStatValue: { color: '#fff', fontSize: 18, fontWeight: '900' },
  navStatLabel: { color: BlueprintColors.textSecondary, fontSize: 10, fontWeight: '800' },
  nextTurnCard: {
    marginTop: 12,
    backgroundColor: '#1E293B',
    padding: 16,
    borderRadius: 20,
    width: '60%',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 10,
  },
  nextTurnLabel: { color: BlueprintColors.primaryAccent, fontSize: 10, fontWeight: '900', marginBottom: 4 },
  nextTurnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  bottomNavDashboard: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1E293B',
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingBottom: 40,
    paddingTop: 12,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 25,
    elevation: 30,
  },
  bottomNavStats: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingHorizontal: 20,
  },
  bottomStatItem: { alignItems: 'center' },
  bottomStatValue: { color: '#fff', fontSize: 24, fontWeight: '900' },
  bottomStatLabel: { color: BlueprintColors.textSecondary, fontSize: 12, fontWeight: '700' },
  bottomStatDivider: { width: 1, height: 30, backgroundColor: 'rgba(255,255,255,0.1)' },
  stopNavBtn: {
    backgroundColor: '#FF3B30',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 16,
  },
  stopNavBtnText: { color: '#fff', fontWeight: '900', fontSize: 16 },
  pullHandle: {
    width: 40,
    height: 5,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2.5,
    alignSelf: 'center',
    marginBottom: 20,
  },
  bottomSheetInner: {
    paddingTop: 0,
  },
  pricingVisualBadge: {
    width: 50,
    height: 50,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  continueBtn: {
    backgroundColor: BlueprintColors.primaryAccent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 14,
  },
  continueBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  fabContainer: {
    position: 'absolute',
    right: 20,
    bottom: 240,
    gap: 12,
    zIndex: 9999,
  },
  fabBtn: {
    backgroundColor: BlueprintColors.secondaryAccent,
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  floatingProfileBtn: {
    position: 'absolute',
    top: 67, 
    right: 16,
    zIndex: 1000,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  upiAppItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  upiAppIconBg: {
    width: 46,
    height: 46,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  upiAppTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  upiAppSubtitle: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 12,
    marginTop: 2,
  },
});
