import React from 'react';
import { Image, ImageSourcePropType, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  equipmentDisplayName,
  EquipmentVisualInput,
  getEquipmentImageSource,
} from '../utils/equipmentImages';

type EquipmentImageCardProps = {
  equipment: EquipmentVisualInput;
  label?: string;
  subtitle?: string;
  themeColors: any;
  accentColor: string;
  compact?: boolean;
  hero?: boolean;
  onPress?: () => void;
};

export default function EquipmentImageCard({
  equipment,
  label,
  subtitle,
  themeColors,
  accentColor,
  compact = false,
  hero = false,
  onPress,
}: EquipmentImageCardProps) {
  const source: ImageSourcePropType | null = getEquipmentImageSource(equipment);
  const title = label || equipmentDisplayName(equipment) || 'Equipment';
  const Wrapper: any = onPress ? TouchableOpacity : View;

  if (hero) {
    return (
      <Wrapper
        activeOpacity={onPress ? 0.82 : 1}
        onPress={onPress}
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: themeColors.border,
          backgroundColor: themeColors.surfaceRaised,
          overflow: 'hidden',
        }}
      >
        <View style={{ height: 176, backgroundColor: themeColors.surface, alignItems: 'center', justifyContent: 'center' }}>
          {source ? (
            <Image source={source} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
          ) : (
            <Ionicons name="barbell-outline" size={52} color={accentColor} />
          )}
        </View>
        <View style={{ padding: 12 }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: themeColors.textPrimary }} numberOfLines={2}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={{ fontSize: 12, color: themeColors.textMuted, marginTop: 3 }} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </Wrapper>
    );
  }

  const size = compact ? 46 : 56;
  return (
    <Wrapper
      activeOpacity={onPress ? 0.82 : 1}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: themeColors.border,
        backgroundColor: themeColors.surfaceRaised,
        padding: compact ? 8 : 10,
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          overflow: 'hidden',
          backgroundColor: themeColors.surface,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: themeColors.border,
        }}
      >
        {source ? (
          <Image source={source} style={{ width: '100%', height: '100%' }} resizeMode="contain" />
        ) : (
          <Ionicons name="barbell-outline" size={compact ? 20 : 24} color={accentColor} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: compact ? 12 : 14, fontWeight: '800', color: themeColors.textPrimary }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {onPress ? <Ionicons name="chevron-forward" size={16} color={themeColors.textMuted} /> : null}
    </Wrapper>
  );
}
