import React, { useState, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, Text, StyleSheet, Platform, TouchableOpacity, TextInput, Dimensions, Modal, Alert, ScrollView, Linking, Keyboard, ActivityIndicator, BackHandler, AppState, Image, Animated, KeyboardAvoidingView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import MapLibreView from '../../components/MapLibreView';
import { useStripe } from '../../components/StripeImports';
import RazorpayCheckout from '../../components/RazorpayCheckout';
import razorpayService from '../../services/razorpayService';
import { registerForPushNotificationsAsync } from '../../services/notifications';

import { io, Socket } from 'socket.io-client';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import * as Speech from 'expo-speech';
import { Ionicons } from '@expo/vector-icons';
import { BlueprintTheme, BlueprintColors } from '../../constants/BlueprintTheme';
import apiClient from '../../api/client';
import { startBackgroundLocation, stopBackgroundLocation, onBackgroundLocation } from '../../services/backgroundLocation';
import { cacheRouteCorridor, clearOfflinePack } from '../../services/offlineTileCache';
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

export default function FinderDashboard() {
  const router = useRouter();
  const mapRef = useRef<any>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [step, setStep] = useState<AppStep>('home');
  const [navCountdown, setNavCountdown] = useState<number | null>(null);
  const [showUPIInline, setShowUPIInline] = useState(false);
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
  const [arrivalDetected, setArrivalDetected] = useState(false);
  const [simulatedLocation, setSimulatedLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number, longitude: number }[]>([]);
  const [altRoutes, setAltRoutes] = useState<Array<{ coords: Array<{ latitude: number; longitude: number }>; duration: number; distance: number }>>([]);
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
  const [chatOpen, setChatOpen] = useState(false);



  const { isInPipMode: isInPip } = ExpoPip.useIsInPip();

  // Ensure the backend's active role matches this dashboard so Finder actions
  // (price calculation, booking, cancel, etc.) are authorized. Finding requires
  // no registration, so this is safe and idempotent.
  useEffect(() => {
    apiClient.post('/auth/switch-role', { newRole: 'FINDER' }).catch(() => {});
  }, []);

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
  const lastNearbyFetch = useRef(0);
  const lastRouteFetch = useRef(0);
  const lastRouteDest = useRef<string | null>(null);
  const lastRouteFetchPos = useRef<{ lat: number; lng: number } | null>(null);
  const lastUpdateCoords = useRef({ lat: 0, lng: 0 });
  const lastRerouteTime = useRef(0);
  const lastVoiceInstruction = useRef('');
  const lastVoiceDistance = useRef(0);
  const isMutedRef = useRef(false);


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
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  const [selectedExtendHours, setSelectedExtendHours] = useState(1);
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
        if (userLocation && mapRef.current) {
          mapRef.current.animateCamera({
            center: { latitude: userLocation.lat, longitude: userLocation.lng },
            zoom: 17, pitch: 60, heading: 0
          }, { duration: 1200 });
        }
        centerRoute();
        if (routeCoords.length > 0) {
          setSimulatedLocation({ lat: routeCoords[0].latitude, lng: routeCoords[0].longitude });
        }
        setIsFollowing(true);
        setStep('en_route');
        // Phase 3: Start background location + cache tiles
        startBackgroundLocation().catch(() => {});
        if (routeCoords.length > 2) {
          const styleUrl = mapStyleConfig.provider === 'ola' ? mapStyleConfig.styleUrl : undefined;
          cacheRouteCorridor(routeCoords, styleUrl).catch(() => {});
        }
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
  const [mockSimulatorApp, setMockSimulatorApp] = useState<'gpay' | 'phonepe' | 'paytm' | 'upi' | null>(null);
  const [mockSimulatorOrderId, setMockSimulatorOrderId] = useState<string | null>(null);

  const executeUPIVerification = async (orderId: string) => {
    setIsUPIProcessing(true);
    setMockSimulatorApp(null);
    try {
      const verification = await razorpayService.verifyPayment({
        bookingId: Number(bookingDetails?.id),
        razorpay_order_id: orderId,
        razorpay_payment_id: `pay_mock_upi_${Date.now()}`,
        razorpay_signature: 'mock_upi_intent',
      });
      if (verification.success) {
        setStep('receipt');
      } else {
        Alert.alert('Verification Failed', 'Could not confirm payment signature.');
      }
    } catch (verErr: any) {
      Alert.alert('Verification Error', verErr.message || 'Failed to verify payment with server.');
    } finally {
      setIsLoading(false);
      setIsUPIProcessing(false);
      setMockSimulatorOrderId(null);
    }
  };

  const [spots, setSpots] = useState<Spot[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSlotLoading, setIsSlotLoading] = useState(false);
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

  // Haversine distance in km
  const getDistanceKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  useEffect(() => {
    let locationSub: Location.LocationSubscription | null = null;

    if (step === 'en_route' && selectedSpotId) {
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

            // Use GPS heading when moving, keep last heading when stationary
            if (isMoving && loc.coords.heading != null && loc.coords.heading >= 0) {
              lastAnimatedHeading.current = smoothHeading(loc.coords.heading, lastAnimatedHeading.current, 0.35);
            }

            setNavigationData({
              speed: isMoving ? rawSpeed : 0,
              heading: lastAnimatedHeading.current
            });

            // Calculate remaining distance along actual route
            const straightKm = getDistanceKm(coords.lat, coords.lng, spot.lat, spot.lng);
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
              apiClient.get(`/maps/route?start=${coords.lng},${coords.lat}&end=${spot.lng},${spot.lat}&alternatives=false`)
                .then((rRes: any) => {
                  if (rRes.data.success) {
                    const rRoute = rRes.data.data.routes?.[0];
                    if (rRoute?.legs?.[0]?.steps) {
                      routeStepsRef.current = rRoute.legs[0].steps;
                      // Update traffic segments
                      const segs: Array<{ coords: Array<[number, number]>; congestion: 'low' | 'moderate' | 'heavy' | 'severe' }> = [];
                      for (const s of rRoute.legs[0].steps) {
                        if (s.geometry?.coordinates && s.geometry.coordinates.length >= 2 && s.duration > 0) {
                          const segSpd = (s.distance / s.duration) * 3.6;
                          let cong: 'low' | 'moderate' | 'heavy' | 'severe' = 'low';
                          if (segSpd < 10) cong = 'severe';
                          else if (segSpd < 25) cong = 'heavy';
                          else if (segSpd < 45) cong = 'moderate';
                          segs.push({ coords: s.geometry.coordinates, congestion: cong });
                        }
                      }
                      setTrafficSegments(segs);
                    }
                    if (rRoute) {
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

                    Speech.speak(voiceText, { rate: 1.0, pitch: 1.0, language: ttsLang });
                  }
                }
              }
            }

            // Arrival detection: within ~100m straight-line OR < 100m remaining on route
            if (straightKm < 0.1 || remainingKm < 0.1) {
              setArrivalDetected(true);
              setIsFollowing(false);
              if (!isMutedRef.current) {
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
          console.error("GPS Watch Error:", e);
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
        clearOfflinePack().catch(() => {});
        Speech.stop();
      };
    } else if (!['arriving'].includes(step)) {
      // Don't reset arrivalDetected when transitioning to 'arriving' (check-in flow)
      setArrivalDetected(false);
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

    if (destination && userLocation && (isActiveNav || isNewDest) && (now - lastRouteFetch.current > 4000 || isNewDest) && movedEnough) {
      lastRouteFetch.current = now;
      lastRouteDest.current = destId;
      lastRouteFetchPos.current = { lat: userLocation.lat, lng: userLocation.lng };
      (async () => {
        try {
          console.log(`[API] Fetching route from ${userLocation.lat},${userLocation.lng} to ${destination.lat},${destination.lng}`);
          const isNav = ['en_route', 'navigating', 'arriving'].includes(step);
          const res = await apiClient.get(`/maps/route?start=${userLocation.lng},${userLocation.lat}&end=${destination.lng},${destination.lat}&alternatives=${!isNav}`);
          if (res.data.success) {
            const routes = res.data.data.routes || [];
            // Never trust provider ordering blindly: pick the FASTEST route
            // (min duration; ties broken by distance) — the rest stay as
            // selectable grey alternatives.
            const route = [...routes].sort(
              (a: any, b: any) => (a.duration - b.duration) || (a.distance - b.distance)
            )[0];
            if (!route) return;
            console.log(`[API] Route found! ${route.geometry.coordinates.length} points. ${routes.length} alternatives. Best: ${(route.distance / 1000).toFixed(1)}km/${Math.ceil(route.duration / 60)}min`);
            setRouteCoords(route.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })));
            setDistanceInfo({ km: (route.distance / 1000).toFixed(1), mins: Math.ceil(route.duration / 60).toString() });
            if (route.legs?.[0]?.steps) {
              routeStepsRef.current = route.legs[0].steps;
              // Compute traffic segments from step-level speed data
              const steps = route.legs[0].steps;
              const segments: Array<{ coords: Array<[number, number]>; congestion: 'low' | 'moderate' | 'heavy' | 'severe' }> = [];
              for (const s of steps) {
                if (s.geometry?.coordinates && s.geometry.coordinates.length >= 2 && s.duration > 0) {
                  // Speed in km/h for this segment
                  const segSpeedKmh = (s.distance / s.duration) * 3.6;
                  let congestion: 'low' | 'moderate' | 'heavy' | 'severe' = 'low';
                  if (segSpeedKmh < 10) congestion = 'severe';
                  else if (segSpeedKmh < 25) congestion = 'heavy';
                  else if (segSpeedKmh < 45) congestion = 'moderate';
                  segments.push({ coords: s.geometry.coordinates, congestion });
                }
              }
              setTrafficSegments(segments);
              // Extract lane guidance for first meaningful step
              const firstLaneStep = steps.find((s: any) => s.lanes && s.lanes.length > 0);
              if (firstLaneStep) setLaneGuidance(firstLaneStep.lanes);
              else setLaneGuidance([]);
            }
            // Store alternative routes (skip first — that's the primary)
            if (!isNav && routes.length > 1) {
              setAltRoutes(routes.slice(1).map((r: any) => ({
                coords: r.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })),
                duration: r.duration,
                distance: r.distance,
              })));
            } else {
              setAltRoutes([]);
            }
          }
        } catch (e) {
          console.log("Route fetch throttled/failed");
        }
      })();
    } else if (!destination) {
      setRouteCoords([]);
      setAltRoutes([]);
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

        // 1. Race multiple location strategies — whichever resolves first wins
        const getLocationFast = async (): Promise<{ lat: number; lng: number }> => {
          // Strategy A: Last known position (instant if available)
          const lastKnown = Location.getLastKnownPositionAsync({ maxAge: 120000 });
          
          // Strategy B: Fresh position with lowest accuracy (fast)
          const fresh = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Lowest });
          
          // Strategy C: Timeout fallback after 5 seconds — use a default so app doesn't hang
          const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));

          // Race: take whichever completes first
          const result = await Promise.race([
            lastKnown.then(loc => loc ? { lat: loc.coords.latitude, lng: loc.coords.longitude } : null),
            fresh.then(loc => ({ lat: loc.coords.latitude, lng: loc.coords.longitude })),
            timeout
          ]);

          if (result) return result;
          
          // If timeout hit, try one more time with Low accuracy
          const fallback = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
          return { lat: fallback.coords.latitude, lng: fallback.coords.longitude };
        };

        const coords = await getLocationFast();
        setUserLocation(coords);
        lastUpdateCoords.current = coords;
        fetchNearbySpots(coords.lat, coords.lng);

        // 2. Start continuous watch in parallel
        watchSub = await Location.watchPositionAsync({
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 2000,
          distanceInterval: 10,
        }, (l) => {
          const newCoords = { lat: l.coords.latitude, lng: l.coords.longitude };
          setUserLocation(newCoords);
        });

        headingSub = await Location.watchHeadingAsync((h) => {
          setDeviceHeading(h.trueHeading);
        });

        // Move camera to user location
        setTimeout(() => {
          if (mapRef.current) {
            mapRef.current.animateCamera({
              center: { latitude: coords.lat, longitude: coords.lng },
              pitch: 0,
              heading: 0,
              zoom: 17
            }, { duration: 1500 });
          }
        }, 800);

        try {
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
        } catch (e) {
          console.log('Error fetching initial spots', e);
          setSpots([]);
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
  }, []);

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

  const fetchNearbySpots = async (lat: number | string, lon: number | string, radius: number = 10) => {
    setIsNearbyLoading(true);
    try {
      const res = await apiClient.get(`/spots/nearby?lat=${lat}&lng=${lon}&radius=${radius}`);
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
    } catch (e) {
      console.log('Search API failed', e);
      setSpots([]);
    } finally {
      setIsNearbyLoading(false);
    }
  };

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
        const top = data[0];
        // Same rule as tapping a suggestion: NEVER use raw autocomplete
        // coordinates (location-biased). Resolve the top result through its
        // place_id; fall back to text geocoding. This was the second search
        // path (Enter key) that kept landing everything in Bangalore.
        let rLat = NaN;
        let rLon = NaN;
        if (top.verified) {
          // Blended city result — coordinates are authoritative.
          rLat = parseFloat(top.lat);
          rLon = parseFloat(top.lon);
        }
        if ((isNaN(rLat) || !rLat) && top.place_id) {
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
        if (isNaN(rLat) || isNaN(rLon) || !rLat || !rLon) {
          const geo = await apiClient.get(`/maps/geocode?q=${encodeURIComponent(top.display_name || searchQuery)}`);
          if (geo.data?.success && geo.data.data) {
            rLat = parseFloat(geo.data.data.lat);
            rLon = parseFloat(geo.data.data.lon);
            console.log(`[Search] (submit) Resolved "${top.display_name || searchQuery}" via geocode -> ${rLat},${rLon}`);
          }
        }
        if (isNaN(rLat) || isNaN(rLon) || !rLat || !rLon) {
          throw new Error('No results');
        }

        setSearchedPlace({ lat: rLat, lng: rLon, title: top.display_name || searchQuery });
        setStep('home');
        if (mapRef.current) {
          mapRef.current.animateCamera({
            center: { latitude: rLat, longitude: rLon },
            zoom: 13
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
    if (!item.isInternal && !item.verified) {
      if (item.place_id) {
        try {
          const det = await apiClient.get(`/maps/place-details?place_id=${encodeURIComponent(item.place_id)}`);
          if (det.data?.success && det.data.data) {
            lat = parseFloat(det.data.data.lat);
            lon = parseFloat(det.data.data.lon);
            console.log(`[Search] Resolved "${name}" via place_id -> ${lat},${lon}`);
          }
        } catch (e) {
          console.log('[Search] Place details failed:', (e as any)?.message);
        }
      }
      // No place_id (or resolution failed): never trust the biased
      // autocomplete coords — geocode the display text instead.
      if (!item.place_id || !lat || !lon || isNaN(lat) || isNaN(lon)) {
        try {
          const geo = await apiClient.get(`/maps/geocode?q=${encodeURIComponent(name)}`);
          if (geo.data?.success && geo.data.data) {
            lat = parseFloat(geo.data.data.lat);
            lon = parseFloat(geo.data.data.lon);
            console.log(`[Search] Resolved "${name}" via geocode -> ${lat},${lon}`);
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
    setSearchQuery(name);
    setSuggestions([]);
    setIsSearching(false);
    setSearchFocused(false);
    Keyboard.dismiss();

    // First: show the destination pin on the map
    setSearchedPlace({ lat, lng: lon, title: name });
    setStep('home');
    setIsFollowing(false);
    if (mapRef.current) {
      mapRef.current.animateCamera({
        center: { latitude: lat, longitude: lon },
        zoom: 13
      }, { duration: 1200 });
    }
    // Then: fetch all available spots in that area
    await fetchNearbySpots(lat, lon, 1000);
  };


  const centerRoute = () => {
    if (userLocation && selectedSpotId) {
      const spot = spots.find(s => s.id === selectedSpotId);
      if (spot && spot.lat && spot.lng) {
        if (mapRef.current) {
          mapRef.current.animateCamera({
            center: {
              latitude: (userLocation.lat + spot.lat) / 2,
              longitude: (userLocation.lng + spot.lng) / 2
            },
            zoom: 15
          });
        }
      }
    }
  };

  const recenterCamera = () => {
    setIsFollowing(true); // The map component will fly to userLocation automatically when isFollowing=true
  };

  useEffect(() => {
    let pollInterval: any;
    if (['arriving', 'checkout_verification'].includes(step) && bookingDetails?.id) {
      pollInterval = setInterval(async () => {
        try {
          const res = await apiClient.get('/bookings/my-bookings');
          if (res.data?.success) {
            const currentBooking = res.data.data.find((b: any) => b.id === bookingDetails?.id);
            if (currentBooking) {
              if (step === 'arriving' && (currentBooking.status === 'active' || currentBooking.status === 'occupied')) {
                setBookingDetails({ ...bookingDetails, ...currentBooking });
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                setStep('active_parking');
                clearInterval(pollInterval);
              } else if (step === 'checkout_verification' && currentBooking.status === 'completed') {
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
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExtendStay = async () => {
    if (!bookingDetails?.id) return;
    setIsExtending(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await apiClient.put(`/bookings/${bookingDetails.id}/extend`, {
        additionalHours: selectedExtendHours
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
      
      const orderId = res.data.order_id;
      const amountInRupees = (res.data.amount / 100).toFixed(2);
      
      const upiId = 'parkstop@razorpay';
      const pn = 'ParkStop';
      const upiQuery = `pa=${upiId}&pn=${encodeURIComponent(pn)}&am=${amountInRupees}&cu=INR&tr=${orderId}&tn=ParkStop%20Booking%20${bookingDetails?.id}`;
      
      let upiUrl = '';
      if (app === 'gpay') {
        upiUrl = `gpay://upi/pay?${upiQuery}`;
      } else if (app === 'phonepe') {
        upiUrl = `phonepe://upi/pay?${upiQuery}`;
      } else if (app === 'paytm') {
        upiUrl = `paytmmp://upi/pay?${upiQuery}`;
      } else {
        upiUrl = `upi://pay?${upiQuery}`;
      }

      console.log(`[UPI Launch] Opening deep-link: ${upiUrl}`);
      
      let canOpen = false;
      try {
        canOpen = await Linking.canOpenURL(upiUrl);
      } catch (e) {
        console.log("canOpenURL check failed", e);
      }

      if (canOpen) {
        try {
          await Linking.openURL(upiUrl);
          // Wait 3.5 seconds to simulate returning to app after checkout
          setIsUPIProcessing(true);
          setTimeout(() => {
            executeUPIVerification(orderId);
          }, 3500);
        } catch (err) {
          console.log("openURL failed despite canOpen=true", err);
          setMockSimulatorOrderId(orderId);
          setMockSimulatorApp(app);
        }
      } else {
        // Mock fallback simulator
        console.log("UPI App not installed. Triggering Mock Simulator.");
        setMockSimulatorOrderId(orderId);
        setMockSimulatorApp(app);
      }

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
    setRazorpayOrder(null);
    Alert.alert('Payment Cancelled', 'You cancelled the payment transaction.');
  };

  const handleRazorpayFailure = (error: string) => {
    setIsRazorpayVisible(false);
    setRazorpayOrder(null);
    Alert.alert('Payment Failed', error || 'Failed to complete transaction.');
  };

  const isBottomPanelFull = ['arriving', 'active_parking', 'payment', 'receipt'].includes(step);
  const showRoute = ['navigating', 'en_route', 'booking_confirm', 'home'].includes(step);

  // Removed welcome auto-transition


  // Fetch slot data when a spot is selected
  const fetchSlots = async (spotId: string) => {
    setIsSlotLoading(true);
    setSlotData([]);
    try {
      const res = await apiClient.get(`/spots/${spotId}/slots`);
      if (res.data.success) setSlotData(res.data.data);
    } catch (err) {
      console.error("Fetch slots error:", err);
      setSlotData([]);
    } finally {
      setIsSlotLoading(false);
    }
  };
  const handleCreateBooking = async (method: 'online' | 'cash') => {
    if (!selectedSpotId) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setIsLoading(true);
    setSearchedPlace(null);
    setShowPaymentMethodModal(false);
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
                  { label: 'Sedan', image: require('../../assets/images/vehicles/sedan.png') },
                  { label: 'SUV', image: require('../../assets/images/vehicles/suv.png') },
                  { label: 'Hatchback', image: require('../../assets/images/vehicles/hatchback.png') },
                  { label: 'Minivan', image: require('../../assets/images/vehicles/minivan.png') },
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
                        try { await apiClient.post('/auth/logout'); } catch(e) {}
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
                  <Text style={{ fontSize: 32, marginBottom: 8 }}>😕</Text>
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>No spots found</Text>
                  <Text style={{ color: '#64748b', marginTop: 4, fontSize: 13 }}>Try searching a different area</Text>
                </View>
              )}
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>

          {!hasLocationPermission && (
            <View style={{ position: 'absolute', bottom: 120, left: 20, right: 20, zIndex: 100, padding: 16, backgroundColor: 'rgba(239, 68, 68, 0.08)', borderRadius: 20, borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.2)', alignItems: 'center' }}>
              <Ionicons name="warning" size={24} color="#ef4444" style={{ marginBottom: 8 }} />
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800', marginBottom: 4 }}>GPS Access Denied</Text>
              <TouchableOpacity onPress={() => Linking.openSettings()} style={{ backgroundColor: '#ef4444', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}>
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 11 }}>Open Settings</Text>
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
            markers={spots}
            routeCoords={showRoute ? routeCoords.slice(currentRouteIndex) : []}
            altRoutes={showRoute ? altRoutes : []}
            onSelectAltRoute={(index: number) => {
              const alt = altRoutes[index];
              if (alt) {
                setRouteCoords(alt.coords);
                setDistanceInfo({ km: (alt.distance / 1000).toFixed(1), mins: Math.ceil(alt.duration / 60).toString() });
                setAltRoutes([]);
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
            isMuted={isMuted}
            onMapPress={(coords: [number, number]) => {
              fetchNearbySpots(coords[1], coords[0]);
            }}
            nextInstruction={currentInstruction.turn}
            speed={navigationData.speed}
            heading={navigationData.heading}
            userLocation={(simulatedLocation || userLocation) || undefined}
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
              console.log(`[NAV] Off-route detected at ${lat},${lng} — rerouting...`);
              if (!isMuted) Speech.speak(navLanguage === 'hi-IN' ? 'Naya raasta dhundh rahe hain' : 'Rerouting', { rate: 1.1, pitch: 1.0, language: navLanguage });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
              (async () => {
                try {
                  const res = await apiClient.get(`/maps/route?start=${lng},${lat}&end=${dest.lng},${dest.lat}&alternatives=false`);
                  if (res.data.success) {
                    const route = res.data.data.routes?.[0];
                    if (route) {
                      setRouteCoords(route.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })));
                      setDistanceInfo({ km: (route.distance / 1000).toFixed(1), mins: Math.ceil(route.duration / 60).toString() });
                      if (route.legs?.[0]?.steps) routeStepsRef.current = route.legs[0].steps;
                      setIsFollowing(true);
                      console.log(`[NAV] Rerouted! ${route.geometry.coordinates.length} points`);
                    }
                  }
                } catch (e) {
                  console.warn('[NAV] Reroute failed', e);
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
                mapRef.current.animateCamera({
                  center: { latitude: spot.lat, longitude: spot.lng },
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

          {/* Floating OTP Badge — only on arrival, not during navigation */}
        </View>
      )}

      {/* Google Maps Style Instruction Banner */}

      {/* FLOATING BACK/HOME BUTTON — rendered AFTER map so it sits on top of WebView */}
      {['spot_booking', 'en_route', 'navigating', 'arriving', 'booking_confirm', 'active_parking', 'checkout_verification', 'payment'].includes(step) && (
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
          }}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
      )}
      {/* Directions Banner / Arrival Banner */}
      {['navigating', 'en_route', 'arriving'].includes(step) && !isInPip && (
        arrivalDetected ? (
          /* ── Arrival banner with Check In button ── */
          <View style={{ position: 'absolute', top: 50, left: 16, right: 16, backgroundColor: '#0f172a', borderRadius: 24, padding: 20, alignItems: 'center', shadowColor: '#10b981', shadowOpacity: 0.4, shadowRadius: 20, zIndex: 1000, borderWidth: 1.5, borderColor: 'rgba(16,185,129,0.4)' }}>
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
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, maxHeight: '85%', backgroundColor: '#0f172a', borderTopLeftRadius: 28, borderTopRightRadius: 28, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 30, elevation: 20, zIndex: 1000, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
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
            ) : (
              <View style={{ alignItems: 'center', padding: 20, marginBottom: 16 }}>
                <Text style={{ color: '#f43f5e', fontSize: 13, fontWeight: '700' }}>No slots available</Text>
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
                      { label: 'Sedan', image: require('../../assets/images/vehicles/sedan.png') },
                      { label: 'SUV', image: require('../../assets/images/vehicles/suv.png') },
                      { label: 'Hatchback', image: require('../../assets/images/vehicles/hatchback.png') },
                      { label: 'Minivan', image: require('../../assets/images/vehicles/minivan.png') },
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

          {step === 'en_route' && !isInPip && (
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
                        // Recenter map to user location before starting navigation
                        if (userLocation && mapRef.current) {
                          mapRef.current.animateCamera({
                            center: { latitude: userLocation.lat, longitude: userLocation.lng },
                            zoom: 17,
                            pitch: 60,
                            heading: 0
                          }, { duration: 1200 });
                        }
                        centerRoute();
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
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4, letterSpacing: -0.5 }}>Check-Out Verification</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 20, fontWeight: '500', lineHeight: 18 }}>
                      Show this exit code to the spot owner before leaving.
                    </Text>

                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 16 }}>
                      <View style={{ alignItems: 'center', backgroundColor: 'rgba(99,102,241,0.08)', padding: 24, borderRadius: 20, borderWidth: 1.5, borderColor: 'rgba(99,102,241,0.2)', marginBottom: 16 }}>
                        <Text style={{ color: '#818cf8', fontWeight: '800', fontSize: 10, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1.5 }}>Exit OTP</Text>
                        <Text selectable={true} style={{ color: '#fff', fontWeight: '900', fontSize: 40, letterSpacing: 8 }}>{bookingDetails?.checkoutOtp || bookingDetails?.checkout_otp || '----'}</Text>
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
                          const res = await apiClient.put(`/bookings/${bookingDetails.id}/finder-checkout`);
                          if (res.data?.success) {
                            setBookingDetails(prev => prev ? {
                              ...prev,
                              basePrice: res.data.data.total_price,
                              finalAmount: res.data.data.total_price,
                              ...res.data.data
                            } : prev);
                            setStep('payment');
                          }
                        } catch (e: any) {
                          Alert.alert('Checkout Failed', e.response?.data?.message || 'Unable to complete checkout.');
                        } finally {
                          setIsLoading(false);
                        }
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{isLoading ? 'Processing...' : 'Complete Checkout'}</Text>
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
                          setShowUPIInline(!showUPIInline);
                        } else {
                          processPayment();
                        }
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>
                        {isLoading ? 'Processing...' : (selectedPaymentMethod === 'cash' ? 'Complete Checkout' : 'Proceed to Payment')}
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
                        setParkingHours(1);
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
      <Modal visible={!!mockSimulatorApp} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: mockSimulatorApp === 'phonepe' ? '#5f259f' : mockSimulatorApp === 'paytm' ? '#00baf2' : mockSimulatorApp === 'gpay' ? '#1A73E8' : '#0f172a', justifyContent: 'center', padding: 20 }}>
          <View style={{ alignItems: 'center', marginBottom: 40 }}>
            {mockSimulatorApp === 'phonepe' && <Text style={{ color: '#fff', fontSize: 48, fontWeight: '900', marginBottom: 10 }}>पे</Text>}
            {mockSimulatorApp === 'paytm' && <Text style={{ color: '#0f172a', fontSize: 32, fontWeight: '900', fontStyle: 'italic', backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 4, borderRadius: 8, overflow: 'hidden' }}>Pay<Text style={{ color: '#00baf2' }}>tm</Text></Text>}
            {mockSimulatorApp === 'gpay' && <Image source={{ uri: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c1/Google_%22G%22_logo.svg/120px-Google_%22G%22_logo.svg.png' }} style={{ width: 60, height: 60, backgroundColor: '#fff', borderRadius: 30, marginBottom: 10 }} />}
            {mockSimulatorApp === 'upi' && <Text style={{ color: '#fff', fontSize: 36, fontWeight: '900', fontStyle: 'italic' }}>UPI</Text>}
            <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700', marginTop: 20 }}>Test Environment</Text>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 16, textAlign: 'center', marginTop: 10 }}>The app {mockSimulatorApp} is not installed or unavailable. You are viewing the mock simulator fallback.</Text>
          </View>
          
          <View style={{ backgroundColor: '#fff', borderRadius: 24, padding: 24, elevation: 10 }}>
            <Text style={{ color: '#64748b', fontSize: 14, fontWeight: '600', textAlign: 'center' }}>Amount to Pay</Text>
            <Text style={{ color: '#0f172a', fontSize: 40, fontWeight: '900', textAlign: 'center', marginVertical: 10 }}>₹{bookingDetails?.totalPrice || bookingDetails?.total_price || bookingDetails?.pricing?.finalPrice || '0.00'}</Text>
            
            <TouchableOpacity 
              style={{ backgroundColor: mockSimulatorApp === 'phonepe' ? '#5f259f' : mockSimulatorApp === 'paytm' ? '#00baf2' : mockSimulatorApp === 'gpay' ? '#1A73E8' : '#16a34a', paddingVertical: 18, borderRadius: 16, alignItems: 'center', marginTop: 20 }}
              onPress={() => {
                if (mockSimulatorOrderId) {
                  executeUPIVerification(mockSimulatorOrderId);
                }
              }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Complete Mock Payment</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={{ paddingVertical: 18, alignItems: 'center', marginTop: 10 }}
              onPress={() => {
                setMockSimulatorApp(null);
                setMockSimulatorOrderId(null);
                setIsLoading(false);
              }}
            >
              <Text style={{ color: '#64748b', fontSize: 16, fontWeight: '700' }}>Cancel Payment</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

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
          <View style={[styles.chatModal, BlueprintTheme.glassCard, { height: 350, padding: 24, borderRadius: 32 }]}>
            <View style={styles.chatHeader}>
              <Text style={styles.chatTitle}>Extend Your Stay</Text>
              <TouchableOpacity onPress={() => setExtendModalOpen(false)}>
                <Text style={styles.chatClose}>Cancel</Text>
              </TouchableOpacity>
            </View>
            <View style={{ flex: 1, paddingVertical: 10, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', marginBottom: 18, fontWeight: '500' }}>
                Select additional hours to add to your reservation:
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, marginBottom: 24 }}>
                {[1, 2, 3, 4].map(h => (
                  <TouchableOpacity
                    key={h}
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setSelectedExtendHours(h);
                    }}
                    style={{
                      width: 60, height: 60, borderRadius: 16,
                      backgroundColor: selectedExtendHours === h ? '#6366f1' : 'rgba(255,255,255,0.05)',
                      alignItems: 'center', justifyContent: 'center',
                      borderWidth: 2, borderColor: selectedExtendHours === h ? '#6366f1' : 'rgba(255,255,255,0.08)'
                    }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '900', fontSize: 16 }}>+{h}h</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <TouchableOpacity
                disabled={isExtending}
                onPress={handleExtendStay}
                style={[BlueprintTheme.buttonPrimary, { width: '100%', height: 52, borderRadius: 16, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 }]}
              >
                {isExtending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={BlueprintTheme.buttonPrimaryText}>Confirm Extension</Text>
                )}
              </TouchableOpacity>
            </View>
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
