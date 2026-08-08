import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StripeProvider } from '../components/StripeImports';
import OfflineBanner from '../components/OfflineBanner';
import NotificationTapHandler from '../components/NotificationTapHandler';

export default function RootLayout() {
  return (
    <StripeProvider publishableKey={process.env.EXPO_PUBLIC_STRIPE_KEY || ''}>
      <Stack screenOptions={{ freezeOnBlur: true }}>
        {/* 1. Entry point — splash / auth check */}
        <Stack.Screen name="index" options={{ headerShown: false }} />

        {/* 2. Onboarding — first-launch 'how it works' walkthrough */}
        <Stack.Screen name="onboarding" options={{ headerShown: false, animation: 'fade' }} />

        {/* 3. Welcome — logo + tagline + Sign In / Create Account */}
        <Stack.Screen name="welcome" options={{ headerShown: false, animation: 'fade' }} />

        {/* 3. Auth — login and register */}
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="register" options={{ headerShown: false, animation: 'slide_from_right' }} />

        {/* 4. Terms of Service — readable modal, opened from the Register checkbox */}
        <Stack.Screen name="terms" options={{ presentation: 'modal', headerShown: false, animation: 'slide_from_bottom' }} />

        {/* 5. Role selection */}
        <Stack.Screen name="role-selection" options={{ headerShown: false, animation: 'fade' }} />

        {/* 6. Main dashboards */}
        <Stack.Screen name="finder/index" options={{ headerShown: false }} />
        <Stack.Screen name="spotter" options={{ headerShown: false }} />
        <Stack.Screen name="admin/index" options={{ headerShown: false }} />

        {/* 7. Overlays */}
        <Stack.Screen name="payments" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="notifications" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', headerShown: false }} />
      </Stack>
      <NotificationTapHandler />
      <OfflineBanner />
      <StatusBar style="light" />
    </StripeProvider>
  );
}
