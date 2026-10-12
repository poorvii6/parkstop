import React, { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, Text, StyleSheet, Platform, TouchableOpacity, TextInput, Dimensions, Modal, Alert, ScrollView, Linking, Keyboard, ActivityIndicator, BackHandler, AppState, Image, DeviceEventEmitter } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import MapLibreView from '../../components/MapLibreView';
import RazorpayCheckout from '../../components/RazorpayCheckout';
import razorpayService from '../../services/razorpayService';
import { registerForPushNotificationsAsync, getCurrentPushToken } from '../../services/notifications';
import { onRealtime } from '../../services/realtime';

import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { isNetworkError, ONLINE_EVENT } from '../../utils/networkStatus';
import { useOnlineRefresh } from '../../hooks/useOnlineRefresh';
import NotificationBell from '../../components/NotificationBell';
import { getDistanceKm } from '../../utils/geo';
import { BlueprintTheme, BlueprintColors } from '../../constants/BlueprintTheme';
import apiClient from '../../api/client';
import { saveLastLocation, loadLastLocation } from '../../services/lastLocation';
import { Spot, PricingBreakdown, AppStep } from '../../types/finder';
import SkeletonCard from '../../components/SkeletonCard';
import { openDirections } from '../../utils/directions';
import { BookedPanel, PaymentPanel, ReceiptPanel } from '../../components/finder/SessionPanels';

const { width } = Dimensions.get('window');

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
  const [vehicleType, setVehicleType] = useState<string>('');
  const [vehicleSubType, setVehicleSubType] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<string>('');
  const [parkingHours, setParkingHours] = useState<number>(1);
  const [parkingMinutes, setParkingMinutes] = useState<number>(0);
  const [isManualDuration, setIsManualDuration] = useState(false);
  const [isLongParking, setIsLongParking] = useState(false);
  const [parkingEndDate, setParkingEndDate] = useState<string>('');
  const [calculatedPrice, setCalculatedPrice] = useState<number | null>(null);
  const [isCalculatingPrice, setIsCalculatingPrice] = useState(false);
  const [slotData, setSlotData] = useState<Array<{ name: string; status: string }>>([]);
  const [mapStyleConfig, setMapStyleConfig] = useState<{ styleUrl?: string; apiKey?: string; provider?: string }>({});
  const ignoreNextQueryChange = useRef(false);




  // Ensure the backend's active role matches this dashboard so Finder actions
  // (price calculation, booking, cancel, etc.) are authorized. Finding requires
  // no registration, so this is safe and idempotent.
  useEffect(() => {
    apiClient.post('/auth/switch-role', { newRole: 'FINDER' }).catch(() => {});
  }, []);

  // Restore an unfinished booking on open, even after the app was closed:
  //   reserved          -> keep guiding them to the spot
  //   active            -> the parking session screen
  //   checkout_pending  -> waiting for the owner to confirm
  //   completed, unpaid -> the payment screen
  // The server refuses a new booking until the last one is paid, so the
  // driver must always be able to get back here.
  const checkResumable = useCallback(async () => {
    try {
      const res = await apiClient.get('/bookings/my-bookings');
      if (!res.data?.success) return;
      const nowTs = Date.now();
      const found = (res.data.data || []).find((b: any) => {
        if (b.status === 'active' || b.status === 'checkout_pending') return true;
        if (b.status === 'completed') return b.payment_mode !== 'cash' && b.payment_status !== 'paid';
        // Reserved: only resume a CURRENT session (booked <2h ago, window
        // still open) — stale reservations must not draw a route on open.
        if (b.status !== 'reserved') return false;
        const created = b.created_at ? new Date(b.created_at).getTime() : 0;
        const ends = b.end_time ? new Date(b.end_time).getTime() : 0;
        return nowTs - created < 2 * 60 * 60 * 1000 && ends > nowTs;
      });
      if (!found?.parking_spots) return;
      // Never jump straight in on open — offer a "Resume" card instead.
      setResumableBooking(found);
    } catch {}
  }, []);

  useEffect(() => { checkResumable(); }, [checkResumable]);

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
    setBookingDetails({
      ...b,
      id: String(b.id),
      otp: b.otp_code != null ? String(b.otp_code) : '',
      checkoutOtp: b.checkout_otp,
      totalPrice: Number(b.total_price) || 0,
      payment_mode: 'online',
    });
    setResumableBooking(null);

    if (b.status === 'active') { setStep('active_parking'); return; }
    if (b.status === 'checkout_pending') { setStep('awaiting_owner'); return; }
    if (b.status === 'completed') { setStep('payment'); return; }

    // Reserved: back to the "you're booked" screen with the PIN and the
    // Google Maps button.
    if (b.slot_name) setSelectedSlot(b.slot_name);
    setStep('booking_confirm');
  };

  const [priceModalOpen, setPriceModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [searchedPlace, setSearchedPlace] = useState<{ lat: number, lng: number, title: string } | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);
  const [deviceHeading, setDeviceHeading] = useState(0);
  // Last position used to load nearby spots; null until the first fix.
  const lastUpdateCoords = useRef<{ lat: number; lng: number } | null>(null);

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
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  // Extension duration in MINUTES. Presets cover quick top-ups (5/10/20/30 min)
  // and hour blocks (60/120/180); customExtendText holds a manual entry.
  const [selectedExtendMinutes, setSelectedExtendMinutes] = useState(60);
  const [customExtendText, setCustomExtendText] = useState('');
  const [isExtending, setIsExtending] = useState(false);


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

  useEffect(() => {
    if (step !== 'spot_booking' || !selectedSpotId) return;
    
    let hours = parkingHours + (parkingMinutes / 60);
    let end = new Date(Date.now() + hours * 3600000);

    if (isLongParking && parkingEndDate) {
      const parts = parkingEndDate.split(/[-/]/);
      if (parts.length === 3) {
        const [dd, mm, yyyy] = parts;
        end = new Date(`${yyyy}-${mm}-${dd}T23:59:59`);
        if (!isNaN(end.getTime())) {
          hours = Math.ceil((end.getTime() - Date.now()) / 3600000);
        }
      }
    }

    const delayDebounceFn = setTimeout(async () => {
      setIsCalculatingPrice(true);
      const spot = spots.find(s => s.id === selectedSpotId);
      try {
        const res = await apiClient.post('/bookings/calculate-price', {
          spot_id: parseInt(selectedSpotId, 10),
          start_time: new Date().toISOString(),
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
  }, [step, selectedSpotId, parkingHours, parkingMinutes, isLongParking, parkingEndDate]);

  const [isRazorpayVisible, setIsRazorpayVisible] = useState(false);
  const [razorpayOrder, setRazorpayOrder] = useState<{
    orderId: string;
    amount: number;
    currency: string;
    keyId: string;
  } | null>(null);
  // Preselect UPI in Razorpay Checkout when the user tapped a UPI app.
  const [preferUpiCheckout, setPreferUpiCheckout] = useState(false);

  // REMOVED: executeUPIVerification + the mock UPI simulator.
  //
  // They existed only to send `mock_upi_intent` — a fake signature that asked
  // the server to mark a booking paid with no money moving. The server now
  // refuses it outright, and the UPI flow goes through Razorpay Checkout, which
  // produces a real, verifiable payment against the order.

  const [spots, setSpots] = useState<Spot[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSlotLoading, setIsSlotLoading] = useState(false);
  const [slotLoadError, setSlotLoadError] = useState(false); // true when slots couldn't load due to being offline
  const [isNearbyLoading, setIsNearbyLoading] = useState(false);

  useEffect(() => {
    const backAction = () => {
      // 2. Spot Booking: Return to home
      if (step === 'spot_booking') {
        setStep('home');
        setSelectedSpotId(null);
        setSlotData([]);
        setSelectedSlot('');
        return true;
      }

      // 3. Booked, not yet checked in: back to the map. The booking stays;
      //    the Resume card brings it back.
      if (step === 'booking_confirm') {
        setStep('home');
        setSelectedSpotId(null);
        checkResumable();
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

          const result = await Promise.race([lastKnown, fresh, timeout]);
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
            const precise = { lat: l.coords.latitude, lng: l.coords.longitude };
            setUserLocation(precise);
            lastUpdateCoords.current = precise;
            saveLastLocation(precise);
            lastFixQuality.current = { acc: l.coords.accuracy || 15, t: Date.now() };
          })
          .catch(() => {});

        // 2. Continuous watch — with ACCURACY GATING. Navigation happens in
        //    Google Maps, so this only keeps the blue dot and nearby spots
        //    fresh: high accuracy every few seconds is plenty and far kinder
        //    to the battery than navigation-grade 1-second fixes.
        //    A reading with high uncertainty must not drag the dot away from a
        //    recent precise fix (that wander was the "inaccurate" feeling).
        //    Wrapped so a watcher failure cannot take down the heading
        //    subscription or anything after it.
        try {
          watchSub = await Location.watchPositionAsync({
            accuracy: Location.Accuracy.High,
            timeInterval: 4000,
            distanceInterval: 10,
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

    return () => {
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
    setSuggestions([]);
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

  // "Directions" from the place card opens Google Maps to the searched place.
  const handleDirectionsToPlace = () => {
    if (!searchedPlace) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    openDirections(searchedPlace.lat, searchedPlace.lng);
  };

  const recenterCamera = () => {
    setIsFollowing(true); // The map component will fly to userLocation automatically when isFollowing=true
  };

  useEffect(() => {
    let pollInterval: any;
    if (['booking_confirm', 'checkout_verification', 'awaiting_owner'].includes(step) && bookingDetails?.id) {
      pollInterval = setInterval(async () => {
        try {
          const res = await apiClient.get('/bookings/my-bookings');
          if (res.data?.success) {
            const currentBooking = res.data.data.find((b: any) => String(b.id) === String(bookingDetails?.id));
            if (currentBooking) {
              if (step === 'booking_confirm' && (currentBooking.status === 'active' || currentBooking.status === 'occupied')) {
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
      }, 6000);
    }
    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [step, bookingDetails?.id]);

  // Instant check-in via socket (the 3s poll above is the fallback). When the
  // spotter verifies the entry OTP, the backend emits booking:checkedin to this
  // finder — advance straight to the active session with no wait.
  useEffect(() => {
    if (step !== 'booking_confirm' || !bookingDetails?.id) return;
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
  // Also on the parking screen: a session left running far past its booked
  // time is closed by the server, which sends the same event.
  useEffect(() => {
    if (!['awaiting_owner', 'active_parking'].includes(step) || !bookingDetails?.id) return;
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
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        // Show the amount actually charged (the order is in paise).
        const paid = razorpayOrder ? razorpayOrder.amount / 100 : null;
        if (paid) setBookingDetails(prev => prev ? { ...prev, finalAmount: paid } : prev);
        setStep('receipt');
      } else {
        Alert.alert('Payment not confirmed', `${verification.message || 'We could not confirm this payment.'}\n\nIf money was deducted, do not pay again — it will be confirmed or refunded automatically. Payment ID: ${data.razorpay_payment_id}`);
      }
    } catch (e: any) {
      Alert.alert('Payment not confirmed', `${e.message || 'We could not confirm this payment yet.'}\n\nIf money was deducted, do not pay again — it will be confirmed or refunded automatically. Payment ID: ${data.razorpay_payment_id}`);
    } finally {
      paymentInFlight.current = false;
      setIsLoading(false);
      setRazorpayOrder(null);
    }
  };

  const handleRazorpayCancel = () => {
    paymentInFlight.current = false;
    setIsRazorpayVisible(false);
    setPreferUpiCheckout(false);
    setRazorpayOrder(null);
    Alert.alert('Payment Cancelled', 'You cancelled the payment transaction.');
  };

  const handleRazorpayFailure = (error: string) => {
    paymentInFlight.current = false;
    setIsRazorpayVisible(false);
    setPreferUpiCheckout(false);
    setRazorpayOrder(null);
    Alert.alert('Payment Failed', error || 'Failed to complete transaction.');
  };

  // ── Online payment: Razorpay Checkout (UPI first, cards/netbanking too) ──
  // The server builds the order (spot price + advance fee + any old dues) and
  // later checks the payment against that exact order before marking it paid.
  const paymentInFlight = useRef(false);

  const handleRazorpayPay = async () => {
    if (!bookingDetails?.id || paymentInFlight.current || isRazorpayVisible) return; // no double taps
    paymentInFlight.current = true;
    setIsLoading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const order = await razorpayService.createOrder(Number(bookingDetails.id));
      if (!order?.success || !order.order_id || !order.key_id) {
        throw new Error('Could not start the payment. Please try again.');
      }
      setRazorpayOrder({
        orderId: order.order_id,
        amount: order.amount,
        currency: order.currency || 'INR',
        keyId: order.key_id,
      });
      setPreferUpiCheckout(true);
      setIsRazorpayVisible(true);
    } catch (e: any) {
      paymentInFlight.current = false;
      Alert.alert('Payment Error', e?.response?.data?.message || e?.message || 'Could not start payment');
    } finally {
      setIsLoading(false);
    }
  };

  const isBottomPanelFull = ['booking_confirm', 'active_parking', 'payment', 'receipt'].includes(step);

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
  const handleCreateBooking = async () => {
    if (!selectedSpotId) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIsLoading(true);
    setSearchedPlace(null);
    try {
      let hours = parkingHours + (parkingMinutes / 60);
      let end = new Date(Date.now() + hours * 3600000);
      if (isLongParking && parkingEndDate) {
        const parts = parkingEndDate.split(/[-/]/);
        if (parts.length === 3) {
          const [dd, mm, yyyy] = parts;
          end = new Date(`${yyyy}-${mm}-${dd}T23:59:59`);
          if (isNaN(end.getTime())) {
            Alert.alert("Invalid Date", "Please check your date format (DD-MM-YYYY).");
            setIsLoading(false);
            return;
          }
        } else {
          Alert.alert("Invalid Format", "Please use DD-MM-YYYY format.");
          setIsLoading(false);
          return;
        }
        hours = Math.ceil((end.getTime() - Date.now()) / 3600000);
      }

      const res = await apiClient.post('/bookings', {
        spot_id: parseInt(selectedSpotId, 10),
        start_time: new Date().toISOString(),
        end_time: end.toISOString(),
        slot_name: selectedSlot,
        vehicle_type: vehicleType,
        vehicle_subtype: vehicleSubType
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
          payment_mode: 'online'
        });
        setStep('booking_confirm');
      }
    } catch (e: any) { 
      const errMsg = e.response?.data?.message || 'Error';
      if (errMsg.toLowerCase().includes('slots') || errMsg.toLowerCase().includes('full')) {
        Alert.alert('Booking Failed', 'This parking spot is currently full and cannot be booked right now.');
      } else if (errMsg.includes('before booking again')) {
        // An unfinished or unpaid booking exists: bring back its Resume card.
        Alert.alert('Finish your last parking', errMsg);
        checkResumable();
      } else {
        Alert.alert('Booking Failed', errMsg);
      }
    }
    finally { setIsLoading(false); }
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
                onChangeText={setSearchQuery}
                onSubmitEditing={handleSearch}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                returnKeyType="search"
              />
              {searchQuery.length > 0 && (
                <TouchableOpacity onPress={() => { setSearchQuery(''); setSuggestions([]); setSearchedPlace(null); setSearchFocused(false); }} style={{ padding: 6, marginRight: 6 }}>
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
                          try { await AsyncStorage.removeItem('otp_verified_uid'); } catch {}
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
                    const n = spots.filter((s: any) => s.available).length;
                    return [d, n > 0 ? `${n} parking nearby` : 'searching parking…'].filter(Boolean).join(' • ');
                  })()}
                </Text>
              </View>
              <TouchableOpacity onPress={handleDirectionsToPlace} activeOpacity={0.85} style={{ backgroundColor: '#1a73e8', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', marginLeft: 8 }}>
                <Ionicons name="navigate" size={15} color="#fff" style={{ marginRight: 5 }} />
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>Directions</Text>
              </TouchableOpacity>
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
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>
                  {resumableBooking.status === 'completed' ? 'Payment pending' : 'Booking in progress'}
                </Text>
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
          <MapLibreView
            ref={mapRef}
            viewportHint={viewportHint}
            markers={spots}
            destination={(() => {
              if (selectedSpotId) {
                const s = spots.find(x => x.id === selectedSpotId);
                if (s) return { lat: s.lat, lng: s.lng };
              }
              return null;
            })()}
            searchedPlace={searchedPlace ?? null}
            onRecenter={recenterCamera}
            controlsBottomOffset={['spot_booking', 'booking_confirm'].includes(step) ? 470 : 260}
            onMapPress={(coords: [number, number]) => {
              fetchNearbySpots(coords[1], coords[0]);
            }}
            heading={deviceHeading}
            userLocation={userLocation || undefined}
            locationAccuracy={locationAccuracy}
            isFollowing={isFollowing}
            onMapInteraction={() => setIsFollowing(false)}
            mapStyleUrl={mapStyleConfig.provider === 'ola' ? mapStyleConfig.styleUrl : undefined}
            mapApiKey={mapStyleConfig.provider === 'ola' ? mapStyleConfig.apiKey : undefined}
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
              if (userLocation && mapRef.current) {
                mapRef.current.animateCamera({
                  center: { latitude: userLocation.lat, longitude: userLocation.lng },
                  zoom: 14
                });
              }
            }}
            hideControls={['spot_booking'].includes(step)}
          />

        </View>
      )}

      {/* FLOATING BACK/HOME BUTTON — rendered AFTER map so it sits on top of WebView */}
      {['spot_booking', 'booking_confirm', 'active_parking', 'checkout_verification', 'awaiting_owner', 'payment'].includes(step) && (
        <TouchableOpacity
          style={{
            position: 'absolute',
            top: Platform.OS === 'ios' ? 58 : 38,
            left: 16,
            zIndex: 99999,
            backgroundColor: 'rgba(15,23,42,0.95)',
            width: 46,
            height: 46,
            borderRadius: 23,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1.5,
            borderColor: 'rgba(255,255,255,0.2)',
            shadowColor: '#000',
            shadowOpacity: 0.5,
            shadowRadius: 10,
            elevation: 50,
          }}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            if (step === 'home' && searchedPlace !== null) {
              setSearchedPlace(null);
              setSearchQuery('');
            } else if (step === 'booking_confirm') {
              // The booking stays; the Resume card brings it back.
              setStep('home');
              setSelectedSpotId(null);
              checkResumable();
            } else if (step === 'spot_booking') {
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
          }}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
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
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 9, backgroundColor: !isLongParking && !isManualDuration ? '#6366f1' : 'transparent', alignItems: 'center' }} 
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsLongParking(false); setIsManualDuration(false); }}
                >
                  <Text style={{ color: !isLongParking && !isManualDuration ? '#fff' : '#94a3b8', fontWeight: '900', fontSize: 12 }}>Custom</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 9, backgroundColor: isManualDuration ? '#6366f1' : 'transparent', alignItems: 'center' }} 
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsLongParking(false); setIsManualDuration(true); }}
                >
                  <Text style={{ color: isManualDuration ? '#fff' : '#94a3b8', fontWeight: '900', fontSize: 12 }}>Type Duration</Text>
                </TouchableOpacity>
                <TouchableOpacity 
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 9, backgroundColor: isLongParking ? '#6366f1' : 'transparent', alignItems: 'center' }} 
                  onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsLongParking(true); setIsManualDuration(false); }}
                >
                  <Text style={{ color: isLongParking ? '#fff' : '#94a3b8', fontWeight: '900', fontSize: 12 }}>Long Stay</Text>
                </TouchableOpacity>
              </View>

              {(!isLongParking && !isManualDuration) && (
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' }}>Hours</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                    {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 24].map(h => (
                      <TouchableOpacity
                        key={h}
                        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setParkingHours(h); }}
                        style={{ 
                          width: 44, height: 44, 
                          backgroundColor: parkingHours === h ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)', 
                          borderWidth: 2, borderColor: parkingHours === h ? '#6366f1' : 'rgba(255,255,255,0.08)', 
                          borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 6 
                        }}
                      >
                        <Text style={{ color: '#fff', fontWeight: '900', fontSize: 13 }}>{h}h</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' }}>Minutes</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {[0, 15, 30, 45].map(m => (
                      <TouchableOpacity
                        key={m}
                        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setParkingMinutes(m); }}
                        style={{ 
                          width: 48, height: 48, 
                          backgroundColor: parkingMinutes === m ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)', 
                          borderWidth: 2, borderColor: parkingMinutes === m ? '#6366f1' : 'rgba(255,255,255,0.08)', 
                          borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 8 
                        }}
                      >
                        <Text style={{ color: '#fff', fontWeight: '900', fontSize: 14 }}>{m}m</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}

              {isManualDuration && (
                <View style={{ marginBottom: 16 }}>
                  <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 6, textTransform: 'uppercase' }}>Hours</Text>
                      <TextInput
                        style={{ 
                          backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', 
                          paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, 
                          borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.08)',
                          fontSize: 14, fontWeight: '800', textAlign: 'center' 
                        }}
                        keyboardType="numeric"
                        value={parkingHours.toString()}
                        onChangeText={(val) => {
                          const hrs = parseInt(val, 10);
                          setParkingHours(isNaN(hrs) ? 0 : hrs);
                        }}
                        placeholder="0"
                        placeholderTextColor="rgba(255,255,255,0.15)"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 6, textTransform: 'uppercase' }}>Minutes</Text>
                      <TextInput
                        style={{ 
                          backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', 
                          paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, 
                          borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.08)',
                          fontSize: 14, fontWeight: '800', textAlign: 'center' 
                        }}
                        keyboardType="numeric"
                        value={parkingMinutes.toString()}
                        onChangeText={(val) => {
                          const mins = parseInt(val, 10);
                          setParkingMinutes(isNaN(mins) ? 0 : mins);
                        }}
                        placeholder="0"
                        placeholderTextColor="rgba(255,255,255,0.15)"
                      />
                    </View>
                  </View>
                </View>
              )}

              {isLongParking && (
                <View style={{ marginBottom: 16 }}>
                  <Text style={{ color: '#64748b', marginBottom: 8, fontSize: 10, fontWeight: '800', textTransform: 'uppercase' }}>End Date</Text>
                  <TextInput
                    style={{ backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', padding: 14, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', fontSize: 15, fontWeight: '600' }}
                    placeholder="DD-MM-YYYY"
                    placeholderTextColor="#475569"
                    value={parkingEndDate}
                    onChangeText={setParkingEndDate}
                  />
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
                  handleCreateBooking();
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

          {(
            <View style={[styles.bottomPanelContainer, isBottomPanelFull && { bottom: 0, left: 0, right: 0 }]}>
              <View style={[BlueprintTheme.glassCard, isBottomPanelFull && { borderRadius: 0, borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingBottom: 40 }]}>
                {step === 'booking_confirm' && (() => {
                  const spot = spots.find(s => s.id === selectedSpotId);
                  return (
                    <BookedPanel
                      spotTitle={spot?.title}
                      slot={(selectedSlot || (bookingDetails as any)?.slot_name || '').split('_').pop() || '—'}
                      bookingId={bookingDetails?.id}
                      otp={bookingDetails?.otp}
                      onNavigate={spot ? () => openDirections(spot.lat, spot.lng) : undefined}
                    />
                  );
                })()}

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
                          const currentLoc = userLocation;
                          
                          if (spot && currentLoc) {
                            const dist = getDistanceKm(spot.lat, spot.lng, currentLoc.lat, currentLoc.lng) * 1000;
                            if (dist > 250) { 
                               Alert.alert("Too far from the spot", "Go back to the spot to end your session.");
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
                  <PaymentPanel
                    bookingId={bookingDetails?.id}
                    ratePerHour={spots.find(s => s.id === selectedSpotId)?.price}
                    fallbackTotal={Number(bookingDetails?.finalAmount || bookingDetails?.totalPrice || 0)}
                    busy={isLoading || isRazorpayVisible}
                    onPay={handleRazorpayPay}
                  />
                )}

                {step === 'receipt' && (
                  <ReceiptPanel
                    bookingId={bookingDetails?.id}
                    spotTitle={spots.find(s => s.id === selectedSpotId)?.title}
                    slot={(selectedSlot || (bookingDetails as any)?.slot_name || '').split('_').pop() || '—'}
                    amount={Number(bookingDetails?.finalAmount || bookingDetails?.totalPrice || bookingDetails?.total_price || 0)}
                    onDone={() => {
                      setStep('home');
                      setSelectedSpotId(null);
                      setBookingDetails(null);
                      setSelectedSlot('');
                      setParkingHours(1);
                    }}
                  />
                )}

              </View>
            </View>
          )}
        </>
      )}




      {/* 📱 MOCK SIMULATOR MODAL */}


      {/* 💳 RAZORPAY CHECKOUT MODAL */}
      {razorpayOrder && (
        <RazorpayCheckout
          visible={isRazorpayVisible}
          orderId={razorpayOrder.orderId}
          amount={razorpayOrder.amount}
          currency={razorpayOrder.currency}
          keyId={razorpayOrder.keyId}
          preferUpi={preferUpiCheckout}
          prefillEmail={require('../../services/firebase').auth?.currentUser?.email || ''}
          prefillName={require('../../services/firebase').auth?.currentUser?.displayName || ''}
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
