/**
 * Small shared building blocks for the owner-verification screens, so every
 * step looks and behaves the same.
 */
import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SC } from '../../constants/SpotterTheme';

export function StepScreen({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  const router = useRouter();
  return (
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.back} hitSlop={12}>
          <Ionicons name="chevron-back" size={22} color={SC.textPrimary} />
        </TouchableOpacity>
        <Text style={s.headerTitle} numberOfLines={1}>{title}</Text>
        <View style={{ width: 36 }} />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
          {children}
        </ScrollView>
        {footer ? <View style={s.footer}>{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function PrimaryButton({ label, onPress, loading, disabled }: { label: string; onPress: () => void; loading?: boolean; disabled?: boolean }) {
  const off = disabled || loading;
  return (
    <TouchableOpacity style={[s.primary, off && { opacity: 0.5 }]} onPress={onPress} disabled={off} activeOpacity={0.85}>
      {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>{label}</Text>}
    </TouchableOpacity>
  );
}

export function ErrorNote({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <View style={s.error}>
      <Ionicons name="alert-circle" size={18} color={SC.error} />
      <Text style={s.errorText}>{text}</Text>
    </View>
  );
}

export function InfoNote({ icon = 'lock-closed', text }: { icon?: any; text: string }) {
  return (
    <View style={s.info}>
      <Ionicons name={icon} size={16} color={SC.textSecondary} />
      <Text style={s.infoText}>{text}</Text>
    </View>
  );
}

export const vs = StyleSheet.create({
  label: { color: SC.textSecondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8, marginTop: 18 },
  input: {
    backgroundColor: SC.bgElevated, borderRadius: 14, borderWidth: 1, borderColor: SC.border,
    color: SC.textPrimary, fontSize: 17, fontWeight: '600', paddingHorizontal: 16, paddingVertical: 14,
  },
  card: { backgroundColor: SC.bgCard, borderRadius: 18, borderWidth: 1, borderColor: SC.border, padding: 16 },
  bullet: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 10 },
  bulletText: { color: SC.textPrimary, fontSize: 14, lineHeight: 20, flex: 1 },
});

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: SC.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  back: { width: 36, height: 36, borderRadius: 18, backgroundColor: SC.bgCard, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: SC.textPrimary, fontSize: 17, fontWeight: '800', flex: 1, textAlign: 'center' },
  body: { padding: 20, paddingBottom: 40 },
  subtitle: { color: SC.textSecondary, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: SC.border, backgroundColor: SC.bg },
  primary: { backgroundColor: SC.accent, borderRadius: 16, paddingVertical: 16, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  error: { flexDirection: 'row', gap: 8, backgroundColor: SC.errorSoft, borderRadius: 12, padding: 12, marginTop: 16, alignItems: 'flex-start' },
  errorText: { color: '#FCA5A5', fontSize: 14, lineHeight: 20, flex: 1, fontWeight: '600' },
  info: { flexDirection: 'row', gap: 8, marginTop: 16, alignItems: 'flex-start' },
  infoText: { color: SC.textSecondary, fontSize: 13, lineHeight: 19, flex: 1 },
});
