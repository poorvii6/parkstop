import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import apiClient from '../../api/client';
import { SC, TF, SP, RAD, SS } from '../../constants/SpotterTheme';

export default function VerifyScreen() {
  const router = useRouter();
  const [bookingId, setBookingId] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'checkin' | 'checkout'>('checkin');

  // Active bookings for quick-verify
  const [activeBookings, setActiveBookings] = useState<any[]>([]);
  const [fetchingBookings, setFetchingBookings] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    fetchActiveBookings();
  }, []);

  const fetchActiveBookings = async () => {
    try {
      const res = await apiClient.get('/bookings/spotter-bookings');
      if (res.data?.success) {
        setActiveBookings(res.data.data || []);
      }
    } catch (e) {
      console.log('Error fetching spotter bookings', e);
    } finally {
      setFetchingBookings(false);
      setRefreshing(false);
    }
  };

  const handleVerify = async () => {
    if (!bookingId || !otp) {
      Alert.alert('Missing Info', 'Please enter both Booking ID and OTP code.');
      return;
    }
    setLoading(true);
    try {
      const endpoint = mode === 'checkin' ? '/bookings/verify-otp' : '/bookings/verify-checkout-otp';
      const res = await apiClient.post(endpoint, {
        bookingId: parseInt(bookingId),
        otp,
      });
      if (res.data?.success) {
        Alert.alert(
          mode === 'checkin' ? '✅ Check-In Verified' : '✅ Checkout Verified',
          mode === 'checkin'
            ? 'Vehicle authenticated & parked successfully!'
            : 'Session completed. Payment will be processed.',
        );
        setBookingId('');
        setOtp('');
        fetchActiveBookings();
      }
    } catch (e: any) {
      Alert.alert('Verification Failed', e.response?.data?.message || 'Invalid OTP or Booking ID');
    } finally {
      setLoading(false);
    }
  };

  const quickVerify = (booking: any) => {
    setBookingId(booking.id.toString());
    setOtp('');
    if (booking.status === 'reserved') {
      setMode('checkin');
    } else if (booking.status === 'active') {
      setMode('checkout');
    }
  };

  const activeCount = activeBookings.filter(b => b.status === 'active').length;
  const reservedCount = activeBookings.filter(b => b.status === 'reserved').length;

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
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); fetchActiveBookings(); }} tintColor={SC.accent} colors={[SC.accent]} />
        }
      >
        {/* TITLE */}
        <Text style={{ color: SC.textPrimary, ...TF.h1, marginBottom: 6 }}>Verify Finder</Text>
        <Text style={{ color: SC.textSecondary, ...TF.bodySm, marginBottom: SP.xl }}>
          Verify check-in or checkout OTP to manage parking sessions.
        </Text>

        {/* MODE TOGGLE */}
        <View style={s.toggleRow}>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'checkin' && s.toggleActive]}
            onPress={() => setMode('checkin')}
          >
            <Ionicons name="arrow-forward-circle" size={18} color={mode === 'checkin' ? '#FFF' : SC.textMuted} />
            <Text style={[s.toggleText, mode === 'checkin' && { color: '#FFF' }]}>Check-In</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.toggleBtn, mode === 'checkout' && s.toggleActiveCheckout]}
            onPress={() => setMode('checkout')}
          >
            <Ionicons name="arrow-back-circle" size={18} color={mode === 'checkout' ? '#FFF' : SC.textMuted} />
            <Text style={[s.toggleText, mode === 'checkout' && { color: '#FFF' }]}>Checkout</Text>
          </TouchableOpacity>
        </View>

        {/* VERIFY FORM */}
        <View style={SS.glassCard}>
          <View style={SS.inputGroup}>
            <Text style={SS.inputLabel}>BOOKING ID</Text>
            <TextInput
              style={SS.input}
              placeholder="e.g. 42"
              placeholderTextColor={SC.textDisabled}
              value={bookingId}
              onChangeText={setBookingId}
              keyboardType="number-pad"
            />
          </View>
          <View style={SS.inputGroup}>
            <Text style={SS.inputLabel}>
              {mode === 'checkin' ? 'CHECK-IN OTP' : 'CHECKOUT OTP'}
            </Text>
            <TextInput
              style={SS.input}
              placeholder="000000"
              placeholderTextColor={SC.textDisabled}
              value={otp}
              onChangeText={setOtp}
              keyboardType="number-pad"
              maxLength={6}
            />
          </View>
          <TouchableOpacity
            style={[SS.primaryBtn, loading && { opacity: 0.7 }]}
            onPress={handleVerify}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#FFF" size="small" />
            ) : (
              <Text style={SS.primaryBtnText}>
                {mode === 'checkin' ? 'Verify & Park' : 'Verify & Complete'}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {/* QUICK STATS */}
        <View style={s.quickStatsRow}>
          <View style={[s.quickStat, { borderColor: SC.warning }]}>
            <Text style={[s.quickStatValue, { color: SC.warning }]}>{reservedCount}</Text>
            <Text style={s.quickStatLabel}>Reserved</Text>
          </View>
          <View style={[s.quickStat, { borderColor: SC.info }]}>
            <Text style={[s.quickStatValue, { color: SC.info }]}>{activeCount}</Text>
            <Text style={s.quickStatLabel}>Active</Text>
          </View>
        </View>

        {/* ACTIVE BOOKINGS */}
        <View style={{ marginTop: SP.xl }}>
          <View style={SS.sectionHeader}>
            <Text style={SS.sectionTitle}>Current Bookings</Text>
            <View style={SS.badge}>
              <Text style={SS.badgeText}>{activeBookings.length} TOTAL</Text>
            </View>
          </View>

          {fetchingBookings ? (
            <ActivityIndicator color={SC.accent} style={{ marginTop: 20 }} />
          ) : activeBookings.length === 0 ? (
            <View style={[SS.card, { alignItems: 'center', paddingVertical: 28 }]}>
              <Ionicons name="shield-outline" size={32} color={SC.textMuted} />
              <Text style={SS.emptyText}>No active bookings to verify</Text>
            </View>
          ) : (
            activeBookings.map((booking: any, i: number) => {
              const isReserved = booking.status === 'reserved';
              const isActive = booking.status === 'active';
              const chipColor = isReserved ? SC.warning : isActive ? SC.info : SC.success;
              const chipBg = isReserved ? SC.warningSoft : isActive ? SC.infoSoft : SC.successSoft;

              return (
                <TouchableOpacity
                  key={i}
                  style={s.bookingCard}
                  onPress={() => quickVerify(booking)}
                  activeOpacity={0.8}
                >
                  <View style={[s.bookingIcon, { backgroundColor: chipBg }]}>
                    <Ionicons
                      name={isReserved ? 'time' : isActive ? 'car' : 'checkmark-circle'}
                      size={18}
                      color={chipColor}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: SC.textPrimary, ...TF.bodyBold }}>
                      Booking #{booking.id}
                    </Text>
                    <Text style={{ color: SC.textMuted, ...TF.bodySm, marginTop: 2 }}>
                      {booking.vehicle_subtype || booking.vehicle_type || 'Vehicle'} · Slot {booking.slot_name || '—'}
                    </Text>
                  </View>
                  <View style={[s.bookingChip, { backgroundColor: chipBg }]}>
                    <Text style={[s.bookingChipText, { color: chipColor }]}>
                      {booking.status?.toUpperCase()}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: SP.xl,
  },
  toggleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: RAD.sm,
    backgroundColor: SC.bgCard,
    borderWidth: 1,
    borderColor: SC.border,
  },
  toggleActive: {
    backgroundColor: SC.accent,
    borderColor: SC.accent,
  },
  toggleActiveCheckout: {
    backgroundColor: SC.info,
    borderColor: SC.info,
  },
  toggleText: {
    color: SC.textMuted,
    ...TF.btnSecondary,
  },

  quickStatsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: SP.xl,
  },
  quickStat: {
    flex: 1,
    backgroundColor: SC.bgCard,
    borderRadius: RAD.md,
    padding: SP.cardPadding,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: SC.border,
    borderLeftWidth: 3,
  },
  quickStatValue: {
    ...TF.bigValue,
    fontSize: 24,
  },
  quickStatLabel: {
    color: SC.textMuted,
    ...TF.labelSm,
    marginTop: 4,
  },

  bookingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SC.bgCard,
    borderRadius: RAD.md,
    padding: SP.cardPadding,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: SC.border,
  },
  bookingIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  bookingChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: RAD.full,
  },
  bookingChipText: {
    ...TF.chip,
    fontSize: 9,
  },
});
