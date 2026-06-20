import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Dimensions, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, FontAwesome5, MaterialCommunityIcons } from '@expo/vector-icons';
import apiClient from '../../api/client';
import { SC, TF, SP, RAD, SS } from '../../constants/SpotterTheme';
import { registerForPushNotificationsAsync } from '../../services/notifications';
import RazorpayCheckout from '../../components/RazorpayCheckout';
import { Alert } from 'react-native';

const { width } = Dimensions.get('window');

/* ── Mini Line Chart ───────────────────────────────────────────── */
const MiniChart = ({ data = [0, 0, 0, 0, 0, 0, 0] }: { data: number[] }) => {
  const maxVal = Math.max(...data, 1);
  const chartH = 100;
  const paddingX = 36;
  const chartW = width - 80;
  const stepX = (chartW - paddingX) / (data.length - 1 || 1);

  const points = data.map((val, i) => ({
    x: paddingX + i * stepX,
    y: chartH - (val / maxVal) * chartH,
  }));

  const lines = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    lines.push(
      <View
        key={`l-${i}`}
        style={{
          position: 'absolute',
          left: p1.x,
          top: p1.y,
          width: length,
          height: 2.5,
          backgroundColor: SC.accent,
          borderRadius: 1,
          transform: [
            { translateY: -1.25 },
            { rotate: `${angle}deg` },
            { translateX: length / 2 - dx / 2 },
            { translateY: dy / 2 },
          ],
        }}
      />
    );
  }

  const yLabels = [maxVal, maxVal * 0.5, 0].map(v =>
    v >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toString()
  );

  return (
    <View style={{ height: chartH + 28, position: 'relative' }}>
      <View style={{ position: 'absolute', left: 0, top: 0, bottom: 20, justifyContent: 'space-between' }}>
        {yLabels.map((l, i) => (
          <Text key={i} style={{ color: SC.textMuted, fontSize: 9, width: 30, textAlign: 'right' }}>{l}</Text>
        ))}
      </View>
      <View style={{ position: 'absolute', left: paddingX, right: 0, top: 0, bottom: 20, justifyContent: 'space-between' }}>
        {[0, 1, 2].map(i => (
          <View key={i} style={{ height: 1, backgroundColor: SC.border, width: '100%' }} />
        ))}
      </View>
      <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 20 }}>
        {lines}
        {points.map((p, i) => (
          <View
            key={`d-${i}`}
            style={{
              position: 'absolute',
              left: p.x - 4,
              top: p.y - 4,
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: SC.accent,
              borderWidth: 2,
              borderColor: SC.bgCard,
            }}
          />
        ))}
      </View>
      <View style={{ position: 'absolute', left: paddingX, right: 0, bottom: 0, flexDirection: 'row', justifyContent: 'space-between' }}>
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => (
          <Text key={i} style={{ color: SC.textMuted, fontSize: 9 }}>{d}</Text>
        ))}
      </View>
    </View>
  );
};

/* ── Stat Card ─────────────────────────────────────────────────── */
const StatCard = ({ icon, iconColor, iconBg, label, value, sub, onPress }: any) => (
  <TouchableOpacity style={s.statCard} onPress={onPress} activeOpacity={0.85}>
    <View style={[s.statIconBox, { backgroundColor: iconBg }]}>
      {icon}
    </View>
    <Text style={s.statLabel}>{label}</Text>
    <Text style={s.statValue}>{value}</Text>
    {sub && <Text style={s.statSub}>{sub}</Text>}
  </TouchableOpacity>
);

/* ── Main Dashboard ────────────────────────────────────────────── */
export default function SpotterDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardData, setDashboardData] = useState({
    active_spots: 0,
    earnings: 0,
    revenue_trend: [0, 0, 0, 0, 0, 0, 0],
    surge_factor: 1,
    inventory: [] as any[],
    recent_traffic: [] as any[],
    balance: 0
  });
  const [payoutSetup, setPayoutSetup] = useState<boolean | null>(null);

  const [isRazorpayVisible, setIsRazorpayVisible] = useState(false);
  const [razorpayOrder, setRazorpayOrder] = useState<any>(null);
  const [isClearingDues, setIsClearingDues] = useState(false);

  const handleClearDues = async () => {
    try {
      setIsClearingDues(true);
      const res = await apiClient.post('/payments/create-dues-order');
      if (res.data.success) {
        setRazorpayOrder({
          orderId: res.data.order_id,
          amount: res.data.amount,
          currency: res.data.currency,
          keyId: res.data.key_id
        });
        setIsRazorpayVisible(true);
      } else {
        Alert.alert('Error', res.data.message || 'Failed to create dues order');
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Failed to process dues payment');
    } finally {
      setIsClearingDues(false);
    }
  };

  const handleRazorpaySuccess = async (data: any) => {
    setIsRazorpayVisible(false);
    try {
      setLoading(true);
      const res = await apiClient.post('/payments/verify-dues', {
        razorpay_order_id: data.razorpay_order_id,
        razorpay_payment_id: data.razorpay_payment_id,
        razorpay_signature: data.razorpay_signature,
      });
      if (res.data.success) {
        Alert.alert('Success', 'Dues cleared successfully!');
        fetchDashboardData();
      } else {
        Alert.alert('Error', 'Payment verification failed');
      }
    } catch (e) {
      Alert.alert('Error', 'Payment verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRazorpayFailure = (data: any) => {
    setIsRazorpayVisible(false);
    Alert.alert('Payment Failed', data.error?.description || 'Your payment could not be processed.');
  };

  const fetchDashboardData = useCallback(async () => {
    try {
      const res = await apiClient.get('/spots/dashboard');
      if (res.data?.success) {
        setDashboardData(res.data.data);
      }
    } catch (e) {
      console.log('Error fetching dashboard', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboardData();
    registerForPushNotificationsAsync();
    // Check payout account status
    apiClient.get('/payouts/account-status')
      .then(res => { if (res.data?.success) setPayoutSetup(res.data.data.is_setup); })
      .catch(() => setPayoutSetup(false));
  }, [fetchDashboardData]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchDashboardData();
  };

  if (loading) {
    return (
      <View style={[SS.page, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={SC.accent} size="large" />
      </View>
    );
  }

  let totalSlots = 0;
  let totalAvailable = 0;
  (dashboardData.inventory || []).forEach((spot: any) => {
    totalSlots += spot.total_slots || 0;
    totalAvailable += spot.available_slots || 0;
  });
  const occupiedSlots = totalSlots - totalAvailable;
  const capacityPct = totalSlots > 0 ? Math.round((occupiedSlots / totalSlots) * 100) : 0;
  const activeBookings = (dashboardData.recent_traffic || []).filter(
    (t: any) => t.status === 'active' || t.status === 'reserved'
  ).length;

  return (
    <View style={SS.page}>
      {/* HEADER */}
      <SafeAreaView edges={['top']} style={SS.headerSafe}>
        <View style={SS.header}>
          <Text style={SS.logoText}>
            <Text style={SS.logoAccent}>P</Text>arkStop
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={SS.statusBox}>
              <Text style={SS.statusLabel}>SPOTTER STATUS</Text>
              <View style={SS.statusRow}>
                <Text style={SS.statusText}>Active</Text>
                <View style={SS.statusDot} />
              </View>
            </View>
            <TouchableOpacity onPress={() => router.push('/modal')} style={SS.profileBtn}>
              <Ionicons name="person" size={18} color={SC.info} />
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={SS.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={SC.accent}
            colors={[SC.accent]}
          />
        }
      >
        {/* DUES WARNING BANNER */}
        {dashboardData.balance < 0 && (
          <View style={{ backgroundColor: 'rgba(239,68,68,0.1)', padding: 16, borderRadius: 16, marginBottom: 24, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <Ionicons name="warning" size={24} color="#ef4444" style={{ marginRight: 8 }} />
              <Text style={{ color: '#ef4444', fontSize: 18, fontWeight: '800' }}>Platform Dues: ₹{Math.abs(dashboardData.balance).toFixed(2)}</Text>
            </View>
            <Text style={{ color: '#f87171', fontSize: 14, marginBottom: 12 }}>
              {dashboardData.balance <= -500 
                ? "Your parking spots are hidden from Finders because your dues exceeded ₹500. Clear dues to reactivate."
                : "You have pending platform fees from cash bookings. Clear them soon to avoid suspension."}
            </Text>
            <TouchableOpacity 
              style={{ backgroundColor: '#ef4444', paddingVertical: 12, borderRadius: 12, alignItems: 'center' }}
              onPress={handleClearDues}
              disabled={isClearingDues}
            >
              {isClearingDues ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>Clear Dues via Razorpay</Text>}
            </TouchableOpacity>
          </View>
        )}

        {/* PAYOUT SETUP BANNER */}
        {payoutSetup === false && (
          <TouchableOpacity
            style={s.payoutBanner}
            onPress={() => router.push('/spotter/payout-setup')}
            activeOpacity={0.85}
          >
            <View style={s.payoutBannerIcon}>
              <Ionicons name="wallet-outline" size={22} color={SC.warning} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.payoutBannerTitle}>Set Up Payouts</Text>
              <Text style={s.payoutBannerSub}>Link your UPI or bank account to receive earnings automatically</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={SC.textMuted} />
          </TouchableOpacity>
        )}

        {/* STAT CARDS */}
        <View style={s.statsRow}>
          <StatCard
            icon={<Ionicons name="wallet" size={20} color="#FFF" />}
            iconColor="#FFF"
            iconBg={SC.accent}
            label="MONTHLY EARNINGS"
            value={`₹${dashboardData.earnings.toFixed(0)}`}
            sub={`Surge ${dashboardData.surge_factor}x`}
          />
          <StatCard
            icon={<FontAwesome5 name="car-side" size={16} color="#FFF" />}
            iconColor="#FFF"
            iconBg={SC.info}
            label="ACTIVE BOOKINGS"
            value={activeBookings.toString()}
            sub="Vehicles parked"
          />
        </View>

        <View style={s.statsRow}>
          <StatCard
            icon={<Ionicons name="location" size={20} color="#FFF" />}
            iconColor="#FFF"
            iconBg={SC.success}
            label="ACTIVE SPOTS"
            value={dashboardData.active_spots.toString()}
            sub={`${totalSlots} total slots`}
          />
          <StatCard
            icon={<Ionicons name="trending-up" size={20} color="#FFF" />}
            iconColor="#FFF"
            iconBg={SC.warning}
            label="CAPACITY"
            value={`${capacityPct}%`}
            sub={capacityPct > 80 ? 'High demand!' : 'Slots available'}
          />
        </View>

        {/* EARNINGS ANALYTICS */}
        <View style={{ marginBottom: SP.xxl }}>
          <View style={SS.sectionHeader}>
            <Text style={SS.sectionTitle}>Earnings Analytics</Text>
            <View style={SS.badge}>
              <Text style={SS.badgeText}>WEEKLY TREND</Text>
            </View>
          </View>
          <View style={[SS.card, { paddingVertical: 20 }]}>
            <MiniChart data={dashboardData.revenue_trend || [0, 0, 0, 0, 0, 0, 0]} />
          </View>
        </View>

        {/* CAPACITY BAR */}
        <View style={{ marginBottom: SP.xxl }}>
          <View style={SS.sectionHeader}>
            <Text style={SS.sectionTitle}>Capacity Usage</Text>
            <Text style={{ color: capacityPct > 80 ? SC.error : SC.success, ...TF.bodyBold }}>
              {capacityPct}% Full
            </Text>
          </View>
          <View style={s.progressBg}>
            <View
              style={[
                s.progressFill,
                {
                  width: `${capacityPct}%`,
                  backgroundColor: capacityPct > 80 ? SC.error : capacityPct > 50 ? SC.warning : SC.success,
                },
              ]}
            />
          </View>
          <Text style={{ color: SC.textMuted, ...TF.bodySm, marginTop: 6 }}>
            {occupiedSlots} of {totalSlots} slots occupied
          </Text>
        </View>

        {/* LIVE INVENTORY */}
        <View style={{ marginBottom: SP.xxl }}>
          <View style={SS.sectionHeader}>
            <Text style={SS.sectionTitle}>Live Inventory</Text>
            <View style={SS.badge}>
              <Text style={SS.badgeText}>{dashboardData.inventory?.length || 0} SPOTS</Text>
            </View>
          </View>
          {(!dashboardData.inventory || dashboardData.inventory.length === 0) ? (
            <View style={[SS.card, { alignItems: 'center', paddingVertical: 32 }]}>
              <Ionicons name="location-outline" size={36} color={SC.textMuted} />
              <Text style={[SS.emptyText, { marginTop: 12 }]}>No spots listed yet</Text>
              <TouchableOpacity
                style={[SS.primaryBtn, { marginTop: 16, paddingHorizontal: 24, paddingVertical: 12 }]}
                onPress={() => router.push('/spotter/spots')}
              >
                <Text style={SS.primaryBtnText}>Create Your First Spot</Text>
              </TouchableOpacity>
            </View>
          ) : (
            dashboardData.inventory.map((spot: any, i: number) => (
              <View key={i} style={s.inventoryCard}>
                <View style={s.inventoryIcon}>
                  {spot.car_slots > 0 ? (
                    <FontAwesome5 name="car-side" size={20} color={SC.accent} />
                  ) : (
                    <MaterialCommunityIcons name="motorbike" size={24} color={SC.textSecondary} />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: SC.textPrimary, ...TF.bodyBold }}>{spot.title}</Text>
                  <Text style={{ color: SC.textMuted, ...TF.bodySm, marginTop: 2 }}>
                    {spot.car_slots} Car · {spot.bike_slots} Bike slots
                  </Text>
                </View>
                <View
                  style={[
                    s.slotBadge,
                    spot.available_slots === 0 && { borderColor: SC.error, backgroundColor: SC.errorSoft },
                  ]}
                >
                  <Text
                    style={[
                      s.slotBadgeText,
                      spot.available_slots === 0 && { color: SC.error },
                    ]}
                  >
                    {spot.available_slots > 0 ? `${spot.available_slots} OPEN` : 'FULL'}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>

        {/* LIVE TRAFFIC */}
        <View style={{ marginBottom: SP.xl }}>
          <View style={SS.sectionHeader}>
            <Text style={SS.sectionTitle}>Live Traffic</Text>
          </View>
          {(!dashboardData.recent_traffic || dashboardData.recent_traffic.length === 0) ? (
            <View style={[SS.card, { alignItems: 'center', paddingVertical: 28 }]}>
              <Ionicons name="car-sport-outline" size={32} color={SC.textMuted} />
              <Text style={SS.emptyText}>No recent activity</Text>
            </View>
          ) : (
            dashboardData.recent_traffic.map((traffic: any, i: number) => {
              const isArrival = traffic.status === 'active';
              const isDeparture = traffic.status === 'completed';
              const isReserved = traffic.status === 'reserved';
              const iconBg = isArrival || isReserved ? SC.infoSoft : isDeparture ? SC.successSoft : SC.warningSoft;
              const iconColor = isArrival || isReserved ? SC.info : isDeparture ? SC.success : SC.warning;

              return (
                <View key={i} style={s.trafficCard}>
                  <View style={[s.trafficIcon, { backgroundColor: iconBg }]}>
                    <Ionicons
                      name={isArrival || isReserved ? 'arrow-forward' : isDeparture ? 'checkmark' : 'time'}
                      size={16}
                      color={iconColor}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: SC.textPrimary, ...TF.bodyBold }}>
                      {traffic.vehicle_subtype || traffic.vehicle_type || 'Vehicle'}
                      {isArrival ? ' Arrived' : isDeparture ? ' Completed' : ' Reserved'}
                    </Text>
                    <Text style={{ color: SC.textMuted, ...TF.bodySm, marginTop: 2 }}>
                      {traffic.parking_spots?.title || 'Spot'} · ₹{Number(traffic.total_price || 0).toFixed(0)}
                    </Text>
                  </View>
                  <View style={[s.statusChip, { backgroundColor: iconBg }]}>
                    <Text style={[s.statusChipText, { color: iconColor }]}>
                      {traffic.status?.toUpperCase()}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>

      {/* 💳 RAZORPAY CHECKOUT MODAL */}
      {razorpayOrder && (
        <RazorpayCheckout
          visible={isRazorpayVisible}
          orderId={razorpayOrder.orderId}
          amount={razorpayOrder.amount}
          currency={razorpayOrder.currency}
          keyId={razorpayOrder.keyId}
          onSuccess={handleRazorpaySuccess}
          onCancel={handleRazorpayFailure}
          onFailure={handleRazorpayFailure}
        />
      )}
    </View>
  );
}

/* ── Local Styles ──────────────────────────────────────────────── */
const s = StyleSheet.create({
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: SC.bgCard,
    borderRadius: RAD.lg,
    padding: SP.cardPadding,
    borderWidth: 1,
    borderColor: SC.border,
  },
  statIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  statLabel: {
    color: SC.textMuted,
    ...TF.labelSm,
    marginBottom: 4,
  },
  statValue: {
    color: SC.textPrimary,
    ...TF.bigValue,
    fontSize: 22,
  },
  statSub: {
    color: SC.textSecondary,
    ...TF.bodySm,
    marginTop: 4,
  },

  progressBg: {
    height: 6,
    backgroundColor: SC.border,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },

  inventoryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SC.bgCard,
    borderRadius: RAD.md,
    padding: SP.cardPadding,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: SC.border,
  },
  inventoryIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: SC.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  slotBadge: {
    borderWidth: 1,
    borderColor: SC.success,
    backgroundColor: SC.successSoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: RAD.full,
  },
  slotBadgeText: {
    color: SC.success,
    ...TF.chip,
  },

  trafficCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SC.bgCard,
    borderRadius: RAD.md,
    padding: SP.cardPadding,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: SC.border,
  },
  trafficIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  statusChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: RAD.full,
  },
  statusChipText: {
    ...TF.chip,
    fontSize: 9,
  },

  // Payout Banner
  payoutBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SC.warningSoft,
    borderRadius: RAD.md,
    padding: SP.cardPadding,
    marginBottom: SP.lg,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.2)',
    gap: 12,
  },
  payoutBannerIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  payoutBannerTitle: {
    color: SC.warning,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 2,
  },
  payoutBannerSub: {
    color: SC.textSecondary,
    fontSize: 12,
  },
});
