import React from 'react';
import { ActivityIndicator, Modal, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { getTheme } from '../../constants/theme';

type ThemeColors = ReturnType<typeof getTheme>['colors'];

type SavedMealLike = {
  id?: number | null;
  _optimisticId?: number | string;
  name: string;
  items?: unknown[] | null;
  total_calories?: number | null;
  total_protein_g?: number | null;
};

/**
 * Add-favorite-to-day sheet. The parent owns the in-flight lock so
 * stale closure dates can never resolve onto the wrong day:
 *
 *   - `pendingSavedKey` identifies the row currently being added (parent
 *     -computed via the same `savedMealKey()` that this sheet keys rows
 *      with). When non-null, that row is disabled + spinner-marked, and
 *      all OTHER rows are dimmed to indicate the sheet is busy.
 *
 *   - The sheet does NOT call `onClose()` itself after `onSelect`. The
 *     parent decides: on success it closes (or rolls back on failure).
 *     This is how we preserve "tap row → land meal on the date you
 *     tapped, even if you switched selected day before it resolved."
 */
export default function AddFromSavedMealSheet<TSavedMeal extends SavedMealLike>({
  dateKey,
  savedMeals,
  themeColors,
  savedMealKey,
  onClose,
  onSelect,
  pendingSavedKey = null,
}: {
  dateKey: string | null;
  savedMeals: TSavedMeal[];
  themeColors: ThemeColors;
  savedMealKey: (saved: TSavedMeal) => string;
  onClose: () => void;
  /** Parent-side async handler. Receives the date captured AT TAP TIME
   *  and the saved meal. Errors must throw so the sheet keeps showing
   *  the pending row → alert path is parent-owned. */
  onSelect: (dateKey: string, saved: TSavedMeal) => void | Promise<void>;
  /** Row key currently being added (parent state). Drives the spinner /
   *  disabled state on the in-flight row. */
  pendingSavedKey?: string | null;
}) {
  const isAnyPending = !!pendingSavedKey;
  return (
    <Modal
      visible={!!dateKey}
      animationType="slide"
      transparent
      onRequestClose={() => { if (!isAnyPending) onClose(); }}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: themeColors.background,
          borderTopLeftRadius: 20, borderTopRightRadius: 20,
          padding: 16, paddingBottom: 30, maxHeight: '75%',
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: themeColors.textPrimary }}>Add from Favorites</Text>
            <TouchableOpacity
              onPress={onClose}
              disabled={isAnyPending}
              accessibilityState={{ disabled: isAnyPending }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={isAnyPending ? { opacity: 0.4 } : undefined}
            >
              <Ionicons name="close" size={22} color={themeColors.textSecondary} />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 11, color: themeColors.textMuted, marginBottom: 12, lineHeight: 15 }}>
            Adds a full copy of the saved meal to {dateKey}. Check it off only after you eat it.
          </Text>
          <ScrollView>
            {savedMeals.length === 0 ? (
              <View style={{ padding: 16, alignItems: 'center' }}>
                <Ionicons name="albums-outline" size={28} color={themeColors.textMuted} style={{ marginBottom: 8 }} />
                <Text style={{ fontSize: 12, color: themeColors.textSecondary, textAlign: 'center' }}>No favorite meals yet.</Text>
                <Text style={{ fontSize: 11, color: themeColors.textMuted, textAlign: 'center', marginTop: 4, lineHeight: 16 }}>
                  Tap the star on a meal row or the Favorite chip in the meal editor to add one.
                </Text>
              </View>
            ) : savedMeals.map(sm => {
              const rowKey = savedMealKey(sm);
              const isThisRowPending = pendingSavedKey === rowKey;
              const isDimmed = isAnyPending && !isThisRowPending;
              return (
                <TouchableOpacity
                  key={sm.id ?? sm._optimisticId ?? rowKey}
                  // Captures the dateKey AT TAP TIME so the parent's
                  // async resolver lands the meal on the day the user
                  // actually tapped, even if `dateKey` prop later flips
                  // (selected-day change, sheet open elsewhere, etc.).
                  onPress={() => {
                    if (!dateKey) return;
                    if (isAnyPending) return; // hard block: another add still in flight
                    void onSelect(dateKey, sm);
                  }}
                  disabled={isAnyPending}
                  accessibilityState={{ busy: isThisRowPending, disabled: isAnyPending }}
                  style={{
                    backgroundColor: themeColors.surface, borderRadius: 12, padding: 12, marginBottom: 8,
                    borderWidth: 1, borderColor: themeColors.border,
                    opacity: isDimmed ? 0.45 : 1,
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: themeColors.textPrimary }} numberOfLines={1}>
                      {sm.name}
                    </Text>
                    <Text style={{ fontSize: 11, color: themeColors.textMuted, marginTop: 2 }}>
                      {sm.items?.length ?? 0} item{(sm.items?.length ?? 0) === 1 ? '' : 's'} · {Math.round(sm.total_calories ?? 0)} cal · {Math.round(sm.total_protein_g ?? 0)}g P
                    </Text>
                  </View>
                  {isThisRowPending && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <ActivityIndicator size="small" color={themeColors.primary} />
                      <Text style={{ fontSize: 11, fontWeight: '700', color: themeColors.primary }}>Adding…</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
