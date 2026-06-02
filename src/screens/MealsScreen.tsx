import React, { memo } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import TabDragWrapper from '../components/TabDragWrapper';
import FadeInView from '../components/FadeInView';
import HomeMealsPlanTab from '../components/HomeMealsPlanTab';
import SavedMealsSection from '../components/SavedMealsSection';
import SupplementStackScreen from '../components/SupplementStackScreen';
import EditProfileScreen from './EditProfileScreen';
import type { DailyRowShape } from './progressData';
import type { DailyNutritionPlan, MealSuggestion, UserProfile } from '../types';
import type { NutritionScoreWeeklyDay } from '../services/api';
import { getContrastingTextColor, getTheme } from '../constants/theme';
import { configureExpandAnimation } from '../utils/layoutAnim';
import { macroTotalsFromMeal } from '../utils/mealItems';
import { todayKey } from '../utils/workoutHistory';
import { shouldHoldMealPlanForVisualSync } from '../utils/mealVisualHydration';
import { formatNutritionPrimaryTarget } from '../utils/nutritionTargetRanges';
import { dynamicTextProps } from '../utils/dynamicType';
import styles from './meals/mealScreenStyles';

export type MealsSubTab = 'plan' | 'foods' | 'supplements' | 'macros' | 'history';

type ThemeColors = ReturnType<typeof getTheme>['colors'];

type MealDay = {
  key: string;
  date: Date;
};

type MealEditorTarget = {
  dateKey: string;
  type: string;
  meal: MealSuggestion;
  historyMealId?: number;
  markEatenOnSave?: boolean;
  startWithCamera?: boolean;
};

type RecipeTarget = {
  dateKey: string;
  type: string;
  meal: MealSuggestion;
};

type MealsScreenProps = {
  authToken?: string | null;
  userProfile: UserProfile;
  mealsSubTab: MealsSubTab;
  subTabSlideStyle: any;
  swipeMealsSubTab: (direction: -1 | 1) => void;
  selectMealsSubTab: (tab: MealsSubTab) => void;
  setMealsSubTab: React.Dispatch<React.SetStateAction<MealsSubTab>>;
  themeColors: ThemeColors;
  mealPalette: { strong: string; soft?: string; text?: string };
  isFreeTier: boolean;
  onSaveProfile?: (updated: UserProfile, mode?: 'goal' | 'workout' | 'mealplan' | 'theme') => void;
  onProfileUpdate?: (changes: Partial<UserProfile>, skipRegen?: boolean) => void;
  onOpenGroceryList: () => void;
  savedMealsRefreshKey: number;
  onSavedMealLoggedFromFoods: (log: any) => Promise<void> | void;
  onSavedMealChanged?: (change?: any) => Promise<void> | void;
  handleSavedMealTemplateUpdated: (...args: any[]) => Promise<void> | void;
  onImportSavedMeal: () => void;
  reloadSavedMeals: () => Promise<void>;
  onEditSavedMealTemplate: (savedMeal: any) => void;

  nutritionCalendarMonthOffset: number;
  setNutritionCalendarMonthOffset: React.Dispatch<React.SetStateAction<number>>;
  mealHistoryWindowDays: number;
  setMealHistoryWindowDays: React.Dispatch<React.SetStateAction<number>>;
  expandedHistoryDate: string | null;
  setExpandedHistoryDate: (value: string | null) => void;
  mealHistoryLoading: boolean;
  mealHistoryHydrated: boolean;
  mealPlanHydrating: boolean;
  mealHistoryCardRefs: React.MutableRefObject<Record<string, View | null>>;
  backendMealDailyRows: DailyRowShape[];
  backendMealDailyByDate: Map<string, DailyRowShape>;
  backendMealSuggestionsByDate: Map<string, MealSuggestion[]>;
  checkedMealsByDate: Record<string, Record<string, boolean>>;
  nutritionPlansByDate: Record<string, DailyNutritionPlan>;
  projectedNutritionScoreByDate: Map<string, NutritionScoreWeeklyDay>;
  handleAddSnack: (dateKey: string) => void;
  openAddFromSavedForDate: (dateKey: string) => void;
  handleToggleMeal: (dateKey: string, mealType: string) => void;
  setEditingMeal: (value: MealEditorTarget | null) => void;
  isSavedFavoriteMeal: (meal: MealSuggestion) => boolean;
  handleToggleSaveMeal: (mealType: string, meal: MealSuggestion) => Promise<void> | void;
  handleBackendMealDelete: (dateKey: string, mealId: number, meal: MealSuggestion, mealType?: string) => Promise<unknown> | unknown;
  scrollSubTabNodeToTop: (node: any) => void;

  mealDays: MealDay[];
  selectedMealDayKey: string;
  setSelectedMealDayKey: React.Dispatch<React.SetStateAction<string>>;
  planWeek: any;
  isLightTheme: boolean;
  mealPlanCardRefs: React.MutableRefObject<Record<string, View | null>>;
  adjustedDailyTarget: any;
  adjustedDailyTargetsByDate?: Record<string, any>;
  hydrationByDate: Record<string, any>;
  hydration: any;
  hydrationLoading: boolean;
  mealGenerationByDate: Record<string, 'replace' | 'fill'>;
  savedMealNames: Set<string>;
  todayCollagenG: number | null;
  todayProbioticCfu: number | null;
  todayPrebioticG: number | null;
  proteinBreakdown: any;
  todaySupplementMicros: any;
  onSupplementsChanged?: () => Promise<void> | void;
  nutritionScoreUpdating: boolean;
  dayNames: string[];
  WeekStripComponent: React.ComponentType<any>;
  mealDayLabel: (date: Date, index: number) => string;
  refreshHydration: (dayKey?: string) => Promise<any>;
  handleGenerateToday: (dateKey: string) => void;
  handleFillGaps: (dateKey: string) => void;
  handleRemoveMeal: (dateKey: string, mealType: string) => void;
  handleRestoreMeal: (dateKey: string, mealType: string) => void;
  handleHardDeleteMeal: (dateKey: string, mealType: string) => void;
  handleToggleRoutine: (dateKey: string, mealType: string) => void;
  setRecipeTarget: (value: RecipeTarget | null) => void;
  handleMoveMeal: (dateKey: string, mealType: string, direction: -1 | 1) => void;
  handleDuplicateMeal: (dateKey: string, mealType: string, meal?: MealSuggestion) => void;
  handleSplitMeal: (dateKey: string, mealType: string, meal?: MealSuggestion) => void;
  handleHydrationDelta: (deltaOz: number, dateKey: string) => Promise<void> | void;
  handleHydrationSet: (ounces: number, dateKey: string) => Promise<void> | void;
  onSavedMealLoggedToPlan: (log: any) => Promise<void>;
};

function clampScore(value: unknown): number | null {
  const score = Number(value);
  if (!Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function nutritionScoreTone(score: number, tc: ThemeColors) {
  if (score >= 70) return tc.success;
  if (score >= 45) return tc.warning;
  return tc.error;
}

function loggedMealTimeLabel(meal: Partial<MealSuggestion> | Record<string, any> | null | undefined): string | null {
  const raw = meal?._consumedAt ?? (meal as any)?.consumed_at ?? (meal as any)?.created_at;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function MealsScreenInner({
  authToken,
  userProfile,
  mealsSubTab,
  subTabSlideStyle,
  swipeMealsSubTab,
  selectMealsSubTab,
  setMealsSubTab,
  themeColors,
  mealPalette,
  isFreeTier,
  onSaveProfile,
  onProfileUpdate,
  onOpenGroceryList,
  savedMealsRefreshKey,
  onSavedMealLoggedFromFoods,
  onSavedMealChanged,
  handleSavedMealTemplateUpdated,
  onImportSavedMeal,
  reloadSavedMeals,
  onEditSavedMealTemplate,
  nutritionCalendarMonthOffset,
  setNutritionCalendarMonthOffset,
  mealHistoryWindowDays,
  setMealHistoryWindowDays,
  expandedHistoryDate,
  setExpandedHistoryDate,
  mealHistoryLoading,
  mealHistoryHydrated,
  mealPlanHydrating,
  mealHistoryCardRefs,
  backendMealDailyRows,
  backendMealDailyByDate,
  backendMealSuggestionsByDate,
  checkedMealsByDate,
  nutritionPlansByDate,
  projectedNutritionScoreByDate,
  handleAddSnack,
  openAddFromSavedForDate,
  handleToggleMeal,
  setEditingMeal,
  isSavedFavoriteMeal,
  handleToggleSaveMeal,
  handleBackendMealDelete,
  scrollSubTabNodeToTop,
  mealDays,
  selectedMealDayKey,
  setSelectedMealDayKey,
  planWeek,
  isLightTheme,
  mealPlanCardRefs,
  adjustedDailyTarget,
  adjustedDailyTargetsByDate,
  hydrationByDate,
  hydration,
  hydrationLoading,
  mealGenerationByDate,
  savedMealNames,
  todayCollagenG,
  todayProbioticCfu,
  todayPrebioticG,
  proteinBreakdown,
  todaySupplementMicros,
  onSupplementsChanged,
  nutritionScoreUpdating,
  dayNames,
  WeekStripComponent,
  mealDayLabel,
  refreshHydration,
  handleGenerateToday,
  handleFillGaps,
  handleRemoveMeal,
  handleRestoreMeal,
  handleHardDeleteMeal,
  handleToggleRoutine,
  setRecipeTarget,
  handleMoveMeal,
  handleDuplicateMeal,
  handleSplitMeal,
  handleHydrationDelta,
  handleHydrationSet,
  onSavedMealLoggedToPlan,
}: MealsScreenProps) {
  return (
    <TabDragWrapper
      canGoPrev={false}
      canGoNext={false}
      resetKey={mealsSubTab}
      onCommit={swipeMealsSubTab}>
      <Animated.View style={subTabSlideStyle} collapsable={false}>
        {mealsSubTab === 'supplements' && (
          <FadeInView duration={260} slideDistance={10} style={{ flexGrow: 1, marginHorizontal: -16, marginBottom: 96, backgroundColor: themeColors.background }}>
            <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
              <TouchableOpacity
                testID="meal-supplements-back"
                accessibilityLabel="Back to plan"
                onPress={() => selectMealsSubTab('plan')}
                activeOpacity={0.75}
                style={[styles.overlayBackBtn, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                <Ionicons name="chevron-back" size={16} color={themeColors.textPrimary} />
                <Text style={[styles.overlayBackText, { color: themeColors.textPrimary }]}>Back to plan</Text>
              </TouchableOpacity>
            </View>
            {authToken ? (
              <SupplementStackScreen
                authToken={authToken}
                themeName={userProfile.themePreference}
                userProfile={userProfile}
                embedded
                onSupplementsChanged={onSupplementsChanged}
              />
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 48 }}>
                <ActivityIndicator size="small" color={themeColors.primary} />
              </View>
            )}
          </FadeInView>
        )}

        {(mealsSubTab !== 'plan' && mealsSubTab !== 'history' && mealsSubTab !== 'supplements') && (
          <FadeInView duration={260} slideDistance={10} style={{ flex: 1, marginHorizontal: -16, marginBottom: 96, backgroundColor: themeColors.background }}>
            <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
              <TouchableOpacity
                testID="meal-foods-back"
                accessibilityLabel="Back to plan"
                onPress={() => selectMealsSubTab('plan')}
                activeOpacity={0.75}
                style={[styles.overlayBackBtn, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                <Ionicons name="chevron-back" size={16} color={themeColors.textPrimary} />
                <Text style={[styles.overlayBackText, { color: themeColors.textPrimary }]}>Back to plan</Text>
              </TouchableOpacity>
            </View>
            {mealsSubTab === 'foods' && !isFreeTier && (
              <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
                <TouchableOpacity
                  testID="foods-grocery-list-card"
                  onPress={onOpenGroceryList}
                  activeOpacity={0.8}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    backgroundColor: themeColors.surface,
                    borderRadius: 12, padding: 12, marginBottom: 10,
                    borderWidth: 1, borderColor: themeColors.border,
                  }}
                >
                  <View style={{
                    width: 34, height: 34, borderRadius: 17,
                    backgroundColor: themeColors.surfaceRaised,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Ionicons name="cart-outline" size={18} color={themeColors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: themeColors.textPrimary }}>Grocery list</Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted }}>Auto-built from this week's meals</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={themeColors.textMuted} />
                </TouchableOpacity>
                {authToken && (
                  <SavedMealsSection
                    authToken={authToken}
                    themeName={userProfile.themePreference}
                    refreshKey={savedMealsRefreshKey}
                    onLogged={onSavedMealLoggedFromFoods}
                    onChanged={onSavedMealChanged}
                    onTemplateUpdated={handleSavedMealTemplateUpdated}
                    onImportSavedMeal={onImportSavedMeal}
                    onLibraryChanged={reloadSavedMeals}
                    foodsAvailable={userProfile.foodsAvailable}
                    dietaryPreference={userProfile.dietaryPreference}
                    allergies={userProfile.allergies}
                    goal={userProfile.goal}
                    onEditTemplate={onEditSavedMealTemplate}
                  />
                )}
              </View>
            )}
            <EditProfileScreen
              authToken={authToken ?? ''}
              profile={userProfile}
              mode="mealplan"
              initialMealTab={mealsSubTab as 'foods' | 'supplements' | 'macros'}
              noHeader
              onSave={(updated) => { onSaveProfile?.(updated, 'mealplan'); setMealsSubTab('plan'); }}
              onCancel={() => setMealsSubTab('plan')}
              onRoutinesChanged={() => { /* no-op */ }}
              onProfileUpdate={onProfileUpdate}
            />
          </FadeInView>
        )}

        {mealsSubTab === 'history' && (() => {
          const todayStr = todayKey();
          const todayDateObj = new Date();
          const viewedMonthDate = new Date(todayDateObj.getFullYear(), todayDateObj.getMonth() + nutritionCalendarMonthOffset, 1);
          const viewedYear = viewedMonthDate.getFullYear();
          const viewedMonth = viewedMonthDate.getMonth();
          const isCurrentMonth = nutritionCalendarMonthOffset === 0;
          const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
          const daysInViewedMonth = new Date(viewedYear, viewedMonth + 1, 0).getDate();
          const firstDow = new Date(viewedYear, viewedMonth, 1).getDay();
          const monthPrefix = `${viewedYear}-${String(viewedMonth + 1).padStart(2, '0')}-`;

          const days: string[] = [];
          const seen = new Set<string>();
          for (const k of Object.keys(nutritionPlansByDate).concat(Object.keys(checkedMealsByDate), backendMealDailyRows.map(row => row.date))) {
            if (!seen.has(k)) { seen.add(k); days.push(k); }
          }
          const sorted = days
            .filter(d => d < todayStr && d.startsWith(monthPrefix))
            .sort((a, b) => b.localeCompare(a));
          const activeExpandedHistoryDate = expandedHistoryDate === null ? (sorted[0] ?? null) : expandedHistoryDate;
          const isSelectableHistoryDate = (key: string | null | undefined) =>
            !!key && /^\d{4}-\d{2}-\d{2}$/.test(key) && key < todayStr && key.startsWith(monthPrefix);
          const detailDates = activeExpandedHistoryDate && isSelectableHistoryDate(activeExpandedHistoryDate) && !sorted.includes(activeExpandedHistoryDate)
            ? [activeExpandedHistoryDate, ...sorted]
            : sorted;
          type CellStatus = 'logged' | 'partial' | 'rest' | 'future' | 'empty';
          const cells: Array<{ day: number; key: string; status: CellStatus }> = [];
          for (let i = 0; i < firstDow; i++) cells.push({ day: 0, key: `pad-${i}`, status: 'empty' });
          for (let d = 1; d <= daysInViewedMonth; d++) {
            const key = `${monthPrefix}${String(d).padStart(2, '0')}`;
            const isFuture = isCurrentMonth && d > todayDateObj.getDate();
            if (isFuture) { cells.push({ day: d, key, status: 'future' }); continue; }
            const planDay = nutritionPlansByDate[key];
            const backendMeals = backendMealSuggestionsByDate.get(key) ?? [];
            const checks = checkedMealsByDate[key] ?? {};
            const removedSetHist = new Set((planDay?.removedMealIds ?? []) as string[]);
            const activeKeys = (planDay?.meals ?? [])
              .map((_, i) => `meal_${i}`)
              .filter(k => !removedSetHist.has(k));
            const checkedCount = Object.values(checks).filter(Boolean).length;
            const allPlanChecked = activeKeys.length > 0 && activeKeys.every(k => !!checks[k]);
            const anyLogged = backendMeals.length > 0 || checkedCount > 0;
            const fullyLogged = activeKeys.length > 0 ? allPlanChecked : anyLogged;
            const status: CellStatus = fullyLogged ? 'logged' : anyLogged ? 'partial' : 'rest';
            cells.push({ day: d, key, status });
          }
          while (cells.length % 7 !== 0) cells.push({ day: 0, key: `pad-end-${cells.length}`, status: 'empty' });
          const rows: typeof cells[] = [];
          for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
          const loggedCount = cells.filter(c => c.status === 'logged').length;
          const partialCount = cells.filter(c => c.status === 'partial').length;

          return (
            <FadeInView testID="meal-history-screen" duration={260} slideDistance={10} style={{ gap: 10, marginBottom: 80 }}>
              <TouchableOpacity
                testID="meal-history-back"
                accessibilityLabel="Back to plan"
                onPress={() => selectMealsSubTab('plan')}
                activeOpacity={0.75}
                style={[styles.overlayBackBtn, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                <Ionicons name="chevron-back" size={16} color={themeColors.textPrimary} />
                <Text style={[styles.overlayBackText, { color: themeColors.textPrimary }]}>Back to plan</Text>
              </TouchableOpacity>
              {mealHistoryLoading && (
                <View
                  testID="meal-history-loading-row"
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: themeColors.border,
                    backgroundColor: themeColors.surface,
                  }}>
                  <ActivityIndicator size="small" color={mealPalette.strong} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textSecondary }}>
                    Loading logged meals...
                  </Text>
                </View>
              )}
              <View style={{ backgroundColor: themeColors.surface, borderRadius: 14, borderWidth: 1, borderColor: themeColors.border, padding: 12 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <TouchableOpacity
                    testID="nutrition-calendar-prev-month"
                    accessibilityLabel="Previous month"
                    onPress={() => {
                      const next = nutritionCalendarMonthOffset - 1;
                      setNutritionCalendarMonthOffset(next);
                      const daysBackNeeded = Math.abs(next) * 31 + 31;
                      if (daysBackNeeded > mealHistoryWindowDays) {
                        setMealHistoryWindowDays(Math.min(365, daysBackNeeded));
                      }
                      setExpandedHistoryDate(null);
                    }}
                    style={{ padding: 6, marginLeft: -6 }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="chevron-back" size={18} color={themeColors.textSecondary} />
                  </TouchableOpacity>
                  <View style={{ flex: 1, alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
                    <Text style={{ fontSize: 16, fontWeight: '700', color: themeColors.textPrimary }}>{monthNames[viewedMonth]} {viewedYear}</Text>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      {loggedCount > 0 && <Text style={{ fontSize: 12, color: themeColors.success, fontWeight: '600' }}>{loggedCount} logged</Text>}
                      {partialCount > 0 && <Text style={{ fontSize: 12, color: themeColors.warning, fontWeight: '600' }}>{partialCount} partial</Text>}
                    </View>
                  </View>
                  <TouchableOpacity
                    testID="nutrition-calendar-next-month"
                    accessibilityLabel="Next month"
                    onPress={() => { setNutritionCalendarMonthOffset(o => Math.min(0, o + 1)); setExpandedHistoryDate(null); }}
                    disabled={isCurrentMonth}
                    style={{ padding: 6, marginRight: -6, opacity: isCurrentMonth ? 0.3 : 1 }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="chevron-forward" size={18} color={themeColors.textSecondary} />
                  </TouchableOpacity>
                </View>
                <View style={{ flexDirection: 'row', marginBottom: 6 }}>
                  {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                    <Text key={d} style={{ flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600', color: themeColors.textMuted }}>{d}</Text>
                  ))}
                </View>
                {rows.map((row, ri) => (
                  <View key={ri} style={{ flexDirection: 'row', marginBottom: 4 }}>
                    {row.map(cell => {
                      const isToday = isCurrentMonth && cell.day === todayDateObj.getDate() && cell.status !== 'empty';
                      const isSelected = activeExpandedHistoryDate === cell.key && cell.status !== 'empty';
                      const tappable = cell.status !== 'future' && cell.status !== 'empty';
                      const dayScore = cell.status !== 'future' && cell.status !== 'empty'
                        ? clampScore(projectedNutritionScoreByDate.get(cell.key)?.score)
                        : null;
                      const scoreTone = dayScore != null ? nutritionScoreTone(dayScore, themeColors) : null;
                      const scoredTextColor = scoreTone ? getContrastingTextColor(scoreTone) : null;
                      return (
                        <View key={cell.key} style={{ flex: 1, alignItems: 'center', paddingVertical: 4 }}>
                          {cell.status === 'empty' ? (
                            <View style={{ width: 40, height: 40 }} />
                          ) : (
                            <TouchableOpacity
                              activeOpacity={tappable ? 0.7 : 1}
                              disabled={!tappable}
                              onPress={() => {
                                if (!tappable) return;
                                configureExpandAnimation(300);
                                setExpandedHistoryDate(isSelected ? '' : cell.key);
                                if (!isSelected) scrollSubTabNodeToTop(mealHistoryCardRefs.current[cell.key]);
                              }}
                              style={{
                                width: 40, height: 40, borderRadius: 12,
                                alignItems: 'center', justifyContent: 'center',
                                backgroundColor:
                                  scoreTone ? scoreTone :
                                  cell.status === 'logged' ? themeColors.success :
                                  cell.status === 'partial' ? themeColors.warning + '33' :
                                  'transparent',
                                borderWidth: isSelected ? 2 : isToday ? 2 : 0,
                                borderColor: isSelected ? mealPalette.strong : isToday ? mealPalette.strong : 'transparent',
                              }}>
                              <Text style={{
                                fontSize: dayScore != null ? 12 : 13,
                                lineHeight: dayScore != null ? 14 : 16,
                                fontWeight: isToday ? '800' : cell.status === 'logged' ? '700' : '400',
                                color: scoredTextColor ?? (cell.status === 'logged' ? '#fff'
                                  : cell.status === 'partial' ? themeColors.warning
                                  : cell.status === 'future' ? themeColors.textMuted + '55'
                                  : themeColors.textSecondary),
                              }}>{cell.day}</Text>
                              {dayScore != null && (
                                <View style={[
                                  styles.historyCalendarScoreBadge,
                                  { backgroundColor: scoredTextColor ?? '#fff', borderColor: scoredTextColor ?? '#fff' },
                                ]}>
                                  <Text style={[styles.historyCalendarScoreText, { color: scoreTone ?? themeColors.textPrimary }]}>
                                    {dayScore}
                                  </Text>
                                </View>
                              )}
                            </TouchableOpacity>
                          )}
                        </View>
                      );
                    })}
                  </View>
                ))}
                <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 14, marginTop: 10 }}>
                  {[
                    { c: themeColors.success, l: 'Logged' },
                    { c: themeColors.warning + '33', l: 'Partial' },
                    { c: themeColors.border, l: 'No meals' },
                  ].map(item => (
                    <View key={item.l} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: item.c }} />
                      <Text style={{ fontSize: 10, color: themeColors.textMuted }}>{item.l}</Text>
                    </View>
                  ))}
                </View>
              </View>
              {detailDates.length === 0 && !mealHistoryLoading && (
                <View style={[styles.emptyStateCard, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}>
                  <Ionicons name="restaurant-outline" size={36} color={mealPalette.strong} />
                  <Text {...dynamicTextProps} style={[styles.emptyStateTitle, { color: themeColors.textPrimary }]}>
                    {isCurrentMonth ? 'No meal history yet' : `No meals logged in ${monthNames[viewedMonth]}`}
                  </Text>
                  <Text {...dynamicTextProps} style={[styles.emptyStateBody, { color: themeColors.textSecondary }]}>
                    {isCurrentMonth
                      ? 'Check off meals on the Plan tab or log from Favorites. Past days will collect here with calories, macros, and score trends.'
                      : 'Tap the chevrons above to browse other months.'}
                  </Text>
                </View>
              )}
              {detailDates.map((d, historyIdx) => {
                const plan = nutritionPlansByDate[d];
                const planMeals = plan?.meals ?? [];
                const backendMeals = backendMealSuggestionsByDate.get(d) ?? [];
                const meals = backendMeals.length > 0 ? backendMeals : planMeals;
                const checks = checkedMealsByDate[d] ?? {};
                const backendRow = backendMealDailyByDate.get(d);
                const hasBackendMeals = backendMeals.length > 0;
                const checkedCount = planMeals.reduce((n, _m, i) => n + (checks[`meal_${i}`] ? 1 : 0), 0);
                const loggedPlanTotals = planMeals.reduce((acc, m, i) => {
                  if (!checks[`meal_${i}`]) return acc;
                  const macros = macroTotalsFromMeal(m);
                  return {
                    cal: acc.cal + macros.calories,
                    pro: acc.pro + macros.protein,
                    carb: acc.carb + macros.carbs,
                    fat: acc.fat + macros.fat,
                  };
                }, { cal: 0, pro: 0, carb: 0, fat: 0 });
                const backendMealTotals = backendMeals.reduce((acc, m) => {
                  const macros = macroTotalsFromMeal(m);
                  return {
                    cal: acc.cal + macros.calories,
                    pro: acc.pro + macros.protein,
                    carb: acc.carb + macros.carbs,
                    fat: acc.fat + macros.fat,
                  };
                }, { cal: 0, pro: 0, carb: 0, fat: 0 });
                const displayTotals = backendRow
                  ? {
                      cal: backendRow.calories,
                      pro: backendRow.protein_g,
                      carb: backendRow.carbs_g,
                      fat: backendRow.fat_g,
                    }
                  : hasBackendMeals
                    ? backendMealTotals
                    : loggedPlanTotals;
                const targets = plan?.targets;
                const isExpanded = activeExpandedHistoryDate === d;
                const dateObj = new Date(d + 'T12:00:00');
                const label = dateObj.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                const historyActiveKeys = planMeals.map((_, i) => `meal_${i}`);
                const historyAllChecked = historyActiveKeys.length > 0 && historyActiveKeys.every(k => !!checks[k]);
                const displayLoggedCount = backendRow?.meal_count ?? (hasBackendMeals ? backendMeals.length : checkedCount);
                const cardFullyLogged = historyActiveKeys.length > 0 ? historyAllChecked : displayLoggedCount > 0;
                const dayScoreEntry = projectedNutritionScoreByDate.get(d);
                const dayScore = typeof dayScoreEntry?.score === 'number' ? dayScoreEntry.score : null;
                const scoreTier = dayScore == null ? null
                  : dayScore >= 70 ? themeColors.success
                  : dayScore >= 45 ? themeColors.warning
                  : themeColors.error;
                return (
                  <View
                    key={d}
                    ref={(el) => {
                      mealHistoryCardRefs.current[d] = el;
                    }}
                    collapsable={false}
                    style={{
                      backgroundColor: cardFullyLogged ? themeColors.success + '12' : themeColors.surface,
                      borderRadius: 14, borderWidth: 1,
                      borderColor: cardFullyLogged ? themeColors.success + '55' : themeColors.border,
                    }}>
                    <Pressable
                      testID={`meal-history-row-${historyIdx}`}
                      accessibilityLabel={`meal-history-row-${historyIdx}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: isExpanded }}
                      onPress={() => {
                        try {
                          configureExpandAnimation(300);
                        } catch {}
                        setExpandedHistoryDate(isExpanded ? '' : d);
                        if (!isExpanded) scrollSubTabNodeToTop(mealHistoryCardRefs.current[d]);
                      }}
                      style={({ pressed }) => ({ padding: 14, opacity: pressed ? 0.85 : 1 })}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, flexWrap: 'wrap' }}>
                          <Text style={{ fontSize: 15, fontWeight: '700', color: themeColors.textPrimary }}>{label}</Text>
                          {dayScore != null && scoreTier && (
                            <View
                              testID={`meal-history-row-${historyIdx}-score`}
                              accessibilityLabel={`Nutrition score ${dayScore}`}
                              style={[
                                styles.historyScoreCircle,
                                { backgroundColor: scoreTier + '18', borderColor: scoreTier },
                              ]}>
                              <Text style={[styles.historyScoreCircleValue, { color: scoreTier }]}>
                                {dayScore}
                              </Text>
                              <Text style={[styles.historyScoreCircleLabel, { color: scoreTier }]}>score</Text>
                            </View>
                          )}
                          {cardFullyLogged && (
                            <View style={{
                              flexDirection: 'row', alignItems: 'center', gap: 3,
                              backgroundColor: themeColors.success + '22',
                              paddingHorizontal: 6, paddingVertical: 2,
                              borderRadius: 10,
                            }}>
                              <Ionicons name="checkmark-circle" size={11} color={themeColors.success} />
                              <Text style={{ fontSize: 10, fontWeight: '700', color: themeColors.success, letterSpacing: 0.3 }}>
                                FULLY LOGGED
                              </Text>
                            </View>
                          )}
                        </View>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text style={{ fontSize: 11, color: themeColors.textMuted }}>
                            {hasBackendMeals ? `${displayLoggedCount} logged` : `${checkedCount}/${meals.length || '–'} logged`}
                          </Text>
                          <Ionicons name={isExpanded ? 'chevron-down' : 'chevron-forward'} size={14} color={themeColors.textMuted} />
                        </View>
                      </View>
                      {(backendRow || meals.length > 0) && (
                        <Text style={{ fontSize: 12, color: themeColors.textSecondary, marginTop: 4 }}>
                          {Math.round(displayTotals.cal)} cal · {Math.round(displayTotals.pro)}g P · {Math.round(displayTotals.carb)}g C · {Math.round(displayTotals.fat)}g F
                          {targets?.calories ? ` · target ${formatNutritionPrimaryTarget('calories', targets.calories)}` : ''}
                        </Text>
                      )}
                    </Pressable>
                    {isExpanded && (
                      <View style={{ borderTopWidth: 1, borderTopColor: themeColors.border, padding: 12, gap: 8 }}>
                        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                          <TouchableOpacity
                            testID={`meal-history-row-${historyIdx}-add-meal`}
                            accessibilityLabel={`Add meal to ${label}`}
                            onPress={() => handleAddSnack(d)}
                            style={{
                              flexDirection: 'row', alignItems: 'center', gap: 5,
                              paddingHorizontal: 10, paddingVertical: 7,
                              borderRadius: 10, backgroundColor: mealPalette.strong,
                            }}>
                            <Ionicons name="add" size={14} color={getContrastingTextColor(mealPalette.strong)} />
                            <Text style={{ color: getContrastingTextColor(mealPalette.strong), fontSize: 11, fontWeight: '800' }}>Add meal</Text>
                          </TouchableOpacity>
                          {authToken && (
                            <TouchableOpacity
                              testID={`meal-history-row-${historyIdx}-add-favorite`}
                              accessibilityLabel={`Add favorite meal to ${label}`}
                              onPress={() => openAddFromSavedForDate(d)}
                              style={{
                                flexDirection: 'row', alignItems: 'center', gap: 5,
                                paddingHorizontal: 10, paddingVertical: 7,
                                borderRadius: 10, borderWidth: 1, borderColor: themeColors.border,
                                backgroundColor: themeColors.surface,
                              }}>
                              <Ionicons name="bookmark-outline" size={14} color={mealPalette.strong} />
                              <Text style={{ color: themeColors.textPrimary, fontSize: 11, fontWeight: '800' }}>Favorites</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                        {meals.length === 0 && (
                          <Text style={{ fontSize: 12, color: themeColors.textMuted }}>
                            No meals logged for this day yet.
                          </Text>
                        )}
                        {meals.map((m, i) => {
                          const historyMealId = Number((m as any)._loggedMealId || 0) || undefined;
                          const mealType = hasBackendMeals && historyMealId ? `history_${historyMealId}` : `meal_${i}`;
                          const ate = hasBackendMeals ? true : !!checks[mealType];
                          const macros = macroTotalsFromMeal(m);
                          const loggedTime = loggedMealTimeLabel(m);
                          const openMealEditor = () => setEditingMeal({ dateKey: d, type: mealType, meal: m, historyMealId });
                          const isSavedFavorite = isSavedFavoriteMeal(m);
                          return (
                            <View
                              key={(m as any)._localId ?? `${d}-${i}`}
                              testID={`meal-history-row-${historyIdx}-meal-${i}`}
                              accessibilityLabel={`meal-history-row-${historyIdx}-meal-${i}`}
                              style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                              <TouchableOpacity
                                disabled={hasBackendMeals}
                                onPress={() => handleToggleMeal(d, mealType)}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                style={{
                                  width: 22, height: 22, borderRadius: 11,
                                  alignItems: 'center', justifyContent: 'center',
                                  borderWidth: 2,
                                  borderColor: ate ? mealPalette.strong : themeColors.border,
                                  backgroundColor: ate ? mealPalette.strong : 'transparent',
                                }}>
                                {ate && <Ionicons name="checkmark" size={12} color={getContrastingTextColor(mealPalette.strong)} />}
                              </TouchableOpacity>
                              <TouchableOpacity
                                style={{ flex: 1 }}
                                onPress={openMealEditor}>
                                <Text style={{ fontSize: 13, fontWeight: '600', color: themeColors.textPrimary }} numberOfLines={1}>{m.meal}</Text>
                                <Text style={{ fontSize: 10, color: themeColors.textMuted, marginTop: 1 }}>
                                  {loggedTime ? `${loggedTime} · ` : ''}{macros.calories} cal · {macros.protein}g P · {macros.carbs}g C · {macros.fat}g F
                                </Text>
                              </TouchableOpacity>
                              {(!hasBackendMeals || historyMealId) && (
                                <TouchableOpacity
                                  onPress={openMealEditor}
                                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                  <Ionicons name="create-outline" size={18} color={mealPalette.strong} />
                                </TouchableOpacity>
                              )}
                              {authToken && (
                                <TouchableOpacity
                                  accessibilityLabel={isSavedFavorite ? `Remove ${m.meal} from favorites` : `Add ${m.meal} to favorites`}
                                  testID={`meal-history-row-${historyIdx}-meal-${i}-favorite`}
                                  onPress={() => { void handleToggleSaveMeal(mealType, m); }}
                                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                  <Ionicons
                                    name={isSavedFavorite ? 'bookmark' : 'bookmark-outline'}
                                    size={18}
                                    color={isSavedFavorite ? mealPalette.strong : themeColors.textMuted}
                                  />
                                </TouchableOpacity>
                              )}
                              <TouchableOpacity
                                accessibilityLabel={historyMealId ? `Log ${m.meal} again` : `Duplicate ${m.meal}`}
                                testID={`meal-history-row-${historyIdx}-meal-${i}-duplicate`}
                                onPress={() => {
                                  const targetDate = historyMealId && d !== todayKey() ? todayKey() : d;
                                  handleDuplicateMeal(targetDate, mealType, m);
                                }}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                <Ionicons name="copy-outline" size={18} color={themeColors.textMuted} />
                              </TouchableOpacity>
                              <TouchableOpacity
                                accessibilityLabel={`Split ${m.meal}`}
                                testID={`meal-history-row-${historyIdx}-meal-${i}-split`}
                                onPress={() => handleSplitMeal(d, mealType, m)}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                <Ionicons name="git-branch-outline" size={18} color={themeColors.textMuted} />
                              </TouchableOpacity>
                              <TouchableOpacity
                                onPress={() => {
                                  Alert.alert(
                                    'Delete meal?',
                                    hasBackendMeals && historyMealId
                                      ? `Remove "${m.meal}" from this day's history? This recalculates calories and macros for ${label}.`
                                      : `Remove "${m.meal}" from this day's log? You can re-check it from the Plan tab anytime.`,
                                    [
                                      { text: 'Cancel', style: 'cancel' },
                                      {
                                        text: 'Delete',
                                        style: 'destructive',
                                        onPress: async () => {
                                          if (hasBackendMeals && historyMealId && authToken) {
                                            await handleBackendMealDelete(d, historyMealId, m);
                                          } else {
                                            handleToggleMeal(d, mealType);
                                          }
                                        },
                                      },
                                    ],
                                  );
                                }}
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                                <Ionicons name="trash-outline" size={18} color={themeColors.textMuted} />
                              </TouchableOpacity>
                            </View>
                          );
                        })}
                      </View>
                    )}
                  </View>
                );
              })}
            </FadeInView>
          );
        })()}

        {mealsSubTab === 'plan' && (
          <HomeMealsPlanTab
            authToken={authToken}
            userProfile={userProfile}
            mealDays={mealDays}
            selectedMealDayKey={selectedMealDayKey}
            checkedMealsByDate={checkedMealsByDate}
            backendMealDailyByDate={backendMealDailyByDate}
            backendMealSuggestionsByDate={backendMealSuggestionsByDate}
            mealHistoryLoading={mealHistoryLoading}
            visualHydrating={shouldHoldMealPlanForVisualSync({
              authToken,
              mealPlanHydrating,
              mealHistoryHydrated,
              mealHistoryLoading,
              hasVisibleMealPlan: Object.keys(nutritionPlansByDate).length > 0,
            })}
            nutritionPlansByDate={nutritionPlansByDate}
            planWeek={planWeek}
            isFreeTier={isFreeTier}
            isLightTheme={isLightTheme}
            themeColors={themeColors}
            mealPalette={mealPalette}
            mealPlanCardRefs={mealPlanCardRefs}
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
            dayNames={dayNames}
            mealsAccent={mealPalette.strong}
            WeekStripComponent={WeekStripComponent}
            mealDayLabel={mealDayLabel}
            onSelectMealDay={setSelectedMealDayKey}
            refreshHydration={refreshHydration}
            selectMealsSubTab={selectMealsSubTab}
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
            onSavedMealLogged={onSavedMealLoggedToPlan}
            onSavedMealChanged={onSavedMealChanged}
            reloadSavedMeals={reloadSavedMeals}
            handleSavedMealTemplateUpdated={handleSavedMealTemplateUpdated}
            onEditSavedMealTemplate={onEditSavedMealTemplate}
          />
        )}
      </Animated.View>
    </TabDragWrapper>
  );
}

export default memo(MealsScreenInner);
