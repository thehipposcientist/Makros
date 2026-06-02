import React, { useRef, useState } from 'react';
import { Alert } from 'react-native';

import type { DailyNutritionPlan, MealSuggestion, UserProfile } from '../../types';
import { getTheme } from '../../constants/theme';
import { calculateNutritionTargets } from '../../utils/planGenerator';
import MealEditModal from '../MealEditModal';
import RecipeModal from '../RecipeModal';
import AddFromSavedMealSheet from './AddFromSavedMealSheet';
import { MealReviewPromptModal, UnloggedMealsPromptModal, type MealReviewPromptState, type UnloggedPromptState } from './MealCatchupModals';
import NutritionScoreDetailSheet, { type NutritionScoreDetail } from './NutritionScoreDetailSheet';

type ThemeColors = ReturnType<typeof getTheme>['colors'];

type SavedMealReference = {
  id?: number;
  _optimisticId?: number;
  name: string;
  items?: any[];
  total_calories?: number;
  total_protein_g?: number;
  total_carbs_g?: number;
  total_fat_g?: number;
};

type MealEditorTarget = {
  dateKey: string;
  type: string;
  meal: MealSuggestion;
  historyMealId?: number;
  markEatenOnSave?: boolean;
  startWithCamera?: boolean;
  startWithBarcode?: boolean;
} | null;

type RecipeTarget = {
  dateKey: string;
  type: string;
  meal: MealSuggestion;
} | null;

type EditingSavedMeal = {
  id: number;
  name: string;
  items: any[];
} | null;

type Props = {
  authToken?: string | null;
  userProfile: UserProfile;
  themeColors: ThemeColors;
  mealPalette: { strong: string };
  nutritionScoreDetail: NutritionScoreDetail | null;
  onCloseNutritionScoreDetail: () => void;
  addFromSavedDateKey: string | null;
  savedMeals: SavedMealReference[];
  savedMealKey: (saved: SavedMealReference) => string;
  onCloseAddFromSaved: () => void;
  onAddSavedMealToDay: (dateKey: string, saved: SavedMealReference) => Promise<void> | void;
  editingMeal: MealEditorTarget;
  nutritionPlansByDate: Record<string, DailyNutritionPlan>;
  allFoods: any[];
  foodCategories: any;
  favoriteMeals: SavedMealReference[];
  onSaveMeal: (dateKey: string, mealType: string, meal: MealSuggestion, options?: any) => Promise<void> | void;
  onSaveHistoryMeal: (dateKey: string, mealType: string, historyMealId: number, meal: MealSuggestion) => Promise<void> | void;
  onCloseEditingMeal: () => void;
  onToggleMealRoutine: (dateKey: string, mealType: string) => Promise<void> | void;
  onProfileUpdate?: (changes: Partial<UserProfile>, skipRegen?: boolean) => void;
  reloadSavedMeals: () => Promise<void> | void;
  editingSavedMeal: EditingSavedMeal;
  onCloseEditingSavedMeal: () => void;
  onSavedMealTemplateUpdated: (updated: any, previous: SavedMealReference) => Promise<void> | void;
  mealItemMicronutrientSnapshot: (raw: Record<string, any>) => Record<string, number> | undefined;
  recipeTarget: RecipeTarget;
  onCloseRecipe: () => void;
  onPersistRecipe: (dateKey: string, mealType: string, meal: MealSuggestion) => Promise<void> | void;
  mealReviewPrompt: MealReviewPromptState;
  onDismissMealReviewPrompt: () => Promise<void> | void;
  onReviewMealHistoryPrompt: () => Promise<void> | void;
  unloggedPrompt: UnloggedPromptState;
  onDismissUnloggedPrompt: () => Promise<void> | void;
  onAddUnloggedMeal: () => Promise<void> | void;
  onMarkAllUnloggedEaten: () => void;
  onSkipAllUnlogged: () => void;
  onToggleUnloggedMeal: (mealType: string) => void;
  onEditUnloggedMeal: (item: { mealType: string; meal: MealSuggestion }) => Promise<void> | void;
  onSaveUnloggedPrompt: () => void;
};

export default function MealOverlayModals({
  authToken,
  userProfile,
  themeColors,
  mealPalette,
  nutritionScoreDetail,
  onCloseNutritionScoreDetail,
  addFromSavedDateKey,
  savedMeals,
  savedMealKey,
  onCloseAddFromSaved,
  onAddSavedMealToDay,
  editingMeal,
  nutritionPlansByDate,
  allFoods,
  foodCategories,
  favoriteMeals,
  onSaveMeal,
  onSaveHistoryMeal,
  onCloseEditingMeal,
  onToggleMealRoutine,
  onProfileUpdate,
  reloadSavedMeals,
  editingSavedMeal,
  onCloseEditingSavedMeal,
  onSavedMealTemplateUpdated,
  mealItemMicronutrientSnapshot,
  recipeTarget,
  onCloseRecipe,
  onPersistRecipe,
  mealReviewPrompt,
  onDismissMealReviewPrompt,
  onReviewMealHistoryPrompt,
  unloggedPrompt,
  onDismissUnloggedPrompt,
  onAddUnloggedMeal,
  onMarkAllUnloggedEaten,
  onSkipAllUnlogged,
  onToggleUnloggedMeal,
  onEditUnloggedMeal,
  onSaveUnloggedPrompt,
}: Props) {
  // ── Add-from-Favorites in-flight lock ──────────────────────────────────
  // Stored as both a ref (for the synchronous double-tap guard) AND state
  // (so the sheet can show "Adding…" on the in-flight row + dim the rest).
  // We capture the date AT TAP TIME and keep the sheet open until the
  // parent's async insert resolves, so a slow add never lands on a day
  // the user has since switched away from.
  const addFromSavedPendingRef = useRef<string | null>(null);
  const [addFromSavedPendingKey, setAddFromSavedPendingKey] = useState<string | null>(null);

  const handleSelectSavedMeal = async (dateAtTap: string, saved: SavedMealReference) => {
    const rowKey = savedMealKey(saved);
    // Synchronous lock: a double-tap that lands before React commits
    // the pending state would otherwise fire twice.
    if (addFromSavedPendingRef.current) return;
    addFromSavedPendingRef.current = rowKey;
    setAddFromSavedPendingKey(rowKey);
    try {
      // Pass dateAtTap explicitly — never read the sheet's `dateKey`
      // prop here, which can flip if the parent re-renders mid-flight.
      await onAddSavedMealToDay(dateAtTap, saved);
      import('../../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
      onCloseAddFromSaved();
    } catch (e: any) {
      Alert.alert('Could not add meal', String(e?.message ?? e));
    } finally {
      addFromSavedPendingRef.current = null;
      setAddFromSavedPendingKey(null);
    }
  };

  return (
    <>
      <NutritionScoreDetailSheet
        detail={nutritionScoreDetail}
        colors={themeColors}
        onClose={onCloseNutritionScoreDetail}
      />

      <AddFromSavedMealSheet
        dateKey={authToken ? addFromSavedDateKey : null}
        savedMeals={savedMeals}
        themeColors={themeColors}
        savedMealKey={savedMealKey}
        pendingSavedKey={addFromSavedPendingKey}
        onClose={() => {
          if (addFromSavedPendingRef.current) return;
          onCloseAddFromSaved();
        }}
        onSelect={handleSelectSavedMeal}
      />

      {editingMeal && (
        <EditableMealSheet
          authToken={authToken}
          userProfile={userProfile}
          editingMeal={editingMeal}
          nutritionPlansByDate={nutritionPlansByDate}
          allFoods={allFoods}
          foodCategories={foodCategories}
          favoriteMeals={favoriteMeals}
          onSaveMeal={onSaveMeal}
          onSaveHistoryMeal={onSaveHistoryMeal}
          onClose={onCloseEditingMeal}
          onToggleRoutine={onToggleMealRoutine}
          onProfileUpdate={onProfileUpdate}
          reloadSavedMeals={reloadSavedMeals}
        />
      )}

      {editingSavedMeal && (
        <SavedMealTemplateEditor
          authToken={authToken}
          userProfile={userProfile}
          editingSavedMeal={editingSavedMeal}
          allFoods={allFoods}
          foodCategories={foodCategories}
          mealItemMicronutrientSnapshot={mealItemMicronutrientSnapshot}
          onClose={onCloseEditingSavedMeal}
          onSavedMealTemplateUpdated={onSavedMealTemplateUpdated}
          reloadSavedMeals={reloadSavedMeals}
        />
      )}

      <RecipeModal
        visible={!!recipeTarget}
        meal={recipeTarget?.meal ?? null}
        authToken={authToken ?? undefined}
        themeName={userProfile.themePreference}
        cookingSkill={userProfile.cookingSkill}
        prepTimeMinutes={userProfile.prepTimeMinutes}
        dietaryPreference={userProfile.dietaryPreference}
        allergies={userProfile.allergies}
        onClose={onCloseRecipe}
        onPersist={(updated) => {
          if (!recipeTarget) return;
          onPersistRecipe(recipeTarget.dateKey, recipeTarget.type, updated);
        }}
      />

      <MealReviewPromptModal
        prompt={mealReviewPrompt}
        themeColors={themeColors}
        onDismiss={onDismissMealReviewPrompt}
        onReviewHistory={onReviewMealHistoryPrompt}
      />

      <UnloggedMealsPromptModal
        prompt={unloggedPrompt}
        themeColors={themeColors}
        mealPalette={mealPalette}
        onDismiss={onDismissUnloggedPrompt}
        onAddMeal={onAddUnloggedMeal}
        onMarkAllEaten={onMarkAllUnloggedEaten}
        onSkipAll={onSkipAllUnlogged}
        onToggleMeal={onToggleUnloggedMeal}
        onEditMeal={onEditUnloggedMeal}
        onSave={onSaveUnloggedPrompt}
      />
    </>
  );
}

function EditableMealSheet({
  authToken,
  userProfile,
  editingMeal,
  nutritionPlansByDate,
  allFoods,
  foodCategories,
  favoriteMeals,
  onSaveMeal,
  onSaveHistoryMeal,
  onClose,
  onToggleRoutine,
  onProfileUpdate,
  reloadSavedMeals,
}: {
  authToken?: string | null;
  userProfile: UserProfile;
  editingMeal: NonNullable<MealEditorTarget>;
  nutritionPlansByDate: Record<string, DailyNutritionPlan>;
  allFoods: any[];
  foodCategories: any;
  favoriteMeals: SavedMealReference[];
  onSaveMeal: Props['onSaveMeal'];
  onSaveHistoryMeal: Props['onSaveHistoryMeal'];
  onClose: () => void;
  onToggleRoutine: Props['onToggleMealRoutine'];
  onProfileUpdate?: Props['onProfileUpdate'];
  reloadSavedMeals: Props['reloadSavedMeals'];
}) {
  const fallbackTargets = calculateNutritionTargets(userProfile);
  const rawPlan = nutritionPlansByDate[editingMeal.dateKey]
    ?? { meals: [], removedMealIds: [], targets: fallbackTargets } as DailyNutritionPlan;
  const t = rawPlan.targets;
  const modalNutritionPlan: DailyNutritionPlan = (!t || (t.calories ?? 0) <= 0)
    ? { ...rawPlan, targets: fallbackTargets }
    : rawPlan;

  return (
    <MealEditModal
      visible
      mealType={editingMeal.type}
      meal={editingMeal.meal}
      dateKey={editingMeal.dateKey}
      themeName={userProfile.themePreference}
      nutritionPlan={modalNutritionPlan}
      allFoods={allFoods}
      foodCategories={foodCategories}
      savedMeals={userProfile.savedMeals ?? []}
      favoriteMeals={favoriteMeals as any}
      authToken={authToken ?? undefined}
      cookingSkill={userProfile.cookingSkill}
      prepTimeMinutes={userProfile.prepTimeMinutes}
      dietaryPreference={userProfile.dietaryPreference}
      allergies={userProfile.allergies}
      autoOpenFoodCamera={editingMeal.startWithCamera === true}
      autoOpenBarcodeScanner={editingMeal.startWithBarcode === true}
      // The modal awaits these; bubble parent errors so it can keep
      // the editor open and surface an alert. Capturing dateKey/type
      // from `editingMeal` at invocation time (not from a closure that
      // might mutate after an async boundary) is the whole point of
      // routing through MealOverlayModals — the parent receives the
      // EXACT identity the user tapped.
      onSave={async (updated) => {
        if (editingMeal.historyMealId) {
          await onSaveHistoryMeal(editingMeal.dateKey, editingMeal.type, editingMeal.historyMealId, updated);
        } else {
          await onSaveMeal(editingMeal.dateKey, editingMeal.type, updated, { markEaten: editingMeal.markEatenOnSave });
        }
      }}
      onSaveRoutine={editingMeal.historyMealId ? undefined : (async (updated, scope) => {
        await onSaveMeal(editingMeal.dateKey, editingMeal.type, updated, { routineScope: scope, markEaten: editingMeal.markEatenOnSave });
      })}
      onClose={onClose}
      onToggleRoutine={editingMeal.historyMealId ? undefined : (() => onToggleRoutine(editingMeal.dateKey, editingMeal.type))}
      onSaveAsMeal={async (draft) => {
        // IMPORTANT: read `draft` (passed from MealEditModal's current
        // state) — NOT `editingMeal.meal`, which is the original prop
        // and stale by the time the user has edited foods/name/etc.
        // The modal already builds `draft` via its own `buildDraftFromState`
        // so what we save IS what the user sees on screen.
        if (!authToken || !editingMeal) {
          throw new Error('Sign in to save favorites.');
        }
        const byName = new Map<string, any>();
        for (const f of allFoods ?? []) {
          const k = (f.name || '').toLowerCase().trim();
          if (k) byName.set(k, f);
        }
        const items = (draft.items ?? []).map((it: any) => {
          const name = String(it.name || it.food_name || 'Item');
          const libMatch = byName.get(name.toLowerCase().trim());
          return {
            food_name: name,
            food_id: it.food_id ?? libMatch?.id ?? libMatch?.food_id ?? null,
            serving_id: it.serving_id ?? null,
            serving_grams: it.serving_grams ?? null,
            source: it.source ?? null,
            fdc_id: it.fdc_id ?? it.external_id ?? null,
            external_id: it.external_id ?? it.fdc_id ?? null,
            barcode: it.barcode ?? null,
            brand: it.brand ?? null,
            is_verified: it.is_verified ?? null,
            quantity: Number(it.quantity || it.qty || 1),
            unit: String(it.unit || 'serving'),
            calories: Number(it.calories || 0),
            protein_g: Number(it.protein_g ?? it.protein ?? 0),
            carbs_g: Number(it.carbs_g ?? it.carbs ?? 0),
            fat_g: Number(it.fat_g ?? it.fat ?? 0),
            ...(it.micronutrients ? { micronutrients: it.micronutrients } : {}),
          };
        });
        if (items.length === 0) {
          // Modal already pre-checks this, but defend the API boundary too.
          throw new Error('Add some foods first, then save as a favorite.');
        }
        const { createSavedMeal } = await import('../../services/api');
        const { newIdempotencyKey } = await import('../../services/mealMutationKeys');
        // Backend collapses retried POSTs with this token via the
        // partial unique index uq_saved_meals_user_idempotency_key, so
        // a network-layer retry + the modal's savingFavoriteRef lock
        // together guarantee one row per tap.
        await createSavedMeal(authToken, {
          name: (draft.meal || (draft as any).name || 'My saved meal'),
          items: items as any,
          idempotency_key: newIdempotencyKey('fav'),
        });
        await reloadSavedMeals();
        Alert.alert('Saved', 'You can log this meal again from Foods → Saved Meals, or the "From saved" button on any day card.');
      }}
      onAddCustomFood={(item) => {
        const existing = userProfile?.customFoods ?? [];
        const customExists = existing.some(f => f.name.toLowerCase() === item.name.toLowerCase());
        const nextCustomFoods = customExists ? existing : [...existing, item];
        const existingKitchen = userProfile?.foodsAvailable ?? [];
        const kitchenExists = existingKitchen.some(name => name.toLowerCase() === item.name.toLowerCase());
        const nextFoodsAvailable = kitchenExists ? existingKitchen : [...existingKitchen, item.name];
        if (customExists && kitchenExists) return;
        onProfileUpdate?.({
          customFoods: nextCustomFoods,
          foodsAvailable: nextFoodsAvailable,
        } as any, true);
      }}
    />
  );
}

function SavedMealTemplateEditor({
  authToken,
  userProfile,
  editingSavedMeal,
  allFoods,
  foodCategories,
  mealItemMicronutrientSnapshot,
  onClose,
  onSavedMealTemplateUpdated,
  reloadSavedMeals,
}: {
  authToken?: string | null;
  userProfile: UserProfile;
  editingSavedMeal: NonNullable<EditingSavedMeal>;
  allFoods: any[];
  foodCategories: any;
  mealItemMicronutrientSnapshot: Props['mealItemMicronutrientSnapshot'];
  onClose: () => void;
  onSavedMealTemplateUpdated: Props['onSavedMealTemplateUpdated'];
  reloadSavedMeals: Props['reloadSavedMeals'];
}) {
  const mappedItems = (editingSavedMeal.items || []).map((it: any) => {
    const qty = Number(it.quantity || 1);
    const cal = Number(it.calories || 0);
    const pro = Number(it.protein_g || it.protein || 0);
    const carbs = Number(it.carbs_g || it.carbs || 0);
    const fat = Number(it.fat_g || it.fat || 0);
    const micronutrients = mealItemMicronutrientSnapshot(it);
    return {
      name: String(it.food_name || it.name || 'Item'),
      food_id: it.food_id ?? null,
      serving_id: it.serving_id ?? null,
      serving_grams: it.serving_grams ?? null,
      quantity: qty,
      unit: String(it.unit || 'serving'),
      calories: cal,
      protein: pro,
      carbs,
      fat,
      baseQuantity: qty > 0 ? qty : 1,
      baseCalories: cal,
      baseProtein: pro,
      baseCarbs: carbs,
      baseFat: fat,
      ...(micronutrients ? { micronutrients } : {}),
    };
  });
  const totals = mappedItems.reduce(
    (acc: any, it: any) => ({
      calories: acc.calories + (it.calories || 0),
      protein: acc.protein + (it.protein || 0),
      carbs: acc.carbs + (it.carbs || 0),
      fat: acc.fat + (it.fat || 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0 },
  );
  const scaffoldMeal = {
    meal: editingSavedMeal.name,
    items: mappedItems as any,
    foods: mappedItems.map((i: any) => i.name),
    amounts: mappedItems.map((i: any) => `${i.quantity} ${i.unit}`),
    ...totals,
  };
  const scaffoldPlan = {
    targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    meals: [scaffoldMeal],
  } as any;

  return (
    <MealEditModal
      visible
      mealType="meal_0"
      meal={scaffoldMeal as any}
      dateKey={undefined}
      themeName={userProfile.themePreference}
      nutritionPlan={scaffoldPlan}
      allFoods={allFoods}
      foodCategories={foodCategories}
      savedMeals={[]}
      authToken={authToken ?? undefined}
      mode="template"
      cookingSkill={userProfile.cookingSkill}
      prepTimeMinutes={userProfile.prepTimeMinutes}
      dietaryPreference={userProfile.dietaryPreference}
      allergies={userProfile.allergies}
      onClose={onClose}
      onSave={async (updated) => {
        const items = (updated.items ?? []).map((it: any) => ({
          food_name: it.name || 'Item',
          food_id: it.food_id ?? null,
          serving_id: it.serving_id ?? null,
          serving_grams: it.serving_grams ?? null,
          source: it.source ?? null,
          fdc_id: it.fdc_id ?? it.external_id ?? null,
          external_id: it.external_id ?? it.fdc_id ?? null,
          barcode: it.barcode ?? null,
          brand: it.brand ?? null,
          is_verified: it.is_verified ?? null,
          quantity: Number(it.quantity || 1),
          unit: String(it.unit || 'serving'),
          calories: Number(it.calories || 0),
          protein_g: Number(it.protein || 0),
          carbs_g: Number(it.carbs || 0),
          fat_g: Number(it.fat || 0),
          ...(it.micronutrients ? { micronutrients: it.micronutrients } : {}),
        }));
        try {
          const { updateSavedMeal } = await import('../../services/api');
          const updatedTemplate = await updateSavedMeal(authToken!, editingSavedMeal.id, {
            name: updated.meal || editingSavedMeal.name,
            items: items as any,
          });
          await onSavedMealTemplateUpdated(updatedTemplate, editingSavedMeal);
          reloadSavedMeals();
          onClose();
          Alert.alert('Updated', 'Favorite updated for future logs. Meals already logged stay unchanged.');
        } catch (e: any) {
          Alert.alert('Could not update', String(e?.message ?? e));
        }
      }}
    />
  );
}
