import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform, Dimensions, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';

export default function RoleSelectionScreen() {
  const router = useRouter();
  const [activeRole, setActiveRole] = React.useState<string | null>(null);

  const handleSelectRole = async (role: string) => {
    setActiveRole(role);
  };

  const handleContinue = async () => {
    if (!activeRole) return;
    await AsyncStorage.setItem('user_role', activeRole);
    if (activeRole === 'SPOTTER' || activeRole === 'FINDER') {
      router.replace('/welcome');
    }
  };

  const handleLogout = async () => {
    await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role']);
    try {
      const { auth } = require('../services/firebase');
      await auth.signOut();
    } catch (err) {}
    router.replace('/login');
  };

  return (
    <SafeAreaView style={BlueprintTheme.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <View style={styles.logoContainer}>
            <Text style={styles.logoText}>
              <Text style={{ color: BlueprintColors.primaryAccent }}>P</Text>arkStop
            </Text>
          </View>
        </View>

        <View style={styles.titleSection}>
          <Text style={styles.mainTitle}>Find It. Park It. Go.</Text>
          <Text style={styles.subtitle}>Instant parking, wherever you need it.</Text>
        </View>

        <View style={styles.cardsContainer}>
          <TouchableOpacity 
            style={[
              BlueprintTheme.glassCard, 
              styles.roleCard,
              activeRole === 'FINDER' && styles.activeCard
            ]} 
            onPress={() => handleSelectRole('FINDER')}
            activeOpacity={0.9}
          >
            <View style={styles.cardContent}>
              <View style={[styles.iconContainer, activeRole === 'FINDER' && styles.activeIcon]}>
                <Text style={styles.iconText}>🔍</Text>
              </View>
              <View>
                <Text style={styles.cardTitle}>I'm a Finder</Text>
                <Text style={styles.cardDesc}>Looking for a parking spot</Text>
              </View>
            </View>
          </TouchableOpacity>

          <TouchableOpacity 
            style={[
              BlueprintTheme.glassCard, 
              styles.roleCard,
              activeRole === 'SPOTTER' && styles.activeCard
            ]} 
            onPress={() => handleSelectRole('SPOTTER')}
            activeOpacity={0.9}
          >
            <View style={styles.cardContent}>
              <View style={[styles.iconContainer, activeRole === 'SPOTTER' && styles.activeIcon]}>
                <Text style={styles.iconText}>🅿️</Text>
              </View>
              <View>
                <Text style={styles.cardTitle}>I'm a Spotter</Text>
                <Text style={styles.cardDesc}>Listing parking spots</Text>
              </View>
            </View>
          </TouchableOpacity>
        </View>

        <View style={styles.footer}>
          <TouchableOpacity 
            style={[BlueprintTheme.buttonPrimary, !activeRole && { opacity: 0.5 }]} 
            onPress={handleContinue}
            disabled={!activeRole}
          >
            <Text style={BlueprintTheme.buttonPrimaryText}>Continue</Text>
          </TouchableOpacity>
          
          <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}>
            <Text style={styles.logoutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scrollContent: { padding: 24, flexGrow: 1, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: 40 },
  logoContainer: { flexDirection: 'row', alignItems: 'center' },
  logoText: { fontSize: 32, fontWeight: '900', color: '#FFFFFF', letterSpacing: -1 },
  titleSection: { alignItems: 'center', marginBottom: 48 },
  mainTitle: { fontSize: 36, fontWeight: '800', color: '#FFFFFF', marginBottom: 8, textAlign: 'center' },
  subtitle: { fontSize: 16, color: BlueprintColors.textSecondary, textAlign: 'center' },
  cardsContainer: { gap: 16, marginBottom: 48 },
  roleCard: { padding: 24 },
  activeCard: { borderColor: BlueprintColors.primaryAccent, backgroundColor: 'rgba(255, 107, 44, 0.1)' },
  cardContent: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  iconContainer: { width: 48, height: 48, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center', alignItems: 'center' },
  activeIcon: { backgroundColor: BlueprintColors.primaryAccent },
  iconText: { fontSize: 24 },
  cardTitle: { fontSize: 20, fontWeight: '700', color: '#FFFFFF' },
  cardDesc: { fontSize: 14, color: BlueprintColors.textSecondary },
  footer: { gap: 16 },
  logoutBtn: { alignSelf: 'center', padding: 12 },
  logoutText: { color: BlueprintColors.textSecondary, fontWeight: '600' }
});
