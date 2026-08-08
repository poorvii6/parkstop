/**
 * OfflineBanner.tsx — app-wide connectivity status banner.
 *
 * Mounted once in the root layout. Shows a polished, non-alarming card when the
 * API client decides we genuinely can't reach the server (OFFLINE_EVENT), and a
 * brief "Back online" confirmation when connectivity returns (ONLINE_EVENT).
 * The decision logic (grace window, throttling) lives in utils/networkStatus.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, DeviceEventEmitter, Platform, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { OFFLINE_EVENT, ONLINE_EVENT, initConnectivityMonitor } from '../utils/networkStatus';

type Status = 'offline' | 'online' | null;

export default function OfflineBanner() {
  const [status, setStatus] = useState<Status>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Start OS-level connectivity monitoring so "internet off" shows instantly.
    initConnectivityMonitor();

    const clearHide = () => { if (hideTimer.current) clearTimeout(hideTimer.current); };

    const offSub = DeviceEventEmitter.addListener(OFFLINE_EVENT, () => {
      clearHide();
      setStatus('offline');
    });
    const onSub = DeviceEventEmitter.addListener(ONLINE_EVENT, () => {
      // Only celebrate a reconnect if we were actually showing "offline".
      setStatus((prev) => {
        if (prev !== 'offline') return prev;
        clearHide();
        hideTimer.current = setTimeout(() => setStatus(null), 1800);
        return 'online';
      });
    });

    return () => { offSub.remove(); onSub.remove(); clearHide(); };
  }, []);

  useEffect(() => {
    if (status) {
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 8, tension: 65 }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: 220, useNativeDriver: true }).start();
    }
  }, [status]);

  if (!status) return null;

  const online = status === 'online';
  const accent = online ? '#22c55e' : '#f59e0b';
  const iconBg = online ? 'rgba(34,197,94,0.15)' : 'rgba(245,158,11,0.15)';
  const icon = online ? 'checkmark-circle' : 'cloud-offline';
  const title = online ? 'Back online' : "You're offline";
  const subtitle = online
    ? 'Your connection has been restored.'
    : "We can't reach the network. We'll reconnect automatically.";

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        {
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-26, 0] }) }],
        },
      ]}
    >
      <View style={[styles.card, { borderColor: accent + '55' }]}>
        <View style={[styles.iconWrap, { backgroundColor: iconBg }]}>
          <Ionicons name={icon as any} size={20} color={accent} />
        </View>
        <View style={styles.textWrap}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 56 : 40,
    left: 14,
    right: 14,
    zIndex: 3000,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0b1220',
    borderRadius: 18,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  textWrap: { flex: 1 },
  title: { color: '#ffffff', fontSize: 14.5, fontWeight: '800', marginBottom: 1 },
  subtitle: { color: '#94a3b8', fontSize: 11.5, fontWeight: '600', lineHeight: 15 },
});
