// Combined "Today's Training Readiness" card. Replaces the separate
// RecoveryCard (compact) + PreparednessCard on HomeScreen plan tab.
//
// Logic:
//   - Pulls backend readiness (per-muscle fatigue + readiness label).
//   - Pulls local preparedness composite (sleep/HRV/nutrition/RHR) if
//     Apple Health is available; otherwise falls back to backend readiness
//     + logged workouts only. No pillar is shown if its input is missing.
//   - Filters displayed muscle bars to the muscles that TODAY'S planned
//     focus actually trains, so users see signal for what they're about
//     to do — not the whole 12-muscle grid.
//
// Works with no Apple Health: in that case we surface backend readiness
// + nutrition + yesterday strain only, and the Apple-Health pillars disappear.

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, LayoutAnimation, Platform, UIManager, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, HealthSummary } from '../types';
import { scorePreparedness, PreparednessResult } from '../services/preparedness';
import { loadPreparednessInputs } from '../services/preparednessLoader';
import { isHealthKitAvailable, readHealthSummary } from '../services/appleHealth';
import { getFatigueScore, FatigueScore } from '../services/api';
import { loadHealthSummary, saveHealthSummary } from '../utils/workoutHistory';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// Animated width bar. Re-runs whenever `pct` changes (so switching focus
// mid-session animates the new target). Uses JS driver because percentage
// width isn't supported by the native one.
function AnimBar({ pct, color, trackColor }: { pct: number; color: string; trackColor: string }) {
  const w = useRef(new Animated.Value(0)).current;
  const last = useRef<number>(-1);
  useEffect(() => {
    if (last.current === pct) return;
    last.current = pct;
    Animated.timing(w, {
      toValue: Math.max(0, Math.min(1, pct)),
      duration: 650,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [pct, w]);
  return (
    <View style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: trackColor }}>
      <Animated.View style={{
        width: w.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        height: 5, borderRadius: 3, backgroundColor: color,
      }} />
    </View>
  );
}

// Animated integer counter. Eases up to `value` on mount + whenever value
// changes. Used for the hero score.
function AnimCounter({ value, style }: { value: number; style: any }) {
  const v = useRef(new Animated.Value(0)).current;
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const sub = v.addListener(({ value: x }) => setDisplay(Math.round(x)));
    Animated.timing(v, {
      toValue: value,
      duration: 800,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    return () => v.removeListener(sub);
  }, [value, v]);
  return <Text style={style}>{display}</Text>;
}

// Map planned focuses to the muscle groups they actually train. Keep it
// coarse but useful — we want the "push day" view to surface chest/
// shoulders/triceps even if the backend reports 12 muscles.
const FOCUS_TO_MUSCLES: Record<string, string[]> = {
  push: ['chest', 'shoulders', 'triceps'],
  pull: ['back', 'biceps'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves'],
  upper: ['chest', 'back', 'shoulders', 'biceps', 'triceps'],
  upper_body: ['chest', 'back', 'shoulders', 'biceps', 'triceps'],
  lower: ['quads', 'hamstrings', 'glutes', 'calves'],
  lower_body: ['quads', 'hamstrings', 'glutes', 'calves'],
  full_body: ['chest', 'back', 'shoulders', 'quads', 'hamstrings', 'glutes', 'core'],
  chest: ['chest', 'shoulders', 'triceps'],
  back: ['back', 'biceps'],
  shoulders: ['shoulders', 'triceps'],
  arms: ['biceps', 'triceps'],
  core: ['core'],
  cardio: ['cardio'],
  conditioning: ['cardio'],
  mobility: [],
  recovery: [],
};

function musclesForFocus(focus: string | null | undefined): string[] {
  if (!focus) return [];
  const norm = focus.toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
  // Direct lookup, then tokenized fallback ("push day" -> push).
  if (FOCUS_TO_MUSCLES[norm]) return FOCUS_TO_MUSCLES[norm];
  for (const key of Object.keys(FOCUS_TO_MUSCLES)) {
    if (norm.includes(key)) return FOCUS_TO_MUSCLES[key];
  }
  return [];
}

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  age?: number | null;
  proteinTarget?: number | null;
  calorieTarget?: number | null;
  todaysFocus?: string | null;
  /** Prefer a parent-provided summary so we don't duplicate the fetch. */
  healthSummary?: HealthSummary | null;
  /** Called with the computed score after every load so the parent
   *  can use the SAME number for watch pushes. Eliminates phone vs.
   *  watch drift caused by independent compute calls. */
  onScoreComputed?: (score: number, label: string) => void;
}

export default function TrainingReadinessCard({
  authToken, themeName, age, proteinTarget, calorieTarget, todaysFocus, healthSummary: parentSummary, onScoreComputed,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [prep, setPrep] = useState<PreparednessResult | null>(null);
  const [fatigue, setFatigue] = useState<FatigueScore | null>(null);
  const [hasAppleHealth, setHasAppleHealth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // PERMANENT FIX for phone↔watch readiness drift: fetch from
      // the server, render the response directly, push it unchanged
      // to the watch. No more dual client-compute. The server is the
      // ONLY computer of readiness — phone + watch are pure consumers.
      // `computed_at_ms` lets the watch reject stale pushes that
      // arrive out-of-order via WCSession.
      //
      // Falls back to the legacy client compute ONLY when the server
      // call errors (offline, auth lapse, brief outage). When that
      // happens the score on phone and watch will drift slightly until
      // connectivity returns and the next call lands — the trade we're
      // making for offline support.
      // Health-summary fetch order:
      //   1. Use the parent's already-loaded summary if provided.
      //   2. Otherwise read LIVE from HealthKit on this mount — without this
      //      the card was reading a stale AsyncStorage blob that only got
      //      refreshed on ProgressScreen/ActiveWorkout visits, so a user
      //      who opened the app and looked at readiness from HomeScreen
      //      saw yesterday's RHR/HRV (or nothing on first launch).
      //   3. Last-resort fall back to the AsyncStorage cache so the card
      //      shows *something* if HK throws (permissions revoked, etc.).
      let summary = parentSummary ?? null;
      if (!summary && isHealthKitAvailable()) {
        try {
          const fresh = await readHealthSummary({ age: age ?? null });
          if (fresh) {
            summary = fresh;
            // Warm the AsyncStorage cache so other screens benefit until
            // they next call readHealthSummary themselves.
            saveHealthSummary(fresh).catch(() => null);
          }
        } catch (err) {
          // HK throwing is otherwise silent — surface to dev logs so we
          // can diagnose "no HR data" reports without a remote session.
          console.warn('[readiness] HK readHealthSummary failed:', err);
        }
      }
      if (!summary) {
        summary = await loadHealthSummary().catch(() => null);
      }
      const ahAvailable = isHealthKitAvailable() && summary != null;
      setHasAppleHealth(ahAvailable);

      let serverResp: import('../services/api').ReadinessTodayResponse | null = null;
      try {
        const { getReadinessToday } = await import('../services/api');
        serverResp = await getReadinessToday(authToken, {
          avgSleepHours: summary?.lastNightSleepHours ?? null,
          avgRestingHr: summary?.restingHeartRate ?? null,
          avgHrvMs: summary?.hrvAvg ?? null,
        });
      } catch { /* offline / auth lapse — fall through to client compute */ }

      // Fatigue is still surfaced separately for the muscle bars in
      // the expanded view, regardless of which path produced the score.
      getFatigueScore(authToken).then(f => setFatigue(f)).catch(() => null);

      let displayScore: number;
      let displayLabel: PreparednessResult['label'];
      let displayResult: PreparednessResult;

      if (serverResp && serverResp.signals_present > 0) {
        displayScore = serverResp.score;
        // Map the server label onto the local enum for downstream UI.
        displayLabel = (
          serverResp.label === 'Primed' ? 'Primed'
          : serverResp.label === 'Ready' ? 'Ready'
          : serverResp.label === 'Moderate' ? 'Moderate'
          : 'Fatigued'
        );
        displayResult = {
          score: displayScore,
          label: displayLabel,
          // Pillars are no longer locally computed — leave a thin
          // shape so existing render paths keep working.
          pillars: { sleep: 0, hrv: 0, fatigue: 0, nutrition: 0, restingHr: 0, yesterdayStrain: 0 },
          insights: [],
          missing: serverResp.missing,
          signalsPresent: serverResp.signals_present,
          signalsTotal: serverResp.signals_total,
          raw: 0,
          maxPossible: 0,
        } as PreparednessResult;
        setPrep(displayResult);
      } else {
        // Offline / no server signal — fall back to local compute so
        // the card still shows something useful. We accept that this
        // path can drift from the watch (which has the LAST server-
        // pushed value cached). When the next network call lands, both
        // surfaces realign.
        const inputs = await loadPreparednessInputs({
          authToken,
          age: age ?? null,
          proteinTarget: proteinTarget ?? null,
          calorieTarget: calorieTarget ?? null,
          todaysFocus: todaysFocus ?? null,
          cachedHealthSummary: summary ?? null,
        });
        displayResult = scorePreparedness(inputs);
        displayScore = displayResult.score;
        displayLabel = displayResult.label;
        setPrep(displayResult);
      }

      try { onScoreComputed?.(displayScore, displayLabel); } catch {}

      // Push the SERVER response (or our local fallback) verbatim to
      // the watch. The existing watchSync.pushReadinessToWatch maps
      // computed_at_ms onto syncedAtMs, and ConnectivityStore on the
      // watch already orders by syncedAtMs — so stale pushes can't
      // overwrite a fresher value.
      try {
        const { pushReadinessToWatch } = await import('../utils/watchSync');
        if (serverResp) {
          await pushReadinessToWatch({
            score: serverResp.score,
            label: serverResp.label,
            summary: serverResp.summary,
            factors: serverResp.factors as any,
            // Pass the server's stamp so the watch's ordering check
            // ignores any older push that lands after this one.
            syncedAtMs: serverResp.computed_at_ms,
          } as any).catch(() => {});
        } else {
          await pushReadinessToWatch({
            score: displayResult.score,
            label: displayResult.label,
            summary: displayResult.score >= 75 ? 'Solid recovery — train as planned.'
              : displayResult.score >= 50 ? 'Moderate. Standard intensity is fine.'
              : 'Low. Consider lighter loads today.',
            factors: [],
          }).catch(() => {});
        }
      } catch { /* watch bridge optional */ }
    } catch {
      setPrep(null);
    } finally {
      setLoading(false);
    }
  }, [authToken, parentSummary, age, proteinTarget, calorieTarget, todaysFocus]);

  useEffect(() => { load(); }, [load]);

  if (loading && !prep) return null;
  if (!prep) return null;
  // Zero real signals → don't show a misleading "0 Fatigued" dial. Show
  // a neutral CTA instead. The user can still open Apple Health from
  // Settings to grant permissions.
  if (prep.signalsPresent === 0) {
    return (
      <View style={{
        backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1, borderColor: tc.border, flexDirection: 'row', alignItems: 'center', gap: 8,
      }}>
        <Ionicons name="flash-outline" size={16} color={tc.textMuted} />
        <Text style={{ flex: 1, fontSize: 12, color: tc.textSecondary }}>
          Connect Apple Health and log a meal to see today's readiness.
        </Text>
      </View>
    );
  }

  // Status colors — lean into the theme. Primed/Ready both wear the theme's
  // primary (varying intensity), and only Moderate/Fatigued switch to the
  // semantic amber/red signal. Keeps the card cohesive with whatever palette
  // the user picked without dropping the "you need to rest" warning.
  const labelColor =
    prep.label === 'Primed'    ? tc.primary :
    prep.label === 'Ready'     ? tc.primary :
    prep.label === 'Moderate'  ? tc.warning : tc.error;

  // Bar colors follow the same philosophy: primary at full or reduced weight
  // for "good" bands, only amber/red when something is actually off.
  const barColorFor = (pct: number) =>
    pct >= 0.75 ? tc.primary :
    pct >= 0.50 ? (tc.primaryDark ?? tc.primary) :
    pct >= 0.30 ? tc.warning : tc.error;
  const muscleBarColor = (recovery: number) =>
    recovery >= 75 ? tc.primary :
    recovery >= 50 ? (tc.primaryDark ?? tc.primary) :
    recovery >= 30 ? tc.warning : tc.error;

  const focusMuscles = musclesForFocus(todaysFocus);
  const muscleFatigue = fatigue?.muscle_fatigue ?? {};
  // Narrow the muscle list to today's planned focus; if unknown, show top-3.
  const relevantMuscles: Array<[string, number]> = (focusMuscles.length > 0
    ? focusMuscles.map((m) => [m, muscleFatigue[m] ?? 0] as [string, number])
    : Object.entries(muscleFatigue)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 3)
  );

  const toggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(e => !e);
  };

  // Only show pillars whose input was actually available. Honors both
  // (a) "Apple Health not connected" and (b) "AH connected but this
  // specific signal not yet logged" via prep.missing. Without (b), HRV
  // would appear as a flat "12 / 20" bar even when the user's watch
  // never wrote an HRV sample.
  const isPresent = (key: string) => !prep.missing.includes(key);
  const pillarRows: Array<[string, number, number]> = [];
  if (hasAppleHealth && isPresent('sleep')) pillarRows.push(['Sleep', prep.pillars.sleep, 30]);
  if (hasAppleHealth && isPresent('hrv')) pillarRows.push(['HRV', prep.pillars.hrv, 20]);
  if (isPresent('fatigue')) pillarRows.push(['Muscle recovery', prep.pillars.fatigue, 20]);
  if (isPresent('nutrition')) pillarRows.push(['Nutrition', prep.pillars.nutrition, 15]);
  if (hasAppleHealth && isPresent('rhr')) pillarRows.push(['Resting HR', prep.pillars.restingHr, 10]);
  pillarRows.push(['Yesterday\'s load', prep.pillars.yesterdayStrain, 5]);

  // Pillars the server said were missing AND are AH-derived. Surfaced
  // as inline grey rows so the user knows the score excludes them
  // rather than silently hiding (the previous behavior, which made
  // "no HR data" reports impossible to debug from the user side).
  // Only shown when AH is connected — otherwise the "Connect Apple
  // Health" footer covers the same ground.
  const missingHkRows: Array<[string, string]> = [];
  if (hasAppleHealth) {
    if (!isPresent('sleep')) missingHkRows.push(['Sleep', 'No sleep recorded last night — Apple Watch may not have synced.']);
    if (!isPresent('hrv')) missingHkRows.push(['HRV', 'No HRV reading yet today — usually arrives after Watch sync.']);
    if (!isPresent('rhr')) missingHkRows.push(['Resting HR', 'No resting HR reading today — Apple Watch may not have synced.']);
  }

  const focusLabel = todaysFocus
    ? todaysFocus.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : null;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={toggle}
      style={{
        backgroundColor: tc.surface, borderRadius: radius.lg, padding: 14, marginBottom: 12,
        borderWidth: 1,
        // Accent-tinted border that still respects each theme's identity.
        // Primed/Ready wear the theme color; Moderate/Fatigued switch to
        // the semantic signal so the UI still warns appropriately.
        borderColor: (prep.label === 'Primed' || prep.label === 'Ready')
          ? tc.primary + '55'
          : labelColor + '55',
        overflow: 'hidden',
      }}
    >
      {/* Left accent strip — subtle theme anchor. 3px wide on the leading edge. */}
      <View style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
        backgroundColor: labelColor,
        opacity: 0.6,
      }} />
      {/* Header — score-circle treatment so it reads as a gauge, not a
          second copy of the workout-card focus header. The colored ring
          carries the readiness state; "Push" appears as a small caption
          beneath the state word, not as the dominant headline. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {/* Score dial — colored by state (green/amber/red). Size and
            ring-weight mirror the Switch Day tile dial so the visual
            language is consistent across the home screen. */}
        <View style={{
          width: 56, height: 56, borderRadius: 28,
          borderWidth: 4, borderColor: labelColor,
          backgroundColor: tc.surface,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <AnimCounter
            value={prep.score}
            style={{ fontSize: 18, fontWeight: '900', color: labelColor, lineHeight: 20 }}
          />
          <Text style={{ fontSize: 7, fontWeight: '700', color: labelColor + 'BB', letterSpacing: 0.4, marginTop: -1 }}>
            READY
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          {/* State word — primary line ("Primed" / "Ready" / "Moderate" /
              "Fatigued"). Large and color-coded but NOT the focus name,
              so the user can't confuse it with the "Push" header below. */}
          <Text style={{ fontSize: 18, fontWeight: '800', color: labelColor, lineHeight: 22 }}>
            {prep.label}
          </Text>
          {/* Small caption beneath — ties readiness to today's focus
              without competing with the workout card. */}
          {focusLabel ? (
            <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 1 }} numberOfLines={1}>
              for {focusLabel} · {prep.signalsPresent}/{prep.signalsTotal} signals
            </Text>
          ) : (
            <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 1 }}>
              Today's training readiness · {prep.signalsPresent}/{prep.signalsTotal} signals
            </Text>
          )}
          {!expanded && (
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 3 }} numberOfLines={1}>
              {prep.insights[0] ?? (relevantMuscles.length > 0
                ? `${relevantMuscles.map(([m]) => m.replace('_', ' ')).join(', ')} recovery shown`
                : 'All tracked signals look clean')}
            </Text>
          )}
        </View>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={tc.textMuted} />
      </View>

      {expanded && (
        <View style={{ marginTop: 10, gap: 4 }}>
          {/* Muscle-specific readiness for today's focus */}
          {relevantMuscles.length > 0 && (
            <View style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>
                {focusMuscles.length > 0 ? 'TODAY\'S MUSCLES' : 'MOST FATIGUED'}
              </Text>
              {relevantMuscles.map(([muscle, fat]) => {
                const pct = Math.round(fat * 100);
                const recovery = Math.max(0, Math.min(100, 100 - pct));
                const barColor = muscleBarColor(recovery);
                return (
                  <View key={muscle} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <Text style={{ width: 92, fontSize: 11, fontWeight: '600', color: tc.textSecondary, textTransform: 'capitalize' }}>
                      {muscle.replace('_', ' ')}
                    </Text>
                    <AnimBar pct={recovery / 100} color={barColor} trackColor={tc.border} />
                    <Text style={{ width: 44, fontSize: 10, fontWeight: '700', color: tc.textSecondary, textAlign: 'right' }}>
                      {recovery}%
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          {/* Readiness pillars */}
          <Text style={{ fontSize: 10, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>
            DRIVERS
          </Text>
          {/* Per-pillar descriptions so users understand what each row
              means — particularly "Yesterday", which was confusing
              users ("what is yesterday?"). The description renders as
              a small muted caption beneath each bar. */}
          {(() => {
            const descriptions: Record<string, string> = {
              'Sleep': 'Last night\'s sleep duration + quality from Apple Health.',
              'HRV': 'Heart-rate variability trend — higher = better recovered.',
              'Muscle recovery': 'How fresh the muscles you\'re training today are (fatigue decay from recent workouts).',
              'Nutrition': 'Whether you\'ve hit your calorie + protein targets the last few days.',
              'Resting HR': 'Resting heart rate vs your 30-day baseline. Elevated RHR often means under-recovered.',
              "Yesterday's load": 'How hard yesterday\'s training was. A short or rest day = more points today; 2+ hours of training yesterday pulls the score down because you\'re less recovered.',
            };
            return pillarRows.map(([label, pts, max]) => {
              const pct = Math.max(0, Math.min(1, (pts as number) / (max as number)));
              const barColor = barColorFor(pct);
              const desc = descriptions[label as string];
              return (
                <View key={label as string} style={{ marginBottom: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: tc.textSecondary }}>{label as string}</Text>
                    <AnimBar pct={pct} color={barColor} trackColor={tc.border} />
                    <Text style={{ width: 42, fontSize: 10, fontWeight: '700', color: tc.textSecondary, textAlign: 'right' }}>
                      {pts}/{max}
                    </Text>
                  </View>
                  {desc && (
                    <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2, marginLeft: 0, lineHeight: 13 }}>
                      {desc}
                    </Text>
                  )}
                </View>
              );
            });
          })()}

          {missingHkRows.length > 0 && (
            <View style={{ marginTop: 4 }}>
              {missingHkRows.map(([label, hint]) => (
                <View key={label} style={{ marginBottom: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ width: 110, fontSize: 11, fontWeight: '600', color: tc.textMuted }}>{label}</Text>
                    <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: tc.border, opacity: 0.4 }} />
                    <Text style={{ width: 42, fontSize: 10, fontWeight: '700', color: tc.textMuted, textAlign: 'right' }}>—</Text>
                  </View>
                  <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2, lineHeight: 13, fontStyle: 'italic' }}>
                    {hint}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {!hasAppleHealth && (
            <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 6, fontStyle: 'italic' }}>
              Connect Apple Health for sleep + HRV signals.
            </Text>
          )}
          {prep.insights.length > 1 && (
            <View style={{ marginTop: 6, gap: 3 }}>
              {prep.insights.slice(1).map((line, i) => (
                <Text key={i} style={{ fontSize: 11, color: tc.textSecondary, lineHeight: 15 }}>• {line}</Text>
              ))}
            </View>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}
