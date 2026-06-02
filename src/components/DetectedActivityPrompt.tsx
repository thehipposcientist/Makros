import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme } from '../constants/theme';
import type { AppThemeName } from '../types';
import {
  addActivityDetectionListener,
  addActivityDetectionPreferenceListener,
  dismissDetectedActivity,
  getActivityDetectionAuthorizationStatus,
  isActivityDetectionAvailable,
  liveActivityFromDetection,
  loadActivityDetectionPreference,
  logPrefillFromDetection,
  startActivityDetection,
  stopActivityDetection,
  type DetectedActivityCandidate,
} from '../services/activityDetection';
import type { LiveActivityInitialActivity } from '../utils/liveActivityQuickStart';
import type { LogActivityPrefill } from './LogActivityModal';

interface Props {
  enabled: boolean;
  themeName?: AppThemeName;
  onStartTracking: (activity: LiveActivityInitialActivity) => void;
  onLogActivity: (prefill: LogActivityPrefill) => void;
}

function detectedTitle(candidate: DetectedActivityCandidate): string {
  if (candidate.kind === 'running') return 'Run detected';
  if (candidate.kind === 'cycling') return 'Ride detected';
  return 'Walk detected';
}

function elapsedCopy(seconds: number): string {
  const mins = Math.max(0, Math.round(seconds / 60));
  if (mins <= 0) return 'just now';
  if (mins === 1) return 'about 1 min ago';
  return `about ${mins} min ago`;
}

export default function DetectedActivityPrompt({
  enabled,
  themeName,
  onStartTracking,
  onLogActivity,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [candidate, setCandidate] = useState<DetectedActivityCandidate | null>(null);
  const [starting, setStarting] = useState(false);
  const [preferenceEnabled, setPreferenceEnabled] = useState(false);
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');

  const available = useMemo(() => isActivityDetectionAvailable(), []);

  useEffect(() => {
    if (!enabled) {
      setCandidate(null);
      stopActivityDetection();
      return;
    }
    let cancelled = false;
    loadActivityDetectionPreference()
      .then((value) => { if (!cancelled) setPreferenceEnabled(value); })
      .catch(() => { if (!cancelled) setPreferenceEnabled(false); });
    const unsubscribePreference = addActivityDetectionPreferenceListener((value) => {
      if (cancelled) return;
      setPreferenceEnabled(value);
      if (!value) setCandidate(null);
    });
    return () => {
      cancelled = true;
      unsubscribePreference();
    };
  }, [enabled]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      setAppActive(active);
      if (!active) {
        setCandidate(null);
        stopActivityDetection();
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!enabled || !available || !preferenceEnabled || !appActive) {
      setCandidate(null);
      stopActivityDetection();
      return;
    }
    const status = getActivityDetectionAuthorizationStatus();
    if (status === 'denied' || status === 'restricted') return;

    let cancelled = false;
    const unsubscribe = addActivityDetectionListener((next) => {
      if (!cancelled) setCandidate(next);
    });
    startActivityDetection().then((ok) => {
      if (!ok) unsubscribe();
    }).catch(() => unsubscribe());
    return () => {
      cancelled = true;
      unsubscribe();
      stopActivityDetection();
    };
  }, [appActive, available, enabled, preferenceEnabled]);

  if (!enabled || !preferenceEnabled || !candidate) return null;

  const handleDismiss = async () => {
    await dismissDetectedActivity(candidate.id);
    setCandidate(null);
  };

  const handleStart = async () => {
    setStarting(true);
    await dismissDetectedActivity(candidate.id);
    onStartTracking(liveActivityFromDetection(candidate));
    setCandidate(null);
    setStarting(false);
  };

  const handleLog = async () => {
    await dismissDetectedActivity(candidate.id);
    onLogActivity(logPrefillFromDetection(candidate));
    setCandidate(null);
  };

  return (
    <View
      testID="detected-activity-prompt"
      style={[
        styles.card,
        {
          backgroundColor: tc.surface,
          borderColor: tc.primary + '66',
          shadowColor: tc.primary,
        },
      ]}>
      <View style={[styles.iconWrap, { backgroundColor: tc.primary + '18' }]}>
        <Ionicons
          name={candidate.kind === 'cycling' ? 'bicycle-outline' : 'walk-outline'}
          size={20}
          color={tc.primary}
        />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, { color: tc.textPrimary }]} numberOfLines={1}>
          {detectedTitle(candidate)}
        </Text>
        <Text style={[styles.subtitle, { color: tc.textMuted }]} numberOfLines={1}>
          Started {elapsedCopy(candidate.elapsedSeconds)}
        </Text>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          testID="detected-activity-log"
          accessibilityLabel="Log detected activity"
          onPress={handleLog}
          activeOpacity={0.75}
          style={[styles.secondaryBtn, { borderColor: tc.border, backgroundColor: tc.surfaceRaised }]}>
          <Ionicons name="add-circle-outline" size={14} color={tc.textSecondary} />
          <Text style={[styles.secondaryText, { color: tc.textSecondary }]}>Log</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="detected-activity-start"
          accessibilityLabel="Start tracking detected activity"
          onPress={handleStart}
          activeOpacity={0.82}
          disabled={starting}
          style={[styles.primaryBtn, { backgroundColor: tc.primary }]}>
          {starting ? (
            <ActivityIndicator size="small" color={onPrimary} />
          ) : (
            <>
              <Ionicons name="play" size={13} color={onPrimary} />
              <Text style={[styles.primaryText, { color: onPrimary }]}>Start</Text>
            </>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          testID="detected-activity-dismiss"
          accessibilityLabel="Dismiss detected activity"
          onPress={handleDismiss}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          style={styles.closeBtn}>
          <Ionicons name="close" size={16} color={tc.textMuted} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 10,
    borderRadius: 8,
    borderWidth: 1,
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 13,
    fontWeight: '900',
  },
  subtitle: {
    fontSize: 11,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  secondaryBtn: {
    minHeight: 34,
    paddingHorizontal: 9,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  secondaryText: {
    fontSize: 11,
    fontWeight: '800',
  },
  primaryBtn: {
    minWidth: 64,
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  primaryText: {
    fontSize: 11,
    fontWeight: '900',
  },
  closeBtn: {
    width: 24,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
