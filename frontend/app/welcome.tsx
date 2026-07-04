import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { auth } from '../services/firebase';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';

export default function WelcomeScreen() {
  const router = useRouter();
  const [role, setRole] = useState<string>('');

  useEffect(() => {
    const loadRole = async () => {
      const storedRole = await AsyncStorage.getItem('user_role');
      if (storedRole) setRole(storedRole.toUpperCase());
    };
    loadRole();
  }, []);

  const handleContinue = async () => {
    if (role === 'ADMIN') router.replace('/admin');
    else if (role === 'SPOTTER') router.replace('/spotter');
    else if (role === 'FINDER') router.replace('/finder');
    else router.replace('/');
  };

  return (
    <SafeAreaView style={BlueprintTheme.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.logoText}>
            <Text style={{ color: BlueprintColors.primaryAccent }}>P</Text>arkStop
          </Text>
        </View>

        <View style={styles.titleSection}>
          <Text style={styles.mainTitle}>Term of Service</Text>
          <Text style={styles.subtitle}>Please review our terms before continuing.</Text>
        </View>

        <View style={[BlueprintTheme.glassCard, styles.contentCard]}>
          <Text style={styles.cardHeader}>Guidelines</Text>
          <Text style={styles.textBody}>
            {role === 'SPOTTER' ? (
              "As a Spotter, you're a key partner in our network. You'll be listing your private space for community use. Ensure your spot is accurately described and available during your listed hours. Commissions are processed weekly."
            ) : (
              "Find instant, secure parking anywhere in the city. By using ParkStop, you agree to respect the host's property and follow all local parking regulations. Your booking is valid for the selected duration only."
            )}
          </Text>
        </View>

        <View style={[BlueprintTheme.glassCard, styles.contentCard]}>
          <Text style={styles.cardHeader}>Liability & Safety</Text>
          <Text style={styles.textBody}>
            ParkStop provides a platform for connecting hosts and finders. We are not responsible for any theft, damage, or accidents that occur at parking locations. Please ensure your vehicle is locked and no valuables are left inside.
          </Text>
        </View>

        <View style={styles.footer}>
          <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={handleContinue}>
            <Text style={BlueprintTheme.buttonPrimaryText}>Accept and continue</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            onPress={async () => {
              await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role']);
              try {
                await auth.signOut();
              } catch (err) {}
              router.replace('/login');
            }} 
            style={styles.declineBtn}
          >
            <Text style={styles.declineText}>Decline</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1, padding: 24 },
  header: { alignItems: 'center', marginBottom: 48 },
  logoText: { fontSize: 28, fontWeight: '900', color: '#FFFFFF', letterSpacing: -1 },
  titleSection: { marginBottom: 32 },
  mainTitle: { fontSize: 32, fontWeight: '800', color: '#FFFFFF', marginBottom: 8 },
  subtitle: { fontSize: 16, color: BlueprintColors.textSecondary },
  contentCard: { padding: 20, marginBottom: 20 },
  cardHeader: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginBottom: 12 },
  textBody: { color: BlueprintColors.textSecondary, fontSize: 15, lineHeight: 22 },
  footer: { marginTop: 20, gap: 16 },
  declineBtn: { alignItems: 'center', paddingVertical: 12 },
  declineText: { color: BlueprintColors.textSecondary, fontWeight: '600' }
});
