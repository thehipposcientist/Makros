// MealThumbnail — meal-level image with category fallback.
//
// Renders one of:
//   • a remote photo (user upload / recipe / product) when image_url is set
//   • a category-tinted Ionicon when no image is available
//   • a neutral placeholder when name + image are both missing
//
// Per the product brief this is for MEAL-LEVEL surfaces only:
// saved-meal cards, meal hero areas, empty states. Do NOT use this on
// ingredient rows — keep ingredient lists clean / macro-focused.

import { useState } from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { resolveMealImage, type ImageSpec } from '../utils/foodImage';

type Size = 'sm' | 'md' | 'lg';

const SIZE_PX: Record<Size, number> = { sm: 36, md: 56, lg: 96 };
const ICON_PX: Record<Size, number> = { sm: 18, md: 26, lg: 44 };
const RADIUS_PX: Record<Size, number> = { sm: 8, md: 10, lg: 14 };

interface Props {
  meal: Parameters<typeof resolveMealImage>[0];
  size?: Size;
  /** Override the resolver (e.g. when caller already computed it). */
  spec?: ImageSpec;
}

export default function MealThumbnail({ meal, size = 'sm', spec }: Props) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const resolved = spec ?? resolveMealImage(meal);
  const photoSource = resolved.asset ?? (resolved.uri ? { uri: resolved.uri } : null);
  const showPhoto = resolved.kind === 'photo' && !!photoSource && !photoFailed;
  const px = SIZE_PX[size];

  return (
    <View
      style={[
        styles.wrap,
        { width: px, height: px, borderRadius: RADIUS_PX[size], backgroundColor: resolved.bg },
      ]}
    >
      {showPhoto ? (
        <Image
          source={photoSource!}
          style={{ width: px, height: px, borderRadius: RADIUS_PX[size] }}
          resizeMode="cover"
          onError={() => setPhotoFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Ionicons name={resolved.icon} size={ICON_PX[size]} color={resolved.tint} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
