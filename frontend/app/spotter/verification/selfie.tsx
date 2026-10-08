/**
 * Step 3 — Live selfie. Checked for a real, live face and matched against the
 * Aadhaar photo. The photo is not stored.
 */
import React, { useState } from 'react';
import { View, Image, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';
import { ownerVerification, errorText, errorCode } from '../../../api/ownerVerification';
import { StepScreen, PrimaryButton, ErrorNote, InfoNote, vs } from '../../../components/spotter/VerifyUI';

export default function SelfieStep() {
  const router = useRouter();
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [redoAadhaar, setRedoAadhaar] = useState(false);

  const take = async () => {
    setError('');
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError('Camera permission is needed for the selfie.');
      if (!perm.canAskAgain) Linking.openSettings().catch(() => {});
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      cameraType: ImagePicker.CameraType.front,
      quality: 0.7,
      allowsEditing: false,
      exif: false,
    });
    if (!res.canceled && res.assets?.[0]?.uri) setPhoto(res.assets[0].uri);
  };

  const submit = async () => {
    if (!photo) return;
    setBusy(true);
    setError('');
    setRedoAadhaar(false);
    try {
      await ownerVerification.verifySelfie(photo);
      router.back();
    } catch (e) {
      setError(errorText(e, 'Could not check your selfie.'));
      if (errorCode(e) === 'REDO_AADHAAR') setRedoAadhaar(true);
      setPhoto(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScreen
      title="Live selfie"
      subtitle="Take a selfie so we can confirm it's really you."
      footer={
        photo
          ? <PrimaryButton label="Use this photo" onPress={submit} loading={busy} />
          : <PrimaryButton label="Open camera" onPress={take} />
      }
    >
      <View style={st.frame}>
        {photo ? (
          <Image source={{ uri: photo }} style={st.photo} />
        ) : (
          <View style={st.placeholder}>
            <Ionicons name="person-circle-outline" size={96} color={SC.textMuted} />
          </View>
        )}
      </View>
      {photo && !busy ? (
        <TouchableOpacity onPress={take} style={{ alignSelf: 'center', marginTop: 12 }}>
          <Text style={{ color: SC.accent, fontWeight: '700' }}>Retake</Text>
        </TouchableOpacity>
      ) : null}

      <View style={[vs.card, { marginTop: 18 }]}>
        <Tip text="Face the camera, in good light." />
        <Tip text="Remove glasses, mask or cap." />
        <Tip text="Only you in the photo." />
      </View>
      <ErrorNote text={error} />
      {redoAadhaar ? (
        <PrimaryButton label="Redo Aadhaar step" onPress={() => router.replace('/spotter/verification/aadhaar' as any)} />
      ) : null}
      <InfoNote text="Your selfie is only used for this check and is not saved." />
    </StepScreen>
  );
}

function Tip({ text }: { text: string }) {
  return (
    <View style={vs.bullet}>
      <Ionicons name="checkmark-circle" size={18} color={SC.success} />
      <Text style={vs.bulletText}>{text}</Text>
    </View>
  );
}

const st = StyleSheet.create({
  frame: { alignSelf: 'center', width: 220, height: 220, borderRadius: 110, overflow: 'hidden', borderWidth: 3, borderColor: SC.accent, marginTop: 16, backgroundColor: SC.bgCard },
  photo: { width: '100%', height: '100%', transform: [{ scaleX: -1 }] },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
