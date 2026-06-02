// Favorites section — reusable food bundles the user has explicitly saved.
//
// Distinct from Routine Meals (pinned/scheduled) and the auto-detected
// "common meals" carousel (meals eaten 2+ times). A Favorite is an
// explicit "I want to be able to log this again with one tap" bundle.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, Alert, ActivityIndicator,
  Modal, ScrollView, Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme } from '../constants/theme';
import { AppThemeName } from '../types';
import MealTimeSelector, { defaultMealDateTime } from './MealTimeSelector';
import MealThumbnail from './MealThumbnail';
import SavedMealImportModal from './SavedMealImportModal';
import * as api from '../services/api';
import { savedMealLogIdempotencyKey } from '../services/mealMutationKeys';
import { mealImageAssetUri } from '../utils/foodImage';
import { buildSuggestedMeals, type SuggestedMeal } from '../utils/suggestedMeals';

interface Props {
  authToken: string;
  themeName?: AppThemeName;
  /** Called after a saved meal is logged so the parent can refresh the
   *  day's meal list. */
  onLogged?: (log: { mealId: number; saved: api.SavedMeal; meal_date: string; meal_type: string; consumed_at: string }) => void | Promise<void>;
  /** Called when a previously logged favorite is removed through Undo. */
  onChanged?: (change?: { action?: 'deleted'; mealId?: number }) => void | Promise<void>;
  /** Called after a saved-meal template changes so the parent can refresh
   *  the saved library while logged meal snapshots stay untouched. */
  onTemplateUpdated?: (updated: api.SavedMeal, previous: api.SavedMeal) => void | Promise<void>;
  /** Open the template-mode MealEditModal for a saved meal. The parent
   *  handles the modal wiring + the PATCH call so this component stays
   *  focused on list/log concerns. Called with the raw SavedMeal row
   *  so the parent can hydrate the editor with current items. */
  onEditTemplate?: (saved: api.SavedMeal) => void;
  /** Bumped by the parent whenever the saved-meal library mutates from
   *  outside this component (e.g. user starred a meal in today's plan).
   *  Triggers a re-fetch so the favorites carousel reflects the change
   *  immediately instead of going stale until the section remounts. */
  refreshKey?: number;
  /** Opens the app-level import sheet. If omitted, this component keeps
   *  a local import sheet so the section is still usable standalone. */
  onImportSavedMeal?: () => void;
  /** Parent library cache needs a nudge after import/delete/share changes. */
  onLibraryChanged?: () => void | Promise<void>;
  foodsAvailable?: string[];
  dietaryPreference?: string | null;
  allergies?: string[];
  goal?: string | null;
}

const MEAL_TYPE_OPTIONS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'snack', label: 'Snack' },
  { key: 'pre_workout', label: 'Pre-workout' },
  { key: 'post_workout', label: 'Post-workout' },
] as const;

function e2eId(value: string | number | null | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

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

export default function SavedMealsSection({
  authToken,
  themeName,
  onLogged,
  onChanged,
  onTemplateUpdated,
  onEditTemplate,
  refreshKey = 0,
  onImportSavedMeal,
  onLibraryChanged,
  foodsAvailable = [],
  dietaryPreference,
  allergies = [],
  goal,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [saved, setSaved] = useState<api.SavedMeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [target, setTarget] = useState<api.SavedMeal | null>(null);
  const [suggestionTarget, setSuggestionTarget] = useState<SuggestedMeal | null>(null);
  const [quickLoggingId, setQuickLoggingId] = useState<number | null>(null);
  const [savingSuggestionId, setSavingSuggestionId] = useState<string | null>(null);
  const [undoTarget, setUndoTarget] = useState<{ mealId: number; name: string } | null>(null);
  const [localImportOpen, setLocalImportOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickLogInFlightRef = useRef<number | null>(null);

  const suggestedMeals = useMemo(() => buildSuggestedMeals({
    foodsAvailable,
    dietaryPreference,
    allergies,
    goal,
    existingMealNames: saved.map(row => row.name),
    limit: 8,
  }), [allergies, dietaryPreference, foodsAvailable, goal, saved]);

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

  // Re-fetch on mount AND whenever the parent bumps `refreshKey`. The
  // section's `saved` state is local, so without this nudge it stays
  // stale until the section remounts (which currently means the user
  // has to navigate away and back to see a freshly-starred meal).
  useEffect(() => { reload(); }, [reload, refreshKey]);

  useEffect(() => {
    if (saved.length === 0 && managing) setManaging(false);
  }, [managing, saved.length]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    };
  }, []);

  const armUndo = useCallback((next: { mealId: number; name: string }) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndoTarget(next);
    undoTimerRef.current = setTimeout(() => {
      setUndoTarget(current => current?.mealId === next.mealId ? null : current);
      undoTimerRef.current = null;
    }, 8000);
  }, []);

  const handleQuickLog = useCallback(async (sm: api.SavedMeal) => {
    if (quickLogInFlightRef.current != null) return;
    quickLogInFlightRef.current = sm.id;
    setQuickLoggingId(sm.id);
    try {
      const consumedAt = defaultMealDateTime();
      const mealDate = dateKey(consumedAt);
      const mealType = defaultMealTypeByHour();
      const consumedAtISO = consumedAt.toISOString();
      const r = await api.logSavedMeal(authToken, sm.id, {
        meal_date: mealDate,
        meal_type: mealType,
        consumed_at: consumedAtISO,
        idempotency_key: savedMealLogIdempotencyKey(sm.id, mealDate, mealType, consumedAtISO),
      });
      await Promise.resolve(onLogged?.({
        mealId: r.meal_id,
        saved: sm,
        meal_date: mealDate,
        meal_type: mealType,
        consumed_at: consumedAtISO,
      })).catch(() => {});
      armUndo({ mealId: r.meal_id, name: sm.name });
      reload();
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    } catch (e: any) {
      Alert.alert('Could not log', String(e?.message ?? e));
    } finally {
      quickLogInFlightRef.current = null;
      setQuickLoggingId(null);
    }
  }, [armUndo, authToken, onLogged, quickLoggingId, reload]);

  const handleUndoLog = useCallback(async () => {
    const targetLog = undoTarget;
    if (!targetLog) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoTarget(null);
    try {
      await api.deleteLoggedMeal(authToken, targetLog.mealId);
      await Promise.resolve(onChanged?.({ action: 'deleted', mealId: targetLog.mealId })).catch(() => {});
      reload();
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    } catch (e: any) {
      setUndoTarget(targetLog);
      Alert.alert('Could not undo', String(e?.message ?? e));
    }
  }, [authToken, onChanged, reload, undoTarget]);

  const handleDelete = (sm: api.SavedMeal) => {
    Alert.alert(
      'Remove from favorites?',
      `"${sm.name}" will be removed from your favorites. Meals you already logged from it stay on your history.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            try {
              await api.deleteSavedMeal(authToken, sm.id);
              reload();
              await Promise.resolve(onLibraryChanged?.()).catch(() => {});
              if (saved.length <= 1) setManaging(false);
            }
            catch (e: any) { Alert.alert('Could not delete', String(e?.message ?? e)); }
          },
        },
      ],
    );
  };

  const handleShare = async (sm: api.SavedMeal) => {
    try {
      const { shareCode } = await api.shareSavedMeal(authToken, sm.id);
      reload();
      await Promise.resolve(onLibraryChanged?.()).catch(() => {});
      await Share.share({
        message: `Try my Thallo meal "${sm.name}" — share code: ${shareCode}\n\nOpen in app: thallo://meal/${shareCode}`,
      });
    } catch (e: any) {
      Alert.alert('Could not share', e?.message ?? 'Try again in a moment.');
    }
  };

  const handleSaveSuggestion = useCallback(async (suggestion: SuggestedMeal) => {
    if (savingSuggestionId) return;
    setSavingSuggestionId(suggestion.id);
    try {
      const { newIdempotencyKey } = await import('../services/mealMutationKeys');
      const created = await api.createSavedMeal(authToken, {
        name: suggestion.name,
        notes: suggestion.notes,
        items: suggestion.items,
        image_url: mealImageAssetUri(suggestion.imageAssetKey),
        image_source: 'asset',
        resolve_image: true,
        // Stable per (suggestion id, attempt) so a retry collapses on the
        // backend partial unique index instead of double-saving the card.
        idempotency_key: `suggestion:${suggestion.id}:${newIdempotencyKey('s').slice(2)}`,
      });
      setSaved(current => [created, ...current.filter(row => row.id !== created.id)]);
      setSuggestionTarget(null);
      await Promise.resolve(onLibraryChanged?.()).catch(() => {});
      await reload();
      import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});
    } catch (e: any) {
      Alert.alert('Could not save', String(e?.message ?? e));
    } finally {
      setSavingSuggestionId(null);
    }
  }, [authToken, onLibraryChanged, reload, savingSuggestionId]);

  const handleActions = (sm: api.SavedMeal) => {
    // Action sheet — long-press or ⋯ opens this. Editing here changes
    // the saved template for future logs only.
    const buttons: any[] = [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log with details', onPress: () => setTarget(sm) },
      { text: 'Share', onPress: () => handleShare(sm) },
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
        'Renaming updates this favorite for future logs. Meals already logged stay unchanged.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save',
            onPress: async (newName?: string) => {
              if (!newName || !newName.trim()) return;
              try {
                const updated = await api.updateSavedMeal(authToken, sm.id, { name: newName.trim() });
                await Promise.resolve(onTemplateUpdated?.(updated, sm)).catch(() => {});
                await Promise.resolve(onLibraryChanged?.()).catch(() => {});
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
    <View testID="saved-meals-section" style={{ marginBottom: 14 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>FAVORITES</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {saved.length > 0 && (
            <Text style={{ fontSize: 10, color: tc.textMuted }}>{saved.length}</Text>
          )}
          {saved.length > 0 && (
            <TouchableOpacity
              testID="saved-meal-manage-toggle"
              onPress={() => setManaging(v => !v)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              accessibilityRole="button"
              accessibilityLabel={managing ? 'Done managing favorite meals' : 'Manage favorite meals'}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 9,
                paddingVertical: 6,
                borderRadius: 999,
                backgroundColor: managing ? tc.primary + '18' : tc.surfaceRaised,
                borderWidth: 1,
                borderColor: managing ? tc.primary + '55' : tc.border,
              }}
            >
              <Ionicons name={managing ? 'checkmark' : 'options-outline'} size={15} color={managing ? tc.primary : tc.textSecondary} />
              <Text style={{ fontSize: 11, fontWeight: '800', color: managing ? tc.primary : tc.textPrimary }}>
                {managing ? 'Done' : 'Manage'}
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            testID="saved-meal-import-open"
            onPress={() => onImportSavedMeal ? onImportSavedMeal() : setLocalImportOpen(true)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button"
            accessibilityLabel="Import shared meal"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 9,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: tc.primary + '14',
              borderWidth: 1,
              borderColor: tc.primary + '55',
            }}
          >
            <Ionicons name="download-outline" size={16} color={tc.primary} />
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.primary }}>Import</Text>
          </TouchableOpacity>
        </View>
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
            Tap the star on any meal card or the Favorite chip in the meal editor. Favorites live here for one-tap logging anytime.
          </Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast">
          {saved.map((sm, idx) => (
            <View
              key={sm.id}
              testID={`saved-meal-card-${idx}`}
              style={{
                backgroundColor: tc.surface, borderRadius: 12, padding: 14, marginRight: 10,
                borderWidth: 1, borderColor: tc.border,
                minWidth: 218, maxWidth: 248,
                position: 'relative',
              }}
            >
              <TouchableOpacity
                testID={`saved-meal-log-open-${e2eId(sm.name)}`}
                accessibilityLabel={`saved-meal-log-open-${e2eId(sm.name)}`}
                activeOpacity={0.8}
                disabled={quickLoggingId === sm.id}
                onLongPress={() => handleActions(sm)}
                onPress={() => managing ? handleActions(sm) : handleQuickLog(sm)}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <MealThumbnail meal={sm} size="sm" />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary, paddingRight: 22 }} numberOfLines={1}>
                      {sm.name}
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                      {Math.round(sm.total_calories)} cal · {Math.round(sm.total_protein_g)}g protein
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>
                      {sm.items.length} item{sm.items.length === 1 ? '' : 's'}
                      {sm.times_logged > 0 ? ` · logged ${sm.times_logged}x` : ''}
                      {sm.source_owner_username ? ` · from @${sm.source_owner_username}` : ''}
                    </Text>
                  </View>
                </View>
              </TouchableOpacity>
              {managing ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
                  <TouchableOpacity
                    testID={`saved-meal-rename-${idx}`}
                    accessibilityLabel={`Rename ${sm.name}`}
                    onPress={() => promptRename(sm)}
                    activeOpacity={0.78}
                    style={{
                      flex: 1,
                      minHeight: 34,
                      borderRadius: 10,
                      backgroundColor: tc.surfaceRaised,
                      borderWidth: 1,
                      borderColor: tc.border,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 5,
                    }}>
                    <Ionicons name="pencil-outline" size={14} color={tc.textSecondary} />
                    <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textPrimary }}>Rename</Text>
                  </TouchableOpacity>
                  {onEditTemplate && (
                    <TouchableOpacity
                      testID={`saved-meal-edit-items-${idx}`}
                      accessibilityLabel={`Edit items for ${sm.name}`}
                      onPress={() => onEditTemplate(sm)}
                      activeOpacity={0.78}
                      style={{
                        flex: 1,
                        minHeight: 34,
                        borderRadius: 10,
                        backgroundColor: tc.surfaceRaised,
                        borderWidth: 1,
                        borderColor: tc.border,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                      }}>
                      <Ionicons name="list-outline" size={14} color={tc.textSecondary} />
                      <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textPrimary }}>Items</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    testID={`saved-meal-delete-${idx}`}
                    accessibilityLabel={`Delete ${sm.name}`}
                    onPress={() => handleDelete(sm)}
                    activeOpacity={0.78}
                    style={{
                      width: 36,
                      height: 34,
                      borderRadius: 10,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: (tc.error ?? '#EF4444') + '14',
                      borderWidth: 1,
                      borderColor: (tc.error ?? '#EF4444') + '55',
                    }}>
                    <Ionicons name="trash-outline" size={15} color={tc.error ?? '#EF4444'} />
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
                  <TouchableOpacity
                    testID={`saved-meal-log-now-${e2eId(sm.name)}`}
                    accessibilityLabel={`Log ${sm.name}`}
                    onPress={() => handleQuickLog(sm)}
                    disabled={quickLoggingId === sm.id}
                    activeOpacity={0.78}
                    style={{
                      flex: 1,
                      minHeight: 34,
                      borderRadius: 10,
                      backgroundColor: tc.primary + '16',
                      borderWidth: 1,
                      borderColor: tc.primary + '55',
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 5,
                    }}>
                    {quickLoggingId === sm.id ? (
                      <ActivityIndicator size="small" color={tc.primary} />
                    ) : (
                      <Ionicons name="add-circle" size={15} color={tc.primary} />
                    )}
                    <Text style={{ fontSize: 11, fontWeight: '800', color: tc.primary }}>
                      {quickLoggingId === sm.id ? 'Logging...' : 'Log'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    testID={`saved-meal-share-${idx}`}
                    accessibilityLabel={`Share ${sm.name}`}
                    onPress={() => handleShare(sm)}
                    activeOpacity={0.78}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: tc.surfaceRaised,
                      borderWidth: 1,
                      borderColor: tc.border,
                    }}>
                    <Ionicons name="share-outline" size={16} color={sm.share_code ? tc.primary : tc.textSecondary} />
                  </TouchableOpacity>
                </View>
              )}
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

      {suggestedMeals.length > 0 && (
        <View style={{ marginTop: saved.length === 0 ? 10 : 14 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textMuted, letterSpacing: 0.5 }}>SUGGESTED FOR YOU</Text>
            <Ionicons name="sparkles-outline" size={15} color={tc.textMuted} />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast">
            {suggestedMeals.map((suggestion, idx) => {
              const saving = savingSuggestionId === suggestion.id;
              const mealForImage = {
                name: suggestion.name,
                image_url: mealImageAssetUri(suggestion.imageAssetKey),
                image_source: 'asset',
                items: suggestion.items,
              };
              return (
                <View
                  key={suggestion.id}
                  testID={`suggested-meal-card-${idx}`}
                  style={{
                    backgroundColor: tc.surface,
                    borderRadius: 12,
                    padding: 14,
                    marginRight: 10,
                    borderWidth: 1,
                    borderColor: tc.border,
                    minWidth: 256,
                    maxWidth: 280,
                  }}
                >
                  <TouchableOpacity
                    activeOpacity={0.82}
                    onPress={() => setSuggestionTarget(suggestion)}
                    accessibilityRole="button"
                    accessibilityLabel={`View ${suggestion.name}`}
                    style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}
                  >
                    <MealThumbnail meal={mealForImage} size="md" />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                        {suggestion.name}
                      </Text>
                      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                        {suggestion.totalCalories} cal · {suggestion.totalProteinG}g protein
                      </Text>
                      <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                        {suggestion.reason}
                      </Text>
                    </View>
                  </TouchableOpacity>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 }}>
                    <TouchableOpacity
                      onPress={() => setSuggestionTarget(suggestion)}
                      activeOpacity={0.78}
                      style={{
                        flex: 1,
                        minHeight: 34,
                        borderRadius: 10,
                        backgroundColor: tc.surfaceRaised,
                        borderWidth: 1,
                        borderColor: tc.border,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        paddingHorizontal: 8,
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`View details for ${suggestion.name}`}
                    >
                      <Ionicons name="receipt-outline" size={14} color={tc.textSecondary} />
                      <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textPrimary }}>
                        View
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      testID={`suggested-meal-save-${e2eId(suggestion.name)}`}
                      accessibilityLabel={`Add ${suggestion.name} to favorites`}
                      onPress={() => handleSaveSuggestion(suggestion)}
                      disabled={saving || savingSuggestionId != null}
                      activeOpacity={0.78}
                      style={{
                        minWidth: 78,
                        minHeight: 34,
                        borderRadius: 10,
                        backgroundColor: tc.primary + '16',
                        borderWidth: 1,
                        borderColor: tc.primary + '55',
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 5,
                        paddingHorizontal: 10,
                      }}
                    >
                      {saving ? (
                        <ActivityIndicator size="small" color={tc.primary} />
                      ) : (
                        <Ionicons name="star-outline" size={15} color={tc.primary} />
                      )}
                      <Text style={{ fontSize: 11, fontWeight: '800', color: tc.primary }}>
                        {saving ? 'Adding...' : 'Add'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      {undoTarget && (
        <View style={{
          marginTop: 10,
          backgroundColor: tc.surface,
          borderWidth: 1,
          borderColor: tc.border,
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 10,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}>
          <Ionicons name="checkmark-circle" size={16} color={tc.primary} />
          <Text style={{ flex: 1, fontSize: 12, fontWeight: '600', color: tc.textPrimary }} numberOfLines={1}>
            Logged {undoTarget.name}
          </Text>
          <TouchableOpacity onPress={handleUndoLog} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={{ fontSize: 12, fontWeight: '800', color: tc.primary }}>Undo</Text>
          </TouchableOpacity>
        </View>
      )}

      <SuggestedMealDetailModal
        suggestion={suggestionTarget}
        themeName={themeName}
        saving={!!suggestionTarget && savingSuggestionId === suggestionTarget.id}
        disabled={savingSuggestionId != null}
        onClose={() => setSuggestionTarget(null)}
        onAdd={(suggestion) => handleSaveSuggestion(suggestion)}
      />
      <LogSavedMealModal
        saved={target}
        authToken={authToken}
        themeName={themeName}
        onClose={() => setTarget(null)}
        onLogged={(log) => { setTarget(null); reload(); Promise.resolve(onLogged?.(log)).catch(() => {}); }}
      />
      {!onImportSavedMeal && (
        <SavedMealImportModal
          visible={localImportOpen}
          themeName={themeName}
          authToken={authToken}
          onClose={() => setLocalImportOpen(false)}
          onImported={async () => {
            reload();
            await Promise.resolve(onLibraryChanged?.()).catch(() => {});
          }}
        />
      )}
    </View>
  );
}


// ─── Suggested meal detail ───────────────────────────────────────────

function SuggestedMealDetailModal({
  suggestion,
  themeName,
  saving,
  disabled,
  onClose,
  onAdd,
}: {
  suggestion: SuggestedMeal | null;
  themeName?: AppThemeName;
  saving: boolean;
  disabled: boolean;
  onClose: () => void;
  onAdd: (suggestion: SuggestedMeal) => void;
}) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const mealForImage = suggestion ? {
    name: suggestion.name,
    image_url: mealImageAssetUri(suggestion.imageAssetKey),
    image_source: 'asset',
    items: suggestion.items,
  } : null;

  return (
    <Modal visible={!!suggestion} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View testID="suggested-meal-detail-modal" style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 16,
          paddingBottom: 30,
          maxHeight: '88%',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <MealThumbnail meal={mealForImage} size="lg" />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontSize: 17, fontWeight: '900', color: tc.textPrimary }} numberOfLines={2}>
                {suggestion?.name ?? ''}
              </Text>
              <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 3 }} numberOfLines={2}>
                {suggestion ? `${suggestion.reason} · ${suggestion.items.length} foods · ${suggestion.prepTimeMinutes} min` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
              <SuggestedMacroPill label="Cal" value={suggestion?.totalCalories ?? 0} suffix="" color={tc.primary} textColor={tc.textPrimary} borderColor={tc.border} />
              <SuggestedMacroPill label="P" value={suggestion?.totalProteinG ?? 0} suffix="g" color="#22C55E" textColor={tc.textPrimary} borderColor={tc.border} />
              <SuggestedMacroPill label="C" value={suggestion?.totalCarbsG ?? 0} suffix="g" color="#3B82F6" textColor={tc.textPrimary} borderColor={tc.border} />
              <SuggestedMacroPill label="F" value={suggestion?.totalFatG ?? 0} suffix="g" color="#F59E0B" textColor={tc.textPrimary} borderColor={tc.border} />
            </View>

            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
              RECIPE
            </Text>
            <View style={{ backgroundColor: tc.surface, borderRadius: 10, padding: 10, marginBottom: 14, borderWidth: 1, borderColor: tc.border }}>
              {(suggestion?.recipeSteps ?? []).map((step, idx) => (
                <View key={`${idx}-${step}`} style={{ flexDirection: 'row', gap: 8, paddingVertical: 5 }}>
                  <Text style={{ width: 20, height: 20, borderRadius: 10, overflow: 'hidden', textAlign: 'center', lineHeight: 20, fontSize: 11, fontWeight: '900', color: onPrimary, backgroundColor: tc.primary }}>
                    {idx + 1}
                  </Text>
                  <Text style={{ flex: 1, fontSize: 12, lineHeight: 17, color: tc.textPrimary }}>
                    {step}
                  </Text>
                </View>
              ))}
            </View>

            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>
              INGREDIENTS
            </Text>
            <View style={{ backgroundColor: tc.surface, borderRadius: 10, padding: 10, marginBottom: 16, borderWidth: 1, borderColor: tc.border }}>
              {(suggestion?.items ?? []).map((it, i) => (
                <View key={`${it.food_name}-${i}`} style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  paddingVertical: 6,
                  borderBottomWidth: i < (suggestion?.items.length ?? 0) - 1 ? 1 : 0,
                  borderBottomColor: tc.border + '66',
                }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 12, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                      {it.food_name}
                    </Text>
                    <Text style={{ fontSize: 10, color: tc.textMuted, marginTop: 1 }} numberOfLines={1}>
                      {it.quantity} {it.unit}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 11, color: tc.textMuted }}>
                    {Math.round(it.calories)} cal · {Math.round(it.protein_g)}g P
                  </Text>
                </View>
              ))}
            </View>

            <TouchableOpacity
              testID="suggested-meal-detail-add"
              accessibilityLabel="Add suggested meal"
              onPress={() => suggestion && onAdd(suggestion)}
              disabled={!suggestion || disabled}
              activeOpacity={0.8}
              style={{
                backgroundColor: disabled ? tc.border : tc.primary,
                paddingVertical: 12,
                borderRadius: 10,
                alignItems: 'center',
                flexDirection: 'row',
                justifyContent: 'center',
                gap: 7,
              }}
            >
              {saving ? (
                <ActivityIndicator color={onPrimary} />
              ) : (
                <Ionicons name="add-circle" size={17} color={onPrimary} />
              )}
              <Text style={{ color: onPrimary, fontWeight: '900', fontSize: 14 }}>
                {saving ? 'Adding...' : 'Add to favorites'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function SuggestedMacroPill({
  label,
  value,
  suffix,
  color,
  textColor,
  borderColor,
}: {
  label: string;
  value: number;
  suffix: string;
  color: string;
  textColor: string;
  borderColor: string;
}) {
  return (
    <View style={{
      flex: 1,
      minHeight: 52,
      borderRadius: 10,
      borderWidth: 1,
      borderColor,
      backgroundColor: color + '14',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    }}>
      <Text style={{ fontSize: 10, fontWeight: '800', color, marginBottom: 2 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 14, fontWeight: '900', color: textColor }} numberOfLines={1}>
        {Math.round(value)}{suffix}
      </Text>
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
  const onPrimary = getContrastingTextColor(tc.primary);
  const [mealType, setMealType] = useState<string>(defaultMealTypeByHour());
  const [consumedAt, setConsumedAt] = useState<Date>(() => defaultMealDateTime());
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (saved) {
      setMealType(defaultMealTypeByHour());
      setConsumedAt(defaultMealDateTime());
    }
  }, [saved]);

  const handleLog = async () => {
    if (!saved || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const mealDate = dateKey(consumedAt);
      const consumedAtISO = consumedAt.toISOString();
      const r = await api.logSavedMeal(authToken, saved.id, {
        meal_date: mealDate,
        meal_type: mealType,
        consumed_at: consumedAtISO,
        idempotency_key: savedMealLogIdempotencyKey(saved.id, mealDate, mealType, consumedAtISO),
      });
      onLogged({ mealId: r.meal_id, saved, meal_date: mealDate, meal_type: mealType, consumed_at: consumedAtISO });
    } catch (e: any) {
      Alert.alert('Could not log', String(e?.message ?? e));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={!!saved} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View testID="saved-meal-log-modal" style={{
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
                    testID={`saved-meal-type-${opt.key}`}
                    accessibilityLabel={`saved-meal-type-${opt.key}`}
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
              testID="saved-meal-log-submit"
              accessibilityLabel="saved-meal-log-submit"
              onPress={handleLog}
              disabled={submitting}
              style={{
                backgroundColor: submitting ? tc.border : tc.primary,
                paddingVertical: 12, borderRadius: 10,
                alignItems: 'center',
              }}
            >
              {submitting ? (
                <ActivityIndicator color={onPrimary} />
              ) : (
                <Text style={{ color: onPrimary, fontWeight: '800', fontSize: 14 }}>
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
