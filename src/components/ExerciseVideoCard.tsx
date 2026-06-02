// Exercise demo video card — thumbnail preview that opens the in-app
// FormVideoModal on tap. The card is purely VISUAL — the actual video
// playback still flows through FormVideoModal / `/ai/exercise-video`
// (embedded YouTube WebView). This gives users an at-a-glance preview
// without leaving the app.
//
// Preview source:
//   - Bundled Move Kit demo video when this exercise has a match.
//   - Older bundled free-exercise-db frame when there is no Move Kit match.
//   - Curated or auto-scraped YouTube video (`videoId`) thumbnail.
//   - No media → a branded placeholder tile.
//
// Legal framing:
//   - Thumbnails are served by `img.youtube.com` (hotlinking allowed,
//     same as Twitter/Discord/Reddit previews).
//   - YouTube playback still routes through the embed iframe — no download,
//     no rehost.
//
// onPress always invokes openExerciseVideo (FormVideoModal).

import { View, Text, TouchableOpacity, ImageSourcePropType } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { demoLockoutSource, moveKitDemoVideo } from '../utils/exerciseDemo';
import ExerciseThumbMedia from './ExerciseThumbMedia';

interface Props {
  exerciseName: string;
  videoId?: string | null;
  /** free-exercise-db id — when present, the lockout photo frame is
   *  used as the thumbnail instead of the YouTube thumbnail. */
  demoExerciseDbId?: string | null;
  themeName?: AppThemeName;
  /** Invoked on tap. Typically wired to the parent's openExerciseVideo
   *  callback which opens FormVideoModal. */
  onPress?: () => void;
}

function ytThumb(id: string): string {
  // hqdefault is a safe bet on every public video (480×360). maxresdefault
  // isn't guaranteed to exist, so we avoid it.
  return `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
}

export default function ExerciseVideoCard({ exerciseName, videoId, demoExerciseDbId, themeName, onPress }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const onPrimary = getContrastingTextColor(tc.primary);

  // Prefer the bundled Move Kit demo video, then the older bundled
  // free-exercise-db lockout frame, then the YouTube thumbnail.
  const demoSrc = demoLockoutSource(demoExerciseDbId);
  const moveKitVideo = moveKitDemoVideo(demoExerciseDbId, exerciseName);
  const ytSrc: ImageSourcePropType | null = videoId ? { uri: ytThumb(videoId) } : null;
  const thumbSrc = demoSrc ?? ytSrc;
  const isDemoFrame = !!demoSrc;
  const isMoveKitFrame = !!moveKitVideo;

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
        // Bundled demo frames are 3:2 (850x567); YouTube thumbs are 16:9.
        aspectRatio: isDemoFrame && !isMoveKitFrame ? 3 / 2 : 16 / 9,
        // Demo photos sit on a neutral light background; the YouTube
        // thumbnail covers fully so no surface color shows through.
        backgroundColor: isMoveKitFrame ? '#000000' : (isDemoFrame ? '#F5F5F5' : tc.surface),
      }}>
        {thumbSrc || isMoveKitFrame ? (
          <ExerciseThumbMedia
            exerciseName={exerciseName}
            demoExerciseDbId={demoExerciseDbId}
            fallbackSource={ytSrc}
            style={{ width: '100%', height: '100%' }}
            imageResizeMode={isDemoFrame && !isMoveKitFrame ? 'contain' : 'cover'}
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
              TAP FOR YOUTUBE FORM DEMO
            </Text>
          </View>
        )}
        {/* Light bottom-only gradient — ensures the "YouTube" badge stays
            readable without darkening the whole thumbnail. Top 60% of
            the image is fully unaltered so the form preview stays clear. */}
        {(thumbSrc || isMoveKitFrame) && (
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
        {thumbSrc && !isDemoFrame && !isMoveKitFrame && (
          <View style={{
            position: 'absolute', bottom: 8, right: 10,
            backgroundColor: 'rgba(0,0,0,0.72)',
            paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
            flexDirection: 'row', alignItems: 'center', gap: 5,
          }}>
            <Ionicons name="logo-youtube" size={11} color="#FF0000" />
            <Text style={{ fontSize: 10, fontWeight: '700', color: '#fff', letterSpacing: 0.3 }}>
              YOUTUBE
            </Text>
          </View>
        )}
        {(isDemoFrame || isMoveKitFrame) && (
          <View style={{
            position: 'absolute', bottom: 8, right: 10,
            backgroundColor: tc.primary,
            paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
          }}>
            <Text style={{ fontSize: 10, fontWeight: '800', color: onPrimary, letterSpacing: 0.5 }}>
              FORM PREVIEW
            </Text>
          </View>
        )}
      </View>
      <View style={{ padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name="play-circle" size={16} color={tc.primary} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
            {isDemoFrame || isMoveKitFrame ? 'Tap for form demo + videos' : 'Watch form video'}
          </Text>
          <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>
            {isMoveKitFrame ? 'Move Kit demo above · video on tap' : (isDemoFrame ? 'Static frame above · video on tap' : 'YouTube form demo — not created by Thallo')}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color={tc.textMuted} />
      </View>
    </TouchableOpacity>
  );
}
