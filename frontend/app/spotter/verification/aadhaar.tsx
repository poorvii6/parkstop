/**
 * Step 1 — Aadhaar through DigiLocker.
 * The owner signs in to DigiLocker (government site) and allows sharing.
 * We never see or type the Aadhaar number in our app.
 */
import React, { useRef, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';
import { ownerVerification, errorText, errorCode } from '../../../api/ownerVerification';
import { StepScreen, PrimaryButton, ErrorNote, InfoNote, vs } from '../../../components/spotter/VerifyUI';

export default function AadhaarStep() {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const [returnUrl, setReturnUrl] = useState('');
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const finished = useRef(false);

  const start = async () => {
    setStarting(true);
    setError('');
    finished.current = false;
    try {
      const out = await ownerVerification.startAadhaar();
      setReturnUrl(out.return_url);
      setUrl(out.url);
    } catch (e) {
      setError(errorText(e, 'Could not open DigiLocker.'));
    } finally {
      setStarting(false);
    }
  };

  const complete = async () => {
    if (finished.current) return;
    finished.current = true;
    setUrl(null);
    setChecking(true);
    setError('');
    try {
      await ownerVerification.completeAadhaar();
      router.back();
    } catch (e) {
      finished.current = false;
      const code = errorCode(e);
      setError(code === 'PENDING' ? errorText(e) + ' Then tap "Continue to DigiLocker" again if needed.' : errorText(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <StepScreen
      title="Aadhaar"
      subtitle="Verify your identity with DigiLocker, the Government of India's document app."
      footer={<PrimaryButton label={checking ? 'Checking…' : 'Continue to DigiLocker'} onPress={start} loading={starting || checking} />}
    >
      <View style={[vs.card, { marginTop: 12 }]}>
        <Bullet n="1" text="Sign in with your Aadhaar number or Aadhaar-linked mobile number." />
        <Bullet n="2" text="Enter the OTP sent to your Aadhaar-linked mobile." />
        <Bullet n="3" text="Tap Allow to share your Aadhaar with ParkStop." />
      </View>
      <InfoNote text="ParkStop never sees your full Aadhaar number. We keep your name, date of birth and the last 4 digits only." />
      <InfoNote icon="time-outline" text="The DigiLocker link works for 10 minutes. If it expires, just start again." />
      <ErrorNote text={error} />

      <Modal visible={!!url} animationType="slide" onRequestClose={() => setUrl(null)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }} edges={['top', 'bottom']}>
          <View style={st.bar}>
            <TouchableOpacity onPress={() => setUrl(null)} hitSlop={12}>
              <Ionicons name="close" size={26} color="#111" />
            </TouchableOpacity>
            <Text style={st.barTitle}>DigiLocker</Text>
            <TouchableOpacity onPress={complete} hitSlop={12}>
              <Text style={st.done}>I'm done</Text>
            </TouchableOpacity>
          </View>
          {url ? (
            <WebView
              source={{ uri: url }}
              startInLoadingState
              renderLoading={() => <ActivityIndicator style={{ marginTop: 40 }} color={SC.accent} size="large" />}
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              onShouldStartLoadWithRequest={(req) => {
                if (returnUrl && req.url.startsWith(returnUrl)) { complete(); return false; }
                return true;
              }}
              onNavigationStateChange={(nav) => {
                if (returnUrl && nav.url.startsWith(returnUrl)) complete();
              }}
            />
          ) : null}
        </SafeAreaView>
      </Modal>
    </StepScreen>
  );
}

function Bullet({ n, text }: { n: string; text: string }) {
  return (
    <View style={vs.bullet}>
      <View style={st.num}><Text style={st.numText}>{n}</Text></View>
      <Text style={vs.bulletText}>{text}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee' },
  barTitle: { fontSize: 16, fontWeight: '800', color: '#111' },
  done: { fontSize: 15, fontWeight: '800', color: SC.accent },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: SC.accentSoft, alignItems: 'center', justifyContent: 'center' },
  numText: { color: SC.accent, fontWeight: '800', fontSize: 13 },
});
