import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../src/constants/theme';
import { configureWorkoutNotifications } from '../src/utils/restNotifications';
import { installDevLogs } from '../src/utils/devLogs';

// Install the ring-buffer console shim as early as possible so every
// subsequent log lands in the in-app viewer. Runs once per JS runtime.
installDevLogs();

let GestureWrapper: React.ComponentType<{ style?: any; children: React.ReactNode }> = ({ style, children }) => (
  <View style={style}>{children}</View>
);
try {
  const gh = require('react-native-gesture-handler');
  if (gh?.GestureHandlerRootView) GestureWrapper = gh.GestureHandlerRootView;
} catch {}

export default function RootLayout() {
  useEffect(() => {
    configureWorkoutNotifications().catch(() => undefined);
  }, []);

  return (
    <GestureWrapper style={{ flex: 1, backgroundColor: '#0D0F14' }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0D0F14' } }}>
        <Stack.Screen name="index" />
      </Stack>
      <StatusBar style="light" />
    </GestureWrapper>
  );
}