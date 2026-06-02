import {
  buildUserFoodCategories,
  searchUserFoodCategories,
  badgeLabelForSource,
  badgeToneForSource,
} from '../customFoodSearch.ts';

const seedCategories = [
  {
    key: 'protein',
    label: 'Proteins',
    foods: [
      { name: 'Chicken Breast', unit: '4 oz', calories: 180, protein: 35, carbs: 0, fat: 4 },
      { name: 'Greek Yogurt', unit: '1 cup', calories: 150, protein: 18, carbs: 9, fat: 4 },
    ],
  },
  {
    key: 'carbs',
    label: 'Carbs',
    foods: [
      { name: 'White Rice', unit: '1 cup', calories: 200, protein: 4, carbs: 45, fat: 0 },
    ],
  },
];

const customFoods = [
  { name: 'Mom\'s Banana Bread', unit: '1 slice', calories: 220, protein: 3, carbs: 38, fat: 7 },
  { name: 'Custom Protein Shake', unit: '1 scoop + milk', calories: 280, protein: 40, carbs: 18, fat: 5 },
];

describe('buildUserFoodCategories — pantry filter', () => {
  it('keeps only seed foods that are in the user\'s pantry list', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['Chicken Breast', 'White Rice'],
      customFoods: [],
    });
    expect(cats.length).toBe(2);
    expect(cats[0].foods.length).toBe(1);
    expect(cats[0].foods[0].name).toBe('Chicken Breast');
    expect(cats[1].foods[0].name).toBe('White Rice');
  });

  it('drops categories with no pantry-available foods', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['White Rice'],
      customFoods: [],
    });
    expect(cats.length).toBe(1);
    expect(cats[0].key).toBe('carbs');
  });

  it('matches pantry names case-insensitively', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['CHICKEN breast', 'white rice'],
      customFoods: [],
    });
    expect(cats[0].foods[0].name).toBe('Chicken Breast');
    expect(cats[1].foods[0].name).toBe('White Rice');
  });
});

describe('buildUserFoodCategories — custom foods', () => {
  it('prepends a synthetic "custom" category when the user has custom foods', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['Chicken Breast'],
      customFoods,
    });
    expect(cats[0].key).toBe('custom');
    expect(cats[0].label).toBe('My Custom Foods');
    expect(cats[0].foods.length).toBe(2);
    expect(cats[0].foods[0].name).toBe('Mom\'s Banana Bread');
  });

  it('returns just the synthetic category when no pantry foods are selected', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: [],
      customFoods,
    });
    expect(cats.length).toBe(1);
    expect(cats[0].key).toBe('custom');
  });

  it('returns empty when both pantry and custom are empty', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: [],
      customFoods: [],
    });
    expect(cats.length).toBe(0);
  });

  it('preserves micronutrients on custom foods when present', () => {
    const cats = buildUserFoodCategories({
      metaCategories: [],
      foodsAvailable: [],
      customFoods: [
        { name: 'Iron Pill Smoothie', calories: 100, protein: 5, carbs: 12, fat: 2, micronutrients: { iron_mg: 18 } },
      ],
    });
    expect((cats[0].foods[0].micronutrients as any)?.iron_mg).toBe(18);
  });
});

describe('searchUserFoodCategories — basic matching', () => {
  it('returns nothing for queries shorter than 2 characters', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['Chicken Breast'],
      customFoods,
    });
    expect(searchUserFoodCategories(cats, '').length).toBe(0);
    expect(searchUserFoodCategories(cats, 'c').length).toBe(0);
    expect(searchUserFoodCategories(cats, '  ').length).toBe(0);
  });

  it('finds custom foods alongside seed foods in one search', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['Chicken Breast'],
      customFoods,
    });
    const results = searchUserFoodCategories(cats, 'protein');
    // Matches "Custom Protein Shake" (custom) and "Proteins" category-tagged seed foods (haystack includes label).
    const names = results.map(r => r.name);
    expect(names.includes('Custom Protein Shake')).toBe(true);
  });

  it('case-insensitive substring match', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['Chicken Breast'],
      customFoods,
    });
    const lower = searchUserFoodCategories(cats, 'banana bread');
    const upper = searchUserFoodCategories(cats, 'BANANA BREAD');
    const mixed = searchUserFoodCategories(cats, 'BaNaNa');
    expect(lower[0]?.name).toBe('Mom\'s Banana Bread');
    expect(upper[0]?.name).toBe('Mom\'s Banana Bread');
    expect(mixed[0]?.name).toBe('Mom\'s Banana Bread');
  });

  it('all-tokens-must-match (token-AND search)', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['Chicken Breast', 'White Rice'],
      customFoods: [],
    });
    // "rice chicken" should match neither because no single name has both tokens.
    expect(searchUserFoodCategories(cats, 'rice chicken').length).toBe(0);
    // "white rice" matches the single rice food.
    expect(searchUserFoodCategories(cats, 'white rice').length).toBe(1);
  });

  it('dedupes by name (case-insensitive) when same food appears in multiple categories', () => {
    const cats = [
      { key: 'a', label: 'A', foods: [{ name: 'Eggs', unit: '2 large', calories: 140, protein: 12, carbs: 0, fat: 10 }] },
      { key: 'b', label: 'B', foods: [{ name: 'eggs', unit: '2 large', calories: 140, protein: 12, carbs: 0, fat: 10 }] },
    ];
    const results = searchUserFoodCategories(cats, 'eggs');
    expect(results.length).toBe(1);
  });

  it('caps results at the supplied limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      name: `Almond Variant ${i}`, unit: '1 oz', calories: 100, protein: 3, carbs: 4, fat: 9,
    }));
    const cats = [{ key: 'nuts', label: 'Nuts', foods: many }];
    expect(searchUserFoodCategories(cats, 'almond').length).toBe(12);
    expect(searchUserFoodCategories(cats, 'almond', 5).length).toBe(5);
  });
});

describe('searchUserFoodCategories — source tagging', () => {
  it('tags custom-category results with source="user"', () => {
    const cats = buildUserFoodCategories({
      metaCategories: [],
      foodsAvailable: [],
      customFoods,
    });
    const results = searchUserFoodCategories(cats, 'banana');
    expect(results[0].source).toBe('user');
    expect(results[0].is_verified).toBe(false);
  });

  it('tags seed-category results with source="seed"', () => {
    const cats = buildUserFoodCategories({
      metaCategories: seedCategories,
      foodsAvailable: ['Chicken Breast'],
      customFoods: [],
    });
    const results = searchUserFoodCategories(cats, 'chicken');
    expect(results[0].source).toBe('seed');
    expect(results[0].is_verified).toBe(true);
  });

  it('preserves serving grams from local catalog foods', () => {
    const cats = [{
      key: 'protein',
      label: 'Proteins',
      foods: [{ name: 'Ground Beef Patty', unit: '1 patty', serving_grams: 113, calories: 170, protein: 23, carbs: 0, fat: 8 }],
    }];
    const results = searchUserFoodCategories(cats, 'ground beef');
    expect(results[0].serving_grams).toBe(113);
  });

  it('returns custom foods even when the seed pantry is empty (regression: search must surface custom)', () => {
    const cats = buildUserFoodCategories({
      metaCategories: [],
      foodsAvailable: [],
      customFoods,
    });
    const results = searchUserFoodCategories(cats, 'shake');
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Custom Protein Shake');
    expect(results[0].source).toBe('user');
  });
});

describe('badgeLabelForSource', () => {
  it('labels verified provider-backed rows without naming vendors', () => {
    expect(badgeLabelForSource('seed')).toBe('Verified');
    expect(badgeLabelForSource('usda')).toBe('Verified');
    expect(badgeLabelForSource('fatsecret')).toBe('Verified');
  });

  it('labels label, custom, and estimate rows by trust level', () => {
    expect(badgeLabelForSource('barcode')).toBe('Label');
    expect(badgeLabelForSource('openfoodfacts')).toBe('Label');
    expect(badgeLabelForSource('user')).toBe('Custom');
    expect(badgeLabelForSource('ai')).toBe('Estimate');
    expect(badgeLabelForSource('vision_estimate')).toBe('Estimate');
  });

  it('hides unknown provider names', () => {
    expect(badgeLabelForSource('foo')).toBe('');
    expect(badgeLabelForSource(null)).toBe('');
    expect(badgeLabelForSource(undefined)).toBe('');
  });
});

describe('badgeToneForSource', () => {
  it('returns stable tone keys for visible trust labels', () => {
    expect(badgeToneForSource('seed')).toBe('verified');
    expect(badgeToneForSource('usda')).toBe('verified');
    expect(badgeToneForSource('fatsecret')).toBe('verified');
    expect(badgeToneForSource('barcode')).toBe('label');
    expect(badgeToneForSource('user')).toBe('custom');
    expect(badgeToneForSource('ai')).toBe('estimate');
    expect(badgeToneForSource('foo')).toBeNull();
  });
});
