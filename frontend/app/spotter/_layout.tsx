import React from 'react';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { SC, TF } from '../../constants/SpotterTheme';

export default function SpotterTabsLayout() {
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
