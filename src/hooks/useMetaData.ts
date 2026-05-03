/**
 * Fetches and caches all reference data from the backend:
 * foods, equipment, goals, paces, and goal config.
 *
 * Screens use this hook instead of importing the removed frontend constants files.
 */
import { useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getFoods, getFoodCategories, getEquipment, getGoals, getPaces, getGoalConfig } from '../services/api';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FoodItem {
  id?: number | null;
  name: string;
  unit: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface FoodCategoryGroup {
  key: string;
  label: string;
  icon: string;
  foods: FoodItem[];
}

export interface EquipmentItem {
  name: string;
  icon: string;
}

export interface EquipmentCategoryGroup {
  label: string;
  icon: string;
  items: EquipmentItem[];
}

export interface GoalOption {
  value: string;
  label: string;
  icon: string;
  description: string;
}

export interface PaceOption {
  goal_value: string;
  value: string;
  label: string;
  icon: string;
  rate: string;
  description: string;
}

export interface GoalConfig {
  weight_goals: string[];
  timeline_goals: string[];
  lifestyle_goals: string[];
  timeline_weeks: Record<string, Record<string, number>>;
}

export interface MetaData {
  foodCategories: FoodCategoryGroup[];
  allFoods: FoodItem[];
  foods?: FoodItem[];
  equipmentCategories: EquipmentCategoryGroup[];
  goals: GoalOption[];
  paces: PaceOption[];
  goalConfig: GoalConfig;
  loading: boolean;
  error: string | null;
}

// ── Cache key ─────────────────────────────────────────────────────────────────

// Bumped to v2 when `/foods` switched from per-100g to per-default-serving
// macros. Old cached values would show 884 cal for a tbsp of olive oil.
const CACHE_KEY = 'metaData_v2';

// ── Defaults (used until fetch completes) ─────────────────────────────────────

const DEFAULT_GOAL_CONFIG: GoalConfig = {
  weight_goals:   ['fat_loss', 'toning', 'muscle_gain'],
  timeline_goals: ['body_recomp', 'strength', 'endurance', 'athletic_performance'],
  lifestyle_goals:['maintain', 'flexibility', 'stress_relief', 'longevity'],
  timeline_weeks: {
    body_recomp:          { conservative: 12, moderate: 24, aggressive: 52 },
    strength:             { conservative: 4,  moderate: 12, aggressive: 26 },
    endurance:            { conservative: 4,  moderate: 8,  aggressive: 16 },
    athletic_performance: { conservative: 4,  moderate: 12, aggressive: 26 },
  },
};

const EMPTY: MetaData = {
  foodCategories: [],
  allFoods: [],
  equipmentCategories: [],
  goals: [],
  paces: [],
  goalConfig: DEFAULT_GOAL_CONFIG,
  loading: true,
  error: null,
};

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMetaData(): MetaData {
  const [meta, setMeta] = useState<MetaData>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // 1. Try to serve from AsyncStorage cache immediately
      try {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached && !cancelled) {
          setMeta({ ...JSON.parse(cached), loading: false, error: null });
        }
      } catch {}

      // 2. Fetch fresh data from backend
      try {
        const [rawFoods, foodCategoryMeta, rawEquipment, rawGoals, rawPaces, goalConfig] =
          await Promise.all([
            getFoods(),
            getFoodCategories(),
            getEquipment(),
            getGoals(),
            getPaces(),
            getGoalConfig(),
          ]);

        if (cancelled) return;

        // Group foods by category
        const foodsByCat: Record<string, FoodItem[]> = {};
        for (const f of rawFoods as any[]) {
          if (!foodsByCat[f.category]) foodsByCat[f.category] = [];
          foodsByCat[f.category].push({
            id: f.id ?? null,
            name: f.name, unit: f.unit,
            calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat,
          });
        }
        const categoryOrder = ['proteins', 'plant_proteins', 'dairy', 'grains_carbs', 'vegetables', 'fruits', 'fats_oils'];
        const foodCategories: FoodCategoryGroup[] = categoryOrder
          .filter(k => foodsByCat[k])
          .map(k => ({
            key:   k,
            label: (foodCategoryMeta as any)[k]?.label ?? k,
            icon:  (foodCategoryMeta as any)[k]?.icon  ?? 'restaurant-outline',
            foods: foodsByCat[k],
          }));

        // Group equipment by category
        const equipByCat: Record<string, EquipmentItem[]> = {};
        for (const e of rawEquipment as any[]) {
          if (!equipByCat[e.category]) equipByCat[e.category] = [];
          equipByCat[e.category].push({ name: e.name, icon: e.icon });
        }
        const categoryIcons: Record<string, string> = {
          'Bodyweight & Home': 'home-outline',
          'Free Weights':      'barbell-outline',
          'Benches & Racks':   'resize-outline',
          'Gym Machines':      'cog-outline',
          'Cardio':            'bicycle-outline',
        };
        const equipmentCategories: EquipmentCategoryGroup[] = Object.entries(equipByCat).map(([label, items]) => ({
          label,
          icon: categoryIcons[label] ?? 'build-outline',
          items,
        }));

        const allFoods: FoodItem[] = foodCategories.flatMap(c => c.foods);

        const result: MetaData = {
          foodCategories,
          allFoods,
          equipmentCategories,
          goals:      rawGoals as GoalOption[],
          paces:      rawPaces as PaceOption[],
          goalConfig: goalConfig as GoalConfig,
          loading: false,
          error: null,
        };

        setMeta(result);
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({
          foodCategories, allFoods, equipmentCategories,
          goals: rawGoals, paces: rawPaces, goalConfig,
        }));
      } catch (e: any) {
        if (!cancelled) {
          setMeta(prev => ({ ...prev, loading: false, error: e.message ?? 'Failed to load' }));
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return meta;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Case-insensitive food lookup from the loaded foods array. */
export function lookupFood(name: string, allFoods: FoodItem[]): FoodItem | undefined {
  const lower = name.toLowerCase();
  return allFoods.find(f => f.name.toLowerCase() === lower);
}

// Primary goal ids (build_muscle, lose_fat, ...) map to bucket names the
// backend /paces endpoint keys off (muscle_gain, fat_loss, ...). Without
// this map pacesForGoal returns [] for every launch goal, which kills the
// pace picker and the ETA lookup on Progress. Mirror of GOAL_TO_BUCKET in
// src/utils/goalEstimate.ts.
const PRIMARY_GOAL_TO_PACE_BUCKET: Record<string, string> = {
  build_muscle: 'muscle_gain', lean_bulk: 'muscle_gain', gain_weight: 'muscle_gain',
  improve_aesthetics: 'muscle_gain', build_glutes: 'muscle_gain',
  build_upper_body: 'muscle_gain', build_lower_body: 'muscle_gain',
  build_arms: 'muscle_gain', build_shoulders: 'muscle_gain',
  lose_fat: 'fat_loss', get_lean: 'fat_loss', cut: 'fat_loss',
  preserve_muscle_cutting: 'fat_loss',
  body_recomp: 'body_recomp',
  tone: 'toning', get_toned: 'toning',
};

/** Get pace options for a specific goal from the loaded paces array.
 *  Falls back through: bucket name → raw goal id → []. */
export function pacesForGoal(goal: string, paces: PaceOption[]): PaceOption[] {
  const bucket = PRIMARY_GOAL_TO_PACE_BUCKET[goal] ?? goal;
  const byBucket = paces.filter(p => p.goal_value === bucket);
  if (byBucket.length > 0) return byBucket;
  return paces.filter(p => p.goal_value === goal);
}
