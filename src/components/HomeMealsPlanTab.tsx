import React, { memo, useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import type { DailyNutritionPlan, MealSuggestion, UserProfile } from '../types';
import FadeInView from './FadeInView';
import IncompleteDayBanner from './IncompleteDayBanner';
import MacroDonutRow from './MacroDonutRow';
import MacroBreakdownSheet, { type MacroKey } from './MacroBreakdownSheet';
import NutritionCard from './NutritionCard';
import PressableScale from './PressableScale';
import SavedMealsSection from './SavedMealsSection';
import { overPhotoTextShadow } from './PhotoScrim';
import { getContrastingTextColor } from '../constants/theme';
import { hydrationTargetRangeOz } from '../utils/hydration';
import { macroTotalsFromMeal } from '../utils/mealItems';
import { mealCheckKey, mergeBackendMealSuggestionsIntoPlan, resolveMealIndex } from '../utils/mealPlanState';
import { todayKey } from '../utils/workoutHistory';
import { mealCardBackgroundSource } from '../utils/mealCardBackground';
import {
  darkPhotoBaseForColors,
  darkPhotoHueOverlayColor,
  darkPhotoOverlayColors,
  lightPhotoOverlayColors,
  lightPhotoPanelChrome,
  photoBottomFadeStops,
} from '../utils/photoCardChrome';
import {
  DailyTargetAdjustmentBanner,
  HydrationTodayPanel,
  buildDailyTargetAdjustmentBanner,
} from './meals/MealTargetPanels';
import styles from '../screens/meals/mealScreenStyles';

type MealDay = {
  key: string;
  date: Date;
};

type WeekStripItem = {
  key: string;
  date: Date;
  title: string;
  state: 'done' | 'logged' | 'skipped' | 'rest' | 'today' | 'planned';
};

const USE_LIGHT_PHOTO_PANELS: boolean = false;

type HomeMealsPlanTabProps = {
  authToken?: string | null;
  userProfile: UserProfile;
  mealDays: MealDay[];
  selectedMealDayKey: string;
  checkedMealsByDate: Record<string, Record<string, boolean>>;
  backendMealDailyByDate: Map<string, any>;
  backendMealSuggestionsByDate: Map<string, MealSuggestion[]>;
  mealHistoryLoading: boolean;
  visualHydrating?: boolean;
  nutritionPlansByDate: Record<string, DailyNutritionPlan>;
  planWeek: any;
  isFreeTier: boolean;
  isLightTheme: boolean;
  themeColors: any;
  mealPalette: { strong: string; soft?: string };
  mealPlanCardRefs: React.MutableRefObject<Record<string, View | null>>;
  projectedNutritionScoreByDate: Map<string, any>;
  adjustedDailyTarget: any;
  adjustedDailyTargetsByDate?: Record<string, any>;
  hydrationByDate: Record<string, any>;
  hydration: any;
  hydrationLoading: boolean;
  mealGenerationByDate: Record<string, 'replace' | 'fill'>;
  savedMealNames: Set<string>;
  savedMealsRefreshKey: number;
  todayCollagenG: number | null;
  todayProbioticCfu: number | null;
  todayPrebioticG: number | null;
  proteinBreakdown: any;
  todaySupplementMicros: any;
  nutritionScoreUpdating: boolean;
  dayNames: string[];
  mealsAccent: string;
  WeekStripComponent: React.ComponentType<{
    items: WeekStripItem[];
    selectedKey: string;
    accent: string;
    colors: any;
    label: string;
    doneTone?: 'accent' | 'success';
    onSelect: (key: string) => void;
  }>;
  mealDayLabel: (date: Date, index: number) => string;
  onSelectMealDay: (dayKey: string) => void;
  refreshHydration: (dayKey?: string) => Promise<any>;
  selectMealsSubTab: (tab: 'plan' | 'foods' | 'supplements' | 'macros' | 'history') => void;
  setMealsSubTab: (tab: 'plan' | 'foods' | 'supplements' | 'macros' | 'history') => void;
  handleAddSnack: (dateKey: string) => void;
  handleGenerateToday: (dateKey: string) => void;
  handleFillGaps: (dateKey: string) => void;
  handleToggleMeal: (dateKey: string, mealType: string) => void;
  setEditingMeal: (value: { dateKey: string; type: string; meal: MealSuggestion; historyMealId?: number } | null) => void;
  handleBackendMealDelete: (dateKey: string, mealId: number, meal: MealSuggestion, mealType?: string) => void;
  handleRemoveMeal: (dateKey: string, mealType: string) => void;
  handleRestoreMeal: (dateKey: string, mealType: string) => void;
  handleHardDeleteMeal: (dateKey: string, mealType: string) => void;
  handleToggleRoutine: (dateKey: string, mealType: string) => void;
  setRecipeTarget: (value: { dateKey: string; type: string; meal: MealSuggestion } | null) => void;
  handleMoveMeal: (dateKey: string, mealType: string, direction: -1 | 1) => void;
  handleDuplicateMeal: (dateKey: string, mealType: string, meal?: MealSuggestion) => void;
  handleSplitMeal: (dateKey: string, mealType: string, meal?: MealSuggestion) => void;
  openAddFromSavedForDate: (dateKey: string) => void;
  handleToggleSaveMeal: (...args: any[]) => void;
  scrollSubTabNodeToTop: (node: any) => void;
  handleHydrationDelta: (deltaOz: number, dateKey: string) => void;
  handleHydrationSet: (ounces: number, dateKey: string) => void;
  onSavedMealLogged: (log: any) => Promise<void>;
  onSavedMealChanged?: (change?: { action?: 'deleted'; mealId?: number }) => Promise<void> | void;
  reloadSavedMeals: () => Promise<void>;
  handleSavedMealTemplateUpdated: (...args: any[]) => void;
  onEditSavedMealTemplate: (savedMeal: any) => void;
};

function HomeMealsPlanTabInner({
  authToken,
  userProfile,
  mealDays,
  selectedMealDayKey,
  checkedMealsByDate,
  backendMealDailyByDate,
  backendMealSuggestionsByDate,
  mealHistoryLoading,
  visualHydrating = false,
  nutritionPlansByDate,
  planWeek,
  isFreeTier,
  isLightTheme,
  themeColors,
  mealPalette,
  mealPlanCardRefs,
  projectedNutritionScoreByDate,
  adjustedDailyTarget,
  adjustedDailyTargetsByDate,
  hydrationByDate,
  hydration,
  hydrationLoading,
  mealGenerationByDate,
  savedMealNames,
  savedMealsRefreshKey,
  todayCollagenG,
  todayProbioticCfu,
  todayPrebioticG,
  proteinBreakdown,
  todaySupplementMicros,
  nutritionScoreUpdating,
  dayNames,
  mealsAccent,
  WeekStripComponent,
  mealDayLabel,
  onSelectMealDay,
  refreshHydration,
  selectMealsSubTab,
  setMealsSubTab,
  handleAddSnack,
  handleGenerateToday,
  handleFillGaps,
  handleToggleMeal,
  setEditingMeal,
  handleBackendMealDelete,
  handleRemoveMeal,
  handleRestoreMeal,
  handleHardDeleteMeal,
  handleToggleRoutine,
  setRecipeTarget,
  handleMoveMeal,
  handleDuplicateMeal,
  handleSplitMeal,
  openAddFromSavedForDate,
  handleToggleSaveMeal,
  scrollSubTabNodeToTop,
  handleHydrationDelta,
  handleHydrationSet,
  onSavedMealLogged,
  onSavedMealChanged,
  reloadSavedMeals,
  handleSavedMealTemplateUpdated,
  onEditSavedMealTemplate,
}: HomeMealsPlanTabProps) {
  const weekMealDays = useMemo(
    () => [...mealDays].sort((a, b) => a.date.getTime() - b.date.getTime()),
    [mealDays],
  );
  const todayMealDay = useMemo(
    () => weekMealDays.find(d => d.key === todayKey()),
    [weekMealDays],
  );
  const selectedMealKey = useMemo(
    () => weekMealDays.some(d => d.key === selectedMealDayKey)
      ? selectedMealDayKey
      : (todayMealDay?.key ?? weekMealDays[0]?.key ?? todayKey()),
    [selectedMealDayKey, todayMealDay?.key, weekMealDays],
  );
  const selectedMealDay = useMemo(
    () => weekMealDays.find(d => d.key === selectedMealKey) ?? null,
    [selectedMealKey, weekMealDays],
  );
  const orderedMealDays = useMemo(
    () => selectedMealDay ? [selectedMealDay] : [],
    [selectedMealDay],
  );
  const mealWeekItems = useMemo<WeekStripItem[]>(() => (
    weekMealDays.map(day => {
      const checks = checkedMealsByDate[day.key] ?? {};
      const checkedCount = Object.values(checks).filter(Boolean).length;
      const backendLoggedCount = backendMealDailyByDate.get(day.key)?.meal_count ?? 0;
      const loggedCount = Math.max(checkedCount, backendLoggedCount);
      const isPast = day.date < new Date(new Date().setHours(0, 0, 0, 0));
      return {
        key: day.key,
        date: day.date,
        title: day.key === todayKey() ? 'Today’s meals' : `${dayNames[day.date.getDay()]} meals`,
        state: loggedCount > 0 ? 'logged' : isPast ? 'skipped' : day.key === todayKey() ? 'today' : 'planned',
      };
    })
  ), [backendMealDailyByDate, checkedMealsByDate, dayNames, weekMealDays]);

  const handleSelectDay = useCallback((dayKey: string) => {
    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
    onSelectMealDay(dayKey);
    refreshHydration(dayKey).catch(() => {});
  }, [onSelectMealDay, refreshHydration]);

  if (visualHydrating) {
    return (
      <View
        testID="meal-plan-hydrating"
        style={{
          minHeight: 240,
          borderRadius: 14,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: themeColors.border,
          backgroundColor: themeColors.surface,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          gap: 10,
        }}>
        <ActivityIndicator size="small" color={mealPalette.strong} />
        <Text style={{ color: themeColors.textSecondary, fontSize: 12, fontWeight: '700' }}>
          Syncing meals...
        </Text>
      </View>
    );
  }

  return (
    <>
      <WeekStripComponent
        items={mealWeekItems}
        selectedKey={selectedMealKey}
        accent={mealsAccent}
        colors={themeColors}
        label="Meal week"
        onSelect={handleSelectDay}
      />
      <View style={styles.labeledActionRow}>
        <TouchableOpacity
          testID="meal-action-edit-plan"
          accessibilityLabel="Edit meal plan"
          onPress={() => selectMealsSubTab('foods')}
          activeOpacity={0.75}
          style={[styles.labeledActionBtn, { backgroundColor: mealPalette.strong + (isLightTheme ? '10' : '14'), borderColor: mealPalette.strong + '3D', shadowColor: mealPalette.strong }]}>
          <LinearGradient
            pointerEvents="none"
            colors={[mealPalette.strong + '24', themeColors.surface + '00'] as any}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.labeledActionGlow}
          />
          <Ionicons name="create-outline" size={14} color={mealPalette.strong} />
          <Text style={[styles.labeledActionText, { color: themeColors.textPrimary }]}>Edit Plan</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="meal-action-history"
          accessibilityLabel="Open meal history"
          onPress={() => selectMealsSubTab('history')}
          activeOpacity={0.75}
          style={[styles.labeledActionBtn, { backgroundColor: mealPalette.strong + (isLightTheme ? '0D' : '12'), borderColor: mealPalette.strong + '33', shadowColor: mealPalette.strong }]}>
          <LinearGradient
            pointerEvents="none"
            colors={[mealPalette.strong + '20', themeColors.surface + '00'] as any}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.labeledActionGlow}
          />
          <View style={{ width: 14, height: 14, alignItems: 'center', justifyContent: 'center' }}>
            {mealHistoryLoading ? (
              <ActivityIndicator size="small" color={mealPalette.strong} style={{ transform: [{ scale: 0.65 }] }} />
            ) : (
              <Ionicons name="time-outline" size={14} color={mealPalette.strong} />
            )}
          </View>
          <Text style={[styles.labeledActionText, { color: themeColors.textPrimary }]}>History</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="meal-action-supplements"
          accessibilityLabel="Open supplement stack"
          onPress={() => selectMealsSubTab('supplements')}
          activeOpacity={0.75}
          style={[styles.labeledActionBtn, { backgroundColor: mealPalette.strong + (isLightTheme ? '0D' : '12'), borderColor: mealPalette.strong + '33', shadowColor: mealPalette.strong }]}>
          <LinearGradient
            pointerEvents="none"
            colors={[mealPalette.strong + '20', themeColors.surface + '00'] as any}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.labeledActionGlow}
          />
          <Ionicons name="medical-outline" size={14} color={mealPalette.strong} />
          <Text style={[styles.labeledActionText, { color: themeColors.textPrimary }]}>Supplements</Text>
        </TouchableOpacity>
      </View>
      {orderedMealDays.map((day, idx) => (
        <HomeMealsPlanDayCard
          key={day.key}
          day={day}
          index={idx}
          authToken={authToken}
          userProfile={userProfile}
          nutritionPlansByDate={nutritionPlansByDate}
          planWeek={planWeek}
          isFreeTier={isFreeTier}
          isLightTheme={isLightTheme}
          themeColors={themeColors}
          mealPalette={mealPalette}
          mealPlanCardRefs={mealPlanCardRefs}
          backendMealSuggestionsByDate={backendMealSuggestionsByDate}
          checkedMealsByDate={checkedMealsByDate}
          backendMealDailyByDate={backendMealDailyByDate}
          projectedNutritionScoreByDate={projectedNutritionScoreByDate}
          adjustedDailyTarget={adjustedDailyTarget}
          adjustedDailyTargetsByDate={adjustedDailyTargetsByDate}
          hydrationByDate={hydrationByDate}
          hydration={hydration}
          hydrationLoading={hydrationLoading}
          mealGenerationByDate={mealGenerationByDate}
          savedMealNames={savedMealNames}
          savedMealsRefreshKey={savedMealsRefreshKey}
          todayCollagenG={todayCollagenG}
          todayProbioticCfu={todayProbioticCfu}
          todayPrebioticG={todayPrebioticG}
          proteinBreakdown={proteinBreakdown}
          todaySupplementMicros={todaySupplementMicros}
          nutritionScoreUpdating={nutritionScoreUpdating}
          mealsAccent={mealsAccent}
          todayMealDay={todayMealDay}
          firstMealDayKey={mealDays[0]?.key}
          mealDayLabel={mealDayLabel}
          setMealsSubTab={setMealsSubTab}
          handleAddSnack={handleAddSnack}
          handleGenerateToday={handleGenerateToday}
          handleFillGaps={handleFillGaps}
          handleToggleMeal={handleToggleMeal}
          setEditingMeal={setEditingMeal}
          handleBackendMealDelete={handleBackendMealDelete}
          handleRemoveMeal={handleRemoveMeal}
          handleRestoreMeal={handleRestoreMeal}
          handleHardDeleteMeal={handleHardDeleteMeal}
          handleToggleRoutine={handleToggleRoutine}
          setRecipeTarget={setRecipeTarget}
          handleMoveMeal={handleMoveMeal}
          handleDuplicateMeal={handleDuplicateMeal}
          handleSplitMeal={handleSplitMeal}
          openAddFromSavedForDate={openAddFromSavedForDate}
          handleToggleSaveMeal={handleToggleSaveMeal}
          scrollSubTabNodeToTop={scrollSubTabNodeToTop}
          handleHydrationDelta={handleHydrationDelta}
          handleHydrationSet={handleHydrationSet}
          onSavedMealLogged={onSavedMealLogged}
          onSavedMealChanged={onSavedMealChanged}
          reloadSavedMeals={reloadSavedMeals}
          handleSavedMealTemplateUpdated={handleSavedMealTemplateUpdated}
          onEditSavedMealTemplate={onEditSavedMealTemplate}
        />
      ))}
    </>
  );
}

type HomeMealsPlanDayCardProps = Omit<
  HomeMealsPlanTabProps,
  | 'mealDays'
  | 'selectedMealDayKey'
  | 'WeekStripComponent'
  | 'dayNames'
  | 'mealHistoryLoading'
  | 'onSelectMealDay'
  | 'refreshHydration'
  | 'selectMealsSubTab'
> & {
  day: MealDay;
  index: number;
  todayMealDay?: MealDay | null;
  firstMealDayKey?: string;
};

function HomeMealsPlanDayCardInner({
  day,
  index,
  authToken,
  userProfile,
  nutritionPlansByDate,
  planWeek,
  isFreeTier,
  isLightTheme,
  themeColors,
  mealPalette,
  mealPlanCardRefs,
  backendMealSuggestionsByDate,
  checkedMealsByDate,
  backendMealDailyByDate,
  projectedNutritionScoreByDate,
  adjustedDailyTarget,
  adjustedDailyTargetsByDate,
  hydrationByDate,
  hydration,
  hydrationLoading,
  mealGenerationByDate,
  savedMealNames,
  savedMealsRefreshKey,
  todayCollagenG,
  todayProbioticCfu,
  todayPrebioticG,
  proteinBreakdown,
  todaySupplementMicros,
  nutritionScoreUpdating,
  mealsAccent,
  todayMealDay,
  firstMealDayKey,
  mealDayLabel,
  setMealsSubTab,
  handleAddSnack,
  handleGenerateToday,
  handleFillGaps,
  handleToggleMeal,
  setEditingMeal,
  handleBackendMealDelete,
  handleRemoveMeal,
  handleRestoreMeal,
  handleHardDeleteMeal,
  handleToggleRoutine,
  setRecipeTarget,
  handleMoveMeal,
  handleDuplicateMeal,
  handleSplitMeal,
  openAddFromSavedForDate,
  handleToggleSaveMeal,
  scrollSubTabNodeToTop,
  handleHydrationDelta,
  handleHydrationSet,
  onSavedMealLogged,
  onSavedMealChanged,
  reloadSavedMeals,
  handleSavedMealTemplateUpdated,
  onEditSavedMealTemplate,
}: HomeMealsPlanDayCardProps) {
  const [macroBreakdown, setMacroBreakdown] = useState<MacroKey | null>(null);
  let plan = nutritionPlansByDate[day.key];
  if (!plan && planWeek?.days?.length) {
    const pd = planWeek.days.find((pdi: any) => pdi.day_date === day.key);
    if (pd?.nutrition) plan = pd.nutrition as any;
  }
  if (!plan && isFreeTier) {
    plan = {
      meals: [],
      removedMealIds: [],
      targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    } as any;
  }

  const isToday = day.key === todayKey();
  const isPast = day.date < new Date(new Date().setHours(0, 0, 0, 0));
  const backendMealsForDay = backendMealSuggestionsByDate.get(day.key) ?? [];
  const historyBackedMealPlan = isPast && backendMealsForDay.length > 0;

  if (!plan && historyBackedMealPlan) {
    plan = {
      meals: backendMealsForDay,
      removedMealIds: [],
      targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    } as any;
  } else if (plan && historyBackedMealPlan) {
    plan = {
      ...plan,
      meals: backendMealsForDay,
      removedMealIds: [],
    };
  } else if (!isPast && plan) {
    plan = mergeBackendMealSuggestionsIntoPlan(plan, backendMealsForDay);
  } else if (!isPast && !plan) {
    plan = {
      meals: backendMealsForDay,
      removedMealIds: [],
      targets: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    } as any;
  }

  if (!plan) {
    return (
      <FadeInView delay={index * 60}>
        <View style={{ height: 60, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="small" color={themeColors.textMuted} />
        </View>
      </FadeInView>
    );
  }

  const dayChecks = checkedMealsByDate[day.key] ?? {};
  const checkedCount = Object.values(dayChecks).filter(Boolean).length;
  const backendLoggedCount = backendMealDailyByDate.get(day.key)?.meal_count ?? 0;
  const displayLoggedCount = Math.max(checkedCount, backendLoggedCount);
  const isPastLogged = isPast && displayLoggedCount > 0;
  const isPastSkipped = isPast && displayLoggedCount === 0;
  const authoritativeNutritionScore = projectedNutritionScoreByDate.get(day.key);
  const removedSet = new Set(plan.removedMealIds ?? []);
  const planMeals = plan.meals ?? [];
  const meals = planMeals.filter((meal, i) => !removedSet.has(`meal_${i}`) && !removedSet.has(mealCheckKey(plan, meal, i)));
  const isEmptyMealDay = meals.length === 0;
  const mealChecksForDisplay = historyBackedMealPlan
    ? Object.fromEntries((plan.meals ?? []).map((_, i) => [`meal_${i}`, true]))
    : (checkedMealsByDate[day.key] ?? {});

  let totalCalories = 0, totalProtein = 0, totalCarbs = 0, totalFat = 0;
  for (const meal of meals) {
    const macros = macroTotalsFromMeal(meal);
    totalCalories += macros.calories;
    totalProtein += macros.protein;
    totalCarbs += macros.carbs;
    totalFat += macros.fat;
  }

  const adjustedTargetForDay = adjustedDailyTargetsByDate?.[day.key] ?? (isToday ? adjustedDailyTarget : null);
  const liveAdjustedMacros = adjustedTargetForDay?.adjusted_macros ?? null;
  const planForDisplay = liveAdjustedMacros && adjustedTargetForDay
    ? {
      ...plan,
      targets: {
        ...(plan.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 }),
        calories: adjustedTargetForDay.adjusted_calories,
        protein: liveAdjustedMacros.protein_g,
        carbs: liveAdjustedMacros.carbs_g,
        fat: liveAdjustedMacros.fat_g,
      },
      _liveTargets: {
        source: 'activity_and_weekly_budget',
        activity_adjustment_kcal: adjustedTargetForDay.activity_adjustment_applied ?? adjustedTargetForDay.activity_adjustment_kcal ?? 0,
        weekly_adjustment_kcal: adjustedTargetForDay.weekly_adjustment_applied ?? adjustedTargetForDay.adjustment_applied,
      },
    } as DailyNutritionPlan
    : plan;
  const t = planForDisplay.targets ?? { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const mealCardBackground = mealCardBackgroundSource(planForDisplay, day.key, userProfile.dietaryPreference);
  const mealPhotoTone: 'dark' | 'light' = isLightTheme && USE_LIGHT_PHOTO_PANELS ? 'light' : 'dark';
  const mealPhotoLight = mealPhotoTone === 'light';
  const darkMealPhotoBackdrop = isLightTheme ? '#020617' : themeColors.background;
  const darkMealPhotoBase = isLightTheme ? '#020617' : themeColors.surface;
  const mealPhotoTextPrimary = mealPhotoLight ? themeColors.textPrimary : '#FFFFFF';
  const mealPhotoTextSecondary = mealPhotoLight ? themeColors.textPrimary : 'rgba(255,255,255,0.78)';
  const mealPhotoTextShadow = mealPhotoLight ? null : overPhotoTextShadow;
  const addMealCtaTextColor = getContrastingTextColor(mealsAccent);
  const mealPhotoPanelChrome = mealPhotoLight ? lightPhotoPanelChrome(mealPalette.strong, themeColors.surface) : null;
  const mealPhotoBorder = mealPhotoLight ? mealPhotoPanelChrome!.borderColor : 'rgba(255,255,255,0.24)';
  const mealPhotoChipBackground = mealPhotoLight ? themeColors.surface + 'F0' : 'rgba(255,255,255,0.14)';
  const mealPhotoChipBorder = mealPhotoLight ? mealPalette.strong + '3D' : 'rgba(255,255,255,0.34)';
  const lightMealPhotoOverlay = mealPhotoLight ? lightPhotoOverlayColors(mealPalette.strong, themeColors.surface) : null;
  const darkMealPhotoOverlay = darkPhotoOverlayColors(mealPalette.strong, darkMealPhotoBackdrop, 0.84);
  const mealPhotoOverlayColors = lightMealPhotoOverlay?.colors ?? darkMealPhotoOverlay.colors;
  const mealPhotoOverlayLocations = lightMealPhotoOverlay?.locations ?? darkMealPhotoOverlay.locations;
  const mealPhotoBottomFade = photoBottomFadeStops(themeColors.surface);
  const cardBg = mealPhotoLight ? themeColors.surface : darkMealPhotoBase;
  const cardBorder = isToday ? mealsAccent + (isLightTheme ? 'AA' : '') : mealPhotoBorder;
  const cardBorderWidth = isToday ? 1.5 : StyleSheet.hairlineWidth;
  const cardBorderStyle: 'solid' | 'dashed' = isPast && !isToday ? 'dashed' : 'solid';
  const hydrationForDay = hydrationByDate[day.key] ?? (isToday ? hydration : null);
  const hydrationOunces = Math.round(hydrationForDay?.ounces ?? 0);
  const hydrationTarget = Math.max(1, Math.round(hydrationForDay?.target_ounces ?? 64));
  const computedHydrationRange = hydrationTargetRangeOz(hydrationTarget);
  const hydrationTargetMin = Math.max(1, Math.round(
    hydrationForDay?.target_ounces_min ?? hydrationForDay?.breakdown?.target_min_oz ?? computedHydrationRange?.min ?? hydrationTarget
  ));
  const hydrationTargetMax = Math.max(hydrationTargetMin, Math.round(
    hydrationForDay?.target_ounces_max ?? hydrationForDay?.breakdown?.target_max_oz ?? computedHydrationRange?.max ?? hydrationTarget
  ));
  const hydrationPct = Math.min(100, Math.round((hydrationOunces / hydrationTargetMin) * 100));
  const targetAdjustmentInfo = isToday
    ? buildDailyTargetAdjustmentBanner(adjustedTargetForDay, hydrationForDay)
    : null;
  const mealCardImageLayer = (
    <View pointerEvents="none" style={[styles.mealCardImageLayer, mealPhotoLight && { backgroundColor: themeColors.surface }]}>
      <Image source={mealCardBackground} style={[styles.mealCardBackgroundImage, mealPhotoLight && styles.mealCardBackgroundImageLight]} resizeMode="cover" blurRadius={14} fadeDuration={0} />
      <Image source={mealCardBackground} style={[styles.mealCardForegroundImage, mealPhotoLight && styles.mealCardForegroundImageLight]} resizeMode="cover" resizeMethod="scale" fadeDuration={0} />
      <LinearGradient
        pointerEvents="none"
        colors={mealPhotoOverlayColors as any}
        locations={mealPhotoOverlayLocations as any}
        style={styles.mealCardBackgroundOverlay}
      />
      {!mealPhotoLight && <View style={[styles.cardPhotoDarkHueOverlay, { backgroundColor: darkPhotoHueOverlayColor(darkMealPhotoBackdrop) }]} />}
      {!isEmptyMealDay && (
        <LinearGradient
          pointerEvents="none"
          colors={mealPhotoBottomFade.colors as any}
          locations={mealPhotoBottomFade.locations as any}
          style={styles.cardPhotoBottomFade}
        />
      )}
    </View>
  );

  return (
    <>
      <FadeInView delay={index * 70}>
        <View
          style={[
            styles.mealAccordionCard,
            isToday && { marginBottom: 16 },
            {
              backgroundColor: cardBg,
              borderColor: cardBorder,
              borderWidth: cardBorderWidth,
              borderStyle: cardBorderStyle,
              opacity: 1,
              shadowColor: mealsAccent,
              shadowOpacity: isToday ? (isLightTheme ? 0.22 : 0.30) : (isLightTheme ? 0.10 : 0.18),
              shadowRadius: isToday ? 18 : 12,
              shadowOffset: { width: 0, height: isToday ? 10 : 5 },
              elevation: isToday ? 7 : 3,
            },
          ]}
          ref={(el) => {
            mealPlanCardRefs.current[day.key] = el;
          }}
          collapsable={false}
          testID={isToday ? 'today-meal-card' : undefined}>
          {isEmptyMealDay && mealCardImageLayer}
          <View style={styles.mealCardPhotoTopContent}>
            {!isEmptyMealDay && mealCardImageLayer}
            <View
              testID={isToday ? 'today-meal-card-header' : undefined}
              style={[
                styles.mealAccordionHeader,
                { backgroundColor: 'transparent' },
                mealPhotoLight && styles.lightPhotoCopyPanel,
                mealPhotoLight && mealPhotoPanelChrome,
              ]}
            >
              <View style={{ flex: 1, minWidth: 0, paddingRight: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={[
                    styles.mealAccordionTitle,
                    {
                      color: mealPhotoTextPrimary,
                      fontWeight: isToday ? '900' : '700',
                      fontSize: isToday ? 22 : 18,
                      flexShrink: 1,
                    },
                    mealPhotoTextShadow,
                  ]} numberOfLines={1}>
                    {mealDayLabel(day.date, index)}
                  </Text>
                  {isPastLogged && (
                    <View style={{
                      backgroundColor: mealPhotoChipBackground,
                      borderRadius: 4,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: mealPhotoChipBorder,
                      paddingHorizontal: 5,
                      paddingVertical: 1,
                    }}>
                      <Text style={[{ fontSize: 10, fontWeight: '700', color: mealPhotoTextPrimary }, mealPhotoTextShadow]}>
                        ✓ {displayLoggedCount} logged
                      </Text>
                    </View>
                  )}
                  {isPastSkipped && (
                    <View style={{
                      backgroundColor: mealPhotoChipBackground,
                      borderRadius: 4,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: mealPhotoChipBorder,
                      paddingHorizontal: 5,
                      paddingVertical: 1,
                    }}>
                      <Text style={[{ fontSize: 10, fontWeight: '700', color: mealPhotoTextPrimary }, mealPhotoTextShadow]}>
                        Skipped
                      </Text>
                    </View>
                  )}
                  {!isPast && !isToday && (
                    <View style={{ backgroundColor: mealPhotoChipBackground, borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, borderColor: mealPhotoChipBorder, paddingHorizontal: 5, paddingVertical: 1 }}>
                      <Text style={[{ fontSize: 10, fontWeight: '700', color: mealPhotoTextPrimary }, mealPhotoTextShadow]}>Planned</Text>
                    </View>
                  )}
                </View>
              </View>
              {!isPastSkipped && (
                <PressableScale
                  testID={isToday ? 'today-add-meal' : undefined}
                  onPress={(e) => {
                    e?.stopPropagation?.();
                    import('../utils/feedback').then(f => f.hapticLight()).catch(() => {});
                    handleAddSnack(day.key);
                  }}
                  scaleDown={0.95}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 6 }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 5,
                    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 19,
                    backgroundColor: mealsAccent,
                    borderWidth: 1, borderColor: addMealCtaTextColor + '44',
                    marginRight: 3,
                    shadowColor: mealsAccent,
                    shadowOffset: { width: 0, height: 5 },
                    shadowOpacity: mealPhotoLight ? 0.22 : 0.34,
                    shadowRadius: 10,
                    elevation: 5,
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Add meal"
                >
                  <Ionicons name="add-circle" size={18} color={addMealCtaTextColor} />
                  <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={0.82}
                    style={{ fontSize: 12, fontWeight: '900', color: addMealCtaTextColor, letterSpacing: 0 }}
                  >
                    Add meal
                  </Text>
                </PressableScale>
              )}
            </View>

            {targetAdjustmentInfo ? (
              <DailyTargetAdjustmentBanner info={targetAdjustmentInfo} colors={themeColors} accent={mealsAccent} photoTone={mealPhotoTone} />
            ) : null}

            <View
              testID={isToday ? 'today-meal-macros' : undefined}
              style={[
                mealPhotoLight && styles.lightPhotoMetricPanel,
                mealPhotoLight && mealPhotoPanelChrome,
              ]}>
              <MacroDonutRow
                themeName={userProfile.themePreference}
                accent={mealPalette.strong}
                calories={{ actual: totalCalories, target: t.calories }}
                protein={{ actual: totalProtein, target: t.protein }}
                carbs={{ actual: totalCarbs, target: t.carbs }}
                fat={{ actual: totalFat, target: t.fat }}
                overPhoto
                photoTone={mealPhotoTone}
                onPressMacro={setMacroBreakdown}
              />
              <MacroBreakdownSheet
                macro={macroBreakdown}
                meals={meals}
                totals={{ calories: totalCalories, protein: totalProtein, carbs: totalCarbs, fat: totalFat }}
                targets={t}
                accent={mealPalette.strong}
                themeName={userProfile.themePreference}
                onClose={() => setMacroBreakdown(null)}
              />
            </View>

            {(isToday || isPast) && authToken && (
              <View style={mealPhotoLight ? { marginTop: 10 } : null}>
                <HydrationTodayPanel
                  ounces={hydrationOunces}
                  target={hydrationTarget}
                  targetMin={hydrationTargetMin}
                  targetMax={hydrationTargetMax}
                  pct={hydrationPct}
                  breakdown={hydrationForDay?.breakdown}
                  guidance={hydrationForDay?.guidance}
                  loading={hydrationLoading}
                  colors={themeColors}
                  accent={mealsAccent}
                  overPhoto
                  photoTone={mealPhotoTone}
                  onDelta={(oz: number) => handleHydrationDelta(oz, day.key)}
                  onSet={(oz: number) => handleHydrationSet(oz, day.key)}
                />
              </View>
            )}
          </View>

          <View style={[styles.mealExpansionRail, { backgroundColor: isEmptyMealDay ? 'transparent' : themeColors.surface }]}>
            {!isPast && !historyBackedMealPlan && !isFreeTier && (() => {
              const mealCount = (planForDisplay.meals ?? []).length;
              const isEmpty = mealCount === 0;
              const targetCalories = Number(t.calories ?? 0);
              // `Fill gaps` only makes sense when there's a real target to
              // fill toward. With targetCalories === 0 we don't know the
              // gap, so the button would be misleading (it implies "add to
              // reach your goal" while there's no goal). Generate is still
              // useful in the empty-day case — it generates against the
              // user's default profile targets, which the user can fix on
              // the profile screen after seeing the result.
              const hasCalorieRoom = targetCalories > 0 && totalCalories < targetCalories - 25;
              if (!isEmpty && !hasCalorieRoom) return null;
              const generationMode = mealGenerationByDate[day.key] ?? null;
              const isGeneratingForDay = generationMode != null;
              const generationLabel = generationMode === 'fill' ? 'Filling...' : 'Generating...';
              return (
                <View style={{ marginTop: 12, marginBottom: 10 }}>
                  {isEmpty ? (
                    <PressableScale
                      testID={isToday ? 'generate-today-btn' : undefined}
                      disabled={isGeneratingForDay}
                      onPress={() => handleGenerateToday(day.key)}
                      scaleDown={0.97}
                      style={[{
                        backgroundColor: mealsAccent,
                        paddingVertical: 10, borderRadius: 10,
                        alignItems: 'center',
                      }, isGeneratingForDay && { opacity: 0.72 }]}>
                      {isGeneratingForDay ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 17 }}>
                          <ActivityIndicator size="small" color={addMealCtaTextColor} />
                          <Text style={{ color: addMealCtaTextColor, fontSize: 13, fontWeight: '700' }}>
                            {generationLabel}
                          </Text>
                        </View>
                      ) : (
                        <Text style={{ color: addMealCtaTextColor, fontSize: 13, fontWeight: '700' }}>
                          Generate meals
                        </Text>
                      )}
                    </PressableScale>
                  ) : (
                    <PressableScale
                      disabled={isGeneratingForDay}
                      onPress={() => handleFillGaps(day.key)}
                      scaleDown={0.97}
                      style={[{
                        backgroundColor: themeColors.surface,
                        borderWidth: 1, borderColor: mealsAccent,
                        paddingVertical: 10, borderRadius: 10,
                        alignItems: 'center',
                      }, isGeneratingForDay && { opacity: 0.72 }]}>
                      {isGeneratingForDay ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 17 }}>
                          <ActivityIndicator size="small" color={mealsAccent} />
                          <Text style={{ color: mealsAccent, fontSize: 13, fontWeight: '700' }}>
                            {generationLabel}
                          </Text>
                        </View>
                      ) : (
                        <Text style={{ color: mealsAccent, fontSize: 13, fontWeight: '700' }}>
                          Fill the gaps
                        </Text>
                      )}
                    </PressableScale>
                  )}
                </View>
              );
            })()}
            <NutritionCard
              testID={day.key === todayKey() ? 'today-nutrition-card' : undefined}
              embedded
              themeName={userProfile.themePreference}
              nutritionPlan={planForDisplay}
              checkedMeals={mealChecksForDisplay}
              onToggleMeal={historyBackedMealPlan ? undefined : ((mealType) => handleToggleMeal(day.key, mealType))}
              onEditMeal={(mealType, meal) => {
                const historyMealId = Number((meal as any)._loggedMealId || 0) || undefined;
                const isRoutineBacked = !!(meal as any)?._routineId;
                if (historyMealId && !isRoutineBacked) {
                  setEditingMeal({ dateKey: day.key, type: `history_${historyMealId}`, meal, historyMealId });
                  return;
                }
                setEditingMeal({ dateKey: day.key, type: mealType, meal });
              }}
              onAddSnack={() => handleAddSnack(day.key)}
              onRemoveMeal={(mealType) => {
                const idx = resolveMealIndex(plan, mealType);
                const meal = idx >= 0 ? planMeals[idx] : undefined;
                const historyMealId = meal ? (Number((meal as any)._loggedMealId || 0) || undefined) : undefined;
                const isRoutineBacked = !!(meal as any)?._routineId;
                if (historyMealId && meal && !isRoutineBacked) {
                  handleBackendMealDelete(day.key, historyMealId, meal, mealType);
                  return;
                }
                handleRemoveMeal(day.key, mealType);
              }}
              onRestoreMeal={historyBackedMealPlan ? undefined : ((mealType) => handleRestoreMeal(day.key, mealType))}
              onHardDeleteMeal={(mealType) => {
                const idx = resolveMealIndex(plan, mealType);
                const meal = idx >= 0 ? planMeals[idx] : undefined;
                const historyMealId = meal ? (Number((meal as any)._loggedMealId || 0) || undefined) : undefined;
                Alert.alert(
                  'Delete meal?',
                  'This removes the meal entirely. You won\'t be able to restore it.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete',
                      style: 'destructive',
                      onPress: () => {
                        const isRoutineBacked = !!(meal as any)?._routineId;
                        if (historyMealId && meal && !isRoutineBacked) {
                          handleBackendMealDelete(day.key, historyMealId, meal, mealType);
                        } else {
                          handleHardDeleteMeal(day.key, mealType);
                        }
                      },
                    },
                  ],
                );
              }}
              onToggleRoutine={historyBackedMealPlan ? undefined : ((mealType) => handleToggleRoutine(day.key, mealType))}
              onShowRecipe={historyBackedMealPlan ? undefined : ((mealType, meal) => setRecipeTarget({ dateKey: day.key, type: mealType, meal }))}
              onMoveMeal={historyBackedMealPlan ? undefined : ((mealType, direction) => handleMoveMeal(day.key, mealType, direction))}
              onDuplicateMeal={(mealType, meal) => handleDuplicateMeal(day.key, mealType, meal)}
              onSplitMeal={(mealType, meal) => handleSplitMeal(day.key, mealType, meal)}
              goal={userProfile.goal}
              savedMealNames={savedMealNames}
              onAddFromSaved={authToken ? (() => openAddFromSavedForDate(day.key)) : undefined}
              onToggleSave={authToken ? ((mealType, meal) => handleToggleSaveMeal(day.key, mealType, meal)) : undefined}
              dailyCollagenG={day.key === todayKey() ? todayCollagenG : null}
              dailyProbioticCfuBillions={day.key === todayKey() ? todayProbioticCfu : null}
              dailyPrebioticG={day.key === todayKey() ? todayPrebioticG : null}
              proteinBreakdown={day.key === todayKey() ? proteinBreakdown : null}
              todaySupplements={day.key === todayKey() ? todaySupplementMicros : null}
              glp1Support={userProfile.glp1Support}
              authoritativeScore={typeof authoritativeNutritionScore?.score === 'number' ? authoritativeNutritionScore : null}
              scoreUpdating={day.key === todayKey() && nutritionScoreUpdating}
              hidePlanScore={isPast}
            />
          </View>
        </View>
      </FadeInView>
      {isToday && todayMealDay && (
        <View style={{ marginTop: -4 }}>
          {isFreeTier ? (
            <>
              <FadeInView delay={20}>
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  backgroundColor: themeColors.surface,
                  borderRadius: 12, padding: 12, marginBottom: 10,
                  borderWidth: 1, borderColor: themeColors.border,
                }}>
                  <Ionicons name="restaurant-outline" size={18} color={mealPalette.strong} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: themeColors.textPrimary }}>
                      Manual meal logging
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                      Add meals yourself, use Favorites, or pin routines to auto-fill. Upgrade to Pro for AI plans.
                    </Text>
                  </View>
                </View>
              </FadeInView>
              {authToken && (
                <SavedMealsSection
                  authToken={authToken}
                  themeName={userProfile.themePreference}
                  refreshKey={savedMealsRefreshKey}
                  onLogged={onSavedMealLogged}
                  onChanged={onSavedMealChanged}
                  onTemplateUpdated={handleSavedMealTemplateUpdated}
                  onEditTemplate={onEditSavedMealTemplate}
                  onLibraryChanged={reloadSavedMeals}
                  foodsAvailable={userProfile.foodsAvailable}
                  dietaryPreference={userProfile.dietaryPreference}
                  allergies={userProfile.allergies}
                  goal={userProfile.goal}
                />
              )}
            </>
          ) : authToken ? (
            <>
              <SavedMealsSection
                authToken={authToken}
                themeName={userProfile.themePreference}
                refreshKey={savedMealsRefreshKey}
                onLogged={onSavedMealLogged}
                onChanged={onSavedMealChanged}
                onTemplateUpdated={handleSavedMealTemplateUpdated}
                onEditTemplate={onEditSavedMealTemplate}
                onLibraryChanged={reloadSavedMeals}
                foodsAvailable={userProfile.foodsAvailable}
                dietaryPreference={userProfile.dietaryPreference}
                allergies={userProfile.allergies}
                goal={userProfile.goal}
              />
              {(() => {
                const todayPlanForTarget = nutritionPlansByDate[todayMealDay.key] ?? (firstMealDayKey ? nutritionPlansByDate[firstMealDayKey] : undefined);
                const target = todayPlanForTarget?.targets?.calories ?? 0;
                if (target <= 0) return null;
                return (
                  <IncompleteDayBanner
                    authToken={authToken}
                    themeName={userProfile.themePreference}
                    targetCalories={target}
                    onFillIn={() => setMealsSubTab('history')}
                  />
                );
              })()}
            </>
          ) : null}
        </View>
      )}
    </>
  );
}

const HomeMealsPlanDayCard = memo(HomeMealsPlanDayCardInner);

export default memo(HomeMealsPlanTabInner);
