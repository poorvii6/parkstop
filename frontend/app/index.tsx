import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlueprintColors } from '../constants/BlueprintTheme';
import { auth } from '../services/firebase';
import { onAuthStateChanged } from 'firebase/auth';

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
        const token = await AsyncStorage.getItem('access_token');
        const isOffline = token === 'offline_token';
        const firebaseUser = await getRestoredUser();
        await new Promise((r) => setTimeout(r, 700));

        // Not signed in -> Welcome (which then reveals the walkthrough)
        if (!firebaseUser && !isOffline) { router.replace('/welcome'); return; }

        const role = await AsyncStorage.getItem('user_role');
        const isDualUser = await AsyncStorage.getItem('is_dual_user');
        const r = role ? role.toUpperCase() : '';
        if (r === 'ADMIN') router.replace('/admin');
        else if (isDualUser === 'true') router.replace('/role-selection');
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
