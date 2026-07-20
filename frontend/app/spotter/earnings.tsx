/**
 * Earnings Breakdown — makes the Spotter wallet legible.
 *
 * The dashboard shows a single number ("Dues: ₹340") with no explanation.
 * This screen answers "where did that come from?" by itemising every completed
 * booking, showing its fee, and — crucially — the SIGN of its wallet effect:
 *
 *   cash booking   → spotter already took the money, so the fee is a DEBT (red)
 *   online booking → platform holds the money, so the earning is a CREDIT (green)
 *
 * Backed by GET /spots/earnings-breakdown.
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import apiClient from '../../api/client';
import { SC, TF, SP, RAD, SS } from '../../constants/SpotterTheme';

/* ── Types ─────────────────────────────────────────────────────── */
type Item = {
  booking_id: number;
  spot_title: string;
  date: string;
  hours: number;
  total_price: number;
  platform_fee: number;
  spotter_earning: number;
  payment_mode: string;
  payment_status: string;
  wallet_effect: number;
};
type BySpot = {
  spot_id: number | null;
  spot_title: string;
  bookings: number;
  gross: number;
  fees: number;
  earnings: number;
};
type Totals = {
  gross: number; fees: number; earnings: number;
  cash_fees_owed: number; bookings: number;
};

const PERIODS = [
  { label: '7D', days: 7 },
  { label: '30D', days: 30 },
  { label: '90D', days: 90 },
  { label: '1Y', days: 365 },
];

const money = (n: number) =>
  `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const shortDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch {
    return '—';
  }
};

export default function EarningsBreakdown() {
  const router = useRouter();
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [bySpot, setBySpot] = useState<BySpot[]>([]);
  const [items, setItems] = useState<Item[]>([]);

  const load = useCallback(async (period: number, isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get(`/spots/earnings-breakdown?days=${period}`);
      if (res.data?.success) {
        const d = res.data.data;
        setTotals(d.totals);
        setBySpot(d.by_spot || []);
        setItems(d.items || []);
      } else {
        setError(res.data?.message || 'Could not load your earnings.');
      }
    } catch {
      // Distinguish "no data" from "couldn't reach the server" — showing ₹0
      // for a network failure would be a lie about the spotter's money.
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(days); }, [days, load]));

  const onRefresh = () => { setRefreshing(true); load(days, true); };

  // Best-performing spot, used for the relative bars in the per-spot section.
  const maxSpotEarning = useMemo(
    () => Math.max(...bySpot.map((s) => s.earnings), 1),
    [bySpot]
  );

  return (
    <View style={SS.page}>
      <SafeAreaView edges={['top']} style={SS.headerSafe}>
        <View style={SS.header}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={st.backBtn}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="chevron-back" size={24} color={SC.textPrimary} />
          </TouchableOpacity>
          <Text style={SS.sectionTitle}>Earnings Breakdown</Text>
          <View style={{ width: 38 }} />
        </View>
      </SafeAreaView>

      {/* Period selector */}
      <View style={st.periodRow} accessibilityRole="tablist">
        {PERIODS.map((p) => {
          const active = p.days === days;
          return (
            <TouchableOpacity
              key={p.days}
              onPress={() => setDays(p.days)}
              style={[st.periodChip, active && st.periodChipActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Show last ${p.days} days`}
            >
              <Text style={[st.periodText, active && st.periodTextActive]}>{p.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading ? (
        <View style={st.center}>
          <ActivityIndicator color={SC.accent} />
          <Text style={SS.emptyText}>Loading your earnings…</Text>
        </View>
      ) : error ? (
        <View style={st.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={SC.textMuted} />
          <Text style={[SS.emptyText, { marginBottom: SP.lg }]}>{error}</Text>
          <TouchableOpacity
            onPress={() => load(days)}
            style={st.retryBtn}
            accessibilityRole="button"
            accessibilityLabel="Retry loading earnings"
          >
            <Ionicons name="refresh" size={16} color={SC.accent} />
            <Text style={st.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={SS.scrollContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={SC.accent} />
          }
        >
          {/* ── Summary ─────────────────────────────────────────── */}
          <View style={[SS.card, { marginBottom: SP.lg }]}>
            <Text style={st.cardLabel}>You earned</Text>
            <Text style={st.hero}>{money(totals?.earnings || 0)}</Text>
            <Text style={st.heroSub}>
              from {totals?.bookings || 0} completed booking
              {(totals?.bookings || 0) === 1 ? '' : 's'} in the last {days} days
            </Text>

            <View style={st.splitRow}>
              <View style={st.splitCell}>
                <Text style={st.splitLabel}>Customers paid</Text>
                <Text style={st.splitValue}>{money(totals?.gross || 0)}</Text>
              </View>
              <View style={st.splitDivider} />
              <View style={st.splitCell}>
                <Text style={st.splitLabel}>Platform fee</Text>
                <Text style={[st.splitValue, { color: SC.warning }]}>
                  −{money(totals?.fees || 0)}
                </Text>
              </View>
            </View>
          </View>

          {/* ── Dues explainer: the whole reason this screen exists ── */}
          {!!totals?.cash_fees_owed && totals.cash_fees_owed > 0 && (
            <View style={[SS.card, st.duesCard]}>
              <View style={st.duesHead}>
                <Ionicons name="information-circle" size={18} color={SC.warning} />
                <Text style={st.duesTitle}>Why you owe {money(totals.cash_fees_owed)}</Text>
              </View>
              <Text style={st.duesBody}>
                You collected cash directly from drivers on some bookings, so the
                full amount stayed with you. The platform fee on those bookings is
                what you now owe back. It is settled from your wallet — nothing is
                taken from your bank.
              </Text>
            </View>
          )}

          {/* ── Per-spot performance ────────────────────────────── */}
          {bySpot.length > 0 && (
            <>
              <Text style={st.sectionHead}>By spot</Text>
              <View style={[SS.card, { marginBottom: SP.lg }]}>
                {bySpot.map((s, i) => (
                  <View
                    key={`${s.spot_id}-${i}`}
                    style={[st.spotRow, i === bySpot.length - 1 && { borderBottomWidth: 0 }]}
                    accessibilityLabel={`${s.spot_title}, ${s.bookings} bookings, earned ${money(s.earnings)}`}
                  >
                    <View style={st.spotTop}>
                      <Text style={st.spotTitle} numberOfLines={1}>{s.spot_title}</Text>
                      <Text style={st.spotEarning}>{money(s.earnings)}</Text>
                    </View>
                    <View style={st.barTrack}>
                      <View
                        style={[st.barFill, { width: `${(s.earnings / maxSpotEarning) * 100}%` }]}
                      />
                    </View>
                    <Text style={st.spotMeta}>
                      {s.bookings} booking{s.bookings === 1 ? '' : 's'} · {money(s.gross)} gross · {money(s.fees)} fees
                    </Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {/* ── Itemised ledger ─────────────────────────────────── */}
          <Text style={st.sectionHead}>Every booking</Text>
          <View style={SS.card}>
            {items.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: SP.xl }}>
                <Ionicons name="receipt-outline" size={40} color={SC.textMuted} />
                <Text style={SS.emptyText}>
                  No completed bookings in this period.{'\n'}
                  Earnings appear here once a driver checks out.
                </Text>
              </View>
            ) : (
              items.map((it, i) => {
                const isDebt = it.wallet_effect < 0;
                return (
                  <View
                    key={it.booking_id}
                    style={[st.itemRow, i === items.length - 1 && { borderBottomWidth: 0 }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={st.itemTitle} numberOfLines={1}>{it.spot_title}</Text>
                      <Text style={st.itemMeta}>
                        #{it.booking_id} · {shortDate(it.date)} · {it.hours}h ·{' '}
                        {it.payment_mode === 'cash' ? 'Cash' : 'Online'}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[st.itemAmount, { color: isDebt ? SC.error : SC.success }]}>
                        {isDebt ? '−' : '+'}{money(it.wallet_effect)}
                      </Text>
                      <Text style={st.itemSub}>
                        {isDebt ? 'fee owed' : 'earned'} · {money(it.total_price)} total
                      </Text>
                    </View>
                  </View>
                );
              })
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  backBtn: { width: 38, height: 38, justifyContent: 'center' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SP.xl },

  retryBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: SP.lg, paddingVertical: SP.md,
    borderRadius: RAD.full, backgroundColor: SC.accentSoft,
    borderWidth: 1, borderColor: SC.borderActive,
  },
  retryText: { color: SC.accent, ...TF.btnSecondary },

  periodRow: {
    flexDirection: 'row', gap: SP.sm,
    paddingHorizontal: SP.pagePadding, paddingBottom: SP.md,
  },
  periodChip: {
    paddingHorizontal: SP.lg, paddingVertical: 7,
    borderRadius: RAD.full, backgroundColor: SC.bgCard,
    borderWidth: 1, borderColor: SC.border,
  },
  periodChipActive: { backgroundColor: SC.accentSoft, borderColor: SC.borderActive },
  periodText: { color: SC.textSecondary, ...TF.chip },
  periodTextActive: { color: SC.accent },

  cardLabel: { color: SC.textSecondary, ...TF.label },
  hero: { color: SC.textPrimary, ...TF.bigValue, marginTop: SP.xs },
  heroSub: { color: SC.textMuted, ...TF.bodySm, marginTop: 2 },

  splitRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: SP.lg, paddingTop: SP.lg,
    borderTopWidth: 1, borderTopColor: SC.border,
  },
  splitCell: { flex: 1 },
  splitDivider: { width: 1, height: 32, backgroundColor: SC.border, marginHorizontal: SP.md },
  splitLabel: { color: SC.textMuted, ...TF.labelSm },
  splitValue: { color: SC.textPrimary, ...TF.medValue, marginTop: 3 },

  duesCard: {
    marginBottom: SP.lg,
    backgroundColor: SC.warningSoft,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  duesHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: SP.sm },
  duesTitle: { color: SC.warning, ...TF.bodyBold },
  duesBody: { color: SC.textSecondary, ...TF.bodySm, lineHeight: 19 },

  sectionHead: {
    color: SC.textSecondary, ...TF.label,
    marginBottom: SP.md, marginLeft: SP.xs,
  },

  spotRow: { paddingVertical: SP.md, borderBottomWidth: 1, borderBottomColor: SC.border },
  spotTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  spotTitle: { color: SC.textPrimary, ...TF.bodyBold, flex: 1, marginRight: SP.sm },
  spotEarning: { color: SC.success, ...TF.bodyBold },
  barTrack: {
    height: 5, borderRadius: 3, marginTop: SP.sm,
    backgroundColor: 'rgba(255,255,255,0.06)', overflow: 'hidden',
  },
  barFill: { height: 5, borderRadius: 3, backgroundColor: SC.accent },
  spotMeta: { color: SC.textMuted, fontSize: 11, fontWeight: '600', marginTop: 6 },

  itemRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: SP.md, borderBottomWidth: 1, borderBottomColor: SC.border,
  },
  itemTitle: { color: SC.textPrimary, ...TF.bodySm, fontWeight: '700' },
  itemMeta: { color: SC.textMuted, fontSize: 11, fontWeight: '600', marginTop: 3 },
  itemAmount: { ...TF.bodyBold },
  itemSub: { color: SC.textMuted, fontSize: 10, fontWeight: '600', marginTop: 3 },
});
