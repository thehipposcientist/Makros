import React, { useEffect, useState } from 'react';
import { Image, ImageSourcePropType, StyleProp, ViewStyle } from 'react-native';
import { ResizeMode, Video } from 'expo-av';

import { demoLockoutSource, moveKitDemoVideo } from '../utils/exerciseDemo';

interface Props {
  exerciseName?: string | null;
  demoExerciseDbId?: string | null;
  fallbackSource?: ImageSourcePropType | null;
  style: StyleProp<ViewStyle>;
  imageResizeMode?: 'cover' | 'contain' | 'stretch' | 'repeat' | 'center';
  videoResizeMode?: ResizeMode;
  shouldPlayVideo?: boolean;
}

export function hasExerciseThumbMedia(opts: {
  exerciseName?: string | null;
  demoExerciseDbId?: string | null;
  fallbackSource?: ImageSourcePropType | null;
}): boolean {
  return (
    !!moveKitDemoVideo(opts.demoExerciseDbId, opts.exerciseName)
    || !!demoLockoutSource(opts.demoExerciseDbId)
    || !!opts.fallbackSource
  );
}

export default function ExerciseThumbMedia({
  exerciseName,
  demoExerciseDbId,
  fallbackSource,
  style,
  imageResizeMode = 'cover',
  videoResizeMode = ResizeMode.COVER,
  shouldPlayVideo = false,
}: Props) {
  const [videoErrored, setVideoErrored] = useState(false);

  useEffect(() => {
    setVideoErrored(false);
  }, [demoExerciseDbId, exerciseName]);

  const video = moveKitDemoVideo(demoExerciseDbId, exerciseName);
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

  // Move Kit video is preferred above; this keeps the old bundled
  // free-exercise-db frame as the offline fallback for exercises
  // without a Move Kit match.
  const imageSource = demoLockoutSource(demoExerciseDbId) ?? fallbackSource;
  return imageSource ? (
    <Image source={imageSource} style={style as any} resizeMode={imageResizeMode} />
  ) : null;
}
