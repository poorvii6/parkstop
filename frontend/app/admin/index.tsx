import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '../../api/client';
import { useOnlineRefresh } from '../../hooks/useOnlineRefresh';
import { BlueprintTheme, BlueprintColors } from '../../constants/BlueprintTheme';

type PlatformStats = {
  total_completed_bookings: string;
  total_bookings: string;
  total_revenue: string;
  platform_earnings: string;
  spotter_payout: string;
};

export default function AdminDashboard() {
  const router = useRouter();
  const [stats, setStats] = useState<PlatformStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      const response = await apiClient.get('/analytics/platform');
      if (response.data.success) {
        setStats(response.data.data.summary);
      }
    } catch (error) {
      console.log('Failed to fetch platform analytics', error);
    } finally {
      setLoading(false);
    }
  };

  // Refresh analytics when connectivity returns.
  useOnlineRefresh(fetchAnalytics);

  // Admins keep admin rights on the server while using the other screens.
  const openAs = async (role: 'FINDER' | 'SPOTTER') => {
    try {
      await apiClient.post('/auth/switch-role', { newRole: role });
      await AsyncStorage.setItem('user_role', role);
      router.replace(role === 'FINDER' ? '/finder' : '/spotter');
    } catch (e: any) {
      const { Alert } = require('react-native');
      Alert.alert('Could not open', e?.response?.data?.message || 'Please try again.');
    }
  };

  const handleLogout = async () => {
    await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role', 'is_dual_user']);
    try {
      const { auth } = require('../../services/firebase');
      try { await require('@react-native-async-storage/async-storage').default.removeItem('otp_verified_uid'); } catch {}
      await auth.signOut();
    } catch (err) {}
    router.replace('/login');
  };

  return (
    <SafeAreaView style={BlueprintTheme.container}>
      <View style={styles.header}>
        <Text style={styles.logoText}>
          <Text style={{ color: BlueprintColors.primaryAccent }}>P</Text>arkStop <Text style={styles.adminTag}>Admin</Text>
        </Text>
        <TouchableOpacity onPress={handleLogout} style={styles.exitBtn}>
          <Text style={styles.exitText}>Exit</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.titleSection}>
          <Text style={styles.mainTitle}>Platform Overview</Text>
          <Text style={styles.subtitle}>Real-time system diagnostics and revenue tracking.</Text>
        </View>

        {loading || !stats ? (
           <ActivityIndicator color={BlueprintColors.primaryAccent} size="large" style={{ marginTop: 40 }} />
        ) : (
          <View style={styles.statsGrid}>
            <View style={[BlueprintTheme.glassCard, styles.statCard]}>
              <Text style={styles.statLabel}>Platform Commission</Text>
              <Text style={styles.statValue}>₹{parseFloat(stats?.platform_earnings || '0').toFixed(2)}</Text>
            </View>
            <View style={[BlueprintTheme.glassCard, styles.statCard]}>
              <Text style={styles.statLabel}>Gross Revenue</Text>
              <Text style={styles.statValue}>₹{parseFloat(stats?.total_revenue || '0').toFixed(2)}</Text>
            </View>
            <View style={[BlueprintTheme.glassCard, styles.statCard]}>
              <Text style={styles.statLabel}>Completed Bookings</Text>
              <Text style={styles.statValue}>{stats?.total_completed_bookings || '0'}</Text>
            </View>
            <View style={[BlueprintTheme.glassCard, styles.statCard]}>
              <Text style={styles.statLabel}>Spot Owner Payouts</Text>
              <Text style={styles.statValue}>₹{parseFloat(stats?.spotter_payout || '0').toFixed(2)}</Text>
            </View>
          </View>
        )}

        <Text style={styles.sectionTitle}>Manage</Text>
        <TouchableOpacity style={[BlueprintTheme.glassCard, styles.actionCard]} onPress={() => router.push('/admin/verifications' as any)}>
          <Text style={styles.actionTitle}>Owner verifications</Text>
          <Text style={styles.actionSub}>Review and approve new spot owners</Text>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>Use the app</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          <TouchableOpacity style={[BlueprintTheme.glassCard, styles.actionCard, { flex: 1 }]} onPress={() => openAs('FINDER')}>
            <Text style={styles.actionTitle}>Driver</Text>
            <Text style={styles.actionSub}>Find and book parking</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[BlueprintTheme.glassCard, styles.actionCard, { flex: 1 }]} onPress={() => openAs('SPOTTER')}>
            <Text style={styles.actionTitle}>Owner</Text>
            <Text style={styles.actionSub}>List and manage spots</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionCard: { padding: 18, marginBottom: 12 },
  actionTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  actionSub: { color: BlueprintColors.textSecondary, fontSize: 13, marginTop: 4 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, backgroundColor: BlueprintColors.background },
  logoText: { color: '#FFFFFF', fontSize: 24, fontWeight: '900', letterSpacing: -1 },
  adminTag: { fontSize: 12, color: BlueprintColors.primaryAccent, textTransform: 'uppercase', fontWeight: '800' },
  exitBtn: { padding: 8 },
  exitText: { color: BlueprintColors.textSecondary, fontWeight: '600' },
  container: { padding: 20 },
  titleSection: { marginBottom: 32 },
  mainTitle: { color: '#FFFFFF', fontSize: 28, fontWeight: '800', marginBottom: 8 },
  subtitle: { color: BlueprintColors.textSecondary, fontSize: 16 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginBottom: 32 },
  statCard: { flex: 1, minWidth: '45%', padding: 20 },
  statLabel: { color: BlueprintColors.textSecondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 8 },
  statValue: { color: '#FFFFFF', fontSize: 24, fontWeight: '800' },
  sectionTitle: { color: '#FFFFFF', fontSize: 20, fontWeight: '800', marginBottom: 16 },
  statusGrid: { gap: 12 },
  statusItem: { padding: 16 },
  statusHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  statusName: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  statusIndicator: { width: 8, height: 8, borderRadius: 4 },
  statusDetail: { color: BlueprintColors.textSecondary, fontSize: 13 },
  statusPing: { color: BlueprintColors.textSecondary, fontSize: 12, marginTop: 8 }
});
