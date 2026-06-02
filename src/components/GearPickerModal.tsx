/**
 * Per-session gear disambiguation modal.
 *
 * Fires at workout completion when MORE THAN ONE active gear item matches
 * the workout's keywords (e.g. two pairs of running shoes both keyworded
 * with 'run'). The previous behavior auto-credited mileage to BOTH, which
 * silently double-counted. Now the user picks which gear was actually
 * used and only that ID gets credited.
 *
 * Usage from ActiveWorkoutScreen:
 *   const { gearIds, cancelled } = await pickGearForSession({
 *     authToken, focusLabel, exerciseNames,
 *   });
 *   if (cancelled) return; // user backed out of completion entirely
 *   await logWorkoutDone(..., undefined, gearIds);
 */
import { useEffect, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import type { GearItem } from '../services/api';

interface Props {
  visible: boolean;
  candidates: GearItem[];
  themeName?: AppThemeName;
  onPick: (selectedIds: number[]) => void;
  onSkip: () => void;
}

export default function GearPickerModal({ visible, candidates, themeName, onPick, onSkip }: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Default to ALL candidates checked when the modal opens — matches the
  // old auto-match behavior so a user who taps Save without thinking still
  // gets the same credit they would have before. They opt OUT of items
  // they didn't actually use.
  useEffect(() => {
    if (visible) setSelected(new Set(candidates.map(c => c.id)));
  }, [visible, candidates]);

  if (!visible) return null;

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onSkip}>
      <View style={s.overlay}>
        <View style={[s.sheet, { backgroundColor: tc.surface }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Ionicons name="checkmark-done-outline" size={20} color={tc.primary} />
            <Text style={[s.title, { color: tc.textPrimary }]}>Which gear did you use?</Text>
          </View>
          <Text style={[s.sub, { color: tc.textSecondary }]}>
            Multiple items match this workout. Only the ones you uncheck will be skipped — the rest get credited.
          </Text>

          <ScrollView style={{ maxHeight: 280, marginVertical: 14 }}>
            {candidates.map(g => {
              const checked = selected.has(g.id);
              return (
                <TouchableOpacity
                  key={g.id}
                  onPress={() => toggle(g.id)}
                  activeOpacity={0.7}
                  style={[
                    s.row,
                    { borderColor: checked ? tc.primary : tc.border, backgroundColor: checked ? tc.primary + '10' : tc.background },
                  ]}>
                  <View style={[s.checkbox, { borderColor: checked ? tc.primary : tc.border, backgroundColor: checked ? tc.primary : 'transparent' }]}>
                    {checked && <Ionicons name="checkmark" size={14} color={onPrimary} />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.gearName, { color: tc.textPrimary }]}>{g.name}</Text>
                    <Text style={[s.gearMeta, { color: tc.textMuted }]}>
                      {g.gear_type.replace(/_/g, ' ')} · {g.accumulated_sessions} session{g.accumulated_sessions === 1 ? '' : 's'} logged
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity
              onPress={() => onPick([])}
              style={[s.btn, { borderColor: tc.border, backgroundColor: tc.background, flex: 1 }]}>
              <Text style={{ color: tc.textSecondary, fontWeight: '700', fontSize: 13 }}>None today</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onPick(Array.from(selected))}
              style={[s.btn, { backgroundColor: tc.primary, borderColor: tc.primary, flex: 2 }]}>
              <Text style={{ color: onPrimary, fontWeight: '800', fontSize: 13 }}>
                Save {selected.size > 0 ? `(${selected.size})` : ''}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  sheet: { borderRadius: radius.lg, padding: 18 },
  title: { fontSize: 17, fontWeight: '800' },
  sub: { fontSize: 12, lineHeight: 17 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, borderRadius: 10, borderWidth: 1, marginBottom: 8,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
  },
  gearName: { fontSize: 14, fontWeight: '700' },
  gearMeta: { fontSize: 11, marginTop: 2, textTransform: 'capitalize' },
  btn: {
    paddingVertical: 12, borderRadius: 10, borderWidth: 1, alignItems: 'center',
  },
});
