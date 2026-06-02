import React, { useEffect, useState } from 'react';
import { View, Image, ImageSourcePropType } from 'react-native';
import { ResizeMode, Video } from 'expo-av';

import { demoFrameSource, moveKitDemoVideo } from '../utils/exerciseDemo';

interface Props {
  /** Resolved demo id from the backend (null when this exercise has no
   *  free-exercise-db match — component falls back to `fallbackThumbSrc`). */
  demoExerciseDbId?: string | null;
  /** Exercise name is the preferred Move Kit lookup key. */
  exerciseName?: string | null;
  /** Tail-end fallback (typically a YouTube thumbnail source or null).
   *  Used only when no bundled demo id is available. */
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
// real estate. 3:2 to match the source photo aspect (850x567).
const EXPANDED_W = 240;
const EXPANDED_H = 160;
const CYCLE_MS = 900;

export default function LiveExerciseDemoThumb({
  demoExerciseDbId, exerciseName, fallbackThumbSrc, isExpanded, accentColor, surfaceColor, onPress, shouldPlayVideo = false,
}: Props) {
  const [videoErrored, setVideoErrored] = useState(false);
  useEffect(() => {
    setVideoErrored(false);
  }, [demoExerciseDbId, exerciseName]);

  const video = moveKitDemoVideo(demoExerciseDbId, exerciseName);
  const showVideo = !!video && !videoErrored;
  const lockoutSrc = demoFrameSource(demoExerciseDbId, 1);
  const bottomSrc = demoFrameSource(demoExerciseDbId, 0);
  const hasDemo = !!lockoutSrc;
  // Anything past the bundled demos is a remote URI (typically YouTube),
  // so demo-mode treatment only kicks in when we have local media.
  const treatAsDemo = hasDemo || showVideo;

  // Two-frame cycling — only runs while the card is expanded so collapsed
  // rows aren't running 100 useless intervals on long workouts.
  const [frame, setFrame] = useState<0 | 1>(1);
  useEffect(() => {
    if (!isExpanded || !hasDemo || showVideo) {
      setFrame(1);
      return;
    }
    const t = setInterval(() => setFrame(f => (f === 0 ? 1 : 0)), CYCLE_MS);
    return () => clearInterval(t);
  }, [isExpanded, hasDemo, showVideo]);

  const w = isExpanded ? EXPANDED_W : COLLAPSED_SIZE;
  const h = isExpanded ? EXPANDED_H : COLLAPSED_SIZE;
  const radius = isExpanded ? 12 : 10;

  const containerStyle = {
    width: w,
    height: h,
    borderRadius: radius,
    backgroundColor: showVideo ? '#000000' : (treatAsDemo ? '#FFFFFF' : surfaceColor),
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
  // Expanded view is the only place the photo is large enough that
  // contain (with the 3:2 container) shows the full frame intelligibly.
  // Collapsed (52x52) and YouTube fallbacks both look better with cover
  // (figure-centred crop).
  const fitMode = (isExpanded && hasDemo) ? ('contain' as const) : ('cover' as const);

  if (!showVideo && !hasDemo && !fallbackThumbSrc) return null;

  return (
    <View style={containerStyle}>
      {showVideo ? (
        <Video
          pointerEvents="none"
          source={video!.source}
          style={imageStyle}
          resizeMode={ResizeMode.CONTAIN}
          shouldPlay={shouldPlayVideo}
          isLooping={shouldPlayVideo}
          isMuted
          onError={() => setVideoErrored(true)}
        />
      ) : hasDemo ? (
        <>
          <Image
            source={bottomSrc!}
            style={[imageStyle, { position: 'absolute', top: 0, left: 0, opacity: frame === 0 ? 1 : 0 }]}
            resizeMode={fitMode}
          />
          <Image
            source={lockoutSrc!}
            style={[imageStyle, { position: 'absolute', top: 0, left: 0, opacity: frame === 1 ? 1 : 0 }]}
            resizeMode={fitMode}
          />
        </>
      ) : fallbackThumbSrc ? (
        <Image source={fallbackThumbSrc} style={imageStyle} resizeMode={fitMode} />
      ) : null}
    </View>
  );
}
