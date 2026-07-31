import React, { useEffect, useState, useRef } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SC, TF } from '../../constants/SpotterTheme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, ActivityIndicator, Text, TouchableOpacity, Animated, Platform, Alert } from 'react-native';
import * as Haptics from 'expo-haptics';
import { registerForPushNotificationsAsync } from '../../services/notifications';
import { onRealtime } from '../../services/realtime';
import apiClient from '../../api/client';

export default function SpotterTabsLayout() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);

  // Loud in-app new-booking banner state.
  const [banner, setBanner] = useState<{ title: string; sub: string } | null>(null);
  const slide = useRef(new Animated.Value(-140)).current;
  const hideTimer = useRef<any>(null);

  // Checkout-confirm gate: a finder tapped End Session and is waiting for THIS
  // owner to confirm the vehicle has left. Payment is locked on their side until
  // we confirm, so this banner is persistent (no auto-hide) and tappable.
  const [checkoutReq, setCheckoutReq] = useState<{ id: number; title: string; slot: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const slide2 = useRef(new Animated.Value(-140)).current;

  useEffect(() => {
    const checkRole = async () => {
      const role = await AsyncStorage.getItem('user_role');
      if (role?.toUpperCase() !== 'SPOTTER') {
        router.replace('/role-selection');
      } else {
        setCheckingAuth(false);
      }
    };
    checkRole();
  }, []);

  // #1 CLOSED-APP PUSH: register this spotter's device for push notifications so
  // the backend can reach them even when the app is closed. Previously ONLY the
  // finder registered, so spotters never had a push token saved — a booking that
  // arrived with the app closed was silently missed.
  useEffect(() => {
    if (!checkingAuth) {
      registerForPushNotificationsAsync().catch(() => {});
    }
  }, [checkingAuth]);

  const dismiss = () => {
    Animated.timing(slide, { toValue: -140, duration: 280, useNativeDriver: true }).start(() => setBanner(null));
  };

  // #2 LOUD IN-APP ALERT: while the app is OPEN, a new booking pops a banner at
  // the top + a strong haptic, tappable straight to Verify. Works on every
  // spotter tab because it lives in the layout.
  useEffect(() => {
    const showBanner = (payload: any) => {
      const price = payload?.total_price != null ? ` · ₹${payload.total_price}` : '';
      const spot = payload?.spot_title || payload?.spot?.title || 'a spot';
      setBanner({ title: 'New booking!', sub: `${spot}${price} · tap to verify` });
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      setTimeout(() => { try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {} }, 220);
      Animated.spring(slide, { toValue: 0, useNativeDriver: true, bounciness: 10, speed: 12 }).start();
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(dismiss, 7000);
    };
    const off = onRealtime('booking:new', showBanner);
    return () => { off(); if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, []);

  // Checkout request from a finder -> show a persistent confirm banner.
  useEffect(() => {
    const onReq = (p: any) => {
      const slot = p?.slot_name ? String(p.slot_name).split('_').pop() : '';
      setCheckoutReq({ id: p?.id, title: p?.spot_title || 'your spot', slot: slot || '' });
      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
      setTimeout(() => { try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {} }, 220);
      Animated.spring(slide2, { toValue: 0, useNativeDriver: true, bounciness: 10, speed: 12 }).start();
    };
    const off = onRealtime('booking:checkout_requested', onReq);
    return () => off();
  }, []);

  const dismissCheckout = () => {
    Animated.timing(slide2, { toValue: -140, duration: 280, useNativeDriver: true }).start(() => setCheckoutReq(null));
  };

  const confirmCheckout = () => {
    if (!checkoutReq?.id) return;
    Alert.alert(
      'Confirm checkout',
      `Confirm the vehicle has left ${checkoutReq.title}${checkoutReq.slot ? ` (slot ${checkoutReq.slot})` : ''}? This lets the driver pay and frees your spot.`,
      [
        { text: 'Not yet', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: async () => {
            try {
              setConfirming(true);
              await apiClient.post(`/bookings/${checkoutReq.id}/confirm-checkout`);
              try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
              dismissCheckout();
            } catch (e: any) {
              Alert.alert('Could not confirm', e?.response?.data?.message || 'Please try again.');
            } finally {
              setConfirming(false);
            }
          },
        },
      ]
    );
  };

  const openVerify = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    dismiss();
    router.push('/spotter/verify');
  };

  if (checkingAuth) {
    return (
      <View style={{ flex: 1, backgroundColor: SC.bg, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={SC.accent} size="large" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: {
            backgroundColor: SC.bgCard,
            borderTopWidth: 0,
            height: 72,
            paddingBottom: 14,
            paddingTop: 8,
            elevation: 0,
            shadowOpacity: 0,
          },
          tabBarActiveTintColor: SC.accent,
          tabBarInactiveTintColor: SC.textMuted,
          tabBarLabelStyle: {
            fontSize: 10,
            fontWeight: '700',
            letterSpacing: 0.3,
          },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: 'Dashboard',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="grid" size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="verify"
          options={{
            title: 'Verify',
            tabBarIcon: ({ focused, size }) => (
              <Ionicons name="shield-checkmark" size={22} color={focused ? SC.warning : SC.textMuted} />
            ),
            tabBarActiveTintColor: SC.warning,
          }}
        />
        <Tabs.Screen
          name="spots"
          options={{
            title: 'Spots',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="location" size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="support"
          options={{
            title: 'Support',
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="chatbubble-ellipses" size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="payout-setup"
          options={{
            title: 'Payout Setup',
            href: null,
          }}
        />
      </Tabs>

      {/* #2 Loud new-booking banner overlay */}
      {banner ? (
        <Animated.View
          pointerEvents="box-none"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: [{ translateY: slide }], zIndex: 999, paddingTop: Platform.OS === 'ios' ? 54 : 34 }}
        >
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={openVerify}
            style={{ marginHorizontal: 12, backgroundColor: SC.success, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 10 }}
          >
            <Ionicons name="notifications" size={24} color="#fff" style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontWeight: '900', fontSize: 16 }}>{banner.title}</Text>
              <Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 12.5, marginTop: 1 }} numberOfLines={1}>{banner.sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      ) : null}

      {/* Checkout-confirm gate banner (persistent until the owner acts) */}
      {checkoutReq ? (
        <Animated.View
          pointerEvents="box-none"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: [{ translateY: slide2 }], zIndex: 1000, paddingTop: Platform.OS === 'ios' ? 54 : 34 }}
        >
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={confirmCheckout}
            style={{ marginHorizontal: 12, backgroundColor: SC.warning, borderRadius: 16, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 10 }}
          >
            <Ionicons name="exit-outline" size={24} color="#fff" style={{ marginRight: 12 }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontWeight: '900', fontSize: 16 }}>Driver checking out</Text>
              <Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 12.5, marginTop: 1 }} numberOfLines={1}>
                {checkoutReq.title}{checkoutReq.slot ? ` · slot ${checkoutReq.slot}` : ''} · tap to confirm
              </Text>
            </View>
            {confirming ? <ActivityIndicator color="#fff" /> : <Ionicons name="checkmark-circle" size={22} color="#fff" />}
          </TouchableOpacity>
        </Animated.View>
      ) : null}
    </View>
  );
}
