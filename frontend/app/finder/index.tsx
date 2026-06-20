import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Platform, TouchableOpacity, TextInput, Dimensions, Modal, Alert, ScrollView, Linking, Keyboard, ActivityIndicator, BackHandler, AppState, Image, Animated } from 'react-native';
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
import { Ionicons } from '@expo/vector-icons';
import { BlueprintTheme, BlueprintColors } from '../../constants/BlueprintTheme';
import apiClient from '../../api/client';

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

type Spot = {
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

type PricingBreakdown = {
  id?: string;
  time: number;
  location: number;
  demand: number;
  finalPrice: number;
  multiplier: number;
};

type AppStep = 'vehicle_select' | 'choice' | 'nearby_list' | 'search' | 'spot_detail' | 'slot_select' | 'time_select' | 'booking_confirm' | 'navigating' | 'en_route' | 'arriving' | 'active_parking' | 'checkout_verification' | 'payment' | 'receipt';

function SkeletonCard({ width, height, style }: { width?: any, height?: any, style?: any }) {
  const fadeAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(fadeAnim, {
          toValue: 0.8,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(fadeAnim, {
          toValue: 0.4,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [fadeAnim]);

  return (
    <Animated.View
      style={[
        {
          width: width || '100%',
          height: height || 80,
          backgroundColor: 'rgba(255, 255, 255, 0.08)',
          borderRadius: 16,
          opacity: fadeAnim,
        },
        style,
      ]}
    />
  );
}

export default function FinderDashboard() {
  const router = useRouter();
  const mapRef = useRef<any>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [step, setStep] = useState<AppStep>('vehicle_select');
  const [vehicleType, setVehicleType] = useState<string>('');
  const [vehicleSubType, setVehicleSubType] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<string>('');
  const [parkingHours, setParkingHours] = useState<number>(1);
  const [parkingMinutes, setParkingMinutes] = useState<number>(0);
  const [isLongParking, setIsLongParking] = useState(false);
  const [parkingEndDate, setParkingEndDate] = useState<string>('');
  const [calculatedPrice, setCalculatedPrice] = useState<number | null>(null);
  const [isCalculatingPrice, setIsCalculatingPrice] = useState(false);
  const [slotData, setSlotData] = useState<Array<{ name: string; status: string }>>([]);
  const [arrivalDetected, setArrivalDetected] = useState(false);
  const [simulatedLocation, setSimulatedLocation] = useState<{ lat: number, lng: number } | null>(null);
  const [routeCoords, setRouteCoords] = useState<{ latitude: number, longitude: number }[]>([]);
  const [currentRouteIndex, setCurrentRouteIndex] = useState(0);
  const [distanceInfo, setDistanceInfo] = useState({ miles: '0', mins: '0' });
  const [currentInstruction, setCurrentInstruction] = useState({ turn: '', street: '', icon: '' });
  const routeStepsRef = useRef<any[]>([]);
  const [chatOpen, setChatOpen] = useState(false);



  const { isInPipMode: isInPip } = ExpoPip.useIsInPip();

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
  const [deviceHeading, setDeviceHeading] = useState(0);
  // Refs for GPS tracking logic
  const lastAnimatedHeading = useRef(0);
  const lastNearbyFetch = useRef(0);
  const lastRouteFetch = useRef(0);
  const lastRouteDest = useRef<string | null>(null);
  const lastUpdateCoords = useRef({ lat: 0, lng: 0 });


  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);
  const [bookingDetails, setBookingDetails] = useState<{ id: string, otp: string, total_price?: number, totalPrice?: number, pricing?: PricingBreakdown, checkout_otp?: string, checkoutOtp?: string, started_at?: string, created_at?: string, updated_at?: string, start_time?: string } | null>(null);
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [hasLocationPermission, setHasLocationPermission] = useState(true);
  const [extendModalOpen, setExtendModalOpen] = useState(false);
  const [selectedExtendHours, setSelectedExtendHours] = useState(1);
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
    const interval = setInterval(updateTimer, 30000); // update every 30 seconds

    return () => clearInterval(interval);
  }, [step, bookingDetails]);

  useEffect(() => {
    if (step !== 'time_select' || !selectedSpotId) return;
    
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
      try {
        const res = await apiClient.post('/bookings/calculate-price', {
          spot_id: parseInt(selectedSpotId, 10),
          start_time: new Date().toISOString(),
          end_time: end.toISOString(),
        });
        if (res.data.success) {
          setCalculatedPrice(res.data.data.total_price);
        }
      } catch (err) {
        console.error('Failed to calculate dynamic price', err);
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

  const [spots, setSpots] = useState<Spot[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSlotLoading, setIsSlotLoading] = useState(false);
  const [isNearbyLoading, setIsNearbyLoading] = useState(false);

  useEffect(() => {
    const backAction = () => {
      // 1. Navigation Steps: Prompt for exit, return to list on confirm
      if (['en_route', 'navigating', 'arriving'].includes(step)) {
        Alert.alert(
          'Exit Navigation',
          'Are you sure you want to exit navigation?',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Yes',
              onPress: () => {
                setStep('nearby_list');
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

      // 2. Booking Steps: Return to previous logical page
      if (step === 'time_select') {
        setStep('slot_select');
        return true;
      }
      if (step === 'slot_select') {
        setStep('spot_detail');
        return true;
      }
      if (step === 'spot_detail') {
        setStep('nearby_list');
        setSelectedSpotId(null);
        setSlotData([]);
        return true;
      }
      if (step === 'booking_confirm') {
        setStep('choice');
        return true;
      }

      // 3. Choice Step: Return to vehicle select
      if (step === 'choice') {
        setStep('vehicle_select');
        return true;
      }

      // 4. Vehicle Select: Do nothing (or let system handle exit)
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

      // 5. Search Step: Confirm before exiting map
      if (step === 'search') {
        Alert.alert('Exit Map', 'Do you want to go back to the main menu?', [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Yes', onPress: () => {
              setStep('choice');
              setSearchQuery('');
              setSearchedPlace(null);
              setSpots([]);
            }
          }
        ]);
        return true;
      }

      // 6. Nearby List: Return to choice
      if (step === 'nearby_list') {
        setStep('choice');
        setSearchQuery('');
        setSearchedPlace(null);
        return true;
      }

      // 6. Root Steps: Already handled in 4 (vehicle_select)
      return false; // Let default behavior happen for any unhandled states
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

      const startRealTracking = async () => {
        try {
          locationSub = await Location.watchPositionAsync({
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 1000,
            distanceInterval: 5,
          }, (loc) => {
            const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
            setSimulatedLocation(coords);
            setUserLocation(coords);

            const rawSpeed = loc.coords.speed || 0;
            const speedKmh = rawSpeed * 3.6;
            const isMoving = speedKmh > 3;

            // Use GPS heading when moving, keep last heading when stationary
            if (isMoving && loc.coords.heading != null && loc.coords.heading >= 0) {
              lastAnimatedHeading.current = smoothHeading(loc.coords.heading, lastAnimatedHeading.current, 0.35);
            }

            setNavigationData({
              speed: isMoving ? rawSpeed : 0,
              heading: lastAnimatedHeading.current
            });

            // Distance to destination via road factor (~1.3x straight-line in cities)
            const straightKm = getDistanceKm(coords.lat, coords.lng, spot.lat, spot.lng);
            const roadKm = straightKm * 1.3;
            const avgSpeedKmh = speedKmh > 8 ? speedKmh : 25; // Assume 25 km/h in city
            const etaMins = Math.max(1, Math.ceil((roadKm / avgSpeedKmh) * 60));

            setDistanceInfo({
              miles: roadKm.toFixed(1), // We display as "km" in the UI
              mins: etaMins.toString()
            });

            // Turn-by-turn: consume steps based on proximity to maneuver location
            const stepsArr = [...routeStepsRef.current];
            if (stepsArr.length > 0) {
              const activeStep = stepsArr[0];
              const maneuverLoc = activeStep?.maneuver?.location;

              // Calculate distance to the maneuver point
              let distToManeuver = Infinity;
              if (maneuverLoc) {
                distToManeuver = getDistanceKm(coords.lat, coords.lng, maneuverLoc[1], maneuverLoc[0]) * 1000; // in meters
              }

              // Pop step if within 30m of its maneuver point
              if (distToManeuver < 30 && stepsArr.length > 1) {
                stepsArr.shift();
                routeStepsRef.current = stepsArr;
              }

              if (activeStep?.maneuver) {
                const type = activeStep.maneuver.type;
                const modifier = activeStep.maneuver.modifier || '';
                const name = activeStep.name || '';
                let action = 'Continue straight';
                let icon = '⬆️';

                if (type === 'turn' || type === 'end of road' || type === 'fork') {
                  if (modifier.includes('sharp right')) { action = 'Sharp right'; icon = '↪️'; }
                  else if (modifier.includes('slight right')) { action = 'Slight right'; icon = '↗️'; }
                  else if (modifier.includes('right')) { action = 'Turn right'; icon = '➡️'; }
                  else if (modifier.includes('sharp left')) { action = 'Sharp left'; icon = '↩️'; }
                  else if (modifier.includes('slight left')) { action = 'Slight left'; icon = '↖️'; }
                  else if (modifier.includes('left')) { action = 'Turn left'; icon = '⬅️'; }
                  else if (modifier.includes('uturn')) { action = 'U-turn'; icon = '↩️'; }
                } else if (type === 'roundabout' || type === 'rotary') {
                  action = 'Enter roundabout'; icon = '🔄';
                } else if (type === 'merge') {
                  action = 'Merge'; icon = '↗️';
                } else if (type === 'arrive') {
                  action = 'You have arrived'; icon = '📍';
                }

                // Show distance to next maneuver
                const distText = distToManeuver < 1000
                  ? `In ${Math.round(distToManeuver)} m`
                  : `In ${(distToManeuver / 1000).toFixed(1)} km`;
                const streetText = name ? `${distText} • ${name}` : distText;

                setCurrentInstruction({ turn: action, street: streetText, icon });
              }
            }

            // Arrival detection: within ~50m
            if (straightKm < 0.05) {
              setArrivalDetected(true);
              setIsFollowing(false);
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

      return () => {
        if (locationSub) {
          try { locationSub.remove(); } catch (e) {}
        }
      };
    } else {
      setArrivalDetected(false);
      setSimulatedLocation(null);
      setDistanceInfo({ miles: '0', mins: '0' });
    }
  }, [step, selectedSpotId]);

  // Navigation Simulation disabled in favor of real-time GPS tracking
  useEffect(() => {
    if (['en_route', 'navigating', 'arriving'].includes(step) && routeCoords.length > 0) {
      console.log("[NAV] Navigation mode active. Waiting for GPS signal...");
    }
  }, [step, routeCoords]);
  useEffect(() => {
    const now = Date.now();
    const destination = selectedSpotId
      ? spots.find(s => s.id === selectedSpotId)
      : searchedPlace;

    const isActiveNav = ['en_route', 'navigating', 'arriving'].includes(step);
    const destId = destination ? String(('id' in destination ? (destination as any).id : '') || `${destination.lat},${destination.lng}`) : null;
    const isNewDest = destId !== lastRouteDest.current;

    if (destination && userLocation && (isActiveNav || isNewDest) && (now - lastRouteFetch.current > 4000 || isNewDest)) {
      lastRouteFetch.current = now;
      lastRouteDest.current = destId;
      (async () => {
        try {
          console.log(`[API] Fetching route from ${userLocation.lat},${userLocation.lng} to ${destination.lat},${destination.lng}`);
          const res = await apiClient.get(`/maps/route?start=${userLocation.lng},${userLocation.lat}&end=${destination.lng},${destination.lat}`);
          if (res.data.success) {
            const route = res.data.data.routes[0];
            console.log(`[API] Route found! ${route.geometry.coordinates.length} points.`);
            setRouteCoords(route.geometry.coordinates.map((p: any) => ({ latitude: p[1], longitude: p[0] })));
            setDistanceInfo({ miles: (route.distance / 1609.34).toFixed(1), mins: Math.ceil(route.duration / 60).toString() });
            if (route.legs?.[0]?.steps) routeStepsRef.current = route.legs[0].steps;
          }
        } catch (e) {
          console.log("Route fetch throttled/failed");
        }
      })();
    } else if (!destination) {
      setRouteCoords([]);
    }
  }, [selectedSpotId, searchedPlace, userLocation, spots, step]);


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

  // Instant Nearby Discovery: Populate suggestions with local places on load
  useEffect(() => {
    const now = Date.now();
    // Only fetch if we have no suggestions AND haven't searched AND moved significantly
    if (userLocation && suggestions.length === 0 && searchQuery === '' && (now - lastNearbyFetch.current > 10000)) {
      lastNearbyFetch.current = now;
      console.log("[API] Fetching nearby spots...");
      (async () => {
        try {
          const res = await apiClient.get(`/maps/search?q=parking&lat=${userLocation.lat}&lon=${userLocation.lng}`);
          if (res.data.success) {
            setSuggestions(res.data.data.slice(0, 5));
          }
        } catch (e) {
          console.log("Initial nearby fetch failed");
        }
      })();
    }
  }, [userLocation, searchQuery]);

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
            setStep('spot_detail');
            if (spots.length > 0) {
              setSelectedSpotId(spots[0].id);
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
        const { lat, lon } = data[0];
        setSearchedPlace({ lat: parseFloat(lat), lng: parseFloat(lon), title: searchQuery });
        setStep('search');
        if (mapRef.current) {
          mapRef.current.animateCamera({
            center: { latitude: parseFloat(lat), longitude: parseFloat(lon) },
            zoom: 13
          }, { duration: 1200 });
        }
        await fetchNearbySpots(parseFloat(lat), parseFloat(lon), 1000);
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
          setStep('search');
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

  const selectSuggestion = async (item: any) => {
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    const name = item.display_name;

    setSearchQuery(name);
    setSuggestions([]);
    Keyboard.dismiss();

    // First: show the destination pin on the map
    setSearchedPlace({ lat, lng: lon, title: name });
    setStep('search');
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
                setStep('active_parking');
                clearInterval(pollInterval);
              } else if (step === 'checkout_verification' && currentBooking.status === 'completed') {
                setBookingDetails({ ...bookingDetails, ...currentBooking });
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

  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const processPayment = async () => {
    if (!bookingDetails?.id) return;
    setIsLoading(true);
    try {
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
  const showRoute = ['navigating', 'en_route', 'booking_confirm', 'search'].includes(step);

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

  return (
    <SafeAreaView style={[BlueprintTheme.container, { backgroundColor: '#000' }]} edges={['top']}>
      
      {/* FLOATING PROFILE ACCESS */}
      {['choice', 'nearby_list', 'vehicle_select', 'search'].includes(step) && (
        <TouchableOpacity 
          style={styles.floatingProfileBtn} 
          onPress={() => router.push('/modal')}
        >
          <Ionicons name="person-circle" size={40} color="rgba(255,255,255,0.3)" />
        </TouchableOpacity>
      )}

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
                setStep('choice');
              }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Confirm Selection</Text>
            </TouchableOpacity>
          )}
        </LinearGradient>
      )}

      {/* STEP 3: CHOICE — NEARBY OR SEARCH */}
      {step === 'choice' && (
        <LinearGradient colors={['#0f172a', '#1e1b4b']} style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '900', textAlign: 'center', marginBottom: 8, letterSpacing: -0.5 }}>ParkStop Finder</Text>
          <Text style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', marginBottom: 32, fontWeight: '500' }}>Choose your parking journey</Text>

          <TouchableOpacity 
            activeOpacity={0.8}
            style={{ 
              backgroundColor: 'rgba(99,102,241,0.12)', 
              padding: 16, borderRadius: 20, marginBottom: 12, 
              borderWidth: 1, borderColor: 'rgba(99,102,241,0.4)', 
              flexDirection: 'row', alignItems: 'center'
            }} 
            onPress={() => { 
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setStep('nearby_list'); 
              if (userLocation) fetchNearbySpots(userLocation.lat, userLocation.lng); 
            }}>
            <LinearGradient colors={['#6366f1', '#4f46e5']} style={{ width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 20 }}>📍</Text>
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Nearby Spots</Text>
              <Text style={{ color: 'rgba(148, 163, 184, 0.8)', fontSize: 12, marginTop: 2 }}>Live availability</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#6366f1" />
          </TouchableOpacity>

          <TouchableOpacity 
            activeOpacity={0.8}
            style={{ 
              backgroundColor: 'rgba(255,255,255,0.03)', 
              padding: 16, borderRadius: 20, 
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', 
              flexDirection: 'row', alignItems: 'center' 
            }} 
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setStep('search');
            }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 20 }}>🔍</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Search Area</Text>
              <Text style={{ color: 'rgba(148, 163, 184, 0.8)', fontSize: 12, marginTop: 2 }}>Explore cities</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.2)" />
          </TouchableOpacity>

          <TouchableOpacity 
            activeOpacity={0.8}
            style={{ 
              backgroundColor: 'rgba(255,255,255,0.03)', 
              padding: 16, borderRadius: 20, marginTop: 12,
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', 
              flexDirection: 'row', alignItems: 'center' 
            }} 
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/modal');
            }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
              <Text style={{ fontSize: 20 }}>🔖</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Saved Spots</Text>
              <Text style={{ color: 'rgba(148, 163, 184, 0.8)', fontSize: 12, marginTop: 2 }}>Quickly book favorites</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.2)" />
          </TouchableOpacity>

          {!userLocation && hasLocationPermission && (
            <View style={{ marginTop: 24, alignItems: 'center' }}>
              <ActivityIndicator size="small" color="#6366f1" />
              <Text style={{ color: '#64748b', fontSize: 12, marginTop: 10, fontWeight: '600' }}>Calibrating GPS...</Text>
            </View>
          )}

          {!hasLocationPermission && (
            <View style={{ marginTop: 24, padding: 18, backgroundColor: 'rgba(239, 68, 68, 0.08)', borderRadius: 20, borderWidth: 1, borderColor: 'rgba(239, 68, 68, 0.2)', alignItems: 'center', width: '100%' }}>
              <Ionicons name="warning" size={32} color="#ef4444" style={{ marginBottom: 10 }} />
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800', textAlign: 'center', marginBottom: 6 }}>GPS Access Denied</Text>
              <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '500', textAlign: 'center', marginBottom: 14, lineHeight: 18 }}>Enable location permissions to automatically discover spots and navigate.</Text>
              <TouchableOpacity 
                activeOpacity={0.8}
                onPress={() => Linking.openSettings()}
                style={{ backgroundColor: '#ef4444', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 }}
              >
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>Open Settings</Text>
              </TouchableOpacity>
            </View>
          )}
        </LinearGradient>
      )}

      {/* STEP 4a: NEARBY SPOTS — Opaque Full-Screen List */}
      {step === 'nearby_list' && (
        <View style={{ flex: 1, backgroundColor: '#0f172a' }}>
          <LinearGradient colors={['#1e1b4b', '#0f172a']} style={{ padding: 20, paddingTop: Platform.OS === 'ios' ? 20 : 12, borderBottomLeftRadius: 32, borderBottomRightRadius: 32, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 15, elevation: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <TouchableOpacity 
                onPress={() => setStep('choice')} 
                style={{ 
                  backgroundColor: 'rgba(255,255,255,0.08)', 
                  width: 44, height: 44, borderRadius: 22, 
                  alignItems: 'center', justifyContent: 'center',
                  marginRight: 16
                }}>
                <Ionicons name="arrow-back" size={24} color="#fff" />
              </TouchableOpacity>
              <View>
                <Text style={{ color: '#fff', fontSize: 24, fontWeight: '900', letterSpacing: -0.5 }}>
                  Nearby Parking
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981', marginRight: 6 }} />
                  <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '700' }}>{spots.filter(s => s.available).length} spots found</Text>
                </View>
              </View>
            </View>
          </LinearGradient>

          <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1, padding: 16 }}>
            {isNearbyLoading ? (
              [1, 2, 3, 4].map(idx => (
                <View
                  key={idx}
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.02)',
                    borderRadius: 24, padding: 16, marginBottom: 12,
                    borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)',
                    flexDirection: 'row', alignItems: 'center'
                  }}
                >
                  <SkeletonCard width={48} height={48} style={{ borderRadius: 16, marginRight: 16 }} />
                  <View style={{ flex: 1, gap: 6 }}>
                    <SkeletonCard width="80%" height={16} style={{ borderRadius: 8 }} />
                    <SkeletonCard width="50%" height={12} style={{ borderRadius: 6 }} />
                  </View>
                  <SkeletonCard width={60} height={20} style={{ borderRadius: 10 }} />
                </View>
              ))
            ) : spots.length > 0 ? (
              spots.map(spot => (
                <TouchableOpacity
                  key={spot.id}
                  activeOpacity={0.8}
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.02)',
                    borderRadius: 24, padding: 16, marginBottom: 12,
                    borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)',
                    flexDirection: 'row', alignItems: 'center',
                    shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10
                  }}
                  onPress={() => {
                    if (!spot.available) {
                      Alert.alert('Spot Full', 'This parking spot is currently full and cannot be booked right now.');
                      return;
                    }
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                    setSelectedSpotId(spot.id);
                    setStep('spot_detail');
                    fetchSlots(spot.id);
                  }}
                >
                  <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(99,102,241,0.08)', alignItems: 'center', justifyContent: 'center', marginRight: 16, borderWidth: 1, borderColor: 'rgba(99,102,241,0.1)' }}>
                    <Ionicons name="navigate-circle" size={26} color="#6366f1" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900', marginBottom: 2 }}>{spot.title}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <Text style={{ color: '#10b981', fontWeight: '800', fontSize: 13 }}>₹{spot.price}<Text style={{ fontSize: 10, color: '#64748b' }}>/hr</Text></Text>
                      <View style={{ width: 3, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.15)', marginHorizontal: 8 }} />
                      <Ionicons name="location-outline" size={12} color="#94a3b8" style={{ marginRight: 2 }} />
                      <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '600' }}>{spot.distance} km</Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    <View style={{ backgroundColor: (spot.available_slots ?? 0) > 0 ? 'rgba(16,185,129,0.1)' : 'rgba(244,63,94,0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, borderWidth: 1, borderColor: (spot.available_slots ?? 0) > 0 ? 'rgba(16,185,129,0.2)' : 'rgba(244,63,94,0.2)' }}>
                      <Text style={{ color: (spot.available_slots ?? 0) > 0 ? '#10b981' : '#f43f5e', fontWeight: '900', fontSize: 9, textTransform: 'uppercase' }}>
                        {(spot.available_slots ?? 0) > 0 ? 'Available' : 'Full'}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="rgba(255,255,255,0.15)" />
                  </View>
                </TouchableOpacity>
              ))
            ) : (
              <View style={{ alignItems: 'center', marginTop: 100 }}>
                <Text style={{ fontSize: 40, marginBottom: 12 }}>😕</Text>
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800' }}>Sorry, no spots found</Text>
                <Text style={{ color: '#64748b', marginTop: 8, fontSize: 14, fontWeight: '500' }}>There are no parking spots available in this area.</Text>
              </View>
            )}
            <View style={{ height: 32 }} />
          </ScrollView>
        </View>
      )}

      {/* Map Rendering Container */}
      {!['welcome', 'vehicle_select'].includes(step) && (
        <View
          style={[
            styles.fullMapContainer,
            ['choice', 'nearby_list'].includes(step) ? { opacity: 0, zIndex: -10 } : {}
          ]}
          pointerEvents={['choice', 'nearby_list'].includes(step) ? 'none' : 'auto'}
        >
          <MapLibreView
            ref={mapRef}
            markers={spots}
            routeCoords={showRoute ? routeCoords.slice(currentRouteIndex) : []}
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
            onMuteToggle={() => setIsMuted(!isMuted)}
            onMarkerPress={(id: string) => {
              const spot = spots.find(s => s.id === id);
              if (spot && !spot.available) {
                Alert.alert('Spot Full', 'This parking spot is currently full and cannot be booked right now.');
                return;
              }
              setIsFollowing(false);
              setSelectedSpotId(id);
              fetchSlots(id);
              setStep('spot_detail');
              if (spot && mapRef.current) {
                mapRef.current.animateCamera({
                  center: { latitude: spot.lat, longitude: spot.lng },
                  zoom: 17
                }, { duration: 1000 });
              }
            }}
            onExit={() => {
              setStep('nearby_list');
              setSelectedSpotId(null);
              setSearchedPlace(null);
              setRouteCoords([]);
              setDistanceInfo({ miles: '0', mins: '0' });
              if (userLocation && mapRef.current) {
                mapRef.current.animateCamera({
                  center: { latitude: userLocation.lat, longitude: userLocation.lng },
                  zoom: 14
                });
              }
            }}
            hideControls={['spot_detail', 'choice'].includes(step)}
          />

          {/* Floating OTP Badge During Navigation/Parking */}
          {['navigating', 'en_route', 'arriving', 'active_parking'].includes(step) && bookingDetails?.otp && !isInPip && (
            <View style={{ position: 'absolute', top: 160, right: 16, backgroundColor: 'rgba(15,23,42,0.9)', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 10, zIndex: 99 }}>
              <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '800', marginBottom: 2 }}>CHECK-IN PIN</Text>
              <Text selectable={true} style={{ color: '#10b981', fontSize: 22, fontWeight: '900', letterSpacing: 4 }}>{bookingDetails.otp}</Text>
            </View>
          )}
        </View>
      )}

      {/* Google Maps Style Instruction Banner */}

      {/* FLOATING BACK/HOME BUTTON — rendered AFTER map so it sits on top of WebView */}
      {['search', 'spot_detail', 'en_route', 'navigating', 'arriving', 'booking_confirm', 'active_parking'].includes(step) && (
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
            if (['en_route', 'navigating', 'arriving'].includes(step)) {
              Alert.alert('Exit Navigation', 'Are you sure you want to exit navigation?', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Yes, Exit', onPress: () => {
                    setStep('nearby_list');
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
            } else if (['spot_detail', 'slot_select', 'time_select', 'booking_confirm'].includes(step)) {
              setStep('nearby_list');
              setSelectedSpotId(null);
              setSlotData([]);
            } else if (step === 'search') {
              Alert.alert('Exit Map', 'Do you want to go back to the main menu?', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Yes', onPress: () => {
                    setStep('choice');
                    setSearchQuery('');
                    setSearchedPlace(null);
                    setSpots([]);
                  }
                }
              ]);
            } else if (step === 'active_parking') {
              // Stay on active parking
            } else {
              setStep('choice');
            }
          }}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
      )}
      {['navigating', 'en_route', 'arriving'].includes(step) && !isInPip && (
        <View style={{ position: 'absolute', top: 50, left: 16, right: 16, backgroundColor: 'rgba(26,115,232,0.97)', borderRadius: 24, padding: 18, flexDirection: 'row', alignItems: 'center', shadowColor: '#1a73e8', shadowOpacity: 0.5, shadowRadius: 20, zIndex: 1000 }}>
          <View style={{ width: 56, height: 56, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 14 }}>
            <Text style={{ fontSize: 32 }}>{currentInstruction.icon || '⬆️'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#fff', fontSize: 20, fontWeight: '900' }} numberOfLines={1}>{currentInstruction.turn}</Text>
            <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '600', marginTop: 2 }} numberOfLines={1}>{currentInstruction.street}</Text>
          </View>
          <View style={{ width: 52, height: 52, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 26, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>{(navigationData.speed * 3.6).toFixed(0)}</Text>
            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 8, fontWeight: '800' }}>km/h</Text>
          </View>
        </View>
      )}

      {/* STEP 5: SPOT DETAIL BOTTOM SHEET */}
      {step === 'spot_detail' && (
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#0f172a', borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 32, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 30, elevation: 20, zIndex: 1000, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
          <View style={{ width: 40, height: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 2, alignSelf: 'center', marginBottom: 20 }} />

          {/* Spot Image Carousel */}
          {(() => {
            const currentSpot = spots.find(s => s.id === selectedSpotId);
            const imgs = currentSpot?.images || [];
            return imgs.length > 0 ? (
              <ScrollView 
                horizontal 
                pagingEnabled 
                showsHorizontalScrollIndicator={false}
                style={{ height: 160, borderRadius: 16, marginBottom: 20 }}
              >
                {imgs.map((imgUrl, idx) => (
                  <Image 
                    key={idx} 
                    source={{ uri: imgUrl }} 
                    style={{ width: width - 40, height: 160, borderRadius: 16 }} 
                    resizeMode="cover"
                  />
                ))}
              </ScrollView>
            ) : (
              <View style={{ height: 160, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 16, justifyContent: 'center', alignItems: 'center', marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
                <Ionicons name="image-outline" size={40} color="rgba(255,255,255,0.2)" />
                <Text style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12, marginTop: 8, fontWeight: '600' }}>No spot photos uploaded</Text>
              </View>
            );
          })()}

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: -0.5 }}>{spots.find(s => s.id === selectedSpotId)?.title}</Text>
              <Text style={{ color: '#94a3b8', fontSize: 13, marginTop: 4, fontWeight: '500' }}>Safe & monitored area</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity 
                onPress={async () => {
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  try {
                    const res = await apiClient.post(`/saved-spots/${selectedSpotId}/toggle`);
                    Alert.alert('Saved Spots', res.data.message);
                  } catch(e) {
                    Alert.alert('Error', 'Failed to save spot');
                  }
                }} 
                style={{ backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}
              >
                <Ionicons name="bookmark" size={16} color="#6366f1" />
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={() => setStep('nearby_list')} 
                style={{ backgroundColor: 'rgba(255,255,255,0.06)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 12 }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={{ backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 20, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.04)' }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
              <View>
                <Text style={{ color: '#64748b', fontWeight: '700', fontSize: 10, textTransform: 'uppercase' }}>Hourly Rate</Text>
                <Text style={{ color: '#fff', fontWeight: '900', fontSize: 18, marginTop: 2 }}>₹{spots.find(s => s.id === selectedSpotId)?.price}<Text style={{ fontSize: 11, color: '#94a3b8', fontWeight: '500' }}> / hr</Text></Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={{ color: '#64748b', fontWeight: '700', fontSize: 10, textTransform: 'uppercase' }}>Availability</Text>
                <Text style={{ color: '#10b981', fontWeight: '900', fontSize: 18, marginTop: 2 }}>{spots.find(s => s.id === selectedSpotId)?.available_slots} Bay(s)</Text>
              </View>
            </View>
            <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 8 }} />
            <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '500' }}>Instant check-in via OTP and 24/7 security.</Text>
          </View>

          <TouchableOpacity
            activeOpacity={0.9}
            style={{ 
              backgroundColor: '#6366f1', 
              paddingVertical: 18, borderRadius: 20, 
              alignItems: 'center',
            }}
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setStep('slot_select');
            }}
          >
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Select Slot</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* STEPS 4b onward: Map-based overlays */}
      {!['welcome', 'vehicle_select', 'choice', 'nearby_list', 'spot_detail'].includes(step) && (
        <>
          {/* Top Search Bar */}
          {['search'].includes(step) && !isInPip && (
            <View style={styles.floatingSearchContainer}>
              <View style={styles.searchBarWrapper}>
                <Ionicons name="search" size={20} color={BlueprintColors.textSecondary} style={{ marginRight: 10 }} />
                <TextInput
                  style={styles.searchBar}
                  placeholder="Search for a destination..."
                  placeholderTextColor={BlueprintColors.textSecondary}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  onSubmitEditing={handleSearch}
                  returnKeyType="search"
                />
                {searchQuery.length > 0 && (
                  <TouchableOpacity style={styles.clearSearchBtn} onPress={() => { setSearchQuery(''); setSuggestions([]); }}>
                    <Text style={{ color: BlueprintColors.textSecondary, fontSize: 18 }}>✕</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={handleSearch} style={{ padding: 8, marginLeft: 4, backgroundColor: '#4f46e5', borderRadius: 12, paddingHorizontal: 14 }}>
                  <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Search</Text>
                </TouchableOpacity>
                {isSearching && <View style={styles.searchLoader} />}
              </View>

              {suggestions.length > 0 && (
                <View style={styles.suggestionsContainer}>
                  <ScrollView style={{ maxHeight: 200 }} keyboardShouldPersistTaps="handled">
                    {suggestions.map((item, idx) => (
                      <TouchableOpacity 
                        key={idx}
                        style={styles.suggestionItem}
                        onPress={() => selectSuggestion(item)}
                      >
                        <View style={styles.suggestionIconCircle}>
                          <Text style={styles.suggestionIcon}>📍</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.suggestionTitle} numberOfLines={1}>{item.display_name?.split(',')[0] || item.display_name}</Text>
                          <Text style={styles.suggestionSub} numberOfLines={1}>{item.display_name}</Text>
                        </View>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}

              <TouchableOpacity style={{ marginTop: 12 }} onPress={() => { setStep('choice'); setSearchQuery(''); setSearchedPlace(null); setSuggestions([]); }}>
                <Text style={{ color: '#6366f1', fontWeight: '800', fontSize: 13 }}>Back to options</Text>
              </TouchableOpacity>
            </View>
          )}

          {step === 'en_route' && !isInPip && (
            <>

              {arrivalDetected && (
                <View style={styles.enRouteOverlay} pointerEvents="box-none">
                  <View style={styles.enRouteBanner}>
                    <View style={{ flex: 1, alignItems: 'center' }}>
                      <Text style={{ fontSize: 36, marginBottom: 4 }}>🎉</Text>
                      <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', textAlign: 'center' }}>You have reached your destination!</Text>
                      <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13, marginTop: 6, textAlign: 'center' }}>Park in Slot {selectedSlot} and show your check-in PIN to the spotter.</Text>
                    </View>
                    <TouchableOpacity style={[styles.continueBtn, { backgroundColor: '#10b981', marginTop: 12, paddingVertical: 14, paddingHorizontal: 28, borderRadius: 16 }]} onPress={() => setStep('arriving')}>
                      <Text style={[styles.continueBtnText, { fontSize: 16 }]}>Check In</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}

              <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#0f172a', borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingBottom: 40, paddingTop: 20, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 30, elevation: 30, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
                <View style={{ width: 48, height: 5, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 3, alignSelf: 'center', marginBottom: 20 }} />
                
                <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.05)', marginHorizontal: 32, borderRadius: 2, marginBottom: 24, overflow: 'hidden' }}>
                  <View style={{ height: '100%', backgroundColor: '#6366f1', width: '70%', borderRadius: 2 }} />
                </View>

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', paddingHorizontal: 20 }}>
                  <View style={{ alignItems: 'center' }}>
                    <Text style={{ color: '#fff', fontSize: 28, fontWeight: '900' }}>{distanceInfo.miles}</Text>
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
                            setStep('nearby_list');
                            setSelectedSpotId(null);
                            setRouteCoords([]);
                            setSimulatedLocation(null);
                            setArrivalDetected(false);
                            if (userLocation) fetchNearbySpots(userLocation.lat, userLocation.lng);
                          }
                        }
                      ]);
                    }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '900', fontSize: 16 }}>Exit</Text>
                  </TouchableOpacity>
                </View>
              </View>


            </>
          )}

          {step !== 'en_route' && !isInPip && (
            <View style={[styles.bottomPanelContainer, isBottomPanelFull && { bottom: 0, left: 0, right: 0 }]}>
              <View style={[BlueprintTheme.glassCard, isBottomPanelFull && { borderRadius: 0, borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingBottom: 40 }]}>

                {step === 'search' && (
                  <>
                    <Text style={styles.panelTitle}>Available Parking Spots Near My Location</Text>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={{ marginBottom: 16 }}
                      decelerationRate="fast"
                      snapToInterval={220} // Approximate width + margin of spotCard
                    >
                      {spots.length > 0 ? spots.map(spot => (
                        <TouchableOpacity
                          key={spot.id}
                          activeOpacity={0.7}
                          style={[styles.spotCard, selectedSpotId === spot.id && styles.activeSpotCard, { width: 200, marginRight: 16 }]}
                          onPress={() => {
                            if (!spot.available) {
                              Alert.alert('Spot Full', 'This parking spot is currently full and cannot be booked right now.');
                              return;
                            }
                            setSelectedSpotId(spot.id);
                            fetchSlots(spot.id);
                            setStep('spot_detail');
                            setIsFollowing(false);
                            if (mapRef.current) {
                              mapRef.current.animateCamera({
                                center: { latitude: spot.lat, longitude: spot.lng },
                                zoom: 17
                              }, { duration: 1000 });
                            }
                          }}
                        >
                          <Text style={styles.spotOwner} numberOfLines={1}>{spot.title}</Text>
                          <Text style={styles.spotDetails}>₹{spot.price.toFixed(2)}/hr</Text>
                          <Text style={[styles.statusText, { color: spot.available ? BlueprintColors.success : BlueprintColors.error }]}>
                            {spot.available ? '● Available' : '● Full'}
                          </Text>
                        </TouchableOpacity>
                      )) : (
                        <Text style={styles.descText}>Searching for nearby spots...</Text>
                      )}
                    </ScrollView>
                  </>
                )}

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

                      <View style={{ backgroundColor: 'rgba(99,102,241,0.05)', padding: 14, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(99,102,241,0.1)' }}>
                        <Text style={{ color: '#94a3b8', fontSize: 10, fontWeight: '800', marginBottom: 6 }}>ENTRY OTP</Text>
                        <Text selectable={true} style={{ color: '#10b981', fontSize: 32, fontWeight: '900', letterSpacing: 6 }}>{bookingDetails?.otp}</Text>
                      </View>
                    </View>

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
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4, letterSpacing: -0.5 }}>Host Verification</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 20, fontWeight: '500' }}>Show OTP to the host.</Text>
                    
                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 24 }}>
                      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
                        <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 14, borderRadius: 16, alignItems: 'center' }}>
                          <Text style={{ fontSize: 9, color: '#64748b', fontWeight: '800', marginBottom: 4 }}>ID</Text>
                          <Text style={{ fontSize: 16, fontWeight: '900', color: '#fff' }}>#{bookingDetails?.id}</Text>
                        </View>
                        <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.05)', padding: 14, borderRadius: 16, alignItems: 'center' }}>
                          <Text style={{ fontSize: 9, color: '#64748b', fontWeight: '800', marginBottom: 4 }}>Slot</Text>
                          <Text style={{ fontSize: 16, fontWeight: '900', color: '#6366f1' }}>{selectedSlot?.split('_').pop()}</Text>
                        </View>
                      </View>

                      <View style={{ backgroundColor: 'rgba(16,185,129,0.08)', padding: 20, borderRadius: 20, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(16,185,129,0.15)' }}>
                        <Text style={{ fontSize: 10, color: '#10b981', fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' }}>Check-in OTP</Text>
                        <Text selectable={true} style={{ fontSize: 40, fontWeight: '900', color: '#fff', letterSpacing: 8 }}>{bookingDetails?.otp}</Text>
                      </View>
                    </View>

                    <TouchableOpacity 
                      activeOpacity={0.8}
                      style={{ 
                        backgroundColor: 'rgba(16,185,129,0.1)', 
                        paddingVertical: 16, borderRadius: 16, 
                        borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)', 
                        alignItems: 'center' 
                      }} 
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
                        setStep('active_parking');
                      }}
                    >
                      <Text style={{ color: '#10b981', fontWeight: '800', fontSize: 15 }}>Verify</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {step === 'active_parking' && (
                  <View style={{ paddingVertical: 10 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                      <View>
                        <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: -0.5 }}>Active Session</Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}>
                          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981', marginRight: 6 }} />
                          <Text style={{ color: '#10b981', fontWeight: '800', fontSize: 12 }}>Live Tracking</Text>
                        </View>
                      </View>
                      <View style={{ backgroundColor: 'rgba(255,255,255,0.05)', padding: 10, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }}>
                        <Text style={{ color: '#64748b', fontSize: 9, fontWeight: '800', marginBottom: 2 }}>SLOT</Text>
                        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{selectedSlot?.split('_').pop()}</Text>
                      </View>
                    </View>

                    <View style={{ backgroundColor: 'rgba(255,255,255,0.02)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', marginBottom: 24, alignItems: 'center' }}>
                      <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '800', textTransform: 'uppercase', marginBottom: 8 }}>Duration</Text>
                      <Text style={{ color: '#fff', fontSize: 28, fontWeight: '900' }}>{isLongParking ? 'Long Term' : `${Math.floor(elapsedMinutes / 60)}h ${(elapsedMinutes % 60).toString().padStart(2, '0')}m`}</Text>
                      
                      <View style={{ height: 1, width: '100%', backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 16 }} />
                      
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <View style={{ padding: 8, backgroundColor: 'rgba(244,63,94,0.1)', borderRadius: 10 }}>
                          <Text style={{ fontSize: 14 }}>⚠️</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>Avoid Overstay</Text>
                          <Text style={{ color: '#64748b', fontSize: 11, marginTop: 1, fontWeight: '500' }}>Fees resume after grace.</Text>
                        </View>
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
                        onPress={() => {
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
                          setStep('checkout_verification');
                        }}
                      >
                        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>End Session</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {step === 'checkout_verification' && (
                  <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4, letterSpacing: -0.5 }}>Check-Out</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 20, fontWeight: '500', textAlign: 'center' }}>Provide OTP to the spotter.</Text>

                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, width: '100%', marginBottom: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', alignItems: 'center' }}>
                      <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' }}>Check-Out OTP</Text>
                      {bookingDetails?.checkoutOtp ? (
                        <Text selectable={true} style={{ color: '#6366f1', fontSize: 36, fontWeight: '900', letterSpacing: 8 }}>{bookingDetails.checkoutOtp}</Text>
                      ) : (
                        <Text style={{ color: '#ef4444', fontSize: 16, fontWeight: '700' }}>Error: OTP missing.</Text>
                      )}
                    </View>

                    <View style={{ width: '100%', padding: 14, borderRadius: 20, backgroundColor: 'rgba(99,102,241,0.05)', flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: 'rgba(99,102,241,0.15)', marginBottom: 24 }}>
                      <ActivityIndicator color="#6366f1" size="small" />
                      <View>
                        <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>Syncing...</Text>
                        <Text style={{ color: '#94a3b8', fontSize: 11, fontWeight: '500' }}>Verification takes ~15s</Text>
                      </View>
                    </View>

                    <TouchableOpacity 
                      activeOpacity={0.8}
                      style={{ 
                        backgroundColor: 'rgba(16,185,129,0.1)', 
                        paddingVertical: 16, borderRadius: 16, 
                        borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)', 
                        width: '100%', alignItems: 'center' 
                      }} 
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        setStep('payment');
                      }}
                    >
                      <Text style={{ color: '#10b981', fontWeight: '800', fontSize: 15 }}>Verify</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {step === 'payment' && (
                  <View style={{ paddingVertical: 10 }}>
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 16, letterSpacing: -0.5 }}>Review & Pay</Text>
                    
                    <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 24 }}>
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
                          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Total</Text>
                          <Text style={{ color: '#6366f1', fontSize: 24, fontWeight: '900' }}>₹{Number(bookingDetails?.totalPrice || 0).toFixed(2)}</Text>
                        </View>
                      </View>
                    </View>

                    <TouchableOpacity 
                      activeOpacity={0.9}
                      style={{ 
                        backgroundColor: '#6366f1', 
                        paddingVertical: 18, borderRadius: 20, 
                        alignItems: 'center',
                      }} 
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                        processPayment();
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{isLoading ? 'Processing...' : 'Proceed to Payment'}</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {step === 'receipt' && (
                  <View style={{ alignItems: 'center', paddingVertical: 10 }}>
                    <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: '#10b981', justifyContent: 'center', alignItems: 'center', marginBottom: 16 }}>
                      <Ionicons name="checkmark" size={50} color="#fff" />
                    </View>
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 4, letterSpacing: -0.5 }}>Payment Success!</Text>
                    <Text style={{ color: '#94a3b8', fontSize: 13, marginBottom: 24, textAlign: 'center' }}>
                      Receipt sent to email.
                    </Text>

                    <TouchableOpacity 
                      activeOpacity={0.9}
                      style={{ 
                        backgroundColor: '#6366f1', 
                        paddingVertical: 18, borderRadius: 20, 
                        width: '100%', alignItems: 'center',
                      }} 
                      onPress={() => {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                        setStep('choice');
                        setSelectedSpotId(null);
                        setBookingDetails(null);
                        setVehicleType('');
                        setVehicleSubType('');
                        setSelectedSlot('');
                        setParkingHours(1);
                      }}
                    >
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Back to Dashboard</Text>
                    </TouchableOpacity>
                  </View>
                )}

              </View>
            </View>
          )}
        </>
      )}

      <TouchableOpacity style={styles.chatFab} onPress={() => setChatOpen(true)}>
        <Text style={styles.chatFabText}>💬</Text>
      </TouchableOpacity>

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

      <Modal visible={chatOpen} transparent animationType="slide">
        <View style={styles.chatModalBg}>
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
        </View>
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

      {step === 'slot_select' && (
        <SafeAreaView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0f172a', zIndex: 9999 }} edges={['top']}>
          <LinearGradient colors={['#1e1b4b', '#0f172a']} style={{ padding: 20, paddingTop: Platform.OS === 'ios' ? 20 : 12, borderBottomLeftRadius: 32, borderBottomRightRadius: 32, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 15, elevation: 10, marginBottom: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <TouchableOpacity 
                onPress={() => setStep('spot_detail')} 
                style={{ 
                  backgroundColor: 'rgba(255,255,255,0.08)', 
                  width: 44, height: 44, borderRadius: 22, 
                  alignItems: 'center', justifyContent: 'center',
                  marginRight: 16
                }}>
                <Ionicons name="arrow-back" size={24} color="#fff" />
              </TouchableOpacity>
              <View>
                <Text style={{ color: '#fff', fontSize: 24, fontWeight: '900', letterSpacing: -0.5 }}>
                  Select a Slot
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981', marginRight: 6 }} />
                  <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '700' }}>Pick your preferred location</Text>
                </View>
              </View>
            </View>
          </LinearGradient>

          <View style={{ flex: 1, paddingHorizontal: 20 }}>

          {isSlotLoading ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20, justifyContent: 'center' }}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(idx => (
                <SkeletonCard key={idx} width="31%" height={74} style={{ borderRadius: 16 }} />
              ))}
            </View>
          ) : slotData.length > 0 ? (
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20, justifyContent: 'center' }}>
                {slotData.map(slot => {
                  const isAvailable = slot.status === 'available';
                  const isSelected = selectedSlot === slot.name;
                  
                  return (
                    <TouchableOpacity
                      key={slot.name}
                      disabled={!isAvailable}
                      activeOpacity={0.8}
                      onPress={() => {
                        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        setSelectedSlot(slot.name);
                      }}
                      style={{
                        width: '31%', height: 74,
                        backgroundColor: isSelected ? 'rgba(99,102,241,0.15)' : (isAvailable ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.01)'),
                        borderRadius: 16, alignItems: 'center', justifyContent: 'center',
                        borderWidth: 2, borderColor: isSelected ? '#6366f1' : (isAvailable ? 'rgba(255,255,255,0.08)' : 'transparent'),
                        opacity: isAvailable ? 1 : 0.4
                      }}
                    >
                      <Text style={{ color: isAvailable ? '#64748b' : '#475569', fontSize: 9, fontWeight: '800', marginBottom: 2 }}>SLOT</Text>
                      <Text style={{ color: isAvailable ? '#fff' : '#475569', fontSize: 18, fontWeight: '900' }}>{slot.name.split('_').pop()}</Text>
                      {isSelected && <View style={{ position: 'absolute', top: 5, right: 5, width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#6366f1' }} />}
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          ) : (
            <View style={{ alignItems: 'center', padding: 30 }}>
              <Text style={{ color: '#f43f5e', fontSize: 14, fontWeight: '700' }}>No slots found.</Text>
            </View>
          )}

          {slotData.length > 0 && !slotData.some(slot => slot.status === 'available') && (
            <View style={{ alignItems: 'center', padding: 10, marginBottom: 10 }}>
              <Text style={{ color: '#f43f5e', fontSize: 14, fontWeight: '700' }}>All slots are currently full.</Text>
            </View>
          )}

          {selectedSlot && (
            <TouchableOpacity 
              activeOpacity={0.9}
              style={{ 
                backgroundColor: '#6366f1', 
                paddingVertical: 16, borderRadius: 16, 
                alignItems: 'center', marginBottom: 24,
              }}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                setStep('time_select');
              }}
            >
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Continue</Text>
            </TouchableOpacity>
          )}
          </View>
        </SafeAreaView>
      )}

      {step === 'time_select' && (
        <SafeAreaView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#0f172a', zIndex: 9999 }} edges={['top']}>
          <LinearGradient colors={['#1e1b4b', '#0f172a']} style={{ padding: 20, paddingTop: Platform.OS === 'ios' ? 20 : 12, borderBottomLeftRadius: 32, borderBottomRightRadius: 32, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 15, elevation: 10, marginBottom: 20 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <TouchableOpacity 
                onPress={() => setStep('slot_select')} 
                style={{ 
                  backgroundColor: 'rgba(255,255,255,0.08)', 
                  width: 44, height: 44, borderRadius: 22, 
                  alignItems: 'center', justifyContent: 'center',
                  marginRight: 16
                }}>
                <Ionicons name="arrow-back" size={24} color="#fff" />
              </TouchableOpacity>
              <View>
                <Text style={{ color: '#fff', fontSize: 24, fontWeight: '900', letterSpacing: -0.5 }}>
                  Select Duration
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#10b981', marginRight: 6 }} />
                  <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '700' }}>
                    Slot {selectedSlot?.split('_').pop()} • ₹{spots.find(s => s.id === selectedSpotId)?.price || 0}/hr
                  </Text>
                </View>
              </View>
            </View>
          </LinearGradient>

          <View style={{ flex: 1, paddingHorizontal: 20 }}>

          <View style={{ flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 14, padding: 4, marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)' }}>
            <TouchableOpacity 
              style={{ flex: 1, padding: 8, borderRadius: 10, backgroundColor: !isLongParking ? 'rgba(99,102,241,0.15)' : 'transparent', alignItems: 'center' }} 
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsLongParking(false); }}
            >
              <Text style={{ color: !isLongParking ? '#fff' : '#64748b', fontWeight: '800', fontSize: 12 }}>Custom</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={{ flex: 1, padding: 8, borderRadius: 10, backgroundColor: isLongParking ? 'rgba(99,102,241,0.15)' : 'transparent', alignItems: 'center' }} 
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setIsLongParking(true); }}
            >
              <Text style={{ color: isLongParking ? '#fff' : '#64748b', fontWeight: '800', fontSize: 12 }}>Long Stay</Text>
            </TouchableOpacity>
          </View>

          {!isLongParking ? (
            <View style={{ marginBottom: 20 }}>
              <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 10, textTransform: 'uppercase' }}>Hours</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 20 }}>
                {[0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 24].map(h => (
                  <TouchableOpacity
                    key={h}
                    onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setParkingHours(h); }}
                    style={{ 
                      width: 52, height: 52, 
                      backgroundColor: parkingHours === h ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)', 
                      borderWidth: 2, borderColor: parkingHours === h ? '#6366f1' : 'rgba(255,255,255,0.08)', 
                      borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginRight: 8 
                    }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '900', fontSize: 15 }}>{h}h</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={{ color: '#64748b', fontSize: 10, fontWeight: '800', marginBottom: 10, textTransform: 'uppercase' }}>Minutes</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {[0, 15, 30, 45].map(m => (
                  <TouchableOpacity
                    key={m}
                    onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setParkingMinutes(m); }}
                    style={{ 
                      width: 58, height: 58, 
                      backgroundColor: parkingMinutes === m ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)', 
                      borderWidth: 2, borderColor: parkingMinutes === m ? '#6366f1' : 'rgba(255,255,255,0.08)', 
                      borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 10 
                    }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '900', fontSize: 16 }}>{m}m</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : (
            <View style={{ marginBottom: 24 }}>
              <Text style={{ color: '#64748b', marginBottom: 10, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' }}>End Date</Text>
              <TextInput
                style={{ backgroundColor: 'rgba(255,255,255,0.03)', color: '#fff', padding: 18, borderRadius: 20, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.08)', fontSize: 16, fontWeight: '600' }}
                placeholder="DD-MM-YYYY"
                placeholderTextColor="#475569"
                value={parkingEndDate}
                onChangeText={setParkingEndDate}
              />
            </View>
          )}

          <View style={{ backgroundColor: 'rgba(16,185,129,0.05)', padding: 18, borderRadius: 24, marginBottom: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(16,185,129,0.1)' }}>
            <View>
              <Text style={{ color: '#10b981', fontSize: 10, fontWeight: '900', textTransform: 'uppercase' }}>Total Price (Dynamic)</Text>
              {isCalculatingPrice ? (
                <ActivityIndicator size="small" color="#10b981" style={{ marginTop: 6, alignSelf: 'flex-start' }} />
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ color: '#fff', fontSize: 24, fontWeight: '900', marginTop: 2 }}>
                    ₹{calculatedPrice !== null ? calculatedPrice.toFixed(2) : (isLongParking ? '---' : ((parkingHours + (parkingMinutes / 60)) * (spots.find(s => s.id === selectedSpotId)?.price || 0)).toFixed(2))}
                  </Text>
                  {calculatedPrice !== null && calculatedPrice > ((parkingHours + (parkingMinutes / 60)) * (spots.find(s => s.id === selectedSpotId)?.price || 0)) && (
                    <View style={{ marginLeft: 10, backgroundColor: 'rgba(239,68,68,0.2)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 }}>
                      <Text style={{ color: '#ef4444', fontSize: 10, fontWeight: '800' }}>⚡ SURGE</Text>
                    </View>
                  )}
                </View>
              )}
            </View>
            <View style={{ padding: 10, backgroundColor: 'rgba(16,185,129,0.1)', borderRadius: 12 }}>
              <Text style={{ fontSize: 20 }}>💸</Text>
            </View>
          </View>

          <TouchableOpacity 
            activeOpacity={0.9}
            style={{ 
              backgroundColor: '#6366f1', 
              paddingVertical: 18, borderRadius: 20, 
              alignItems: 'center', marginTop: 'auto', marginBottom: 30,
            }} 
            onPress={async () => {
              if (!selectedSpotId) return;
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              setIsLoading(true);
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
                  setBookingDetails({
                    id: res.data.data.id.toString(),
                    otp: res.data.data.otp_code.toString(),
                    totalPrice: res.data.data.total_price,
                    checkoutOtp: res.data.data.checkout_otp,
                    created_at: res.data.data.created_at || new Date().toISOString(),
                    start_time: res.data.data.start_time || new Date().toISOString(),
                  });
                  setStep('booking_confirm');
                }
              } catch (e: any) { 
                const errMsg = e.response?.data?.message || 'Error';
                if (errMsg.toLowerCase().includes('slots') || errMsg.toLowerCase().includes('full')) {
                  Alert.alert('Booking Failed', 'This parking spot is currently full and cannot be booked right now.');
                } else {
                  Alert.alert('Booking Failed', errMsg);
                }
              }
              finally { setIsLoading(false); }
            }}
          >
            <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900' }}>{isLoading ? 'Reserving...' : 'Confirm Reservation'}</Text>
          </TouchableOpacity>
          </View>
        </SafeAreaView>
      )}

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
  etaProgressBar: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginHorizontal: 32,
    borderRadius: 2,
    marginBottom: 20,
  },
  etaProgressFill: {
    height: '100%',
    backgroundColor: '#4285F4',
    borderRadius: 2,
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
});
