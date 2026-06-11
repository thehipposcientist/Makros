import type { MealItem, MealRoutineEntry, MealRoutineFood } from '../types';

export type MealRoutineItemSnapshot = {
  food_name: string;
  food_id?: number | null;
  serving_id?: number | null;
  serving_grams?: number | null;
  quantity: number;
  unit: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

export type BackendMealRoutineSnapshot = {
  id: number;
  name: string;
  meal_type?: string | null;
  days_of_week?: number[] | null;
  default_time?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  active?: boolean;
  display_order?: number | null;
  total_calories?: number | null;
  total_protein_g?: number | null;
  total_carbs_g?: number | null;
  total_fat_g?: number | null;
  items?: MealRoutineItemSnapshot[] | null;
  created_at: string;
};

export type MealRoutineInputSnapshot = {
  name: string;
  meal_type?: string | null;
  display_order?: number;
  items?: MealRoutineItemSnapshot[];
  days_of_week?: number[];
  default_time?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  active?: boolean;
  idempotency_key?: string | null;
};

export function mealRoutineItemsFromBackend(items: MealRoutineItemSnapshot[] | null | undefined): MealItem[] {
  return (items ?? []).map(it => ({
    name: it.food_name,
    food_id: it.food_id ?? null,
    serving_id: it.serving_id ?? null,
    serving_grams: it.serving_grams ?? null,
    quantity: it.quantity,
    unit: it.unit as any,
    calories: it.calories,
    protein: it.protein_g,
    carbs: it.carbs_g,
    fat: it.fat_g,
  })) as MealItem[];
}

export function mealRoutineItemsToBackend(entry: MealRoutineEntry): MealRoutineItemSnapshot[] {
  const items = entry.items ?? [];
  if (items.length > 0) {
    return items.map(it => ({
      food_name: it.name,
      food_id: (it as any).food_id ?? null,
      serving_id: (it as any).serving_id ?? null,
      serving_grams: (it as any).serving_grams ?? null,
      quantity: Number((it as any).quantity ?? 1),
      unit: String((it as any).unit ?? 'serving'),
      calories: Number((it as any).calories ?? 0),
      protein_g: Number((it as any).protein ?? 0),
      carbs_g: Number((it as any).carbs ?? 0),
      fat_g: Number((it as any).fat ?? 0),
    }));
  }
  return (entry.foods ?? []).map((f: MealRoutineFood) => ({
    food_name: f.name,
    food_id: null,
    quantity: 1,
    unit: 'serving',
    calories: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
  }));
}

export function mealRoutineEntryFromBackend(routine: BackendMealRoutineSnapshot): MealRoutineEntry {
  const items = mealRoutineItemsFromBackend(routine.items);
  return {
    id: `routine_backend_${routine.id}`,
    backendId: routine.id,
    displayOrder: routine.display_order ?? 0,
    daysOfWeek: Array.isArray(routine.days_of_week) ? routine.days_of_week : [],
    defaultTime: routine.default_time ?? null,
    startDate: routine.start_date ?? null,
    endDate: routine.end_date ?? null,
    active: routine.active,
    name: routine.name,
    mealType: routine.meal_type ?? 'custom',
    foods: items.map((it, i) => ({
      id: `${routine.id}_${i}`,
      name: it.name,
      quantity: (it as any).unit === 'piece' ? String((it as any).quantity) : `${(it as any).quantity} ${(it as any).unit}`,
    })),
    items: items.length > 0 ? items : undefined,
    createdAt: routine.created_at,
    calories: routine.total_calories ?? undefined,
    protein: routine.total_protein_g ?? undefined,
    carbs: routine.total_carbs_g ?? undefined,
    fat: routine.total_fat_g ?? undefined,
  };
}

export function mealRoutineInputFromEntry(entry: MealRoutineEntry, fallbackOrder = 0): MealRoutineInputSnapshot {
  const mt = entry.mealType && entry.mealType !== 'custom' ? entry.mealType : undefined;
  const displayOrder = Number.isFinite(Number(entry.displayOrder)) ? Number(entry.displayOrder) : fallbackOrder;
  const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];
  return {
    name: entry.name,
    meal_type: mt,
    display_order: displayOrder,
    items: mealRoutineItemsToBackend(entry),
    days_of_week: Array.isArray(entry.daysOfWeek) ? entry.daysOfWeek : ALL_WEEK,
    default_time: entry.defaultTime ?? undefined,
    start_date: entry.startDate ?? undefined,
    end_date: entry.endDate ?? undefined,
    active: entry.active ?? true,
    ...(entry.id ? { idempotency_key: `routine:${entry.id}` } : {}),
  };
}

export function inferBackendIdFromRoutineEntry(entry: Pick<MealRoutineEntry, 'id' | 'backendId'>): number | null {
  if (entry.backendId != null && Number.isFinite(Number(entry.backendId))) {
    const id = Number(entry.backendId);
    return id > 0 ? id : null;
  }
  const match = /^routine_backend_(\d+)$/.exec(String(entry.id ?? '').trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
