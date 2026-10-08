/**
 * Shown at the top of the owner dashboard until the owner is verified.
 * Tapping it opens the verification checklist.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { SC } from '../../constants/SpotterTheme';
import { ownerVerification, OwnerVerification } from '../../api/ownerVerification';

export default function OwnerVerificationBanner() {
  const router = useRouter();
  const [data, setData] = useState<OwnerVerification | null>(null);

  useFocusEffect(useCallback(() => {
    let alive = true;
    ownerVerification.get().then((d) => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, []));

  if (!data || data.status === 'approved') return null;

  const done = Object.values(data.steps).filter(Boolean).length;
  const cfg = {
    not_started: { color: SC.warning, bg: SC.warningSoft, icon: 'shield-outline', title: 'Verify to go live', text: 'Drivers can’t see your spots until you’re verified.' },
    in_progress: { color: SC.warning, bg: SC.warningSoft, icon: 'shield-half', title: `Verification: ${done} of 5 done`, text: 'Finish and submit so drivers can book your spots.' },
    pending: { color: SC.info, bg: SC.infoSoft, icon: 'time', title: 'Verification under review', text: 'We’ll notify you when it’s approved.' },
    rejected: { color: SC.error, bg: SC.errorSoft, icon: 'alert-circle', title: 'Verification needs changes', text: data.rejection_reason || 'Tap to see what to fix.' },
  }[data.status as 'not_started' | 'in_progress' | 'pending' | 'rejected'];
  if (!cfg) return null;

  return (
    <TouchableOpacity
      style={[s.wrap, { backgroundColor: cfg.bg, borderColor: cfg.color + '55' }]}
      onPress={() => router.push('/spotter/verification' as any)}
      activeOpacity={0.85}
      accessibilityRole="button"
    >
      <Ionicons name={cfg.icon as any} size={24} color={cfg.color} />
      <View style={{ flex: 1 }}>
        <Text style={[s.title, { color: cfg.color }]}>{cfg.title}</Text>
        <Text style={s.text} numberOfLines={2}>{cfg.text}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={cfg.color} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 16, borderWidth: 1, padding: 14, marginBottom: 16 },
  title: { fontSize: 15, fontWeight: '800' },
  text: { color: SC.textPrimary, opacity: 0.85, fontSize: 13, marginTop: 2 },
});
