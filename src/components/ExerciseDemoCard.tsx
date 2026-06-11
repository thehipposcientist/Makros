import React, { useEffect, useState } from 'react';
import { View, Text, Image, ActivityIndicator } from 'react-native';
import { ResizeMode, Video } from 'expo-av';

import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { moveKitDemoVideo } from '../utils/exerciseDemo';

interface Props {
  /** Legacy demo identifier, retained as a Move Kit lookup key. */
  demoExerciseDbId: string | null | undefined;
  /** Display name wins for Move Kit because some legacy demo ids are shared fallbacks. */
  exerciseName?: string | null;
  /** Hosted WorkoutX GIF. Used whenever no Move Kit video exists. */
  workoutxGifUrl?: string | null;
  workoutxLabel?: string | null;
  themeName?: AppThemeName;
  onDemoUnavailable?: (kind: 'moveKit' | 'workoutx') => void;
}

export default function ExerciseDemoCard({
  demoExerciseDbId,
  exerciseName,
  workoutxGifUrl,
  workoutxLabel,
  themeName,
  onDemoUnavailable,
}: Props) {
  const tc = getTheme(themeName).colors;
  const accent = tc.primary;
  const muted = tc.textMuted;

  const [videoReady, setVideoReady] = useState(false);
  const [videoErrored, setVideoErrored] = useState(false);
  const [workoutxLoaded, setWorkoutxLoaded] = useState(false);
  const [workoutxErrored, setWorkoutxErrored] = useState(false);

  useEffect(() => {
    setVideoReady(false);
    setVideoErrored(false);
    setWorkoutxLoaded(false);
    setWorkoutxErrored(false);
  }, [demoExerciseDbId, exerciseName, workoutxGifUrl]);

  const video = moveKitDemoVideo(demoExerciseDbId, exerciseName);
  const useVideo = !!video && !videoErrored;
  const useWorkoutX = !useVideo && !!workoutxGifUrl && !workoutxErrored;
  if (!useVideo && !useWorkoutX) return null;

  return (
    <View style={{
      backgroundColor: tc.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: tc.border,
      padding: 14,
      gap: 10,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ fontSize: 11, fontWeight: '800', color: muted, letterSpacing: 0.6 }}>
          FORM DEMO
        </Text>
        <View style={{
          paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
          backgroundColor: accent + '1F', borderWidth: 1, borderColor: accent + '44',
        }}>
          <Text style={{ fontSize: 9, fontWeight: '800', color: accent, letterSpacing: 0.5 }}>
            {useVideo ? 'MOVE KIT VIDEO' : 'WORKOUTX GIF'}
          </Text>
        </View>
      </View>

      <View style={{
        width: '100%',
        aspectRatio: useVideo || useWorkoutX ? 16 / 9 : 3 / 2,
        backgroundColor: useVideo ? '#000000' : '#FFFFFF',
        borderRadius: radius.md,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: tc.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        {useVideo ? (
          <>
            {!videoReady && <ActivityIndicator color={accent} />}
            <Video
              source={video!.source}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
              isLooping
              isMuted
              onReadyForDisplay={() => setVideoReady(true)}
              onError={() => {
                setVideoErrored(true);
                onDemoUnavailable?.('moveKit');
              }}
            />
          </>
        ) : useWorkoutX ? (
          <>
            {!workoutxLoaded && !workoutxErrored && <ActivityIndicator color={accent} />}
            <Image
              source={{ uri: workoutxGifUrl! }}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
              resizeMode="contain"
              onLoad={() => setWorkoutxLoaded(true)}
              onError={() => {
                setWorkoutxErrored(true);
                onDemoUnavailable?.('workoutx');
              }}
            />
          </>
        ) : null}
      </View>

      <Text style={{ fontSize: 10, color: muted, textAlign: 'center', lineHeight: 14 }}>
        {useVideo
          ? 'Looping demo via Move Kit.'
          : `Hosted movement demo via WorkoutX${workoutxLabel ? `: ${workoutxLabel}` : ''}.`}
      </Text>
    </View>
  );
}
