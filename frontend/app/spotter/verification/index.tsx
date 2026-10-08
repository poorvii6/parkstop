/**
 * Owner verification — overview. Shows each step, what's done, and lets the
 * owner submit for review once everything is complete.
 */
import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, RefreshControl, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';
import { ownerVerification, OwnerVerification, StepKey, errorText } from '../../../api/ownerVerification';
import { PrimaryButton, ErrorNote } from '../../../components/spotter/VerifyUI';

const STEPS: { key: StepKey; title: string; desc: string; icon: any; route: string }[] = [
  { key: 'aadhaar', title: 'Aadhaar', desc: 'Share your Aadhaar through DigiLocker', icon: 'finger-print', route: '/spotter/verification/aadhaar' },
  { key: 'pan', title: 'PAN card', desc: 'Your personal PAN, in your name', icon: 'card', route: '/spotter/verification/pan' },
  { key: 'selfie', title: 'Live selfie', desc: 'A quick photo to match your Aadhaar', icon: 'happy', route: '/spotter/verification/selfie' },
  { key: 'bank', title: 'Bank account', desc: 'Where your earnings are paid', icon: 'business', route: '/spotter/verification/bank' },
  { key: 'property', title: 'Property proof', desc: 'Bill, tax receipt or rent agreement', icon: 'home', route: '/spotter/verification/property' },
];

export default function VerificationOverview() {
  const router = useRouter();
  const [data, setData] = useState<OwnerVerification | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setError('');
      setData(await ownerVerification.get());
    } catch (e) {
      setError(errorText(e, 'Could not load your verification.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const locked = data?.status === 'pending' || data?.status === 'approved';
  const doneCount = data ? Object.values(data.steps).filter(Boolean).length : 0;

  const onSubmit = async () => {
    setSubmitting(true);
    setError('');
    try {
      setData(await ownerVerification.submit());
      Alert.alert('Submitted', 'We will review your details, usually within 1 working day. You will get a notification.');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.back} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={SC.textPrimary} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Owner verification</Text>
        <View style={{ width: 36 }} />
      </View>

      {loading ? (
        <ActivityIndicator color={SC.accent} size="large" style={{ marginTop: 60 }} />
      ) : (
        <ScrollView
          contentContainerStyle={s.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={SC.accent} />}
        >
          <StatusCard data={data} doneCount={doneCount} />
          <ErrorNote text={error} />

          {STEPS.map((step, i) => {
            const done = !!data?.steps[step.key];
            const needsAadhaar = step.key !== 'aadhaar' && step.key !== 'property' && !data?.steps.aadhaar;
            const disabled = locked || needsAadhaar;
            return (
              <TouchableOpacity
                key={step.key}
                style={[s.step, done && s.stepDone, disabled && !done && { opacity: 0.45 }]}
                onPress={() => router.push(step.route as any)}
                disabled={disabled}
                activeOpacity={0.85}
              >
                <View style={[s.stepIcon, done && { backgroundColor: SC.successSoft }]}>
                  <Ionicons name={done ? 'checkmark' : step.icon} size={20} color={done ? SC.success : SC.textPrimary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.stepTitle}>{i + 1}. {step.title}</Text>
                  <Text style={s.stepDesc}>
                    {done ? doneText(step.key, data) : needsAadhaar ? 'Complete Aadhaar first' : step.desc}
                  </Text>
                </View>
                {!locked && <Ionicons name="chevron-forward" size={18} color={SC.textMuted} />}
              </TouchableOpacity>
            );
          })}

          {!locked && (
            <View style={{ marginTop: 20 }}>
              <PrimaryButton
                label={data?.status === 'rejected' ? 'Submit again' : 'Submit for review'}
                onPress={onSubmit}
                loading={submitting}
                disabled={!data?.all_done}
              />
              {!data?.all_done && <Text style={s.hint}>Finish all 5 steps to submit.</Text>}
            </View>
          )}

          <Text style={s.privacy}>
            We keep only the results of these checks — never your full Aadhaar number, Aadhaar photo or selfie. Checks are done by Cashfree, an RBI-licensed company.
          </Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function doneText(key: StepKey, d: OwnerVerification | null) {
  if (!d) return 'Done';
  if (key === 'aadhaar' && d.details.aadhaar) return `${d.details.aadhaar.name} · XXXX ${d.details.aadhaar.last4}`;
  if (key === 'pan' && d.details.pan) return d.details.pan.masked;
  if (key === 'bank' && d.details.bank) return `${d.details.bank.bank_name || 'Bank'} · XXXX ${d.details.bank.last4}`;
  if (key === 'property' && d.details.property) return d.details.property.address;
  return 'Verified';
}

function StatusCard({ data, doneCount }: { data: OwnerVerification | null; doneCount: number }) {
  if (!data) return null;
  const map: Record<string, { icon: any; color: string; bg: string; title: string; text: string }> = {
    not_started: { icon: 'shield-outline', color: SC.warning, bg: SC.warningSoft, title: 'Verify to go live', text: 'Drivers can only see your spots after you are verified. It takes about 5 minutes.' },
    in_progress: { icon: 'shield-half', color: SC.warning, bg: SC.warningSoft, title: `${doneCount} of 5 done`, text: 'Finish the remaining steps, then submit for review.' },
    pending: { icon: 'time', color: SC.info, bg: SC.infoSoft, title: 'Under review', text: 'We are checking your details. You will get a notification when it is done.' },
    approved: { icon: 'shield-checkmark', color: SC.success, bg: SC.successSoft, title: 'You are verified', text: 'Your spots are visible to drivers and you can withdraw earnings.' },
    rejected: { icon: 'alert-circle', color: SC.error, bg: SC.errorSoft, title: 'Changes needed', text: data.rejection_reason || 'Please update your details and submit again.' },
  };
  const m = map[data.status] || map.not_started;
  return (
    <View style={[s.status, { backgroundColor: m.bg, borderColor: m.color + '55' }]}>
      <Ionicons name={m.icon} size={26} color={m.color} />
      <View style={{ flex: 1 }}>
        <Text style={[s.statusTitle, { color: m.color }]}>{m.title}</Text>
        <Text style={s.statusText}>{m.text}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SC.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: SC.bgCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800' },
  body: { padding: 20, paddingBottom: 40 },
  status: { flexDirection: 'row', gap: 12, borderRadius: 18, borderWidth: 1, padding: 16, marginBottom: 18, alignItems: 'flex-start' },
  statusTitle: { fontSize: 16, fontWeight: '800', marginBottom: 4 },
  statusText: { color: SC.textPrimary, fontSize: 14, lineHeight: 20, opacity: 0.85 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: SC.bgCard, borderRadius: 16, borderWidth: 1, borderColor: SC.border, padding: 14, marginBottom: 10 },
  stepDone: { borderColor: 'rgba(34,197,94,0.35)' },
  stepIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: SC.bgElevated, alignItems: 'center', justifyContent: 'center' },
  stepTitle: { color: SC.textPrimary, fontSize: 15, fontWeight: '800' },
  stepDesc: { color: SC.textSecondary, fontSize: 13, marginTop: 2 },
  hint: { color: SC.textMuted, fontSize: 13, textAlign: 'center', marginTop: 10 },
  privacy: { color: SC.textMuted, fontSize: 12, lineHeight: 18, marginTop: 24, textAlign: 'center' },
});
