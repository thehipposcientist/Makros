import { View, Text, StyleSheet, TouchableOpacity, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WorkoutDay, AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';

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
  const estimatedMinutes = Math.round(workout.exercises.length * 8);

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
      {/* Number */}
      <View style={[styles.exNum, { backgroundColor: section.strong }]}>
        <Text style={styles.exNumText}>{String(index + 1).padStart(2, '0')}</Text>
      </View>

      {/* Info */}
      <View style={styles.exInfo}>
        <Text style={[styles.exName, { color: c.textPrimary }]}>{exercise.name}</Text>
        {exercise.equipment ? (
          <Text style={[styles.exEquipment, { color: c.textMuted }]}>{exercise.equipment}</Text>
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
