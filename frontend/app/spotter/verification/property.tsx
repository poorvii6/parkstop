/**
 * Step 5 — Property proof. A photo of a bill, tax receipt or rent agreement
 * for the parking address. Stored privately and checked by the ParkStop team.
 */
import React, { useState } from 'react';
import { View, Text, TextInput, Image, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';
import { ownerVerification, errorText, DOC_TYPES } from '../../../api/ownerVerification';
import { StepScreen, PrimaryButton, ErrorNote, InfoNote, vs } from '../../../components/spotter/VerifyUI';

export default function PropertyStep() {
  const router = useRouter();
  const [docType, setDocType] = useState('');
  const [address, setAddress] = useState('');
  const [image, setImage] = useState<{ uri: string; mimeType?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async (source: 'camera' | 'library') => {
    setError('');
    const perm = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setError(source === 'camera' ? 'Camera permission is needed.' : 'Photo access is needed.');
      if (!perm.canAskAgain) Linking.openSettings().catch(() => {});
      return;
    }
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, allowsEditing: false };
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (!res.canceled && res.assets?.[0]) setImage({ uri: res.assets[0].uri, mimeType: res.assets[0].mimeType });
  };

  const ready = !!docType && address.trim().length >= 10 && !!image;

  const submit = async () => {
    if (!ready || !image) { setError('Please choose a document type, enter the address and add a photo.'); return; }
    setBusy(true);
    setError('');
    try {
      await ownerVerification.uploadProperty(image.uri, image.mimeType, docType, address.trim());
      router.back();
    } catch (e) {
      setError(errorText(e, 'Could not upload your document.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScreen
      title="Property proof"
      subtitle="Show that you own or rent the place where the parking is."
      footer={<PrimaryButton label="Upload document" onPress={submit} loading={busy} disabled={!ready} />}
    >
      <Text style={vs.label}>Document type</Text>
      <View style={st.chips}>
        {DOC_TYPES.map((d) => (
          <TouchableOpacity key={d.key} style={[st.chip, docType === d.key && st.chipOn]} onPress={() => setDocType(d.key)}>
            <Text style={[st.chipText, docType === d.key && { color: '#fff' }]}>{d.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={vs.label}>Parking address</Text>
      <TextInput
        style={[vs.input, { minHeight: 84, textAlignVertical: 'top', fontSize: 15 }]}
        value={address}
        onChangeText={(t) => { setAddress(t); setError(''); }}
        placeholder="House / building, street, area, city, PIN"
        placeholderTextColor={SC.textDisabled}
        multiline
        maxLength={300}
      />

      <Text style={vs.label}>Photo of the document</Text>
      {image ? (
        <View>
          <Image source={{ uri: image.uri }} style={st.preview} resizeMode="cover" />
          <TouchableOpacity onPress={() => setImage(null)} style={{ alignSelf: 'center', marginTop: 10 }}>
            <Text style={{ color: SC.accent, fontWeight: '700' }}>Change photo</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TouchableOpacity style={st.pickBtn} onPress={() => pick('camera')}>
            <Ionicons name="camera" size={22} color={SC.textPrimary} />
            <Text style={st.pickText}>Take photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={st.pickBtn} onPress={() => pick('library')}>
            <Ionicons name="images" size={22} color={SC.textPrimary} />
            <Text style={st.pickText}>From gallery</Text>
          </TouchableOpacity>
        </View>
      )}
      <ErrorNote text={error} />
      <InfoNote text="The name and address on the document should match you and your parking place. Only the ParkStop team can see it." />
    </StepScreen>
  );
}

const st = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: SC.bgCard, borderWidth: 1, borderColor: SC.border },
  chipOn: { backgroundColor: SC.accent, borderColor: SC.accent },
  chipText: { color: SC.textSecondary, fontWeight: '700', fontSize: 13 },
  preview: { width: '100%', height: 220, borderRadius: 16, backgroundColor: SC.bgCard },
  pickBtn: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: 20, borderRadius: 16, backgroundColor: SC.bgCard, borderWidth: 1, borderColor: SC.border, borderStyle: 'dashed' },
  pickText: { color: SC.textPrimary, fontWeight: '700', fontSize: 13 },
});
