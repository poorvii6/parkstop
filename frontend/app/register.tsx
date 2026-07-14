import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import apiClient from '../api/client';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';
import { createUserWithEmailAndPassword, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { auth } from '../services/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';

export default function RegisterScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'FINDER' | 'SPOTTER'>('FINDER');
  const [loading, setLoading] = useState(false);

  // Email OTP States
  const [otpModalVisible, setOtpModalVisible] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);

  const router = useRouter();

  const handleSocialLogin = async (providerName: 'google') => {
    try {
      setLoading(true);
      if (__DEV__) console.log(`[SOCIAL AUTH] Triggering Firebase Google Sign-In...`);
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
            webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '',
          });
          
          await GoogleSignin.hasPlayServices();
          await GoogleSignin.signOut().catch(() => {});
          const result = await GoogleSignin.signIn();
          if (__DEV__) console.log('[SOCIAL AUTH] Google Sign-In raw result:', JSON.stringify(result));
          
          const idToken = result.idToken || result.data?.idToken;
          if (!idToken) {
            throw new Error('Google Sign-In completed but failed to obtain ID Token.');
          }
          
          const credential = GoogleAuthProvider.credential(idToken);
          userCredential = await signInWithCredential(auth, credential);
        } catch (err: any) {
          setLoading(false);
          console.error('[SOCIAL AUTH] Google Sign-In failed:', err);
          if (err.code === 'SIGN_IN_CANCELLED') {
            Alert.alert('Cancelled', 'Sign-in was cancelled.');
          } else {
            Alert.alert(
              'Google Sign-In Error',
              `Code: ${err.code || 'UNKNOWN'}\nMessage: ${err.message || 'An error occurred.'}`
            );
          }
          return; // Exit gracefully without crashing
        }
      }

      if (!userCredential) return;

      const firebaseUser = userCredential.user;
      const firebaseToken = await firebaseUser.getIdToken();
      if (__DEV__) console.log(`[SOCIAL AUTH] Firebase login successful. Syncing profile...`);
      const response = await apiClient.post('/auth/social-login', {
        email: firebaseUser.email,
        name: firebaseUser.displayName || '',
        token: firebaseToken,
        role: role
      });

      if (response.data.success) {
        const user = response.data.data.user;
        await AsyncStorage.setItem('user_role', user.role);
        if (Platform.OS === 'web') alert('Welcome to ParkStop!');
        else Alert.alert('Welcome to ParkStop!', 'Thank you for joining our network.');

        const isDualUser = user.is_finder_registered && user.is_spotter_registered;
        await AsyncStorage.setItem('is_dual_user', isDualUser ? 'true' : 'false');
        if (isDualUser) {
          router.replace('/role-selection');
        } else {
          const r = user.role ? user.role.toUpperCase() : '';
          if (r === 'ADMIN') router.replace('/admin');
          else if (r === 'SPOTTER') router.replace('/spotter');
          else if (r === 'FINDER') router.replace('/finder');
          else router.replace('/role-selection');
        }
      }
    } catch (error: any) {
      console.error('[SOCIAL AUTH] OAuth Error:', error);
      Alert.alert('Authentication Failed', error.message || 'Failed to complete social login.');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async () => {
    // 1. Basic empty check
    if (!name || !email || !password || !phone) {
      return Alert.alert('Oops', 'Please fill out everything');
    }

    // 2. Gmail format validation
    const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;
    if (!gmailRegex.test(email)) {
      return Alert.alert('Invalid Email', 'Please enter a valid Gmail address (ending in @gmail.com)');
    }

    // 3. Indian Phone format validation
    const phoneRegex = /^(?:\+91|91)?[6-9]\d{9}$/;
    if (!phoneRegex.test(phone)) {
      return Alert.alert('Invalid Phone', 'Please enter a valid 10-digit Indian mobile number (e.g. 9876543210 or +919876543210)');
    }

    setLoading(true);

    try {
      if (__DEV__) console.log(`[GMAIL OTP] Requesting backend to send verification email to ${email}...`);
      const response = await apiClient.post('/auth/send-otp', { email });
      
      if (response.data.success) {
        setOtpCode('');
        setOtpModalVisible(true);
      }
    } catch (otpErr: any) {
      console.error('[GMAIL OTP] Send OTP request failed:', otpErr.response?.data || otpErr.message);
      let msg = otpErr.response?.data?.message || 'Failed to send OTP verification email. Please try again.';
      if (otpErr.message === 'Network Error') {
        msg = `Network Error: Cannot connect to backend server.\n\nExpected URL: ${apiClient.defaults.baseURL || 'http://localhost:3000/api/v1'}\n\nPlease check that:\n1. Your backend server is running.\n2. Your phone is on the same Wi-Fi network.\n3. Windows Firewall is not blocking port 3000.`;
      }
      Alert.alert('Send OTP Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (!otpCode || otpCode.length !== 6) {
      return Alert.alert('Oops', 'Please enter the 6-digit OTP code');
    }

    setOtpLoading(true);
    try {
      if (__DEV__) console.log(`[GMAIL OTP] Verifying OTP code for ${email}...`);
      const response = await apiClient.post('/auth/verify-otp', {
        email,
        code: otpCode
      });

      if (response.data.success && response.data.otp_token) {
        setOtpModalVisible(false);
        // OTP successfully verified, proceed with Firebase account creation & database sync
        await executeRegister(response.data.otp_token);
      }
    } catch (error: any) {
      console.error('[GMAIL OTP] Verification failed:', error.response?.data || error.message);
      const msg = error.response?.data?.message || 'Invalid or expired OTP verification code';
      Alert.alert('Verification Failed', msg);
    } finally {
      setOtpLoading(false);
    }
  };

  const executeRegister = async (otpToken: string) => {
    setLoading(true);
    let firebaseUser: any = null;

    try {
      if (__DEV__) console.log(`[AUTH] Registering user in Firebase...`);
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      firebaseUser = userCredential.user;

      let firebaseToken = '';
      try {
        firebaseToken = await firebaseUser.getIdToken();
      } catch (tokenErr) {
        console.error('[AUTH] Failed to get Firebase token, deleting user...', tokenErr);
        await firebaseUser.delete();
        throw tokenErr;
      }

      if (__DEV__) console.log(`[AUTH] Firebase account created. Registering in ParkStop local DB...`);
      try {
        const response = await apiClient.post('/auth/register', {
          name,
          email,
          phone,
          role,
          firebase_token: firebaseToken,
          otp_token: otpToken
        });

        if (response.data.success) {
          const user = response.data.data.user;
          await AsyncStorage.setItem('user_role', user.role);
          if (Platform.OS === 'web') alert('Welcome to ParkStop!');
          else Alert.alert('Welcome to ParkStop!', 'Thank you for joining our network.');

          const isDualUser = user.is_finder_registered && user.is_spotter_registered;
          await AsyncStorage.setItem('is_dual_user', isDualUser ? 'true' : 'false');
          if (isDualUser) {
            router.replace('/role-selection');
          } else {
            const r = user.role ? user.role.toUpperCase() : '';
            if (r === 'ADMIN') router.replace('/admin');
            else if (r === 'SPOTTER') router.replace('/spotter');
            else if (r === 'FINDER') router.replace('/finder');
            else router.replace('/role-selection');
          }
        }
      } catch (backendError: any) {
        console.error('[AUTH] Backend register failed, rolling back Firebase user:', backendError.response?.data || backendError.message);
        // Rollback Firebase user to keep database state consistent
        try {
          await firebaseUser.delete();
        } catch (delErr) {
          console.error('[AUTH] Failed to rollback Firebase user:', delErr);
        }
        throw backendError;
      }

    } catch (error: any) {
      const errorData = error.response?.data;
      console.error('[AUTH] Register Error Response:', errorData || error.message);
      let msg = errorData?.message || error.message || 'Network error';

      if (errorData?.errors) {
        const validationMsgs = errorData.errors.map((e: any) => `${e.field}: ${e.message}`).join('\n');
        msg = `Validation failed:\n${validationMsgs}`;
      }

      if (Platform.OS === 'web') alert('Registration Failed: ' + msg);
      else Alert.alert('Registration Failed', msg);
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
            <Text style={styles.mainTitle}>Create Account</Text>
            <Text style={styles.subtitle}>Join the network and start parking.</Text>
          </View>

          <View style={styles.roleContainer}>
            <TouchableOpacity
              style={[styles.roleButton, role === 'FINDER' && styles.roleButtonActive]}
              onPress={() => setRole('FINDER')}
            >
              <Text style={[styles.roleText, role === 'FINDER' && styles.roleTextActive]}>Finder</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.roleButton, role === 'SPOTTER' && styles.roleButtonActive]}
              onPress={() => setRole('SPOTTER')}
            >
              <Text style={[styles.roleText, role === 'SPOTTER' && styles.roleTextActive]}>Spot Owner</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.inputSection}>
            <View style={styles.inputWrapper}>
              <Text style={BlueprintTheme.inputLabel}>Full Name</Text>
              <TextInput
                style={BlueprintTheme.input}
                placeholder="Alex Johnson"
                placeholderTextColor="rgba(255,255,255,0.2)"
                value={name}
                onChangeText={setName}
              />
            </View>
            <View style={styles.inputWrapper}>
              <Text style={BlueprintTheme.inputLabel}>Email Address (Gmail)</Text>
              <TextInput
                style={BlueprintTheme.input}
                placeholder="alexj@gmail.com"
                placeholderTextColor="rgba(255,255,255,0.2)"
                autoCapitalize="none"
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
              />
            </View>
            <View style={styles.inputWrapper}>
              <Text style={BlueprintTheme.inputLabel}>Phone Number</Text>
              <TextInput
                style={BlueprintTheme.input}
                placeholder="9876543210"
                placeholderTextColor="rgba(255,255,255,0.2)"
                keyboardType="phone-pad"
                value={phone}
                onChangeText={setPhone}
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
            <TouchableOpacity style={BlueprintTheme.buttonPrimary} onPress={handleRegister} disabled={loading}>
              {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={BlueprintTheme.buttonPrimaryText}>Sign Up</Text>}
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.googleBtn, { backgroundColor: '#FFFFFF' }]} 
              onPress={() => handleSocialLogin('google')}
              disabled={loading}
            >
              <Text style={[styles.googleBtnText, { color: '#000000' }]}>Continue with Google</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={() => router.replace('/login')} style={styles.loginLink}>
              <Text style={styles.linkText}>Already have an account? <Text style={styles.linkBold}>Login</Text></Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* OTP VERIFICATION MODAL OVERLAY */}
      <Modal
        visible={otpModalVisible}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setOtpModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Verify Gmail Account</Text>
            <Text style={styles.modalSubtitle}>
              We sent a 6-digit OTP code to {email}. Enter it below to verify.
            </Text>

            <TextInput
              style={[BlueprintTheme.input, styles.otpInput]}
              placeholder="123456"
              placeholderTextColor="rgba(255,255,255,0.2)"
              keyboardType="number-pad"
              maxLength={6}
              value={otpCode}
              onChangeText={setOtpCode}
            />

            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonCancel]}
                onPress={() => setOtpModalVisible(false)}
              >
                <Text style={styles.modalButtonCancelText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.modalButton, styles.modalButtonVerify]}
                onPress={handleVerifyOTP}
                disabled={otpLoading}
              >
                {otpLoading ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.modalButtonVerifyText}>Verify & Sign Up</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scrollContent: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  header: { alignItems: 'center', marginBottom: 48 },
  logoText: { fontSize: 32, fontWeight: '900', color: '#FFFFFF', letterSpacing: -1 },
  titleSection: { marginBottom: 32 },
  mainTitle: { fontSize: 32, fontWeight: '800', color: '#FFFFFF', marginBottom: 8 },
  subtitle: { fontSize: 16, color: BlueprintColors.textSecondary },
  roleContainer: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 16,
    padding: 4,
    marginBottom: 32,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  roleButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  roleButtonActive: {
    backgroundColor: BlueprintColors.primaryAccent,
  },
  roleText: { color: BlueprintColors.textSecondary, fontSize: 14, fontWeight: '600' },
  roleTextActive: { color: '#FFFFFF', fontWeight: '800' },
  inputSection: { gap: 12, marginBottom: 32 },
  inputWrapper: { gap: 4 },
  footer: { gap: 16 },
  loginLink: { marginTop: 16, alignItems: 'center' },
  linkText: { color: BlueprintColors.textSecondary, fontSize: 14 },
  linkBold: { color: BlueprintColors.primaryAccent, fontWeight: '700' },
  googleBtn: { 
    backgroundColor: 'rgba(255,255,255,0.05)', 
    paddingVertical: 18, 
    borderRadius: 16, 
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)'
  },
  googleBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
  // OTP Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    backgroundColor: '#1E293B',
    borderRadius: 24,
    padding: 24,
    width: '100%',
    maxWidth: 400,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    gap: 16,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  modalSubtitle: {
    fontSize: 14,
    color: BlueprintColors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  otpInput: {
    textAlign: 'center',
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 8,
    paddingVertical: 12,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  modalButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalButtonCancel: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  modalButtonCancelText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  modalButtonVerify: {
    backgroundColor: BlueprintColors.primaryAccent,
  },
  modalButtonVerifyText: {
    color: '#FFFFFF',
    fontWeight: '700',
  },
});
