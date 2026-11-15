/**
 * Picking a property document: a PDF, or a photo of one.
 *
 * PDF FIRST, and deliberately. A khata certificate, encumbrance certificate or
 * BBMP tax receipt is downloaded from the Karnataka portals as a PDF. While the
 * app could only take photos, every honest owner had to screenshot one — and a
 * screenshot is different bytes every time, so the server's duplicate-document
 * check matched nothing and was defeated by the ordinary path rather than by
 * anyone attacking it. A PDF is also far easier for a reviewer to read a name
 * off than a photograph of a screen.
 *
 * The preview is the one place this has to think about format: React Native's
 * <Image> cannot render a PDF, so a chosen PDF shows as a named file card and
 * a chosen photo shows as the photo.
 */
import React, { useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { SC } from '../../constants/SpotterTheme';
import type { PickedDoc } from '../../api/spotVerification';

const IMAGE_MIME = /^image\/(jpe?g|png|webp)$/;

/** What the server accepts. Kept in step with DOC_MIME in the upload route. */
const ACCEPTED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

export const isPdf = (f: PickedDoc | null) => !!f && f.mimeType === 'application/pdf';

export default function DocumentPickerField({
  value,
  onChange,
  onError,
  disabled,
}: {
  value: PickedDoc | null;
  onChange: (f: PickedDoc | null) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const pickFile = async () => {
    setBusy(true);
    try {
      const res = await DocPicker.getDocumentAsync({ type: ACCEPTED, copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;

      const a = res.assets[0];
      const mimeType = a.mimeType || (a.name?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '');
      if (!ACCEPTED.includes(mimeType)) {
        onError('Please choose a PDF, or a JPG, PNG or WebP photo.');
        return;
      }
      onChange({ uri: a.uri, name: a.name || 'document.pdf', mimeType });
    } catch {
      onError('Could not open that file. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const pickImage = async (source: 'camera' | 'library') => {
    const perm = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      onError(source === 'camera' ? 'Camera permission is needed.' : 'Photo access is needed.');
      if (!perm.canAskAgain) Linking.openSettings().catch(() => {});
      return;
    }

    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, allowsEditing: false };
    const res = source === 'camera'
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets?.[0]) return;

    const a = res.assets[0];
    const mimeType = a.mimeType && IMAGE_MIME.test(a.mimeType) ? a.mimeType : 'image/jpeg';
    onChange({
      uri: a.uri,
      name: a.fileName || `document.${mimeType.split('/')[1]}`,
      mimeType,
    });
  };

  if (value) {
    return (
      <View>
        {isPdf(value) ? (
          <View style={s.pdfCard}>
            <Ionicons name="document-text" size={30} color={SC.accent} />
            <View style={{ flex: 1 }}>
              <Text style={s.pdfName} numberOfLines={2}>{value.name}</Text>
              <Text style={s.pdfHint}>PDF · ready to upload</Text>
            </View>
          </View>
        ) : (
          <Image source={{ uri: value.uri }} style={s.preview} resizeMode="cover" />
        )}
        {!disabled ? (
          <TouchableOpacity onPress={() => onChange(null)} style={{ alignSelf: 'center', marginTop: 10 }}>
            <Text style={s.change}>Choose a different file</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {/* First, because it is what owners actually have. */}
      <TouchableOpacity style={s.pdfBtn} onPress={pickFile} disabled={disabled || busy}>
        <Ionicons name="document-attach" size={22} color="#fff" />
        <Text style={s.pdfBtnText}>{busy ? 'Opening…' : 'Choose a PDF or file'}</Text>
      </TouchableOpacity>
      <Text style={s.or}>or take a photo of the document</Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TouchableOpacity style={s.pickBtn} onPress={() => pickImage('camera')} disabled={disabled}>
          <Ionicons name="camera" size={22} color={SC.textPrimary} />
          <Text style={s.pickText}>Camera</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.pickBtn} onPress={() => pickImage('library')} disabled={disabled}>
          <Ionicons name="images" size={22} color={SC.textPrimary} />
          <Text style={s.pickText}>Gallery</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  preview: { width: '100%', height: 220, borderRadius: 16, backgroundColor: SC.bgCard },
  pdfCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: SC.bgCard, borderRadius: 16, borderWidth: 1, borderColor: SC.border, padding: 16,
  },
  pdfName: { color: SC.textPrimary, fontSize: 15, fontWeight: '700' },
  pdfHint: { color: SC.textSecondary, fontSize: 12, marginTop: 3 },
  change: { color: SC.accent, fontWeight: '700' },
  pdfBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: SC.accent, borderRadius: 16, paddingVertical: 16,
  },
  pdfBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  or: { color: SC.textSecondary, fontSize: 12, textAlign: 'center' },
  pickBtn: {
    flex: 1, alignItems: 'center', gap: 6, paddingVertical: 18, borderRadius: 16,
    backgroundColor: SC.bgCard, borderWidth: 1, borderColor: SC.border, borderStyle: 'dashed',
  },
  pickText: { color: SC.textPrimary, fontWeight: '700', fontSize: 13 },
});
