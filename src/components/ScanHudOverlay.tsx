import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import ScanReticle from './ScanReticle';
import { useReducedMotion } from '../utils/motion';

type ScanHudMode = 'barcode' | 'food' | 'label';

type Props = {
  active?: boolean;
  mode?: ScanHudMode;
  title?: string;
  subtitle?: string;
  status?: string;
  stages?: string[];
  accentColor?: string;
  textColor?: string;
  mutedTextColor?: string;
  surfaceColor?: string;
  compact?: boolean;
  showReticle?: boolean;
  reticleWidth?: number;
  reticleHeight?: number;
  style?: StyleProp<ViewStyle>;
};

type IconName = React.ComponentProps<typeof Ionicons>['name'];

const MODE_COPY: Record<ScanHudMode, { icon: IconName; title: string; subtitle: string; stages: string[] }> = {
  barcode: {
    icon: 'barcode-outline',
    title: 'Scan barcode',
    subtitle: 'Hold the code inside the frame',
    stages: ['Looking for barcode', 'Reading bars', 'Ready to match product'],
  },
  food: {
    icon: 'sparkles-outline',
    title: 'AI food scan',
    subtitle: 'Review estimated foods before saving',
    stages: ['Reading plate', 'Estimating portions', 'Building macros'],
  },
  label: {
    icon: 'reader-outline',
    title: 'Label scan',
    subtitle: 'Reading nutrition facts',
    stages: ['Reading label', 'Finding servings', 'Building macros'],
  },
};

function withAlpha(color: string, alphaHex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alphaHex}` : color;
}

export default function ScanHudOverlay({
  active = true,
  mode = 'food',
  title,
  subtitle,
  status,
  stages,
  accentColor = '#FFFFFF',
  textColor = '#FFFFFF',
  mutedTextColor = 'rgba(255,255,255,0.72)',
  surfaceColor = 'rgba(5,10,20,0.48)',
  compact = false,
  showReticle = true,
  reticleWidth,
  reticleHeight,
  style,
}: Props) {
  const reducedMotion = useReducedMotion();
  const modeCopy = MODE_COPY[mode];
  const stageList = useMemo(() => {
    const next = stages?.filter(Boolean);
    return next && next.length ? next : modeCopy.stages;
  }, [modeCopy.stages, stages]);
  const [stageIndex, setStageIndex] = useState(0);
  const sweep = useRef(new Animated.Value(0)).current;
  const width = reticleWidth ?? (compact ? 190 : 268);
  const height = reticleHeight ?? (compact ? 104 : 164);

  useEffect(() => {
    if (!active || stageList.length <= 1) {
      setStageIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setStageIndex(index => (index + 1) % stageList.length);
    }, 1300);
    return () => clearInterval(timer);
  }, [active, stageList.length]);

  useEffect(() => {
    if (!active || reducedMotion) {
      sweep.setValue(0.5);
      return;
    }
    sweep.setValue(0);
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: 1850,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reducedMotion, sweep]);

  const translateX = sweep.interpolate({
    inputRange: [0, 1],
    outputRange: [-width * 0.7, width * 0.7],
  });
  const stageText = status || stageList[stageIndex % stageList.length] || 'Scanning';
  const iconName = modeCopy.icon;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.root,
        compact ? styles.rootCompact : null,
        { backgroundColor: surfaceColor },
        style,
      ]}
    >
      <View style={[styles.copyRow, compact ? styles.copyRowCompact : null]}>
        <View style={[
          styles.iconBubble,
          compact ? styles.iconBubbleCompact : null,
          {
            backgroundColor: withAlpha(accentColor, '24'),
            borderColor: withAlpha(accentColor, '55'),
          },
        ]}>
          <Ionicons name={iconName} size={compact ? 14 : 18} color={accentColor} />
        </View>
        <View style={styles.copyText}>
          <Text style={[styles.title, compact ? styles.titleCompact : null, { color: textColor }]} numberOfLines={1}>
            {title || modeCopy.title}
          </Text>
          <Text style={[styles.subtitle, compact ? styles.subtitleCompact : null, { color: mutedTextColor }]} numberOfLines={1}>
            {subtitle || modeCopy.subtitle}
          </Text>
        </View>
      </View>

      {showReticle && (
        <View style={[styles.reticleShell, compact ? styles.reticleShellCompact : null, { width, height }]}>
          <ScanReticle
            width={width}
            height={height}
            active={active}
            cornerColor={accentColor}
            beamColor={accentColor}
            gridColor={withAlpha(accentColor, '38')}
            surfaceColor={withAlpha(accentColor, compact ? '0C' : '10')}
          />
          {active && !reducedMotion && (
            <Animated.View style={[styles.lightPass, { transform: [{ translateX }, { rotate: '14deg' }] }]}>
              <LinearGradient
                colors={['rgba(255,255,255,0)', withAlpha(accentColor, '34'), 'rgba(255,255,255,0)'] as const}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
          )}
        </View>
      )}

      <View style={[
        styles.statusRow,
        compact ? styles.statusRowCompact : null,
        {
          backgroundColor: withAlpha(accentColor, '18'),
          borderColor: withAlpha(accentColor, '44'),
        },
      ]}>
        {active ? (
          <ActivityIndicator size="small" color={accentColor} />
        ) : (
          <Ionicons name="checkmark-circle" size={compact ? 14 : 16} color={accentColor} />
        )}
        <Text style={[styles.statusText, compact ? styles.statusTextCompact : null, { color: textColor }]} numberOfLines={1}>
          {stageText}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 18,
    borderRadius: 18,
    overflow: 'hidden',
    gap: 16,
  },
  rootCompact: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    gap: 10,
  },
  copyRow: {
    width: '100%',
    maxWidth: 320,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  copyRowCompact: {
    gap: 8,
  },
  iconBubble: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  iconBubbleCompact: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  copyText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 16,
    fontWeight: '900',
  },
  titleCompact: {
    fontSize: 12,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 12,
    fontWeight: '700',
  },
  subtitleCompact: {
    fontSize: 10,
  },
  reticleShell: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 14,
  },
  reticleShellCompact: {
    borderRadius: 10,
  },
  lightPass: {
    position: 'absolute',
    top: -12,
    bottom: -12,
    width: 54,
    opacity: 0.68,
  },
  statusRow: {
    maxWidth: 320,
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  statusRowCompact: {
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '800',
  },
  statusTextCompact: {
    fontSize: 10,
  },
});
