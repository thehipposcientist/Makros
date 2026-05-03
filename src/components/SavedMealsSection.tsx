// Favorites section — reusable food bundles the user has explicitly saved.
//
// Distinct from Routine Meals (pinned/scheduled) and the auto-detected
// "common meals" carousel (meals eaten 2+ times). A Favorite is an
// explicit "I want to be able to log this again with one tap" bundle.

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, Alert, ActivityIndicator,
  Modal, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme } from '../constants/theme';
import { AppThemeName } from '../types';
import MealTimeSelector, { defaultMealDateTime } from './MealTimeSelector';
import * as api from '../services/api';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** Called after a saved meal is logged so the parent can refresh the
   *  day's meal list. */
  onLogged?: (log: { mealId: number; saved: api.SavedMeal; meal_date: string; meal_type: string; consumed_at: string }) => void;
  /** Open the template-mode MealEditModal for a saved meal. The parent
   *  handles the modal wiring + the PATCH call so this component stays
   *  focused on list/log concerns. Called with the raw SavedMeal row
   *  so the parent can hydrate the editor with current items. */
  onEditTemplate?: (saved: api.SavedMeal) => void;
}

const MEAL_TYPE_OPTIONS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'snack', label: 'Snack' },
  { key: 'pre_workout', label: 'Pre-workout' },
  { key: 'post_workout', label: 'Post-workout' },
] as const;

/** Pick a sensible default meal_type by current time-of-day so the
 *  user doesn't have to choose on every log. */
function defaultMealTypeByHour(): string {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 14) return 'lunch';
  if (h < 17) return 'snack';
  if (h < 21) return 'dinner';
  return 'snack';
}

function dateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export default function SavedMealsSection({ authToken, themeName, onLogged, onEditTemplate }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [saved, setSaved] = useState<api.SavedMeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<api.SavedMeal | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listSavedMeals(authToken);
      setSaved(rows);
    } catch {
      setSaved([]);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => { reload(); }, [reload]);

  const handleDelete = (sm: api.SavedMeal) => {
    Alert.alert(
      'Remove from favorites?',
      `"${sm.name}" will be removed from your favorites. Meals you already logged from it stay on your history.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            try { await api.deleteSavedMeal(authToken, sm.id); reload(); }
            catch (e: any) { Alert.alert('Could not delete', String(e?.message ?? e)); }
          },
        },
      ],
    );
  };

  const handleActions = (sm: api.SavedMeal) => {
    // Action sheet — long-press or ⋯ opens this. Makes edit semantics
    // explicit: editing from here changes the TEMPLATE, not past
    // logged meals (those are snapshots, unchanged).
    const buttons: any[] = [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Rename', onPress: () => promptRename(sm) },
    ];
    if (onEditTemplate) {
      buttons.push({ text: 'Edit items', onPress: () => onEditTemplate(sm) });
    }
    buttons.push({ text: 'Delete', style: 'destructive', onPress: () => handleDelete(sm) });
    Alert.alert(sm.name, 'What do you want to do with this favorite?', buttons);
  };

  const promptRename = (sm: api.SavedMeal) => {
    // Alert.prompt is iOS-only; on Android we keep it simple and
    // fall back to a plain alert pointing the user at the rename flow
    // via the meal editor (we can build a cross-platform modal later).
    const prompt = (Alert as any).prompt;
    if (typeof prompt === 'function') {
      prompt(
        'Rename favorite',
        'Editing here updates the template — past days that used it stay unchanged.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save',
            onPress: async (newName?: string) => {
              if (!newName || !newName.trim()) return;
              try {
                await api.updateSavedMeal(authToken, sm.id, { name: newName.trim() });
                reload();
              } catch (e: any) {
                Alert.alert('Could not rename', String(e?.message ?? e));
              }
            },
          },
        ],
        'plain-text',
        sm.name,
      );
    } else {
      Alert.alert('Rename', 'Renaming from Android coming soon — delete and re-save for now.');
    }
  };

  if (loading && saved.length === 0) {
    return (
      <View style={{ padding: 14 }}>
        <ActivityIndicator size="small" color={tc.primary} />
      </View>
    );
  }

  return (
    <View style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>FAVORITES</Text>
        {saved.length > 0 && (
          <Text style={{ fontSize: 10, color: tc.textMuted }}>{saved.length}</Text>
        )}
      </View>
      {saved.length === 0 ? (
        <View style={{
          backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
          borderStyle: 'dashed', borderRadius: 12, padding: 14,
        }}>
          <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary, marginBottom: 2 }}>
            No favorites yet
          </Text>
          <Text style={{ fontSize: 11, color: tc.textMuted, lineHeight: 16 }}>
            Tap "Save" on any meal card or "Add to Favorites" in the meal editor. Favorites live here for one-tap logging anytime.
          </Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast">
          {saved.map(sm => (
            <View
              key={sm.id}
              style={{
                backgroundColor: tc.surface, borderRadius: 12, padding: 12, marginRight: 8,
                borderWidth: 1, borderColor: tc.border,
                minWidth: 180, maxWidth: 210,
                position: 'relative',
              }}
            >
              <TouchableOpacity
                activeOpacity={0.8}
                onLongPress={() => handleActions(sm)}
                onPress={() => setTarget(sm)}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary, flex: 1, paddingRight: 22 }} numberOfLines={1}>
                    {sm.name}
                  </Text>
                </View>
                <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                  {Math.round(sm.total_calories)} cal · {Math.round(sm.total_protein_g)}g protein
                </Text>
                <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>
                  {sm.items.length} item{sm.items.length === 1 ? '' : 's'}
                  {sm.times_logged > 0 ? ` · logged ${sm.times_logged}x` : ''}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
                  <Ionicons name="add-circle" size={14} color={tc.primary} />
                  <Text style={{ fontSize: 11, fontWeight: '700', color: tc.primary }}>
                    Log to today
                  </Text>
                </View>
              </TouchableOpacity>
              {/* Actions affordance — rename/delete the TEMPLATE.
                  Long-press also opens this. Tap target is a
                  dedicated corner button so users discover edit
                  without accidentally triggering it. */}
              <TouchableOpacity
                onPress={() => handleActions(sm)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={{
                  position: 'absolute', top: 6, right: 6,
                  width: 22, height: 22, borderRadius: 11,
                  alignItems: 'center', justifyContent: 'center',
                }}
                accessibilityRole="button"
                accessibilityLabel={`More actions for ${sm.name}`}
              >
                <Ionicons name="ellipsis-horizontal" size={14} color={tc.textMuted} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <LogSavedMealModal
        saved={target}
        authToken={authToken}
        themeName={themeName}
        onClose={() => setTarget(null)}
        onLogged={(log) => { setTarget(null); reload(); Promise.resolve(onLogged?.(log)).catch(() => {}); }}
      />
    </View>
  );
}


// ─── Quick-log modal ──────────────────────────────────────────────────

function LogSavedMealModal({
  saved, authToken, themeName, onClose, onLogged,
}: {
  saved: api.SavedMeal | null;
  authToken: string;
  themeName?: AppThemeName;
  onClose: () => void;
  onLogged: (log: { mealId: number; saved: api.SavedMeal; meal_date: string; meal_type: string; consumed_at: string }) => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const [mealType, setMealType] = useState<string>(defaultMealTypeByHour());
  const [consumedAt, setConsumedAt] = useState<Date>(() => defaultMealDateTime());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (saved) {
      setMealType(defaultMealTypeByHour());
      setConsumedAt(defaultMealDateTime());
    }
  }, [saved]);

  const handleLog = async () => {
    if (!saved) return;
    setSubmitting(true);
    try {
      const mealDate = dateKey(consumedAt);
      const consumedAtISO = consumedAt.toISOString();
      const r = await api.logSavedMeal(authToken, saved.id, {
        meal_date: mealDate,
        meal_type: mealType,
        consumed_at: consumedAtISO,
      });
      onLogged({ mealId: r.meal_id, saved, meal_date: mealDate, meal_type: mealType, consumed_at: consumedAtISO });
    } catch (e: any) {
      Alert.alert('Could not log', String(e?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={!!saved} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background, borderTopLeftRadius: 20, borderTopRightRadius: 20,
          padding: 16, paddingBottom: 30, maxHeight: '80%',
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                Log {saved?.name}
              </Text>
              <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }}>
                {saved ? `${Math.round(saved.total_calories)} cal · ${Math.round(saved.total_protein_g)}g P · ${Math.round(saved.total_carbs_g)}g C · ${Math.round(saved.total_fat_g)}g F` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
              LOG AS
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {MEAL_TYPE_OPTIONS.map(opt => {
                const active = mealType === opt.key;
                return (
                  <TouchableOpacity
                    key={opt.key}
                    onPress={() => setMealType(opt.key)}
                    style={{
                      backgroundColor: active ? tc.primary : tc.surface,
                      borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                      borderRadius: 14, paddingVertical: 7, paddingHorizontal: 11,
                    }}
                  >
                    <Text style={{
                      fontSize: 12, fontWeight: '700',
                      color: active ? getContrastingTextColor(tc.primary) : tc.textPrimary,
                    }}>{opt.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={{ marginBottom: 14 }}>
              <MealTimeSelector
                value={consumedAt}
                colors={tc}
                onChange={setConsumedAt}
              />
            </View>

            <Text style={{ fontSize: 11, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
              ITEMS ({saved?.items.length ?? 0})
            </Text>
            <View style={{ backgroundColor: tc.surface, borderRadius: 10, padding: 10, marginBottom: 16, borderWidth: 1, borderColor: tc.border }}>
              {(saved?.items ?? []).map((it, i) => (
                <View key={`${it.food_name}-${i}`} style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingVertical: 4,
                  borderBottomWidth: i < (saved?.items.length ?? 0) - 1 ? 1 : 0,
                  borderBottomColor: tc.border + '66',
                }}>
                  <Text style={{ fontSize: 12, color: tc.textPrimary, flex: 1 }} numberOfLines={1}>
                    {it.food_name}
                  </Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>
                    {it.quantity} {it.unit} · {Math.round(it.calories)} cal
                  </Text>
                </View>
              ))}
            </View>

            <TouchableOpacity
              onPress={handleLog}
              disabled={submitting}
              style={{
                backgroundColor: submitting ? tc.border : tc.primary,
                paddingVertical: 12, borderRadius: 10,
                alignItems: 'center',
              }}
            >
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>
                  Log to today
                </Text>
              )}
            </TouchableOpacity>

            <Text style={{ fontSize: 10, color: tc.textMuted, textAlign: 'center', marginTop: 10 }}>
              Tip: long-press a saved meal card to delete it.
            </Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
