/**
 * Per-SPOT verification, as a stack inside the spotter tabs.
 *
 * A sibling of `verification/`, which is per-PERSON (Aadhaar, PAN, selfie,
 * bank). The two are deliberately separate screens because they answer
 * different questions: that flow approves the owner once, this one is opened
 * per spot and an owner with four driveways comes here four times.
 *
 * Registered in the tabs layout with `href: null` so it never shows as a tab —
 * it is reached from the badge on the spots list.
 */
import { Stack } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';

export default function SpotVerificationLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: SC.bg },
        animation: 'slide_from_right',
      }}
    />
  );
}
