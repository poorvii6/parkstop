import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';

export default function TermsScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={BlueprintTheme.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Terms of Service</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.closeBtn} accessibilityLabel="Close">
          <Text style={styles.closeText}>✕</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>
          Please review these terms carefully. By creating a ParkStop account you agree to everything below.
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>1. Introduction & Acceptance</Text>
          <Text style={styles.textBody}>
            By creating an account or using ParkStop, you enter into a legally binding agreement to follow these Terms of Service. If you do not agree to these terms, do not download, install, or use the application.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>2. Account & Eligibility</Text>
          <Text style={styles.textBody}>
            You must be at least 18 years of age to register for a ParkStop account. You agree to provide accurate, complete, and current information during registration, and to maintain the security of your login credentials.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>3. User Guidelines & Conduct</Text>
          <Text style={styles.subHeader}>As a Finder</Text>
          <Text style={styles.textBody}>
            You agree to park only in your booked spot during the active booking duration, to respect the host's property, obey all posted signage, and remove your vehicle promptly at the end of the booking window. Overstaying may result in towing or additional fines.
          </Text>
          <Text style={styles.subHeader}>As a Spot Owner</Text>
          <Text style={styles.textBody}>
            You agree to list only private parking spots that you legally own or are authorized to rent. You must accurately describe the spot's size, accessibility, and availability, and keep it clear and accessible for Finders during booking hours.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>4. Payments, Fees & Payouts</Text>
          <Text style={styles.subHeader}>Finders</Text>
          <Text style={styles.textBody}>
            You agree to pay all booking fees and applicable convenience charges at the time of reservation. Payments are securely processed online. Cancellations and refunds are governed by the active host cancellation policy.
          </Text>
          <Text style={styles.subHeader}>Spot Owners</Text>
          <Text style={styles.textBody}>
            Earnings and payouts are processed securely through our payment integration. ParkStop deducts a standard platform convenience fee from each transaction. Payouts are transferred to your connected account after successful completion of spot usage.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>5. Limitation of Liability</Text>
          <Text style={styles.textBody}>
            ParkStop acts strictly as a platform connecting hosts and finders. We do not inspect, guarantee, or assume liability for the physical condition, safety, or security of any listed parking space. ParkStop is not responsible for any theft, vandalism, vehicle damage, property damage, or personal injury occurring at parking locations.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionHeader}>6. Governing Law & Disputes</Text>
          <Text style={styles.textBody}>
            These Terms shall be governed by and construed in accordance with local regulations and national laws. Any legal disputes arising from or relating to the service will be subject to the exclusive jurisdiction of the competent local courts.
          </Text>
        </View>

        <TouchableOpacity style={[BlueprintTheme.buttonPrimary, styles.doneBtn]} onPress={() => router.back()}>
          <Text style={BlueprintTheme.buttonPrimaryText}>Done</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 8,
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: '#FFFFFF' },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  scrollContent: { padding: 24, paddingTop: 8 },
  intro: { color: BlueprintColors.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 24 },
  section: { marginBottom: 26 },
  sectionHeader: { color: '#FFFFFF', fontSize: 18, fontWeight: '700', marginBottom: 10 },
  subHeader: { color: BlueprintColors.primaryAccent, fontSize: 14, fontWeight: '700', marginBottom: 4, marginTop: 8 },
  textBody: { color: BlueprintColors.textSecondary, fontSize: 15, lineHeight: 24 },
  doneBtn: { marginTop: 8, marginBottom: 24 },
});
