import React, { useEffect, useState } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SC, TF } from '../../constants/SpotterTheme';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, ActivityIndicator } from 'react-native';

export default function SpotterTabsLayout() {
  const router = useRouter();
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    const checkRole = async () => {
      const role = await AsyncStorage.getItem('user_role');
      if (role?.toUpperCase() !== 'SPOTTER') {
        router.replace('/welcome');
      } else {
        setCheckingAuth(false);
      }
    };
    checkRole();
  }, []);

  if (checkingAuth) {
    return (
      <View style={{ flex: 1, backgroundColor: SC.bgApp, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={SC.accent} size="large" />
      </View>
    );
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: SC.bgCard,
          borderTopWidth: 0,
          height: 72,
          paddingBottom: 14,
          paddingTop: 8,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarActiveTintColor: SC.accent,
        tabBarInactiveTintColor: SC.textMuted,
        tabBarLabelStyle: {
          fontSize: 10,
          fontWeight: '700',
          letterSpacing: 0.3,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="grid" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="verify"
        options={{
          title: 'Verify',
          tabBarIcon: ({ focused, size }) => (
            <Ionicons name="shield-checkmark" size={22} color={focused ? SC.warning : SC.textMuted} />
          ),
          tabBarActiveTintColor: SC.warning,
        }}
      />
      <Tabs.Screen
        name="spots"
        options={{
          title: 'Spots',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="location" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="support"
        options={{
          title: 'Support',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-ellipses" size={22} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="payout-setup"
        options={{
          title: 'Payout Setup',
          href: null,
        }}
      />
    </Tabs>
  );
}
