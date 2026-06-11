import React, { useEffect, useState } from 'react';
import { Image, ImageSourcePropType, StyleProp, View, ViewStyle } from 'react-native';
import { ResizeMode, Video } from 'expo-av';

import { moveKitDemoVideo } from '../utils/exerciseDemo';
import { loadWorkoutXDemoPreview } from '../utils/workoutxDemoPreview';

interface Props {
  exerciseName?: string | null;
  demoExerciseDbId?: string | null;
  fallbackSource?: ImageSourcePropType | null;
  authToken?: string | null;
  equipment?: string | null;
  primaryMuscle?: string | null;
  movementPattern?: string | null;
  style: StyleProp<ViewStyle>;
  imageResizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  workoutxResizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  videoResizeMode?: ResizeMode;
  shouldPlayVideo?: boolean;
  placeholder?: React.ReactNode;
}

export function hasExerciseThumbMedia(opts: {
  exerciseName?: string | null;
  demoExerciseDbId?: string | null;
  fallbackSource?: ImageSourcePropType | null;
  authToken?: string | null;
  allowHostedFallback?: boolean;
}): boolean {
  return (
    !!moveKitDemoVideo(opts.demoExerciseDbId, opts.exerciseName)
    || !!opts.fallbackSource
    || !!(opts.allowHostedFallback && opts.authToken && opts.exerciseName)
  );
}

export default function ExerciseThumbMedia({
  exerciseName,
  demoExerciseDbId,
  fallbackSource,
  authToken,
  equipment,
  primaryMuscle,
  movementPattern,
  style,
  imageResizeMode = 'cover',
  workoutxResizeMode = 'contain',
  videoResizeMode = ResizeMode.COVER,
  shouldPlayVideo = false,
  placeholder,
}: Props) {
  const [videoErrored, setVideoErrored] = useState(false);
  const [workoutxGifUrl, setWorkoutxGifUrl] = useState<string | null>(null);
  const [workoutxErrored, setWorkoutxErrored] = useState(false);
  const [workoutxLoading, setWorkoutxLoading] = useState(false);
  const [workoutxSettledKey, setWorkoutxSettledKey] = useState<string | null>(null);

  useEffect(() => {
    setVideoErrored(false);
  }, [demoExerciseDbId, exerciseName]);

  const video = moveKitDemoVideo(demoExerciseDbId, exerciseName);
  const shouldFetchWorkoutX = !video && !!authToken && !!exerciseName;
  const workoutxLookupKey = [
    exerciseName ?? '',
    equipment ?? '',
    primaryMuscle ?? '',
    movementPattern ?? '',
  ].join('|').toLowerCase();
  const workoutxSettled = !shouldFetchWorkoutX || workoutxSettledKey === workoutxLookupKey;

  useEffect(() => {
    let cancelled = false;
    setWorkoutxGifUrl(null);
    setWorkoutxErrored(false);
    setWorkoutxSettledKey(null);
    if (!shouldFetchWorkoutX) {
      setWorkoutxLoading(false);
      return;
    }
    setWorkoutxLoading(true);
    loadWorkoutXDemoPreview({
      authToken,
      exerciseName,
      equipment,
      primaryMuscle,
      movementPattern,
    }).then((demo) => {
      if (!cancelled) {
        setWorkoutxGifUrl(demo?.gifUrl ?? null);
        setWorkoutxErrored(!demo);
        setWorkoutxSettledKey(workoutxLookupKey);
      }
    }).catch(() => {
      if (!cancelled) {
        setWorkoutxErrored(true);
        setWorkoutxSettledKey(workoutxLookupKey);
      }
    }).finally(() => {
      if (!cancelled) setWorkoutxLoading(false);
    });
    return () => { cancelled = true; };
  }, [authToken, equipment, exerciseName, movementPattern, primaryMuscle, shouldFetchWorkoutX, workoutxLookupKey]);

  if (video && !videoErrored) {
    return (
      <Video
        pointerEvents="none"
        source={video.source}
        style={style}
        resizeMode={videoResizeMode}
        shouldPlay={shouldPlayVideo}
        isLooping={shouldPlayVideo}
        isMuted
        onError={() => setVideoErrored(true)}
      />
    );
  }

  if (workoutxGifUrl && !workoutxErrored && workoutxSettled) {
    return (
      <Image
        source={{ uri: workoutxGifUrl }}
        style={style as any}
        resizeMode={workoutxResizeMode}
        onError={() => setWorkoutxErrored(true)}
      />
    );
  }

  if (shouldFetchWorkoutX && (workoutxLoading || !workoutxSettled)) {
    return placeholder ? <View style={style}>{placeholder}</View> : null;
  }

  if (fallbackSource) {
    return <Image source={fallbackSource} style={style as any} resizeMode={imageResizeMode} />;
  }

  return placeholder ? <View style={style}>{placeholder}</View> : null;
}
