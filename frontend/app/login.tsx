import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Platform, KeyboardAvoidingView, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '../api/client';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';
import { signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth } from '../services/firebase';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleLogin = async () => {
    if (!email || !password) return Alert.alert('Hold up!', 'Please enter your email and password');
    setLoading(true);

    try {
      console.log(`[AUTH] Authenticating with Firebase for email: ${email}`);
      const userCredential = await signInWithEmailAndPassword(auth, email, password);
      const firebaseUser = userCredential.user;

      console.log(`[AUTH] Firebase login successful. Retrieving ID token...`);
      const firebaseToken = await firebaseUser.getIdToken();

      console.log(`[AUTH] Synchronizing session profile with ParkStop database...`);
      const response = await apiClient.post('/auth/social-login', {
        email: firebaseUser.email || email,
        token: firebaseToken
      });

      if (response.data.success) {
        await AsyncStorage.setItem('user_role', response.data.data.user.role);
        router.replace('/welcome');
      }
    } catch (error: any) {
      console.error('[AUTH] Login Error:', error.response?.data || error.message);
      const msg = error.response?.data?.message || 'Incorrect email or password';
      if (Platform.OS === 'web') alert('Login Failed: ' + msg);
      else Alert.alert('Login Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSocialLogin = async (providerName: 'google' | 'apple') => {
    if (providerName === 'apple') {
      Alert.alert('Sign in with Apple', 'Apple Sign-In requires active provisioning profiles. Please use Email/Password sign-in or Google for development.');
      return;
    }

    try {
      setLoading(true);
      console.log(`[SOCIAL AUTH] Triggering Firebase Google Sign-In...`);
      const provider = new GoogleAuthProvider();
      
      let userCredential;
      if (Platform.OS === 'web') {
        userCredential = await signInWithPopup(auth, provider);
      } else {
        const Constants = require('expo-constants').default;
        const isExpoGo = Constants.appOwnership === 'expo';
        
        if (isExpoGo) {
          setLoading(false);
          Alert.alert(
            'Development Build Required',
            'Native Google Sign-In cannot run inside the default Expo Go app. Please use your Web browser, or use Email/Password sign-in to test locally.'
          );
          return;
        }

        try {
          const { GoogleSignin } = require('@react-native-google-signin/google-signin');
          const { signInWithCredential } = require('firebase/auth');
          
          GoogleSignin.configure({
            webClientId: '1004284557988-h41uhmkqd31872dicfos21gj59rh5vr5.apps.googleusercontent.com',
          });
          
          await GoogleSignin.hasPlayServices();
          const { idToken } = await GoogleSignin.signIn();
          const credential = GoogleAuthProvider.credential(idToken);
          userCredential = await signInWithCredential(auth, credential);
        } catch (err: any) {
          setLoading(false);
          if (err.code === 'SIGN_IN_CANCELLED') {
            Alert.alert('Cancelled', 'Sign-in was cancelled.');
          } else {
            Alert.alert(
              'Development Build Required',
              'Native Google Sign-In cannot run inside the default Expo Go app. Please use your Web browser, or use Email/Password sign-in to test locally.'
            );
          }
          return; // Exit gracefully without crashing
        }
      }

      if (!userCredential) return;

      const firebaseUser = userCredential.user;
      const firebaseToken = await firebaseUser.getIdToken();
      console.log(`[SOCIAL AUTH] Firebase login successful. Syncing profile...`);
      const response = await apiClient.post('/auth/social-login', {
        email: firebaseUser.email,
        name: firebaseUser.displayName || '',
        token: firebaseToken
      });

      if (response.data.success) {
        await AsyncStorage.setItem('user_role', response.data.data.user.role);
        router.replace('/welcome');
      }
    } catch (error: any) {
      console.error('[SOCIAL AUTH] OAuth Error:', error);
      Alert.alert('Authentication Failed', error.message || 'Failed to complete social login.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={BlueprintTheme.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <Text style={styles.logoText}>
              <Text style={{ color: BlueprintColors.primaryAccent }}>P</Text>arkStop
            </Text>
          </View>

          <View style={styles.titleSection}>
            <Text style={styles.mainTitle}>Welcome Back</Text>
            <Text style={styles.subtitle}>Enter your details to find your spot.</Text>
          </View>

          {loading ? (
            <View style={{ paddingVertical: 60, alignItems: 'center' }}>
              <ActivityIndicator size="large" color={BlueprintColors.primaryAccent} />
              <Text style={{ color: '#94a3b8', marginTop: 16, fontWeight: '600' }}>Authenticating...</Text>
            </View>
          ) : (
            <>
              <View style={styles.inputSection}>
                <View style={styles.inputWrapper}>
                  <Text style={BlueprintTheme.inputLabel}>Email Address</Text>
                  <TextInput
                    style={BlueprintTheme.input}
                    placeholder="alexj@email.com"
                    placeholderTextColor="rgba(255,255,255,0.2)"
                    autoCapitalize="none"
                    keyboardType="email-address"
                    value={email}
                    onChangeText={setEmail}
                  />
                </View>

                <View style={styles.inputWrapper}>
                  <Text style={BlueprintTheme.inputLabel}>Password</Text>
                  <TextInput
                    style={BlueprintTheme.input}
                    placeholder="••••••••"
                    placeholderTextColor="rgba(255,255,255,0.2)"
                    secureTextEntry
                    value={password}
                    onChangeText={setPassword}
                  />
                </View>
              </View>

              <View style={styles.footer}>
                <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={handleLogin} disabled={loading}>
                  <Text style={BlueprintTheme.buttonPrimaryText}>Sign In</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.googleBtn, { backgroundColor: '#FFFFFF' }]} 
                  onPress={() => handleSocialLogin('google')}
                >
                  <Text style={[styles.googleBtnText, { color: '#000000' }]}>Continue with Google</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.googleBtn, { backgroundColor: '#000000', borderColor: '#FFFFFF', marginTop: 12 }]} 
                  onPress={() => handleSocialLogin('apple')}
                >
                  <Text style={styles.googleBtnText}>Continue with Apple</Text>
                </TouchableOpacity>

                <TouchableOpacity onPress={() => router.replace('/register')} style={styles.registerLink}>
                  <Text style={styles.linkText}>Don't have an account? <Text style={styles.linkBold}>Sign Up</Text></Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.googleBtn, { marginTop: 20, borderColor: BlueprintColors.primaryAccent }]} 
                  onPress={async () => {
                    await AsyncStorage.setItem('access_token', 'offline_token');
                    await AsyncStorage.setItem('user_role', 'FINDER');
                    router.replace('/welcome');
                  }}
                >
                  <Text style={[styles.googleBtnText, { color: BlueprintColors.primaryAccent }]}>Skip Login (4G Guest Mode)</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: 64 },
  logoText: { fontSize: 36, fontWeight: '900', color: '#FFFFFF', letterSpacing: -1 },
  titleSection: { marginBottom: 40 },
  mainTitle: { fontSize: 32, fontWeight: '800', color: '#FFFFFF', marginBottom: 8 },
  subtitle: { fontSize: 16, color: BlueprintColors.textSecondary },
  inputSection: { gap: 8, marginBottom: 32 },
  inputWrapper: { gap: 4 },
  footer: { gap: 16 },
  googleBtn: { 
    backgroundColor: 'rgba(255,255,255,0.05)', 
    paddingVertical: 18, 
    borderRadius: 16, 
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)'
  },
  googleBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  registerLink: { marginTop: 16, alignItems: 'center' },
  linkText: { color: BlueprintColors.textSecondary, fontSize: 14 },
  linkBold: { color: BlueprintColors.primaryAccent, fontWeight: '700' }
});
