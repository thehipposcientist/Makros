// Plan-view exercise swap modal. Mirrors the Active Workout swap picker —
// uses the shared scoreSwapCandidate ranking so overlap percentages match
// exactly between live workouts and plan edits.
//
// Opens from the "Swap" chip on each WorkoutCard exercise row. On select,
// the parent receives (newExerciseName, newEquipment) and persists to
// the plan (AsyncStorage + backend).

import { useMemo } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { rankSwapCandidates, ExerciseLibraryItem } from '../utils/swapScoring';

interface Props {
  visible: boolean;
  baseExerciseName: string | null;
  library: ExerciseLibraryItem[];
  ownedEquipment?: string[];
  themeName?: AppThemeName;
  onClose: () => void;
  onSelect: (next: ExerciseLibraryItem) => void;
}

export default function PlanSwapExerciseModal({
  visible, baseExerciseName, library, ownedEquipment, themeName, onClose, onSelect,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const base = useMemo<ExerciseLibraryItem | null>(() => {
    if (!baseExerciseName) return null;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const target = norm(baseExerciseName);
    // Exact match → fallback to substring → fallback to first-word match.
    const exact = library.find(e => norm(e.name) === target);
    if (exact) return exact;
    const contains = library.find(
      e => norm(e.name).includes(target) || target.includes(norm(e.name)),
    );
    if (contains) return contains;
    // Last resort: fabricate a minimal base from the plan name so the
    // picker still works for AI-emitted exercises that aren't in the
    // library row set (common for seed gaps). Uses empty muscles — the
    // scorer will fall back to movement-pattern matching only.
    return {
      id: -1 as any,
      name: baseExerciseName,
      primary_muscle: '',
      secondary_muscles: [],
      equipment: '',
      description: '',
    } as unknown as ExerciseLibraryItem;
  }, [baseExerciseName, library]);

  const candidates = useMemo(() => {
    if (!base || library.length === 0) return [];
    return rankSwapCandidates(base, library, ownedEquipment, 10);
  }, [base, library, ownedEquipment]);

  const overlapColor = (pct: number) => {
    if (pct >= 80) return tc.success;
    if (pct >= 60) return tc.warning;
    return tc.error;
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tc.background }}>
        <View style={{
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16,
          paddingTop: Platform.OS === 'ios' ? 8 : 24, paddingBottom: 12,
          borderBottomWidth: 1, borderBottomColor: tc.border,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.5 }}>SWAP</Text>
            <Text style={{ fontSize: 17, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
              {baseExerciseName ?? 'Exercise'}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={24} color={tc.textPrimary} />
          </TouchableOpacity>
        </View>

        {library.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20, gap: 10 }}>
            <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center' }}>
              Loading exercise library…
            </Text>
          </View>
        ) : candidates.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center' }}>
              No suitable alternatives found with your current equipment.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ padding: 12, gap: 8 }}>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginBottom: 6 }}>
              Ranked by muscle + movement pattern overlap.
            </Text>
            {candidates.map(c => (
              <TouchableOpacity
                key={c.name}
                activeOpacity={0.8}
                onPress={() => { onSelect(c); onClose(); }}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  padding: 12, borderRadius: radius.md,
                  backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                    {c.primary_muscle}{c.equipment ? ` · ${c.equipment}` : ''}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ fontSize: 16, fontWeight: '900', color: overlapColor(c._overlap) }}>
                    {c._overlap}%
                  </Text>
                  <Text style={{ fontSize: 9, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.5 }}>
                    OVERLAP
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
