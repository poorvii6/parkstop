import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlueprintColors } from '../constants/BlueprintTheme';
import { auth } from '../services/firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { isOtpVerified } from '../utils/otpGate';
import apiClient from '../api/client';

export default function SplashScreen() {
  const router = useRouter();
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fade, { toValue: 1, duration: 550, useNativeDriver: true }).start();

    const getRestoredUser = () =>
      new Promise<any>((resolve) => {
        let settled = false;
        const done = (u: any) => { if (settled) return; settled = true; resolve(u); };
        const unsub = onAuthStateChanged(auth, (user) => { unsub(); done(user); });
        setTimeout(() => done(auth.currentUser), 5000);
      });

    const checkAuth = async () => {
      try {
        // Old builds had a "guest/offline" shortcut that let the app open with
        // no login at all. Wipe any leftover of it so it can never be used.
        if ((await AsyncStorage.getItem('access_token')) === 'offline_token') {
          await AsyncStorage.removeItem('access_token');
        }

        const firebaseUser = await getRestoredUser();
        await new Promise((r) => setTimeout(r, 700));

        // Not signed in -> Welcome. A real login is the ONLY way in.
        if (!firebaseUser) {
          await AsyncStorage.multiRemove(['access_token', 'refresh_token', 'user_role', 'is_dual_user', 'otp_verified_uid']);
          router.replace('/welcome');
          return;
        }

        // Signed in to Firebase but never finished the email OTP on this phone
        // (e.g. closed the app at the code screen). Sign out and start over.
        if (firebaseUser && !(await isOtpVerified(firebaseUser.uid))) {
          await auth.signOut().catch(() => {});
          router.replace('/welcome');
          return;
        }

        // Ask the server who this is. The role saved on the phone can be out of
        // date (e.g. an account made admin, or a new owner).
        let r = '';
        let isDual = false;
        try {
          const res = await apiClient.get('/auth/profile');
          const u = res.data?.data?.user;
          if (!u) throw new Error('no profile');
          isDual = !!(u.is_finder_registered && u.is_spotter_registered);
          r = String(u.role || '').toUpperCase();
          if (r === 'ADMIN') {
            await AsyncStorage.setItem('user_role', 'ADMIN');
          } else {
            // Keep the mode the user last chose, if they are allowed it.
            const saved = String((await AsyncStorage.getItem('user_role')) || '').toUpperCase();
            if (saved === 'SPOTTER' && u.is_spotter_registered) r = 'SPOTTER';
            else if (saved === 'FINDER') r = 'FINDER';
            await AsyncStorage.setItem('user_role', r);
          }
          await AsyncStorage.setItem('is_dual_user', isDual ? 'true' : 'false');
        } catch (e: any) {
          // Account no longer valid on the server -> the API client has already
          // signed out on 401. Start over.
          if (e?.response?.status === 401 || e?.response?.status === 404 || !auth.currentUser) {
            router.replace('/welcome');
            return;
          }
          // Server unreachable: open the last screen; it will show it is offline.
          r = String((await AsyncStorage.getItem('user_role')) || '').toUpperCase();
          isDual = (await AsyncStorage.getItem('is_dual_user')) === 'true';
        }

        if (r === 'ADMIN') router.replace('/admin');
        else if (isDual) router.replace('/role-selection');
        else if (r === 'SPOTTER') router.replace('/spotter');
        else if (r === 'FINDER') router.replace('/finder');
        else router.replace('/role-selection');
      } catch (e) {
        router.replace('/welcome');
      }
    };
    checkAuth();
  }, []);

  return (
    <View style={styles.container}>
      <Animated.Text style={[styles.logo, { opacity: fade }]}>
        <Text style={{ color: BlueprintColors.primaryAccent }}>P</Text>arkStop
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BlueprintColors.background, justifyContent: 'center', alignItems: 'center' },
  logo: { color: '#FFFFFF', fontSize: 44, fontWeight: '900', letterSpacing: -2 },
});
