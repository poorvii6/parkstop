import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BlueprintColors } from '../constants/BlueprintTheme';

export default function SplashScreen() {
  const router = useRouter();
  const [fadeAnim] = useState(new Animated.Value(0));

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 1000,
      useNativeDriver: true,
    }).start();

    const checkAuth = async () => {
      // Shorter delay for premium feel
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        const token = await AsyncStorage.getItem('access_token');
        const role = await AsyncStorage.getItem('user_role');
        
        if (!token) {
          router.replace('/login'); // Prefer login as entry point now
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
