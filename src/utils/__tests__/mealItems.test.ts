// Tests for mealItems — quantity parsing, unit conversion, legacy
// migration, and the guessUnitForFood / classifyFood heuristics.
//
// These functions touch every meal save / read path. A regression here
// silently corrupts users' macros, which is the worst kind of bug
// (no crash, just wrong numbers in their history forever). High test
// density is justified.

import {
  convertQuantity,
  parseAmountString,
  splitFoodString,
  itemsFromLegacy,
  ensureItems,
  syncLegacyFieldsFromItems,
  formatItemAmount,
  guessUnitForFood,
  classifyFood,
  validUnitsForFood,
  normalizeServingUnit,
} from '../mealItems.ts';

describe('convertQuantity — same unit', () => {
  it('returns the input quantity unchanged', () => {
    expect(convertQuantity(2, 'cup', 'cup')).toBe(2);
    expect(convertQuantity(0, 'g', 'g')).toBe(0);
    expect(convertQuantity(1.5, 'tbsp', 'tbsp')).toBe(1.5);
  });
});

describe('convertQuantity — volume', () => {
  it('1 cup = 240 ml (US cooking cup)', () => {
    expect(convertQuantity(1, 'cup', 'ml')).toBe(240);
  });
  it('1 fl_oz ≈ 29.57 ml', () => {
    const r = convertQuantity(1, 'fl_oz', 'ml')!;
    expect(Math.abs(r - 29.5735) < 0.01).toBe(true);
  });
  it('1 tbsp = 3 tsp (within rounding)', () => {
    const tspPerTbsp = convertQuantity(1, 'tbsp', 'tsp')!;
    expect(Math.abs(tspPerTbsp - 3) < 0.01).toBe(true);
  });
  it('1 gallon = 4 quarts', () => {
    expect(Math.abs(convertQuantity(1, 'gallon', 'quart')! - 4) < 0.01).toBe(true);
  });
});

describe('convertQuantity — weight', () => {
  it('1 lb ≈ 453.59 g', () => {
    const r = convertQuantity(1, 'lb', 'g')!;
    expect(Math.abs(r - 453.592) < 0.01).toBe(true);
  });
  it('1 kg = 1000 g', () => {
    expect(convertQuantity(1, 'kg', 'g')).toBe(1000);
  });
  it('16 oz = 1 lb (within rounding)', () => {
    const r = convertQuantity(16, 'oz', 'lb')!;
    expect(Math.abs(r - 1) < 0.01).toBe(true);
  });
  it('round-trip lb→g→lb preserves the original quantity (within float epsilon)', () => {
    const grams = convertQuantity(2.5, 'lb', 'g')!;
    const back = convertQuantity(grams, 'g', 'lb')!;
    expect(Math.abs(back - 2.5) < 0.0001).toBe(true);
  });
});

describe('convertQuantity — cross-system returns null', () => {
  it('volume → weight is undefined without density', () => {
    expect(convertQuantity(1, 'cup', 'g')).toBe(null);
    expect(convertQuantity(1, 'lb', 'ml')).toBe(null);
  });
  it('count → volume is undefined', () => {
    expect(convertQuantity(1, 'piece', 'cup')).toBe(null);
    expect(convertQuantity(1, 'slice', 'tbsp')).toBe(null);
  });
  it('count → count is null when units differ', () => {
    // piece → slice has no defined relationship
    expect(convertQuantity(1, 'piece', 'slice')).toBe(null);
  });
});

describe('parseAmountString — fractions', () => {
  it('parses "1/2 cup"', () => {
    expect(parseAmountString('1/2 cup')).toEqual({ quantity: 0.5, unit: 'cup' });
  });
  it('parses "3/4 lb"', () => {
    expect(parseAmountString('3/4 lb')).toEqual({ quantity: 0.75, unit: 'lb' });
  });
  it('parses "1/4" with no unit (defaults to serving)', () => {
    expect(parseAmountString('1/4')).toEqual({ quantity: 0.25, unit: 'serving' });
  });
  it('returns null for invalid 1/0 division', () => {
    // Should fall through to numeric parser, which matches "1" alone.
    const r = parseAmountString('1/0 cup');
    expect(r?.quantity).toBe(1);
  });
});

describe('parseAmountString — decimals + integers', () => {
  it('parses "200g"', () => {
    expect(parseAmountString('200g')).toEqual({ quantity: 200, unit: 'g' });
  });
  it('parses "3 oz"', () => {
    expect(parseAmountString('3 oz')).toEqual({ quantity: 3, unit: 'oz' });
  });
  it('parses "1.5 cups"', () => {
    expect(parseAmountString('1.5 cups')).toEqual({ quantity: 1.5, unit: 'cup' });
  });
  it('parses bare number — defaults to serving', () => {
    expect(parseAmountString('2')).toEqual({ quantity: 2, unit: 'serving' });
  });
  it('strips "about " prefix', () => {
    expect(parseAmountString('about 3 oz')).toEqual({ quantity: 3, unit: 'oz' });
  });
});

describe('parseAmountString — unit aliases + edge cases', () => {
  it('recognizes "tablespoon", "tablespoons", "tbsp", "tbs", "tbl"', () => {
    expect(parseAmountString('1 tablespoon')!.unit).toBe('tbsp');
    expect(parseAmountString('2 tablespoons')!.unit).toBe('tbsp');
    expect(parseAmountString('3 tbsp')!.unit).toBe('tbsp');
    expect(parseAmountString('4 tbs')!.unit).toBe('tbsp');
    expect(parseAmountString('5 tbl')!.unit).toBe('tbsp');
  });
  it('recognizes "fl oz", "fl.oz", "floz" all as fl_oz', () => {
    expect(parseAmountString('8 fl oz')!.unit).toBe('fl_oz');
    expect(parseAmountString('8 fl.oz')!.unit).toBe('fl_oz');
    expect(parseAmountString('8 floz')!.unit).toBe('fl_oz');
  });
  it('returns null for empty / whitespace', () => {
    expect(parseAmountString('')).toBe(null);
    expect(parseAmountString('   ')).toBe(null);
  });
  it('returns null for non-numeric junk', () => {
    expect(parseAmountString('abc')).toBe(null);
    expect(parseAmountString('cup')).toBe(null);
  });
  it('uses default "serving" for an unrecognized unit token', () => {
    const r = parseAmountString('5 widgets');
    expect(r?.quantity).toBe(5);
    expect(r?.unit).toBe('serving');
  });
});

describe('splitFoodString — embedded quantities', () => {
  it('parses "2 eggs" as quantity=2 piece, name=eggs', () => {
    expect(splitFoodString('2 eggs')).toEqual({ name: 'eggs', quantity: 2, unit: 'piece' });
  });
  it('parses "3 oz chicken" as quantity=3 oz, name=chicken', () => {
    expect(splitFoodString('3 oz chicken')).toEqual({ name: 'chicken', quantity: 3, unit: 'oz' });
  });
  it('parses "1 cup rice" as quantity=1 cup, name=rice', () => {
    expect(splitFoodString('1 cup rice')).toEqual({ name: 'rice', quantity: 1, unit: 'cup' });
  });
  it('keeps the whole string as name when there is no leading number', () => {
    expect(splitFoodString('scrambled eggs')).toEqual({ name: 'scrambled eggs' });
  });
  it('handles empty / whitespace strings safely', () => {
    expect(splitFoodString('')).toEqual({ name: '' });
    expect(splitFoodString('   ')).toEqual({ name: '' });
  });
  it('does NOT eat unrecognized unit tokens — falls back to piece', () => {
    // "2 widgets cheese" — widgets isn't a unit, so the parser falls
    // through to "<num> <rest>" → name="widgets cheese", unit="piece".
    const r = splitFoodString('2 widgets cheese');
    expect(r.quantity).toBe(2);
    expect(r.unit).toBe('piece');
    expect(r.name).toBe('widgets cheese');
  });
});

describe('itemsFromLegacy — distributes macros evenly', () => {
  it('builds 3 items splitting macros across them', () => {
    const items = itemsFromLegacy(
      ['eggs', 'toast', 'butter'],
      ['2', '1 slice', '1 tbsp'],
      { calories: 300, protein: 12, carbs: 30, fat: 18 },
    );
    expect(items.length).toBe(3);
    expect(items[0].calories).toBe(100); // 300 / 3
    expect(items[1].protein).toBe(4);    // 12 / 3
    expect(items[1].unit).toBe('slice');
    expect(items[2].unit).toBe('tbsp');
    expect(items[0].quantity).toBe(2);
  });
  it('returns [] when foods array is empty', () => {
    expect(itemsFromLegacy([], [], {})).toEqual([]);
  });
  it('handles missing amounts gracefully (defaults qty=1)', () => {
    const items = itemsFromLegacy(['banana'], [], { calories: 105 });
    expect(items.length).toBe(1);
    expect(items[0].quantity).toBe(1);
    expect(items[0].calories).toBe(105);
  });
  it('defaults missing macros to 0 when totalMacros is undefined', () => {
    const items = itemsFromLegacy(['banana'], ['1']);
    expect(items[0].calories).toBe(0);
    expect(items[0].protein).toBe(0);
  });
});

describe('ensureItems', () => {
  it('passes through a meal that already has items with non-zero macros', () => {
    const meal = {
      meal: 'Breakfast', foods: [], amounts: [],
      calories: 400, protein: 30, carbs: 40, fat: 10,
      items: [
        { name: 'oats', quantity: 1, unit: 'cup', calories: 200, protein: 10, carbs: 30, fat: 4 } as any,
        { name: 'protein', quantity: 1, unit: 'scoop', calories: 200, protein: 20, carbs: 10, fat: 6 } as any,
      ],
    } as any;
    const result = ensureItems(meal);
    expect(result.items?.[0].calories).toBe(200);
    expect(result.items?.[1].calories).toBe(200);
  });

  it('redistributes meal-level macros when items have all-zero macros', () => {
    // The AI sometimes returns per-item macros as 0 even when the meal-level
    // totals are correct. ensureItems must distribute totals evenly.
    const meal = {
      meal: 'Lunch', foods: [], amounts: [],
      calories: 500, protein: 40, carbs: 50, fat: 15,
      items: [
        { name: 'chicken', quantity: 6, unit: 'oz', calories: 0, protein: 0, carbs: 0, fat: 0 } as any,
        { name: 'rice', quantity: 1, unit: 'cup', calories: 0, protein: 0, carbs: 0, fat: 0 } as any,
      ],
    } as any;
    const result = ensureItems(meal);
    // 500 / 2 = 250 per item; protein 40/2=20, carbs 50/2=25, fat 15/2=7.5→8
    expect(result.items?.[0].calories).toBe(250);
    expect(result.items?.[1].calories).toBe(250);
    expect(result.items?.[0].protein).toBe(20);
    expect(result.items?.[0].fat).toBe(8);
  });

  it('builds items from legacy foods/amounts when no items present', () => {
    const meal = {
      meal: 'Snack', foods: ['banana', 'almonds'], amounts: ['1', '1 oz'],
      calories: 250, protein: 6, carbs: 30, fat: 14,
    } as any;
    const result = ensureItems(meal);
    expect(result.items?.length).toBe(2);
    expect(result.items?.[0].name).toBe('banana');
    expect(result.items?.[1].name).toBe('almonds');
    expect(result.items?.[1].unit).toBe('oz');
  });

  it('does not touch the input object (purity)', () => {
    const meal = {
      meal: 'Snack', foods: ['banana'], amounts: ['1'],
      calories: 100, protein: 1, carbs: 27, fat: 0,
    } as any;
    const before = JSON.stringify(meal);
    ensureItems(meal);
    expect(JSON.stringify(meal)).toBe(before);
  });
});

describe('syncLegacyFieldsFromItems', () => {
  it('sums item macros into meal totals when items have data', () => {
    const meal = {
      meal: 'Lunch', foods: [], amounts: [], calories: 0, protein: 0, carbs: 0, fat: 0,
      items: [
        { name: 'a', quantity: 1, unit: 'piece', calories: 100, protein: 10, carbs: 5, fat: 2 } as any,
        { name: 'b', quantity: 2, unit: 'piece', calories: 200, protein: 5, carbs: 30, fat: 8 } as any,
      ],
    } as any;
    const r = syncLegacyFieldsFromItems(meal);
    expect(r.calories).toBe(300);
    expect(r.protein).toBe(15);
    expect(r.carbs).toBe(35);
    expect(r.fat).toBe(10);
    expect(r.foods).toEqual(['a', 'b']);
  });

  it('preserves meal-level totals when items have no macros (regression: do not zero out the meal)', () => {
    // The dangerous scenario: items have 0 macros but meal totals are
    // non-zero. Without the guard, save would write 0 to the user's
    // history, silently destroying their data.
    const meal = {
      meal: 'Dinner', foods: [], amounts: [],
      calories: 600, protein: 50, carbs: 60, fat: 20,
      items: [
        { name: 'steak', quantity: 6, unit: 'oz', calories: 0, protein: 0, carbs: 0, fat: 0 } as any,
        { name: 'broccoli', quantity: 1, unit: 'cup', calories: 0, protein: 0, carbs: 0, fat: 0 } as any,
      ],
    } as any;
    const r = syncLegacyFieldsFromItems(meal);
    expect(r.calories).toBe(600);
    expect(r.protein).toBe(50);
    expect(r.carbs).toBe(60);
    expect(r.fat).toBe(20);
  });

  it('returns the meal unchanged when no items present', () => {
    const meal = { meal: 'Snack', foods: [], amounts: [], calories: 100 } as any;
    expect(syncLegacyFieldsFromItems(meal)).toBe(meal);
  });
});

describe('formatItemAmount', () => {
  it('drops the "piece" unit (eggs not piece eggs)', () => {
    expect(formatItemAmount({ name: 'egg', quantity: 2, unit: 'piece', calories: 140, protein: 12, carbs: 0, fat: 10 } as any)).toBe('2');
  });
  it('keeps a real unit', () => {
    expect(formatItemAmount({ name: 'rice', quantity: 1, unit: 'cup', calories: 200, protein: 4, carbs: 45, fat: 0 } as any)).toBe('1 cup');
  });
  it('annotates "serving" with estimated grams when in range', () => {
    const r = formatItemAmount({ name: 'mystery', quantity: 1, unit: 'serving', calories: 300, protein: 0, carbs: 0, fat: 0 } as any);
    expect(r.includes('1 serving')).toBe(true);
    // 300 / 1.5 = 200g estimate
    expect(r.includes('200g')).toBe(true);
  });
  it('annotates "scoop" with calorie context', () => {
    const r = formatItemAmount({ name: 'protein', quantity: 1, unit: 'scoop', calories: 120, protein: 24, carbs: 3, fat: 1 } as any);
    expect(r.includes('1 scoop')).toBe(true);
    expect(r.includes('120 cal')).toBe(true);
  });
  it('formats fractional quantities cleanly', () => {
    expect(formatItemAmount({ name: 'cup', quantity: 0.5, unit: 'cup', calories: 100, protein: 5, carbs: 10, fat: 2 } as any)).toBe('0.5 cup');
  });
});

describe('classifyFood + guessUnitForFood', () => {
  it('liquids default to cup', () => {
    expect(guessUnitForFood('orange juice')).toEqual({ quantity: 1, unit: 'cup' });
    expect(classifyFood('protein smoothie')).toBe('liquid');
    expect(classifyFood('almond milk')).toBe('liquid');
  });
  it('countables default to piece', () => {
    expect(guessUnitForFood('banana').unit).toBe('piece');
    expect(guessUnitForFood('apple').unit).toBe('piece');
    expect(classifyFood('banana')).toBe('countable');
  });
  it('breads default to slice', () => {
    expect(guessUnitForFood('whole wheat bread').unit).toBe('slice');
  });
  it('powders default to scoop', () => {
    expect(guessUnitForFood('whey protein powder').unit).toBe('scoop');
    expect(classifyFood('creatine')).toBe('powder');
  });
  it('spreadables default to tbsp', () => {
    expect(guessUnitForFood('peanut butter').unit).toBe('tbsp');
    expect(guessUnitForFood('olive oil').unit).toBe('tbsp');
    expect(classifyFood('honey')).toBe('spreadable');
  });
  it('grains/veggies default to cup', () => {
    expect(guessUnitForFood('white rice').unit).toBe('cup');
    expect(guessUnitForFood('quinoa').unit).toBe('cup');
    expect(guessUnitForFood('broccoli').unit).toBe('cup');
  });
  it('generic proteins default to 3 oz', () => {
    expect(guessUnitForFood('grilled chicken')).toEqual({ quantity: 3, unit: 'oz' });
    expect(guessUnitForFood('salmon')).toEqual({ quantity: 3, unit: 'oz' });
  });
});

describe('validUnitsForFood', () => {
  it('liquids do not allow weight units', () => {
    const u = validUnitsForFood('orange juice');
    expect(u.includes('cup')).toBe(true);
    expect(u.includes('lb')).toBe(false);
    expect(u.includes('g')).toBe(false);
  });
  it('countables allow piece + grams', () => {
    const u = validUnitsForFood('banana');
    expect(u.includes('piece')).toBe(true);
    expect(u.includes('g')).toBe(true);
  });
  it('powders include scoop and weight', () => {
    const u = validUnitsForFood('whey protein powder');
    expect(u.includes('scoop')).toBe(true);
    expect(u.includes('g')).toBe(true);
  });
});

describe('normalizeServingUnit', () => {
  it('replaces "serving" with a guessed real unit', () => {
    const r = normalizeServingUnit({ name: 'banana', quantity: 1, unit: 'serving' as any, calories: 105, protein: 1, carbs: 27, fat: 0 } as any);
    expect(r.unit).toBe('piece');
    expect(r.quantity).toBe(1);
  });
  it('leaves non-serving units untouched', () => {
    const item = { name: 'rice', quantity: 1, unit: 'cup', calories: 200, protein: 4, carbs: 45, fat: 0 } as any;
    expect(normalizeServingUnit(item).unit).toBe('cup');
  });
});
