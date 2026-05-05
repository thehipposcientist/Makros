import { buildExerciseGuide } from '../exerciseGuide.ts';

describe('exercise guide copy', () => {
  it('uses sprint-specific space and recovery cues for Sprint Intervals', () => {
    const guide = buildExerciseGuide({
      name: 'Sprint Intervals',
      description: 'All-out sprints with walking recovery',
      primary_muscle: 'cardio',
      secondary_muscles: ['quads', 'glutes'],
      movement_pattern: 'cardio',
      exercise_type: 'cardio',
      is_compound: true,
    });

    expect(guide.phaseTitle).toBe('Interval Breakdown');
    expect(guide.primaryPhaseLabel).toBe('SPRINT');
    expect(guide.secondaryPhaseLabel).toBe('RECOVER');
    expect(guide.howTo).toContain('30-40 yards');
    expect(guide.setup).toContain('room to slow down');
    expect(guide.concentric.includes('weight')).toBe(false);
    expect(guide.eccentric.includes('lowering')).toBe(false);
  });

  it('uses pace/control language for steady cardio', () => {
    const guide = buildExerciseGuide({
      name: 'Bike Zone 2',
      primary_muscle: 'cardio',
      movement_pattern: 'cardio',
      exercise_type: 'cardio',
      is_compound: false,
    });

    expect(guide.phaseTitle).toBe('Cardio Execution');
    expect(guide.primaryPhaseLabel).toBe('PACE');
    expect(guide.secondaryPhaseLabel).toBe('CONTROL');
    expect(guide.feel).toContain('short sentences');
  });

  it('uses burpee-specific floor-to-stand cues', () => {
    const guide = buildExerciseGuide({
      name: 'Burpees',
      primary_muscle: 'cardio',
      movement_pattern: 'cardio',
      exercise_type: 'cardio',
      is_compound: true,
    });

    expect(guide.phaseTitle).toBe('Interval Breakdown');
    expect(guide.primaryPhaseLabel).toBe('REP');
    expect(guide.secondaryPhaseLabel).toBe('RESET');
    expect(guide.howTo).toContain('jump or step your feet back');
    expect(guide.movement).toContain('plank');
    expect(guide.concentric.includes('weight')).toBe(false);
    expect(guide.eccentric.includes('lowering')).toBe(false);
  });

  it('uses mountain-climber plank and knee-drive cues', () => {
    const guide = buildExerciseGuide({
      name: 'Mountain Climbers',
      primary_muscle: 'cardio',
      movement_pattern: 'cardio',
      exercise_type: 'cardio',
      is_compound: true,
    });

    expect(guide.primaryPhaseLabel).toBe('DRIVE');
    expect(guide.secondaryPhaseLabel).toBe('RESET');
    expect(guide.howTo).toContain('high plank');
    expect(guide.movement).toContain('knee drives');
  });

  it('uses upright drill cues for jumping jacks and high knees', () => {
    const jumpingJacks = buildExerciseGuide({
      name: 'Jumping Jacks',
      primary_muscle: 'cardio',
      movement_pattern: 'cardio',
      exercise_type: 'cardio',
    });
    const highKnees = buildExerciseGuide({
      name: 'High Knees',
      primary_muscle: 'cardio',
      movement_pattern: 'cardio',
      exercise_type: 'cardio',
    });

    expect(jumpingJacks.primaryPhaseLabel).toBe('JUMP');
    expect(jumpingJacks.howTo).toContain('arms reach overhead');
    expect(highKnees.primaryPhaseLabel).toBe('DRIVE');
    expect(highKnees.howTo).toContain('knees toward hip height');
  });

  it('uses battle-rope wave cues', () => {
    const guide = buildExerciseGuide({
      name: 'Battle Ropes',
      primary_muscle: 'cardio',
      movement_pattern: 'cardio',
      exercise_type: 'cardio',
      equipment: 'battle_ropes',
    });

    expect(guide.primaryPhaseLabel).toBe('WAVES');
    expect(guide.secondaryPhaseLabel).toBe('RESET');
    expect(guide.howTo).toContain('waves');
    expect(guide.setup).toContain('one rope end');
  });

  it('keeps strength exercises on lifting/lowering labels', () => {
    const guide = buildExerciseGuide({
      name: 'Barbell Bench Press',
      primary_muscle: 'chest',
      equipment: 'barbell',
      is_compound: true,
    });

    expect(guide.phaseTitle).toBe('Muscle Phase Breakdown');
    expect(guide.primaryPhaseLabel).toBe('↑ LIFTING');
    expect(guide.secondaryPhaseLabel).toBe('↓ LOWERING');
    expect(guide.concentric).toContain('press');
  });

  it('does not mistake strength rows for cardio rowing', () => {
    const guide = buildExerciseGuide({
      name: 'Barbell Row',
      primary_muscle: 'back',
      movement_pattern: 'horizontal_pull',
      equipment: 'barbell',
      is_compound: true,
    });

    expect(guide.phaseTitle).toBe('Muscle Phase Breakdown');
    expect(guide.primaryPhaseLabel).toBe('↑ LIFTING');
    expect(guide.concentric).toContain('Pulling');
  });
});
