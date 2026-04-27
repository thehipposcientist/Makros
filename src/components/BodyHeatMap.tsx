// Body heat map — reusable SVG visualization of muscle recovery.
//
// Two views (front / back) toggled by a segmented control. Each muscle region
// is a tappable Path; its fill is interpolated between success / warning /
// error based on recovery %. Tapping reveals the muscle name + recovery % +
// status in a small callout below the figure.
//
// Regions are hand-shaped to read as "a person" while staying compact (no
// detailed anatomical paths). The figure is designed to scale with the
// container width — all coordinates live in a 200×360 viewBox.

import { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing } from 'react-native';
import Svg, { Path, Ellipse, G } from 'react-native-svg';

const AnimatedPath = Animated.createAnimatedComponent(Path);
import { Ionicons } from '@expo/vector-icons';
import { AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';

export type HeatMapSide = 'front' | 'back';

export type HeatMuscleKey =
  // Front
  | 'chest' | 'shoulders' | 'biceps' | 'abs' | 'quads' | 'calves'
  // Back
  | 'upper_back' | 'lats' | 'triceps' | 'glutes' | 'hamstrings';

/** Recovery 0-100 per muscle key. Missing keys = 100 (treated as fresh). */
export type HeatRecoveryMap = Partial<Record<HeatMuscleKey, number>>;

interface Props {
  recovery: HeatRecoveryMap;
  themeName?: AppThemeName;
  /** Optional fixed height; otherwise uses 260. */
  height?: number;
}

const FRONT_MUSCLES: HeatMuscleKey[] = ['chest', 'shoulders', 'biceps', 'abs', 'quads', 'calves'];
const BACK_MUSCLES: HeatMuscleKey[] = ['upper_back', 'lats', 'triceps', 'glutes', 'hamstrings', 'calves'];

const MUSCLE_LABEL: Record<HeatMuscleKey, string> = {
  chest: 'Chest', shoulders: 'Shoulders', biceps: 'Biceps', abs: 'Core',
  quads: 'Quads', calves: 'Calves',
  upper_back: 'Upper Back', lats: 'Lats', triceps: 'Triceps',
  glutes: 'Glutes', hamstrings: 'Hamstrings',
};


export default function BodyHeatMap({ recovery, themeName, height = 260 }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [side, setSide] = useState<HeatMapSide>('front');
  const [selected, setSelected] = useState<HeatMuscleKey | null>(null);

  // Subtle opacity pulse on the currently-selected muscle for visual feedback.
  const pulse = useRef(new Animated.Value(1)).current;
  // Scale pulse on the whole figure when a muscle is tapped — adds a tactile
  // "thump" beneath the per-muscle opacity flash so the selection registers
  // through the user's eye even if the colored fill is subtle.
  const tapScale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!selected) return;
    pulse.setValue(0.55);
    Animated.timing(pulse, {
      toValue: 1,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    tapScale.setValue(0.985);
    Animated.spring(tapScale, {
      toValue: 1,
      damping: 12,
      stiffness: 220,
      mass: 0.4,
      useNativeDriver: true,
    }).start();
  }, [selected, pulse, tapScale]);

  // Fade-in of the whole figure on mount / side flip + small scale to
  // sell depth on the flip (figure leans in from 0.95).
  const figureOpacity = useRef(new Animated.Value(0)).current;
  const figureScale   = useRef(new Animated.Value(0.95)).current;
  useEffect(() => {
    figureOpacity.setValue(0);
    figureScale.setValue(0.95);
    Animated.parallel([
      Animated.timing(figureOpacity, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(figureScale, {
        toValue: 1,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [side, figureOpacity, figureScale]);

  const recoveryFor = (m: HeatMuscleKey): number => {
    const v = recovery[m];
    return v == null ? 100 : Math.max(0, Math.min(100, v));
  };

  const fillFor = (m: HeatMuscleKey): string => {
    const r = recoveryFor(m);
    // Theme-first palette: fresh muscles wear the user's primary color so the
    // heat map reads as part of the chosen theme. Only moderate/severe fatigue
    // switches to the semantic amber/red signal — that's when we actually want
    // the color to break the theme and demand attention.
    if (r >= 80) return tc.primary;
    if (r >= 60) return blend(tc.primary, tc.warning, (80 - r) / 20);
    if (r >= 40) return tc.warning;
    if (r >= 20) return blend(tc.warning, tc.error, (40 - r) / 20);
    return tc.error;
  };

  const statusFor = (r: number): string => {
    if (r >= 80) return 'Fresh';
    if (r >= 60) return 'Mostly recovered';
    if (r >= 40) return 'Moderate fatigue';
    if (r >= 20) return 'Heavy fatigue';
    return 'Severely fatigued';
  };

  const strokeColor = tc.textMuted;
  const strokeW = 1;

  const regions = side === 'front' ? FRONT_MUSCLES : BACK_MUSCLES;

  // Muscle path defs — very simple shapes, legible and tappable.
  // viewBox: 200 x 360. Figure centered.
  const frontPaths: Record<HeatMuscleKey, string> = {
    chest:     'M72 80 Q100 70 128 80 L128 110 Q100 120 72 110 Z',
    shoulders: 'M58 78 Q55 65 72 62 L72 90 Q60 92 58 78 Z M142 78 Q145 65 128 62 L128 90 Q140 92 142 78 Z',
    biceps:    'M56 95 Q50 115 54 140 Q62 145 68 140 Q64 115 68 95 Z M144 95 Q150 115 146 140 Q138 145 132 140 Q136 115 132 95 Z',
    abs:       'M80 118 L120 118 L120 172 L80 172 Z',
    quads:     'M74 182 Q72 210 76 250 L94 250 Q96 218 94 182 Z M126 182 Q128 210 124 250 L106 250 Q104 218 106 182 Z',
    calves:    'M78 258 Q78 290 84 320 L94 320 Q94 292 92 258 Z M122 258 Q122 290 116 320 L106 320 Q106 292 108 258 Z',
    // unused on front — kept to satisfy the type
    upper_back: '', lats: '', triceps: '', glutes: '', hamstrings: '',
  };

  const backPaths: Record<HeatMuscleKey, string> = {
    upper_back: 'M72 80 Q100 72 128 80 L128 108 Q100 112 72 108 Z',
    lats:       'M66 112 Q60 142 72 168 L94 168 L94 112 Z M134 112 Q140 142 128 168 L106 168 L106 112 Z',
    triceps:    'M56 95 Q50 115 54 140 Q62 145 68 140 Q64 115 68 95 Z M144 95 Q150 115 146 140 Q138 145 132 140 Q136 115 132 95 Z',
    glutes:     'M76 170 Q72 195 82 208 L100 208 L100 170 Z M124 170 Q128 195 118 208 L100 208 L100 170 Z',
    hamstrings: 'M76 212 Q72 240 78 258 L94 258 L94 212 Z M124 212 Q128 240 122 258 L106 258 L106 212 Z',
    calves:     'M78 262 Q78 294 84 324 L94 324 Q94 296 92 262 Z M122 262 Q122 294 116 324 L106 324 Q106 296 108 262 Z',
    // unused on back
    chest: '', shoulders: '', biceps: '', abs: '', quads: '',
  };

  const paths = side === 'front' ? frontPaths : backPaths;

  return (
    <View>
      {/* Side toggle — segmented control */}
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: tc.background,
          borderRadius: 8,
          padding: 2,
          marginBottom: 8,
          alignSelf: 'center',
        }}
      >
        {(['front', 'back'] as HeatMapSide[]).map(s => (
          <TouchableOpacity
            key={s}
            onPress={() => { setSide(s); setSelected(null); }}
            style={{
              paddingHorizontal: 14, paddingVertical: 5,
              borderRadius: 6,
              backgroundColor: side === s ? tc.surfaceRaised : 'transparent',
            }}
            activeOpacity={0.7}
          >
            <Text style={{
              fontSize: 11, fontWeight: '700',
              color: side === s ? tc.textPrimary : tc.textMuted,
              textTransform: 'uppercase', letterSpacing: 0.6,
            }}>{s}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ alignItems: 'center' }}>
        <Animated.View style={{ opacity: figureOpacity, transform: [{ scale: Animated.multiply(figureScale, tapScale) }] }}>
          <Svg width={height * (200 / 360)} height={height} viewBox="0 0 200 360">
            {/* Head */}
            <Ellipse cx="100" cy="34" rx="22" ry="24" fill={tc.surfaceRaised} stroke={strokeColor} strokeWidth={strokeW} />
            {/* Neck */}
            <Path d="M92 56 L108 56 L108 66 L92 66 Z" fill={tc.surfaceRaised} stroke={strokeColor} strokeWidth={strokeW} />
            {/* Torso outline (base layer under muscles so gaps still read as body) */}
            <Path
              d="M58 70 Q58 60 72 62 Q100 58 128 62 Q142 60 142 70 Q144 120 140 170 Q128 200 122 252 Q122 310 116 330 L84 330 Q78 310 78 252 Q72 200 60 170 Q56 120 58 70 Z"
              fill={tc.surfaceRaised}
              stroke={strokeColor}
              strokeWidth={strokeW}
            />

            {/* Muscles */}
            <G>
              {regions.map(m => {
                const d = paths[m];
                if (!d) return null;
                const isSel = selected === m;
                if (isSel) {
                  return (
                    <AnimatedPath
                      key={m}
                      d={d}
                      fill={fillFor(m)}
                      stroke={tc.textPrimary}
                      strokeWidth={2}
                      opacity={pulse}
                      onPress={() => setSelected(m)}
                    />
                  );
                }
                return (
                  <Path
                    key={m}
                    d={d}
                    fill={fillFor(m)}
                    stroke={strokeColor}
                    strokeWidth={strokeW}
                    opacity={0.92}
                    onPress={() => setSelected(m)}
                  />
                );
              })}
            </G>
          </Svg>
        </Animated.View>

        {/* Callout */}
        <View style={{
          marginTop: 6, paddingHorizontal: 12, paddingVertical: 8,
          backgroundColor: tc.surfaceRaised, borderRadius: radius.md,
          minWidth: 180, alignItems: 'center',
          borderWidth: 1, borderColor: tc.border,
        }}>
          {selected ? (
            <>
              <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary }}>
                {MUSCLE_LABEL[selected]}
              </Text>
              <Text style={{ fontSize: 18, fontWeight: '900', color: fillFor(selected), marginTop: 2 }}>
                {Math.round(recoveryFor(selected))}%
              </Text>
              <Text style={{ fontSize: 11, color: tc.textSecondary, marginTop: 2 }}>
                {statusFor(recoveryFor(selected))}
              </Text>
            </>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="hand-right-outline" size={14} color={tc.textMuted} />
              <Text style={{ fontSize: 11, color: tc.textMuted }}>Tap a muscle to inspect</Text>
            </View>
          )}
        </View>
      </View>

      {/* Legend */}
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 10, marginTop: 8 }}>
        {[
          { label: 'Fresh', color: tc.primary },
          { label: 'Moderate', color: tc.warning },
          { label: 'Fatigued', color: tc.error },
        ].map(l => (
          <View key={l.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: l.color }} />
            <Text style={{ fontSize: 10, color: tc.textMuted }}>{l.label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// Blend two hex colors by `t` in [0, 1]. Cheap linear RGB interp (close enough
// for heat-map bands; avoids pulling in a color library).
function blend(a: string, b: string, t: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const ax = parseInt(a.replace('#', ''), 16);
  const bx = parseInt(b.replace('#', ''), 16);
  const ar = (ax >> 16) & 255, ag = (ax >> 8) & 255, ab = ax & 255;
  const br = (bx >> 16) & 255, bg = (bx >> 8) & 255, bb = bx & 255;
  const r = clamp(ar + (br - ar) * t);
  const g = clamp(ag + (bg - ag) * t);
  const bl = clamp(ab + (bb - ab) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}
