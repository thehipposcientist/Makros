import { View, Text, StyleSheet } from 'react-native';
import { WorkoutDay } from '../types';
import { colors, radius } from '../constants/theme';

interface WorkoutCardProps {
  workout: WorkoutDay;
}

export default function WorkoutCard({ workout }: WorkoutCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{workout.focus}</Text>
        <Text style={styles.subtitle}>{workout.day}</Text>
      </View>

      <View style={styles.exercisesContainer}>
        {workout.exercises.map((exercise, index) => (
          <View key={index} style={styles.exerciseItem}>
            <View style={styles.exerciseHeader}>
              <Text style={styles.exerciseName}>{exercise.name}</Text>
              <Text style={styles.equipment}>{exercise.equipment}</Text>
            </View>
            <View style={styles.badges}>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{exercise.sets} × {exercise.reps}</Text>
              </View>
              <View style={styles.badge}>
                <Text style={styles.badgeText}>Rest {exercise.restSeconds}s</Text>
              </View>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Complete all sets with proper form</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  header:    { marginBottom: 16 },
  title:     { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 4 },
  subtitle:  { fontSize: 13, color: colors.textSecondary },

  exercisesContainer: { gap: 10, marginBottom: 14 },
  exerciseItem: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    padding: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  exerciseHeader: { marginBottom: 10 },
  exerciseName:   { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 3 },
  equipment:      { fontSize: 12, color: colors.textMuted },

  badges:    { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  badge: {
    backgroundColor: colors.background,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.border,
  },
  badgeText: { fontSize: 12, color: colors.primary, fontWeight: '600' },

  footer:     { paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  footerText: { fontSize: 12, color: colors.textSecondary },
});
