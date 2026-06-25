import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Platform, KeyboardAvoidingView, ScrollView, Modal } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiClient from '../api/client';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Social Auth States
  const [oauthProvider, setOauthProvider] = useState<'google' | 'apple' | null>(null);
  const [customOauthEmail, setCustomOauthEmail] = useState('');
  const [customOauthName, setCustomOauthName] = useState('');
  const [oauthLoading, setOauthLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) return Alert.alert('Hold up!', 'Please enter your email and password');
    setLoading(true);

    try {
      console.log(`[AUTH] Attempting login for email: ${email}`);
      const response = await apiClient.post('/auth/login', { email, password });
      if (response.data.success) {
        await AsyncStorage.setItem('access_token', response.data.data.access_token);
        await AsyncStorage.setItem('user_role', response.data.data.user.role);
        router.replace('/welcome');
      }
    } catch (error: any) {
      console.error('[AUTH] Login Error:', error.response?.data || error.message);
      const msg = error.response?.data?.message || (error.response?.data?.errors ? 'Invalid email or password' : null) || error.message || 'Network error';
      if (Platform.OS === 'web') alert('Login Failed: ' + msg);
      else Alert.alert('Login Failed', msg);
    } finally {
      setLoading(false);
    }
  };

  const handleSocialLogin = async (selectedEmail: string, selectedName: string) => {
    if (!selectedEmail) return Alert.alert('Error', 'Please enter a valid email address');
    if (!selectedEmail.includes('@')) return Alert.alert('Error', 'Please enter a valid email address');
    
    setOauthLoading(true);
    try {
      console.log(`[SOCIAL AUTH] Connecting to backend for email: ${selectedEmail}, provider: ${oauthProvider}`);
      const response = await apiClient.post('/auth/social-login', {
        email: selectedEmail,
        name: selectedName || selectedEmail.split('@')[0],
        provider: oauthProvider,
        token: 'mock_oauth_token_' + Date.now()
      });

      if (response.data.success) {
        await AsyncStorage.setItem('access_token', response.data.data.access_token);
        await AsyncStorage.setItem('user_role', response.data.data.user.role);
        setOauthProvider(null);
        setCustomOauthEmail('');
        setCustomOauthName('');
        router.replace('/welcome');
      }
    } catch (error: any) {
      console.error('[SOCIAL AUTH] Social Login Error:', error.response?.data || error.message);
      const msg = error.response?.data?.message || error.message || 'Connection failed';
      Alert.alert('Authentication Failed', msg);
    } finally {
      setOauthLoading(false);
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
              {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={BlueprintTheme.buttonPrimaryText}>Sign In</Text>}
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.googleBtn, { backgroundColor: '#FFFFFF' }]} 
              onPress={() => setOauthProvider('google')}
            >
              <Text style={[styles.googleBtnText, { color: '#000000' }]}>Continue with Google</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.googleBtn, { backgroundColor: '#000000', borderColor: '#FFFFFF', marginTop: 12 }]} 
              onPress={() => setOauthProvider('apple')}
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
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Simulated OAuth Modal */}
      <Modal
        visible={oauthProvider !== null}
        transparent={true}
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setOauthProvider(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.oauthContainer}>
            <View style={styles.oauthHeader}>
              <Text style={styles.oauthHeaderTitle}>
                {oauthProvider === 'google' ? '🌐 Sign in with Google' : ' Sign in with Apple'}
              </Text>
              <Text style={styles.oauthHeaderSubtitle}>
                {oauthProvider === 'google' 
                  ? 'ParkStop wants to use "google.com" to sign in' 
                  : 'ParkStop wants to authenticate using your Apple ID'}
              </Text>
            </View>

            {oauthLoading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#6366f1" />
                <Text style={{ color: '#94a3b8', marginTop: 12, fontWeight: '600' }}>Authenticating...</Text>
              </View>
            ) : (
              <ScrollView bounces={false} showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
                <Text style={styles.oauthSectionTitle}>Choose a test account</Text>
                
                {/* Profile Options */}
                <TouchableOpacity 
                  style={styles.oauthProfileBtn}
                  onPress={() => handleSocialLogin(
                    oauthProvider === 'google' ? 'alex.jones@gmail.com' : 'alex.jones@icloud.com',
                    'Alex Jones'
                  )}
                >
                  <View style={styles.oauthAvatar}>
                    <Text style={styles.oauthAvatarText}>AJ</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.oauthProfileName}>Alex Jones</Text>
                    <Text style={styles.oauthProfileEmail}>
                      {oauthProvider === 'google' ? 'alex.jones@gmail.com' : 'alex.jones@icloud.com'}
                    </Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={styles.oauthProfileBtn}
                  onPress={() => handleSocialLogin(
                    oauthProvider === 'google' ? 'sarah.parker@gmail.com' : 'sarah.parker@icloud.com',
                    'Sarah Parker'
                  )}
                >
                  <View style={[styles.oauthAvatar, { backgroundColor: '#10b981' }]}>
                    <Text style={styles.oauthAvatarText}>SP</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.oauthProfileName}>Sarah Parker</Text>
                    <Text style={styles.oauthProfileEmail}>
                      {oauthProvider === 'google' ? 'sarah.parker@gmail.com' : 'sarah.parker@icloud.com'}
                    </Text>
                  </View>
                </TouchableOpacity>

                <View style={styles.dividerRow}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>OR TYPE MANUAL EMAIL</Text>
                  <View style={styles.dividerLine} />
                </View>

                {/* Custom Inputs */}
                <View style={{ gap: 10 }}>
                  <TextInput
                    style={styles.oauthInput}
                    placeholder="Full Name"
                    placeholderTextColor="rgba(255,255,255,0.25)"
                    value={customOauthName}
                    onChangeText={setCustomOauthName}
                  />
                  <TextInput
                    style={styles.oauthInput}
                    placeholder="email@example.com"
                    placeholderTextColor="rgba(255,255,255,0.25)"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    value={customOauthEmail}
                    onChangeText={setCustomOauthEmail}
                  />
                  <TouchableOpacity 
                    style={styles.oauthSubmitBtn}
                    onPress={() => handleSocialLogin(customOauthEmail, customOauthName)}
                  >
                    <Text style={styles.oauthSubmitBtnText}>Continue with custom email</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity 
                  style={styles.oauthCancelBtn}
                  onPress={() => {
                    setOauthProvider(null);
                    setCustomOauthEmail('');
                    setCustomOauthName('');
                  }}
                >
                  <Text style={styles.oauthCancelBtnText}>Cancel</Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
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
  linkBold: { color: BlueprintColors.primaryAccent, fontWeight: '700' },
  
  // OAuth Modal styling
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  oauthContainer: {
    backgroundColor: '#0f172a',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 24,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  oauthHeader: {
    alignItems: 'center',
    marginBottom: 24,
  },
  oauthHeaderTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -0.5,
  },
  oauthHeaderSubtitle: {
    fontSize: 13,
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 6,
    fontWeight: '500',
  },
  oauthSectionTitle: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 4,
  },
  oauthProfileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 16,
    padding: 14,
    gap: 14,
  },
  oauthAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#6366f1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  oauthAvatarText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
  },
  oauthProfileName: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15,
  },
  oauthProfileEmail: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
    fontWeight: '500',
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 10,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  dividerText: {
    color: '#64748b',
    fontSize: 9,
    fontWeight: '800',
    marginHorizontal: 12,
  },
  oauthInput: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  oauthSubmitBtn: {
    backgroundColor: '#6366f1',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 6,
  },
  oauthSubmitBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 15,
  },
  oauthCancelBtn: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  oauthCancelBtnText: {
    color: '#94a3b8',
    fontWeight: '800',
    fontSize: 15,
  },
});
