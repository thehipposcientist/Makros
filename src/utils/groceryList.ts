// Aggregate the week's meal plan into a shoppable grocery list.
// Normalizes names and sums quantities by unit. If the same ingredient shows
// up with different units (e.g., "chicken breast" in oz and g), they're kept
// as separate rows so we don't silently convert.

import type { DailyNutritionPlan, MealItem } from '../types';

export interface GroceryRow {
  name: string;
  quantity: number;
  unit: string;
  meals: number; // how many meals across the week use this item
  category: GroceryCategory;
}

export type GroceryCategory =
  | 'Produce'
  | 'Protein'
  | 'Dairy & Eggs'
  | 'Grains & Bakery'
  | 'Pantry'
  | 'Frozen'
  | 'Drinks'
  | 'Supplements'
  | 'Other';

const PLURAL_RULES: Array<[RegExp, string]> = [
  [/ies$/i, 'y'],
  [/ves$/i, 'f'],
  [/ses$/i, 's'],
  [/s$/i,   ''],
];

function normalizeName(raw: string): string {
  let n = (raw || '').toLowerCase().trim();
  n = n.replace(/\(.+?\)/g, '').replace(/\s+/g, ' ').trim();
  // Strip leading quantity words like "some", "a little"
  n = n.replace(/^(some|a few|a little|extra)\s+/i, '').trim();
  // Singularize basic plurals (eggs → egg, berries → berry)
  for (const [re, rep] of PLURAL_RULES) {
    if (re.test(n)) { n = n.replace(re, rep); break; }
  }
  return n;
}

function keyFor(name: string, unit: string): string {
  return `${normalizeName(name)}__${unit.toLowerCase()}`;
}

function inferCategory(name: string): GroceryCategory {
  const n = normalizeName(name);
  if (/(spinach|kale|broccoli|lettuce|salad|pepper|onion|garlic|tomato|cucumber|carrot|avocado|banana|apple|berry|berries|fruit|vegetable|lemon|lime|orange|potato|sweet potato)/i.test(n)) return 'Produce';
  if (/(chicken|beef|turkey|salmon|tuna|shrimp|fish|pork|tofu|tempeh|protein)/i.test(n)) return 'Protein';
  if (/(milk|cheese|butter|kefir|greek yogurt|yogurt|cottage cheese|egg|eggs)/i.test(n)) return 'Dairy & Eggs';
  if (/(bread|bagel|wrap|tortilla|rice|oats|oatmeal|quinoa|pasta|granola|cereal)/i.test(n)) return 'Grains & Bakery';
  if (/(frozen)/i.test(n)) return 'Frozen';
  if (/(coffee|tea|juice|water|electrolyte|drink|smoothie)/i.test(n)) return 'Drinks';
  if (/(creatine|vitamin|magnesium|omega|supplement|powder)/i.test(n)) return 'Supplements';
  if (/(olive oil|oil|sauce|seasoning|salt|pepper|peanut butter|almond butter|nuts|nut butter|bean|beans|lentils|hummus|salsa|honey)/i.test(n)) return 'Pantry';
  return 'Other';
}

export function buildGroceryList(plans: DailyNutritionPlan[]): GroceryRow[] {
  const map = new Map<string, GroceryRow>();

  for (const plan of plans) {
    if (!plan?.meals) continue;
    for (const meal of plan.meals) {
      const items: MealItem[] = meal.items ?? [];
      for (const item of items) {
        if (!item?.name) continue;
        const k = keyFor(item.name, item.unit ?? '');
        const existing = map.get(k);
        if (existing) {
          existing.quantity += Number(item.quantity) || 0;
          existing.meals += 1;
        } else {
          map.set(k, {
            name: normalizeName(item.name).replace(/^./, c => c.toUpperCase()),
            quantity: Number(item.quantity) || 0,
            unit: String(item.unit ?? ''),
            meals: 1,
            category: inferCategory(item.name),
          });
        }
      }
    }
  }

  // Sort alphabetically, capitalize first letter
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Format a row for text export (WhatsApp / Notes / etc.).
export function formatGroceryText(rows: GroceryRow[], header?: string): string {
  const out: string[] = [];
  if (header) out.push(header, '');
  for (const r of rows) {
    out.push(`- ${r.name} — ${formatGroceryQuantity(r.quantity, r.unit)}${r.meals > 1 ? ` (${r.meals} meals)` : ''}`);
  }
  return out.join('\n');
}

export function formatGroceryQuantity(quantity: number, unit: string): string {
  const q = quantity % 1 === 0 ? String(quantity) : quantity.toFixed(1);
  const rawUnit = (unit || '').trim().toLowerCase();
  if (!rawUnit) return `${q} item${quantity === 1 ? '' : 's'}`;
  const singularPlural: Record<string, { one: string; many: string }> = {
    serving: { one: 'serving', many: 'servings' },
    servings: { one: 'serving', many: 'servings' },
    cup: { one: 'cup', many: 'cups' },
    cups: { one: 'cup', many: 'cups' },
    slice: { one: 'slice', many: 'slices' },
    slices: { one: 'slice', many: 'slices' },
    can: { one: 'can', many: 'cans' },
    cans: { one: 'can', many: 'cans' },
    packet: { one: 'packet', many: 'packets' },
    packets: { one: 'packet', many: 'packets' },
    piece: { one: 'piece', many: 'pieces' },
    pieces: { one: 'piece', many: 'pieces' },
    clove: { one: 'clove', many: 'cloves' },
    cloves: { one: 'clove', many: 'cloves' },
  };
  const mapped = singularPlural[rawUnit];
  if (mapped) return `${q} ${quantity === 1 ? mapped.one : mapped.many}`;
  return `${q} ${unit}`;
}
