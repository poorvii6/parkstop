import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, RefreshControl, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import apiClient from '../api/client';
import { useOnlineRefresh } from '../hooks/useOnlineRefresh';
import { belongsToAudience, Audience } from '../utils/notificationAudience';

const C = {
  bg: '#0C0C14',
  card: '#161622',
  elevated: '#1C1C2E',
  accent: '#FF5733',
  accentSoft: 'rgba(255,87,51,0.12)',
  text: '#FFFFFF',
  sub: 'rgba(255,255,255,0.55)',
  muted: 'rgba(255,255,255,0.35)',
  border: 'rgba(255,255,255,0.08)',
  success: '#22C55E',
  warning: '#F59E0B',
  info: '#3B82F6',
};

type Notif = { id: number; title: string; body: string | null; type: string | null; read: boolean; created_at: string };

const ICON_FOR: Record<string, { name: any; color: string }> = {
  new_booking: { name: 'car-sport', color: C.accent },
  booking_confirmed: { name: 'checkmark-circle', color: C.success },
  finder_nearby: { name: 'location', color: C.info },
  default: { name: 'notifications', color: C.warning },
};

function timeAgo(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(iso).toLocaleDateString();
}

const pad = (n: number) => String(n).padStart(2, '0');

export default function NotificationsScreen() {
  const router = useRouter();
  const { audience } = useLocalSearchParams<{ audience?: Audience }>();
  const [items, setItems] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Quiet hours
  const [qStart, setQStart] = useState<number | null>(null);
  const [qEnd, setQEnd] = useState<number | null>(null);
  const quietOn = qStart != null && qEnd != null;

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const [list, prefs] = await Promise.all([
        apiClient.get('/notifications'),
        apiClient.get('/notifications/preferences'),
      ]);
      // Show only notifications for THIS interface (finder vs spotter).
      const all: Notif[] = list.data?.success ? (list.data.data.items || []) : [];
      const visible = all.filter((n) => belongsToAudience(n.type, audience));
      setItems(visible);
      if (prefs.data?.success) {
        setQStart(prefs.data.data.quiet_hours_start ?? null);
        setQEnd(prefs.data.data.quiet_hours_end ?? null);
      }
      // Mark only the visible (this-interface) notifications read, so the other
      // role's unread count isn't cleared.
      const unreadIds = visible.filter((n) => !n.read).map((n) => n.id);
      if (unreadIds.length) apiClient.post('/notifications/read', { ids: unreadIds }).catch(() => {});
    } catch (e) {
      console.log('Load notifications failed', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useOnlineRefresh(() => load());

  const savePrefs = async (start: number | null, end: number | null) => {
    setQStart(start); setQEnd(end);
    try {
      await apiClient.put('/notifications/preferences', { quiet_hours_start: start, quiet_hours_end: end });
    } catch (e) {
      console.log('Save quiet hours failed', e);
    }
  };

  const toggleQuiet = (on: boolean) => {
    if (on) savePrefs(22, 7); else savePrefs(null, null);
  };

  const stepHour = (which: 'start' | 'end', delta: number) => {
    if (which === 'start') savePrefs(((qStart ?? 22) + delta + 24) % 24, qEnd);
    else savePrefs(qStart, ((qEnd ?? 7) + delta + 24) % 24);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={C.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.accent} />}
      >
        {/* Quiet hours settings */}
        <View style={styles.settingsCard}>
          <View style={styles.settingRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
              <Ionicons name="moon" size={18} color={C.info} />
              <View style={{ flex: 1 }}>
                <Text style={styles.settingTitle}>Quiet hours</Text>
                <Text style={styles.settingSub}>Silence push notifications during these hours</Text>
              </View>
            </View>
            <Switch
              value={quietOn}
              onValueChange={toggleQuiet}
              trackColor={{ false: 'rgba(255,255,255,0.15)', true: C.accentSoft }}
              thumbColor={quietOn ? C.accent : '#f4f3f4'}
            />
          </View>

          {quietOn && (
            <View style={styles.hourRow}>
              <HourStepper label="From" value={qStart!} onDown={() => stepHour('start', -1)} onUp={() => stepHour('start', 1)} />
              <Ionicons name="arrow-forward" size={16} color={C.muted} />
              <HourStepper label="To" value={qEnd!} onDown={() => stepHour('end', -1)} onUp={() => stepHour('end', 1)} />
            </View>
          )}
        </View>

        {/* List */}
        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: 'center' }}>
            <ActivityIndicator color={C.accent} />
          </View>
        ) : items.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: 'center', gap: 10 }}>
            <Ionicons name="notifications-off-outline" size={40} color={C.muted} />
            <Text style={{ color: C.sub, fontSize: 14, fontWeight: '600' }}>No notifications yet</Text>
            <Text style={{ color: C.muted, fontSize: 12, textAlign: 'center' }}>You'll see booking updates and alerts here.</Text>
          </View>
        ) : (
          items.map((n) => {
            const ic = ICON_FOR[n.type || 'default'] || ICON_FOR.default;
            return (
              <View key={n.id} style={[styles.item, !n.read && styles.itemUnread]}>
                <View style={[styles.itemIcon, { backgroundColor: ic.color + '22' }]}>
                  <Ionicons name={ic.name} size={18} color={ic.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemTitle}>{n.title}</Text>
                  {!!n.body && <Text style={styles.itemBody} numberOfLines={2}>{n.body}</Text>}
                  <Text style={styles.itemTime}>{timeAgo(n.created_at)}</Text>
                </View>
                {!n.read && <View style={styles.unreadDot} />}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function HourStepper({ label, value, onDown, onUp }: { label: string; value: number; onDown: () => void; onUp: () => void }) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <TouchableOpacity onPress={onDown} style={styles.stepBtn} hitSlop={6}><Ionicons name="remove" size={16} color={C.text} /></TouchableOpacity>
        <Text style={styles.stepperValue}>{pad(value)}:00</Text>
        <TouchableOpacity onPress={onUp} style={styles.stepBtn} hitSlop={6}><Ionicons name="add" size={16} color={C.text} /></TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { flex: 1, textAlign: 'center', color: C.text, fontSize: 17, fontWeight: '800' },
  settingsCard: { backgroundColor: C.card, borderRadius: 16, borderWidth: 1, borderColor: C.border, padding: 16, marginBottom: 20 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  settingSub: { color: C.sub, fontSize: 11.5, marginTop: 2 },
  hourRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 16, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.border },
  stepper: { flex: 1, backgroundColor: C.elevated, borderRadius: 12, padding: 12, alignItems: 'center', gap: 8 },
  stepperLabel: { color: C.muted, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1 },
  stepperValue: { color: C.text, fontSize: 16, fontWeight: '900', minWidth: 56, textAlign: 'center' },
  stepBtn: { width: 30, height: 30, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 10 },
  itemUnread: { borderColor: 'rgba(255,87,51,0.35)', backgroundColor: 'rgba(255,87,51,0.05)' },
  itemIcon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  itemTitle: { color: C.text, fontSize: 14, fontWeight: '800' },
  itemBody: { color: C.sub, fontSize: 12.5, marginTop: 3, lineHeight: 17 },
  itemTime: { color: C.muted, fontSize: 11, marginTop: 6, fontWeight: '600' },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.accent, marginTop: 4 },
});
