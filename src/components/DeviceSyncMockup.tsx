import React from 'react';
import {
  Image,
  StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, radius } from '../constants/theme';

const phoneScreen = require('../../assets/images/product-screenshots/thallo-today-home.png');
const watchScreen = require('../../assets/images/product-screenshots/thallo-watch-today.png');

type Props = {
  accent?: string;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
};

export default function DeviceSyncMockup({ accent = colors.primary, compact = false, style }: Props) {
  const { width } = useWindowDimensions();
  const narrow = width < 420;
  const large = width >= 760 && !compact;
  const phoneW = compact
    ? (narrow ? 108 : 122)
    : large
      ? 238
      : (narrow ? 152 : 174);
  const watchW = compact
    ? (narrow ? 76 : 86)
    : large
      ? 128
      : (narrow ? 94 : 104);
  const phoneH = Math.round(phoneW * 2.1625);
  const watchH = Math.round(watchW * 1.222);
  const clusterW = Math.round(phoneW + watchW * 0.76);
  const clusterH = Math.round(phoneH + (compact ? 10 : 18));

  return (
    <View
      pointerEvents="none"
      accessibilityRole="image"
      accessibilityLabel="Thallo iPhone home screen and Apple Watch workout screen"
      style={[
        styles.stage,
        compact && styles.stageCompact,
        { minHeight: clusterH + (compact ? 22 : 34) },
        style,
      ]}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[`${accent}22`, 'rgba(255,255,255,0.035)', 'rgba(0,0,0,0)'] as any}
        locations={[0, 0.42, 1] as any}
        style={StyleSheet.absoluteFillObject}
      />
      <View style={[styles.deviceCluster, { width: clusterW, height: clusterH }]}>
        <View style={[styles.watchAssembly, { width: watchW, height: watchH + watchW * 0.5, bottom: phoneH * 0.16 }]}>
          <View style={[styles.watchStrap, { width: watchW * 0.48, height: watchW * 0.26 }]} />
          <View style={[
            styles.watchFrame,
            {
              width: watchW,
              height: watchH,
              borderRadius: watchW * 0.26,
              shadowColor: accent,
            },
          ]}>
            <Image source={watchScreen} resizeMode="cover" style={styles.watchImage} />
          </View>
          <View style={[styles.watchStrap, { width: watchW * 0.48, height: watchW * 0.26 }]} />
        </View>

        <View style={[
          styles.phoneFrame,
          {
            width: phoneW,
            height: phoneH,
            borderRadius: phoneW * 0.145,
            shadowColor: accent,
          },
        ]}>
          <View style={[
            styles.phoneNotch,
            {
              top: phoneW * 0.034,
              width: phoneW * 0.28,
              height: Math.max(5, phoneW * 0.025),
              borderRadius: phoneW * 0.018,
            },
          ]} />
          <Image source={phoneScreen} resizeMode="cover" style={styles.phoneImage} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    backgroundColor: 'rgba(7,11,15,0.68)',
    paddingHorizontal: 18,
    paddingVertical: 18,
  },
  stageCompact: {
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  deviceCluster: {
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
  },
  phoneFrame: {
    borderWidth: 7,
    borderColor: '#05080C',
    backgroundColor: '#05080C',
    shadowOpacity: 0.32,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
    overflow: 'hidden',
  },
  phoneNotch: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: '#05080C',
    zIndex: 2,
  },
  phoneImage: {
    width: '100%',
    height: '100%',
  },
  watchAssembly: {
    position: 'absolute',
    left: 0,
    zIndex: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  watchStrap: {
    borderRadius: radius.pill,
    backgroundColor: '#070A0F',
    borderWidth: 1,
    borderColor: '#202938',
  },
  watchFrame: {
    borderWidth: 5,
    borderColor: '#05080C',
    backgroundColor: '#05080C',
    overflow: 'hidden',
    shadowOpacity: 0.26,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
    marginVertical: -1,
  },
  watchImage: {
    width: '100%',
    height: '100%',
  },
});
