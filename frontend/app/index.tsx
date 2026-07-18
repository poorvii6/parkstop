import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlueprintColors } from '../constants/BlueprintTheme';
import { auth } from '../services/firebase';
import { onAuthStateChanged } from 'firebase/auth';

export default function SplashScreen() {
  const router = useRouter();
  const [fadeAnim] = useState(new Animated.Value(0));

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 1000,
      useNativeDriver: true,
    }).start();

    // Resolves once Firebase has finished restoring any persisted session from
    // AsyncStorage. Reading auth.currentUser directly is unreliable at startup
    // because that restore happens asynchronously — onAuthStateChanged fires
    // exactly once when it's ready. A 5s timeout guards against a stuck listener.
    const getRestoredUser = () =>
      new Promise<any>((resolve) => {
        let settled = false;
        const finish = (u: any) => {
          if (settled) return;
          settled = true;
          resolve(u);
        };
        const unsub = onAuthStateChanged(auth, (user) => {
          unsub();
          finish(user);
        });
        setTimeout(() => finish(auth.currentUser), 5000);
      });

    const checkAuth = async () => {
      try {
        // 1. Check if terms have been accepted
        const hasAcceptedTerms = await AsyncStorage.getItem('has_accepted_terms');
        if (hasAcceptedTerms !== 'true') {
          await new Promise(resolve => setTimeout(resolve, 1200));
          router.replace('/welcome');
          return;
        }

        // 2. Wait for Firebase to restore the persisted session (keeps users logged in)
        const token = await AsyncStorage.getItem('access_token');
        const isOffline = token === 'offline_token';
        const firebaseUser = await getRestoredUser();

        // Minimum splash time for a premium feel
        await new Promise(resolve => setTimeout(resolve, 800));

        if (!firebaseUser && !isOffline) {
          router.replace('/login');
          return;
        }

        // 3. Route authenticated user to the right dashboard
        const role = await AsyncStorage.getItem('user_role');
        const isDualUser = await AsyncStorage.getItem('is_dual_user');

        if (isDualUser === 'true') {
          router.replace('/role-selection');
        } else {
          const r = role ? role.toUpperCase() : '';
          if (r === 'ADMIN') router.replace('/admin');
          else if (r === 'SPOTTER') router.replace('/spotter');
          else if (r === 'FINDER') router.replace('/finder');
          else router.replace('/role-selection');
        }
      } catch (e) {
        router.replace('/login');
      }
    };

    checkAuth();
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: BlueprintColors.background }]}>
      <Animated.View style={[styles.content, { opacity: fadeAnim }]}>
        <View style={styles.logoContainer}>
          <Text style={styles.logoText}>
            <Text style={{ color: BlueprintColors.primaryAccent }}>P</Text>arkStop
          </Text>
        </View>
        <Text style={styles.subtitle}>Instant parking, wherever you need it.</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    alignItems: 'center',
  },
  logoContainer: {
    marginBottom: 16,
  },
  logoText: {
    color: '#FFFFFF',
    fontSize: 48,
    fontWeight: '900',
    letterSpacing: -2,
  },
  subtitle: {
    color: BlueprintColors.textSecondary,
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    paddingHorizontal: 40,
  },
});
