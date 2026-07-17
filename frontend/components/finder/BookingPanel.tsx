import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { BlueprintTheme, BlueprintColors } from '../../constants/BlueprintTheme';

interface BookingPanelProps {
  step: string;
  spots: any[];
  selectedSpotId: string | null;
  setSelectedSpotId: (id: string | null) => void;
  setStep: (step: any) => void;
  bookingDetails: any;
  isLoading: boolean;
  isBottomPanelFull: boolean;
  onConfirmBooking: () => void;
  onStartNavigation: () => void;
  onEndSession: () => void;
  onStripePayment: () => void;
  onBackToSearch: () => void;
  centerRoute: () => void;
  selectedSlot?: string;
  vehicleType?: string;
  vehicleSubType?: string;
}

export const BookingPanel: React.FC<BookingPanelProps> = ({
  step,
  spots,
  selectedSpotId,
  setSelectedSpotId,
  setStep,
  bookingDetails,
  isLoading,
  isBottomPanelFull,
  onConfirmBooking,
  onStartNavigation,
  onEndSession,
  onStripePayment,
  onBackToSearch,
  centerRoute,
  selectedSlot,
  vehicleType,
  vehicleSubType,
}) => {
  const selectedSpot = spots.find(s => s.id === selectedSpotId);

  return (
    <View style={[styles.bottomPanelContainer, isBottomPanelFull && styles.fullBottomPanel]}>
      <View style={[BlueprintTheme.glassCard, styles.glassPanel, isBottomPanelFull && styles.fullGlassPanel]}>
        
        {step === 'search' && (
          <>
            <Text style={styles.panelTitle}>Available Parking Spots Near My Location</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 16 }}
              decelerationRate="fast"
              snapToInterval={220}
            >
              {spots.length > 0 ? spots.map(spot => (
                <TouchableOpacity
                  key={spot.id}
                  activeOpacity={0.7}
                  style={[styles.spotCard, selectedSpotId === spot.id && styles.activeSpotCard]}
                  onPress={() => {
                    setSelectedSpotId(spot.id);
                    setStep('preview');
                    setTimeout(centerRoute, 100);
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={styles.spotOwner} numberOfLines={1}>{spot.title}</Text>
                    {spot.surge_multiplier > 1.0 && <Text style={{ color: '#BEF264', fontWeight: '900', fontSize: 10 }}>⚡ {spot.surge_multiplier}x</Text>}
                  </View>
                  <Text style={styles.spotDetails}>${spot.price.toFixed(2)}/hr</Text>
                  <Text style={[styles.statusText, { color: spot.available ? BlueprintColors.success : BlueprintColors.error }]}>
                    {spot.available ? '● Available' : '● Full'}
                  </Text>
                </TouchableOpacity>
              )) : (
                <Text style={styles.descText}>Searching for nearby spots...</Text>
              )}
            </ScrollView>
          </>
        )}

        {step === 'preview' && selectedSpot && (
          <View style={styles.bottomSheetInner}>
            <View style={styles.pullHandle} />
            <View style={styles.routingHeader}>
              <TouchableOpacity onPress={onBackToSearch} style={styles.backBadge}>
                <Text style={styles.backBadgeText}>← Back</Text>
              </TouchableOpacity>
              <View style={{ flex: 1 }}>
                <Text style={styles.panelTitle}>{selectedSpot.title}</Text>
                <Text style={styles.spotSubText}>5 mins away • {selectedSpot.location_type || 'Urban'} Area</Text>
              </View>
            </View>

            <View style={styles.pricingBreakdownCard}>
              <View style={styles.priceHeader}>
                <View>
                  <Text style={styles.priceMainLabel}>Dynamic Rate</Text>
                  <Text style={styles.priceValue}>${selectedSpot.price}/hr</Text>
                </View>
                <View style={styles.pricingVisualBadge}>
                  <Text style={{ fontSize: 20 }}>💎</Text>
                </View>
              </View>
              <View style={styles.multiplierRow}>
                {selectedSpot.surge_multiplier > 1.0 ? (
                  <View style={[styles.badge, { backgroundColor: 'rgba(190, 242, 100, 0.1)' }]}>
                    <Text style={[styles.badgeText, { color: '#BEF264' }]}>⚡ SURGE {selectedSpot.surge_multiplier}x</Text>
                  </View>
                ) : (
                  <View style={styles.badge}><Text style={styles.badgeText}>NORMAL RATE</Text></View>
                )}
                <View style={styles.badge}><Text style={styles.badgeText}>📍 PREMIUM ZONE</Text></View>
              </View>
            </View>

            <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={onConfirmBooking}>
              <Text style={BlueprintTheme.buttonPrimaryText}>{isLoading ? 'Loading...' : 'Book This Spot'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* BOOKING CONFIRMED — Shows OTP, booking ID, and navigate button */}
        {step === 'booking_confirm' && (
          <View style={{ alignItems: 'center', paddingVertical: 20 }}>
            <Text style={{ fontSize: 64, marginBottom: 16 }}>✅</Text>
            <Text style={{ color: '#fff', fontSize: 24, fontWeight: '900', marginBottom: 8 }}>Booking Confirmed!</Text>

            <View style={styles.bookingConfirmCard}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.1)' }}>
                <View>
                  <Text style={styles.bookingLabel}>BOOKING ID</Text>
                  <Text style={styles.bookingValue}>#{bookingDetails?.id}</Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.bookingLabel}>SLOT</Text>
                  <Text style={[styles.bookingValue, { color: '#6366f1' }]}>{selectedSlot || 'Auto'}</Text>
                </View>
              </View>

              <View style={{ alignItems: 'center' }}>
                <Text style={styles.bookingLabel}>CHECK-IN OTP</Text>
                <Text style={styles.otpValueLarge}>{bookingDetails?.otp}</Text>
                <Text style={{ color: '#94a3b8', fontSize: 12, textAlign: 'center', marginTop: 8 }}>Show this OTP to the spot owner when you arrive.</Text>
              </View>
            </View>

            <TouchableOpacity style={[BlueprintTheme.buttonPrimary, { width: '100%' }]} onPress={onStartNavigation}>
              <Text style={BlueprintTheme.buttonPrimaryText}>Navigate to Spot</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'navigating' && (
          <View style={{ alignItems: 'center', paddingVertical: 10 }}>
            <Text style={styles.panelTitle}>Route Ready</Text>
            <Text style={{ color: BlueprintColors.textSecondary, marginBottom: 20 }}>Tap start to begin navigation</Text>
            <TouchableOpacity 
              style={[BlueprintTheme.buttonPrimary, { width: '100%', backgroundColor: BlueprintColors.success }]} 
              onPress={onStartNavigation}
            >
              <Text style={[BlueprintTheme.buttonPrimaryText, { fontSize: 20 }]}>▶ Start</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'arriving' && (
          <>
            <View style={styles.otpSection}>
              <Text style={styles.panelTitle}>Host Verification</Text>
              <Text style={styles.otpDesc}>Please share this OTP with the spot owner to activate your session.</Text>
              <View style={styles.otpRow}>
                <View style={styles.otpItem}>
                  <Text style={styles.infoLabel}>BOOKING ID</Text>
                  <Text style={styles.otpValue}>{bookingDetails?.id}</Text>
                </View>
                <View style={styles.otpItem}>
                  <Text style={styles.infoLabel}>OTP CODE</Text>
                  <Text style={styles.otpValue}>{bookingDetails?.otp}</Text>
                </View>
              </View>
            </View>
            <TouchableOpacity 
              style={[BlueprintTheme.buttonPrimary, styles.simulateBtn]} 
              onPress={() => setStep('active_parking')}
            >
              <Text style={styles.simulateBtnText}>Simulate Spot Owner Verification</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'active_parking' && (
          <View style={{ paddingVertical: 10 }}>
            <View style={styles.activeSessionHeader}>
              <View>
                <Text style={styles.panelTitle}>Active Session</Text>
                <Text style={{ color: BlueprintColors.success, fontWeight: '700' }}>● Parking in progress</Text>
                {selectedSlot && <Text style={{ color: BlueprintColors.textSecondary, marginTop: 4 }}>Slot {selectedSlot}</Text>}
              </View>
              <View style={styles.timerBadge}>
                <Text style={styles.timerLabel}>PARKED FOR</Text>
                <Text style={styles.timerValue}>0h 12m</Text>
              </View>
            </View>

            <View style={styles.overstayWarning}>
              <Text style={{ color: '#f43f5e', fontWeight: '800', marginBottom: 4 }}>⚠️ Overstay Warning</Text>
              <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 13 }}>If you park 20+ mins past your booked time, extra charges will apply automatically.</Text>
            </View>

            <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={() => setStep('checkout_verification')}>
              <Text style={BlueprintTheme.buttonPrimaryText}>End Session</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* CHECKOUT VERIFICATION — Check-out OTP step */}
        {step === 'checkout_verification' && (
          <View style={{ alignItems: 'center', paddingVertical: 10 }}>
            <Text style={styles.panelTitle}>Check-Out Verification</Text>
            <Text style={{ color: BlueprintColors.textSecondary, marginBottom: 24, textAlign: 'center' }}>Show this check-out OTP to the spot owner to confirm you are leaving.</Text>

            <View style={styles.checkoutOtpCard}>
              <Text style={styles.bookingLabel}>CHECK-OUT OTP</Text>
              <Text style={[styles.otpValueLarge, { color: '#6366f1' }]}>{bookingDetails?.checkoutOtp || '8921'}</Text>
            </View>

            <TouchableOpacity style={[BlueprintTheme.buttonPrimary, { width: '100%' }]} onPress={onEndSession}>
              <Text style={BlueprintTheme.buttonPrimaryText}>Simulate Spot Owner Check-Out</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'payment' && (
          <View style={styles.paymentContainer}>
            <Text style={styles.panelTitle}>Final Bill Summary</Text>
            <View style={styles.receiptLine}>
              <Text style={styles.receiptLabel}>Total Stay Duration</Text>
              <Text style={styles.receiptValue}>1h 12m</Text>
            </View>
            <View style={styles.receiptLine}>
              <Text style={styles.receiptLabel}>Dynamic Rate Applied</Text>
              <Text style={styles.receiptValue}>${selectedSpot?.price}/hr</Text>
            </View>
            <View style={styles.receiptLine}>
              <Text style={styles.receiptLabel}>Platform Service Fee</Text>
              <Text style={styles.receiptValue}>$1.50</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total Amount</Text>
              <Text style={styles.totalValue}>${(Number(bookingDetails?.totalPrice || 0) + 1.5).toFixed(2)}</Text>
            </View>
            <TouchableOpacity style={[BlueprintTheme.buttonPrimary, { marginTop: 24 }]} onPress={onStripePayment}>
              <Text style={BlueprintTheme.buttonPrimaryText}>{isLoading ? 'Processing...' : 'Pay with Stripe'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'receipt' && (
          <View style={styles.receiptContainer}>
            <View style={styles.successIcon}><Text style={{ fontSize: 40 }}>✅</Text></View>
            <Text style={[styles.panelTitle, { textAlign: 'center' }]}>Payment Successful!</Text>
            <Text style={styles.receiptMsg}>
              A copy of the receipt has been sent to your email. Thank you for using ParkStop.
            </Text>
            <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={onBackToSearch}>
              <Text style={BlueprintTheme.buttonPrimaryText}>Back to Dashboard</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  bottomPanelContainer: { position: 'absolute', bottom: 20, left: 20, right: 20 },
  fullBottomPanel: { bottom: 0, left: 0, right: 0 },
  glassPanel: { paddingBottom: 20 },
  fullGlassPanel: { borderRadius: 0, borderTopLeftRadius: 32, borderTopRightRadius: 32, paddingBottom: 40 },
  panelTitle: { fontSize: 22, fontWeight: '900', color: '#FFFFFF', marginBottom: 16 },
  spotCard: { 
    backgroundColor: 'rgba(255,255,255,0.03)', 
    padding: 16, 
    borderRadius: 20, 
    marginRight: 16, 
    width: 200, 
    borderWidth: 1, 
    borderColor: 'rgba(255,255,255,0.05)' 
  },
  activeSpotCard: { borderColor: BlueprintColors.primaryAccent, backgroundColor: 'rgba(255,107,44,0.1)' },
  spotOwner: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  spotDetails: { fontSize: 13, color: BlueprintColors.textSecondary, marginTop: 4 },
  statusText: { fontSize: 12, fontWeight: '700', marginTop: 8 },
  descText: { color: BlueprintColors.textSecondary, fontSize: 14, padding: 10 },
  bottomSheetInner: { paddingTop: 0 },
  pullHandle: {
    width: 40,
    height: 5,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 2.5,
    alignSelf: 'center',
    marginBottom: 20,
  },
  routingHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  backBadge: { backgroundColor: 'rgba(255,107,44,0.1)', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, marginRight: 12 },
  backBadgeText: { color: BlueprintColors.primaryAccent, fontWeight: '800', fontSize: 13 },
  spotSubText: { color: BlueprintColors.textSecondary, fontSize: 13 },
  pricingBreakdownCard: { 
    backgroundColor: 'rgba(255,255,255,0.05)', 
    borderRadius: 20, 
    padding: 16, 
    marginBottom: 24, 
    borderWidth: 1, 
    borderColor: 'rgba(255,255,255,0.05)' 
  },
  priceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  priceMainLabel: { color: BlueprintColors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  priceValue: { color: '#FFFFFF', fontSize: 20, fontWeight: '800' },
  pricingVisualBadge: {
    width: 50,
    height: 50,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 25,
    justifyContent: 'center',
    alignItems: 'center',
  },
  multiplierRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  badge: { backgroundColor: 'rgba(255,107,44,0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  badgeText: { color: BlueprintColors.primaryAccent, fontSize: 11, fontWeight: '800' },
  otpSection: { marginBottom: 24 },
  otpDesc: { color: BlueprintColors.textSecondary, marginBottom: 16 },
  otpRow: { flexDirection: 'row', gap: 12 },
  otpItem: { 
    flex: 1, 
    backgroundColor: 'rgba(255,255,255,0.05)', 
    padding: 16, 
    borderRadius: 20, 
    alignItems: 'center', 
    borderWidth: 1, 
    borderColor: 'rgba(255,255,255,0.05)' 
  },
  infoLabel: { fontSize: 10, color: BlueprintColors.textSecondary, fontWeight: '800', marginBottom: 6 },
  otpValue: { fontSize: 22, fontWeight: '900', color: '#FFFFFF', letterSpacing: 2 },
  simulateBtn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: BlueprintColors.success },
  simulateBtnText: { color: BlueprintColors.success, fontWeight: 'bold' },
  activeSessionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  timerBadge: { backgroundColor: 'rgba(255,255,255,0.05)', padding: 12, borderRadius: 16, alignItems: 'center' },
  timerLabel: { color: BlueprintColors.textSecondary, fontSize: 10, fontWeight: '800' },
  timerValue: { color: '#fff', fontSize: 18, fontWeight: '900' },
  overstayWarning: {
    backgroundColor: 'rgba(244,63,94,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(244,63,94,0.3)',
    padding: 16,
    borderRadius: 12,
    marginBottom: 24,
  },
  bookingConfirmCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 24,
    borderRadius: 24,
    width: '100%',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  bookingLabel: {
    color: '#94a3b8',
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 4,
  },
  bookingValue: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
  },
  otpValueLarge: {
    color: '#10b981',
    fontSize: 40,
    fontWeight: '900',
    letterSpacing: 8,
    marginTop: 8,
  },
  checkoutOtpCard: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 24,
    borderRadius: 24,
    width: '100%',
    marginBottom: 24,
    alignItems: 'center',
  },
  paymentContainer: { paddingVertical: 10 },
  receiptLine: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  receiptLabel: { color: BlueprintColors.textSecondary, fontSize: 14, fontWeight: '600' },
  receiptValue: { color: '#fff', fontSize: 14, fontWeight: '700' },
  totalRow: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    borderTopWidth: 1, 
    borderColor: 'rgba(255,255,255,0.1)', 
    marginTop: 12, 
    paddingTop: 12 
  },
  totalLabel: { color: '#fff', fontSize: 18, fontWeight: '800' },
  totalValue: { color: BlueprintColors.primaryAccent, fontSize: 24, fontWeight: '900' },
  receiptContainer: { alignItems: 'stretch' },
  successIcon: { 
    alignSelf: 'center', 
    backgroundColor: 'rgba(16, 185, 129, 0.1)', 
    width: 80, 
    height: 80, 
    borderRadius: 40, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginBottom: 20 
  },
  receiptMsg: { color: BlueprintColors.textSecondary, textAlign: 'center', marginBottom: 24 },
});
