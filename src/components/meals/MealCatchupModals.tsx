import React from 'react';
import { Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { MealSuggestion } from '../../types';
import { getContrastingTextColor, getTheme } from '../../constants/theme';
import { macroTotalsFromMeal } from '../../utils/mealItems';

type ThemeColors = ReturnType<typeof getTheme>['colors'];

export type MealReviewPromptState = {
  date: string;
  reason: string;
  details: string;
} | null;

export type UnloggedPromptState = {
  date: string;
  items: Array<{ mealType: string; meal: MealSuggestion }>;
  chosen: Record<string, boolean>;
} | null;

export function MealReviewPromptModal({
  prompt,
  themeColors,
  onDismiss,
  onReviewHistory,
}: {
  prompt: MealReviewPromptState;
  themeColors: ThemeColors;
  onDismiss: () => void | Promise<void>;
  onReviewHistory: () => void | Promise<void>;
}) {
  return (
    <Modal
      visible={!!prompt}
      transparent
      animationType="fade"
      onRequestClose={() => { void onDismiss(); }}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.58)', justifyContent: 'center', padding: 22 }}>
        {prompt && (
          <View style={{
            backgroundColor: themeColors.surface,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: themeColors.border,
            padding: 18,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <View style={{
                width: 38, height: 38, borderRadius: 19,
                backgroundColor: themeColors.warning + '22',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons name="analytics-outline" size={19} color={themeColors.warning} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 16, fontWeight: '900', color: themeColors.textPrimary }}>
                  Review yesterday?
                </Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                  {prompt.details}
                </Text>
              </View>
            </View>
            <Text style={{ fontSize: 13, lineHeight: 19, color: themeColors.textSecondary }}>
              {prompt.reason}. If that day is accurate, you are all set. If food is missing or off, update it in history.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }}
                onPress={() => { void onDismiss(); }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: themeColors.textSecondary }}>Looks right</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1.25, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: themeColors.primary }}
                onPress={() => { void onReviewHistory(); }}>
                <Text style={{ fontSize: 13, fontWeight: '900', color: themeColors.background }}>Review history</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

export function UnloggedMealsPromptModal({
  prompt,
  themeColors,
  mealPalette,
  onDismiss,
  onAddMeal,
  onMarkAllEaten,
  onSkipAll,
  onToggleMeal,
  onEditMeal,
  onSave,
}: {
  prompt: UnloggedPromptState;
  themeColors: ThemeColors;
  mealPalette: { strong: string };
  onDismiss: () => void | Promise<void>;
  onAddMeal: () => void | Promise<void>;
  onMarkAllEaten: () => void | Promise<void>;
  onSkipAll: () => void | Promise<void>;
  onToggleMeal: (mealType: string) => void;
  onEditMeal: (item: { mealType: string; meal: MealSuggestion }) => void | Promise<void>;
  onSave: () => void | Promise<void>;
}) {
  return (
    <Modal
      visible={!!prompt}
      transparent
      animationType="slide"
      onRequestClose={() => { void onDismiss(); }}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' }}>
        {prompt && (
          <View style={{
            backgroundColor: themeColors.surface,
            borderTopLeftRadius: 24, borderTopRightRadius: 24,
            borderTopWidth: 1, borderTopColor: themeColors.border,
            height: '92%',
          }}>
            <View style={{ alignItems: 'center', paddingTop: 10 }}>
              <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: themeColors.border }} />
            </View>
            <View style={{ alignItems: 'center', paddingTop: 16, paddingHorizontal: 22, paddingBottom: 8 }}>
              <View style={{
                width: 54, height: 54, borderRadius: 27,
                backgroundColor: mealPalette.strong + '22',
                alignItems: 'center', justifyContent: 'center',
                marginBottom: 10,
              }}>
                <Ionicons name="restaurant" size={24} color={mealPalette.strong} />
              </View>
              <Text style={{ fontSize: 22, fontWeight: '900', color: themeColors.textPrimary, textAlign: 'center' }}>
                Catch up on yesterday
              </Text>
              <Text style={{ fontSize: 13, color: themeColors.textSecondary, textAlign: 'center', marginTop: 6, lineHeight: 18 }}>
                {prompt.items.length === 0
                  ? 'Review yesterday in history if anything needs to be added or corrected.'
                  : `${prompt.items.length} meal${prompt.items.length === 1 ? ' wasn\'t' : 's weren\'t'} logged. Mark what you ate, edit anything that changed, or skip the rest.`}
              </Text>
            </View>
            <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 24, paddingTop: 14 }} showsVerticalScrollIndicator={false}>
              {prompt.items.length === 0 && (
                <View>
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => { void onAddMeal(); }}
                    style={{
                      padding: 18, borderRadius: 14,
                      backgroundColor: themeColors.surfaceRaised,
                      borderWidth: 1, borderColor: mealPalette.strong + '66',
                      alignItems: 'center', marginBottom: 10,
                    }}
                  >
                    <Ionicons name="add-circle-outline" size={32} color={mealPalette.strong} />
                    <Text style={{ fontSize: 15, fontWeight: '800', color: themeColors.textPrimary, marginTop: 8 }}>
                      Add a meal
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 4, textAlign: 'center' }}>
                      Opens the Foods tab so you can log what you actually ate.
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { void onDismiss(); }}
                    style={{ alignSelf: 'center', padding: 12 }}
                  >
                    <Text style={{ fontSize: 12, color: themeColors.textMuted }}>Skip for now</Text>
                  </TouchableOpacity>
                </View>
              )}

              {prompt.items.length > 0 && (<>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
                  <TouchableOpacity
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }}
                    onPress={() => { void onMarkAllEaten(); }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textSecondary }}>Mark all eaten</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center', backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }}
                    onPress={() => { void onSkipAll(); }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: themeColors.textSecondary }}>Skip all</Text>
                  </TouchableOpacity>
                </View>

                {prompt.items.map(it => {
                  const ate = !!prompt.chosen[it.mealType];
                  const macros = macroTotalsFromMeal(it.meal);
                  return (
                    <View
                      key={it.mealType}
                      style={{
                        padding: 12, marginBottom: 10,
                        backgroundColor: themeColors.surfaceRaised, borderRadius: 12,
                        borderWidth: 1, borderColor: ate ? mealPalette.strong + '77' : themeColors.border,
                      }}>
                      <TouchableOpacity
                        activeOpacity={0.8}
                        onPress={() => onToggleMeal(it.mealType)}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                        <View style={{
                          width: 24, height: 24, borderRadius: 12,
                          alignItems: 'center', justifyContent: 'center',
                          borderWidth: 2,
                          borderColor: ate ? mealPalette.strong : themeColors.border,
                          backgroundColor: ate ? mealPalette.strong : 'transparent',
                        }}>
                          {ate && <Ionicons name="checkmark" size={14} color={getContrastingTextColor(mealPalette.strong)} />}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '600', color: themeColors.textPrimary }}>{it.meal.meal}</Text>
                          <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                            {macros.calories} cal · {macros.protein}g P
                          </Text>
                        </View>
                        <Text style={{ fontSize: 11, fontWeight: '700', color: ate ? mealPalette.strong : themeColors.textMuted }}>
                          {ate ? 'ATE' : 'SKIP'}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        activeOpacity={0.7}
                        onPress={() => { void onEditMeal(it); }}
                        style={{
                          marginTop: 10, alignSelf: 'flex-start',
                          paddingHorizontal: 10, paddingVertical: 5,
                          borderRadius: 6,
                          backgroundColor: themeColors.surface,
                          borderWidth: 1, borderColor: themeColors.border,
                        }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                          <Ionicons name="pencil-outline" size={11} color={themeColors.textSecondary} />
                          <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.textSecondary }}>
                            Edit this meal
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </View>
                  );
                })}

                <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                  <TouchableOpacity
                    style={{ flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: themeColors.surfaceRaised, borderWidth: 1, borderColor: themeColors.border }}
                    onPress={() => { void onDismiss(); }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: themeColors.textSecondary }}>Not now</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ flex: 2, paddingVertical: 13, borderRadius: 12, alignItems: 'center', backgroundColor: themeColors.primary }}
                    onPress={() => { void onSave(); }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: themeColors.background }}>Save</Text>
                  </TouchableOpacity>
                </View>
              </>)}
            </ScrollView>
          </View>
        )}
      </View>
    </Modal>
  );
}
