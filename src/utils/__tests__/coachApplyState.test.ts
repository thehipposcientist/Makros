import {
  coachApplyNeedsDayStatusRefresh,
  isRecoverySkipReason,
  skippedDayBadgeLabel,
  skippedDayTitle,
  skippedDayUndoLabel,
} from '../coachApplyState.ts';

describe('coach apply day-state helpers', () => {
  it('refreshes day status after recovery apply fields change', () => {
    expect(coachApplyNeedsDayStatusRefresh({
      skipped_focus: { date: '2026-05-05', from: null, to: 'recovery' },
    })).toBe(true);
    expect(coachApplyNeedsDayStatusRefresh({
      calorie_adjustment: { from: 0, to: -100 },
    })).toBe(false);
    expect(coachApplyNeedsDayStatusRefresh(null)).toBe(false);
  });

  it('renders coach recovery overrides as recovery, not generic skipped', () => {
    expect(isRecoverySkipReason('Coach swapped to recovery')).toBe(true);
    expect(skippedDayTitle('Legs', 'Coach swapped to recovery')).toBe('Recovery Day');
    expect(skippedDayBadgeLabel('Coach swapped to recovery')).toBe('Recovery');
    expect(skippedDayUndoLabel('Coach swapped to recovery')).toBe('Undo recovery');
  });

  it('keeps normal skipped days labeled as skipped', () => {
    expect(isRecoverySkipReason('Travel mode')).toBe(false);
    expect(skippedDayTitle('Pull', 'Travel mode')).toBe('Pull');
    expect(skippedDayBadgeLabel('Travel mode')).toBe('Skipped');
    expect(skippedDayUndoLabel('Travel mode')).toBe('Unskip Workout');
  });
});
