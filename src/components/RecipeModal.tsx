/**
 * RecipeModal — on-demand prep instructions for a single meal.
 *
 * Opened from the meal card's "🍳 Recipe" button. Fetches a recipe from
 * /ai/meal-instructions on first open, caches the result on the meal,
 * and supports a "Try another way" button that asks the AI for a
 * different preparation of the same ingredients.
 *
 * Caching:
 *   - First variation lands in `meal.instructions` (legacy field, kept
 *     for backwards compat with existing callers / editor modal).
 *   - Subsequent variations land in `meal.instructionVariants[]`.
 *   - When the modal closes with onPersist, all variants are saved so
 *     re-opening the modal later doesn't re-fetch.
 *
 * Cost model: ~$0.0001 per fetch (gpt-4o-mini, ~400 output tokens).
 * Zero cost during plan generation — only fires on user tap.
 */
import { useEffect, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, ActivityIndicator, Alert, StyleSheet,
} from 'react-native';
import { MealSuggestion, AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';
import { getMealInstructions } from '../services/api';

interface Props {
  visible: boolean;
  meal: MealSuggestion | null;
  authToken?: string;
  themeName?: AppThemeName;
  cookingSkill?: string;
  prepTimeMinutes?: number;
  dietaryPreference?: string;
  allergies?: string[];
  onClose: () => void;
  /** Persist the fetched variants back to the meal. Called with the full
   *  variant list so the caller can decide how to merge into plan state. */
  onPersist?: (updated: MealSuggestion) => void;
}

export default function RecipeModal({
  visible, meal, authToken, themeName, cookingSkill, prepTimeMinutes,
  dietaryPreference, allergies, onClose, onPersist,
}: Props) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const styles = createStyles(colors);

  // Seed variants from the meal's existing cache on open.
  const [variants, setVariants] = useState<string[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!visible || !meal) return;
    // Pull cached variants. `instructionVariants` is the canonical array;
    // `instructions` is the legacy single-string field that holds the
    // first variant (kept so old code paths still work).
    const cached = meal.instructionVariants && meal.instructionVariants.length > 0
      ? meal.instructionVariants
      : (meal.instructions ? [meal.instructions] : []);
    setVariants(cached);
    setCurrentIdx(cached.length > 0 ? 0 : -1);
    // If nothing cached yet, kick off a fetch immediately so the user
    // sees content as soon as the modal is visible.
    if (cached.length === 0) {
      void fetchVariant([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, meal]);

  const fetchVariant = async (existing: string[]) => {
    if (!meal || !authToken) return;
    setLoading(true);
    try {
      const res = await getMealInstructions(authToken, {
        meal_name: meal.meal,
        items: (meal.items ?? []).map(it => ({
          name: it.name, quantity: it.quantity, unit: it.unit,
        })),
        cooking_skill: cookingSkill,
        prep_time_minutes: prepTimeMinutes,
        dietary_preference: dietaryPreference,
        allergies,
        previous_variants: existing,
      });
      const next = [...existing, res.instructions];
      setVariants(next);
      setCurrentIdx(next.length - 1);
    } catch (e: any) {
      Alert.alert('Could not load recipe', e?.message ?? 'Try again in a moment.');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (onPersist && meal && variants.length > 0) {
      onPersist({
        ...meal,
        instructions: variants[0],            // legacy cache
        instructionVariants: variants,        // canonical
      });
    }
    onClose();
  };

  if (!meal) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.headerBtn}>Done</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>
            🍳  {meal.meal}
          </Text>
          <View style={{ width: 50 }} />
        </View>

        {loading && variants.length === 0 ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.loadingText}>Writing a recipe…</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {/* Variant pager header — only shown once there's >1 variant */}
            {variants.length > 1 && (
              <View style={styles.pagerRow}>
                {variants.map((_, i) => (
                  <TouchableOpacity
                    key={i}
                    onPress={() => setCurrentIdx(i)}
                    style={[
                      styles.pagerDot,
                      i === currentIdx && { backgroundColor: colors.accent },
                    ]}>
                    <Text style={[
                      styles.pagerDotText,
                      i === currentIdx && { color: '#fff' },
                    ]}>
                      {i + 1}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {currentIdx >= 0 && variants[currentIdx] ? (
              <Text style={styles.body}>{variants[currentIdx]}</Text>
            ) : (
              <Text style={styles.body}>No recipe yet.</Text>
            )}

            <TouchableOpacity
              onPress={() => fetchVariant(variants)}
              disabled={loading}
              style={styles.tryAnotherBtn}>
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.tryAnotherText}>
                  {variants.length === 0 ? 'Generate recipe' : 'Try another way'}
                </Text>
              )}
            </TouchableOpacity>

            {variants.length > 1 && (
              <Text style={styles.hint}>
                Tap a number above to switch between saved recipes. Each new
                variation uses the same ingredients but a different technique.
              </Text>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function createStyles(colors: ReturnType<typeof getTheme>['colors']) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.surfaceRaised,
    },
    headerBtn: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.accent,
      width: 50,
    },
    title: {
      flex: 1,
      fontSize: 16,
      fontWeight: '700',
      color: colors.textPrimary,
      textAlign: 'center',
      paddingHorizontal: 8,
    },
    loadingWrap: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    loadingText: {
      fontSize: 13,
      color: colors.textSecondary,
    },
    scroll: {
      padding: 20,
      gap: 18,
    },
    pagerRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 4,
    },
    pagerDot: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
    },
    pagerDotText: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textSecondary,
    },
    body: {
      fontSize: 15,
      lineHeight: 22,
      color: colors.textPrimary,
    },
    tryAnotherBtn: {
      marginTop: 6,
      paddingVertical: 14,
      paddingHorizontal: 20,
      borderRadius: radius.md,
      backgroundColor: colors.accent,
      alignItems: 'center',
    },
    tryAnotherText: {
      color: '#fff',
      fontWeight: '700',
      fontSize: 14,
    },
    hint: {
      fontSize: 12,
      color: colors.textMuted,
      textAlign: 'center',
      lineHeight: 17,
    },
  });
}
