import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { UserProfile, WorkoutPlan, DailyNutritionPlan } from '../types';
import { generateWorkoutPlan, generateDailyNutrition } from '../utils/planGenerator';
import WorkoutCard from '../components/WorkoutCard';
import NutritionCard from '../components/NutritionCard';

interface HomeScreenProps {
  userProfile: UserProfile | null;
}

export default function HomeScreen({ userProfile }: HomeScreenProps) {
  const [workoutPlan, setWorkoutPlan] = useState<WorkoutPlan | null>(null);
  const [nutritionPlan, setNutritionPlan] = useState<DailyNutritionPlan | null>(null);
  const [currentDayIndex, setCurrentDayIndex] = useState(0);

  useEffect(() => {
    if (userProfile) {
      const workout = generateWorkoutPlan(userProfile);
      const nutrition = generateDailyNutrition(userProfile);
      setWorkoutPlan(workout);
      setNutritionPlan(nutrition);
      setCurrentDayIndex(0);
    }
  }, [userProfile]);

  if (!userProfile || !workoutPlan || !nutritionPlan) {
    return (
      <View style={styles.container}>
        <Text>Loading...</Text>
      </View>
    );
  }

  const currentWorkout = workoutPlan.days[currentDayIndex] || null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.dateHeader}>
        <Text style={styles.dateText}>Today's Plan</Text>
        <Text style={styles.dateSubtext}>
          Goal: {userProfile.goal.replace('_', ' ').toUpperCase()}
        </Text>
      </View>

      {/* Workout Section */}
      {currentWorkout && (
        <WorkoutCard workout={currentWorkout} />
      )}

      {/* Nutrition Section */}
      <NutritionCard nutritionPlan={nutritionPlan} />

      {/* Quick Stats */}
      <View style={styles.statsContainer}>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>Training Days</Text>
          <Text style={styles.statValue}>{userProfile.daysPerWeek}/week</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statLabel}>Equipment</Text>
          <Text style={styles.statValue}>{userProfile.equipment.length}</Text>
        </View>
      </View>

      {/* Workout Cycle Navigation */}
      <View style={styles.navigationContainer}>
        <Text style={styles.navigationTitle}>Workout Cycle</Text>
        <View style={styles.dayScrollContainer}>
          {workoutPlan.days.map((_, index) => (
            <TouchableOpacity
              key={index}
              style={[
                styles.dayButton,
                index === currentDayIndex && styles.dayButtonActive,
              ]}
              onPress={() => setCurrentDayIndex(index)}
            >
              <Text
                style={[
                  styles.dayButtonText,
                  index === currentDayIndex && styles.dayButtonTextActive,
                ]}
              >
                {index + 1}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Information Section */}
      <View style={styles.infoContainer}>
        <Text style={styles.infoTitle}>💡 Tips</Text>
        <View style={styles.tipBox}>
          <Text style={styles.tipText}>
            • Rest days are important for recovery{'\n'}
            • Adjust exercises based on your form{'\n'}
            • Stay consistent with your nutrition
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  dateHeader: {
    marginBottom: 24,
  },
  dateText: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#000',
    marginBottom: 4,
  },
  dateSubtext: {
    fontSize: 14,
    color: '#666',
  },
  statsContainer: {
    flexDirection: 'row',
    gap: 12,
    marginVertical: 20,
  },
  statBox: {
    flex: 1,
    paddingVertical: 16,
    paddingHorizontal: 12,
    backgroundColor: '#f0f0f0',
    borderRadius: 12,
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 12,
    color: '#999',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#007AFF',
  },
  navigationContainer: {
    marginVertical: 24,
  },
  navigationTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
    color: '#000',
  },
  dayScrollContainer: {
    flexDirection: 'row',
    gap: 8,
  },
  dayButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#e0e0e0',
  },
  dayButtonActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  dayButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#666',
  },
  dayButtonTextActive: {
    color: '#ffffff',
  },
  infoContainer: {
    marginTop: 24,
    paddingBottom: 20,
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
    color: '#000',
  },
  tipBox: {
    backgroundColor: '#f9f9f9',
    padding: 12,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  tipText: {
    fontSize: 13,
    color: '#666',
    lineHeight: 20,
  },
});
