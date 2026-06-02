/**
 * MyFitnessPalCard — expandable button-card that lets users connect
 * MyFitnessPal via Apple Health and surfaces today's nutrition
 * snapshot (calories + macros) once the read-permission is granted.
 *
 * Self-contained: manages its own state (enabled, snapshot, in-flight
 * flags). Mirrors the "Your Kitchen" expandable card pattern used
 * elsewhere in EditProfileScreen — collapsed shows an icon, title,
 * short status, and "Open" pill; expanded shows the full content.
 *
 * Used to live inline inside ProgressScreen → Health tab. Moved here
 * because the MFP/HK bridge is fundamentally a food-import surface
 * rather than a vitals-style health metric.
 */
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  LayoutAnimation,
  Linking,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import type { AppThemeName } from '../types';
import {
  APPLE_HEALTH_PERMISSION_COPY,
  getLastHealthKitError,
  isHealthKitAvailable,
  readDailyNutritionSnapshot,
  requestHealthPermissions,
  type DailyNutritionSnapshot,
} from '../services/appleHealth';
import {
  isAppleHealthEnabled,
  setAppleHealthEnabled as persistAppleHealthEnabled,
} from '../utils/workoutHistory';

interface Props {
  themeName?: AppThemeName;
}

export default function MyFitnessPalCard({ themeName }: Props) {
  const tc = getTheme(themeName).colors;
  const [expanded, setExpanded] = useState(false);
  const [healthEnabled, setHealthEnabled] = useState(false);
  const [healthConnecting, setHealthConnecting] = useState(false);
  const [snapshot, setSnapshot] = useState<DailyNutritionSnapshot | null>(null);
  const [reading, setReading] = useState(false);

  // Cache the platform/HK check once so all hooks below run
  // unconditionally — early-returning between hooks would violate
  // Rules of Hooks. We just gate the EFFECT bodies + the JSX output.
  const platformOk = Platform.OS === 'ios' && isHealthKitAvailable();

  // Mount-time: check whether the user has already granted permission
  // (so the card can open straight into the snapshot view on first
  // expand instead of asking again).
  useEffect(() => {
    if (!platformOk) return;
    let cancelled = false;
    (async () => {
      try {
        const enabled = await isAppleHealthEnabled();
        if (!cancelled) setHealthEnabled(enabled);
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [platformOk]);

  const refreshSnapshot = async (): Promise<DailyNutritionSnapshot | null> => {
    if (!isHealthKitAvailable()) return null;
    setReading(true);
    try {
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const dayEnd = dayStart + 86400000;
      const snap = await readDailyNutritionSnapshot(dayStart, dayEnd);
      setSnapshot(snap);
      return snap;
    } finally {
      setReading(false);
    }
  };

  // Lazy first-fetch when the user opens the expanded body.
  useEffect(() => {
    if (!platformOk || !expanded || !healthEnabled || snapshot != null || reading) return;
    refreshSnapshot().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformOk, expanded, healthEnabled]);

  // Render-time guard. On Android / unsupported devices the card just
  // doesn't appear — keeps the Foods tab clean for non-iOS users.
  if (!platformOk) return null;

  const handleConnect = () => {
    Alert.alert(
      'Use MyFitnessPal with Thallo',
      'Log food in MyFitnessPal, let MyFitnessPal write nutrition summaries to Apple Health, then allow Thallo to read nutrition from Apple Health.',
      [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Connect Apple Health',
          onPress: async () => {
            setHealthConnecting(true);
            try {
              const granted = await requestHealthPermissions();
              await persistAppleHealthEnabled(granted);
              setHealthEnabled(granted);
              if (granted) {
                await refreshSnapshot();
              } else {
                const err = getLastHealthKitError();
                Alert.alert('Apple Health not connected', `${APPLE_HEALTH_PERMISSION_COPY.denied}\n\n${err ?? ''}`.trim());
              }
            } catch (e: any) {
              Alert.alert('Apple Health error', String(e?.message ?? e));
            } finally {
              setHealthConnecting(false);
            }
          },
        },
      ],
    );
  };

  const openSettings = () => {
    Linking.openURL('app-settings:').catch(() => {
      Alert.alert('Unable to open Settings', 'Go to iPhone Settings -> Privacy & Security -> Health, then allow nutrition categories for MyFitnessPal and Thallo.');
    });
  };

  const hasData = !!snapshot && [snapshot.calories, snapshot.proteinG, snapshot.carbsG, snapshot.fatG]
    .some(v => typeof v === 'number' && v > 0);

  const statusLine = healthEnabled
    ? (hasData ? "Today's totals available" : 'Connected — no data yet today')
    : 'Tap to import food logs from MyFitnessPal';

  return (
    <View style={{ marginBottom: 20 }}>
      <TouchableOpacity
        testID="mfp-card-toggle"
        activeOpacity={0.7}
        onPress={() => { LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut); setExpanded(p => !p); }}
        style={[{
          flexDirection: 'row', alignItems: 'center', gap: 10,
          marginBottom: expanded ? 12 : 0,
        }, !expanded && {
          padding: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: tc.primary + '44',
          backgroundColor: tc.primary + '0E',
        }]}>
        <View style={{
          width: 34, height: 34, borderRadius: 10,
          backgroundColor: tc.primary + '18',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Ionicons name="restaurant-outline" size={18} color={tc.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: tc.textPrimary }}>
            MyFitnessPal via Apple Health
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 1 }}>
            {statusLine}
          </Text>
        </View>
        {expanded ? (
          <Ionicons name="chevron-up" size={16} color={tc.textMuted} />
        ) : (
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 4,
            paddingHorizontal: 10, paddingVertical: 6,
            borderRadius: 999,
            backgroundColor: tc.primary,
          }}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: getContrastingTextColor(tc.primary) }}>
              {healthEnabled ? 'View' : 'Connect'}
            </Text>
            <Ionicons name="chevron-down" size={14} color={getContrastingTextColor(tc.primary)} />
          </View>
        )}
      </TouchableOpacity>

      {expanded && (
        <View style={{
          backgroundColor: tc.surface,
          borderColor: tc.border,
          borderWidth: 1,
          borderRadius: 12,
          padding: 14,
        }}>
          {hasData ? (
            <>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: 9 }}>
                {[
                  { label: 'Calories', value: snapshot?.calories != null ? `${snapshot.calories}` : 'n/a', color: tc.primary },
                  { label: 'Protein',  value: snapshot?.proteinG != null ? `${snapshot.proteinG}g` : 'n/a', color: '#22C55E' },
                  { label: 'Carbs',    value: snapshot?.carbsG   != null ? `${snapshot.carbsG}g`   : 'n/a', color: '#F59E0B' },
                  { label: 'Fat',      value: snapshot?.fatG     != null ? `${snapshot.fatG}g`     : 'n/a', color: '#A78BFA' },
                ].map(item => (
                  <View key={item.label} style={{ flex: 1, alignItems: 'center', backgroundColor: tc.surfaceRaised ?? tc.surface, borderRadius: 8, paddingVertical: 8 }}>
                    <Text style={{ fontSize: 15, fontWeight: '900', color: item.color }}>{item.value}</Text>
                    <Text style={{ fontSize: 9, fontWeight: '700', color: tc.textMuted, marginTop: 1 }}>{item.label}</Text>
                  </View>
                ))}
              </View>
              <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
                These are Apple Health nutrition totals. If MyFitnessPal is connected to Apple Health, Thallo can use the summaries without asking you to relog individual foods here.
              </Text>
            </>
          ) : (
            <>
              <Text style={{ fontSize: 12, color: tc.textSecondary, lineHeight: 17 }}>
                Keep logging food in MyFitnessPal. In MFP, enable HealthKit Sharing for food/nutrition; then allow Thallo to read dietary energy, protein, carbs, and fat from Apple Health.
              </Text>
              <View style={{ marginTop: 10, gap: 6 }}>
                {[
                  'MyFitnessPal: More -> Settings -> Sharing & Privacy -> HealthKit Sharing',
                  'iPhone Settings: Health -> Data Access & Devices -> MyFitnessPal',
                  'iPhone Settings: Health -> Data Access & Devices -> Thallo',
                ].map(step => (
                  <View key={step} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
                    <Ionicons name="checkmark-circle-outline" size={14} color={tc.primary} style={{ marginTop: 1 }} />
                    <Text style={{ flex: 1, fontSize: 11, color: tc.textMuted, lineHeight: 15 }}>{step}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
            {!healthEnabled ? (
              <TouchableOpacity
                testID="mfp-card-connect"
                activeOpacity={0.85}
                disabled={healthConnecting}
                onPress={handleConnect}
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 38, borderRadius: radius.md, backgroundColor: tc.primary }}>
                {healthConnecting ? (
                  <ActivityIndicator color={getContrastingTextColor(tc.primary)} />
                ) : (
                  <Text style={{ fontSize: 12, fontWeight: '800', color: getContrastingTextColor(tc.primary) }}>Connect Apple Health</Text>
                )}
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                testID="mfp-card-refresh"
                activeOpacity={0.85}
                disabled={reading}
                onPress={() => { refreshSnapshot().catch(() => {}); }}
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 38, borderRadius: radius.md, backgroundColor: tc.primary }}>
                {reading ? (
                  <ActivityIndicator color={getContrastingTextColor(tc.primary)} />
                ) : (
                  <Text style={{ fontSize: 12, fontWeight: '800', color: getContrastingTextColor(tc.primary) }}>Refresh Nutrition</Text>
                )}
              </TouchableOpacity>
            )}
            <TouchableOpacity
              testID="mfp-card-settings"
              activeOpacity={0.85}
              onPress={openSettings}
              style={{ alignItems: 'center', justifyContent: 'center', minHeight: 38, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: tc.surfaceRaised ?? tc.surface, borderWidth: 1, borderColor: tc.border }}>
              <Ionicons name="settings-outline" size={17} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}
