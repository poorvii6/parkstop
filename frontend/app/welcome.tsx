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
  const [isChecked, setIsChecked] = useState(false);

  useEffect(() => {
    const loadRole = async () => {
      const storedRole = await AsyncStorage.getItem('user_role');
      if (storedRole) setRole(storedRole.toUpperCase());
    };
    loadRole();
  }, []);

  const handleContinue = async () => {
    if (!isChecked) return;
    try {
      await AsyncStorage.setItem('has_accepted_terms', 'true');

      // If user is already logged in, go to their dashboard
      const hasFirebaseUser = auth.currentUser !== null;
      if (hasFirebaseUser && role) {
        if (role === 'ADMIN') router.replace('/admin');
        else if (role === 'SPOTTER') router.replace('/spotter');
        else if (role === 'FINDER') router.replace('/finder');
        else router.replace('/role-selection');
      } else {
        // New user — send to register
        router.replace('/register');
      }
    } catch (e) {
      console.error('Error saving terms acceptance:', e);
    }
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
          <Text style={styles.mainTitle}>Terms of Service</Text>
          <Text style={styles.subtitle}>Please review and accept our terms before continuing.</Text>
        </View>

        {/* 1. Introduction & Acceptance */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>1. Introduction & Acceptance</Text>
          <Text style={styles.textBody}>
            By creating an account or using ParkStop, you enter into a legally binding agreement to follow these Terms of Service. If you do not agree to these terms, do not download, install, or use the application.
          </Text>
        </View>

        {/* 2. Account & Eligibility */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>2. Account & Eligibility</Text>
          <Text style={styles.textBody}>
            You must be at least 18 years of age to register for a ParkStop account. You agree to provide accurate, complete, and current information during registration, and to maintain the security of your login credentials.
          </Text>
        </View>

        {/* 3. Guidelines & Conduct */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>3. User Guidelines & Conduct</Text>
          <Text style={styles.textBody}>
            {role === 'SPOTTER' ? (
              "As a Spot Owner, you agree to list only private parking spots that you legally own or are authorized to rent. You must accurately describe the spot's size, accessibility, and availability, and ensure that the spot is kept clear and accessible for Finders during booking hours."
            ) : (
              "As a Finder, you agree to park only in your booked spot during the active booking duration. You agree to respect the host's property, obey all posted signage, and remove your vehicle promptly at the end of the booking window. Overstaying may result in towing or additional fines."
            )}
          </Text>
        </View>

        {/* 4. Payments, Fees & Payouts */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>4. Payments, Fees & Payouts</Text>
          <Text style={styles.textBody}>
            {role === 'SPOTTER' ? (
              "Spot Owner earnings and payouts are processed securely through our payment integration. ParkStop deducts a standard platform convenience fee from each transaction. Payouts are transferred weekly to your connected bank account/wallet after verifying successful completion of spot usage."
            ) : (
              "Finders agree to pay all booking fees and applicable convenience charges at the time of reservation. Payments are securely processed online. Cancellations and refunds are governed by the active host cancellation policy."
            )}
          </Text>
        </View>

        {/* 5. Limitation of Liability */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>5. Limitation of Liability</Text>
          <Text style={styles.textBody}>
            ParkStop acts strictly as a platform connecting hosts and finders. We do not inspect, guarantee, or assume liability for the physical condition, safety, or security of any listed parking space. ParkStop is not responsible for any theft, vandalism, vehicle damage, property damage, or personal injury occurring at parking locations.
          </Text>
        </View>

        {/* 6. Governing Law & Dispute Resolution */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>6. Governing Law & Disputes</Text>
          <Text style={styles.textBody}>
            These Terms shall be governed by and construed in accordance with local regulations and national laws. Any legal disputes arising from or relating to the service will be subject to the exclusive jurisdiction of the competent local courts.
          </Text>
        </View>

        {/* Interactive Checkbox */}
        <TouchableOpacity 
          style={styles.checkboxContainer} 
          onPress={() => setIsChecked(!isChecked)}
          activeOpacity={0.8}
        >
          <View style={[styles.checkbox, isChecked && styles.checkboxChecked]}>
            {isChecked && <Text style={styles.checkboxCheckmark}>✓</Text>}
          </View>
          <Text style={styles.checkboxLabel}>
            I have read and agree to the Terms of Service and Privacy Policy
          </Text>
        </TouchableOpacity>

        {/* Footer Actions */}
        <View style={styles.footer}>
          <TouchableOpacity 
            style={[BlueprintTheme.buttonPrimary, !isChecked && styles.buttonDisabled]} 
            onPress={handleContinue}
            disabled={!isChecked}
          >
            <Text style={BlueprintTheme.buttonPrimaryText}>Accept and continue</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            onPress={async () => {
              try {
                await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role', 'has_accepted_terms', 'is_dual_user']);
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
  section: { marginBottom: 28, paddingHorizontal: 4 },
  sectionHeader: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginBottom: 10 },
  textBody: { color: BlueprintColors.textSecondary, fontSize: 15, lineHeight: 24 },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 24,
    paddingHorizontal: 4,
    gap: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: BlueprintColors.primaryAccent,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  checkboxChecked: {
    backgroundColor: BlueprintColors.primaryAccent,
    borderColor: BlueprintColors.primaryAccent,
  },
  checkboxCheckmark: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  checkboxLabel: {
    color: BlueprintColors.textSecondary,
    fontSize: 14,
    flex: 1,
    lineHeight: 20,
  },
  footer: { gap: 16 },
  buttonDisabled: {
    opacity: 0.5,
    shadowOpacity: 0,
    elevation: 0,
  },
  declineBtn: { alignItems: 'center', paddingVertical: 12 },
  declineText: { color: BlueprintColors.textSecondary, fontWeight: '600' }
});
