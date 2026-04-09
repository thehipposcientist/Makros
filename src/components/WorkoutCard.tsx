import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { WorkoutDay } from '../types';
import { AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';

interface WorkoutCardProps {
  workout: WorkoutDay;
  themeName?: AppThemeName;
  onOpenExerciseVideo?: (exerciseName: string) => void;
}

export default function WorkoutCard({ workout, themeName, onOpenExerciseVideo }: WorkoutCardProps) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const section = theme.sections.workout;
  const styles = createStyles(colors, section);

  return (
    <View style={styles.card}>
      {/* Icon-based section header with soft blue tint */}
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionIcon}>🏋️</Text>
        <Text style={styles.sectionLabel}>WORKOUT</Text>
        <View style={styles.sectionDivider} />
        <Text style={styles.sectionMeta}>{workout.focus}</Text>
        <View style={[styles.countBadge, { backgroundColor: section.strong + '22', borderColor: section.strong + '55' }]}>
          <Text style={[styles.countText, { color: section.text }]}>{workout.exercises.length} exercises</Text>
        </View>
      </View>

      {/* Exercise list */}
      <View style={styles.body}>
        <View style={styles.exercisesContainer}>
          {workout.exercises.map((exercise, index) => (
            <View key={index} style={styles.exerciseItem}>
              <View style={styles.exerciseRow}>
                <View style={styles.indexBadge}>
                  <Text style={styles.indexText}>{index + 1}</Text>
                </View>
                <View style={styles.exerciseInfo}>
                  <Text style={styles.exerciseName}>{exercise.name}</Text>
                  <Text style={styles.equipment}>{exercise.equipment}</Text>
                </View>
              </View>
              <View style={styles.badges}>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{exercise.sets} × {exercise.reps}</Text>
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>Rest {exercise.restSeconds}s</Text>
                </View>
                {onOpenExerciseVideo ? (
                  <TouchableOpacity
                    style={styles.videoBadge}
                    onPress={() => onOpenExerciseVideo(exercise.name)}>
                    <Text style={styles.videoBadgeText}>Form ↗</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          ))}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Focus on form · rest fully between sets</Text>
        </View>
      </View>
    </View>
  );
}

const createStyles = (
  colors: ReturnType<typeof getTheme>['colors'],
  section: ReturnType<typeof getTheme>['sections']['workout'],
) => StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginBottom: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },

  // ── Section identity header ──────────────────────────────────────────────────
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: section.soft,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: section.strong + '30',
  },
  sectionIcon: { fontSize: 15 },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: section.text,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionDivider: {
    width: 1,
    height: 12,
    backgroundColor: section.strong + '44',
    marginHorizontal: 2,
  },
  sectionMeta: {
    fontSize: 13,
    fontWeight: '600',
    color: section.text,
    flex: 1,
  },
  countBadge: {
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  countText: { fontSize: 11, fontWeight: '700' },

  // ── Body ─────────────────────────────────────────────────────────────────────
  body: { padding: 14 },

  exercisesContainer: { gap: 8, marginBottom: 14 },

  exerciseItem: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 10,
  },

  exerciseRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },

  indexBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: section.soft,
    borderWidth: 1,
    borderColor: section.strong + '55',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  indexText: { fontSize: 11, fontWeight: '800', color: section.text },

  exerciseInfo: { flex: 1 },
  exerciseName: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginBottom: 3 },
  equipment:    { fontSize: 11, color: colors.textMuted },

  badges: { flexDirection: 'row', gap: 7, flexWrap: 'wrap', marginLeft: 34 },
  badge: {
    backgroundColor: section.soft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: section.strong + '40',
  },
  badgeText: { fontSize: 12, color: section.text, fontWeight: '600' },

  videoBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: section.strong,
    backgroundColor: section.strong + '14',
  },
  videoBadgeText: { fontSize: 12, color: section.strong, fontWeight: '700' },

  footer: { paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontSize: 12, color: colors.textMuted, textAlign: 'center' },
});
