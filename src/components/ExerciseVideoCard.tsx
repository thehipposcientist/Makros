// Exercise demo video card — thumbnail preview that opens the in-app
// FormVideoModal on tap. The card is purely VISUAL — the actual video
// playback still flows through FormVideoModal / `/ai/exercise-video`
// (embedded YouTube WebView). This gives users an at-a-glance preview
// without leaving the app.
//
// Preview source:
//   - Curated or auto-scraped YouTube video (`videoId`) → that video's
//     thumbnail.
//   - No video_id → a branded placeholder tile. Stick-figure / wger
//     static images are intentionally NOT used (inconsistent with the
//     YouTube-thumbnail treatment everywhere else).
//
// onPress always invokes openExerciseVideo (FormVideoModal).

import { View, Text, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';

interface Props {
  exerciseName: string;
  videoId?: string | null;
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

export default function ExerciseVideoCard({ exerciseName, videoId, themeName, onPress }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const thumbUri = videoId ? ytThumb(videoId) : null;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={{
        borderRadius: radius.lg, overflow: 'hidden',
        backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
        marginBottom: 12,
      }}
    >
      <View style={{ position: 'relative', width: '100%', aspectRatio: 16 / 9 }}>
        {thumbUri ? (
          <Image
            source={{ uri: thumbUri }}
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
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
              TAP TO LOAD FORM VIDEO
            </Text>
          </View>
        )}
        {/* Play overlay — centered, semi-transparent circle with a play
            glyph, so the tile reads as a video preview even before load. */}
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <View style={{
            width: 60, height: 60, borderRadius: 30,
            backgroundColor: 'rgba(0,0,0,0.55)',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Ionicons name="play" size={26} color="#fff" style={{ marginLeft: 3 }} />
          </View>
        </View>
        {videoId && (
          <View style={{
            position: 'absolute', bottom: 8, right: 10,
            backgroundColor: 'rgba(0,0,0,0.65)',
            paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4,
            flexDirection: 'row', alignItems: 'center', gap: 4,
          }}>
            <Ionicons name="logo-youtube" size={10} color="#FF0000" />
            <Text style={{ fontSize: 10, fontWeight: '700', color: '#fff', letterSpacing: 0.3 }}>
              FORM VIDEO
            </Text>
          </View>
        )}
      </View>
      <View style={{ padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Ionicons name="play-circle" size={16} color={tc.primary} />
        <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary, flex: 1 }} numberOfLines={1}>
          Watch form video
        </Text>
        <Ionicons name="chevron-forward" size={14} color={tc.textMuted} />
      </View>
    </TouchableOpacity>
  );
}
