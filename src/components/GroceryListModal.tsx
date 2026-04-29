// Grocery list modal. Aggregates this week's meal items into a shoppable list
// with checkable rows and a share button. Checked items persist to
// AsyncStorage so progress survives app restarts.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, ScrollView, Share, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName, DailyNutritionPlan } from '../types';
import { buildGroceryList, formatGroceryQuantity, formatGroceryText, GroceryCategory, GroceryRow } from '../utils/groceryList';

const CHECKED_KEY = 'groceryChecked_v2';
const REMOVED_KEY = 'groceryRemoved_v2';

interface Props {
  visible: boolean;
  onClose: () => void;
  plansByDate: Record<string, DailyNutritionPlan>;
  themeName?: AppThemeName;
}

export default function GroceryListModal({ visible, onClose, plansByDate, themeName }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // Per-item removal (user said they don't want this item; persisted separately
  // from `checked` so completing a shopping trip doesn't also hide future
  // weeks' items).
  const [removed, setRemoved] = useState<Record<string, boolean>>({});

  // Use next 7 days of plans
  const allRows: GroceryRow[] = useMemo(() => {
    if (!visible) return [];
    const now = new Date();
    const keys: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() + i * 86400000);
      keys.push(d.toISOString().slice(0, 10));
    }
    const plans = keys.map(k => plansByDate[k]).filter((p): p is DailyNutritionPlan => !!p);
    return buildGroceryList(plans);
  }, [plansByDate, visible]);

  const planSignature = useMemo(
    () => allRows.map(r => `${r.name}|${r.quantity}|${r.unit}|${r.category}`).join('||'),
    [allRows],
  );

  const rows = useMemo(() => allRows.filter(r => !removed[r.name]), [allRows, removed]);
  const removedCount = useMemo(() => allRows.filter(r => removed[r.name]).length, [allRows, removed]);
  const groupedRows = useMemo(() => {
    const groups = new Map<GroceryCategory, GroceryRow[]>();
    for (const row of rows) {
      const list = groups.get(row.category) ?? [];
      list.push(row);
      groups.set(row.category, list);
    }
    return ['Produce', 'Protein', 'Dairy & Eggs', 'Grains & Bakery', 'Pantry', 'Frozen', 'Drinks', 'Supplements', 'Other']
      .map(category => ({ category: category as GroceryCategory, rows: groups.get(category as GroceryCategory) ?? [] }))
      .filter(section => section.rows.length > 0);
  }, [rows]);

  useEffect(() => {
    if (!visible) return;
    AsyncStorage.getItem(CHECKED_KEY).then(raw => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          setChecked(parsed[planSignature] ?? {});
        } catch {
          setChecked({});
        }
      } else {
        setChecked({});
      }
    });
    AsyncStorage.getItem(REMOVED_KEY).then(raw => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          setRemoved(parsed[planSignature] ?? {});
        } catch {
          setRemoved({});
        }
      } else {
        setRemoved({});
      }
    });
  }, [visible, planSignature]);

  const toggle = useCallback((name: string) => {
    setChecked(prev => {
      const next = { ...prev, [name]: !prev[name] };
      AsyncStorage.getItem(CHECKED_KEY).then(raw => {
        const all = raw ? JSON.parse(raw) : {};
        all[planSignature] = next;
        AsyncStorage.setItem(CHECKED_KEY, JSON.stringify(all)).catch(() => {});
      }).catch(() => {});
      return next;
    });
  }, [planSignature]);

  const removeRow = useCallback((name: string) => {
    setRemoved(prev => {
      const next = { ...prev, [name]: true };
      AsyncStorage.getItem(REMOVED_KEY).then(raw => {
        const all = raw ? JSON.parse(raw) : {};
        all[planSignature] = next;
        AsyncStorage.setItem(REMOVED_KEY, JSON.stringify(all)).catch(() => {});
      }).catch(() => {});
      return next;
    });
    // If it was checked, clean that flag too — meaningless for a removed row.
    setChecked(prev => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      AsyncStorage.getItem(CHECKED_KEY).then(raw => {
        const all = raw ? JSON.parse(raw) : {};
        all[planSignature] = next;
        AsyncStorage.setItem(CHECKED_KEY, JSON.stringify(all)).catch(() => {});
      }).catch(() => {});
      return next;
    });
  }, [planSignature]);

  const restoreAllRemoved = useCallback(() => {
    setRemoved({});
    AsyncStorage.getItem(REMOVED_KEY).then(raw => {
      const all = raw ? JSON.parse(raw) : {};
      delete all[planSignature];
      AsyncStorage.setItem(REMOVED_KEY, JSON.stringify(all)).catch(() => {});
    }).catch(() => {});
  }, [planSignature]);

  const clearChecks = () => {
    setChecked({});
    AsyncStorage.getItem(CHECKED_KEY).then(raw => {
      const all = raw ? JSON.parse(raw) : {};
      delete all[planSignature];
      AsyncStorage.setItem(CHECKED_KEY, JSON.stringify(all)).catch(() => {});
    }).catch(() => {});
  };

  const share = async () => {
    if (rows.length === 0) return;
    const unchecked = rows.filter(r => !checked[r.name]);
    const text = formatGroceryText(unchecked, 'Grocery list — this week');
    try {
      await Share.share({ message: text });
    } catch (e: any) {
      Alert.alert('Share failed', String(e?.message ?? e));
    }
  };

  const total = rows.length;
  const done = rows.filter(r => checked[r.name]).length;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.surface,
          borderTopLeftRadius: 20, borderTopRightRadius: 20,
          maxHeight: '90%',
          borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1,
          borderColor: tc.border,
        }}>
          {/* Handle */}
          <View style={{ alignItems: 'center', paddingTop: 8 }}>
            <View style={{ width: 40, height: 4, borderRadius: 2, backgroundColor: tc.border }} />
          </View>
          {/* Header */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 16, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: tc.border + '66',
          }}>
            <Ionicons name="cart-outline" size={20} color={tc.primary} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 17, fontWeight: '800', color: tc.textPrimary }}>Grocery List</Text>
              <Text style={{ fontSize: 11, color: tc.textMuted }}>
                {total === 0 ? 'No meal plan yet' : `${done}/${total} items · 7 days`}
              </Text>
            </View>
            <TouchableOpacity onPress={share} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="share-outline" size={22} color={tc.primary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          {total === 0 ? (
            <View style={{ padding: 40, alignItems: 'center', gap: 8 }}>
              <Ionicons name="basket-outline" size={36} color={tc.textMuted} />
              <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>Nothing to shop yet</Text>
              <Text style={{ fontSize: 12, color: tc.textSecondary, textAlign: 'center' }}>
                Generate a meal plan and the next 7 days of groceries will show up here automatically.
              </Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 20 }}>
              {groupedRows.map(section => (
                <View key={section.category} style={{ marginBottom: 10 }}>
                  <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.4, marginBottom: 6, paddingHorizontal: 4 }}>
                    {section.category.toUpperCase()}
                  </Text>
                  {section.rows.map((r) => {
                    const isChecked = !!checked[r.name];
                    return (
                      <TouchableOpacity
                        key={r.name + r.unit}
                        activeOpacity={0.7}
                        onPress={() => toggle(r.name)}
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: 10,
                          paddingVertical: 12, paddingHorizontal: 10,
                          borderRadius: radius.md,
                          marginBottom: 4,
                          backgroundColor: isChecked ? tc.border + '22' : tc.surfaceRaised,
                          opacity: isChecked ? 0.6 : 1,
                        }}
                      >
                        <View style={{
                          width: 22, height: 22, borderRadius: 6,
                          borderWidth: 2,
                          borderColor: isChecked ? tc.primary : tc.border,
                          backgroundColor: isChecked ? tc.primary : 'transparent',
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          {isChecked && <Ionicons name="checkmark" size={14} color={tc.background} />}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text
                            style={{
                              fontSize: 14, fontWeight: '600',
                              color: tc.textPrimary,
                              textDecorationLine: isChecked ? 'line-through' : 'none',
                            }}
                          >
                            {r.name}
                          </Text>
                          <Text style={{ fontSize: 10, color: tc.textMuted }}>
                            {formatGroceryQuantity(r.quantity, r.unit)}
                            {r.meals > 1 ? ` · used in ${r.meals} meals` : ''}
                          </Text>
                        </View>
                        <TouchableOpacity
                          onPress={() => removeRow(r.name)}
                          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          style={{ padding: 2 }}
                        >
                          <Ionicons name="close-circle" size={18} color={tc.textMuted} />
                        </TouchableOpacity>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ))}
              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 6 }}>
                {done > 0 && (
                  <TouchableOpacity
                    onPress={clearChecks}
                    style={{ alignItems: 'center', padding: 10 }}
                  >
                    <Text style={{ fontSize: 12, color: tc.textMuted }}>Uncheck all</Text>
                  </TouchableOpacity>
                )}
                {removedCount > 0 && (
                  <TouchableOpacity
                    onPress={restoreAllRemoved}
                    style={{ alignItems: 'center', padding: 10 }}
                  >
                    <Text style={{ fontSize: 12, color: tc.textMuted }}>
                      Restore {removedCount} removed
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}
