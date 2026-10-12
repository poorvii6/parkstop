/**
 * Admin — owner payout requests.
 *
 * ParkStop pays owners by hand: send a bank transfer (IMPS/NEFT) to the
 * account shown, then tap "Mark paid" and enter the bank reference (UTR).
 * "Reject" puts the money back in the owner's wallet and tells them why.
 */
import React, { useCallback, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, RefreshControl,
  Modal, TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import apiClient from '../../api/client';
import { SC } from '../../constants/SpotterTheme';

const TABS = [
  { key: 'requested', label: 'To pay' },
  { key: 'paid', label: 'Paid' },
  { key: 'rejected', label: 'Rejected' },
];

type Row = {
  id: number;
  amount: number;
  status: string;
  created_at: string;
  processed_at?: string;
  reference?: string;
  note?: string;
  owner: { id: number; name?: string; email?: string; phone?: string; verification_status?: string };
  pay_to: { account_name?: string; account_number?: string; ifsc?: string };
};

export default function AdminPayouts() {
  const router = useRouter();
  const [tab, setTab] = useState('requested');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // The open "mark paid" / "reject" dialog.
  const [action, setAction] = useState<{ row: Row; kind: 'paid' | 'reject' } | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (t = tab) => {
    setLoading(true);
    setError('');
    try {
      const r = await apiClient.get(`/payouts/admin/requests?status=${t}`);
      setRows(r.data?.data || []);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Could not load payouts.');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useFocusEffect(useCallback(() => { load(tab); }, [tab]));

  const submit = async () => {
    if (!action) return;
    const value = text.trim();
    if (action.kind === 'paid' && value.length < 6) {
      Alert.alert('Reference needed', 'Enter the bank transaction reference (UTR) from your bank app.');
      return;
    }
    if (action.kind === 'reject' && value.length < 3) {
      Alert.alert('Reason needed', 'Tell the owner briefly why, so they can fix it.');
      return;
    }
    setSaving(true);
    try {
      const url = `/payouts/admin/requests/${action.row.id}/${action.kind === 'paid' ? 'paid' : 'reject'}`;
      await apiClient.post(url, action.kind === 'paid' ? { reference: value } : { reason: value });
      setAction(null);
      setText('');
      load(tab);
    } catch (e: any) {
      Alert.alert('Could not save', e?.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.back} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={SC.textPrimary} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Owner payouts</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={s.tabs}>
        {TABS.map((t) => (
          <TouchableOpacity key={t.key} style={[s.tab, tab === t.key && s.tabOn]} onPress={() => setTab(t.key)}>
            <Text style={[s.tabText, tab === t.key && { color: '#fff' }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {error ? <Text style={s.error}>{error}</Text> : null}

      <FlatList
        data={rows}
        keyExtractor={(r: Row) => String(r.id)}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(tab)} tintColor={SC.accent} />}
        ListEmptyComponent={!loading ? <Text style={s.empty}>Nothing here.</Text> : <ActivityIndicator color={SC.accent} style={{ marginTop: 40 }} />}
        renderItem={({ item }: { item: Row }) => (
          <View style={s.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={s.amount}>₹{Number(item.amount).toFixed(2)}</Text>
              <Text style={s.sub}>{new Date(item.created_at).toLocaleString()}</Text>
            </View>
            <Text style={s.name}>{item.owner?.name || 'Owner'} · #{item.owner?.id}</Text>
            <Text style={s.sub}>{item.owner?.email}{item.owner?.phone ? ` · ${item.owner.phone}` : ''}</Text>

            {item.status === 'requested' ? (
              <View style={s.bank}>
                <Text style={s.bankLabel}>Send to</Text>
                <Text selectable style={s.bankLine}>{item.pay_to?.account_name || '—'}</Text>
                <Text selectable style={s.bankLine}>A/c {item.pay_to?.account_number || '—'}</Text>
                <Text selectable style={s.bankLine}>IFSC {item.pay_to?.ifsc || '—'}</Text>
                {item.owner?.verification_status !== 'approved' ? (
                  <Text style={s.warn}>⚠ This owner is no longer approved. Check before paying.</Text>
                ) : null}
              </View>
            ) : (
              <Text style={[s.sub, { marginTop: 8 }]}>
                {item.status === 'paid' ? `Paid · Ref ${item.reference}` : `Rejected · ${item.note}`}
                {item.processed_at ? ` · ${new Date(item.processed_at).toLocaleDateString()}` : ''}
              </Text>
            )}

            {item.status === 'requested' ? (
              <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                <TouchableOpacity style={[s.btn, { backgroundColor: SC.success, flex: 1 }]} onPress={() => { setText(''); setAction({ row: item, kind: 'paid' }); }}>
                  <Text style={s.btnText}>Mark paid</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.btn, { backgroundColor: SC.bg, borderWidth: 1, borderColor: SC.error }]} onPress={() => { setText(''); setAction({ row: item, kind: 'reject' }); }}>
                  <Text style={[s.btnText, { color: SC.error }]}>Reject</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        )}
      />

      <Modal visible={!!action} transparent animationType="fade" onRequestClose={() => setAction(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.backdrop}>
          <View style={s.dialog}>
            <Text style={s.dialogTitle}>
              {action?.kind === 'paid' ? `Mark ₹${Number(action?.row.amount || 0).toFixed(2)} as paid` : 'Reject payout'}
            </Text>
            <Text style={s.sub}>
              {action?.kind === 'paid'
                ? 'Only after the bank transfer has gone through. Enter the UTR / reference number.'
                : 'The money goes back to the owner’s wallet. Tell them why.'}
            </Text>
            <TextInput
              style={s.input}
              value={text}
              onChangeText={setText}
              placeholder={action?.kind === 'paid' ? 'e.g. 412345678901' : 'e.g. Bank account closed'}
              placeholderTextColor={SC.textMuted}
              autoCapitalize={action?.kind === 'paid' ? 'characters' : 'sentences'}
              autoFocus
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              <TouchableOpacity style={[s.btn, { flex: 1, backgroundColor: SC.bgCard }]} onPress={() => setAction(null)} disabled={saving}>
                <Text style={[s.btnText, { color: SC.textSecondary }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, { flex: 1, backgroundColor: action?.kind === 'paid' ? SC.success : SC.error }]}
                onPress={submit}
                disabled={saving}
              >
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.btnText}>{action?.kind === 'paid' ? 'Mark paid' : 'Reject'}</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SC.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: SC.bgCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 6 },
  tab: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: SC.bgCard, borderWidth: 1, borderColor: SC.border },
  tabOn: { backgroundColor: SC.accent, borderColor: SC.accent },
  tabText: { color: SC.textSecondary, fontWeight: '700', fontSize: 13 },
  card: { backgroundColor: SC.bgCard, borderRadius: 16, borderWidth: 1, borderColor: SC.border, padding: 14, marginBottom: 12 },
  amount: { color: SC.textPrimary, fontSize: 22, fontWeight: '900' },
  name: { color: SC.textPrimary, fontSize: 15, fontWeight: '800', marginTop: 6 },
  sub: { color: SC.textSecondary, fontSize: 13, marginTop: 2 },
  bank: { marginTop: 10, backgroundColor: SC.bg, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: SC.border },
  bankLabel: { color: SC.textMuted, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', marginBottom: 4 },
  bankLine: { color: SC.textPrimary, fontSize: 15, fontWeight: '700', marginTop: 2 },
  warn: { color: SC.warning, fontSize: 12, fontWeight: '700', marginTop: 8 },
  btn: { borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  empty: { color: SC.textMuted, textAlign: 'center', marginTop: 40 },
  error: { color: SC.error, paddingHorizontal: 16, marginTop: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 },
  dialog: { backgroundColor: SC.bgCard, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: SC.border },
  dialogTitle: { color: SC.textPrimary, fontSize: 18, fontWeight: '900', marginBottom: 6 },
  input: { marginTop: 14, backgroundColor: SC.bg, borderRadius: 12, borderWidth: 1, borderColor: SC.border, color: SC.textPrimary, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },
});
