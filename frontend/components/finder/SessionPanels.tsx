/**
 * SessionPanels.tsx — the driver's screens after booking, moved out of
 * app/finder/index.tsx so that file stays manageable.
 *
 *   BookedPanel   booked, not yet checked in: PIN + "Navigate"
 *   PaymentPanel  session closed: what is owed, and the Pay button
 *   ReceiptPanel  paid
 *
 * They only display what they are given and call back; all booking state
 * stays in the finder screen.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import apiClient from '../../api/client';

const money = (n: number) => `₹${Number(n || 0).toFixed(2)}`;

const Row = ({ label, value, color = '#fff' }: { label: string; value: string; color?: string }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
    <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '600' }}>{label}</Text>
    <Text style={{ color, fontSize: 12, fontWeight: '800' }} numberOfLines={1}>{value}</Text>
  </View>
);

/* ── Booked: waiting for the owner to check the driver in ───────────────── */

export function BookedPanel({ spotTitle, slot, bookingId, otp, onNavigate, navigating = false, onCancel, cancelling }: {
  spotTitle?: string;
  slot: string;
  bookingId?: string;
  otp?: string;
  /** Starts ParkStop's in-app navigation to the spot. Undefined when the spot's location is not known yet. */
  onNavigate?: () => void;
  /** True while the route is being fetched. */
  navigating?: boolean;
  /** Cancel the booking (allowed until the owner checks the driver in). */
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <View style={{ paddingVertical: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(16,185,129,0.12)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
          <Ionicons name="checkmark-circle" size={22} color="#10b981" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: -0.3 }} numberOfLines={1}>{spotTitle || 'Parking spot'}</Text>
          <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '500', marginTop: 2 }}>Booked. Show this PIN to the owner when you arrive.</Text>
        </View>
      </View>

      <View style={{ backgroundColor: 'rgba(16,185,129,0.06)', padding: 20, borderRadius: 24, alignItems: 'center', borderWidth: 1.5, borderColor: 'rgba(16,185,129,0.15)', marginBottom: 14 }}>
        <Text style={{ fontSize: 10, color: '#10b981', fontWeight: '800', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 2 }}>Check-in PIN</Text>
        <Text selectable={true} style={{ fontSize: 44, fontWeight: '900', color: '#fff', letterSpacing: 10 }}>{otp}</Text>
      </View>

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
        <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
          <Text style={{ fontSize: 9, color: '#64748b', fontWeight: '800', marginBottom: 4, textTransform: 'uppercase' }}>Booking ID</Text>
          <Text style={{ fontSize: 17, fontWeight: '900', color: '#fff' }}>#{bookingId}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', padding: 12, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' }}>
          <Text style={{ fontSize: 9, color: '#64748b', fontWeight: '800', marginBottom: 4, textTransform: 'uppercase' }}>Slot</Text>
          <Text style={{ fontSize: 17, fontWeight: '900', color: '#6366f1' }}>{slot}</Text>
        </View>
      </View>

      <TouchableOpacity
        activeOpacity={0.9}
        disabled={!onNavigate || navigating}
        style={{ backgroundColor: '#1a73e8', paddingVertical: 17, borderRadius: 20, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 12, opacity: onNavigate ? 1 : 0.5 }}
        onPress={() => {
          if (!onNavigate || navigating) return;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onNavigate();
        }}
      >
        {navigating
          ? <ActivityIndicator size="small" color="#fff" />
          : <Ionicons name="navigate" size={18} color="#fff" />}
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{navigating ? 'Finding route…' : 'Navigate'}</Text>
      </TouchableOpacity>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 12, backgroundColor: 'rgba(99,102,241,0.06)', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(99,102,241,0.12)' }}>
        <ActivityIndicator size="small" color="#818cf8" />
        <Text style={{ color: '#818cf8', fontWeight: '700', fontSize: 13 }}>Waiting for the owner to check you in…</Text>
      </View>

      <TouchableOpacity
        onPress={onCancel}
        disabled={cancelling}
        style={{ alignItems: 'center', paddingVertical: 14, marginTop: 4 }}
        accessibilityRole="button"
      >
        {cancelling
          ? <ActivityIndicator color="#f43f5e" />
          : <Text style={{ color: '#f43f5e', fontWeight: '800', fontSize: 14 }}>Cancel booking</Text>}
      </TouchableOpacity>
    </View>
  );
}

/* ── Payment: what is owed for the closed session ───────────────────────── */

export function PaymentPanel({ bookingId, ratePerHour, fallbackTotal, busy, onPay }: {
  bookingId?: string;
  ratePerHour?: number;
  /** Shown until the server's figure arrives, or if it cannot be fetched. */
  fallbackTotal: number;
  busy: boolean;
  onPay: () => void;
}) {
  // The server works out the bill (actual time parked, plus any old unpaid
  // amount). Ask it directly rather than trusting what the booking form said,
  // which is wrong after an overstay or when the app was reopened.
  const [amount, setAmount] = useState<{ base: number; arrears: number; total: number } | null>(null);
  const [hours, setHours] = useState<number | null>(null);

  useEffect(() => {
    if (!bookingId) return;
    let alive = true;
    apiClient.get(`/bookings/${bookingId}/checkout-amount`)
      .then((r: any) => {
        if (!alive || !r.data?.success) return;
        const d = r.data.data;
        setAmount({ base: Number(d.base_price) || 0, arrears: Number(d.arrears) || 0, total: Number(d.total_amount) || 0 });
      })
      .catch(() => {});
    apiClient.get('/bookings/my-bookings')
      .then((r: any) => {
        if (!alive || !r.data?.success) return;
        const b = (r.data.data || []).find((x: any) => String(x.id) === String(bookingId));
        if (b?.hours != null) setHours(Number(b.hours));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [bookingId]);

  const total = amount ? amount.total : fallbackTotal;
  const stay = hours == null ? '—' : hours >= 1 && Number.isInteger(hours)
    ? `${hours} h`
    : `${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} min`;

  return (
    <View style={{ paddingVertical: 10 }}>
      <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 16, letterSpacing: -0.5 }}>Review & Pay</Text>

      <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 20 }}>
        <View style={{ gap: 12 }}>
          <Row label="Time parked" value={stay} />
          {ratePerHour ? <Row label="Rate" value={`₹${ratePerHour}/hr`} /> : null}
          {amount && amount.arrears > 0 ? (
            <>
              <Row label="This parking" value={money(amount.base)} />
              <Row label="Unpaid from before" value={money(amount.arrears)} color="#f43f5e" />
            </>
          ) : null}
          <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 4 }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 20, fontWeight: '900' }}>Total due</Text>
            <Text style={{ color: '#6366f1', fontSize: 28, fontWeight: '900' }}>{money(total)}</Text>
          </View>
        </View>
      </View>

      <TouchableOpacity
        activeOpacity={0.9}
        style={{ backgroundColor: '#6366f1', paddingVertical: 18, borderRadius: 20, alignItems: 'center', opacity: busy ? 0.7 : 1 }}
        disabled={busy}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onPay();
        }}
      >
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>{busy ? 'Processing...' : 'Pay now'}</Text>
      </TouchableOpacity>
      <Text style={{ color: '#94a3b8', fontSize: 11, textAlign: 'center', marginTop: 10 }}>
        UPI, cards and netbanking via Razorpay
      </Text>
    </View>
  );
}

/* ── Receipt ──────────────────────────────────────────────────────────── */

export function ReceiptPanel({ bookingId, spotTitle, slot, amount, onDone }: {
  bookingId?: string;
  spotTitle?: string;
  slot: string;
  amount: number;
  onDone: () => void;
}) {
  return (
    <View style={{ paddingVertical: 10 }}>
      <View style={{ alignItems: 'center', marginBottom: 20 }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#10b981', justifyContent: 'center', alignItems: 'center', marginBottom: 12 }}>
          <Ionicons name="checkmark" size={36} color="#fff" />
        </View>
        <Text style={{ color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: -0.5 }}>Payment Complete</Text>
      </View>

      <View style={{ backgroundColor: 'rgba(255,255,255,0.03)', padding: 18, borderRadius: 24, borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', marginBottom: 20 }}>
        <View style={{ gap: 10 }}>
          <Row label="Booking ID" value={`#${bookingId ?? ''}`} />
          <Row label="Spot" value={spotTitle || '—'} />
          <Row label="Slot" value={slot} color="#6366f1" />
          <Row label="Payment" value="Online" />
          <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginVertical: 4 }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Amount Paid</Text>
            <Text style={{ color: '#10b981', fontSize: 22, fontWeight: '900' }}>{money(amount)}</Text>
          </View>
        </View>
      </View>

      <TouchableOpacity
        activeOpacity={0.9}
        style={{ backgroundColor: '#6366f1', paddingVertical: 18, borderRadius: 20, width: '100%', alignItems: 'center' }}
        onPress={() => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          onDone();
        }}
      >
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '900' }}>Back to Home</Text>
      </TouchableOpacity>
    </View>
  );
}
