import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../src/constants/theme';
import { configureWorkoutNotifications } from '../src/utils/restNotifications';

export default function RootLayout() {
  useEffect(() => {
    configureWorkoutNotifications().catch(() => undefined);
  }, []);

  return (
    <>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Screen name="index" />
      </Stack>
      <StatusBar style="light" />
    </>
  );
}