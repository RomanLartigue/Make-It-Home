import { Tabs } from 'expo-router';
import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';

import { HapticTab } from '@/components/haptic-tab';
import { Beacon } from '@/constants/beacon';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: Beacon.beacon,
        tabBarInactiveTintColor: Beacon.faint,
        tabBarStyle: {
          backgroundColor: Beacon.nightBottom,
          borderTopColor: Beacon.line,
          borderTopWidth: 1,
        },
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: '600' },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size - 4} color={color} />,
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Circle',
          tabBarIcon: ({ color, size }) => <Ionicons name="people" size={size - 2} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="settings-sharp" size={size - 3} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="gold"
        options={{
          title: 'Gold',
          // Gold star stays gold even when inactive so the tab quietly advertises itself.
          tabBarActiveTintColor: '#f5b942',
          tabBarIcon: ({ focused, size }) => (
            <Ionicons name={focused ? 'star' : 'star-outline'} size={size - 3} color={focused ? '#f5b942' : '#8a7433'} />
          ),
        }}
      />
    </Tabs>
  );
}
