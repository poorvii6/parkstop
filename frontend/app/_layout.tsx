import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationProvider, TaskRemovedBehavior } from '@googlemaps/react-native-navigation-sdk';
import { StripeProvider } from '../components/StripeImports';
import OfflineBanner from '../components/OfflineBanner';
import NotificationTapHandler from '../components/NotificationTapHandler';

export default function RootLayout() {
  return (
    /* Google Navigation SDK.
     *
     * Must wrap the whole app, not just the finder: the navigation session is
     * a singleton that outlives any one screen, and a rider who backgrounds the
     * app mid-trip must come back to a live session rather than a fresh one.
     *
     * CONTINUE_SERVICE keeps guidance running when the app is swiped out of
     * recents. For a parking app that is the safe default — someone riding to a
     * spot with the phone in a pocket must not lose directions because Android
     * tidied up the task list. */
    /* Required ancestor for useSafeAreaInsets(). Without it the hook returns
     * zeros with no warning, which is why the navigation banner sat under the
     * status bar despite being given insets. */
    <SafeAreaProvider>
    <NavigationProvider
      termsAndConditionsDialogOptions={{
        title: 'Navigation Terms',
        companyName: 'ParkStop',
        // Google requires their driver-awareness disclaimer before navigation
        // can start. showOnlyDisclaimer keeps it to that single notice rather
        // than a full terms wall, which is what a rider tapping "navigate"
        // expects to see.
        showOnlyDisclaimer: true,
        // EVERY colour must be set, not just the ones that looked important.
        //
        // Setting only backgroundColor and titleColor left the body text,
        // "Learn more" and the buttons at their defaults — which are dark, and
        // therefore invisible on a dark background. The result was a legal
        // notice the rider physically could not read before agreeing to it.
        // The SDK does not derive the remaining colours from the ones given.
        uiParams: {
          backgroundColor: '#0f172a',
          titleColor: '#ffffff',
          mainTextColor: '#e2e8f0',
          acceptButtonTextColor: '#60a5fa',
          cancelButtonTextColor: '#94a3b8',
        },
      }}
      taskRemovedBehavior={TaskRemovedBehavior.CONTINUE_SERVICE}
    >
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
    </NavigationProvider>
    </SafeAreaProvider>
  );
}
