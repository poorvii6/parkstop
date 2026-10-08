/**
 * Payout setup now happens in Owner Verification → Bank account, where the
 * account is checked with the bank and matched to the owner's Aadhaar name.
 * (The old screen used Cashfree vendor onboarding, which is not available to
 * ParkStop.) Any old link to this screen forwards there.
 */
import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { SC } from '../../constants/SpotterTheme';

export default function PayoutSetupRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/spotter/verification' as any); }, []);
  return (
    <View style={{ flex: 1, backgroundColor: SC.bg, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={SC.accent} />
    </View>
  );
}
