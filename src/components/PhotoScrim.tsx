import { StyleSheet, type TextStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

// Shared legibility helpers for text sitting over card photos.
//
// White over-photo text loses contrast on bright images (the common case in
// light theme). Two complementary fixes, used together:
//   1. <PhotoScrim/> — a bottom-weighted dark gradient dropped inside an
//      ImageBackground (above the image, below the text) so the text band is
//      always darker than the photo.
//   2. overPhotoTextShadow — a subtle drop shadow spread onto the title text
//      so it stays readable even where the scrim is light.

/** Drop shadow for white text rendered over a photo. Spread onto the Text's
 *  style. Cheap and theme-agnostic. */
export const overPhotoTextShadow: TextStyle = {
  textShadowColor: 'rgba(0,0,0,0.55)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 4,
};

interface Props {
  /** How dark the bottom of the gradient gets. */
  strength?: 'soft' | 'medium' | 'strong';
  /** Extra positioning (defaults to filling the parent ImageBackground). */
  style?: any;
}

const BOTTOM_ALPHA: Record<NonNullable<Props['strength']>, number> = {
  soft: 0.42,
  medium: 0.58,
  strong: 0.7,
};
const MID_ALPHA: Record<NonNullable<Props['strength']>, number> = {
  soft: 0.1,
  medium: 0.18,
  strong: 0.28,
};

export default function PhotoScrim({ strength = 'medium', style }: Props) {
  return (
    <LinearGradient
      pointerEvents="none"
      colors={['rgba(0,0,0,0)', `rgba(0,0,0,${MID_ALPHA[strength]})`, `rgba(0,0,0,${BOTTOM_ALPHA[strength]})`]}
      locations={[0, 0.55, 1]}
      start={{ x: 0, y: 0 }}
      end={{ x: 0, y: 1 }}
      style={[StyleSheet.absoluteFill, style]}
    />
  );
}
