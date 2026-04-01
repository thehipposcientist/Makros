import AsyncStorage from '@react-native-async-storage/async-storage';
import { WorkoutSession, CompletedSet } from '../types';

const HISTORY_KEY = 'workoutHistory';

export async function saveWorkoutSession(session: WorkoutSession): Promise<void> {
  const history = await loadWorkoutHistory();
  // Replace if same id exists, otherwise prepend
  const idx = history.findIndex(s => s.id === session.id);
  if (idx >= 0) {
    history[idx] = session;
  } else {
    history.unshift(session);
  }
  // Keep last 100 sessions
  await AsyncStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
}

export async function loadWorkoutHistory(): Promise<WorkoutSession[]> {
  try {
    const raw = await AsyncStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Returns the completed sets for a given exercise from the most recent session that included it. */
export async function getLastSetsForExercise(exerciseName: string): Promise<CompletedSet[] | null> {
  const history = await loadWorkoutHistory();
  for (const session of history) {
    const ex = session.exercises.find(
      e => e.name.toLowerCase() === exerciseName.toLowerCase()
    );
    if (ex && ex.sets.length > 0) {
      return ex.sets;
    }
  }
  return null;
}
