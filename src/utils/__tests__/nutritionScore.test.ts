// Client preview-score caps must mirror the server (nutrition_score.py) so the
// plan preview can't show a higher number than the authoritative /meals/score.
// Before this, a high-blend plan with meaningful quality gaps previewed ~90+
// and then visibly "dropped" once the day round-tripped through the backend.
import { computeNutritionScore } from '../nutritionScore.ts';

// Priority-6 micros all at ~80% RDA → micro sub-score ~100, high confidence.
const RICH_MICROS = {
  calcium: 800, iron: 15, potassium: 3800, magnesium: 350,
  vitamin_d: 16, vitamin_b12: 2.0,
};

function planWith(extraItemFields: Record<string, any>, extraMicros: Record<string, number> = {}): any {
  return {
    targets: { calories: 2000, protein: 150, carbs: 200, fat: 60 },
    removedMealIds: [],
    meals: [{
      meal: 'Bowl',
      calories: 2000,
      protein: 150,
      items: [{
        name: 'Bowl',
        calories: 2000,
        protein: 150,
        food_quality: 'minimally_processed',
        micronutrients: {
          fiber: 30, sodium: 2000, saturated_fat: 0, added_sugar: 0,
          ...RICH_MICROS, ...extraMicros,
        },
        ...extraItemFields,
      }],
    }],
  };
}

describe('nutritionScore preview caps (server parity)', () => {
  it('caps a high-blend plan that has 2 meaningful gaps (no plants + no omega-3)', () => {
    // Perfect macros + strong micros + clean sugar/fat/sodium/fiber, but zero
    // plant variety and no omega-3 → exactly 2 meaningful gaps. Uncapped blend
    // is ~93; the cap pulls it to 85.
    const res = computeNutritionScore(planWith({ plant_count: 0 }), 'body_recomp');
    expect(res.adherence).toBe(100);
    expect(res.score).toBe(85);
    expect(res.cap_reasons.length).toBeGreaterThan(0);
    expect(res.cap_reasons.some(r => r.includes('meaningful'))).toBe(true);
  });

  it('does NOT cap the same plan once plants + omega-3 are present', () => {
    const res = computeNutritionScore(
      planWith({ plant_count: 5, omega3_rich: true }),
      'body_recomp',
    );
    expect(res.score).toBeGreaterThan(85);
    expect(res.cap_reasons.length).toBe(0);
  });

  it('caps a high-blend plan with 3 meaningful gaps at 78', () => {
    // Perfect macros + strong micros + clean sugar/fat/fiber keep the uncapped
    // blend high (~91), but no plants + no omega-3 + high sodium (>3500 mg)
    // = 3 meaningful gaps → ceiling 78.
    const res = computeNutritionScore(
      planWith({ plant_count: 0 }, { sodium: 4000 }),
      'body_recomp',
    );
    expect(res.score).toBe(78);
    expect(res.cap_reasons.some(r => r.includes('meaningful'))).toBe(true);
  });
});
