import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import apiClient from '../api/client';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlueprintTheme, BlueprintColors } from '../constants/BlueprintTheme';

export default function RegisterScreen() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'finder' | 'spotter'>('finder');
  const [loading, setLoading] = useState(false);

  const router = useRouter();

  const handleRegister = async () => {
    // 1. Basic empty check
    if (!name || !email || !password || !phone) {
      return Alert.alert('Oops', 'Please fill out everything');
    }

    // 2. Email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return Alert.alert('Invalid Email', 'Please enter a valid email address (e.g. name@domain.com)');
    }

    setLoading(true);

    try {
      console.log(`[AUTH] Attempting register to: ${apiClient.defaults.baseURL}/auth/register`);
      const response = await apiClient.post('/auth/register', { name, email, phone, password, role });
      if (response.data.success) {
        if (Platform.OS === 'web') alert('Success! Your account has been created.');
        else Alert.alert('Success!', 'Your account has been created.');
        router.replace('/login');
      }
    } catch (error: any) {
      const errorData = error.response?.data;
      console.error('[AUTH] Register Error Response:', errorData || error.message);
      let msg = errorData?.message || error.message || 'Network error';
      
      // If there are specific validation errors, list them
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
              style={[styles.roleButton, role === 'finder' && styles.roleButtonActive]}
              onPress={() => setRole('finder')}
            >
              <Text style={[styles.roleText, role === 'finder' && styles.roleTextActive]}>I'm a Finder</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.roleButton, role === 'spotter' && styles.roleButtonActive]}
              onPress={() => setRole('spotter')}
            >
              <Text style={[styles.roleText, role === 'spotter' && styles.roleTextActive]}>I'm a Spotter</Text>
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
              <Text style={BlueprintTheme.inputLabel}>Phone Number</Text>
              <TextInput
                style={BlueprintTheme.input}
                placeholder="+1 234 567 890"
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

            <TouchableOpacity onPress={() => router.replace('/login')} style={styles.loginLink}>
              <Text style={styles.linkText}>Already have an account? <Text style={styles.linkBold}>Login</Text></Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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
  linkBold: { color: BlueprintColors.primaryAccent, fontWeight: '700' }
});
