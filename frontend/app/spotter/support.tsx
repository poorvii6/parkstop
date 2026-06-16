import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SC, TF, SP, RAD, SS } from '../../constants/SpotterTheme';

const FAQ_ITEMS = [
  {
    q: 'How does ParkStop work for Spotters?',
    a: 'As a Spotter, you list your empty parking spaces on our map. Drivers (Finders) can then discover and reserve your spot. When they arrive, they show you a unique 6-digit OTP code. Verify this code in the "Verify" tab to start the parking session.',
  },
  {
    q: 'Where can I see my total earnings?',
    a: 'Your total earnings are displayed on the Dashboard tab. Monthly earnings are shown at a glance. Payments are processed weekly to your registered bank account after a small platform fee.',
  },
  {
    q: 'What if a driver stays past their reserved time?',
    a: 'The app tracks session duration automatically. If a driver overstays, the session remains active. When they leave, the total fee is calculated based on actual time parked.',
  },
  {
    q: 'Can I list more than one parking spot?',
    a: 'Yes! Use the "Spots" tab to create multiple listings. You can manage all your spots from a single dashboard and track occupancy in real-time.',
  },
  {
    q: 'How do I verify a driver\'s arrival?',
    a: 'Go to the "Verify" tab, enter the driver\'s Booking ID and their 6-digit OTP, then tap "Verify & Park". This starts the session and activates payment tracking.',
  },
];

export default function SupportPage() {
  const router = useRouter();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const toggleFAQ = (index: number) => {
    setExpandedIndex(expandedIndex === index ? null : index);
  };

  const handleCall = () => Linking.openURL('tel:+919845705793');
  const handleEmail = () => Linking.openURL('mailto:twin.win500@gmail.com');

  return (
    <View style={SS.page}>
      {/* HEADER */}
      <SafeAreaView edges={['top']} style={SS.headerSafe}>
        <View style={SS.header}>
          <Text style={SS.logoText}>
            <Text style={SS.logoAccent}>P</Text>arkStop
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={SS.statusBox}>
              <Text style={SS.statusLabel}>SPOTTER STATUS</Text>
              <View style={SS.statusRow}>
                <Text style={SS.statusText}>Active</Text>
                <View style={SS.statusDot} />
              </View>
            </View>
            <TouchableOpacity onPress={() => router.push('/modal')} style={SS.profileBtn}>
              <Ionicons name="person" size={18} color={SC.info} />
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={SS.scrollContent}>
        {/* HELP CARD */}
        <View style={s.helpCard}>
          <View style={s.helpIconRow}>
            <View style={s.helpIconBg}>
              <Ionicons name="headset" size={28} color={SC.accent} />
            </View>
          </View>
          <Text style={{ color: SC.textPrimary, ...TF.h1, marginBottom: 6 }}>Need Help?</Text>
          <Text style={{ color: SC.textSecondary, ...TF.bodySm, lineHeight: 20, marginBottom: SP.xl }}>
            Our support team is available 24/7 to assist with your parking listings and payments.
          </Text>

          <TouchableOpacity style={s.contactItem} onPress={handleCall}>
            <View style={[s.contactIcon, { backgroundColor: SC.successSoft }]}>
              <Ionicons name="call" size={18} color={SC.success} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: SC.textMuted, ...TF.labelSm }}>CALL PRIORITY HOTLINE</Text>
              <Text style={{ color: SC.textPrimary, ...TF.bodyBold, marginTop: 2 }}>+91 98457 05793</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={SC.textMuted} />
          </TouchableOpacity>

          <TouchableOpacity style={s.contactItem} onPress={handleEmail}>
            <View style={[s.contactIcon, { backgroundColor: SC.infoSoft }]}>
              <Ionicons name="mail" size={18} color={SC.info} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: SC.textMuted, ...TF.labelSm }}>EMAIL SUPPORT</Text>
              <Text style={{ color: SC.textPrimary, ...TF.bodyBold, marginTop: 2 }}>twin.win500@gmail.com</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={SC.textMuted} />
          </TouchableOpacity>
        </View>

        {/* FAQ SECTION */}
        <View style={SS.sectionHeader}>
          <Text style={SS.sectionTitle}>Frequently Asked</Text>
          <View style={SS.badge}>
            <Text style={SS.badgeText}>{FAQ_ITEMS.length} TOPICS</Text>
          </View>
        </View>

        {FAQ_ITEMS.map((item, index) => (
          <View key={index} style={{ marginBottom: 10 }}>
            <TouchableOpacity
              style={[
                s.faqQuestion,
                expandedIndex === index && s.faqQuestionExpanded,
              ]}
              onPress={() => toggleFAQ(index)}
              activeOpacity={0.8}
            >
              <View style={s.faqNum}>
                <Text style={s.faqNumText}>{index + 1}</Text>
              </View>
              <Text style={{ color: SC.textPrimary, ...TF.bodyBold, flex: 1, marginRight: 10 }}>
                {item.q}
              </Text>
              <Ionicons
                name={expandedIndex === index ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={SC.accent}
              />
            </TouchableOpacity>
            {expandedIndex === index && (
              <View style={s.faqAnswer}>
                <Text style={{ color: SC.textSecondary, ...TF.bodySm, lineHeight: 20 }}>
                  {item.a}
                </Text>
              </View>
            )}
          </View>
        ))}

        {/* APP INFO */}
        <View style={s.appInfo}>
          <Text style={{ color: SC.textMuted, ...TF.bodySm, textAlign: 'center' }}>
            ParkStop v2.0 · Made with ❤️ in India
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  helpCard: {
    backgroundColor: SC.bgCard,
    borderRadius: RAD.xl,
    padding: SP.xl,
    marginBottom: SP.xxl,
    borderWidth: 1.5,
    borderColor: SC.borderActive,
  },
  helpIconRow: {
    marginBottom: SP.lg,
  },
  helpIconBg: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: SC.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
  },

  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: RAD.md,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: SC.border,
  },
  contactIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },

  faqQuestion: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SC.bgCard,
    borderRadius: RAD.md,
    padding: 16,
    borderWidth: 1,
    borderColor: SC.border,
  },
  faqQuestionExpanded: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderBottomColor: 'transparent',
  },
  faqNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: SC.accentSoft,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  faqNumText: {
    color: SC.accent,
    fontSize: 11,
    fontWeight: '800',
  },
  faqAnswer: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    padding: 16,
    borderBottomLeftRadius: RAD.md,
    borderBottomRightRadius: RAD.md,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: SC.border,
    borderLeftWidth: 3,
    borderLeftColor: SC.accent,
  },

  appInfo: {
    marginTop: SP.xxl,
    paddingBottom: 20,
  },
});
