/**
 * One spot's own verification state, on the owner's list of spots.
 *
 * Owner verification approves a PERSON; this is the PLACE. An owner can be
 * fully verified and still have a spot drivers cannot see, so a list that only
 * showed slot counts left them with no way to tell a live listing from a dead
 * one.
 *
 * The sentence comes from the server (`verification.message`, written once in
 * SpotVerificationPolicy) so the app and the API cannot say different things.
 * This component chooses the short label and the colour.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SC } from '../../constants/SpotterTheme';

export type SpotVerification = {
  status?: string | null;
  visible_to_drivers?: string | null;
  is_live?: boolean;
  message?: string | null;
  hours_left?: number | null;
  rejection_reason?: string | null;
};

const LABELS: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  approved: { label: 'Verified', color: SC.success, bg: SC.successSoft, icon: 'shield-checkmark' },
  // Live, but nobody has checked the address. Said plainly rather than dressed
  // up as "verified" -- it was live before per-spot checks existed.
  grandfathered: { label: 'Live · address not checked yet', color: SC.info, bg: SC.infoSoft, icon: 'shield-half' },
  desk_pending: { label: 'Under review', color: SC.info, bg: SC.infoSoft, icon: 'time' },
  desk_approved: { label: 'Under review · field check', color: SC.info, bg: SC.infoSoft, icon: 'time' },
  in_progress: { label: 'Not visible · submit to review', color: SC.warning, bg: SC.warningSoft, icon: 'shield-outline' },
  not_started: { label: 'Not visible · add a document', color: SC.warning, bg: SC.warningSoft, icon: 'shield-outline' },
  rejected: { label: 'Not visible · needs changes', color: SC.error, bg: SC.errorSoft, icon: 'alert-circle' },
};

export default function SpotVerificationBadge({ v }: { v?: SpotVerification | null }) {
  if (!v) return null;

  const key = String(v.status || v.visible_to_drivers || 'not_started');
  const cfg = LABELS[key];
  if (!cfg) return null;

  return (
    <View style={[s.wrap, { backgroundColor: cfg.bg, borderColor: cfg.color + '55' }]}>
      <Ionicons name={cfg.icon as any} size={14} color={cfg.color} />
      <View style={{ flex: 1 }}>
        <Text style={[s.label, { color: cfg.color }]}>{cfg.label}</Text>
        {!!v.message && <Text style={s.detail} numberOfLines={2}>{v.message}</Text>}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    borderRadius: 10, borderWidth: 1, paddingVertical: 8, paddingHorizontal: 10, marginTop: 10,
  },
  label: { fontSize: 12, fontWeight: '800' },
  detail: { color: SC.textPrimary, opacity: 0.8, fontSize: 11, marginTop: 2 },
});
