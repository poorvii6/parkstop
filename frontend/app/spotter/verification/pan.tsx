/** Step 2 — PAN. Must be a personal PAN in the same name as Aadhaar. */
import React, { useState } from 'react';
import { TextInput, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';
import { ownerVerification, errorText } from '../../../api/ownerVerification';
import { StepScreen, PrimaryButton, ErrorNote, InfoNote, vs } from '../../../components/spotter/VerifyUI';

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export default function PanStep() {
  const router = useRouter();
  const [pan, setPan] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = PAN_RE.test(pan);

  const submit = async () => {
    if (!valid) { setError('Please enter a valid PAN, like ABCDE1234F.'); return; }
    setBusy(true);
    setError('');
    try {
      await ownerVerification.verifyPan(pan);
      router.back();
    } catch (e) {
      setError(errorText(e, 'Could not verify your PAN.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScreen
      title="PAN card"
      subtitle="Enter your personal PAN. The name on it must match your Aadhaar."
      footer={<PrimaryButton label="Verify PAN" onPress={submit} loading={busy} disabled={!valid} />}
    >
      <Text style={vs.label}>PAN number</Text>
      <TextInput
        style={[vs.input, { letterSpacing: 3 }]}
        value={pan}
        onChangeText={(t) => { setPan(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)); setError(''); }}
        placeholder="ABCDE1234F"
        placeholderTextColor={SC.textDisabled}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={10}
      />
      <ErrorNote text={error} />
      <InfoNote text="We check your PAN with Income Tax records and keep only a masked copy (like AB••••••4F)." />
    </StepScreen>
  );
}
