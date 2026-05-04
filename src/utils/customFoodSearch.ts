// Pure helpers for building the user's food categories (seed +
// custom) and searching across them for the meal-edit modal. Lives
// outside the React components so it can be unit-tested without
// mounting the modal — the logic that decides "is this food in
// the search results, and what badge does it get" is critical
// enough to deserve direct test coverage.

export type FoodLike = {
  name?: string | null;
  unit?: string | null;
  calories?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  micronutrients?: Record<string, number> | null;
  id?: string | null;
};

export type FoodCategoryLike = {
  key: string;
  label: string;
  icon?: string;
  foods: FoodLike[];
};

export type CustomFoodLike = {
  name: string;
  unit?: string | null;
  calories?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  micronutrients?: Record<string, number> | null;
};

export type FoodSearchResultLike = {
  name: string;
  serving: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  source: 'seed' | 'user';
  food_id: string | null;
  serving_id: null;
  serving_grams: null;
  is_verified: boolean;
  is_preferred: boolean;
  micronutrients?: Record<string, number>;
};

/** Build the categories the modal renders: seeded categories
 * filtered to only the user's pantry items, plus a synthetic
 * "My Custom Foods" category at the front when the user has
 * any custom foods. Mirrors `userFoodCategories` in HomeScreen.tsx
 * so the merge rule lives in exactly one tested place. */
export function buildUserFoodCategories(args: {
  metaCategories: FoodCategoryLike[];
  foodsAvailable: string[];
  customFoods: CustomFoodLike[];
}): FoodCategoryLike[] {
  const { metaCategories, foodsAvailable, customFoods } = args;
  const available = new Set(foodsAvailable.map(n => n.toLowerCase()));
  const filteredSeed = metaCategories
    .map(cat => ({
      ...cat,
      foods: (cat.foods ?? []).filter(f => available.has((f.name ?? '').toLowerCase())),
    }))
    .filter(cat => cat.foods.length > 0);

  if (!customFoods || customFoods.length === 0) return filteredSeed;
  const customCat: FoodCategoryLike = {
    key: 'custom',
    label: 'My Custom Foods',
    icon: 'star-outline',
    foods: customFoods.map(cf => ({
      name: cf.name,
      unit: cf.unit ?? '1 serving',
      calories: cf.calories ?? 0,
      protein: cf.protein ?? 0,
      carbs: cf.carbs ?? 0,
      fat: cf.fat ?? 0,
      ...(cf.micronutrients ? { micronutrients: cf.micronutrients } : {}),
    })),
  };
  return [customCat, ...filteredSeed];
}

/** Token-AND substring search across categories, returning up to
 * `limit` results. Custom-category foods get `source: 'user'`,
 * everything else gets `source: 'seed'`. Both render under the
 * same THALLO badge in the UI — the source split exists so
 * downstream code can still tell them apart for things like
 * "edit my custom food" actions. */
export function searchUserFoodCategories(
  categories: FoodCategoryLike[],
  query: string,
  limit = 12,
): FoodSearchResultLike[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const tokens = q.split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const results: FoodSearchResultLike[] = [];
  for (const category of categories) {
    for (const food of category.foods ?? []) {
      const name = String(food.name ?? '').trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      const haystack = `${name} ${food.unit ?? ''} ${category.label ?? ''}`.toLowerCase();
      if (!haystack.includes(q) && !tokens.every(t => haystack.includes(t))) continue;
      seen.add(key);
      results.push({
        name,
        serving: food.unit ?? '1 serving',
        calories: Number(food.calories ?? 0),
        protein: Number(food.protein ?? 0),
        carbs: Number(food.carbs ?? 0),
        fat: Number(food.fat ?? 0),
        source: category.key === 'custom' ? 'user' : 'seed',
        food_id: food.id ?? null,
        serving_id: null,
        serving_grams: null,
        is_verified: category.key !== 'custom',
        is_preferred: true,
        ...(food.micronutrients ? { micronutrients: food.micronutrients } : {}),
      });
    }
  }
  return results.slice(0, limit);
}

/** Maps a search result's source onto the visible badge label.
 * Both seed and user-stored foods are surfaced as THALLO since
 * users perceive both as "stored Thallo data". USDA / barcode /
 * AI keep their own labels because those represent external data
 * sources the user should still see called out. */
export function badgeLabelForSource(source: string | null | undefined): string {
  switch (source) {
    case 'seed': return 'THALLO';
    case 'user': return 'THALLO';
    case 'barcode': return 'BARCODE';
    case 'usda': return 'USDA';
    case 'ai': return 'AI';
    default: return String(source ?? '').toUpperCase();
  }
}
