/**
 * Step 4 — Bank account. Checked with the bank, must be in the owner's own
 * name. This becomes the account ParkStop pays earnings into.
 */
import React, { useState } from 'react';
import { TextInput, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';
import { ownerVerification, errorText } from '../../../api/ownerVerification';
import { StepScreen, PrimaryButton, ErrorNote, InfoNote, vs } from '../../../components/spotter/VerifyUI';

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export default function BankStep() {
  const router = useRouter();
  const [account, setAccount] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ifsc, setIfsc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mismatch = confirm.length > 0 && confirm !== account;
  const ready = account.length >= 6 && confirm === account && IFSC_RE.test(ifsc);

  const submit = async () => {
    if (!ready) { setError(mismatch ? 'The account numbers do not match.' : 'Please fill in all fields correctly.'); return; }
    setBusy(true);
    setError('');
    try {
      await ownerVerification.verifyBank(account, ifsc);
      router.back();
    } catch (e) {
      setError(errorText(e, 'Could not verify this account.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScreen
      title="Bank account"
      subtitle="Your earnings are paid into this account. It must be in your own name."
      footer={<PrimaryButton label="Verify account" onPress={submit} loading={busy} disabled={!ready} />}
    >
      <Text style={vs.label}>Account number</Text>
      <TextInput
        style={vs.input}
        value={account}
        onChangeText={(t) => { setAccount(t.replace(/[^0-9A-Za-z]/g, '')); setError(''); }}
        keyboardType="number-pad"
        secureTextEntry
        placeholder="Account number"
        placeholderTextColor={SC.textDisabled}
        maxLength={20}
      />
      <Text style={vs.label}>Confirm account number</Text>
      <TextInput
        style={[vs.input, mismatch && { borderColor: SC.error }]}
        value={confirm}
        onChangeText={(t) => { setConfirm(t.replace(/[^0-9A-Za-z]/g, '')); setError(''); }}
        keyboardType="number-pad"
        placeholder="Type it again"
        placeholderTextColor={SC.textDisabled}
        maxLength={20}
      />
      <Text style={vs.label}>IFSC code</Text>
      <TextInput
        style={[vs.input, { letterSpacing: 2 }]}
        value={ifsc}
        onChangeText={(t) => { setIfsc(t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 11)); setError(''); }}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="SBIN0001234"
        placeholderTextColor={SC.textDisabled}
        maxLength={11}
      />
      <ErrorNote text={error} />
      <InfoNote text="We confirm the account and the holder's name with your bank. You may get ₹1 from us as part of this check — no money is taken from you." />
    </StepScreen>
  );
}
