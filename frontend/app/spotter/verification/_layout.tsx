import { Stack } from 'expo-router';
import { SC } from '../../../constants/SpotterTheme';

export default function VerificationLayout() {
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
