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
  equipmentCategories: EquipmentCategoryGroup[];
  goals: GoalOption[];
  paces: PaceOption[];
  goalConfig: GoalConfig;
  loading: boolean;
  error: string | null;
}

// ── Cache key ─────────────────────────────────────────────────────────────────

const CACHE_KEY = 'metaData_v1';

// ── Defaults (used until fetch completes) ─────────────────────────────────────

const DEFAULT_GOAL_CONFIG: GoalConfig = {
  weight_goals:   ['fat_loss', 'toning', 'muscle_gain'],
  timeline_goals: ['body_recomp', 'strength', 'endurance', 'athletic_performance'],
  lifestyle_goals:['maintain', 'flexibility', 'stress_relief'],
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
            icon:  (foodCategoryMeta as any)[k]?.icon  ?? '🍽️',
            foods: foodsByCat[k],
          }));

        // Group equipment by category
        const equipByCat: Record<string, EquipmentItem[]> = {};
        for (const e of rawEquipment as any[]) {
          if (!equipByCat[e.category]) equipByCat[e.category] = [];
          equipByCat[e.category].push({ name: e.name, icon: e.icon });
        }
        const categoryIcons: Record<string, string> = {
          'Bodyweight & Home': '🏠',
          'Free Weights':      '🏋️',
          'Benches & Racks':   '🪑',
          'Gym Machines':      '⚙️',
          'Cardio':            '🏃',
        };
        const equipmentCategories: EquipmentCategoryGroup[] = Object.entries(equipByCat).map(([label, items]) => ({
          label,
          icon: categoryIcons[label] ?? '🔧',
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

/** Get pace options for a specific goal from the loaded paces array. */
export function pacesForGoal(goal: string, paces: PaceOption[]): PaceOption[] {
  return paces.filter(p => p.goal_value === goal);
}
