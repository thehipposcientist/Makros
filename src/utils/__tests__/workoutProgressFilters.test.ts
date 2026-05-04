import {
  buildExerciseTrendMap,
  buildLocalE1RMHistory,
  isTrackableStrengthExercise,
} from '../workoutProgressFilters.ts';
import { estimate1RM } from '../oneRepMax.ts';
import type { WorkoutSession } from '../../types';

const session = (
  date: string,
  exercises: WorkoutSession['exercises'],
): WorkoutSession => ({
  id: date,
  date,
  focus: 'Upper',
  durationSeconds: 3600,
  exercises,
  completed: true,
});

describe('workout progress filters', () => {
  it('keeps loaded strength exercises trackable', () => {
    expect(isTrackableStrengthExercise({
      name: 'Barbell Bench Press',
      primaryMuscle: 'chest',
      sets: [{ setNumber: 1, weightLbs: 185, reps: 5 }],
    })).toBe(true);
    expect(isTrackableStrengthExercise({
      name: 'Dumbbell Snatch',
      primaryMuscle: 'full_body',
      sets: [{ setNumber: 1, weightLbs: 50, reps: 5 }],
    })).toBe(true);
  });

  it('filters cardio and mobility even when they log duration or reps', () => {
    expect(isTrackableStrengthExercise({
      name: 'Treadmill',
      primaryMuscle: 'cardio',
      sets: [{ setNumber: 1, weightLbs: 0, reps: 25, durationSeconds: 1500 }],
    })).toBe(false);
    expect(isTrackableStrengthExercise({
      name: 'Foam Rolling - Full Body',
      primaryMuscle: 'mobility',
      sets: [{ setNumber: 1, weightLbs: 0, reps: 1, durationSeconds: 300 }],
    })).toBe(false);
    expect(isTrackableStrengthExercise({
      name: 'Worlds Greatest Stretch',
      primaryMuscle: 'full_body',
      sets: [{ setNumber: 1, weightLbs: 10, reps: 5 }],
    })).toBe(false);
    expect(isTrackableStrengthExercise({
      name: 'Y-Raise',
      primaryMuscle: 'shoulders',
      movement_pattern: 'mobility',
      sets: [{ setNumber: 1, weightLbs: 5, reps: 12 }],
    })).toBe(false);
  });

  it('builds strength trends from loaded sets only', () => {
    const history = [
      session('2026-05-01T12:00:00Z', [
        {
          name: 'Barbell Bench Press',
          targetSets: 3,
          targetReps: '5',
          targetRestSeconds: 180,
          equipment: 'barbell',
          primaryMuscle: 'chest',
          sets: [{ setNumber: 1, weightLbs: 185, reps: 5 }],
        },
        {
          name: 'Treadmill',
          targetSets: 1,
          targetReps: '20 min',
          targetRestSeconds: 0,
          equipment: 'treadmill',
          primaryMuscle: 'cardio',
          sets: [{ setNumber: 1, weightLbs: 0, reps: 20, durationSeconds: 1200 }],
        },
      ]),
      session('2026-05-03T12:00:00Z', [
        {
          name: 'Barbell Bench Press',
          targetSets: 3,
          targetReps: '5',
          targetRestSeconds: 180,
          equipment: 'barbell',
          primaryMuscle: 'chest',
          sets: [{ setNumber: 1, weightLbs: 190, reps: 5 }],
        },
      ]),
    ];
    const trend = buildExerciseTrendMap(history);
    expect(Object.keys(trend)).toEqual(['barbell bench press']);
    expect(trend['barbell bench press'].length).toBe(2);
    expect(trend['barbell bench press'][1].bestWeight).toBe(190);
  });

  it('derives local e1RM history without requiring logged RIR', () => {
    const history = [
      session('2026-05-01T12:00:00Z', [{
        name: 'Barbell Bench Press',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 180,
        equipment: 'barbell',
        primaryMuscle: 'chest',
        sets: [{ setNumber: 1, weightLbs: 185, reps: 5 }],
      }]),
      session('2026-05-03T12:00:00Z', [{
        name: 'Barbell Bench Press',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 180,
        equipment: 'barbell',
        primaryMuscle: 'chest',
        sets: [{ setNumber: 1, weightLbs: 190, reps: 5 }],
      }]),
    ];
    const points = buildLocalE1RMHistory(history, 'Barbell Bench Press', estimate1RM);
    expect(points.length).toBe(2);
    expect(points[1].e1rm_lbs > points[0].e1rm_lbs).toBe(true);
  });
});
