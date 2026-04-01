import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { WorkoutDay } from '../types';

interface WorkoutCardProps {
  workout: WorkoutDay;
}

export default function WorkoutCard({ workout }: WorkoutCardProps) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>🏋️ {workout.focus}</Text>
        <Text style={styles.subtitle}>{workout.day}</Text>
      </View>

      <View style={styles.exercisesContainer}>
        {workout.exercises.map((exercise, index) => (
          <View key={index} style={styles.exerciseItem}>
            <View style={styles.exerciseHeader}>
              <Text style={styles.exerciseName}>{exercise.name}</Text>
              <Text style={styles.equipment}>• {exercise.equipment}</Text>
            </View>
            <View style={styles.exerciseDetails}>
              <View style={styles.detailBadge}>
                <Text style={styles.detailText}>
                  {exercise.sets} × {exercise.reps}
                </Text>
              </View>
              <View style={styles.detailBadge}>
                <Text style={styles.detailText}>
                  Rest: {exercise.restSeconds}s
                </Text>
              </View>
            </View>
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          ✅ Complete all exercises with proper form
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#f0f7ff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  header: {
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    color: '#666',
  },
  exercisesContainer: {
    gap: 12,
    marginBottom: 12,
  },
  exerciseItem: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  exerciseHeader: {
    marginBottom: 10,
  },
  exerciseName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#000',
    marginBottom: 4,
  },
  equipment: {
    fontSize: 12,
    color: '#999',
  },
  exerciseDetails: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  detailBadge: {
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  detailText: {
    fontSize: 12,
    color: '#666',
    fontWeight: '500',
  },
  footer: {
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e0e0e0',
  },
  footerText: {
    fontSize: 12,
    color: '#007AFF',
    fontWeight: '500',
  },
});
