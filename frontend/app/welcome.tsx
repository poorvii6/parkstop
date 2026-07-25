import React, { useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';

// Shows the walkthrough once per app launch. (Reset on a full reload, so it's
// easy to preview. Swap to an AsyncStorage 'has_seen_onboarding' flag when you
// want real users to see it only on first install.)
let walkthroughShownThisSession = false;

export default function WelcomeScreen() {
  const router = useRouter();

  // Hold this page ~3s, then reveal the walkthrough (once per launch).
  useFocusEffect(
    useCallback(() => {
      if (walkthroughShownThisSession) return;
      const timer = setTimeout(() => {
        walkthroughShownThisSession = true;
        router.replace('/onboarding');
      }, 3000);
      return () => clearTimeout(timer);
    }, [])
  );

  // Tapping a button cancels the auto-reveal for this session.
  const go = (dest: string) => {
    walkthroughShownThisSession = true;
    router.push(dest);
  };

  return (
    <SafeAreaView style={BlueprintTheme.container}>
      <View style={styles.container}>
        <View style={styles.hero}>
          <Text style={styles.logoText}>
            <Text style={{ color: BlueprintColors.primaryAccent }}>P</Text>arkStop
          </Text>
          <Text style={styles.tagline}>Find It. Park It. Go.</Text>
        </View>

        <View style={styles.footer}>
          <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={() => go('/register')}>
            <Text style={BlueprintTheme.buttonPrimaryText}>Get Started</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.signInBtn} onPress={() => go('/login')}>
            <Text style={styles.signInText}>
              Already have an account? <Text style={styles.signInBold}>Sign In</Text>
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: 'space-between' },
  hero: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  logoText: { fontSize: 46, fontWeight: '900', color: '#FFFFFF', letterSpacing: -2 },
  tagline: { fontSize: 18, fontWeight: '700', color: BlueprintColors.textSecondary, marginTop: 14 },
  footer: { gap: 14, marginBottom: 8 },
  signInBtn: { alignItems: 'center', paddingVertical: 8 },
  signInText: { color: BlueprintColors.textSecondary, fontSize: 14 },
  signInBold: { color: BlueprintColors.primaryAccent, fontWeight: '700' },
});
