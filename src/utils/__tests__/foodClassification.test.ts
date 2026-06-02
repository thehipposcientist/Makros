import { foodClassificationFields, needsFoodClassification } from '../foodClassification.ts';

describe('foodClassificationFields', () => {
  it('preserves processing bucket and related classifier tags', () => {
    const result = foodClassificationFields({
      processing_bucket: 'ultra_processed',
      food_quality: 'processed',
      protein_source: 'mixed',
      fermented: false,
      probiotic: true,
      omega3_rich: true,
      seafood: true,
      fruit: false,
      vegetable: true,
      alcohol: false,
      processed_meat: true,
      refined_grain: true,
      plant_count: 1.4,
    });

    expect(result).toEqual({
      processing_bucket: 'ultra_processed',
      food_quality: 'processed',
      protein_source: 'mixed',
      fermented: false,
      probiotic: true,
      omega3_rich: true,
      seafood: true,
      fruit: false,
      vegetable: true,
      alcohol: false,
      processed_meat: true,
      refined_grain: true,
      plant_count: 1,
    });
  });

  it('maps bucket-like food_quality values into the legacy quality field', () => {
    expect(foodClassificationFields({ food_quality: 'minimally_processed' }).food_quality).toBe('whole');
    expect(foodClassificationFields({ food_quality: 'ultra_processed' }).food_quality).toBe('processed');
  });

  it('drops invalid classifier values instead of storing noisy strings', () => {
    expect(foodClassificationFields({
      processing_bucket: 'maybe',
      protein_source: 'protein-ish',
      fermented: 'yes',
      plant_count: Number.NaN,
    })).toEqual({});
  });
});

describe('needsFoodClassification', () => {
  const fullyClassified = {
    processing_bucket: 'processed',
    protein_source: 'unknown',
    food_quality: 'processed',
    fermented: false,
    probiotic: false,
    omega3_rich: false,
    seafood: false,
    fruit: false,
    vegetable: false,
    alcohol: false,
    processed_meat: false,
    refined_grain: false,
    plant_count: 0,
  };

  it('requires classification when payload is missing', () => {
    expect(needsFoodClassification(undefined)).toBe(true);
    expect(needsFoodClassification(null)).toBe(true);
  });

  it('retries unknown or missing processing buckets', () => {
    expect(needsFoodClassification({
      processing_bucket: 'unknown',
      protein_source: 'animal',
      food_quality: 'unknown',
    })).toBe(true);
    expect(needsFoodClassification({
      protein_source: 'plant',
    })).toBe(true);
  });

  it('fills missing scoring flags even when visible processing labels are present', () => {
    expect(needsFoodClassification({
      processing_bucket: 'minimally_processed',
      protein_source: 'plant',
      food_quality: 'whole',
    })).toBe(true);
  });

  it('accepts complete classifications without spinning on vague protein labels', () => {
    expect(needsFoodClassification(fullyClassified)).toBe(false);
  });
});
