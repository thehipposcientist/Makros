import {
  formatNutritionPrimaryTarget,
  formatNutritionTargetRange,
  formatNutritionTargetZones,
  nutritionRangeStatusText,
  nutritionTargetRange,
  targetRangeStatus,
} from '../nutritionTargetRanges.ts';

describe('nutrition target ranges', () => {
  it('keeps the adapted calorie target as the primary display value', () => {
    expect(formatNutritionPrimaryTarget('calories', 2200)).toBe('2,200 kcal');
    expect(formatNutritionPrimaryTarget('calories', 2200, { includeUnit: false })).toBe('2,200');
  });

  it('uses calorie ranges as adherence zones only', () => {
    expect(nutritionTargetRange('calories', 2200, 'green')).toEqual({ min: 2090, max: 2310 });
    expect(nutritionTargetRange('calories', 2200)).toEqual({ min: 1980, max: 2420 });
    expect(formatNutritionTargetRange('calories', 2200)).toBe('1,980-2,420');
    expect(formatNutritionTargetZones('calories', 2200)).toBe('On target 2,090-2,310 kcal; close 1,980-2,420 kcal');
    expect(targetRangeStatus('calories', 2200, 2200)).toBe('on_target');
    expect(targetRangeStatus('calories', 2400, 2200)).toBe('close');
  });

  it('treats protein as a target/minimum, not a broad range', () => {
    expect(nutritionTargetRange('protein', 160)).toEqual({ min: 152, max: 160 });
    expect(formatNutritionPrimaryTarget('protein', 160)).toBe('160g');
    expect(formatNutritionTargetRange('protein', 160, { includeUnit: false })).toBe('152+');
    expect(targetRangeStatus('protein', 152, 160)).toBe('on_target');
    expect(nutritionRangeStatusText('protein', 130, 160)).toBe('22 g below target');
  });

  it('shows carbs as flexible and fat as a floor', () => {
    expect(nutritionTargetRange('carbs', 240)).toEqual({ min: 180, max: 300 });
    expect(formatNutritionPrimaryTarget('carbs', 240)).toBe('~240g');
    expect(formatNutritionPrimaryTarget('fat', 70)).toBe('70g min');
    expect(targetRangeStatus('fat', 90, 70)).toBe('on_target');
    expect(nutritionRangeStatusText('fat', 55, 70)).toBe('15 g below floor');
  });
});
