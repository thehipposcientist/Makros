import type { MealItem, MealSuggestion } from '../types';
import { ensureItems, macroTotalsFromMeal } from './mealItems.ts';

export type MacroKey = 'calories' | 'protein' | 'carbs' | 'fat';

export interface MacroContribution {
  name: string;
  meal: string;
  amount: number;
}

export interface ProteinSourceTotals {
  plant_total_g: number;
  animal_total_g: number;
  unclassified_total_g: number;
  plant_pct: number;
  animal_pct: number;
  unclassified_pct: number;
  plant: Array<{ name: string; protein_g: number }>;
  animal: Array<{ name: string; protein_g: number }>;
  unclassified: Array<{ name: string; protein_g: number }>;
}

const MACRO_KEYS: Record<MacroKey, string[]> = {
  calories: ['calories', 'calories_kcal', 'kcal'],
  protein: ['protein', 'protein_g'],
  carbs: ['carbs', 'carbs_g'],
  fat: ['fat', 'fat_g'],
};

function finiteNumber(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function firstNumericField(record: Record<string, any> | null | undefined, keys: string[]): number | null {
  if (!record) return null;
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value != null) return value;
  }
  return null;
}

function amountFromRecord(record: Record<string, any> | null | undefined, keys: string[]): number | null {
  return firstNumericField(record, keys) ?? firstNumericField(record?.micronutrients, keys);
}

function macroAmountFromItem(item: MealItem, macro: MacroKey): number {
  return Math.max(0, amountFromRecord(item as any, MACRO_KEYS[macro]) ?? 0);
}

function mealName(meal: MealSuggestion): string {
  return String(meal.meal || meal.name || 'Meal');
}

export function macroContributionsFromMeals(
  meals: MealSuggestion[] | null | undefined,
  macro: MacroKey,
): MacroContribution[] {
  const rows: MacroContribution[] = [];

  for (const meal of meals ?? []) {
    const withItems = ensureItems(meal);
    const label = mealName(withItems);
    const items = withItems.items ?? [];

    if (items.length > 0) {
      for (const item of items) {
        const amount = macroAmountFromItem(item, macro);
        if (amount > 0) {
          rows.push({
            name: String((item as any).food_name || item.name || label),
            meal: label,
            amount,
          });
        }
      }
      continue;
    }

    const fallback = macroTotalsFromMeal(withItems)[macro];
    if (fallback > 0) {
      rows.push({ name: label, meal: '', amount: fallback });
    }
  }

  return rows.sort((a, b) => b.amount - a.amount);
}

export function sumNutrientFromMeals(
  meals: MealSuggestion[] | null | undefined,
  keys: string[],
  topLevelKey?: string,
): number {
  const allKeys = Array.from(new Set([topLevelKey, ...keys].filter(Boolean) as string[]));
  let total = 0;

  for (const meal of meals ?? []) {
    const withItems = ensureItems(meal);
    const itemValues = (withItems.items ?? [])
      .map(item => amountFromRecord(item as any, allKeys))
      .filter((value): value is number => value != null);

    if (itemValues.length > 0) {
      total += itemValues.reduce((sum, value) => sum + value, 0);
      continue;
    }

    total += amountFromRecord(withItems as any, allKeys) ?? 0;
  }

  return Math.round(total * 10) / 10;
}

export function proteinSourceTotalsFromMeals(
  meals: MealSuggestion[] | null | undefined,
): ProteinSourceTotals | null {
  let plantG = 0;
  let animalG = 0;
  let unclassifiedG = 0;
  const plant: Array<{ name: string; protein_g: number }> = [];
  const animal: Array<{ name: string; protein_g: number }> = [];
  const unclassified: Array<{ name: string; protein_g: number }> = [];

  for (const meal of meals ?? []) {
    const withItems = ensureItems(meal);
    const label = mealName(withItems);
    const items = withItems.items ?? [];

    if (items.length === 0) {
      const protein = macroTotalsFromMeal(withItems).protein;
      if (protein > 0) {
        unclassifiedG += protein;
        unclassified.push({ name: label, protein_g: protein });
      }
      continue;
    }

    for (const item of items) {
      const protein = macroAmountFromItem(item, 'protein');
      if (protein <= 0) continue;
      const name = String((item as any).food_name || item.name || label);
      const source = (item as any).protein_source;
      if (source === 'plant') {
        plantG += protein;
        plant.push({ name, protein_g: protein });
      } else if (source === 'animal') {
        animalG += protein;
        animal.push({ name, protein_g: protein });
      } else if (source === 'mixed') {
        const half = protein * 0.5;
        plantG += half;
        animalG += half;
        plant.push({ name, protein_g: half });
        animal.push({ name, protein_g: half });
      } else {
        unclassifiedG += protein;
        unclassified.push({ name, protein_g: protein });
      }
    }
  }

  const total = plantG + animalG + unclassifiedG;
  if (total <= 0) return null;

  return {
    plant_total_g: Math.round(plantG),
    animal_total_g: Math.round(animalG),
    unclassified_total_g: Math.round(unclassifiedG),
    plant_pct: Math.round((plantG / total) * 100),
    animal_pct: Math.round((animalG / total) * 100),
    unclassified_pct: Math.round((unclassifiedG / total) * 100),
    plant,
    animal,
    unclassified,
  };
}
