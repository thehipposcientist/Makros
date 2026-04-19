import { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WorkoutDay, AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';
import { humanizeToken } from '../utils/exerciseGuide';
import { getExerciseImage } from '../utils/exerciseImages';

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
}

export default function WorkoutCard({ workout, themeName, onOpenExerciseVideo }: WorkoutCardProps) {
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
    const secs = workout.exercises.reduce((total, ex) => {
      const sets = Number(ex.sets) || 3;
      const rest = Number((ex as any).restSeconds ?? (ex as any).rest_seconds) || 60;
      const timedWorkSec = parseWorkSecondsPerSet((ex as any).reps, ex.name);
      if (timedWorkSec != null) {
        // Timed exercise: actual working time per set + rest between sets.
        // Mobility/stretch exercises get minimal setup (10s); strength/cardio get 60s.
        // No extra setup time — the work time + rest already accounts for
        // transitions. The old +60s per exercise inflated mobility/recovery
        // estimates by 10+ minutes.
        return total + sets * timedWorkSec + Math.max(0, sets - 1) * rest;
      }
      // Classic strength set: ~45s of work + prescribed rest. The
      // backend's density budget already bakes ramp-up/warmup time
      // into its primary-slot cost (primary=12 min includes warmup),
      // so we do NOT add extra warmup seconds here — that would
      // double-count against the session_minutes budget.
      return total + sets * 45 + Math.max(0, sets - 1) * rest;
    }, 0);
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
        Includes ~5 min warm-up time at the start of the session.
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

function ExerciseRow({ index, exercise, isLast, section, c, styles, onOpenVideo }: {
  index: number;
  exercise: WorkoutDay['exercises'][number];
  isLast: boolean;
  section: ReturnType<typeof getTheme>['sections']['workout'];
  c: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  onOpenVideo?: (name: string) => void;
}) {
  return (
    <View style={[styles.exRow, !isLast && { borderBottomWidth: 1, borderBottomColor: c.border + '66' }]}>
      {/* Thumbnail / Number */}
      {(() => {
        const imgUrl = exercise.image_url || getExerciseImage(exercise.name);
        return imgUrl ? (
          <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: c.surface, overflow: 'hidden', borderWidth: 1, borderColor: c.border }}>
            <Image source={{ uri: imgUrl }} style={{ width: 44, height: 44 }} resizeMode="cover" />
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
            label={`${exercise.sets} × ${exercise.reps}`}
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
