// 2026-05 regression: isolation kickbacks are glute volume work, but
// they should not become the user's glute relative-strength signal.
// The strength profile uses compound-capable estimates: hip thrusts,
// squats, RDLs, and similar loaded patterns.

import { buildRelativeStrengthProfiles } from '../progressData.ts';
import type { WorkoutSession } from '../../types';

const session = (date: string, exercises: any[]): WorkoutSession => ({
  id: date,
  date,
  focus: 'Lower',
  durationSeconds: 3600,
  exercises,
  completed: true,
});

describe('relative strength radar — glutes representative exercise', () => {
  it('ignores glute kickback isolation on the glute strength axis', () => {
    const history: WorkoutSession[] = [
      session('2026-05-25T12:00:00Z', [
        {
          name: 'Barbell Back Squat',
          targetSets: 3,
          targetReps: '5',
          equipment: 'barbell',
          primaryMuscle: 'quads',
          isCompound: true,
          sets: [{ setNumber: 1, weightLbs: 315, reps: 5 }],
        },
        {
          name: 'Cable Glute Kickback',
          targetSets: 3,
          targetReps: '12',
          equipment: 'cable_machine',
          primaryMuscle: 'glutes',
          isCompound: false,
          sets: [{ setNumber: 1, weightLbs: 40, reps: 12 }],
        },
      ]),
    ];

    const profiles = buildRelativeStrengthProfiles(history, 200, {
      today: '2026-05-26',
    });
    const glutes = profiles.find(p => p.muscle === 'glutes');
    expect(glutes != null).toBe(true);
    expect(glutes!.exercise.toLowerCase()).toContain('squat');
    expect(glutes!.score).toBeGreaterThan(60);
    expect(glutes!.contributingExercises).toBe(1);
  });

  it('does not create a glute strength profile from kickbacks alone', () => {
    const history: WorkoutSession[] = [
      session('2026-05-25T12:00:00Z', [
        {
          name: 'Cable Glute Kickback',
          targetSets: 3,
          targetReps: '12',
          equipment: 'cable_machine',
          primaryMuscle: 'glutes',
          isCompound: false,
          sets: [{ setNumber: 1, weightLbs: 80, reps: 12 }],
        },
      ]),
    ];

    const profiles = buildRelativeStrengthProfiles(history, 200, {
      today: '2026-05-26',
    });
    expect(profiles.find(p => p.muscle === 'glutes') == null).toBe(true);
  });

  it('genuine ties (within 1 score point) prefer the primary lift', () => {
    // When a primary and secondary score essentially the same, the
    // tiebreaker still prefers the primary because direct-load
    // measurements are higher-confidence than indirect estimates.
    // This is the stability band we kept in the new sort.
    const history: WorkoutSession[] = [
      session('2026-05-25T12:00:00Z', [
        // Hip thrust (primary glutes). Calibrate weight so its score
        // lands near a comparable squat's secondary glute score.
        {
          name: 'Barbell Hip Thrust',
          targetSets: 3,
          targetReps: '5',
          equipment: 'barbell',
          primaryMuscle: 'glutes',
          isCompound: true,
          sets: [{ setNumber: 1, weightLbs: 250, reps: 5 }],
        },
        // Squat that gives glutes secondary credit of approximately
        // the same magnitude.
        {
          name: 'Barbell Back Squat',
          targetSets: 3,
          targetReps: '5',
          equipment: 'barbell',
          primaryMuscle: 'quads',
          isCompound: true,
          sets: [{ setNumber: 1, weightLbs: 290, reps: 5 }],
        },
      ]),
    ];
    const profiles = buildRelativeStrengthProfiles(history, 200, {
      today: '2026-05-26',
    });
    const glutes = profiles.find(p => p.muscle === 'glutes');
    expect(glutes != null).toBe(true);
    expect(glutes!.exercise.toLowerCase()).toContain('hip thrust');
    expect(glutes!.source).toBe('primary');
  });

  it('counts multiple compound contributors without counting isolation kickbacks', () => {
    // A glutes-focused lifter who trains with squat + RDL but no
    // dedicated glute lift should still see a "+1 supporting lift"
    // caption — both are posterior-chain compounds crediting glutes
    // even though both are tagged primary→hamstrings/quads.
    const history: WorkoutSession[] = [
      session('2026-05-25T12:00:00Z', [
        {
          name: 'Barbell Back Squat',
          targetSets: 3,
          targetReps: '5',
          equipment: 'barbell',
          primaryMuscle: 'quads',
          isCompound: true,
          sets: [{ setNumber: 1, weightLbs: 315, reps: 5 }],
        },
        {
          name: 'Romanian Deadlift',
          targetSets: 3,
          targetReps: '8',
          equipment: 'barbell',
          primaryMuscle: 'hamstrings',
          isCompound: true,
          sets: [{ setNumber: 1, weightLbs: 275, reps: 8 }],
        },
        {
          name: 'Cable Glute Kickback',
          targetSets: 3,
          targetReps: '12',
          equipment: 'cable_machine',
          primaryMuscle: 'glutes',
          isCompound: false,
          sets: [{ setNumber: 1, weightLbs: 40, reps: 12 }],
        },
      ]),
    ];
    const profiles = buildRelativeStrengthProfiles(history, 200, {
      today: '2026-05-26',
    });
    const glutes = profiles.find(p => p.muscle === 'glutes');
    expect(glutes != null).toBe(true);
    expect(glutes!.contributingExercises).toBe(2);
  });
});
