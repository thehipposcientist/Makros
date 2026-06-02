// Per-item food icon resolver. Returns a MaterialCommunityIcons name +
// tint for a single food/ingredient. The icon is intended to render
// inline next to a food row in the meal item list — ~16px, decorative,
// not interactive. Always returns a valid spec; never throws.
//
// Why MaterialCommunityIcons: ships in `@expo/vector-icons` (already a
// dep), gives ~50 distinct food glyphs vs Ionicons' 6, and the line
// weight matches the rest of our icon system.
//
// Match order is most-specific → category fallback. The first keyword
// hit wins, so always put the more specific term ahead of the generic
// one (e.g. "almond butter" before "almond", "chicken breast" before
// "chicken"). The mapping is deliberately small + curated rather than
// exhaustive — anything we don't recognize falls back to a category
// icon driven by the same keyword rules `foodImage.ts` already uses.

import type { MaterialCommunityIcons } from '@expo/vector-icons';
import { categoryForName, type FoodCategory } from './foodImage';

type MciName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

export interface FoodIconSpec {
  name: MciName;
  /** Hex tint for the icon. Theme-agnostic — tint is chosen per food
   *  family so a row of icons reads as a small palette rather than a
   *  monochrome block. */
  color: string;
}

const CATEGORY_FALLBACK: Record<FoodCategory, FoodIconSpec> = {
  proteins:        { name: 'food-drumstick', color: '#B0431C' },
  plant_proteins:  { name: 'sprout',         color: '#3F8030' },
  grains_carbs:    { name: 'barley',         color: '#9C6818' },
  vegetables:      { name: 'leaf',           color: '#2F7A3A' },
  fruits:          { name: 'food-apple',     color: '#B83864' },
  dairy:           { name: 'cup-water',      color: '#3D5BAA' },
  fats_oils:       { name: 'bottle-soda',    color: '#C56A18' },
  condiments:      { name: 'food-variant',   color: '#A8442C' },
  beverages:       { name: 'cup-water',      color: '#76583A' },
  supplements:     { name: 'pill',            color: '#6840A8' },
  snack:           { name: 'cookie',         color: '#A06030' },
  mixed:           { name: 'silverware-fork-knife', color: '#606870' },
};

// Specific overrides. Order matters — the FIRST match wins, so longer/
// more-specific phrases must come before shorter ones that would also
// match. ("almond butter" before "almond", "sweet potato" before
// "potato", etc.)
const SPECIFIC_RULES: Array<{ words: string[]; spec: FoodIconSpec }> = [
  // Beverages — specific first
  { words: ['coffee', 'espresso', 'latte', 'cappuccino', 'macchiato'], spec: { name: 'coffee', color: '#76583A' } },
  { words: ['tea', 'matcha'],                                          spec: { name: 'tea',    color: '#3F8030' } },
  { words: ['beer', 'lager', 'ale'],                                    spec: { name: 'beer',   color: '#9C6818' } },
  { words: ['cocktail', 'mojito', 'margarita'],                         spec: { name: 'cup', color: '#B83864' } },
  { words: ['wine'],                                                    spec: { name: 'cup', color: '#7A1F3A' } },
  { words: ['soda', 'cola', 'sprite', 'pepsi'],                         spec: { name: 'bottle-soda', color: '#A8442C' } },
  { words: ['water'],                                                   spec: { name: 'cup-water',   color: '#3D5BAA' } },
  { words: ['juice'],                                                   spec: { name: 'fruit-citrus', color: '#C56A18' } },

  // Dairy
  { words: ['cottage cheese', 'cheese'],                                spec: { name: 'cheese',     color: '#9C6818' } },
  { words: ['greek yogurt', 'yogurt'],                                  spec: { name: 'cup-water',  color: '#3D5BAA' } },
  { words: ['almond milk', 'oat milk', 'soy milk', 'milk'],             spec: { name: 'cup-water',  color: '#3D5BAA' } },
  { words: ['butter'],                                                  spec: { name: 'food-variant', color: '#9C6818' } },
  { words: ['cream'],                                                   spec: { name: 'cup-water',  color: '#3D5BAA' } },

  // Eggs
  { words: ['egg whites', 'egg white'],                                 spec: { name: 'egg-fried', color: '#A8442C' } },
  { words: ['scrambled eggs', 'egg', 'eggs'],                           spec: { name: 'egg',       color: '#A8442C' } },

  // Proteins — meats
  { words: ['chicken thigh', 'chicken breast', 'chicken'],              spec: { name: 'food-drumstick', color: '#B0431C' } },
  { words: ['turkey'],                                                  spec: { name: 'food-drumstick', color: '#B0431C' } },
  { words: ['steak', 'beef', 'ground beef'],                            spec: { name: 'food-steak', color: '#7A1F3A' } },
  { words: ['pork tenderloin', 'pork', 'bacon', 'ham'],                 spec: { name: 'food-steak', color: '#B0431C' } },
  { words: ['lamb', 'bison', 'venison'],                                spec: { name: 'food-steak', color: '#7A1F3A' } },
  { words: ['sausage', 'hot dog', 'hotdog'],                            spec: { name: 'sausage',    color: '#B0431C' } },
  { words: ['salmon', 'tuna', 'tilapia', 'cod', 'shrimp', 'prawn', 'fish'], spec: { name: 'fish', color: '#3D5BAA' } },

  // Plant proteins / nuts / seeds
  { words: ['almond butter', 'peanut butter', 'cashew butter', 'nut butter'], spec: { name: 'food-variant', color: '#9C6818' } },
  { words: ['peanut'],                                                  spec: { name: 'peanut',     color: '#9C6818' } },
  { words: ['almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'hazelnut'], spec: { name: 'peanut', color: '#9C6818' } },
  { words: ['chia', 'flax', 'sunflower seed', 'pumpkin seed', 'seed'],  spec: { name: 'seed',       color: '#9C6818' } },
  { words: ['tofu', 'tempeh', 'seitan', 'edamame'],                     spec: { name: 'sprout',     color: '#3F8030' } },
  { words: ['lentil', 'chickpea', 'black bean', 'kidney bean', 'bean'], spec: { name: 'sprout',     color: '#3F8030' } },
  { words: ['hummus'],                                                  spec: { name: 'food-variant', color: '#9C6818' } },

  // Fruits
  { words: ['banana'],                                                  spec: { name: 'food-apple', color: '#C5A030' } },
  { words: ['apple'],                                                   spec: { name: 'food-apple', color: '#B83864' } },
  { words: ['orange', 'mandarin', 'lemon', 'lime', 'grapefruit'],       spec: { name: 'fruit-citrus', color: '#C56A18' } },
  { words: ['grape'],                                                   spec: { name: 'fruit-grapes', color: '#6840A8' } },
  { words: ['pineapple'],                                               spec: { name: 'fruit-pineapple', color: '#C5A030' } },
  { words: ['watermelon'],                                              spec: { name: 'fruit-watermelon', color: '#B83864' } },
  { words: ['blueberry', 'blueberries'],                                spec: { name: 'food-apple', color: '#3D5BAA' } },
  { words: ['strawberry', 'strawberries', 'raspberry', 'raspberries', 'blackberry', 'blackberries', 'berry', 'berries'], spec: { name: 'food-apple', color: '#B83864' } },
  { words: ['mango', 'peach', 'pear', 'plum', 'kiwi', 'papaya', 'apricot'], spec: { name: 'food-apple', color: '#C5A030' } },
  { words: ['avocado'],                                                 spec: { name: 'food-apple', color: '#3F8030' } },

  // Veg
  { words: ['sweet potato'],                                            spec: { name: 'carrot', color: '#C56A18' } },
  { words: ['potato'],                                                  spec: { name: 'food-variant', color: '#9C6818' } },
  { words: ['carrot'],                                                  spec: { name: 'carrot', color: '#C56A18' } },
  { words: ['broccoli', 'cauliflower', 'cabbage', 'brussels sprout', 'kale', 'spinach', 'lettuce', 'arugula', 'mixed greens', 'salad'], spec: { name: 'leaf', color: '#2F7A3A' } },
  { words: ['mushroom'],                                                spec: { name: 'mushroom', color: '#9C6818' } },
  { words: ['corn'],                                                    spec: { name: 'corn', color: '#C5A030' } },
  { words: ['tomato'],                                                  spec: { name: 'food-apple', color: '#B0431C' } },
  { words: ['bell pepper', 'pepper'],                                   spec: { name: 'chili-mild', color: '#3F8030' } },
  { words: ['chili', 'jalapeno', 'jalapeño'],                           spec: { name: 'chili-hot', color: '#B0431C' } },
  { words: ['onion', 'garlic', 'shallot', 'leek'],                      spec: { name: 'food-variant', color: '#9C6818' } },
  { words: ['cucumber', 'zucchini', 'asparagus', 'green bean', 'celery', 'beet', 'eggplant'], spec: { name: 'leaf', color: '#2F7A3A' } },

  // Grains / carbs
  { words: ['oat', 'oatmeal'],                                          spec: { name: 'barley', color: '#9C6818' } },
  { words: ['white rice', 'brown rice', 'rice'],                        spec: { name: 'rice',   color: '#9C6818' } },
  { words: ['quinoa', 'couscous', 'barley', 'farro', 'bulgur'],         spec: { name: 'barley', color: '#9C6818' } },
  { words: ['pasta', 'spaghetti', 'penne', 'rigatoni', 'fettuccine', 'macaroni'], spec: { name: 'pasta', color: '#C5A030' } },
  { words: ['noodle', 'ramen', 'udon', 'pho'],                          spec: { name: 'noodles', color: '#9C6818' } },
  { words: ['bagel'],                                                   spec: { name: 'food-croissant', color: '#9C6818' } },
  { words: ['toast', 'bread', 'sourdough', 'whole wheat'],              spec: { name: 'bread-slice', color: '#9C6818' } },
  { words: ['tortilla', 'wrap', 'pita'],                                spec: { name: 'food-croissant', color: '#9C6818' } },
  { words: ['croissant', 'muffin', 'pancake', 'waffle', 'pastry'],      spec: { name: 'food-croissant', color: '#9C6818' } },
  { words: ['cereal', 'granola'],                                       spec: { name: 'food-variant', color: '#9C6818' } },
  { words: ['pizza'],                                                   spec: { name: 'pizza', color: '#B0431C' } },
  { words: ['burger', 'hamburger', 'cheeseburger'],                     spec: { name: 'silverware-fork-knife', color: '#B0431C' } },
  { words: ['fries', 'french fries'],                                   spec: { name: 'silverware-fork-knife', color: '#C5A030' } },
  { words: ['sandwich', 'sub', 'hoagie'],                               spec: { name: 'silverware-fork-knife', color: '#9C6818' } },
  { words: ['burrito', 'taco', 'quesadilla'],                           spec: { name: 'bowl-mix', color: '#B0431C' } },

  // Fats / oils
  { words: ['olive oil', 'coconut oil', 'avocado oil', 'oil'],          spec: { name: 'bottle-soda', color: '#C56A18' } },

  // Condiments
  { words: ['mayo', 'mayonnaise', 'ketchup', 'mustard', 'sriracha', 'hot sauce', 'soy sauce', 'dressing', 'sauce', 'salsa'], spec: { name: 'food-variant', color: '#A8442C' } },
  { words: ['honey', 'maple syrup', 'syrup', 'jam', 'jelly'],           spec: { name: 'food-variant', color: '#C56A18' } },

  // Snacks / sweets
  { words: ['ice cream', 'gelato', 'sorbet'],                           spec: { name: 'ice-cream',  color: '#B83864' } },
  { words: ['cake', 'cheesecake'],                                      spec: { name: 'cake',       color: '#B83864' } },
  { words: ['cupcake'],                                                 spec: { name: 'cupcake',    color: '#B83864' } },
  { words: ['cookie', 'biscuit'],                                       spec: { name: 'cookie',     color: '#9C6818' } },
  { words: ['candy', 'chocolate', 'caramel'],                           spec: { name: 'candy',      color: '#7A1F3A' } },
  { words: ['chip', 'pretzel', 'popcorn', 'cracker'],                   spec: { name: 'cookie',     color: '#9C6818' } },
  { words: ['protein bar', 'granola bar', 'bar'],                       spec: { name: 'cookie',     color: '#9C6818' } },

  // Supplements / powders
  { words: ['protein powder', 'whey', 'casein', 'creatine', 'pre-workout', 'preworkout', 'bcaa', 'electrolyte', 'collagen'], spec: { name: 'pill', color: '#6840A8' } },
  { words: ['multivitamin', 'vitamin', 'fish oil', 'omega'],            spec: { name: 'pill', color: '#6840A8' } },

  // Smoothies / shakes
  { words: ['smoothie', 'shake', 'protein shake'],                      spec: { name: 'cup-water',  color: '#3F8030' } },

  // Soup / broth
  { words: ['soup', 'stew', 'chili', 'broth', 'bone broth'],            spec: { name: 'pot-steam',  color: '#9C6818' } },
];

function normalize(s: string): string {
  return (s || '').toLowerCase();
}

/** Pick an icon for a single food/ingredient name. Always returns a
 *  valid spec — falls back to the food's category icon when no specific
 *  rule matches. */
export function getFoodIconSpec(name: string | null | undefined): FoodIconSpec {
  const n = normalize(name || '').trim();
  if (!n) return CATEGORY_FALLBACK.mixed;
  for (const rule of SPECIFIC_RULES) {
    for (const w of rule.words) {
      if (n.includes(w)) return rule.spec;
    }
  }
  const cat = categoryForName(n);
  return CATEGORY_FALLBACK[cat] ?? CATEGORY_FALLBACK.mixed;
}

export const _internal = { CATEGORY_FALLBACK, SPECIFIC_RULES };
