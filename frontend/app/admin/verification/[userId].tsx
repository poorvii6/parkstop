/** Admin — review one owner's verification, then approve or send back. */
import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Image, Modal, TextInput, Alert, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';
import { ownerVerification, errorText, FLAG_LABELS, DOC_TYPES } from '../../../api/ownerVerification';

export default function AdminVerificationDetail() {
  const router = useRouter();
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const id = Number(userId);
  const [d, setD] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [docFull, setDocFull] = useState(false);

  const load = async () => {
    try { setError(''); setD(await ownerVerification.adminDetail(id)); }
    catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { load(); }, [id]);

  const approve = () => {
    Alert.alert('Approve owner?', `${d?.aadhaar?.name} will be able to list spots and withdraw earnings.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Approve', onPress: async () => {
        setBusy(true);
        try { await ownerVerification.adminApprove(id); await load(); Alert.alert('Approved', 'The owner has been notified.'); }
        catch (e) { Alert.alert('Could not approve', errorText(e)); }
        finally { setBusy(false); }
      } },
    ]);
  };

  const reject = async () => {
    if (reason.trim().length < 5) return;
    setBusy(true);
    try {
      await ownerVerification.adminReject(id, reason.trim());
      setRejectOpen(false); setReason('');
      await load();
      Alert.alert('Sent back', 'The owner has been told what to fix.');
    } catch (e) { Alert.alert('Could not send back', errorText(e)); }
    finally { setBusy(false); }
  };

  if (!d) {
    return (
      <SafeAreaView style={s.safe}>
        {error ? <Text style={s.error}>{error}</Text> : <ActivityIndicator color={SC.accent} style={{ marginTop: 60 }} size="large" />}
      </SafeAreaView>
    );
  }

  const doc = DOC_TYPES.find((t) => t.key === d.property?.doc_type)?.label || d.property?.doc_type;
  const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.back} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={SC.textPrimary} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{d.aadhaar?.name || d.user?.full_name}</Text>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 140 }}>
        <View style={s.statusPill}><Text style={s.statusText}>Status: {d.status.replace('_', ' ')}</Text></View>
        {d.rejection_reason ? <Text style={s.reason}>Last reason: {d.rejection_reason}</Text> : null}

        {(d.flags || []).map((f: any) => (
          <View key={f.code} style={s.flag}>
            <Ionicons name="warning" size={16} color={SC.warning} />
            <Text style={s.flagText}>{FLAG_LABELS[f.code] || f.code}{f.note ? ` — ${f.note}` : ''}</Text>
          </View>
        ))}

        <Section title="Account">
          <Row k="Email" v={d.user?.email} />
          <Row k="Name in app" v={d.user?.full_name} />
          <Row k="Phone" v={d.user?.phone || '—'} />
          <Row k="Joined" v={d.user?.created_at ? new Date(d.user.created_at).toLocaleDateString() : '—'} />
        </Section>

        <Section title="Aadhaar (DigiLocker)" ok={!!d.aadhaar?.verified_at}>
          <Row k="Name" v={d.aadhaar?.name} />
          <Row k="Aadhaar" v={d.aadhaar?.last4 ? `XXXX XXXX ${d.aadhaar.last4}` : '—'} />
          <Row k="Date of birth" v={d.aadhaar?.dob} />
          <Row k="State / PIN" v={[d.aadhaar?.state, d.aadhaar?.pincode].filter(Boolean).join(' · ')} />
        </Section>

        <Section title="PAN" ok={!!d.pan?.verified_at}>
          <Row k="PAN" v={d.pan?.masked} />
          <Row k="Name (Income Tax)" v={d.pan?.registered_name} />
          <Row k="Name match" v={d.pan?.name_match} />
          <Row k="Linked to Aadhaar" v={d.pan?.aadhaar_linked === 'Y' ? 'Yes' : d.pan?.aadhaar_linked ? 'No' : '—'} />
        </Section>

        <Section title="Live selfie" ok={!!d.selfie?.verified_at}>
          <Row k="Liveness" v={pct(d.selfie?.liveness_score)} />
          <Row k="Face match" v={pct(d.selfie?.face_match_score)} />
        </Section>

        <Section title="Bank account" ok={!!d.bank?.verified_at}>
          <Row k="Bank" v={d.bank?.bank_name} />
          <Row k="Account" v={d.bank?.last4 ? `XXXX ${d.bank.last4}` : '—'} />
          <Row k="IFSC" v={d.bank?.ifsc} />
          <Row k="Name at bank" v={d.bank?.name_at_bank} />
          <Row k="Name match" v={d.bank?.name_match} />
        </Section>

        <Section title="Property proof" ok={!!d.property?.uploaded_at}>
          <Row k="Document" v={doc} />
          <Row k="Address" v={d.property?.address} />
          {d.property?.doc_url ? (
            <TouchableOpacity onPress={() => setDocFull(true)}>
              <Image source={{ uri: d.property.doc_url }} style={s.doc} resizeMode="cover" />
              <Text style={s.tapHint}>Tap to view full size</Text>
            </TouchableOpacity>
          ) : null}
          <Text style={s.checkHint}>Check: the name matches the Aadhaar name (or the owner has a rent agreement), and the address matches the spot below.</Text>
        </Section>

        <Section title={`Spots (${d.user?.parking_spots?.length || 0})`}>
          {(d.user?.parking_spots || []).map((sp: any) => (
            <TouchableOpacity key={sp.id} onPress={() => sp.latitude && Linking.openURL(`https://maps.google.com/?q=${sp.latitude},${sp.longitude}`)}>
              <Row k={sp.title} v={sp.address || 'Open in Maps'} />
            </TouchableOpacity>
          ))}
          {!d.user?.parking_spots?.length ? <Text style={s.checkHint}>No spots added yet.</Text> : null}
        </Section>
      </ScrollView>

      {d.status === 'pending' || d.status === 'approved' ? (
        <View style={s.actions}>
          <TouchableOpacity style={[s.btn, s.rejectBtn]} onPress={() => setRejectOpen(true)} disabled={busy}>
            <Text style={s.btnText}>{d.status === 'approved' ? 'Revoke' : 'Send back'}</Text>
          </TouchableOpacity>
          {d.status === 'pending' ? (
            <TouchableOpacity style={[s.btn, s.approveBtn]} onPress={approve} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Approve</Text>}
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      <Modal visible={rejectOpen} transparent animationType="fade" onRequestClose={() => setRejectOpen(false)}>
        <View style={s.modalBg}>
          <View style={s.modal}>
            <Text style={s.modalTitle}>What should the owner fix?</Text>
            <TextInput
              style={s.modalInput}
              value={reason}
              onChangeText={setReason}
              multiline
              placeholder="e.g. The bill is in another person's name. Please upload a rent agreement."
              placeholderTextColor={SC.textDisabled}
              maxLength={500}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              <TouchableOpacity style={[s.btn, { backgroundColor: SC.bgElevated }]} onPress={() => setRejectOpen(false)}>
                <Text style={s.btnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.btn, s.rejectBtn, reason.trim().length < 5 && { opacity: 0.5 }]} onPress={reject} disabled={busy || reason.trim().length < 5}>
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>Send</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={docFull} transparent animationType="fade" onRequestClose={() => setDocFull(false)}>
        <TouchableOpacity style={s.full} activeOpacity={1} onPress={() => setDocFull(false)}>
          {d.property?.doc_url ? <Image source={{ uri: d.property.doc_url }} style={{ width: '100%', height: '85%' }} resizeMode="contain" /> : null}
          <Text style={s.tapHint}>Tap to close</Text>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

function Section({ title, ok, children }: { title: string; ok?: boolean; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {ok !== undefined ? <Ionicons name={ok ? 'checkmark-circle' : 'close-circle'} size={18} color={ok ? SC.success : SC.error} /> : null}
        <Text style={s.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Row({ k, v }: { k: string; v?: any }) {
  return (
    <View style={s.row}>
      <Text style={s.k}>{k}</Text>
      <Text style={s.v} selectable>{v ?? '—'}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SC.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: SC.bgCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800', flex: 1, textAlign: 'center' },
  statusPill: { alignSelf: 'flex-start', backgroundColor: SC.bgCard, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 10 },
  statusText: { color: SC.textPrimary, fontWeight: '700', textTransform: 'capitalize' },
  reason: { color: SC.textSecondary, marginBottom: 10 },
  flag: { flexDirection: 'row', gap: 8, backgroundColor: SC.warningSoft, borderRadius: 12, padding: 10, marginBottom: 8, alignItems: 'flex-start' },
  flagText: { color: SC.warning, fontWeight: '700', flex: 1, fontSize: 13 },
  section: { backgroundColor: SC.bgCard, borderRadius: 16, borderWidth: 1, borderColor: SC.border, padding: 14, marginTop: 12 },
  sectionTitle: { color: SC.textPrimary, fontSize: 15, fontWeight: '800' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 5 },
  k: { color: SC.textSecondary, fontSize: 13, flexShrink: 0 },
  v: { color: SC.textPrimary, fontSize: 13, fontWeight: '600', flex: 1, textAlign: 'right' },
  doc: { width: '100%', height: 200, borderRadius: 12, marginTop: 10, backgroundColor: SC.bgElevated },
  tapHint: { color: SC.textMuted, fontSize: 12, textAlign: 'center', marginTop: 6 },
  checkHint: { color: SC.textMuted, fontSize: 12, lineHeight: 17, marginTop: 8 },
  actions: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: 10, padding: 16, backgroundColor: SC.bg, borderTopWidth: 1, borderTopColor: SC.border },
  btn: { flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  approveBtn: { backgroundColor: SC.success },
  rejectBtn: { backgroundColor: SC.error },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 20 },
  modal: { backgroundColor: SC.bgCard, borderRadius: 20, padding: 18 },
  modalTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800', marginBottom: 10 },
  modalInput: { backgroundColor: SC.bgElevated, borderRadius: 12, color: SC.textPrimary, minHeight: 110, padding: 12, textAlignVertical: 'top', fontSize: 15 },
  full: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  error: { color: SC.error, padding: 20 },
});
