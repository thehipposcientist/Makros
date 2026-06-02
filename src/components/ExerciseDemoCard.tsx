import React, { useEffect, useState } from 'react';
import { View, Text, Image, ActivityIndicator } from 'react-native';
import { ResizeMode, Video } from 'expo-av';

import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { demoFrameSource, moveKitDemoVideo } from '../utils/exerciseDemo';

interface Props {
  /** free-exercise-db identifier — used for old frame fallback and some Move Kit matches. */
  demoExerciseDbId: string | null | undefined;
  /** Display name wins for Move Kit because some legacy demo ids are shared fallbacks. */
  exerciseName?: string | null;
  themeName?: AppThemeName;
  /** Cycle interval (ms) between bottom and top frame. Defaults to 900ms
   *  which matches a comfortable rep cadence. */
  cycleMs?: number;
}

export default function ExerciseDemoCard({ demoExerciseDbId, exerciseName, themeName, cycleMs = 900 }: Props) {
  const tc = getTheme(themeName).colors;
  const accent = tc.primary;
  const muted = tc.textMuted;

  const [frame, setFrame] = useState<0 | 1>(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [videoErrored, setVideoErrored] = useState(false);

  useEffect(() => {
    setFrame(0);
    setLoaded(false);
    setErrored(false);
    setVideoReady(false);
    setVideoErrored(false);
  }, [demoExerciseDbId, exerciseName]);

  useEffect(() => {
    if (!demoExerciseDbId || !loaded) return;
    const t = setInterval(() => setFrame(f => (f === 0 ? 1 : 0)), cycleMs);
    return () => clearInterval(t);
  }, [demoExerciseDbId, loaded, cycleMs]);

  const video = moveKitDemoVideo(demoExerciseDbId, exerciseName);
  const useVideo = !!video && !videoErrored;
  const src0 = demoFrameSource(demoExerciseDbId, 0);
  const src1 = demoFrameSource(demoExerciseDbId, 1);
  if (!useVideo && (!demoExerciseDbId || !src0 || !src1)) return null;

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
            {useVideo ? 'MOVE KIT VIDEO' : (frame === 0 ? 'BOTTOM POSITION' : 'TOP / LOCKOUT')}
          </Text>
        </View>
      </View>

      <View style={{
        width: '100%',
        aspectRatio: useVideo ? 16 / 9 : 3 / 2,
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
              onError={() => setVideoErrored(true)}
            />
          </>
        ) : (
          <>
            {!loaded && !errored && <ActivityIndicator color={accent} />}
            {errored ? (
              <View style={{ padding: 20, alignItems: 'center' }}>
                <Text style={{ fontSize: 12, color: muted, textAlign: 'center' }}>
                  Couldn't load the demo image. Check your connection.
                </Text>
              </View>
            ) : (
              <>
                {/* Explicit width/height + position:absolute. The previous
                    shape (top/left/right/bottom: 0, no width/height) caused
                    the New Architecture image renderer to fall back to the
                    source's intrinsic 850x567 dimensions, which got clipped
                    by the smaller parent — looked like a heavy zoom-in. */}
                <Image
                  source={src0!}
                  style={{
                    position: 'absolute', top: 0, left: 0,
                    width: '100%', height: '100%',
                    opacity: frame === 0 ? 1 : 0,
                  }}
                  resizeMode="cover"
                  onLoad={() => setLoaded(true)}
                  onError={() => setErrored(true)}
                />
                <Image
                  source={src1!}
                  style={{
                    position: 'absolute', top: 0, left: 0,
                    width: '100%', height: '100%',
                    opacity: frame === 1 ? 1 : 0,
                  }}
                  resizeMode="cover"
                />
              </>
            )}
          </>
        )}
      </View>

      <Text style={{ fontSize: 10, color: muted, textAlign: 'center', lineHeight: 14 }}>
        {useVideo ? 'Looping demo via Move Kit. Watch a tutorial below for coaching context.' : 'Two-frame demo via free-exercise-db. Watch a video below for full motion.'}
      </Text>
    </View>
  );
}
