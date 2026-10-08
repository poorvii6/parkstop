/** Admin — owners waiting for verification review. */
import React, { useCallback, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { SC } from '../../constants/SpotterTheme';
import { ownerVerification, errorText, FLAG_LABELS as FLAG_TEXT } from '../../api/ownerVerification';

const TABS = [
  { key: 'pending', label: 'To review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Sent back' },
  { key: 'in_progress', label: 'In progress' },
];


export default function AdminVerifications() {
  const router = useRouter();
  const [tab, setTab] = useState('pending');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (t = tab) => {
    setLoading(true);
    setError('');
    try { setRows(await ownerVerification.adminList(t)); }
    catch (e) { setError(errorText(e)); setRows([]); }
    finally { setLoading(false); }
  }, [tab]);

  useFocusEffect(useCallback(() => { load(tab); }, [tab]));

  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.back} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={SC.textPrimary} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Owner verifications</Text>
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
        keyExtractor={(r) => String(r.user_id)}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(tab)} tintColor={SC.accent} />}
        ListEmptyComponent={!loading ? <Text style={s.empty}>Nothing here.</Text> : <ActivityIndicator color={SC.accent} style={{ marginTop: 40 }} />}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.row} onPress={() => router.push(`/admin/verification/${item.user_id}` as any)}>
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{item.aadhaar_name || item.account_name || 'Unnamed'}</Text>
              <Text style={s.sub}>{item.email}</Text>
              {item.submitted_at ? <Text style={s.sub}>Submitted {new Date(item.submitted_at).toLocaleString()}</Text> : null}
              {item.flags?.length ? (
                <View style={s.flags}>
                  {item.flags.map((f: string) => (
                    <View key={f} style={s.flag}><Text style={s.flagText}>⚠ {FLAG_TEXT[f] || f}</Text></View>
                  ))}
                </View>
              ) : null}
            </View>
            <Ionicons name="chevron-forward" size={18} color={SC.textMuted} />
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SC.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: SC.bgCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 6, flexWrap: 'wrap' },
  tab: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: SC.bgCard, borderWidth: 1, borderColor: SC.border },
  tabOn: { backgroundColor: SC.accent, borderColor: SC.accent },
  tabText: { color: SC.textSecondary, fontWeight: '700', fontSize: 13 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: SC.bgCard, borderRadius: 16, borderWidth: 1, borderColor: SC.border, padding: 14, marginBottom: 10 },
  name: { color: SC.textPrimary, fontSize: 16, fontWeight: '800' },
  sub: { color: SC.textSecondary, fontSize: 13, marginTop: 2 },
  flags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  flag: { backgroundColor: SC.warningSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  flagText: { color: SC.warning, fontSize: 12, fontWeight: '700' },
  empty: { color: SC.textMuted, textAlign: 'center', marginTop: 40 },
  error: { color: SC.error, paddingHorizontal: 16, marginTop: 8 },
});
