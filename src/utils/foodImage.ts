// Food / meal image resolver.
//
// Per the product brief: do NOT show ingredient images by default. The
// resolver returns a single image spec for a meal-level surface (saved-
// meal card, meal hero) and falls back through this chain:
//
//   1. user_photo  — the user's actual uploaded meal photo (image_url
//                    set with image_source="user_photo"). Always wins.
//   2. recipe      — generated/curated recipe image when confidence is
//                    high (image_source="recipe").
//   3. product     — packaged/branded item image from a barcode/product
//                    DB (image_source="product"). Future provider —
//                    see backend/app/services/nutrition/food_image_provider.py.
//   4. category    — vector-icon thumbnail derived from the meal/food
//                    name. Cheap, no asset bloat, theme-friendly.
//   5. placeholder — neutral fallback (last resort).
//
// Ingredient rows intentionally do NOT consume this resolver. Keep
// ingredient lists text + macro-focused.

import type { ImageSourcePropType } from 'react-native';
import type { Ionicons } from '@expo/vector-icons';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

/** Mirrors backend FoodCategory in backend/app/enums.py. */
export type FoodCategory =
  | 'proteins'
  | 'plant_proteins'
  | 'grains_carbs'
  | 'vegetables'
  | 'fruits'
  | 'dairy'
  | 'fats_oils'
  | 'condiments'
  | 'beverages'
  | 'supplements'
  | 'snack'
  | 'mixed';

export type ImageSpecKind = 'photo' | 'category' | 'placeholder';

const MEAL_IMAGE_ASSETS = {
  breakfast: require('../../assets/images/card-backgrounds/meal-card-breakfast-day.jpg'),
  breakfastSmoothie: require('../../assets/images/card-backgrounds/meal-card-breakfast-smoothie-day.jpg'),
  burrito: require('../../assets/images/card-backgrounds/meal-card-burrito-day.jpg'),
  caesar: require('../../assets/images/card-backgrounds/meal-card-caesar-chicken-salad-day.jpg'),
  chicken: require('../../assets/images/card-backgrounds/meal-card-high-protein-chicken-day.jpg'),
  chickenRice: require('../../assets/images/card-backgrounds/meal-card-high-protein-chicken-rice-day.jpg'),
  mealPrepChicken: require('../../assets/images/card-backgrounds/meal-card-high-protein-meal-prep-day.jpg'),
  mediterranean: require('../../assets/images/card-backgrounds/meal-card-mediterranean-day.jpg'),
  noodle: require('../../assets/images/card-backgrounds/meal-card-noodle-day.jpg'),
  oatmeal: require('../../assets/images/card-backgrounds/meal-card-oatmeal-day.jpg'),
  pasta: require('../../assets/images/card-backgrounds/meal-card-pasta-day.jpg'),
  quinoa: require('../../assets/images/card-backgrounds/meal-card-quinoa-day.jpg'),
  salad: require('../../assets/images/card-backgrounds/meal-card-salad-day.jpg'),
  salmon: require('../../assets/images/card-backgrounds/meal-card-high-protein-salmon-day.jpg'),
  smoothie: require('../../assets/images/card-backgrounds/meal-card-smoothie-day.jpg'),
  steak: require('../../assets/images/card-backgrounds/meal-card-high-protein-steak-day.jpg'),
  tunaSalad: require('../../assets/images/card-backgrounds/meal-card-high-protein-tuna-salad-day.jpg'),
  veganPrep: require('../../assets/images/card-backgrounds/meal-card-plant-based-meal-prep-day.jpg'),
  veggieDinner: require('../../assets/images/card-backgrounds/meal-card-plant-based-day.jpg'),
  yogurt: require('../../assets/images/card-backgrounds/meal-card-high-protein-yogurt-day.jpg'),
} as const satisfies Record<string, ImageSourcePropType>;

export type MealImageAssetKey = keyof typeof MEAL_IMAGE_ASSETS;

const MEAL_IMAGE_ASSET_URI_PREFIX = 'thallo://meal-image/';

export function mealImageAssetUri(key: MealImageAssetKey): string {
  return `${MEAL_IMAGE_ASSET_URI_PREFIX}${key}`;
}

export interface ImageSpec {
  kind: ImageSpecKind;
  /** Set only when kind === 'photo'. */
  uri?: string;
  /** Set for bundled meal-card photos. */
  asset?: ImageSourcePropType;
  /** Always set — used when kind !== 'photo' OR while a remote photo loads. */
  icon: IoniconName;
  /** Solid background tint (theme-agnostic — pass through opacity at the
   *  call site if you want a softer look). */
  bg: string;
  /** Foreground / icon tint. */
  tint: string;
  /** Free-form provenance tag. Mirrors backend image_source. */
  source: 'user_photo' | 'recipe' | 'pexels' | 'product' | 'asset' | 'category' | 'placeholder';
}

const CATEGORY_STYLE: Record<FoodCategory, { icon: IoniconName; bg: string; tint: string }> = {
  proteins:        { icon: 'restaurant',           bg: '#F8E0D8', tint: '#B0431C' },
  plant_proteins:  { icon: 'leaf',                 bg: '#E0F0D8', tint: '#3F8030' },
  grains_carbs:    { icon: 'pizza',                bg: '#FFF0CC', tint: '#9C6818' },
  vegetables:      { icon: 'leaf-outline',         bg: '#DDF0DC', tint: '#2F7A3A' },
  fruits:          { icon: 'nutrition',            bg: '#FCE0EC', tint: '#B83864' },
  dairy:           { icon: 'water',                bg: '#E4ECFC', tint: '#3D5BAA' },
  fats_oils:       { icon: 'flame',                bg: '#FFE6CC', tint: '#C56A18' },
  condiments:      { icon: 'color-fill',           bg: '#FFE0DC', tint: '#A8442C' },
  beverages:       { icon: 'cafe',                 bg: '#E8E0D0', tint: '#76583A' },
  supplements:     { icon: 'medkit',               bg: '#E8DCFC', tint: '#6840A8' },
  snack:           { icon: 'fast-food',            bg: '#FFF0E0', tint: '#A06030' },
  mixed:           { icon: 'restaurant-outline',   bg: '#ECECEC', tint: '#606870' },
};

const PLACEHOLDER_STYLE = { icon: 'image-outline' as IoniconName, bg: '#ECECEC', tint: '#A0A4A8' };

// Ordered: more specific keywords first so "almond milk" matches dairy
// before "almond" hits plant_proteins, etc.
const KEYWORD_RULES: Array<{ cat: FoodCategory; words: string[] }> = [
  { cat: 'beverages', words: ['coffee', 'espresso', 'latte', 'tea', 'matcha', 'juice', 'soda', 'gatorade', 'kombucha', 'smoothie', 'shake', 'beer', 'wine'] },
  { cat: 'supplements', words: ['creatine', 'protein powder', 'whey', 'casein', 'multivitamin', 'vitamin', 'electrolyte', 'pre-workout', 'preworkout', 'collagen powder', 'fish oil', 'omega'] },
  { cat: 'dairy', words: ['milk', 'yogurt', 'cheese', 'cottage', 'butter', 'cream', 'kefir', 'ghee'] },
  { cat: 'fruits', words: ['apple', 'banana', 'berry', 'berries', 'strawberr', 'blueberr', 'raspberr', 'blackberr', 'grape', 'orange', 'mango', 'pineapple', 'peach', 'pear', 'melon', 'watermelon', 'kiwi', 'papaya', 'fruit'] },
  { cat: 'vegetables', words: ['salad', 'spinach', 'kale', 'broccoli', 'cauliflower', 'carrot', 'pepper', 'tomato', 'cucumber', 'lettuce', 'onion', 'garlic', 'zucchini', 'asparagus', 'mushroom', 'cabbage', 'celery', 'beet', 'vegetable', 'veggie'] },
  { cat: 'fats_oils', words: ['oil', 'olive', 'avocado', 'butter', 'mayo', 'mayonnaise', 'tahini', 'nut butter', 'peanut butter', 'almond butter', 'cashew butter'] },
  { cat: 'plant_proteins', words: ['tofu', 'tempeh', 'seitan', 'edamame', 'lentil', 'bean', 'chickpea', 'hummus', 'pea protein', 'soy', 'almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'peanut'] },
  { cat: 'proteins', words: ['chicken', 'beef', 'steak', 'pork', 'bacon', 'ham', 'turkey', 'lamb', 'fish', 'salmon', 'tuna', 'cod', 'shrimp', 'prawn', 'egg', 'liver', 'jerky'] },
  { cat: 'grains_carbs', words: ['rice', 'quinoa', 'oat', 'oatmeal', 'bread', 'toast', 'bagel', 'tortilla', 'pasta', 'noodle', 'pizza', 'sandwich', 'burrito', 'wrap', 'cereal', 'granola', 'pancake', 'waffle', 'potato', 'sweet potato', 'pita'] },
  { cat: 'condiments', words: ['sauce', 'dressing', 'ketchup', 'mustard', 'mayo', 'salsa', 'hot sauce', 'syrup', 'honey', 'jam', 'jelly'] },
  { cat: 'snack', words: ['chip', 'cracker', 'pretzel', 'popcorn', 'cookie', 'bar', 'chocolate', 'candy', 'ice cream'] },
];

function normalize(s: string): string {
  return (s || '').toLowerCase();
}

function assetKeyFromImageUrl(value: string | null | undefined): MealImageAssetKey | null {
  let key = String(value ?? '').trim();
  if (!key) return null;
  if (key.startsWith(MEAL_IMAGE_ASSET_URI_PREFIX)) {
    key = key.slice(MEAL_IMAGE_ASSET_URI_PREFIX.length);
  } else if (key.startsWith('asset:meal-card:')) {
    key = key.slice('asset:meal-card:'.length);
  }
  key = key.replace(/\.(jpg|jpeg|png)$/i, '');
  return Object.prototype.hasOwnProperty.call(MEAL_IMAGE_ASSETS, key)
    ? key as MealImageAssetKey
    : null;
}

/** Heuristic name → category. Future: replace with backend-provided
 *  `category` from FoodMetadata when foods have one stored. */
export function categoryForName(name: string | null | undefined): FoodCategory {
  const n = normalize(name || '');
  if (!n) return 'mixed';
  for (const rule of KEYWORD_RULES) {
    for (const w of rule.words) {
      if (n.includes(w)) return rule.cat;
    }
  }
  return 'mixed';
}

/** Resolve the most specific image we can show for a meal/saved-meal/
 *  meal-suggestion-shaped object. NEVER throws — every code path returns
 *  a valid ImageSpec, so callers don't have to guard. */
export function resolveMealImage(meal: {
  image_url?: string | null;
  image_source?: string | null;
  name?: string | null;
  meal?: string | null;
  items?: Array<{ food_name?: string | null; name?: string | null }> | null;
} | null | undefined): ImageSpec {
  const url = meal?.image_url || undefined;
  const imageSource = String(meal?.image_source ?? '').trim().toLowerCase();
  if (url) {
    // Even when a remote photo is set, the icon/tint act as a loading-
    // state shim if the <Image> hasn't loaded yet.
    const cat = categoryForName(meal?.name || meal?.meal || meal?.items?.[0]?.food_name || meal?.items?.[0]?.name);
    const style = CATEGORY_STYLE[cat] || CATEGORY_STYLE.mixed;
    const assetKey = imageSource === 'asset' || url.startsWith(MEAL_IMAGE_ASSET_URI_PREFIX) || url.startsWith('asset:meal-card:')
      ? assetKeyFromImageUrl(url)
      : null;
    if (assetKey) {
      return {
        kind: 'photo',
        asset: MEAL_IMAGE_ASSETS[assetKey],
        icon: style.icon,
        bg: style.bg,
        tint: style.tint,
        source: 'asset',
      };
    }
    if (imageSource === 'asset') {
      return { kind: 'category', icon: style.icon, bg: style.bg, tint: style.tint, source: 'category' };
    }
    const sourceTag = (meal?.image_source as ImageSpec['source']) || 'recipe';
    const allowed: ImageSpec['source'][] = ['user_photo', 'recipe', 'pexels', 'product', 'asset', 'category', 'placeholder'];
    return {
      kind: 'photo',
      uri: url,
      icon: style.icon,
      bg: style.bg,
      tint: style.tint,
      source: allowed.includes(sourceTag) ? sourceTag : 'recipe',
    };
  }
  const headline = meal?.name || meal?.meal || meal?.items?.[0]?.food_name || meal?.items?.[0]?.name || '';
  if (!headline.trim()) {
    return { kind: 'placeholder', icon: PLACEHOLDER_STYLE.icon, bg: PLACEHOLDER_STYLE.bg, tint: PLACEHOLDER_STYLE.tint, source: 'placeholder' };
  }
  const cat = categoryForName(headline);
  const style = CATEGORY_STYLE[cat] || CATEGORY_STYLE.mixed;
  return { kind: 'category', icon: style.icon, bg: style.bg, tint: style.tint, source: 'category' };
}

/** Standalone food/ingredient → ImageSpec. Use SPARINGLY — per product
 *  brief, ingredient rows should stay text-only. Reserve this for empty
 *  states, onboarding category headers, and grocery-style lists. */
export function resolveFoodImage(food: { image_url?: string | null; image_source?: string | null; name?: string | null } | null | undefined): ImageSpec {
  return resolveMealImage({
    image_url: food?.image_url ?? null,
    image_source: food?.image_source ?? null,
    name: food?.name ?? null,
  });
}

export const _internal = { CATEGORY_STYLE, PLACEHOLDER_STYLE };
