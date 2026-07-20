import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ScrollView, ActivityIndicator, RefreshControl, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import apiClient from '../../api/client';
import { onRealtime } from '../../services/realtime';
import Toast from '../../components/Toast';
import { SC, TF, SP, RAD, SS } from '../../constants/SpotterTheme';

export default function VerifyScreen() {
  const router = useRouter();
  const [bookingId, setBookingId] = useState('');
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'checkin' | 'checkout'>('checkin');
  const [checkoutData, setCheckoutData] = useState<any>(null);

  // Active bookings for quick-verify
  const [activeBookings, setActiveBookings] = useState<any[]>([]);
  const [fetchingBookings, setFetchingBookings] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [spotterUpiId, setSpotterUpiId] = useState<string | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  // Booking is chosen by TAPPING a card; typing an ID is a fallback only.
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' | 'info' } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const showToast = (msg: string, kind: 'success' | 'error' | 'info' = 'success') =>
    setToast({ msg, kind });
  const scrollRef = React.useRef<ScrollView | null>(null);
  const selectedBooking = activeBookings.find((b: any) => b.id?.toString() === bookingId) || null;

  useEffect(() => {
    fetchActiveBookings();
    checkPayoutStatus();
  }, []);

  // Live: a booking made right now appears in the list without a refresh, so
  // the driver isn't standing there while the host pulls to reload.
  useEffect(() => {
    const offNew = onRealtime('booking:new', () => fetchActiveBookings());
    const offCancelled = onRealtime('booking:cancelled', () => fetchActiveBookings());
    return () => { offNew(); offCancelled(); };
  }, []);

  // Poll for payment status in real-time when checkout QR is open
  useEffect(() => {
    let interval: any;
    if (checkoutData && checkoutData.booking_id) {
      interval = setInterval(async () => {
        try {
          const res = await apiClient.get('/bookings/spotter-bookings');
          if (res.data?.success) {
            const bookings = res.data.data;
            const current = bookings.find((b: any) => b.id === checkoutData.booking_id);
            if (current) {
              if (current.payment_status === 'paid') {
                clearInterval(interval);
                Alert.alert(
                  '✅ Payment Received!',
                  'The Finder has completed the online payment successfully.',
                  [
                    {
                      text: 'OK',
                      onPress: () => {
                        setCheckoutData(null);
                        setBookingId('');
                        fetchActiveBookings();
                      }
                    }
                  ]
                );
              }
            }
          }
        } catch (err) {
          console.log('Error polling payment status:', err);
        }
      }, 8000); // fallback safety net; the socket below is the fast path
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [checkoutData]);

  // Fast path: the backend emits when payment lands, so the host sees it
  // immediately instead of waiting for the next poll.
  useEffect(() => {
    if (!checkoutData?.booking_id) return;
    const off = onRealtime('booking:paid', (payload: any) => {
      if (payload?.bookingId === checkoutData.booking_id) {
        showToast('Payment received — session complete', 'success');
        setCheckoutData(null);
        setBookingId('');
        fetchActiveBookings();
      }
    });
    return off;
  }, [checkoutData]);

  const checkPayoutStatus = async () => {
    try {
      const res = await apiClient.get('/payouts/account-status');
      if (res.data?.success) {
        if (res.data.data.upi_id) setSpotterUpiId(res.data.data.upi_id);
        if (res.data.data.bank_account_name) setAccountName(res.data.data.bank_account_name);
      }
    } catch (e) {
      console.log('Error fetching payout status', e);
    }
  };

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
      showToast(bookingId ? 'Enter the OTP code' : 'Select a booking first', 'info');
      return;
    }
    setLoading(true);
    setFormError(null);
    try {
      const endpoint = mode === 'checkin' ? '/bookings/verify-otp' : '/bookings/verify-checkout-otp';
      const res = await apiClient.post(endpoint, {
        bookingId: parseInt(bookingId),
        otp,
      });
      if (res.data?.success) {
        // Non-blocking: hosts often verify several cars in a row.
        showToast(
          mode === 'checkin' ? 'Checked in — vehicle parked' : 'Checked out — session complete',
          'success'
        );
        setBookingId('');
        setOtp('');
        fetchActiveBookings();
      }
    } catch (e: any) {
      // Inline error keeps the OTP on screen so it can be corrected directly.
      setFormError(e.response?.data?.message || 'Invalid OTP — please check and try again');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateQR = async () => {
    if (!bookingId) {
      Alert.alert('Missing Info', 'Please enter a Booking ID.');
      return;
    }
    setLoading(true);
    try {
      const res = await apiClient.get(`/bookings/${bookingId}/checkout-amount`);
      if (res.data?.success) {
        setCheckoutData(res.data.data);
      }
    } catch (e: any) {
      Alert.alert('Failed to generate QR', e.response?.data?.message || 'Could not fetch amount');
    } finally {
      setLoading(false);
    }
  };

  const handleCheckoutUnpaid = async () => {
    if (!bookingId) return;
    setLoading(true);
    try {
      const res = await apiClient.put(`/bookings/${bookingId}/checkout-unpaid`);
      if (res.data?.success) {
        showToast('Marked unpaid — your earnings were credited to your wallet', 'success');
        setCheckoutData(null);
        setBookingId('');
        fetchActiveBookings();
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Could not process unpaid checkout');
    } finally {
      setLoading(false);
    }
  };

  const handleCollectCash = async () => {
    if (!bookingId) return;
    setLoading(true);
    try {
      const res = await apiClient.put(`/bookings/${bookingId}/checkout-cash`);
      if (res.data?.success) {
        showToast('Cash collected — platform fee deducted from your wallet', 'success');
        setCheckoutData(null);
        setBookingId('');
        fetchActiveBookings();
      }
    } catch (e: any) {
      Alert.alert('Error', e.response?.data?.message || 'Could not process cash checkout');
    } finally {
      setLoading(false);
    }
  };

  const quickVerify = async (booking: any) => {
    setBookingId(booking.id.toString());
    setOtp('');
    // Bring the verification form into view so the OTP field is right there.
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    if (booking.status === 'reserved') {
      setMode('checkin');
      setCheckoutData(null);
    } else if (booking.status === 'active') {
      setMode('checkout');
      setLoading(true);
      try {
        const res = await apiClient.get(`/bookings/${booking.id}/checkout-amount`);
        if (res.data?.success) {
          setCheckoutData(res.data.data);
        }
      } catch (e: any) {
        Alert.alert('Failed to generate QR', e.response?.data?.message || 'Could not fetch amount');
      } finally {
        setLoading(false);
      }
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
              <Text style={SS.statusLabel}>SPOT OWNER STATUS</Text>
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

      <Toast message={toast?.msg ?? null} kind={toast?.kind} onHide={() => setToast(null)} />
      <ScrollView
        ref={scrollRef}
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

        {/* VERIFY FORM OR QR CODE */}
        <View style={SS.glassCard}>
          {mode === 'checkout' && checkoutData ? (
            <View style={{ alignItems: 'center', paddingVertical: SP.md }}>
              <Text style={{ color: SC.textPrimary, ...TF.h2, marginBottom: 8 }}>
                Booking #{checkoutData.booking_id}
              </Text>
              
              <View style={{ width: '100%', backgroundColor: SC.bg, padding: SP.md, borderRadius: RAD.sm, marginBottom: SP.lg }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                  <Text style={{ color: SC.textSecondary }}>Base Fare</Text>
                  <Text style={{ color: SC.textPrimary }}>₹{checkoutData.base_price}</Text>
                </View>
                {checkoutData.arrears > 0 && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                    <Text style={{ color: SC.error }}>Previous Arrears</Text>
                    <Text style={{ color: SC.error }}>₹{checkoutData.arrears}</Text>
                  </View>
                )}
                <View style={{ height: 1, backgroundColor: SC.border, marginVertical: 8 }} />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: SC.textPrimary, ...TF.bodyBold }}>Total Due</Text>
                  <Text style={{ color: SC.accent, ...TF.h2 }}>₹{checkoutData.total_amount}</Text>
                </View>
              </View>

              <Text style={{ color: SC.textSecondary, marginBottom: SP.md, textAlign: 'center' }}>
                Ask the Finder to scan this QR code using PhonePe, GPay, or Paytm.
              </Text>

              <View style={{ padding: 12, backgroundColor: '#FFF', borderRadius: RAD.md, marginBottom: SP.xl, alignItems: 'center' }}>
                <View style={{ width: 200, height: 200 }}>
                  <Image 
                    source={{ uri: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`upi://pay?pa=${spotterUpiId || 'parkstop@upi'}&pn=${accountName || 'ParkStop'}&am=${checkoutData.total_amount}&tr=${checkoutData.booking_id}`)}` }}
                    style={{ width: 200, height: 200 }}
                  />
                </View>
              </View>

              <View style={{ flexDirection: 'column', gap: 12, width: '100%' }}>
                <TouchableOpacity
                  style={[SS.primaryBtn, { backgroundColor: SC.success, width: '100%' }, loading && { opacity: 0.7 }]}
                  onPress={handleCollectCash}
                  disabled={loading}
                >
                  {loading ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={SS.primaryBtnText}>Collected Cash & Complete</Text>}
                </TouchableOpacity>

                <TouchableOpacity
                  style={[SS.primaryBtn, { backgroundColor: SC.error, width: '100%' }, loading && { opacity: 0.7 }]}
                  onPress={handleCheckoutUnpaid}
                  disabled={loading}
                >
                  {loading ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={SS.primaryBtnText}>Mark as Unpaid (Arrears)</Text>}
                </TouchableOpacity>
              </View>
              
              <TouchableOpacity
                style={{ marginTop: SP.md, padding: 8 }}
                onPress={() => setCheckoutData(null)}
              >
                <Text style={{ color: SC.textMuted }}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={SS.inputGroup}>
                <Text style={SS.inputLabel}>BOOKING ID</Text>
                {/* Always typeable; tapping a booking card below fills this in. */}
                <TextInput
                  style={[SS.input, selectedBooking && { borderColor: SC.accent }]}
                  placeholder="e.g. 42  ·  or tap a booking below"
                  placeholderTextColor={SC.textDisabled}
                  value={bookingId}
                  onChangeText={(v) => { setBookingId(v); if (formError) setFormError(null); }}
                  keyboardType="number-pad"
                />

                {/* Confirms WHICH booking the ID refers to — prevents verifying
                    the wrong car when several are parked. */}
                {selectedBooking && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
                    <Ionicons name="checkmark-circle" size={16} color={SC.accent} />
                    <Text style={{ color: SC.textMuted, ...TF.caption, flex: 1 }} numberOfLines={1}>
                      {selectedBooking.users?.full_name || 'Driver'} · {selectedBooking.parking_spots?.title || 'Spot'} · {selectedBooking.status}
                    </Text>
                  </View>
                )}
              </View>
              
              {mode === 'checkin' && (
                <View style={SS.inputGroup}>
                  <Text style={SS.inputLabel}>CHECK-IN OTP</Text>
                  <TextInput
                    style={SS.input}
                    placeholder="000000"
                    placeholderTextColor={SC.textDisabled}
                    value={otp}
                    onChangeText={(v) => { setOtp(v); if (formError) setFormError(null); }}
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                </View>
              )}

              {/* Inline error — correct the OTP without dismissing a modal */}
              {formError && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: SP.md, padding: 12, borderRadius: RAD.md, backgroundColor: 'rgba(239,68,68,0.10)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.35)' }}>
                  <Ionicons name="alert-circle" size={18} color={SC.error} />
                  <Text style={{ color: SC.error, ...TF.caption, flex: 1 }}>{formError}</Text>
                </View>
              )}

              <TouchableOpacity
                style={[
                  SS.primaryBtn,
                  mode === 'checkout' && { backgroundColor: SC.info },
                  (loading || !bookingId) && { opacity: 0.5 },
                ]}
                onPress={mode === 'checkin' ? handleVerify : handleGenerateQR}
                disabled={loading || !bookingId}
              >
                {loading ? (
                  <ActivityIndicator color="#FFF" size="small" />
                ) : (
                  <Text style={SS.primaryBtnText}>
                    {mode === 'checkin' ? 'Verify & Park' : 'Generate Exit QR'}
                  </Text>
                )}
              </TouchableOpacity>
            </>
          )}
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
                  style={[
                    s.bookingCard,
                    bookingId === booking.id?.toString() && { borderColor: SC.accent, borderWidth: 1.5 },
                  ]}
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
