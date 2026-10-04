/**
 * LoginOtpModal.tsx — the "enter the 6-digit code" step after sign-in.
 *
 * The server's /auth/social-login replies with { requires_otp, pending_login_token }
 * and emails a code. This modal collects the code and calls
 * /auth/login/verify-otp. The user cannot get past it: closing it signs them
 * out of Firebase.
 */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import apiClient from '../api/client';
import { BlueprintColors } from '../constants/BlueprintTheme';
import { getAuthErrorMessage } from '../utils/authErrors';

type Props = {
  visible: boolean;
  email: string;
  pendingToken: string;
  /** Ask the server for a new code. Must return the NEW pending token, or null on failure. */
  onResend: () => Promise<string | null>;
  /** Server accepted the code. */
  onVerified: (user: any) => void;
  /** User gave up. The caller must sign them out. */
  onCancel: () => void;
};

export default function LoginOtpModal({ visible, email, pendingToken, onResend, onVerified, onCancel }: Props) {
  const [code, setCode] = useState('');
  const [token, setToken] = useState(pendingToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resendIn, setResendIn] = useState(60);
  const [resending, setResending] = useState(false);

  // Fresh state every time the modal opens.
  useEffect(() => {
    if (visible) {
      setCode('');
      setError('');
      setToken(pendingToken);
      setResendIn(60);
    }
  }, [visible, pendingToken]);

  useEffect(() => {
    if (!visible || resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [visible, resendIn]);

  const verify = async () => {
    if (code.length !== 6 || busy) {
      if (code.length !== 6) setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await apiClient.post('/auth/login/verify-otp', {
        email: email.toLowerCase(),
        code,
        pending_login_token: token,
      });
      if (res.data?.success) {
        onVerified(res.data.data?.user);
      } else {
        setError(res.data?.message || 'Invalid code. Please try again.');
      }
    } catch (err: any) {
      const serverMsg = err?.response?.data?.message;
      setError(serverMsg || getAuthErrorMessage(err).message);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (resendIn > 0 || resending) return;
    setResending(true);
    setError('');
    try {
      const newToken = await onResend();
      if (newToken) {
        setToken(newToken);
        setCode('');
        setResendIn(60);
      } else {
        setError('Could not send a new code. Please try again.');
      }
    } finally {
      setResending(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Verify it's you</Text>
          <Text style={styles.body}>
            We sent a 6-digit code to{'\n'}
            <Text style={styles.email}>{email}</Text>
          </Text>

          <TextInput
            style={styles.input}
            value={code}
            onChangeText={(t) => { setCode(t.replace(/\D/g, '').slice(0, 6)); setError(''); }}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="••••••"
            placeholderTextColor="rgba(255,255,255,0.25)"
            autoFocus
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
          />

          {!!error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity style={[styles.primary, (busy || code.length !== 6) && { opacity: 0.6 }]} onPress={verify} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Verify & Continue</Text>}
          </TouchableOpacity>

          <TouchableOpacity onPress={resend} disabled={resendIn > 0 || resending} style={styles.linkBtn}>
            <Text style={[styles.link, (resendIn > 0 || resending) && { color: BlueprintColors.textSecondary }]}>
              {resending ? 'Sending…' : resendIn > 0 ? `Resend code in ${resendIn}s` : 'Resend code'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={onCancel} disabled={busy} style={styles.linkBtn}>
            <Text style={styles.cancel}>Cancel and sign out</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: '#14141F', borderRadius: 24, padding: 24, borderWidth: 1, borderColor: BlueprintColors.border },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 8, textAlign: 'center' },
  body: { color: BlueprintColors.textSecondary, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  email: { color: '#fff', fontWeight: '700' },
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 14, borderWidth: 1, borderColor: BlueprintColors.border,
    color: '#fff', fontSize: 26, fontWeight: '800', letterSpacing: 10, textAlign: 'center', paddingVertical: 14,
  },
  error: { color: '#F87171', fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 10 },
  primary: { backgroundColor: BlueprintColors.primaryAccent, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 18 },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  linkBtn: { alignItems: 'center', paddingVertical: 10 },
  link: { color: BlueprintColors.primaryAccent, fontWeight: '700', fontSize: 14 },
  cancel: { color: BlueprintColors.textSecondary, fontWeight: '600', fontSize: 13 },
});
