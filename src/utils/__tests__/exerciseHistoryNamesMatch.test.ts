import { exerciseHistoryEntriesMatch, exerciseHistoryNamesMatch } from '../exerciseHistoryMatch.ts';

describe('exerciseHistoryNamesMatch', () => {
  describe('exact + formatting', () => {
    it('matches identical names', () => {
      expect(exerciseHistoryNamesMatch('Barbell Bench Press', 'Barbell Bench Press')).toBe(true);
    });
    it('matches with case differences', () => {
      expect(exerciseHistoryNamesMatch('barbell bench press', 'Barbell Bench Press')).toBe(true);
    });
    it('matches with hyphens / underscores', () => {
      expect(exerciseHistoryNamesMatch('Single-Arm Dumbbell Row', 'Single Arm Dumbbell Row')).toBe(true);
      expect(exerciseHistoryNamesMatch('single_arm_dumbbell_row', 'Single Arm Dumbbell Row')).toBe(true);
    });
    it('rejects empty strings', () => {
      expect(exerciseHistoryNamesMatch('', 'Bench Press')).toBe(false);
      expect(exerciseHistoryNamesMatch('Bench Press', '')).toBe(false);
    });
  });

  describe('equipment-class gate (the original 190-lb bug)', () => {
    it('does NOT match barbell bench against single-arm dumbbell bench', () => {
      // This was returning TRUE before the fix because the normalizer
      // stripped "barbell" and "dumbbell" so "single arm bench press"
      // substring-matched "bench press". A 190 lb barbell-bench history
      // entry was then surfaced as the per-arm dumbbell recommendation.
      expect(exerciseHistoryNamesMatch('Barbell Bench Press', 'Single-Arm Dumbbell Bench Press')).toBe(false);
      expect(exerciseHistoryNamesMatch('Single-Arm Dumbbell Bench Press', 'Barbell Bench Press')).toBe(false);
    });
    it('does NOT match barbell bench against dumbbell bench', () => {
      expect(exerciseHistoryNamesMatch('Barbell Bench Press', 'Dumbbell Bench Press')).toBe(false);
    });
    it('does NOT match dumbbell row against barbell row', () => {
      expect(exerciseHistoryNamesMatch('Dumbbell Row', 'Barbell Row')).toBe(false);
      expect(exerciseHistoryNamesMatch('Bent-Over Barbell Row', 'Single-Arm Dumbbell Row')).toBe(false);
    });
    it('does NOT match cable row against machine row', () => {
      expect(exerciseHistoryNamesMatch('Cable Row', 'Machine Row')).toBe(false);
    });
    it('does NOT match smith bench against barbell bench', () => {
      expect(exerciseHistoryNamesMatch('Smith Machine Bench Press', 'Barbell Bench Press')).toBe(false);
    });
    it('still allows unspecified-equipment names to match equipment-tagged history', () => {
      // Plan often emits "Bench Press" generically; user history is
      // "Barbell Bench Press". Same lift in most gyms — keep this match.
      expect(exerciseHistoryNamesMatch('Bench Press', 'Barbell Bench Press')).toBe(true);
      expect(exerciseHistoryNamesMatch('Squat', 'Barbell Squat')).toBe(true);
    });
    it('treats canonical generic barbell names as barbell, not dumbbell', () => {
      expect(exerciseHistoryNamesMatch('Romanian Deadlift', 'Dumbbell Romanian Deadlift')).toBe(false);
      expect(exerciseHistoryNamesMatch('Romanian Deadlift', 'Barbell Romanian Deadlift')).toBe(true);
      expect(exerciseHistoryNamesMatch('Bench Press', 'Dumbbell Bench Press')).toBe(false);
    });
    it('uses equipment context when the display names are generic', () => {
      expect(exerciseHistoryEntriesMatch(
        { name: 'Romanian Deadlift', equipment: 'dumbbells' },
        { name: 'Romanian Deadlift', equipment: 'barbell' },
      )).toBe(false);
      expect(exerciseHistoryEntriesMatch(
        { name: 'Romanian Deadlift', equipment: 'barbell' },
        { name: 'Barbell Romanian Deadlift', equipment: 'barbell' },
      )).toBe(true);
    });
  });

  describe('laterality gate', () => {
    it('does NOT match unilateral against bilateral dumbbell variant', () => {
      expect(exerciseHistoryNamesMatch('Single-Arm Dumbbell Bench Press', 'Dumbbell Bench Press')).toBe(false);
      expect(exerciseHistoryNamesMatch('One-Arm Dumbbell Row', 'Dumbbell Row')).toBe(false);
    });
    it('does NOT match unilateral against bilateral machine variant', () => {
      expect(exerciseHistoryNamesMatch('Single-Leg Press', 'Leg Press')).toBe(false);
    });
    it('treats alternating as a unilateral variant', () => {
      expect(exerciseHistoryNamesMatch('Alternating Dumbbell Curl', 'Dumbbell Curl')).toBe(false);
    });
  });

  describe('legitimate substring matches still work', () => {
    it('matches "Romanian Deadlift" against "Barbell Romanian Deadlift" via shorter-substring rule', () => {
      expect(exerciseHistoryNamesMatch('Romanian Deadlift', 'Barbell Romanian Deadlift')).toBe(true);
    });
    it('matches "Lat Pulldown" against "Wide-Grip Lat Pulldown"', () => {
      expect(exerciseHistoryNamesMatch('Lat Pulldown', 'Wide-Grip Lat Pulldown')).toBe(true);
    });
  });
});
