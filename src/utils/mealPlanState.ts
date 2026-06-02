import type { DailyNutritionPlan, MealSuggestion } from '../types';

type PlanMap = Record<string, DailyNutritionPlan>;
type ChecksMap = Record<string, Record<string, boolean>>;

type HistoryItemLike = {
  food_name?: string | null;
  name?: string | null;
  quantity?: number | null;
  unit?: string | null;
  calories?: number | null;
  protein_g?: number | null;
  protein?: number | null;
  carbs_g?: number | null;
  carbs?: number | null;
  fat_g?: number | null;
  fat?: number | null;
};

export type MealHistoryEntryLike = {
  id?: number | null;
  meal_date?: string | null;
  meal_type?: string | null;
  client_meal_key?: string | null;
  name?: string | null;
  source?: string | null;
  items?: HistoryItemLike[] | null;
  totals?: {
    calories?: number | null;
    protein_g?: number | null;
    carbs_g?: number | null;
    fat_g?: number | null;
  } | null;
};

export interface MealPlanSaveResult {
  plansByDate: PlanMap;
  plan: DailyNutritionPlan | null;
  meal: MealSuggestion;
  mealType: string;
  mealIndex: number;
}

export interface MealPlanMoveResult {
  plan: DailyNutritionPlan;
  checks: Record<string, boolean>;
  fromIndex: number;
  toIndex: number;
}

function parseMealKeyIndex(mealType: string): number {
  if (!mealType.startsWith('meal_')) return -1;
  const idx = parseInt(mealType.slice(5), 10);
  return Number.isFinite(idx) ? idx : -1;
}

export function mealLegacyKey(index: number): string {
  return `meal_${index}`;
}

function compactMealKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function rawMealClientKey(meal: MealSuggestion | null | undefined): string {
  if (!meal) return '';
  return compactMealKey((meal as any)._clientMealKey ?? (meal as any).client_meal_key);
}

function compactPrefixedKey(prefix: string, value: unknown): string {
  const compacted = compactMealKey(value);
  if (!compacted) return '';
  const suffix = compacted.slice(0, Math.max(1, 63 - prefix.length));
  return compactMealKey(`${prefix}${suffix}`);
}

export function mealClientKey(meal: MealSuggestion, index = 0): string {
  const existing = rawMealClientKey(meal);
  if (existing) return existing;

  const loggedId = Number((meal as any)._loggedMealId ?? (meal as any).logged_meal_id ?? 0) || 0;
  if (loggedId) return `log_${loggedId}`;

  const localKey = compactPrefixedKey('local_', (meal as any)._localId);
  if (localKey) return localKey;

  const routineKey = compactPrefixedKey('routine_', (meal as any)._routineId);
  if (routineKey) return routineKey;

  const signature = mealSuggestionMergeSignature(meal)
    || `${meal.meal || (meal as any).name || 'meal'}:${Math.round(Number(meal.calories ?? 0))}`;
  return `plan_${Math.max(0, index)}_${stableHash(signature)}`;
}

function uniqueMealClientKey(meal: MealSuggestion, index: number, used: Set<string>): string {
  const base = mealClientKey(meal, index) || `plan_${Math.max(0, index)}`;
  let key = base.slice(0, 64);
  let suffix = 2;
  while (used.has(key)) {
    const tag = `_${suffix}`;
    key = `${base.slice(0, Math.max(1, 64 - tag.length))}${tag}`;
    suffix += 1;
  }
  used.add(key);
  return key;
}

export function ensureMealClientKeys(plan: DailyNutritionPlan): DailyNutritionPlan {
  const used = new Set<string>();
  let changed = false;
  const meals = (plan.meals ?? []).map((meal, index) => {
    const key = uniqueMealClientKey(meal, index, used);
    if (rawMealClientKey(meal) === key && (meal as any)._clientMealKey === key) {
      return meal;
    }
    changed = true;
    return { ...meal, _clientMealKey: key } as MealSuggestion;
  });
  return changed ? { ...plan, meals } : plan;
}

export function markMealPlanUserEdited(plan: DailyNutritionPlan): DailyNutritionPlan {
  return { ...ensureMealClientKeys(plan), _userEdited: true } as DailyNutritionPlan;
}

export function isUserEditedMealPlan(plan: DailyNutritionPlan | null | undefined): boolean {
  if (!plan) return false;
  const rawPlan = plan as any;
  if (rawPlan._userEdited === true || rawPlan._manualDayPlan === true) return true;
  if (Array.isArray(rawPlan.suppressedRoutineIds) && rawPlan.suppressedRoutineIds.length > 0) return true;
  return (plan.meals ?? []).some((meal: any) => {
    const key = String(meal?._clientMealKey ?? meal?.client_meal_key ?? '').trim().toLowerCase();
    return !!(
      meal?._localId
      || meal?._loggedMealId
      || meal?.logged_meal_id
      || meal?._savedMealId
      || meal?.saved_meal_id
      || meal?._routineId
      || meal?.isRoutine
      || key.startsWith('local_')
      || key.startsWith('log_')
      || key.startsWith('saved_')
      || key.startsWith('history_')
      || key.startsWith('routine_')
    );
  });
}

function explicitMealKeyCandidates(meal: MealSuggestion): string[] {
  const keys = [
    rawMealClientKey(meal),
    compactPrefixedKey('log_', (meal as any)._loggedMealId ?? (meal as any).logged_meal_id),
    compactPrefixedKey('local_', (meal as any)._localId),
    compactPrefixedKey('routine_', (meal as any)._routineId),
  ];
  return Array.from(new Set(keys.filter(Boolean)));
}

function fallbackMealKeyCandidates(meal: MealSuggestion, index: number): string[] {
  return Array.from(new Set([
    mealClientKey(meal, index),
    mealLegacyKey(index),
  ].filter(Boolean)));
}

export function mealCheckKey(
  plan: DailyNutritionPlan | null | undefined,
  meal: MealSuggestion,
  index: number,
): string {
  void plan;
  return mealClientKey(meal, index);
}

export function resolveMealIndex(
  plan: DailyNutritionPlan | null | undefined,
  mealType: string,
): number {
  const meals = plan?.meals ?? [];
  const key = compactMealKey(mealType);
  if (!key || meals.length === 0) return -1;

  const explicitIndex = meals.findIndex(meal => explicitMealKeyCandidates(meal).includes(key));
  if (explicitIndex >= 0) return explicitIndex;

  const fallbackIndex = meals.findIndex((meal, index) => fallbackMealKeyCandidates(meal, index).includes(key));
  if (fallbackIndex >= 0) return fallbackIndex;

  const legacyIndex = parseMealKeyIndex(mealType);
  return legacyIndex >= 0 && legacyIndex < meals.length ? legacyIndex : -1;
}

export function mealCheckKeyForType(
  plan: DailyNutritionPlan | null | undefined,
  mealType: string,
): string | null {
  const index = resolveMealIndex(plan, mealType);
  const meal = index >= 0 ? (plan?.meals ?? [])[index] : undefined;
  return meal ? mealCheckKey(plan, meal, index) : null;
}

export function normalizeMealChecksForPlan(
  plan: DailyNutritionPlan | null | undefined,
  checks: Record<string, boolean> | null | undefined,
): Record<string, boolean> {
  const entries = Object.entries(checks ?? {});
  if (!plan || entries.length === 0) return { ...(checks ?? {}) };
  const next: Record<string, boolean> = {};
  for (const [key, value] of entries) {
    const normalizedKey = mealCheckKeyForType(plan, key);
    if (!normalizedKey) continue;
    next[normalizedKey] = next[normalizedKey] === true ? true : !!value;
  }
  return next;
}

export function upsertMealInPlansByDate(
  plansByDate: PlanMap,
  date: string,
  mealType: string,
  meal: MealSuggestion,
  opts: {
    fallbackPlan?: DailyNutritionPlan | null;
    makeLocalId?: () => string;
  } = {},
): MealPlanSaveResult {
  const currentRaw = plansByDate[date] ?? opts.fallbackPlan ?? null;
  if (!currentRaw) {
    return { plansByDate, plan: null, meal, mealType, mealIndex: -1 };
  }
  const current = ensureMealClientKeys(currentRaw);

  const isNewMeal = mealType === 'new_meal' || mealType === 'new_extra';
  const savedMeal = isNewMeal && !(meal as any)._localId && opts.makeLocalId
    ? { ...meal, _localId: opts.makeLocalId() } as MealSuggestion
    : meal;
  const meals = [...(current.meals ?? [])];
  let mealIndex = -1;
  let savedMealType = mealType;

  if (isNewMeal) {
    meals.unshift(savedMeal);
    mealIndex = 0;
  } else {
    const idx = resolveMealIndex(current, mealType);
    if (idx >= 0 && idx < meals.length) {
      const existingKey = rawMealClientKey(meals[idx]);
      meals[idx] = existingKey && !rawMealClientKey(savedMeal)
        ? { ...savedMeal, _clientMealKey: existingKey } as MealSuggestion
        : savedMeal;
      mealIndex = idx;
    } else {
      meals.unshift(savedMeal);
      mealIndex = 0;
    }
  }

  const plan = ensureMealClientKeys({ ...current, meals });
  if (mealIndex >= 0) {
    savedMealType = mealCheckKey(plan, plan.meals[mealIndex], mealIndex);
  }
  return {
    plansByDate: { ...plansByDate, [date]: plan },
    plan,
    meal: mealIndex >= 0 ? plan.meals[mealIndex] : savedMeal,
    mealType: savedMealType,
    mealIndex,
  };
}

export function setMealCheckedInChecksByDate(
  checksByDate: ChecksMap,
  date: string,
  mealType: string,
  checked = true,
  plan?: DailyNutritionPlan | null,
): { checksByDate: ChecksMap; dateChecks: Record<string, boolean> } {
  const baseChecks = plan
    ? normalizeMealChecksForPlan(plan, checksByDate[date] ?? {})
    : { ...(checksByDate[date] ?? {}) };
  const checkKey = plan ? (mealCheckKeyForType(plan, mealType) ?? mealType) : mealType;
  const dateChecks = { ...baseChecks, [checkKey]: checked };
  return {
    checksByDate: { ...checksByDate, [date]: dateChecks },
    dateChecks,
  };
}

export function moveMealInPlanWithChecks(
  plan: DailyNutritionPlan | null | undefined,
  checks: Record<string, boolean> | null | undefined,
  mealType: string,
  direction: -1 | 1,
): MealPlanMoveResult | null {
  if (!plan) return null;
  const keyedPlan = ensureMealClientKeys(plan);
  const meals = [...(keyedPlan.meals ?? [])];
  const fromIndex = resolveMealIndex(keyedPlan, mealType);
  if (fromIndex < 0 || fromIndex >= meals.length) return null;

  const removed = new Set(keyedPlan.removedMealIds ?? []);
  const visibleIndexes = meals
    .map((_, index) => index)
    .filter(index => !removed.has(mealLegacyKey(index)) && !removed.has(mealCheckKey(keyedPlan, meals[index], index)));
  const visiblePosition = visibleIndexes.indexOf(fromIndex);
  if (visiblePosition < 0) return null;

  const targetVisiblePosition = visiblePosition + direction;
  if (targetVisiblePosition < 0 || targetVisiblePosition >= visibleIndexes.length) return null;
  const toIndex = visibleIndexes[targetVisiblePosition];
  if (toIndex < 0 || toIndex >= meals.length || toIndex === fromIndex) return null;

  [meals[fromIndex], meals[toIndex]] = [meals[toIndex], meals[fromIndex]];

  const nextPlan = ensureMealClientKeys({ ...keyedPlan, meals });
  const nextChecks = normalizeMealChecksForPlan(nextPlan, normalizeMealChecksForPlan(keyedPlan, checks ?? {}));

  return {
    plan: nextPlan,
    checks: nextChecks,
    fromIndex,
    toIndex,
  };
}

function normalizeMealText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundedNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function itemSignature(items: Array<Record<string, any>> | null | undefined): string {
  if (!Array.isArray(items) || items.length === 0) return '';
  return items
    .map((item) => {
      const name = normalizeMealText(item.food_name ?? item.name);
      if (!name) return '';
      return [
        name,
        roundedNumber(item.quantity),
        normalizeMealText(item.unit),
        roundedNumber(item.calories),
        roundedNumber(item.protein_g ?? item.protein),
        roundedNumber(item.carbs_g ?? item.carbs),
        roundedNumber(item.fat_g ?? item.fat),
      ].join(':');
    })
    .filter(Boolean)
    .sort()
    .join('|');
}

function mealItems(meal: MealSuggestion): Array<Record<string, any>> {
  if (Array.isArray((meal as any).items) && (meal as any).items.length > 0) {
    return (meal as any).items;
  }
  return (meal.foods ?? []).map((food, i) => ({
    name: food,
    quantity: 1,
    unit: meal.amounts?.[i] ?? 'serving',
  }));
}

function mealCalories(meal: MealSuggestion): number {
  return roundedNumber(meal.calories);
}

function historyCalories(entry: MealHistoryEntryLike): number {
  const total = entry.totals?.calories;
  if (total != null) return roundedNumber(total);
  return roundedNumber((entry.items ?? []).reduce((sum, item) => sum + Number(item.calories ?? 0), 0));
}

function mealContentSignature(meal: MealSuggestion): string {
  const names = mealItems(meal)
    .map(item => normalizeMealText(item.food_name ?? item.name))
    .filter(Boolean)
    .sort()
    .join('|');
  if (!names) return '';
  return [
    names,
    mealCalories(meal),
    roundedNumber(meal.protein),
    roundedNumber(meal.carbs),
    roundedNumber(meal.fat),
  ].join('::');
}

function historyContentSignature(entry: MealHistoryEntryLike): string {
  const names = (entry.items ?? [])
    .map(item => normalizeMealText(item.food_name ?? item.name))
    .filter(Boolean)
    .sort()
    .join('|');
  if (!names) return '';
  return [
    names,
    historyCalories(entry),
    roundedNumber(entry.totals?.protein_g),
    roundedNumber(entry.totals?.carbs_g),
    roundedNumber(entry.totals?.fat_g),
  ].join('::');
}

function mealTypeIndex(mealType: string | null | undefined): number | null {
  switch ((mealType ?? '').toLowerCase()) {
    case 'breakfast': return 0;
    case 'lunch': return 1;
    case 'dinner': return 2;
    case 'snack': return 3;
    default: return null;
  }
}

function loggedMealIdFromSuggestion(meal: MealSuggestion): number {
  return Number((meal as any)._loggedMealId ?? 0) || 0;
}

function mergeLoggedBackendMeal(localMeal: MealSuggestion, backendMeal: MealSuggestion): MealSuggestion {
  const localAny = localMeal as any;
  const backendAny = backendMeal as any;
  const localClientKey = rawMealClientKey(localMeal);
  const backendClientKey = rawMealClientKey(backendMeal);
  const backendId = loggedMealIdFromSuggestion(backendMeal) || loggedMealIdFromSuggestion(localMeal);
  return {
    ...backendMeal,
    _localId: localAny._localId ?? backendAny._localId,
    _clientMealKey: localClientKey || backendClientKey || undefined,
    ...(backendId ? { _loggedMealId: backendId } : {}),
    ...(backendAny._consumedAt ? { _consumedAt: backendAny._consumedAt } : localAny._consumedAt ? { _consumedAt: localAny._consumedAt } : {}),
    ...(backendAny._savedMealId != null ? { _savedMealId: backendAny._savedMealId } : localAny._savedMealId != null ? { _savedMealId: localAny._savedMealId } : {}),
    ...(localAny._routineId ? { _routineId: localAny._routineId } : {}),
    ...(localAny.isRoutine != null ? { isRoutine: localAny.isRoutine } : {}),
    ...(backendAny.instructions ? {} : localAny.instructions ? { instructions: localAny.instructions } : {}),
  } as MealSuggestion;
}

export function mealSuggestionMergeSignature(meal: MealSuggestion): string {
  const name = normalizeMealText((meal as any).meal ?? (meal as any).name);
  if (!name) return '';
  return [
    name,
    mealItems(meal).length,
    mealCalories(meal),
  ].join('|');
}

export function mergeBackendMealSuggestionsIntoPlan(
  plan: DailyNutritionPlan,
  backendMeals: MealSuggestion[],
): DailyNutritionPlan {
  if (backendMeals.length === 0) return ensureMealClientKeys(plan);
  const keyedPlan = ensureMealClientKeys(plan);

  const usedBackendIndexes = new Set<number>();
  const backendIdToIndex = new Map<number, number>();
  backendMeals.forEach((meal, index) => {
    const id = loggedMealIdFromSuggestion(meal);
    if (id > 0 && !backendIdToIndex.has(id)) backendIdToIndex.set(id, index);
  });

  let changed = false;
  const mergedRows = (keyedPlan.meals ?? []).map((meal, mealIndex) => {
    const existingId = loggedMealIdFromSuggestion(meal);
    if (existingId > 0) {
      const backendIndex = backendIdToIndex.get(existingId);
      if (backendIndex != null) {
        usedBackendIndexes.add(backendIndex);
        changed = true;
        return { meal: mergeLoggedBackendMeal(meal, backendMeals[backendIndex]) };
      }
      return { meal };
    }

    const keyCandidates = new Set([
      ...explicitMealKeyCandidates(meal),
      ...fallbackMealKeyCandidates(meal, mealIndex),
    ]);
    const keyMatchedBackendIndex = backendMeals.findIndex((backendMeal, index) => {
      if (usedBackendIndexes.has(index)) return false;
      if (loggedMealIdFromSuggestion(backendMeal) <= 0) return false;
      const backendKey = rawMealClientKey(backendMeal);
      return !!backendKey && keyCandidates.has(backendKey);
    });
    if (keyMatchedBackendIndex >= 0) {
      usedBackendIndexes.add(keyMatchedBackendIndex);
      const backendMeal = backendMeals[keyMatchedBackendIndex] as any;
      changed = true;
      return {
        meal: mergeLoggedBackendMeal(meal, backendMeal),
        promoteBackendIndex: keyMatchedBackendIndex,
      };
    }

    const contentSignature = mealContentSignature(meal);
    if (contentSignature) {
      const contentMatchedBackendIndex = backendMeals.findIndex((backendMeal, index) => (
        !usedBackendIndexes.has(index)
        && loggedMealIdFromSuggestion(backendMeal) > 0
        && mealContentSignature(backendMeal) === contentSignature
      ));
      if (contentMatchedBackendIndex >= 0) {
        usedBackendIndexes.add(contentMatchedBackendIndex);
        const backendMeal = backendMeals[contentMatchedBackendIndex] as any;
        changed = true;
        return {
          meal: mergeLoggedBackendMeal(meal, backendMeal),
          promoteBackendIndex: contentMatchedBackendIndex,
        };
      }
    }

    const signature = mealSuggestionMergeSignature(meal);
    if (!signature) return { meal };

    const backendIndex = backendMeals.findIndex((backendMeal, index) => (
      !usedBackendIndexes.has(index)
      && loggedMealIdFromSuggestion(backendMeal) > 0
      && mealSuggestionMergeSignature(backendMeal) === signature
    ));
    if (backendIndex < 0) return { meal };

    usedBackendIndexes.add(backendIndex);
    const backendMeal = backendMeals[backendIndex] as any;
    changed = true;
    return {
      meal: mergeLoggedBackendMeal(meal, backendMeal),
      promoteBackendIndex: backendIndex,
    };
  });
  const meals = mergedRows.map(row => row.meal);

  const representedIds = new Set(
    meals.map(loggedMealIdFromSuggestion).filter(id => id > 0),
  );
  const representedClientKeys = new Set(
    meals.flatMap((meal, index) => [
      ...explicitMealKeyCandidates(meal),
      ...fallbackMealKeyCandidates(meal, index),
    ]).filter(Boolean),
  );
  const representedSignatures = new Set(
    meals.map(mealSuggestionMergeSignature).filter(Boolean),
  );
  const extraBackendRows = backendMeals.map((backendMeal, index) => ({ backendMeal, index })).filter(({ backendMeal, index }) => {
    if (usedBackendIndexes.has(index)) return false;
    const backendKey = rawMealClientKey(backendMeal);
    if (backendKey && representedClientKeys.has(backendKey)) return false;
    const id = loggedMealIdFromSuggestion(backendMeal);
    if (id > 0) return !representedIds.has(id);
    const signature = mealSuggestionMergeSignature(backendMeal);
    return !!signature && !representedSignatures.has(signature);
  });

  const promotedMeals = [
    ...mergedRows
      .filter(row => row.promoteBackendIndex != null)
      .map(row => ({ meal: row.meal, backendIndex: row.promoteBackendIndex as number })),
    ...extraBackendRows.map(row => ({ meal: row.backendMeal, backendIndex: row.index })),
  ].sort((a, b) => a.backendIndex - b.backendIndex);
  const retainedMeals = mergedRows
    .filter(row => row.promoteBackendIndex == null)
    .map(row => row.meal);

  const nextPlan = ensureMealClientKeys({ ...keyedPlan, meals: [...promotedMeals.map(row => row.meal), ...retainedMeals] });
  if (!changed && extraBackendRows.length === 0 && nextPlan === keyedPlan) return keyedPlan;
  return nextPlan;
}

export function inferMealCheckKeyFromHistoryEntry(
  entry: MealHistoryEntryLike,
  plan: DailyNutritionPlan | null | undefined,
  usedKeys: Set<string> = new Set(),
): string | null {
  const keyedPlan = plan ? ensureMealClientKeys(plan) : null;
  const meals = keyedPlan?.meals ?? [];
  if (meals.length === 0) return null;

  const removed = new Set(keyedPlan?.removedMealIds ?? []);
  const available = meals
    .map((meal, index) => {
      const key = mealCheckKey(keyedPlan, meal, index);
      const legacyKey = mealLegacyKey(index);
      return {
        meal,
        index,
        key,
        legacyKey,
        candidates: Array.from(new Set([
          ...explicitMealKeyCandidates(meal),
          ...fallbackMealKeyCandidates(meal, index),
        ])),
      };
    })
    .filter(candidate => (
      !removed.has(candidate.key)
      && !removed.has(candidate.legacyKey)
      && !usedKeys.has(candidate.key)
      && !usedKeys.has(candidate.legacyKey)
    ));
  if (available.length === 0) return null;

  const historyId = Number(entry.id ?? 0);
  if (historyId > 0) {
    const byId = available.find(({ meal }) => Number((meal as any)._loggedMealId ?? 0) === historyId);
    if (byId) return byId.key;
  }

  const clientMealKey = String(entry.client_meal_key ?? '').trim();
  if (clientMealKey) {
    const compactClientMealKey = compactMealKey(clientMealKey);
    const byClientKey = available.find(({ candidates }) => candidates.includes(compactClientMealKey));
    if (byClientKey) return byClientKey.key;
  }

  const entryItemSig = itemSignature(entry.items as Array<Record<string, any>> | null | undefined);
  if (entryItemSig) {
    const byItems = available.find(({ meal }) => itemSignature(mealItems(meal)) === entryItemSig);
    if (byItems) return byItems.key;
  }

  const entryContentSig = historyContentSignature(entry);
  if (entryContentSig) {
    const byContent = available.find(({ meal }) => mealContentSignature(meal) === entryContentSig);
    if (byContent) return byContent.key;
  }

  const entryName = normalizeMealText(entry.name);
  const entryCal = historyCalories(entry);
  if (entryName) {
    const byNameAndCalories = available.find(({ meal }) => (
      normalizeMealText((meal as any).meal ?? (meal as any).name) === entryName
      && Math.abs(mealCalories(meal) - entryCal) <= 10
    ));
    if (byNameAndCalories) return byNameAndCalories.key;
  }

  // Note: previously fell back to a `meal_type` → fixed-index map
  // (breakfast=0, lunch=1, dinner=2, snack=3) for source='generated'
  // entries that had lost their original meal_N key. Removed because
  // it auto-checked the WRONG meal whenever the plan had multiple
  // breakfasts/lunches or names that didn't follow the convention —
  // pinning a routine re-fired this merge and silently logged meal_0
  // and meal_1 every time. Strict id / item-signature / name+cals
  // matching only.
  return null;
}

export function findMealHistoryEntryForSuggestion(
  history: MealHistoryEntryLike[] | null | undefined,
  date: string,
  mealType: string,
  meal: MealSuggestion | null | undefined,
  plan: DailyNutritionPlan | null | undefined,
): MealHistoryEntryLike | null {
  if (!meal || !history?.length) return null;

  const candidates = history.filter(entry => entry.meal_date === date);
  if (candidates.length === 0) return null;

  const mealId = loggedMealIdFromSuggestion(meal);
  if (mealId > 0) {
    const byId = candidates.find(entry => Number(entry.id ?? 0) === mealId);
    if (byId) return byId;
  }

  const clientKey = mealType.trim();
  const targetCheckKey = mealCheckKeyForType(plan, mealType) ?? clientKey;
  if (targetCheckKey) {
    const byClientKey = candidates.filter(entry => compactMealKey(entry.client_meal_key) === compactMealKey(targetCheckKey));
    if (byClientKey.length > 0) return byClientKey[0];
  }

  const byInferredKey = candidates.filter(entry => inferMealCheckKeyFromHistoryEntry(entry, plan) === targetCheckKey);
  if (byInferredKey.length === 1) return byInferredKey[0];

  const targetItemSig = itemSignature(mealItems(meal));
  if (targetItemSig) {
    const byItems = candidates.filter(entry => itemSignature(entry.items as Array<Record<string, any>> | null | undefined) === targetItemSig);
    if (byItems.length === 1) return byItems[0];
  }

  const targetSig = mealSuggestionMergeSignature(meal);
  if (targetSig) {
    const bySuggestionSig = candidates.filter(entry => (
      mealSuggestionMergeSignature({
        meal: entry.name ?? 'Logged meal',
        foods: [],
        items: (entry.items ?? []).map(item => ({
          name: item.food_name ?? item.name ?? 'Item',
          quantity: item.quantity ?? 1,
          unit: item.unit ?? 'serving',
          calories: item.calories ?? 0,
          protein: item.protein_g ?? item.protein ?? 0,
          carbs: item.carbs_g ?? item.carbs ?? 0,
          fat: item.fat_g ?? item.fat ?? 0,
        })) as any,
        calories: historyCalories(entry),
        protein: roundedNumber(entry.totals?.protein_g),
        carbs: roundedNumber(entry.totals?.carbs_g),
        fat: roundedNumber(entry.totals?.fat_g),
      } as MealSuggestion) === targetSig
    ));
    if (bySuggestionSig.length === 1) return bySuggestionSig[0];
  }

  return null;
}

export function inferMealChecksFromHistory(
  history: MealHistoryEntryLike[],
  plansByDate: PlanMap,
  opts: {
    maxDate?: string;
    shouldIncludeEntry?: (entry: MealHistoryEntryLike, inferredKey: string, date: string) => boolean;
  } = {},
): ChecksMap {
  const checksByDate: ChecksMap = {};
  const usedByDate = new Map<string, Set<string>>();

  for (const entry of history) {
    const date = entry.meal_date ?? '';
    if (!date || (opts.maxDate && date > opts.maxDate)) continue;
    const plan = plansByDate[date];
    if (!plan) continue;

    const usedKeys = usedByDate.get(date) ?? new Set<string>();
    const key = inferMealCheckKeyFromHistoryEntry(entry, plan, usedKeys);
    if (!key) continue;
    if (opts.shouldIncludeEntry && !opts.shouldIncludeEntry(entry, key, date)) continue;

    usedKeys.add(key);
    usedByDate.set(date, usedKeys);
    checksByDate[date] = { ...(checksByDate[date] ?? {}), [key]: true };
  }

  return checksByDate;
}

export function mergeMealHistoryIntoChecksByDate(
  checksByDate: ChecksMap,
  plansByDate: PlanMap,
  history: MealHistoryEntryLike[],
  opts: {
    maxDate?: string;
    shouldIncludeEntry?: (entry: MealHistoryEntryLike, inferredKey: string, date: string) => boolean;
  } = {},
): { checksByDate: ChecksMap; changedDates: string[] } {
  const inferred = inferMealChecksFromHistory(history, plansByDate, opts);
  let next = checksByDate;
  const changedDates: string[] = [];

  for (const [date, checks] of Object.entries(inferred)) {
    const current = normalizeMealChecksForPlan(plansByDate[date], next[date] ?? {});
    let dateChecks = current;
    let changed = dateChecks !== (next[date] ?? {});
    for (const [key, checked] of Object.entries(checks)) {
      if (checked && current[key] !== true) {
        if (!changed) dateChecks = { ...current };
        dateChecks[key] = true;
        changed = true;
      }
    }
    if (changed) {
      if (next === checksByDate) next = { ...checksByDate };
      next[date] = dateChecks;
      changedDates.push(date);
    }
  }

  return { checksByDate: next, changedDates };
}
