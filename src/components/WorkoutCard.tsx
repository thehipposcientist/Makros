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

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={styles.header}>
        <View style={[styles.headerIconCircle, { backgroundColor: s.strong + '1E' }]}>
          <Ionicons name="barbell-outline" size={17} color={s.strong} />
        </View>
        <View style={styles.headerMid}>
          <Text style={[styles.headerSection, { color: s.strong }]}>WORKOUT</Text>
          <Text style={[styles.headerFocus, { color: c.textPrimary }]} numberOfLines={1}>
            {workout.focus}
          </Text>
        </View>
        <View style={[styles.headerCountBadge, { backgroundColor: s.strong + '18', borderColor: s.strong + '44' }]}>
          <Text style={[styles.headerCountNum, { color: s.strong }]}>{workout.exercises.length}</Text>
          <Text style={[styles.headerCountLabel, { color: s.strong + 'CC' }]}>ex</Text>
        </View>
      </View>

      {/* ── Stats strip ────────────────────────────────────────────────── */}
      <View style={[styles.statsStrip, { backgroundColor: s.soft, borderBottomColor: s.strong + '1E' }]}>
        <StatItem icon="time-outline" value={`~${estimatedMinutes} min`} color={s.strong} c={c} />
        <View style={[styles.statsDivider, { backgroundColor: s.strong + '30' }]} />
        <StatItem icon="layers-outline" value={`${totalSets} sets total`} color={s.strong} c={c} />
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

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <View style={[styles.footer, { borderTopColor: c.border }]}>
        <Ionicons name="information-circle-outline" size={12} color={c.textMuted} />
        <Text style={[styles.footerText, { color: c.textMuted }]}>
          Focus on form · rest fully between sets
        </Text>
      </View>

    </View>
  );
}

// ── StatItem ──────────────────────────────────────────────────────────────────

function StatItem({ icon, value, color, c }: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  color: string;
  c: ReturnType<typeof getTheme>['colors'];
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
  s: ReturnType<typeof getTheme>['sections']['workout'],
) => StyleSheet.create({

  card: {
    backgroundColor: c.surface,
    borderRadius: radius.xl,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.border,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: s.soft,
  },
  headerIconCircle: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerMid: { flex: 1, gap: 1 },
  headerSection: { fontSize: 10, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
  headerFocus:   { fontSize: 15, fontWeight: '700' },
  headerCountBadge: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
  },
  headerCountNum:   { fontSize: 16, fontWeight: '800' },
  headerCountLabel: { fontSize: 9, fontWeight: '600', letterSpacing: 0.5 },

  // Stats strip
  statsStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
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

  // Footer
  footer:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1 },
  footerText: { fontSize: 11 },
});
