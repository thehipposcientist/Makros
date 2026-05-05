import React from 'react';
import { Image, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';

type Props = {
  avatarUrl?: string | null;
  name?: string | null;
  username?: string | null;
  size?: number;
  borderColor?: string;
  backgroundColor?: string;
  textColor?: string;
  textSize?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

function initialFor(name?: string | null, username?: string | null): string {
  const source = (name || username || '').trim();
  return (source[0] || '?').toUpperCase();
}

export default function SocialAvatar({
  avatarUrl,
  name,
  username,
  size = 36,
  borderColor = 'transparent',
  backgroundColor = '#E5E7EB',
  textColor = '#111827',
  textSize,
  style,
  children,
}: Props) {
  const radius = size / 2;
  const hasAvatar = typeof avatarUrl === 'string' && avatarUrl.trim().length > 0;
  return (
    <View
      style={[
        styles.frame,
        {
          width: size,
          height: size,
          borderRadius: radius,
          borderColor,
          backgroundColor,
        },
        style,
      ]}>
      {hasAvatar ? (
        <Image
          source={{ uri: avatarUrl!.trim() }}
          style={{ width: size, height: size, borderRadius: radius }}
          resizeMode="cover"
        />
      ) : (
        <Text style={{ color: textColor, fontSize: textSize ?? Math.max(13, Math.round(size * 0.39)), fontWeight: '800' }}>
          {initialFor(name, username)}
        </Text>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'visible',
  },
});
