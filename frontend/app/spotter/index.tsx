import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Dimensions, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
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
    const errorMessage = data && data.error ? data.error.description : 'Your payment could not be processed or was cancelled.';
    Alert.alert('Payment Failed', errorMessage);
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

  useFocusEffect(
    useCallback(() => {
      fetchDashboardData();
      registerForPushNotificationsAsync();
      // Check payout account status
      apiClient.get('/payouts/account-status')
        .then(res => { if (res.data?.success) setPayoutSetup(res.data.data.is_setup); })
        .catch(() => setPayoutSetup(false));
    }, [fetchDashboardData])
  );

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
            <TouchableOpacity 
              disabled={togglingStatus}
              onPress={() => {
                Alert.alert(
                  dashboardData.global_online ? 'Go Offline?' : 'Go Online?',
                  dashboardData.global_online 
                    ? 'This will deactivate all your spots. Finders won\'t be able to book them.'
                    : 'This will activate all your spots for bookings.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Yes', onPress: () => toggleGlobalStatus(!!dashboardData.global_online) }
                  ]
                );
              }}
              style={{
                backgroundColor: 'rgba(255,255,255,0.03)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.08)',
                borderRadius: 16,
                paddingHorizontal: 12,
                paddingVertical: 8,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8
              }}
            >
              <View style={{ gap: 2 }}>
                <Text style={{ color: SC.textMuted, fontSize: 8, fontWeight: '800', letterSpacing: 0.5 }}>STATUS</Text>
                <Text style={{ color: '#FFF', fontSize: 12, fontWeight: '900' }}>
                  {togglingStatus ? 'Updating...' : (dashboardData.global_online ? 'ONLINE' : 'OFFLINE')}
                </Text>
              </View>
              {togglingStatus ? (
                <ActivityIndicator size="small" color={SC.accent} />
              ) : (
                <View 
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    backgroundColor: dashboardData.global_online ? '#10b981' : '#f43f5e',
                    shadowColor: dashboardData.global_online ? '#10b981' : '#f43f5e',
                    shadowOpacity: 0.8,
                    shadowRadius: 4,
                    elevation: 4
                  }}
                />
              )}
            </TouchableOpacity>
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
        {/* QUICK ACTIONS HUB */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: SP.xl }}>
          <TouchableOpacity
            style={[SS.primaryBtn, { flex: 1, backgroundColor: SC.info, paddingVertical: 14 }]}
            onPress={() => router.push('/spotter/verify')}
          >
            <Ionicons name="scan-circle-outline" size={24} color="#FFF" style={{ marginBottom: 4 }} />
            <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 13 }}>Verify Finder</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[SS.primaryBtn, { flex: 1, backgroundColor: SC.success, paddingVertical: 14 }]}
            onPress={() => router.push('/spotter/spots')}
          >
            <Ionicons name="add-circle-outline" size={24} color="#FFF" style={{ marginBottom: 4 }} />
            <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 13 }}>Add Spot</Text>
          </TouchableOpacity>
        </View>

        {/* ACTION REQUIRED PILLS */}
        <View style={{ marginBottom: SP.xl, gap: 8 }}>
          {dashboardData.balance < 0 ? (
            <TouchableOpacity 
              style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(239,68,68,0.15)', padding: 12, borderRadius: RAD.md, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)' }}
              onPress={handleClearDues}
              disabled={isClearingDues}
            >
              <Ionicons name="warning" size={20} color="#ef4444" style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#ef4444', fontWeight: '800', fontSize: 14 }}>Dues: ₹{Math.abs(dashboardData.balance).toFixed(2)}</Text>
                <Text style={{ color: '#f87171', fontSize: 12 }}>{dashboardData.balance <= -500 ? "Spots hidden! Clear to reactivate." : "Clear pending fees."}</Text>
              </View>
              {isClearingDues ? <ActivityIndicator color="#ef4444" /> : <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>PAY</Text>}
            </TouchableOpacity>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(16,185,129,0.15)', padding: 12, borderRadius: RAD.md, borderWidth: 1, borderColor: 'rgba(16,185,129,0.3)' }}>
              <Ionicons name="checkmark-circle" size={20} color="#10b981" style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#10b981', fontWeight: '800', fontSize: 14 }}>No Pending Dues</Text>
                <Text style={{ color: '#34d399', fontSize: 12 }}>All platform fees settled.</Text>
              </View>
              <Text style={{ color: '#10b981', fontWeight: 'bold' }}>₹0.00</Text>
            </View>
          )}

          {payoutSetup === false && (
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(245,158,11,0.15)', padding: 12, borderRadius: RAD.md, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)' }}
              onPress={() => router.push('/spotter/payout-setup')}
            >
              <Ionicons name="wallet" size={20} color="#f59e0b" style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#f59e0b', fontWeight: '800', fontSize: 14 }}>Setup Payouts</Text>
                <Text style={{ color: '#fbbf24', fontSize: 12 }}>Link bank to receive earnings.</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color="#f59e0b" />
            </TouchableOpacity>
          )}
        </View>

        {/* STATS GRID */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 12 }}>
          {/* Earnings Card */}
          <View style={{ flex: 1, backgroundColor: SC.bgCard, borderRadius: RAD.lg, padding: 16, borderWidth: 1, borderColor: SC.border, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 }}>
            <Ionicons name="cash-outline" size={20} color={SC.accent} style={{ marginBottom: 8 }} />
            <Text style={{ color: SC.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>TOTAL EARNED</Text>
            <Text style={{ color: '#FFF', fontSize: 20, fontWeight: '900', marginTop: 4 }}>₹{dashboardData.earnings.toFixed(0)}</Text>
            <Text style={{ color: SC.textMuted, fontSize: 10, marginTop: 2 }}>All-time income</Text>
          </View>

          {/* Occupancy Card */}
          <View style={{ flex: 1, backgroundColor: SC.bgCard, borderRadius: RAD.lg, padding: 16, borderWidth: 1, borderColor: SC.border, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 }}>
            <Ionicons name="pie-chart-outline" size={20} color={SC.info} style={{ marginBottom: 8 }} />
            <Text style={{ color: SC.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>OCCUPANCY</Text>
            <Text style={{ color: '#FFF', fontSize: 20, fontWeight: '900', marginTop: 4 }}>{dashboardData.occupancy_rate || 0}%</Text>
            <Text style={{ color: SC.textMuted, fontSize: 10, marginTop: 2 }}>{occupiedSlots} of {totalSlots} active</Text>
          </View>
        </View>

        <View style={{ flexDirection: 'row', gap: 12, marginBottom: SP.xl }}>
          {/* Avg Duration Card */}
          <View style={{ flex: 1, backgroundColor: SC.bgCard, borderRadius: RAD.lg, padding: 16, borderWidth: 1, borderColor: SC.border, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 }}>
            <Ionicons name="time-outline" size={20} color={SC.success} style={{ marginBottom: 8 }} />
            <Text style={{ color: SC.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>AVG DURATION</Text>
            <Text style={{ color: '#FFF', fontSize: 20, fontWeight: '900', marginTop: 4 }}>{(dashboardData.avg_duration || 0).toFixed(1)} hrs</Text>
            <Text style={{ color: SC.textMuted, fontSize: 10, marginTop: 2 }}>Per booking avg</Text>
          </View>

          {/* Demand Surge Card */}
          <View style={{ flex: 1, backgroundColor: SC.bgCard, borderRadius: RAD.lg, padding: 16, borderWidth: 1, borderColor: SC.border, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 10 }}>
            <Ionicons name="flash-outline" size={20} color={SC.warning} style={{ marginBottom: 8 }} />
            <Text style={{ color: SC.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 }}>SURGE FACTOR</Text>
            <Text style={{ color: '#FFF', fontSize: 20, fontWeight: '900', marginTop: 4 }}>{dashboardData.surge_factor || 1.0}x</Text>
            <Text style={{ color: SC.textMuted, fontSize: 10, marginTop: 2 }}>Demand pricing</Text>
          </View>
        </View>

        {/* LIVE TRAFFIC */}
        <View style={{ marginBottom: SP.xxl }}>
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
                      {traffic.parking_spots?.title || 'Spot'} · {traffic.slot_name || 'No slot'} · ₹{Number(traffic.total_price || 0).toFixed(0)}
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

        {/* ANALYTICS SECTION */}
        <View style={SS.sectionHeader}>
          <Text style={SS.sectionTitle}>Analytics & Inventory</Text>
        </View>

        {/* EARNINGS ANALYTICS */}
        <View style={{ marginBottom: SP.xl }}>
          <View style={[SS.card, { paddingVertical: 20 }]}>
            <Text style={{ color: SC.textMuted, fontSize: 12, fontWeight: '700', marginBottom: 12, marginLeft: 8 }}>WEEKLY TREND</Text>
            <MiniChart data={dashboardData.revenue_trend || [0, 0, 0, 0, 0, 0, 0]} />
          </View>
        </View>

        {/* CAPACITY BAR */}
        <View style={{ marginBottom: SP.xl }}>
          <Text style={{ color: SC.textMuted, fontSize: 12, fontWeight: '700', marginBottom: 8, marginLeft: 8 }}>CAPACITY USAGE ({capacityPct}% FULL)</Text>
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
          <Text style={{ color: SC.textMuted, ...TF.bodySm, marginTop: 6, marginLeft: 8 }}>
            {occupiedSlots} of {totalSlots} slots occupied ({totalAvailable} open slots)
          </Text>
        </View>

        {/* LIVE INVENTORY */}
        <View style={{ marginBottom: SP.xxl }}>
          <Text style={{ color: SC.textMuted, fontSize: 12, fontWeight: '700', marginBottom: 8, marginLeft: 8 }}>ACTIVE SPOTS ({dashboardData.inventory?.length || 0})</Text>
          {(!dashboardData.inventory || dashboardData.inventory.length === 0) ? (
            <View style={[SS.card, { alignItems: 'center', paddingVertical: 32 }]}>
              <Ionicons name="location-outline" size={36} color={SC.textMuted} />
              <Text style={[SS.emptyText, { marginTop: 12 }]}>No spots listed yet</Text>
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

        {/* PAYOUT HISTORY */}
        <View style={{ marginBottom: SP.xxl }}>
          <View style={SS.sectionHeader}>
            <Text style={SS.sectionTitle}>Recent Payouts</Text>
          </View>
          {(!dashboardData.payout_history || dashboardData.payout_history.length === 0) ? (
            <View style={[SS.card, { alignItems: 'center', paddingVertical: 24 }]}>
              <Ionicons name="card-outline" size={32} color={SC.textMuted} />
              <Text style={SS.emptyText}>No payout history</Text>
            </View>
          ) : (
            dashboardData.payout_history.map((payout: any, i: number) => {
              const isCompleted = payout.status === 'completed' || payout.status === 'success';
              const isFailed = payout.status === 'failed' || payout.status === 'failed_needs_retry';
              const badgeBg = isCompleted ? 'rgba(16,185,129,0.1)' : isFailed ? 'rgba(244,63,94,0.1)' : 'rgba(245,158,11,0.1)';
              const badgeText = isCompleted ? '#10b981' : isFailed ? '#f43f5e' : '#f59e0b';

              return (
                <View key={i} style={[SS.card, { flexDirection: 'row', alignItems: 'center', marginBottom: 10, paddingVertical: 14 }]}>
                  <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.03)', justifyContent: 'center', alignItems: 'center', marginRight: 12 }}>
                    <Ionicons name="receipt-outline" size={18} color={SC.textSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 13 }}>UPI Transfer ({payout.mode || 'UPI'})</Text>
                    <Text style={{ color: SC.textMuted, fontSize: 11, marginTop: 2 }}>
                      {new Date(payout.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: '#FFF', fontWeight: '900', fontSize: 15, textAlign: 'right' }}>₹{Number(payout.amount).toFixed(2)}</Text>
                    <View style={{ backgroundColor: badgeBg, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, marginTop: 4 }}>
                      <Text style={{ color: badgeText, fontSize: 9, fontWeight: '800' }}>{payout.status.toUpperCase()}</Text>
                    </View>
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
          onCancel={() => handleRazorpayFailure(null)}
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
