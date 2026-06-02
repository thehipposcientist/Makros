import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import ViewShot from 'react-native-view-shot';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import type { AppThemeName, WorkoutSession, StoredWorkoutSummary } from '../types';
import type { WorkoutPostSummary } from '../services/api';
import ShareWorkoutModal from './ShareWorkoutModal';
import { formatSocialSetSummary, type SocialWorkoutSet } from '../utils/socialWorkoutDetails';
import { formatDistance } from '../utils/units';
import {
  workoutSummaryBackgroundSource,
  workoutSummaryIconName,
  workoutSummaryIsCardioLike,
  workoutSummaryTypeLabel,
} from '../utils/workoutSummaryVisuals';
import { displayFocusForExercises } from '../utils/workoutFocusDisplay';

// Lazy reference to expo-image-picker — same proxy pattern as
// ActiveWorkoutScreen, so the require only fires when the user
// actually picks a Stories background photo.
const ImagePicker: typeof import('expo-image-picker') = (() => {
  let mod: any = null;
  return new Proxy({} as any, {
    get: (_t, prop) => {
      if (!mod) mod = require('expo-image-picker');
      return mod[prop as string];
    },
  });
})();

const SHARE_LOGO_DARK = require('../../assets/images/thallo-logo-white-transparent-New.png');

interface Props {
  visible: boolean;
  authToken: string;
  themeName?: AppThemeName;
  profileGender?: 'male' | 'female' | 'nonbinary' | 'prefer_not_to_say' | string;
  session: WorkoutSession | null;
  summary?: StoredWorkoutSummary | null;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const fromText = Number(match[0]);
      if (Number.isFinite(fromText)) return fromText;
    }
  }
  return null;
}

function sessionSetToSocialSet(set: any): SocialWorkoutSet {
  return {
    reps: set?.reps ?? null,
    weight_lbs: set?.weightLbs ?? set?.weight_lbs ?? set?.weight ?? null,
    duration_seconds: set?.durationSeconds ?? set?.duration_seconds ?? null,
    actual_distance: set?.distanceMiles ?? set?.distance_miles ?? set?.actual_distance ?? null,
    actual_pace: set?.pace ?? set?.actual_pace ?? null,
    heart_rate_avg: set?.avgHeartRate ?? set?.heart_rate_avg ?? null,
    cardio_metrics: set?.cardioMetrics ?? set?.cardio_metrics ?? null,
  };
}

function scoreSocialSet(set: SocialWorkoutSet): number {
  const reps = numeric(set.reps) ?? 0;
  const weight = numeric(set.weight_lbs) ?? 0;
  let score = 0;
  if (weight > 0 && reps > 0) score = weight * (1 + reps / 30);
  else if (reps > 0) score = reps;

  const durationSeconds = numeric(set.duration_seconds) ?? 0;
  if (durationSeconds > 0) score = Math.max(score, durationSeconds / 60);
  const distanceMiles = numeric(set.actual_distance) ?? 0;
  if (distanceMiles > 0) score = Math.max(score, distanceMiles * 120);
  const heartRate = numeric(set.heart_rate_avg) ?? 0;
  if (heartRate > 0) score = Math.max(score, heartRate / 2);

  const metrics = set.cardio_metrics && typeof set.cardio_metrics === 'object' ? set.cardio_metrics : null;
  if (metrics) {
    for (const [rawKey, rawValue] of Object.entries(metrics)) {
      const key = rawKey.toLowerCase();
      if (key.includes('calorie') || key.includes('kcal') || key.includes('body_') || key.includes('macro')) continue;
      const metricValue = numeric(rawValue);
      if (metricValue && metricValue > 0) score = Math.max(score, metricValue);
    }
  }
  return score || 1;
}

function buildStickerTopSets(session: WorkoutSession, maxRows: number) {
  const candidates: Array<{
    exerciseName: string;
    summary: string;
    score: number;
    exerciseIndex: number;
    setIndex: number;
  }> = [];

  (session.exercises ?? []).forEach((exercise, exerciseIndex) => {
    let best: (typeof candidates)[number] | null = null;
    (exercise.sets ?? []).forEach((rawSet, setIndex) => {
      const set = sessionSetToSocialSet(rawSet);
      const row = {
        exerciseName: exercise.name || 'Exercise',
        summary: formatSocialSetSummary(set),
        score: scoreSocialSet(set),
        exerciseIndex,
        setIndex,
      };
      if (!best || row.score > best.score) best = row;
    });
    if (best) candidates.push(best);
  });

  candidates.sort((a, b) =>
    b.score - a.score
    || a.exerciseIndex - b.exerciseIndex
    || a.setIndex - b.setIndex,
  );

  return {
    rows: candidates.slice(0, maxRows),
    overflow: Math.max(0, candidates.length - maxRows),
  };
}

function buildPostSummary(
  session: WorkoutSession,
  summary?: StoredWorkoutSummary | null,
): WorkoutPostSummary {
  const sourceExercises = session.exercises?.length ? session.exercises : (summary?.exercises ?? []);
  const exercises = sourceExercises.map(ex => ({
    name: ex.name,
    equipment: ex.equipment ?? null,
    sets: (ex.sets ?? []).map(s => ({
      reps: s.reps ?? null,
      weight_lbs: s.weightLbs ?? null,
      duration_seconds: s.durationSeconds ?? null,
      actual_distance: s.actualDistance ?? null,
      actual_pace: s.actualPace ?? null,
      heart_rate_avg: s.heartRateAvg ?? null,
      cardio_metrics: s.cardioMetrics ?? null,
    })),
  }));
  const totalSets = exercises.reduce((n, ex) => n + ex.sets.length, 0);
  const totalReps = exercises.reduce(
    (n, ex) => n + ex.sets.reduce((m, s) => m + (s.reps ?? 0), 0),
    0,
  );
  const activity = session.manualActivity;
  const displayFocus = displayFocusForExercises(session.focus, session.exercises);
  return {
    focus: displayFocus,
    duration_seconds: session.durationSeconds || 0,
    date: session.date,
    activity_category: activity?.category ?? null,
    activity_subtype: activity?.subtype ?? null,
    cardio_style: activity?.cardioStyle ?? null,
    distance_miles: activity?.distanceMiles ?? null,
    hr_summary: activity?.avgHeartRate
      ? { avgBpm: activity.avgHeartRate, maxBpm: null }
      : null,
    exercises,
    total_sets: summary?.totalSets ?? totalSets,
    total_reps: summary?.totalReps ?? totalReps,
    training_score: null,
    training_rating: null,
  };
}

export default function WorkoutHistoryShareModal({
  visible,
  authToken,
  themeName,
  profileGender,
  session,
  summary,
  onClose,
}: Props) {
  const theme = getTheme(themeName);
  const c = theme.colors;
  const styles = useMemo(() => makeStyles(c), [c]);

  const cardRef = useRef<ViewShot | null>(null);
  // Second ViewShot ref for the off-screen *transparent* sticker
  // card used in the Strava-style Stories share. The on-screen
  // `cardRef` paints a full-bleed summary; this one is the same
  // info squeezed into a 360×640 transparent overlay that
  // Instagram composites on top of the user's chosen photo.
  const stickerCardRef = useRef<ViewShot | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [instagramAvailable, setInstagramAvailable] = useState(false);
  const [friendsVisible, setFriendsVisible] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const { isInstagramStoriesAvailable } = await import('../utils/shareToInstagram');
        const ok = await isInstagramStoriesAvailable();
        if (!cancelled) setInstagramAvailable(ok);
      } catch {
        if (!cancelled) setInstagramAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  if (!session) return null;
  const sessionDisplayFocus = displayFocusForExercises(
    session.focus,
    session.exercises?.length ? session.exercises : (summary?.exercises ?? []),
  );

  const exerciseCount = (session.exercises ?? []).length;
  const totalSets =
    summary?.totalSets ??
    (session.exercises ?? []).reduce((n, ex) => n + (ex.sets?.length ?? 0), 0);
  const totalReps =
    summary?.totalReps ??
    (session.exercises ?? []).reduce(
      (n, ex) => n + (ex.sets ?? []).reduce((m, s) => m + (s.reps ?? 0), 0),
      0,
    );
  const activity = session.manualActivity;
  const hrAvg = activity?.avgHeartRate ?? summary?.hrAvg ?? null;
  const dateLabel = (() => {
    try {
      const d = new Date(session.date);
      return d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return session.date;
    }
  })();
  const visualInput = {
    focus: sessionDisplayFocus,
    stimulus: null,
    exercises: session.exercises?.length ? session.exercises : (summary?.exercises ?? []),
    activityCategory: activity?.category ?? null,
    activitySubtype: activity?.subtype ?? null,
    sourceContext: activity?.source ?? null,
  };
  const backgroundSource = workoutSummaryBackgroundSource(visualInput, profileGender);
  const typeLabel = workoutSummaryTypeLabel(visualInput);
  const iconName = workoutSummaryIconName(visualInput);
  const isCardioLike = workoutSummaryIsCardioLike(visualInput);
  const distanceMiles = activity?.distanceMiles ?? null;
  const elevationGainFt = Number(activity?.details?.elevationGainFt);
  const caloriesBurned = activity?.caloriesBurned ?? summary?.caloriesBurned ?? null;
  const trainingScore = summary?.trainingScore ?? null;
  const metricRows = (() => {
    const rows: Array<{ key: string; icon: string; value: string; label: string }> = [];
    const addDuration = () => rows.push({
      key: 'duration',
      icon: 'time-outline',
      value: formatDuration(session.durationSeconds || 0),
      label: 'Time',
    });
    const addDistance = () => {
      if (distanceMiles != null && distanceMiles > 0) rows.push({
        key: 'distance',
        icon: 'map-outline',
        value: formatDistance(distanceMiles, 'mi', { precision: distanceMiles >= 10 ? 0 : 2 }),
        label: 'Distance',
      });
    };
    const addElevation = () => {
      if (Number.isFinite(elevationGainFt) && elevationGainFt > 0) rows.push({
        key: 'elevation',
        icon: 'trending-up-outline',
        value: String(Math.round(elevationGainFt)),
        label: 'Elev ft',
      });
    };
    const addCalories = () => {
      if (caloriesBurned != null && caloriesBurned > 0) rows.push({
        key: 'calories',
        icon: 'flame-outline',
        value: String(Math.round(caloriesBurned)),
        label: 'Kcal',
      });
    };
    const addSets = () => {
      if (totalSets > 0) rows.push({ key: 'sets', icon: 'barbell-outline', value: String(totalSets), label: 'Sets' });
    };
    const addReps = () => {
      if (totalReps > 0) rows.push({ key: 'reps', icon: 'repeat-outline', value: String(totalReps), label: 'Reps' });
    };
    const addScore = () => {
      if (trainingScore != null) rows.push({ key: 'score', icon: 'trophy-outline', value: String(Math.round(trainingScore)), label: 'Score' });
    };
    const addHeart = () => {
      if (hrAvg != null && hrAvg > 0) rows.push({ key: 'hr', icon: 'heart-outline', value: String(Math.round(hrAvg)), label: 'Avg bpm' });
    };
    const addExercises = () => {
      if (exerciseCount > 0) rows.push({ key: 'exercises', icon: 'fitness-outline', value: String(exerciseCount), label: 'Exercises' });
    };

    if (isCardioLike) {
      addDuration();
      addDistance();
      addElevation();
      addCalories();
      addHeart();
      addScore();
      addSets();
      addReps();
      addExercises();
    } else {
      addSets();
      addReps();
      addScore();
      addHeart();
      addCalories();
      addDuration();
      addExercises();
      addDistance();
    }
    return rows.slice(0, 4);
  })();
  const sessionLabel = !isCardioLike && totalSets > 0
    ? `${totalSets} set${totalSets === 1 ? '' : 's'} logged`
    : distanceMiles != null && distanceMiles > 0
    ? formatDistance(distanceMiles, 'mi', { precision: distanceMiles >= 10 ? 0 : 2 })
    : totalSets > 0
      ? `${totalSets} set${totalSets === 1 ? '' : 's'} logged`
      : caloriesBurned != null && caloriesBurned > 0
        ? `~${Math.round(caloriesBurned)} kcal`
      : 'Session logged';

  const handleShareImage = async () => {
    try {
      setShareLoading(true);
      const ref = cardRef.current as any;
      if (!ref?.capture) return;
      const uri = await ref.capture();
      const Sharing = await import('expo-sharing');
      const can = await Sharing.isAvailableAsync();
      if (can) {
        await Sharing.shareAsync(uri, {
          mimeType: 'image/png',
          dialogTitle: 'Share Workout',
        });
      } else {
        Alert.alert('Saved', 'Screenshot saved to your device.');
      }
    } catch {
      Alert.alert('Error', 'Could not share the workout.');
    } finally {
      setShareLoading(false);
    }
  };

  const handleShareToStories = async () => {
    try {
      setShareLoading(true);

      const card = cardRef.current as any;
      const captureShareCard = async () => {
        if (!card?.capture) return undefined;
        return await card.capture();
      };
      const instagramShare = await import('../utils/shareToInstagram');
      const storiesAvailable = instagramAvailable || await instagramShare.isInstagramStoriesAvailable();

      if (!storiesAvailable) {
        const imageUri = await captureShareCard();
        if (!imageUri) {
          Alert.alert('Error', 'Share card not ready yet — try again in a moment.');
          setShareLoading(false);
          return;
        }
        const res = await instagramShare.shareToInstagramStories({
          imageUri,
          backgroundTopColor: c.background,
          backgroundBottomColor: c.primary,
        });
        if (!res.ok && res.reason !== 'user_cancelled') {
          Alert.alert(
            'Could not share',
            res.message ?? 'Try again, or use the share sheet to post elsewhere.',
          );
        }
        return;
      }

      // Mirror the ActiveWorkoutScreen share flow: ask whether to
      // include a background photo, then capture the off-screen
      // transparent sticker (NOT the on-screen full-bleed card) so
      // Instagram can composite it over the user's photo or the
      // gradient fallback.
      const photoChoice = await new Promise<'photo' | 'no_photo' | 'cancel'>(resolve => {
        Alert.alert(
          'Share to Instagram Stories',
          'Add a background photo (Strava-style) or share on a gradient?',
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
            { text: 'No photo', onPress: () => resolve('no_photo') },
            { text: 'Choose photo', onPress: () => resolve('photo') },
          ],
          { cancelable: true, onDismiss: () => resolve('cancel') },
        );
      });
      if (photoChoice === 'cancel') {
        setShareLoading(false);
        return;
      }

      let backgroundImage: string | undefined;
      if (photoChoice === 'photo') {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert(
            'Photo access needed',
            'Allow photo library access in Settings to add a background photo, or share without a photo.',
          );
          setShareLoading(false);
          return;
        }
        const pick = await ImagePicker.launchImageLibraryAsync({
          quality: 0.9,
          mediaTypes: ['images'] as any,
          allowsEditing: false,
        });
        if (pick.canceled || !pick.assets?.[0]?.uri) {
          setShareLoading(false);
          return;
        }
        backgroundImage = pick.assets[0].uri;
      }

      const stickerRef = stickerCardRef.current as any;
      if (!stickerRef?.capture) {
        Alert.alert('Error', 'Sticker not ready yet — try again in a moment.');
        setShareLoading(false);
        return;
      }
      const stickerImage = await stickerRef.capture();
      const imageUri = await captureShareCard();

      const res = await instagramShare.shareToInstagramStories({
        imageUri,
        stickerImage,
        backgroundImage,
        backgroundTopColor: c.background,
        backgroundBottomColor: c.primary,
      });
      if (!res.ok && res.reason !== 'user_cancelled') {
        Alert.alert(
          'Could not share',
          res.message ?? 'Try again, or use the share sheet to post elsewhere.',
        );
      }
    } catch {
      Alert.alert('Error', 'Could not share to Stories.');
    } finally {
      setShareLoading(false);
    }
  };

  const friendsSummary = buildPostSummary(session, summary);

  return (
    <>
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={onClose}>
        <View style={styles.backdrop}>
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled">
            <View style={styles.sheet}>
              <View style={styles.header}>
                <Text style={styles.headerTitle}>Share Workout</Text>
                <TouchableOpacity
                  onPress={onClose}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={22} color={c.textMuted} />
                </TouchableOpacity>
              </View>

              <ViewShot ref={cardRef} options={{ format: 'png', quality: 1 }}>
                <View style={styles.shareCard}>
                  <Image
                    source={backgroundSource}
                    style={styles.shareCardBackgroundImage}
                    resizeMode="cover"
                    fadeDuration={0}
                  />
                  <LinearGradient
                    colors={['rgba(0,0,0,0.16)', 'rgba(0,0,0,0.58)', 'rgba(0,0,0,0.86)']}
                    locations={[0, 0.52, 1]}
                    style={styles.shareCardScrim}
                  />
                  <View style={styles.shareCardContent}>
                    <View style={styles.heroHeader}>
                      <Image
                        source={SHARE_LOGO_DARK}
                        style={styles.logo}
                        resizeMode="contain"
                      />
                      <View style={styles.dateBadge}>
                        <Text style={styles.dateBadgeText}>{dateLabel}</Text>
                      </View>
                    </View>

                    <View style={styles.heroBody}>
                      <View style={styles.kickerPill}>
                        <Ionicons name={iconName as any} size={13} color="#fff" />
                        <Text style={styles.kicker}>{typeLabel}</Text>
                      </View>
                      <Text style={styles.focus} numberOfLines={2}>
                        {sessionDisplayFocus || 'Workout'}
                      </Text>
                      <View style={styles.sessionMetaRow}>
                        <Text style={styles.sessionMetaText}>Workout recap</Text>
                        <Text style={styles.sessionMetaText}>{sessionLabel}</Text>
                      </View>
                    </View>

                    <View style={styles.statsGrid}>
                      {metricRows.map(metric => (
                        <View key={metric.key} style={styles.statTile}>
                          <Ionicons name={metric.icon as any} size={14} color="rgba(255,255,255,0.78)" />
                          <Text style={styles.statValue}>{metric.value}</Text>
                          <Text style={styles.statLabel}>{metric.label}</Text>
                        </View>
                      ))}
                    </View>
                    <Text style={styles.shareWatermark}>Tracked with THALLO</Text>
                  </View>
                </View>
              </ViewShot>

              {/* Off-screen Strava-style sticker card. Captured by
                  handleShareToStories and overlaid as a transparent
                  PNG on the user's IG Stories background photo. Kept
                  off-screen so layout still measures it (ViewShot
                  needs a real frame) without flashing it in the UI. */}
              <View pointerEvents="none" style={styles.shareStickerOffscreen}>
                <ViewShot
                  ref={stickerCardRef}
                  options={{ format: 'png', quality: 1, result: 'tmpfile' }}
                  style={styles.shareStickerHost}>
                  <View style={styles.shareStickerInner}>
                    <View style={styles.shareStickerHeader}>
                      <Image
                        source={SHARE_LOGO_DARK}
                        style={styles.shareStickerLogo}
                        resizeMode="contain"
                      />
                      <Text style={styles.shareStickerDate}>{dateLabel}</Text>
                    </View>
                    <Text style={styles.shareStickerKicker}>Workout</Text>
                    <Text style={styles.shareStickerFocus} numberOfLines={2}>
                      {sessionDisplayFocus}
                    </Text>
                    <View style={styles.shareStickerStatRow}>
                      <View style={styles.shareStickerStat}>
                        <Text style={styles.shareStickerStatValue}>
                          {formatDuration(session.durationSeconds || 0)}
                        </Text>
                        <Text style={styles.shareStickerStatLabel}>Duration</Text>
                      </View>
                      {isCardioLike && distanceMiles != null && distanceMiles > 0 ? (
                        <View style={styles.shareStickerStat}>
                          <Text style={styles.shareStickerStatValue}>
                            {formatDistance(distanceMiles, 'mi', { precision: distanceMiles >= 10 ? 0 : 2 })}
                          </Text>
                          <Text style={styles.shareStickerStatLabel}>Distance</Text>
                        </View>
                      ) : totalSets > 0 ? (
                        <View style={styles.shareStickerStat}>
                          <Text style={styles.shareStickerStatValue}>{totalSets}</Text>
                          <Text style={styles.shareStickerStatLabel}>Sets</Text>
                        </View>
                      ) : distanceMiles != null && distanceMiles > 0 ? (
                        <View style={styles.shareStickerStat}>
                          <Text style={styles.shareStickerStatValue}>
                            {formatDistance(distanceMiles, 'mi', { precision: distanceMiles >= 10 ? 0 : 2 })}
                          </Text>
                          <Text style={styles.shareStickerStatLabel}>Distance</Text>
                        </View>
                      ) : caloriesBurned != null && caloriesBurned > 0 ? (
                        <View style={styles.shareStickerStat}>
                          <Text style={styles.shareStickerStatValue}>{Math.round(caloriesBurned)}</Text>
                          <Text style={styles.shareStickerStatLabel}>Kcal</Text>
                        </View>
                      ) : null}
                      {trainingScore != null ? (
                        <View style={styles.shareStickerStat}>
                          <Text style={styles.shareStickerStatValue}>{Math.round(trainingScore)}</Text>
                          <Text style={styles.shareStickerStatLabel}>Score</Text>
                        </View>
                      ) : exerciseCount > 0 ? (
                        <View style={styles.shareStickerStat}>
                          <Text style={styles.shareStickerStatValue}>{exerciseCount}</Text>
                          <Text style={styles.shareStickerStatLabel}>Exercises</Text>
                        </View>
                      ) : null}
                    </View>
                    {(() => {
                      const MAX_ROWS = 6;
                      const { rows: visible, overflow } = buildStickerTopSets(session, MAX_ROWS);
                      if (visible.length === 0) return null;
                      return (
                        <View style={styles.shareStickerExerciseList}>
                          {visible.map((row, i) => (
                            <View key={`${row.exerciseName}-${row.exerciseIndex}-${row.setIndex}-${i}`} style={styles.shareStickerExerciseRow}>
                              <Text style={styles.shareStickerExerciseName} numberOfLines={1}>
                                {row.exerciseName}
                              </Text>
                              <Text style={styles.shareStickerExerciseSets} numberOfLines={1}>
                                {row.summary}
                              </Text>
                            </View>
                          ))}
                          {overflow > 0 ? (
                            <Text style={styles.shareStickerOverflow}>+{overflow} more</Text>
                          ) : null}
                        </View>
                      );
                    })()}
                    <Text style={styles.shareStickerWatermark}>Tracked with THALLO</Text>
                  </View>
                </ViewShot>
              </View>

              <View style={styles.privacyNote}>
                <Ionicons name="lock-closed-outline" size={12} color={c.textMuted} />
                <Text style={styles.privacyNoteText}>
                  Friends see workout stats only. Nutrition and weight stay private.
                </Text>
              </View>

              <View style={styles.shareIconRow}>
                <TouchableOpacity
                  style={[
                    styles.shareIconBtn,
                    { backgroundColor: c.primary, borderColor: c.primary },
                  ]}
                  onPress={() => setFriendsVisible(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Post workout to friends"
                  activeOpacity={0.85}>
                  <Ionicons
                    name="people-outline"
                    size={16}
                    color={getContrastingTextColor(c.primary)}
                  />
                  <Text
                    style={[
                      styles.shareIconBtnText,
                      { color: getContrastingTextColor(c.primary) },
                    ]}>
                    Friends
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="history-share-stories"
                  style={[
                    styles.shareIconBtn,
                    {
                      backgroundColor: instagramAvailable ? '#E1306C' : c.surfaceRaised,
                      borderColor: instagramAvailable ? '#E1306C' : c.border,
                    },
                  ]}
                  onPress={handleShareToStories}
                  disabled={shareLoading}
                  accessibilityRole="button"
                  accessibilityLabel="Share workout to Instagram Stories"
                  activeOpacity={0.85}>
                  <Ionicons name="logo-instagram" size={16} color={instagramAvailable ? '#fff' : c.textPrimary} />
                  <Text style={[styles.shareIconBtnText, { color: instagramAvailable ? '#fff' : c.textPrimary }]}>
                    Story
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  testID="history-share-image"
                  style={[
                    styles.shareIconBtn,
                    {
                      backgroundColor: c.surfaceRaised,
                      borderColor: c.border,
                    },
                  ]}
                  onPress={handleShareImage}
                  disabled={shareLoading}
                  accessibilityRole="button"
                  accessibilityLabel="Share workout image"
                  activeOpacity={0.85}>
                  <Ionicons name="share-outline" size={16} color={c.textPrimary} />
                  <Text style={[styles.shareIconBtnText, { color: c.textPrimary }]}>
                    {shareLoading ? 'Saving' : 'Image'}
                  </Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Text style={styles.closeText}>Close</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <ShareWorkoutModal
        visible={friendsVisible}
        authToken={authToken}
        onClose={() => setFriendsVisible(false)}
        themeName={themeName}
        workoutSummary={friendsVisible ? friendsSummary : null}
      />
    </>
  );
}

const makeStyles = (c: ReturnType<typeof getTheme>['colors']) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    scroll: {
      flexGrow: 1,
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      padding: 16,
      paddingBottom: 28,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 12,
    },
    headerTitle: {
      fontSize: 16,
      fontWeight: '800',
      color: c.textPrimary,
    },
    shareCard: {
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.18)',
      overflow: 'hidden',
      backgroundColor: '#050505',
    },
    shareCardBackgroundImage: {
      ...StyleSheet.absoluteFillObject,
      width: '100%',
      height: '100%',
    },
    shareCardScrim: {
      ...StyleSheet.absoluteFillObject,
    },
    shareCardContent: {
      minHeight: 390,
      padding: 14,
    },
    hero: {
      paddingHorizontal: 14,
      paddingTop: 12,
      paddingBottom: 14,
    },
    heroHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    logo: {
      height: 32,
      width: 130,
    },
    dateBadge: {
      backgroundColor: 'rgba(0,0,0,0.42)',
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.22)',
    },
    dateBadgeText: {
      fontSize: 11,
      fontWeight: '800',
      color: '#fff',
    },
    heroBody: {
      marginTop: 'auto',
      paddingTop: 96,
    },
    kickerPill: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: 'rgba(255,255,255,0.16)',
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.24)',
      paddingHorizontal: 10,
      paddingVertical: 5,
      marginBottom: 9,
    },
    kicker: {
      fontSize: 10,
      fontWeight: '900',
      letterSpacing: 0.8,
      color: '#fff',
      textTransform: 'uppercase',
    },
    focus: {
      fontSize: 31,
      fontWeight: '900',
      color: '#fff',
      lineHeight: 35,
      textShadowColor: 'rgba(0,0,0,0.5)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 4,
    },
    sessionMetaRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 12,
      marginTop: 12,
    },
    sessionMetaText: {
      fontSize: 11,
      color: 'rgba(255,255,255,0.78)',
      fontWeight: '800',
    },
    statsGrid: {
      flexDirection: 'row',
      gap: 7,
      marginTop: 14,
    },
    statTile: {
      flex: 1,
      minWidth: 0,
      backgroundColor: 'rgba(255,255,255,0.12)',
      borderRadius: 10,
      paddingVertical: 9,
      paddingHorizontal: 9,
      borderWidth: 1,
      borderColor: 'rgba(255,255,255,0.18)',
      alignItems: 'flex-start',
      gap: 2,
    },
    statValue: {
      fontSize: 17,
      fontWeight: '900',
      color: '#fff',
      lineHeight: 21,
    },
    statLabel: {
      fontSize: 9,
      fontWeight: '800',
      color: 'rgba(255,255,255,0.62)',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    shareWatermark: {
      fontSize: 10,
      fontWeight: '800',
      color: 'rgba(255,255,255,0.68)',
      textAlign: 'center',
      paddingTop: 12,
      letterSpacing: 1.5,
      textTransform: 'uppercase',
    },
    miniMetrics: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      paddingHorizontal: 14,
      paddingTop: 10,
    },
    miniChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: c.surfaceRaised ?? c.surface,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: c.border,
    },
    miniChipText: {
      fontSize: 11,
      fontWeight: '700',
      color: c.textSecondary,
    },
    achievements: {
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 14,
      gap: 2,
    },
    achievementText: {
      fontSize: 12,
      color: c.primary,
      fontWeight: '600',
    },
    privacyNote: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 12,
      paddingHorizontal: 4,
    },
    privacyNoteText: {
      flex: 1,
      fontSize: 11,
      color: c.textMuted,
      lineHeight: 15,
    },
    shareIconRow: {
      flexDirection: 'row',
      gap: 6,
      marginTop: 8,
    },
    shareIconBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingVertical: 9,
      borderRadius: 10,
      borderWidth: 1,
    },
    shareIconBtnText: {
      fontSize: 11,
      fontWeight: '800',
    },
    closeBtn: {
      alignItems: 'center',
      marginTop: 10,
      paddingVertical: 10,
    },
    closeText: {
      fontSize: 13,
      fontWeight: '700',
      color: c.textMuted,
    },
    // ── Off-screen Strava-style sticker (transparent capture) ────────
    // Mirrors the ActiveWorkoutScreen sticker styles 1:1 so the IG
    // Stories share looks identical regardless of entry point.
    shareStickerOffscreen: {
      position: 'absolute',
      left: -10000,
      top: -10000,
      width: 360,
      height: 640,
    },
    shareStickerHost: {
      width: 360,
      height: 640,
      backgroundColor: 'transparent',
    },
    shareStickerInner: {
      flex: 1,
      paddingHorizontal: 18,
      paddingTop: 14,
      paddingBottom: 16,
    },
    shareStickerHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 14,
    },
    shareStickerLogo: { width: 130, height: 32 },
    shareStickerDate: {
      fontSize: 11,
      fontWeight: '800',
      color: '#fff',
      letterSpacing: 0.4,
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    shareStickerKicker: {
      fontSize: 11,
      fontWeight: '900',
      color: c.primary,
      textTransform: 'uppercase',
      letterSpacing: 1.4,
      marginBottom: 4,
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    shareStickerFocus: {
      fontSize: 30,
      fontWeight: '900',
      color: '#fff',
      letterSpacing: -0.6,
      lineHeight: 34,
      marginBottom: 18,
      textShadowColor: 'rgba(0,0,0,0.6)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 4,
    },
    shareStickerStatRow: {
      flexDirection: 'row',
      gap: 18,
      marginBottom: 18,
    },
    shareStickerStat: { alignItems: 'flex-start', gap: 1 },
    shareStickerStatValue: {
      fontSize: 26,
      fontWeight: '900',
      color: '#fff',
      lineHeight: 30,
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 4,
    },
    shareStickerStatLabel: {
      fontSize: 10,
      fontWeight: '900',
      // Pure white — sticker overlays the user's photo, alpha < 1
      // washes out on bright backgrounds. Bold + drop shadow carry
      // legibility on dark photos.
      color: '#fff',
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    shareStickerExerciseList: {
      gap: 8,
      paddingTop: 4,
      borderTopWidth: 1,
      borderTopColor: 'rgba(255,255,255,0.25)',
      marginTop: 2,
    },
    shareStickerExerciseRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 10,
      paddingTop: 6,
    },
    shareStickerExerciseName: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
      fontSize: 14,
      fontWeight: '800',
      color: '#fff',
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    shareStickerExerciseSets: {
      flexShrink: 0,
      maxWidth: '55%',
      textAlign: 'right',
      fontSize: 12,
      fontWeight: '800',
      color: '#fff',
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    shareStickerOverflow: {
      fontSize: 11,
      fontWeight: '800',
      color: '#fff',
      fontStyle: 'italic',
      paddingTop: 2,
      textShadowColor: 'rgba(0,0,0,0.55)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    shareStickerWatermark: {
      position: 'absolute',
      bottom: 14,
      left: 18,
      right: 18,
      textAlign: 'center',
      fontSize: 10,
      fontWeight: '900',
      color: '#fff',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
      textShadowColor: 'rgba(0,0,0,0.5)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
  });
