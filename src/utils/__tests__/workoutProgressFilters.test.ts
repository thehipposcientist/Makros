import {
  buildExerciseTrendMap,
  buildLocalE1RMHistory,
  buildStrengthTrendSummary,
  inferChartMuscleFromName,
  inferRelativeStrengthSecondaries,
  isTrackableStrengthExercise,
  relativeStrengthPrimaryForName,
  shouldExcludeRelativeStrengthSecondary,
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

  it('keeps core strength names out of the cardio bucket', () => {
    expect(inferChartMuscleFromName('Weighted Plank')).toBe('core');
    expect(inferChartMuscleFromName('Hollow Body Hold')).toBe('core');
    expect(isTrackableStrengthExercise({
      name: 'Weighted Plank',
      primaryMuscle: 'core',
      sets: [{ setNumber: 1, weightLbs: 25, reps: 1, durationSeconds: 45 }],
    })).toBe(true);
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

  it('matches sparse repeat lifts across an 8-week strength trend window', () => {
    const history = [
      session('2026-03-26T12:00:00Z', [{
        name: 'Barbell Bench Press',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 180,
        equipment: 'barbell',
        primaryMuscle: 'chest',
        isCompound: true,
        sets: [{ setNumber: 1, weightLbs: 185, reps: 5 }],
      }]),
      session('2026-04-10T12:00:00Z', [{
        name: 'Back Squat',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 180,
        equipment: 'barbell',
        primaryMuscle: 'quads',
        isCompound: true,
        sets: [{ setNumber: 1, weightLbs: 245, reps: 5 }],
      }]),
      session('2026-05-09T12:00:00Z', [{
        name: 'Barbell Bench Press',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 180,
        equipment: 'barbell',
        primaryMuscle: 'chest',
        isCompound: true,
        sets: [{ setNumber: 1, weightLbs: 195, reps: 5 }],
      }]),
      session('2026-05-16T12:00:00Z', [{
        name: 'Back Squat',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 180,
        equipment: 'barbell',
        primaryMuscle: 'quads',
        isCompound: true,
        sets: [{ setNumber: 1, weightLbs: 255, reps: 5 }],
      }]),
    ];

    const summary = buildStrengthTrendSummary(history, { today: '2026-05-19' });
    expect(summary?.matchedRows.length).toBe(2);
    expect(summary?.trendPct).toBeGreaterThan(0);
    expect(summary?.rows.map(row => row.name).sort()).toEqual(['Back Squat', 'Barbell Bench Press']);
  });

  it('does not produce an overall score from one repeated lift', () => {
    const history = [
      session('2026-04-01T12:00:00Z', [{
        name: 'Barbell Bench Press',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 180,
        equipment: 'barbell',
        primaryMuscle: 'chest',
        isCompound: true,
        sets: [{ setNumber: 1, weightLbs: 185, reps: 5 }],
      }]),
      session('2026-05-16T12:00:00Z', [{
        name: 'Barbell Bench Press',
        targetSets: 3,
        targetReps: '5',
        targetRestSeconds: 180,
        equipment: 'barbell',
        primaryMuscle: 'chest',
        isCompound: true,
        sets: [{ setNumber: 1, weightLbs: 195, reps: 5 }],
      }]),
    ];

    const summary = buildStrengthTrendSummary(history, { today: '2026-05-19' });
    expect(summary?.matchedRows.length).toBe(1);
    expect(summary?.trendPct).toBe(null);
  });

  it('routes deadlift variants to hamstrings, not back (2026-05 audit)', () => {
    // The conventional deadlift is a hip-hinge lift; back acts as an
    // isometric stabilizer, not a prime mover. Users who only
    // deadlifted previously saw inflated `back` scores on the Relative
    // Strength Radar — that's the bug this case locks down.
    expect(inferChartMuscleFromName('Deadlift')).toBe('hamstrings');
    expect(inferChartMuscleFromName('Conventional Deadlift')).toBe('hamstrings');
    expect(inferChartMuscleFromName('Sumo Deadlift')).toBe('hamstrings');
    expect(inferChartMuscleFromName('Trap Bar Deadlift')).toBe('hamstrings');
    expect(inferChartMuscleFromName('Barbell Romanian Deadlift')).toBe('hamstrings');
    expect(inferChartMuscleFromName('Stiff-Leg Deadlift')).toBe('hamstrings');
  });

  it('keeps actual back lifts in the back bucket', () => {
    // Make sure the deadlift fix didn't break legitimate back routing
    // — rows, pulldowns, pull-ups stay where they belong.
    expect(inferChartMuscleFromName('Barbell Row')).toBe('back');
    expect(inferChartMuscleFromName('Lat Pulldown')).toBe('back');
    expect(inferChartMuscleFromName('Pull-Up')).toBe('back');
    expect(inferChartMuscleFromName('One-Arm Dumbbell Row')).toBe('back');
    expect(inferChartMuscleFromName('Chin-Up')).toBe('back');
  });

  it('does not let floor-pull deadlifts populate the glute strength axis', () => {
    expect(relativeStrengthPrimaryForName('Deadlift', 'glutes')).toBe('hamstrings');
    expect(relativeStrengthPrimaryForName('Trap Bar Deadlift', 'back')).toBe('hamstrings');
    expect(inferRelativeStrengthSecondaries('Deadlift', 'hamstrings').includes('glutes')).toBe(false);
    expect(shouldExcludeRelativeStrengthSecondary('Deadlift', 'glutes')).toBe(true);
    expect(shouldExcludeRelativeStrengthSecondary('Sumo Deadlift', 'glutes')).toBe(true);
  });

  it('keeps glute credit for direct glute and stretched-hinge lifts', () => {
    expect(relativeStrengthPrimaryForName('Barbell Hip Thrust', 'glutes')).toBe('glutes');
    expect(inferRelativeStrengthSecondaries('Barbell Romanian Deadlift', 'hamstrings')).toContain('glutes');
    expect(shouldExcludeRelativeStrengthSecondary('Barbell Romanian Deadlift', 'glutes')).toBe(false);
  });
});
