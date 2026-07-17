import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StripeProvider } from '../components/StripeImports';
import { useEffect } from 'react';

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    // Auth checking is basically handled elsewhere, leaving layout strictly presentation
  }, [segments]);

  return (
    <StripeProvider publishableKey={process.env.EXPO_PUBLIC_STRIPE_KEY || ''}>
      <Stack screenOptions={{ freezeOnBlur: true }}>
        {/* 1. Entry point — splash / auth check */}
        <Stack.Screen name="index" options={{ headerShown: false }} />

        {/* 2. Onboarding — terms of service */}
        <Stack.Screen name="welcome" options={{ headerShown: false, animation: 'fade' }} />

        {/* 3. Auth — login and register */}
        <Stack.Screen name="login" options={{ headerShown: false, animation: 'fade' }} />
        <Stack.Screen name="register" options={{ headerShown: false, animation: 'slide_from_right' }} />

        {/* 4. Role selection — dual-role users */}
        <Stack.Screen name="role-selection" options={{ headerShown: false, animation: 'fade' }} />

        {/* 5. Main dashboards */}
        <Stack.Screen name="finder/index" options={{ headerShown: false }} />
        <Stack.Screen name="spotter" options={{ headerShown: false }} />
        <Stack.Screen name="admin/index" options={{ headerShown: false }} />

        {/* 6. Overlays */}
        <Stack.Screen name="payments" options={{ headerShown: false, animation: 'slide_from_right' }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal', headerShown: false }} />
      </Stack>
      <StatusBar style="light" />
    </StripeProvider>
  );
}
