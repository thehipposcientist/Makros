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
}

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
    const q = r.quantity % 1 === 0 ? String(r.quantity) : r.quantity.toFixed(1);
    out.push(`- ${r.name} — ${q}${r.unit ? ' ' + r.unit : ''}${r.meals > 1 ? ` (${r.meals}x)` : ''}`);
  }
  return out.join('\n');
}
