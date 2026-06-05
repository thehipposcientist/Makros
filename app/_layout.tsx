import { useEffect, useRef } from 'react';
import { AppState, View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { configureWorkoutNotifications } from '../src/utils/restNotifications';
import { configureDynamicTypeDefaults } from '../src/utils/dynamicType';
import OfflineBanner from '../src/components/OfflineBanner';
import { fontAssets } from '../src/constants/fonts';

configureDynamicTypeDefaults();

let GestureWrapper: React.ComponentType<{ style?: any; children: React.ReactNode }> = ({ style, children }) => (
  <View style={style}>{children}</View>
);
try {
  const gh = require('react-native-gesture-handler');
  if (gh?.GestureHandlerRootView) GestureWrapper = gh.GestureHandlerRootView;
} catch {}

// Keep Apple Health-derived summaries fresh while the app is active.
const HEALTH_REFRESH_THROTTLE_MS = 5 * 60_000;

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontAssets);
  const lastHealthRefreshMs = useRef(0);

  useEffect(() => {
    configureWorkoutNotifications().catch(() => undefined);
    import('../modules/thallo-watch-bridge')
      .then(({ WatchBridge }) => { WatchBridge.isAvailable(); })
      .catch(() => undefined);
    // Re-evaluate "you haven't done X in a while" reminders on cold
    // start against the latest locally-cached workout history. The
    // util reschedules its one-shot notifications each call.
    import('../src/utils/stalenessReminders')
      .then(({ evaluateStalenessReminders }) => evaluateStalenessReminders())
      .catch(() => undefined);
  }, []);

  // Foreground hook: every time the app becomes active, kick off a
  // healthDataSummary refresh. The refresh internally posts today's +
  // yesterday's snapshot to the backend, so users who only ever open
  // HomeScreen still get daily persistence (was: only ProgressScreen
  // triggered any refresh, so most users wrote zero rows).
  useEffect(() => {
    let inFlight = false;
    const onChange = (next: string) => {
      if (next !== 'active') return;
      const now = Date.now();
      if (inFlight || now - lastHealthRefreshMs.current < HEALTH_REFRESH_THROTTLE_MS) return;
      lastHealthRefreshMs.current = now;
      inFlight = true;
      import('../src/services/healthDataSummary')
        .then(({ refreshHealthDataSummary }) => refreshHealthDataSummary())
        .catch(() => undefined)
        .finally(() => { inFlight = false; });
    };
    const sub = AppState.addEventListener('change', onChange);
    const interval = setInterval(() => onChange(AppState.currentState), HEALTH_REFRESH_THROTTLE_MS);
    // Trigger once on mount as well — the first cold open is "active"
    // by the time RootLayout renders, so addEventListener won't fire.
    onChange(AppState.currentState);
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, []);

  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: '#0D0F14' }} />;
  }

  return (
    <GestureWrapper style={{ flex: 1, backgroundColor: '#0D0F14' }}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0D0F14' } }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="about" />
        <Stack.Screen name="signin" />
      </Stack>
      {/* Persistent reachability indicator — renders nothing while
          online; fades in at the top of the screen when the backend
          becomes unreachable. Mounted at the root so every surface
          inherits the affordance without per-screen wiring. */}
      <OfflineBanner />
      <StatusBar style="light" />
    </GestureWrapper>
  );
}
