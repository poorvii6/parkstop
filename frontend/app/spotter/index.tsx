import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons, FontAwesome5, MaterialCommunityIcons } from '@expo/vector-icons';
import apiClient from '../../api/client';
import Toast from '../../components/Toast';
import RevenueChart from '../../components/spotter/RevenueChart';
import { useSpotterDashboard } from '../../hooks/useSpotterDashboard';
import { SC, TF, SP, RAD, SS } from '../../constants/SpotterTheme';
import RazorpayCheckout from '../../components/RazorpayCheckout';
import { Alert } from 'react-native';

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
  const {
    data: dashboardData,
    loading,
    refreshing,
    loadFailed,
    lastSyncedAt,
    payoutSetup,
    refetch: fetchDashboardData,
    onRefresh,
  } = useSpotterDashboard();
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null);

  const toggleGlobalStatus = async (currentStatus: boolean) => {
    setTogglingStatus(true);
    try {
      const res = await apiClient.put('/spots/toggle-all', { online: !currentStatus });
      if (res.data?.success) {
        setToast({ msg: res.data.message || (currentStatus ? 'Spots taken offline' : 'Spots are live'), kind: 'success' });
        fetchDashboardData();
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Failed to update spots status');
    } finally {
      setTogglingStatus(false);
    }
  };

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
      // Keep the dues button in its spinner state until verification returns.
      // (This previously flipped the whole dashboard into its loading screen,
      // which read as "the app restarted" right after paying.)
      setIsClearingDues(true);
      const res = await apiClient.post('/payments/verify-dues', {
        razorpay_order_id: data.razorpay_order_id,
        razorpay_payment_id: data.razorpay_payment_id,
        razorpay_signature: data.razorpay_signature,
      });
      if (res.data.success) {
        setToast({ msg: 'Dues cleared — your wallet is settled', kind: 'success' });
        fetchDashboardData();
      } else {
        Alert.alert('Error', 'Payment verification failed');
      }
    } catch (e) {
      Alert.alert('Error', 'Payment verification failed');
    } finally {
      setIsClearingDues(false);
    }
  };

  const handleRazorpayFailure = (data: any) => {
    setIsRazorpayVisible(false);
    const errorMessage = data && data.error ? data.error.description : 'Your payment could not be processed or was cancelled.';
    Alert.alert('Payment Failed', errorMessage);
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
      <Toast message={toast?.msg ?? null} kind={toast?.kind} onHide={() => setToast(null)} />
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
              accessibilityRole="switch"
              accessibilityState={{ checked: !!dashboardData.global_online, busy: togglingStatus }}
              accessibilityLabel={dashboardData.global_online ? 'You are online' : 'You are offline'}
              accessibilityHint={
                dashboardData.global_online
                  ? 'Double tap to go offline and hide all your spots from drivers'
                  : 'Double tap to go online and make your spots bookable'
              }
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
            <TouchableOpacity
              onPress={() => router.push('/modal')}
              style={SS.profileBtn}
              accessibilityRole="button"
              accessibilityLabel="Open profile and settings"
            >
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
        {/* OFFLINE BANNER — the numbers below may be stale, say so plainly. */}
        {loadFailed && (
          <TouchableOpacity
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 8,
              backgroundColor: 'rgba(245,158,11,0.15)', padding: 12,
              borderRadius: RAD.md, borderWidth: 1,
              borderColor: 'rgba(245,158,11,0.3)', marginBottom: SP.lg,
            }}
            onPress={onRefresh}
            accessibilityRole="button"
            accessibilityLabel="Could not sync. Tap to retry."
          >
            <Ionicons name="cloud-offline-outline" size={18} color={SC.warning} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: SC.warning, fontWeight: '800', fontSize: 13 }}>
                Couldn&apos;t sync
              </Text>
              <Text style={{ color: SC.textSecondary, fontSize: 11, fontWeight: '600' }}>
                {lastSyncedAt
                  ? `Showing data from ${lastSyncedAt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}. Tap to retry.`
                  : 'These figures may be incomplete. Tap to retry.'}
              </Text>
            </View>
            <Ionicons name="refresh" size={16} color={SC.warning} />
          </TouchableOpacity>
        )}

        {/* QUICK ACTIONS HUB */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: SP.xl }}>
          <TouchableOpacity
            style={[SS.primaryBtn, { flex: 1, backgroundColor: SC.info, paddingVertical: 14 }]}
            onPress={() => router.push('/spotter/verify')}
            accessibilityRole="button"
            accessibilityLabel="Verify a finder's booking"
          >
            <Ionicons name="scan-circle-outline" size={24} color="#FFF" style={{ marginBottom: 4 }} />
            <Text style={{ color: '#FFF', fontWeight: '800', fontSize: 13 }}>Verify Finder</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[SS.primaryBtn, { flex: 1, backgroundColor: SC.success, paddingVertical: 14 }]}
            onPress={() => router.push('/spotter/spots')}
            accessibilityRole="button"
            accessibilityLabel="Add a new parking spot"
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
              accessibilityRole="button"
              accessibilityState={{ disabled: isClearingDues, busy: isClearingDues }}
              accessibilityLabel={`Pay outstanding dues of ${Math.abs(dashboardData.balance).toFixed(2)} rupees`}
              accessibilityHint="Opens payment to settle your platform fees"
            >
              <Ionicons name="warning" size={20} color="#ef4444" style={{ marginRight: 8 }} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#ef4444', fontWeight: '800', fontSize: 14 }}>Dues: ₹{Math.abs(dashboardData.balance).toFixed(2)}</Text>
                <Text style={{ color: '#f87171', fontSize: 12 }}>{dashboardData.balance <= -500 ? "Spots hidden! Clear to reactivate." : "Clear pending fees."}</Text>
              </View>
              {isClearingDues ? <ActivityIndicator color="#ef4444" /> : <Text style={{ color: '#ef4444', fontWeight: 'bold' }}>PAY</Text>}
            </TouchableOpacity>
          ) : null}

          {/* A dues figure with no explanation is the top Spotter complaint.
              This gives them a way to see exactly which bookings produced it. */}
          {dashboardData.balance < 0 && (
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 8 }}
              onPress={() => router.push('/spotter/earnings')}
              accessibilityRole="button"
              accessibilityLabel="See a breakdown of where your dues came from"
            >
              <Ionicons name="receipt-outline" size={14} color={SC.textSecondary} />
              <Text style={{ color: SC.textSecondary, fontSize: 12, fontWeight: '700' }}>
                Where did this come from?
              </Text>
            </TouchableOpacity>
          )}

          {dashboardData.balance >= 0 && (
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
              <Text style={{ color: SC.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6, paddingHorizontal: 20 }}>
                Bookings appear here the moment a driver reserves one of your spots.
              </Text>
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
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, marginLeft: 8 }}>
              <Text style={{ color: SC.textMuted, fontSize: 12, fontWeight: '700' }}>WEEKLY TREND</Text>
              <TouchableOpacity
                onPress={() => router.push('/spotter/earnings')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4 }}
                accessibilityRole="button"
                accessibilityLabel="View itemised earnings breakdown"
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={{ color: SC.accent, fontSize: 12, fontWeight: '700' }}>Breakdown</Text>
                <Ionicons name="chevron-forward" size={13} color={SC.accent} />
              </TouchableOpacity>
            </View>
            <RevenueChart data={dashboardData.revenue_trend || [0, 0, 0, 0, 0, 0, 0]} />
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
              <Text style={{ color: SC.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6, paddingHorizontal: 20 }}>
                List your driveway or garage to start earning from drivers nearby.
              </Text>
              <TouchableOpacity
                onPress={() => router.push('/spotter/spots')}
                style={{ marginTop: 16, backgroundColor: SC.accent, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 12 }}
              >
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>Add your first spot</Text>
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

        {/* PAYOUT HISTORY */}
        <View style={{ marginBottom: SP.xxl }}>
          <View style={SS.sectionHeader}>
            <Text style={SS.sectionTitle}>Recent Payouts</Text>
          </View>
          {(!dashboardData.payout_history || dashboardData.payout_history.length === 0) ? (
            <View style={[SS.card, { alignItems: 'center', paddingVertical: 24 }]}>
              <Ionicons name="card-outline" size={32} color={SC.textMuted} />
              <Text style={SS.emptyText}>No payout history</Text>
              <Text style={{ color: SC.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6, paddingHorizontal: 20 }}>
                Earnings are paid out automatically after each completed booking.
              </Text>
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
