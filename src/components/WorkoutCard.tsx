import { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WorkoutDay, AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';
import { humanizeToken } from '../utils/exerciseGuide';
import { exerciseThumbSmall } from '../utils/exerciseThumb';
import { shouldHideWeight } from '../utils/exerciseDisplay';

/** Turn a planner-emitted equipment string into a display label.
 *  The planner outputs comma-separated slugs like
 *  `"barbell, flat_bench, squat_rack"` — each piece needs to be run
 *  through `humanizeToken` individually so the underscores become
 *  spaces and every word gets title-cased. */
function formatEquipmentLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .split(',')
    .map(part => humanizeToken(part.trim()))
    .filter(Boolean)
    .join(', ');
}

interface WorkoutCardProps {
  workout: WorkoutDay;
  themeName?: AppThemeName;
  onOpenExerciseVideo?: (exerciseName: string) => void;
  /** Open the swap picker for the exercise at this index. Enables a
   *  swap button on each exercise row so plan-view swaps use the same
   *  overlap-ranked alternatives as the live Switch Exercise feature. */
  onSwapExercise?: (exerciseIndex: number, exerciseName: string) => void;
  /** Open the exercise info page (description, cues, video) for the
   *  given exercise name. Typically routes to the Library sub-tab with
   *  the exercise pre-selected. */
  onViewExercise?: (exerciseName: string) => void;
}

export default function WorkoutCard({ workout, themeName, onOpenExerciseVideo, onSwapExercise, onViewExercise }: WorkoutCardProps) {
  const theme  = getTheme(themeName);
  const c      = theme.colors;
  const s      = theme.sections.workout;
  const styles = createStyles(c, s);

  const totalSets        = workout.exercises.reduce((sum, ex) => sum + (Number(ex.sets) || 3), 0);

  // Realistic duration estimate. Strength sets get ~45 s of working
  // time + the prescribed rest; timed sets (cardio intervals, zone 2
  // blocks, planks, carries) are parsed from the `reps` string so a
  // "30-45 min" zone 2 session doesn't estimate as 4 minutes.
  //
  // Supported rep formats parsed as time-per-set:
  //   "30s", "45 sec", "60 seconds"           → seconds
  //   "30-45s", "30-45 sec"                   → seconds (midpoint)
  //   "5m", "5 min", "5 minutes"              → minutes
  //   "30-45 min", "25-40 minutes"            → minutes (midpoint)
  // A plain number or rep-range like "6-8" falls back to the
  // 45s-per-set working estimate (normal strength set timing).
  const parseWorkSecondsPerSet = (reps: unknown, exerciseName?: string): number | null => {
    if (reps == null) return null;
    const s = String(reps).trim().toLowerCase();
    if (!s) return null;
    // Explicit seconds: "30s", "45 sec", "30-45s", "60s each side", "45s hold"
    const secMatch = s.match(/^(\d+)(?:\s*-\s*(\d+))?\s*(s|sec|secs|second|seconds)\b/);
    if (secMatch) {
      const lo = parseInt(secMatch[1], 10);
      const hi = secMatch[2] ? parseInt(secMatch[2], 10) : lo;
      const base = Math.round((lo + hi) / 2);
      return s.includes('each') ? base * 2 : base;
    }
    // Explicit minutes: "5 min", "30-45 min", "42-52 min"
    const minMatch = s.match(/^(\d+)(?:\s*-\s*(\d+))?\s*(m|min|mins|minute|minutes)\b/);
    if (minMatch) {
      const lo = parseInt(minMatch[1], 10);
      const hi = minMatch[2] ? parseInt(minMatch[2], 10) : lo;
      return Math.round(((lo + hi) / 2) * 60);
    }
    // Rep-based with "each side" — treat as ~10s per rep per side
    if (s.includes('each')) {
      const repMatch = s.match(/^(\d+)/);
      if (repMatch) return parseInt(repMatch[1], 10) * 10 * 2;
    }
    // "X reps slow" — treat as ~5s per rep
    if (s.includes('slow')) {
      const repMatch = s.match(/^(\d+)/);
      if (repMatch) return parseInt(repMatch[1], 10) * 5;
    }
    // Bare number heuristic: if the value is a plain number ≥ 20 AND
    // the exercise looks like cardio (name contains cardio keywords),
    // treat it as minutes. "60" on an elliptical = 60 min, not 60 reps.
    // Below 20, it's almost certainly rep-based (squats × 15, etc.).
    const bareNum = s.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (bareNum) {
      const lo = parseInt(bareNum[1], 10);
      const hi = bareNum[2] ? parseInt(bareNum[2], 10) : lo;
      const mid = Math.round((lo + hi) / 2);
      if (mid >= 20) {
        const name = (exerciseName ?? '').toLowerCase();
        const isCardio = ['elliptical', 'treadmill', 'bike', 'cycling', 'running', 'jogging', 'walk', 'rowing', 'stair', 'swim', 'cardio', 'zone'].some(k => name.includes(k));
        if (isCardio) return mid * 60; // treat as minutes
      }
    }
    return null;
  };

  const { estimatedSeconds, estimatedMinutes } = useMemo(() => {
    // Per-exercise estimate accounts for THREE things the old formula missed:
    //   1. Working time per set is ~55s on a real strength set (rack/unrack
    //      + slower tempo on heavy lifts + form check). Was 45s.
    //   2. Rest fudge factor of 1.10× — users rarely start the next set the
    //      second the timer hits 0 (checking phone, breathing, etc).
    //   3. Transition time between exercises (~45s for strength, ~15s for
    //      mobility/stretch). Set up new equipment, walk to next station.
    // Warmup is still NOT added here — the warmup exercise already exists
    // as a line item in workout.exercises with its own timing.
    const REST_FUDGE = 1.10;
    const TRANSITION_STRENGTH_SEC = 45;
    const TRANSITION_MOBILITY_SEC = 15;
    const WORK_STRENGTH_SEC = 55;
    const nonWarmupCount = workout.exercises.filter(e => (e as any)._role !== 'warmup').length;
    const secs = workout.exercises.reduce((total, ex, idx) => {
      const sets = Number(ex.sets) || 3;
      const rest = Number((ex as any).restSeconds ?? (ex as any).rest_seconds) || 60;
      const timedWorkSec = parseWorkSecondsPerSet((ex as any).reps, ex.name);
      const restTotal = Math.max(0, sets - 1) * rest * REST_FUDGE;
      // Transition between exercises (only between, not after last)
      const isLast = idx === workout.exercises.length - 1;
      const isMobility = /mobility|stretch|warm.?up|flow|pose|dog|cat|hip|shoulder.dis|dead hang/i.test(ex.name) || (ex as any)._role === 'warmup';
      const transition = isLast ? 0 : (isMobility ? TRANSITION_MOBILITY_SEC : TRANSITION_STRENGTH_SEC);

      if (timedWorkSec != null) {
        return total + sets * timedWorkSec + restTotal + transition;
      }
      return total + sets * WORK_STRENGTH_SEC + restTotal + transition;
    }, 0);
    void nonWarmupCount;
    return { estimatedSeconds: secs, estimatedMinutes: Math.max(1, Math.round(secs / 60)) };
  }, [workout.exercises]);

  return (
    <View style={styles.card}>
      {/* Header removed — the parent DayCard already shows day + focus.
          Stats strip is now a plain inline row, no colored background,
          matching the macros grid on the meal accordion. */}
      <View style={styles.statsStrip}>
        <StatItem icon="time-outline" value={`~${estimatedMinutes} min`} color={s.strong} />
        <View style={[styles.statsDivider, { backgroundColor: c.border }]} />
        <StatItem icon="layers-outline" value={`${totalSets} sets`} color={s.strong} />
        <View style={[styles.statsDivider, { backgroundColor: c.border }]} />
        <StatItem icon="barbell-outline" value={`${workout.exercises.length} exercises`} color={s.strong} />
      </View>
      <Text style={styles.warmupHint}>
        Estimate includes warm-up, set rests, and transitions between exercises.
      </Text>

      {/* ── Exercise list ───────────────────────────────────────────────── */}
      <View style={styles.body}>
        {workout.exercises.map((exercise, index) => (
          <ExerciseRow
            key={index}
            index={index}
            exercise={exercise}
            isLast={index === workout.exercises.length - 1}
            section={s}
            c={c}
            styles={styles}
            onOpenVideo={onOpenExerciseVideo}
            onSwap={onSwapExercise}
            onView={onViewExercise}
          />
        ))}
      </View>

    </View>
  );
}

// ── StatItem ──────────────────────────────────────────────────────────────────

function StatItem({ icon, value, color }: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  color: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <Ionicons name={icon} size={12} color={color} />
      <Text style={{ fontSize: 11, fontWeight: '600', color, letterSpacing: 0.2 }}>{value}</Text>
    </View>
  );
}

// ── ExerciseRow ───────────────────────────────────────────────────────────────

function ExerciseRow({ index, exercise, isLast, section, c, styles, onOpenVideo, onSwap, onView }: {
  index: number;
  exercise: WorkoutDay['exercises'][number];
  isLast: boolean;
  section: ReturnType<typeof getTheme>['sections']['workout'];
  c: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  onOpenVideo?: (name: string) => void;
  onSwap?: (exerciseIndex: number, exerciseName: string) => void;
  onView?: (name: string) => void;
}) {
  return (
    <View style={[styles.exRow, !isLast && { borderBottomWidth: 1, borderBottomColor: c.border + '66' }]}>
      {/* Thumbnail — YouTube video frame when available, numbered tile
          otherwise. wger static images removed for visual consistency. */}
      {(() => {
        const thumbUri = exerciseThumbSmall(exercise as any);
        return thumbUri ? (
          <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: c.surface, overflow: 'hidden', borderWidth: 1, borderColor: c.border, position: 'relative' }}>
            <Image source={{ uri: thumbUri }} style={{ width: 44, height: 44 }} resizeMode="cover" />
            {/* Tiny play glyph — tells the user this IS a video preview. */}
            <View style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <View style={{
                width: 18, height: 18, borderRadius: 9,
                backgroundColor: 'rgba(0,0,0,0.55)',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons name="play" size={10} color="#fff" style={{ marginLeft: 1 }} />
              </View>
            </View>
          </View>
        ) : (
          <View style={[styles.exNum, { backgroundColor: section.strong }]}>
            <Text style={styles.exNumText}>{String(index + 1).padStart(2, '0')}</Text>
          </View>
        );
      })()}

      {/* Info */}
      <View style={styles.exInfo}>
        <Text style={[styles.exName, { color: c.textPrimary }]}>{exercise.name}</Text>
        {exercise.equipment ? (
          <Text style={[styles.exEquipment, { color: c.textMuted }]}>{formatEquipmentLabel(exercise.equipment)}</Text>
        ) : null}

        {/* Chips */}
        <View style={styles.exChips}>
          <Chip
            icon="repeat-outline"
            // Append "hold" on the preview chip for bodyweight/stretch
            // rows where the reps value is a duration — makes it obvious
            // at a glance that "60s" is a hold, not a rep count.
            label={
              shouldHideWeight(exercise) && /^\d+\s*-?\s*\d*\s*s(ec)?$/i.test(String(exercise.reps ?? ''))
                ? `${exercise.sets} × ${exercise.reps} hold`
                : `${exercise.sets} × ${exercise.reps}`
            }
            strong={section.strong}
            soft={section.soft}
            text={section.text}
          />
          <Chip
            icon="timer-outline"
            label={`${exercise.restSeconds}s rest`}
            strong={section.strong}
            soft={section.soft}
            text={section.text}
          />
          {/* Muscle chip — driven off `primary_muscle` from the planner.
              Humanized (chest → Chest, full_body → Full Body). Skipped
              for mobility/systemic/cardio exercises where the muscle
              label is already conveyed by the exercise name. */}
          {(() => {
            const pm = ((exercise as any).primary_muscle ?? '').toLowerCase().replace(/\s+/g, '_');
            if (!pm || pm === 'mobility' || pm === 'systemic' || pm === 'cardio' || pm === 'full_body') return null;
            const label = humanizeToken(pm);
            if (!label) return null;
            return (
              <Chip
                icon="body-outline"
                label={label}
                strong={section.strong}
                soft={section.soft}
                text={section.text}
              />
            );
          })()}
          {onOpenVideo && (
            <Pressable
              style={({ pressed }) => [
                styles.videoChip,
                { borderColor: section.strong, backgroundColor: pressed ? section.strong + '28' : section.strong + '12' },
              ]}
              onPress={() => onOpenVideo(exercise.name)}>
              <Ionicons name="open-outline" size={11} color={section.strong} />
              <Text style={[styles.videoChipText, { color: section.strong }]}>Form</Text>
            </Pressable>
          )}
          {onView && (
            <Pressable
              style={({ pressed }) => [
                styles.videoChip,
                { borderColor: c.textMuted, backgroundColor: pressed ? c.textMuted + '22' : c.surface },
              ]}
              onPress={() => onView(exercise.name)}
              accessibilityLabel={`view-${exercise.name}`}
            >
              <Ionicons name="information-circle-outline" size={11} color={c.textSecondary} />
              <Text style={[styles.videoChipText, { color: c.textSecondary }]}>Info</Text>
            </Pressable>
          )}
          {onSwap && (
            <Pressable
              style={({ pressed }) => [
                styles.videoChip,
                { borderColor: c.textMuted, backgroundColor: pressed ? c.textMuted + '22' : c.surface },
              ]}
              onPress={() => onSwap(index, exercise.name)}
              accessibilityLabel={`swap-${exercise.name}`}
            >
              <Ionicons name="swap-horizontal" size={11} color={c.textSecondary} />
              <Text style={[styles.videoChipText, { color: c.textSecondary }]}>Swap</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

// ── Chip ──────────────────────────────────────────────────────────────────────

function Chip({ icon, label, strong, soft, text }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  strong: string;
  soft: string;
  text: string;
}) {
  return (
    <View style={[chipStyles.chip, { backgroundColor: soft, borderColor: strong + '33' }]}>
      <Ionicons name={icon} size={10} color={text} />
      <Text style={[chipStyles.label, { color: text }]}>{label}</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip:  { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 9, paddingVertical: 4 },
  label: { fontSize: 11, fontWeight: '600' },
});

// ── Styles ────────────────────────────────────────────────────────────────────

const createStyles = (
  c: ReturnType<typeof getTheme>['colors'],
  _s: ReturnType<typeof getTheme>['sections']['workout'],
) => StyleSheet.create({

  card: {
    backgroundColor: c.surface,
    borderRadius: radius.xl,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.border,
  },

  // Stats strip — plain inline row, no colored background. Mirrors the
  // macros grid on the meal accordion: just numbers + dividers, sitting
  // flush at the top of the body.
  statsStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  statsDivider: { width: 1, height: 12 },

  warmupHint: {
    fontSize: 10,
    fontWeight: '500',
    color: c.textMuted,
    paddingHorizontal: 16,
    paddingBottom: 6,
    fontStyle: 'italic',
  },

  // Body
  body: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },

  // Exercise row
  exRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
  },
  exNum: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  exNumText:   { fontSize: 10, fontWeight: '900', color: '#fff', letterSpacing: 0.5 },
  exInfo:      { flex: 1, gap: 3 },
  exName:      { fontSize: 14, fontWeight: '700', lineHeight: 19 },
  exEquipment: { fontSize: 11, fontWeight: '500', marginBottom: 6 },
  exChips:     { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },

  videoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  videoChipText: { fontSize: 11, fontWeight: '700' },
});
