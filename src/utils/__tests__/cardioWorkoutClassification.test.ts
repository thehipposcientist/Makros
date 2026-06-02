import {
  classifyWorkoutCardioKind,
  estimatedMixedCardioMinutes,
  summarizeCardioWorkoutZones,
} from '../cardioWorkoutClassification.ts';

describe('cardio workout classification', () => {
  it('does not count strength HR-zone exposure as cardio', () => {
    const summary = summarizeCardioWorkoutZones({
      name: 'Functional Strength Training',
      durationMin: 62,
      zoneMinutes: [8, 26, 20, 8, 0],
    });

    expect(summary?.cardioMinutes).toBe(0);
    expect(summary?.zone2Minutes).toBe(0);
    expect(summary?.source).toBe('none');
  });

  it('does not mistake strength rowing movements for cardio rowing', () => {
    expect(classifyWorkoutCardioKind('Barbell Row Strength').kind).toBe('non_cardio');
    expect(classifyWorkoutCardioKind('Rowing').kind).toBe('cardio');
    expect(classifyWorkoutCardioKind('Cross Training').kind).toBe('cardio');
  });

  it('limits mixed strength plus cardio workouts to the estimated finisher', () => {
    const summary = summarizeCardioWorkoutZones({
      name: 'Push + Cardio',
      durationMin: 60,
      zoneMinutes: [5, 35, 15, 5, 0],
    });

    expect(summary?.cardioMinutes).toBe(15);
    expect(summary?.zone2Minutes).toBe(15);
    expect(summary?.source).toBe('heart_rate');
  });

  it('counts pure steady cardio as cardio and Zone 2 without HR data', () => {
    const summary = summarizeCardioWorkoutZones({
      name: 'Zone 2 Bike',
      durationMin: 45,
    });

    expect(summary?.cardioMinutes).toBe(45);
    expect(summary?.zone2Minutes).toBe(45);
    expect(summary?.source).toBe('heuristic');
  });

  it('counts high-intensity cardio minutes without adding Zone 2 credit', () => {
    const summary = summarizeCardioWorkoutZones({
      name: 'HIIT Intervals',
      durationMin: 30,
    });

    expect(summary?.cardioMinutes).toBe(30);
    expect(summary?.zone2Minutes).toBe(0);
  });

  it('estimates mixed cardio finishers from total session duration', () => {
    expect(estimatedMixedCardioMinutes(30)).toBe(10);
    expect(estimatedMixedCardioMinutes(60)).toBe(15);
    expect(estimatedMixedCardioMinutes(100)).toBe(20);
  });
});
