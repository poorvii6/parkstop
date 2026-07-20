/**
 * Toast.tsx — lightweight non-blocking feedback.
 *
 * Replaces Alert.alert for routine outcomes. Alerts stop the user and demand a
 * tap; a host verifying cars one after another shouldn't have to dismiss a
 * modal each time. Errors that need a decision still use Alert.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

export type ToastKind = 'success' | 'error' | 'info';

const TONE: Record<ToastKind, { bg: string; icon: any; color: string }> = {
  success: { bg: 'rgba(16,185,129,0.15)', icon: 'checkmark-circle', color: '#10b981' },
  error: { bg: 'rgba(239,68,68,0.15)', icon: 'alert-circle', color: '#ef4444' },
  info: { bg: 'rgba(59,130,246,0.15)', icon: 'information-circle', color: '#3b82f6' },
};

export const Toast: React.FC<{
  message: string | null;
  kind?: ToastKind;
  onHide?: () => void;
  duration?: number;
}> = ({ message, kind = 'success', onHide, duration = 2600 }) => {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!message) return;
    Animated.timing(anim, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    const t = setTimeout(() => {
      Animated.timing(anim, { toValue: 0, duration: 200, useNativeDriver: true }).start(
        () => onHide?.()
      );
    }, duration);
    return () => clearTimeout(t);
  }, [message, duration]);

  if (!message) return null;
  const tone = TONE[kind];

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        {
          backgroundColor: '#0f172a',
          borderColor: tone.color,
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }],
        },
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: tone.bg }]}>
        <Ionicons name={tone.icon} size={18} color={tone.color} />
      </View>
      <Text style={styles.text} numberOfLines={2}>{message}</Text>
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 60,
    left: 16,
    right: 16,
    zIndex: 2000,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: '#fff', fontSize: 13, fontWeight: '700', flex: 1 },
});

export default Toast;
