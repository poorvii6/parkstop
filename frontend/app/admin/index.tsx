import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '../../api/client';
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

  const handleLogout = async () => {
    await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role', 'is_dual_user']);
    try {
      const { auth } = require('../../services/firebase');
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
              <Text style={styles.statLabel}>Spotter Payouts</Text>
              <Text style={styles.statValue}>₹{parseFloat(stats?.spotter_payout || '0').toFixed(2)}</Text>
            </View>
          </View>
        )}

        <Text style={styles.sectionTitle}>System Status</Text>
        <View style={styles.statusGrid}>
          <View style={[BlueprintTheme.glassCard, styles.statusItem]}>
            <View style={styles.statusHeader}>
              <Text style={styles.statusName}>Payment Engine</Text>
              <View style={[styles.statusIndicator, { backgroundColor: BlueprintColors.success }]} />
            </View>
            <Text style={styles.statusDetail}>Razorpay Gateway</Text>
            <Text style={styles.statusPing}>12ms latency</Text>
          </View>
          
          <View style={[BlueprintTheme.glassCard, styles.statusItem]}>
            <View style={styles.statusHeader}>
              <Text style={styles.statusName}>Chatbot AI</Text>
              <View style={[styles.statusIndicator, { backgroundColor: BlueprintColors.success }]} />
            </View>
            <Text style={styles.statusDetail}>OpenAI / NLP Hub</Text>
            <Text style={styles.statusPing}>45ms latency</Text>
          </View>
        </View>

        <TouchableOpacity style={[BlueprintTheme.buttonPrimary, { marginTop: 40 }]}>
          <Text style={BlueprintTheme.buttonPrimaryText}>System Re-sync</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
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
