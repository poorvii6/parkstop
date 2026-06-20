import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, Platform, KeyboardAvoidingView, ScrollView } from 'react-native';
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

  const handleLogin = async () => {
    if (!email || !password) return Alert.alert('Hold up!', 'Please enter your email and password');
    setLoading(true);

    try {
      console.log(`[AUTH] Attempting login to: ${apiClient.defaults.baseURL}/auth/login`);
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
              onPress={() => Alert.alert('Coming Soon', 'Google sign-in is not yet implemented.')}
            >
              <Text style={[styles.googleBtnText, { color: '#000000' }]}>Continue with Google</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.googleBtn, { backgroundColor: '#000000', borderColor: '#FFFFFF', marginTop: 12 }]} 
              onPress={() => Alert.alert('Coming Soon', 'Apple sign-in is not yet implemented.')}
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
