// Exercise demo video card — thumbnail preview that opens the in-app
// FormVideoModal on tap. The card is purely VISUAL — the actual video
// playback still flows through FormVideoModal / `/ai/exercise-video`.
//
// Preview source:
//   - Bundled Move Kit demo video when this exercise has a match.
//   - Hosted WorkoutX GIF when available.
//   - No media → a branded placeholder tile that opens the demo modal.
//
// onPress always invokes openExerciseVideo (FormVideoModal).

import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { moveKitDemoVideo } from '../utils/exerciseDemo';
import ExerciseThumbMedia from './ExerciseThumbMedia';
import { loadWorkoutXDemoPreview } from '../utils/workoutxDemoPreview';

interface Props {
  exerciseName: string;
  videoId?: string | null;
  /** Legacy demo id, retained only for Move Kit video matching. */
  demoExerciseDbId?: string | null;
  authToken?: string | null;
  equipment?: string | null;
  primaryMuscle?: string | null;
  movementPattern?: string | null;
  themeName?: AppThemeName;
  /** Invoked on tap. Typically wired to the parent's openExerciseVideo
   *  callback which opens FormVideoModal. */
  onPress?: () => void;
}

export default function ExerciseVideoCard({
  exerciseName,
  demoExerciseDbId,
  authToken,
  equipment,
  primaryMuscle,
  movementPattern,
  themeName,
  onPress,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const onPrimary = getContrastingTextColor(tc.primary);

  const moveKitVideo = moveKitDemoVideo(demoExerciseDbId, exerciseName);
  const isMoveKitFrame = !!moveKitVideo;
  const [workoutxGifUrl, setWorkoutxGifUrl] = useState<string | null>(null);
  const [workoutxLabel, setWorkoutxLabel] = useState<string | null>(null);
  const [workoutxLoading, setWorkoutxLoading] = useState(false);
  const [workoutxErrored, setWorkoutxErrored] = useState(false);
  const isWorkoutXFrame = !isMoveKitFrame && !!workoutxGifUrl && !workoutxErrored;

  useEffect(() => {
    setWorkoutxGifUrl(null);
    setWorkoutxLabel(null);
    setWorkoutxErrored(false);
    if (isMoveKitFrame || !authToken || !exerciseName) {
      setWorkoutxLoading(false);
      return;
    }

    let cancelled = false;
    setWorkoutxLoading(true);
    loadWorkoutXDemoPreview({
      authToken,
      exerciseName,
      equipment,
      primaryMuscle,
      movementPattern,
    }).then((demo) => {
      if (cancelled) return;
      setWorkoutxGifUrl(demo?.gifUrl ?? null);
      setWorkoutxLabel(demo?.label ?? null);
      setWorkoutxErrored(!demo);
    }).catch(() => {
      if (!cancelled) setWorkoutxErrored(true);
    }).finally(() => {
      if (!cancelled) setWorkoutxLoading(false);
    });

    return () => { cancelled = true; };
  }, [authToken, equipment, exerciseName, isMoveKitFrame, movementPattern, primaryMuscle]);

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={{
        borderRadius: radius.lg, overflow: 'hidden',
        backgroundColor: tc.surface, borderWidth: 3, borderColor: tc.primary,
        marginBottom: 12,
      }}
    >
      <View style={{
        position: 'relative', width: '100%',
        aspectRatio: 16 / 9,
        backgroundColor: isMoveKitFrame ? '#000000' : isWorkoutXFrame ? '#FFFFFF' : tc.surface,
      }}>
        {isMoveKitFrame ? (
          <ExerciseThumbMedia
            exerciseName={exerciseName}
            demoExerciseDbId={demoExerciseDbId}
            style={{ width: '100%', height: '100%' }}
            imageResizeMode="cover"
            shouldPlayVideo
          />
        ) : isWorkoutXFrame ? (
          <Image
            source={{ uri: workoutxGifUrl! }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="contain"
            onError={() => setWorkoutxErrored(true)}
          />
        ) : (
          <View style={{
            width: '100%', height: '100%',
            backgroundColor: tc.primary + '1A',
            alignItems: 'center', justifyContent: 'center',
            paddingHorizontal: 16,
          }}>
            <View style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: tc.primary + '14',
            }} />
            <Ionicons name="fitness" size={32} color={tc.primary + 'AA'} style={{ marginBottom: 10 }} />
            <Text style={{
              fontSize: 14, fontWeight: '800', color: tc.textPrimary,
              textAlign: 'center',
            }} numberOfLines={2}>
              {exerciseName}
            </Text>
            <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 4, letterSpacing: 0.5, fontWeight: '600' }}>
              {workoutxLoading ? 'LOADING DEMO' : 'TAP FOR FORM DEMOS'}
            </Text>
            {workoutxLoading && (
              <ActivityIndicator color={tc.primary} size="small" style={{ marginTop: 10 }} />
            )}
          </View>
        )}
        {(isMoveKitFrame || isWorkoutXFrame) && (
          <View pointerEvents="none" style={{
            position: 'absolute', left: 0, right: 0, bottom: 0, height: '45%',
            backgroundColor: 'rgba(0,0,0,0.25)',
          }} />
        )}
        {/* Play overlay — softer (was 0.55 opacity, now 0.38), smaller
            circle so the thumbnail is the hero. */}
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <View style={{
            width: 54, height: 54, borderRadius: 27,
            backgroundColor: 'rgba(0,0,0,0.38)',
            borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name="play" size={22} color="#fff" style={{ marginLeft: 3 }} />
          </View>
        </View>
        {(isMoveKitFrame || isWorkoutXFrame) && (
          <View style={{
            position: 'absolute', bottom: 8, right: 10,
            backgroundColor: tc.primary,
            paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
          }}>
            <Text style={{ fontSize: 10, fontWeight: '800', color: onPrimary, letterSpacing: 0.5 }}>
              {isWorkoutXFrame ? 'WORKOUTX PREVIEW' : 'FORM PREVIEW'}
            </Text>
          </View>
        )}
      </View>
      <View style={{ padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name="play-circle" size={16} color={tc.primary} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
            {isMoveKitFrame || isWorkoutXFrame ? 'Tap for form demo + videos' : 'Open form demos'}
          </Text>
          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>
            {isMoveKitFrame
              ? 'Move Kit demo above · more videos on tap'
              : isWorkoutXFrame
                ? `${workoutxLabel ?? 'WorkoutX'} demo above · more videos on tap`
                : 'WorkoutX / YouTube form demos'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color={tc.textMuted} />
      </View>
    </TouchableOpacity>
  );
}
