import {
  buildCycleSupportGuidance,
  cycleStartDateForLog,
  plannedSetTotal,
  reduceWorkoutForCycleSymptoms,
  summarizeCyclePattern,
  upsertPeriodSymptomLog,
  type PeriodSymptomLog,
} from '../cycleSupport.ts';

describe('cycle support guidance', () => {
  it('treats severe period symptoms as a recovery recommendation', () => {
    const guidance = buildCycleSupportGuidance({
      phase: 'menses',
      dayOfCycle: 1,
      cycleLengthDays: 38,
      flow: 'heavy',
      cramps: 'severe',
      energy: 'low',
    });

    expect(guidance.trainingAction).toBe('recovery');
    expect(guidance.nutrition.some(n => n.title.includes('Hydration'))).toBe(true);
    expect(guidance.safety.length >= 2).toBe(true);
  });

  it('keeps normal training available when symptoms are mild', () => {
    const guidance = buildCycleSupportGuidance({
      phase: 'menses',
      dayOfCycle: 3,
      cycleLengthDays: 29,
      flow: 'light',
      cramps: 'mild',
      energy: 'high',
    });

    expect(guidance.trainingAction).toBe('keep');
    expect(guidance.safety.length).toBe(0);
  });

  it('frames period guidance as part of the cycle', () => {
    const guidance = buildCycleSupportGuidance({
      phase: 'menses',
      dayOfCycle: 2,
      cycleLengthDays: 29,
      flow: 'moderate',
      cramps: 'mild',
      energy: 'normal',
    });

    expect(guidance.phaseTitle).toBe('Period phase');
    expect(guidance.phaseDetail).toContain('day 2');
    expect(guidance.trainingDetail).toContain('planned session');
  });

  it('uses phase-specific advice outside the period window', () => {
    const follicular = buildCycleSupportGuidance({
      phase: 'follicular',
      dayOfCycle: 8,
      cycleLengthDays: 29,
    });
    const luteal = buildCycleSupportGuidance({
      phase: 'luteal',
      dayOfCycle: 24,
      cycleLengthDays: 29,
      energy: 'low',
    });

    expect(follicular.phaseTitle).toBe('Follicular phase');
    expect(follicular.trainingTitle).toContain('Build normally');
    expect(follicular.nutrition.some(n => n.title === 'Protein at each meal')).toBe(true);
    expect(luteal.trainingAction).toBe('lighter');
    expect(luteal.trainingTitle).toContain('reserve');
  });

  it('derives cycle start from the logged cycle day', () => {
    expect(cycleStartDateForLog('2026-05-04', 1)).toBe('2026-05-04');
    expect(cycleStartDateForLog('2026-05-04', 4)).toBe('2026-05-01');
  });
});

describe('cycle support workout adjustment', () => {
  it('reduces same-day sets and softens target loading', () => {
    const workout = {
      day: 'Monday',
      focus: 'Legs',
      exercises: [
        {
          name: 'Back Squat',
          sets: 4,
          reps: '6-8',
          restSeconds: 120,
          equipment: 'gym',
          targetWeightLbs: 185,
          setScheme: [
            { setNumber: 1, setType: 'working', targetReps: '6', targetRir: 2, targetWeightLbs: 185, progressionMode: 'double_progression' },
            { setNumber: 2, setType: 'working', targetReps: '6', targetRir: 2, targetWeightLbs: 185, progressionMode: 'double_progression' },
            { setNumber: 3, setType: 'working', targetReps: '6', targetRir: 2, targetWeightLbs: 185, progressionMode: 'double_progression' },
            { setNumber: 4, setType: 'working', targetReps: '6', targetRir: 2, targetWeightLbs: 185, progressionMode: 'double_progression' },
          ],
        },
        { name: 'Leg Curl', sets: 3, reps: '10-12', restSeconds: 60, equipment: 'machine' },
      ],
    } as any;

    const lighter = reduceWorkoutForCycleSymptoms(workout);
    expect(plannedSetTotal(lighter) < plannedSetTotal(workout)).toBe(true);
    expect(lighter.exercises[0].sets).toBe(2);
    expect(lighter.exercises[0].targetWeightLbs).toBe(165);
    expect(lighter.exercises[0].setScheme?.length).toBe(2);
    expect(lighter.exercises[0].setScheme?.[0].targetRir).toBe(3);
  });
});

describe('cycle support learning', () => {
  const baseLog: PeriodSymptomLog = {
    date: '2026-03-01',
    cycleStartDate: '2026-03-01',
    phase: 'menses',
    dayOfCycle: 1,
    cycleLengthDays: 30,
    flow: 'heavy',
    cramps: 'moderate',
    energy: 'low',
    action: null,
    updatedAt: '2026-03-01T12:00:00.000Z',
  };

  it('upserts daily logs by date', () => {
    const logs = upsertPeriodSymptomLog([baseLog], { ...baseLog, flow: 'light', updatedAt: 'later' });
    expect(logs.length).toBe(1);
    expect(logs[0].flow).toBe('light');
  });

  it('surfaces a pattern after two prior cycles', () => {
    const logs = [
      baseLog,
      { ...baseLog, date: '2026-03-02', dayOfCycle: 2 },
      { ...baseLog, date: '2026-04-01', cycleStartDate: '2026-04-01', action: 'lighter' },
      { ...baseLog, date: '2026-04-02', cycleStartDate: '2026-04-01', dayOfCycle: 2, action: 'recovery' },
    ];

    const insight = summarizeCyclePattern(logs, '2026-05-04');
    expect(typeof insight).toBe('string');
    expect(insight?.includes('lighter or recovery')).toBe(true);
  });
});
