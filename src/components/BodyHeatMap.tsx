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
import Svg, { Path, Ellipse, G, Circle, Defs, RadialGradient, Stop, LinearGradient, Text as SvgText } from 'react-native-svg';

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
  /** Pre-select a muscle on mount and switch to whichever side it lives
   *  on. Used by the muscle Library detail page to render the figure as
   *  an "anatomy diagram" — user opens Biceps, the front view appears
   *  with biceps already highlighted + the floating % bubble visible. */
  defaultSelected?: HeatMuscleKey;
  /** Hide the front/back toggle. Useful when the parent has already
   *  picked a side (e.g. anatomy diagram showing only the relevant view). */
  hideSideToggle?: boolean;
  /** Hide the small legend strip below the figure. The Library page
   *  doesn't need it — the floating bubble carries the same info. */
  hideLegend?: boolean;
}

const FRONT_MUSCLES: HeatMuscleKey[] = ['chest', 'shoulders', 'biceps', 'abs', 'quads', 'calves'];
const BACK_MUSCLES: HeatMuscleKey[] = ['upper_back', 'lats', 'triceps', 'glutes', 'hamstrings', 'calves'];

const MUSCLE_LABEL: Record<HeatMuscleKey, string> = {
  chest: 'Chest', shoulders: 'Shoulders', biceps: 'Biceps', abs: 'Core',
  quads: 'Quads', calves: 'Calves',
  upper_back: 'Upper Back', lats: 'Lats', triceps: 'Triceps',
  glutes: 'Glutes', hamstrings: 'Hamstrings',
};


// Which side a given muscle key belongs to. Used to auto-flip the
// figure when `defaultSelected` is on the back view.
const SIDE_OF: Record<HeatMuscleKey, HeatMapSide> = {
  chest: 'front', shoulders: 'front', biceps: 'front', abs: 'front',
  quads: 'front', calves: 'front',
  upper_back: 'back', lats: 'back', triceps: 'back',
  glutes: 'back', hamstrings: 'back',
};

export default function BodyHeatMap({
  recovery, themeName, height = 260,
  defaultSelected, hideSideToggle, hideLegend,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [side, setSide] = useState<HeatMapSide>(
    defaultSelected ? SIDE_OF[defaultSelected] : 'front',
  );
  const [selected, setSelected] = useState<HeatMuscleKey | null>(
    defaultSelected ?? null,
  );

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

  // Idle breathing — slow scale loop on the whole figure so it feels
  // alive instead of frozen. ±0.6% over ~3.4s, sinusoidal so there's
  // no sharp turnaround. Multiplied with `figureScale` and `tapScale`
  // so it composes cleanly with the existing transforms.
  const breath = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1.012,
          duration: 1700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 1.0,
          duration: 1700,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);

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

  const strokeColor = blend(tc.textMuted, tc.background, 0.38);
  const bodyLineColor = blend(tc.textMuted, tc.background, 0.22);
  const strokeW = 0.85;

  const regions = side === 'front' ? FRONT_MUSCLES : BACK_MUSCLES;

  // Muscle path defs — very simple shapes, legible and tappable.
  // viewBox: 200 x 360. Figure centered.
  const frontPaths: Record<HeatMuscleKey, string> = {
    // Chest — split into two pectorals with a center seam so the upper
    // body reads as anatomical rather than a single rounded rectangle.
    chest:     'M72 78 Q86 70 99 76 L99 112 Q86 116 72 110 Z M101 76 Q114 70 128 78 L128 110 Q114 116 101 112 Z',
    // Shoulders — slightly wider caps that wrap onto the upper arm to
    // sell the deltoid shape.
    shoulders: 'M56 80 Q52 64 72 60 Q74 66 74 92 Q62 94 56 80 Z M144 80 Q148 64 128 60 Q126 66 126 92 Q138 94 144 80 Z',
    // Biceps — keep tapered shape; small tweak for symmetry.
    biceps:    'M54 96 Q48 116 52 140 Q60 146 68 140 Q66 116 68 96 Z M146 96 Q152 116 148 140 Q140 146 132 140 Q134 116 132 96 Z',
    // Abs — segmented rectus block (two columns × four rows of subtle
    // grooves). Single path with internal subtractive lines for the
    // six-pack hint without stealing focus from the heat color.
    abs:       'M80 118 L120 118 L120 172 L80 172 Z M100 119 L100 171 M82 134 L118 134 M82 150 L118 150',
    // Quads — slight inner sweep so they read as two separate legs.
    quads:     'M74 182 Q70 212 76 252 L94 252 Q97 218 94 182 Z M126 182 Q130 212 124 252 L106 252 Q103 218 106 182 Z',
    // Calves — gentle teardrop.
    calves:    'M78 258 Q76 292 86 322 L94 322 Q95 292 92 258 Z M122 258 Q124 292 114 322 L106 322 Q105 292 108 258 Z',
    // unused on front — kept to satisfy the type
    upper_back: '', lats: '', triceps: '', glutes: '', hamstrings: '',
  };

  const backPaths: Record<HeatMuscleKey, string> = {
    // Upper back — split with a centerline to suggest traps/spine.
    upper_back: 'M72 78 Q86 72 99 76 L99 110 Q86 113 72 108 Z M101 76 Q114 72 128 78 L128 108 Q114 113 101 110 Z',
    // Lats — wider at the top, tapered to the waist.
    lats:       'M66 112 Q60 144 74 170 L94 170 L94 112 Z M134 112 Q140 144 126 170 L106 170 L106 112 Z',
    // Triceps — mirror of biceps for visual continuity across flips.
    triceps:    'M54 96 Q48 116 52 140 Q60 146 68 140 Q66 116 68 96 Z M146 96 Q152 116 148 140 Q140 146 132 140 Q134 116 132 96 Z',
    // Glutes — rounded paired arcs that meet at the centerline.
    glutes:     'M74 172 Q70 200 84 212 L100 212 L100 172 Z M126 172 Q130 200 116 212 L100 212 L100 172 Z',
    // Hamstrings — paired teardrops with gentle inner sweep.
    hamstrings: 'M76 214 Q72 240 80 258 L94 258 L94 214 Z M124 214 Q128 240 120 258 L106 258 L106 214 Z',
    // Calves — same as front for the back view.
    calves:     'M78 262 Q76 294 86 324 L94 324 Q95 294 92 262 Z M122 262 Q124 294 114 324 L106 324 Q105 294 108 262 Z',
    // unused on back
    chest: '', shoulders: '', biceps: '', abs: '', quads: '',
  };

  const paths = side === 'front' ? frontPaths : backPaths;

  return (
    <View>
      {/* Side toggle — segmented control with a subtle border so it
          reads as an interactive control on the surface card (the
          previous version blended into the parent background).
          Hidden in anatomy-diagram mode where the parent has already
          picked the side. */}
      {!hideSideToggle && (
        <View
          style={{
            flexDirection: 'row',
            backgroundColor: tc.background,
            borderRadius: 10,
            padding: 3,
            marginBottom: 10,
            alignSelf: 'center',
            borderWidth: 1,
            borderColor: tc.border,
          }}
        >
          {(['front', 'back'] as HeatMapSide[]).map(s => (
            <TouchableOpacity
              key={s}
              onPress={() => { setSide(s); setSelected(null); }}
              style={{
                paddingHorizontal: 18, paddingVertical: 6,
                borderRadius: 7,
                backgroundColor: side === s ? tc.surfaceRaised : 'transparent',
                shadowColor: side === s ? '#000' : 'transparent',
                shadowOpacity: side === s ? 0.08 : 0,
                shadowRadius: 3,
                shadowOffset: { width: 0, height: 1 },
              }}
              activeOpacity={0.7}
            >
              <Text style={{
                fontSize: 11, fontWeight: '700',
                color: side === s ? tc.textPrimary : tc.textMuted,
                textTransform: 'uppercase', letterSpacing: 0.7,
              }}>{s}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={{ alignItems: 'center' }}>
        <Animated.View
          style={{
            opacity: figureOpacity,
            transform: [
              { scale: Animated.multiply(Animated.multiply(figureScale, tapScale), breath) },
            ],
          }}
        >
          <Svg width={height * (200 / 360)} height={height} viewBox="0 0 200 360">
            <Defs>
              <RadialGradient id="bodyGlow" cx="50%" cy="50%" r="55%">
                <Stop offset="0%" stopColor={tc.primary} stopOpacity="0.13" />
                <Stop offset="100%" stopColor={tc.primary} stopOpacity="0" />
              </RadialGradient>
              <RadialGradient id="floorGlow" cx="50%" cy="50%" r="55%">
                <Stop offset="0%" stopColor="#000000" stopOpacity="0.16" />
                <Stop offset="100%" stopColor="#000000" stopOpacity="0" />
              </RadialGradient>
              <LinearGradient id="bodyFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0%" stopColor={blend(tc.surfaceRaised, tc.primary, 0.08)} stopOpacity="1" />
                <Stop offset="48%" stopColor={tc.surface} stopOpacity="1" />
                <Stop offset="100%" stopColor={blend(tc.surfaceRaised, tc.background, 0.2)} stopOpacity="1" />
              </LinearGradient>
            </Defs>

            <Ellipse cx="100" cy="180" rx="90" ry="170" fill="url(#bodyGlow)" />
            <Ellipse cx="100" cy="333" rx="48" ry="12" fill="url(#floorGlow)" />

            <Path
              d="M58 75 Q58 63 72 65 Q100 60 128 65 Q142 63 142 75 Q145 123 141 173 Q129 203 123 254 Q124 312 117 333 L83 333 Q76 312 77 254 Q71 203 59 173 Q55 123 58 75 Z"
              fill="#000"
              opacity={0.12}
            />

            <Ellipse cx="100" cy="34" rx="22" ry="24" fill="url(#bodyFill)" stroke={strokeColor} strokeWidth={strokeW} />
            {side === 'front' && (
              <>
                <Path d="M82 27 Q100 18 118 27" stroke={bodyLineColor} strokeWidth={strokeW} fill="none" opacity={0.58} />
                <Circle cx="92" cy="34" r="1.35" fill={bodyLineColor} opacity={0.72} />
                <Circle cx="108" cy="34" r="1.35" fill={bodyLineColor} opacity={0.72} />
              </>
            )}

            <Path d="M92 56 L108 56 L110 67 L90 67 Z" fill={blend(tc.surfaceRaised, tc.primary, 0.05)} stroke={strokeColor} strokeWidth={strokeW} />

            <Path
              d="M58 70 Q58 59 72 62 Q100 57 128 62 Q142 59 142 70 Q145 120 141 170 Q129 201 123 252 Q124 309 116 330 L84 330 Q76 309 77 252 Q71 201 59 170 Q55 120 58 70 Z"
              fill="url(#bodyFill)"
              stroke={strokeColor}
              strokeWidth={strokeW}
            />
            <Path d="M73 78 Q100 69 127 78" stroke={bodyLineColor} strokeWidth={0.8} fill="none" opacity={0.42} />
            <Path d="M100 76 L100 172" stroke={bodyLineColor} strokeWidth={0.75} fill="none" opacity={side === 'front' ? 0.18 : 0.34} />
            <Path d="M78 174 Q100 184 122 174" stroke={bodyLineColor} strokeWidth={0.8} fill="none" opacity={0.35} />
            <Path d="M88 252 Q100 258 112 252" stroke={bodyLineColor} strokeWidth={0.8} fill="none" opacity={0.22} />

            <G>
              {regions.map(m => {
                const d = paths[m];
                if (!d) return null;
                const isSel = selected === m;
                const muscleFill = fillFor(m);
                const muscleStroke = blend(muscleFill, tc.background, 0.45);
                if (isSel) {
                  return (
                    <G key={m}>
                      <Path
                        d={d}
                        fill={muscleFill}
                        stroke={muscleFill}
                        strokeWidth={6}
                        opacity={0.2}
                      />
                      <AnimatedPath
                        d={d}
                        fill={muscleFill}
                        stroke={blend(tc.textPrimary, muscleFill, 0.22)}
                        strokeWidth={1.7}
                        opacity={pulse}
                        onPress={() => setSelected(m)}
                      />
                    </G>
                  );
                }
                return (
                  <Path
                    key={m}
                    d={d}
                    fill={muscleFill}
                    stroke={muscleStroke}
                    strokeWidth={strokeW}
                    opacity={0.9}
                    onPress={() => setSelected(m)}
                  />
                );
              })}
            </G>

            {/* Floating recovery % above the selected muscle. Lets the
                user read the value at the figure without bouncing their
                eye down to the callout. Positions are eyeballed per
                muscle so the bubble lands clear of the muscle silhouette. */}
            {selected && (() => {
              const labelPos: Record<HeatMuscleKey, { x: number; y: number }> = {
                chest:      { x: 100, y: 95 },
                shoulders:  { x: 100, y: 60 },
                biceps:     { x: 100, y: 117 },
                abs:        { x: 100, y: 145 },
                quads:      { x: 100, y: 215 },
                calves:     { x: 100, y: 290 },
                upper_back: { x: 100, y: 92 },
                lats:       { x: 100, y: 138 },
                triceps:    { x: 100, y: 117 },
                glutes:     { x: 100, y: 192 },
                hamstrings: { x: 100, y: 234 },
              };
              const p = labelPos[selected];
              if (!p) return null;
              const pct = Math.round(recoveryFor(selected));
              return (
                <G>
                  <Ellipse cx={p.x} cy={p.y + 1} rx="24" ry="12" fill="#000" opacity={0.14} />
                  <Ellipse cx={p.x} cy={p.y} rx="23" ry="11.5" fill={tc.surfaceRaised} stroke={fillFor(selected)} strokeWidth={1.4} />
                  <SvgText
                    x={p.x}
                    y={p.y + 4}
                    fontSize="11"
                    fontWeight="800"
                    fill={tc.textPrimary}
                    textAnchor="middle"
                  >
                    {`${pct}%`}
                  </SvgText>
                </G>
              );
            })()}
          </Svg>
        </Animated.View>

        {/* Callout — animated swap when a muscle is selected. Shows
            the recovery % big, status word, and a quick-recovery hint
            so users get one immediate read instead of bouncing between
            the figure and the bar list below. */}
        <View style={{
          marginTop: 8,
          paddingHorizontal: 14,
          paddingVertical: selected ? 10 : 7,
          backgroundColor: tc.surfaceRaised,
          borderRadius: radius.lg,
          minWidth: 200,
          alignItems: 'center',
          borderWidth: 1,
          borderColor: selected ? fillFor(selected) : tc.border,
        }}>
          {selected ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textSecondary, textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  {MUSCLE_LABEL[selected]}
                </Text>
                <Text
                  style={{
                    fontSize: 22,
                    fontWeight: '900',
                    color: fillFor(selected),
                    fontVariant: ['tabular-nums'],
                  }}
                >
                  {Math.round(recoveryFor(selected))}%
                </Text>
              </View>
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

      {/* Legend — hidden when the heat map is rendering as an anatomy
          diagram (the colors don't carry a recovery message there). */}
      {!hideLegend && (
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
      )}
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
