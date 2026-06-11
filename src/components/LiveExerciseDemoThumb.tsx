import React, { useEffect, useState } from 'react';
import { View, ImageSourcePropType } from 'react-native';
import { ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';

import { moveKitDemoVideo } from '../utils/exerciseDemo';
import ExerciseThumbMedia, { hasExerciseThumbMedia } from './ExerciseThumbMedia';

interface Props {
  /** Resolved demo id from the backend (null when this exercise has no
   *  Move Kit match — component falls back to `fallbackThumbSrc`). */
  demoExerciseDbId?: string | null;
  /** Exercise name is the preferred Move Kit lookup key. */
  exerciseName?: string | null;
  authToken?: string | null;
  equipment?: string | null;
  primaryMuscle?: string | null;
  movementPattern?: string | null;
  /** Tail-end fallback (typically a YouTube thumbnail source or null).
   *  Used only when Move Kit and WorkoutX are unavailable. */
  fallbackThumbSrc?: ImageSourcePropType | null;
  /** Tied to the exercise card's expand state. Drives both the size
   *  transition and whether to start cycling between the two demo frames. */
  isExpanded: boolean;
  /** Theme accent color, used for the border. */
  accentColor: string;
  /** Surface color to fill behind the image (used for non-demo fallback;
   *  demo frames sit on white because the source photos are white-bg). */
  surfaceColor: string;
  /** Kept for compatibility — currently unused. The thumbnail is purely
   *  decorative; the toolbar's "Form Videos" button is the entry point. */
  onPress?: () => void;
  /** Only true for an intentional, user-focused preview surface. Live
   *  workout rows keep videos paused to avoid background decode work. */
  shouldPlayVideo?: boolean;
}

const COLLAPSED_SIZE = 52;
// Expanded mode now sits centered below the exercise name (the layout
// change moved the thumbnail out of the header row), so we can give it
// real estate.
const EXPANDED_W = 240;
const EXPANDED_H = 160;

export default function LiveExerciseDemoThumb({
  demoExerciseDbId, exerciseName, authToken, equipment, primaryMuscle, movementPattern, fallbackThumbSrc, isExpanded, accentColor, surfaceColor, onPress, shouldPlayVideo = false,
}: Props) {
  const [videoErrored, setVideoErrored] = useState(false);
  useEffect(() => {
    setVideoErrored(false);
  }, [demoExerciseDbId, exerciseName]);

  const video = moveKitDemoVideo(demoExerciseDbId, exerciseName);
  const showVideo = !!video && !videoErrored;
  const hasMedia = hasExerciseThumbMedia({
    exerciseName,
    demoExerciseDbId,
    fallbackSource: fallbackThumbSrc,
    authToken,
    allowHostedFallback: true,
  });

  const w = isExpanded ? EXPANDED_W : COLLAPSED_SIZE;
  const h = isExpanded ? EXPANDED_H : COLLAPSED_SIZE;
  const radius = isExpanded ? 12 : 10;

  const containerStyle = {
    width: w,
    height: h,
    borderRadius: radius,
    backgroundColor: showVideo ? '#000000' : surfaceColor,
    borderWidth: 1.5,
    borderColor: accentColor,
    position: 'relative' as const,
    overflow: 'hidden' as const,
    shadowColor: accentColor,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: isExpanded ? 0.5 : 0.75,
    shadowRadius: isExpanded ? 10 : 8,
    elevation: isExpanded ? 8 : 6,
  };

  const imageStyle = {
    width: '100%' as const, height: '100%' as const,
  };

  if (!hasMedia) return null;

  return (
    <View style={containerStyle}>
      <ExerciseThumbMedia
        exerciseName={exerciseName}
        demoExerciseDbId={demoExerciseDbId}
        fallbackSource={fallbackThumbSrc}
        authToken={authToken}
        equipment={equipment}
        primaryMuscle={primaryMuscle}
        movementPattern={movementPattern}
        style={imageStyle}
        videoResizeMode={ResizeMode.CONTAIN}
        shouldPlayVideo={shouldPlayVideo}
        placeholder={(
          <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="play" size={isExpanded ? 24 : 16} color={accentColor} style={{ marginLeft: 2 }} />
          </View>
        )}
      />
    </View>
  );
}
