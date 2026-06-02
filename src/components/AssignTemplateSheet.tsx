/**
 * AssignTemplateSheet — bottom sheet shown when a user in workout
 * manual mode taps an unassigned day. Lists the user's saved templates
 * (loaded by the parent + passed in) plus a "Mark as rest day" option
 * and a "Clear back to unassigned" option for already-assigned days.
 *
 * Calls /plan-weeks/{id}/days/{idx}/use-template (or mark-rest, or
 * clear) on the backend, then fires onAssigned so the parent can
 * refresh the active PlanWeek view.
 */
import { useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName, SavedWorkoutTemplate } from '../types';
import {
  clearPlanDay,
  generateWorkoutForPlanDay,
  markPlanDayRest,
  upsertWorkoutTemplate as apiUpsertWorkoutTemplate,
  useTemplateForPlanDay,
} from '../services/api';
import type {
  ManualGeneratedWorkoutFocus,
  ManualGeneratedWorkoutStimulus,
} from '../services/api';
import { displayFocusForWorkout } from '../utils/workoutFocusDisplay';

const GENERATED_FOCUS_OPTIONS: Array<{
  id: ManualGeneratedWorkoutFocus;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { id: 'push', label: 'Push', icon: 'arrow-up-circle-outline' },
  { id: 'pull', label: 'Pull', icon: 'arrow-down-circle-outline' },
  { id: 'legs', label: 'Legs', icon: 'walk-outline' },
  { id: 'upper', label: 'Upper', icon: 'body-outline' },
  { id: 'lower', label: 'Lower', icon: 'footsteps-outline' },
  { id: 'full_body', label: 'Full Body', icon: 'accessibility-outline' },
  { id: 'cardio', label: 'Cardio', icon: 'heart-outline' },
  { id: 'mobility', label: 'Mobility', icon: 'sync-outline' },
];

const GENERATED_STIMULUS_OPTIONS: Array<{
  id: ManualGeneratedWorkoutStimulus;
  label: string;
}> = [
  { id: 'balanced', label: 'Balanced' },
  { id: 'heavy', label: 'Heavy' },
  { id: 'pump', label: 'Pump' },
];

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  authToken: string | null;
  templates: SavedWorkoutTemplate[];
  planWeekId: number | null;
  dayIndex: number | null;
  sessionMinutes?: number | null;
  /** Human label shown in the sheet header — e.g. "Wed · Apr 22". */
  dayLabel?: string;
  /** True when the day already has an assigned template (we surface
   *  Clear + a re-pick affordance). False for fresh unassigned days. */
  alreadyAssigned?: boolean;
  onClose: () => void;
  /** Called after a successful use-template / mark-rest / clear. */
  onAssigned?: () => void;
}

export default function AssignTemplateSheet({
  visible, themeName, authToken, templates, planWeekId, dayIndex,
  sessionMinutes, dayLabel, alreadyAssigned = false, onClose, onAssigned,
}: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [generatedFocus, setGeneratedFocus] = useState<ManualGeneratedWorkoutFocus>('push');
  const [generatedStimulus, setGeneratedStimulus] = useState<ManualGeneratedWorkoutStimulus>('balanced');
  const sortedTemplates = useMemo(
    () => [...templates].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
    [templates],
  );

  const canCall = !!authToken && planWeekId != null && dayIndex != null;

  const onPickTemplate = async (template: SavedWorkoutTemplate) => {
    if (!canCall) return;
    setBusyId(template.id);
    try {
      try {
        await useTemplateForPlanDay(authToken!, planWeekId!, dayIndex!, template.id);
      } catch (e: any) {
        // Recover from local-only templates the backend never received
        // (legacy of the silent-fallback upsert bug). Push the template
        // up, then retry the assign. Any other 4xx/5xx falls through.
        const msg = String(e?.message ?? '');
        if (msg.includes('Template not found')) {
          await apiUpsertWorkoutTemplate(authToken!, {
            id: template.id,
            name: template.name,
            workout: template.workout,
            notes: template.notes ?? null,
          });
          await useTemplateForPlanDay(authToken!, planWeekId!, dayIndex!, template.id);
        } else {
          throw e;
        }
      }
      onAssigned?.();
      onClose();
    } catch (e: any) {
      Alert.alert('Could not assign', e?.message ?? 'Try again later.');
    } finally {
      setBusyId(null);
    }
  };

  const onGenerateWorkout = async () => {
    if (!canCall) return;
    setBusyId('__generate__');
    try {
      await generateWorkoutForPlanDay(authToken!, planWeekId!, dayIndex!, {
        focus: generatedFocus,
        stimulus: generatedStimulus,
        session_minutes: sessionMinutes ?? undefined,
      });
      onAssigned?.();
      onClose();
    } catch (e: any) {
      Alert.alert('Could not generate', e?.message ?? 'Try again later.');
    } finally {
      setBusyId(null);
    }
  };

  const onPickRest = async () => {
    if (!canCall) return;
    setBusyId('__rest__');
    try {
      await markPlanDayRest(authToken!, planWeekId!, dayIndex!, true);
      onAssigned?.();
      onClose();
    } catch (e: any) {
      Alert.alert('Could not set rest', e?.message ?? 'Try again later.');
    } finally {
      setBusyId(null);
    }
  };

  const runClearAssignment = async () => {
    if (!canCall) return;
    setBusyId('__clear__');
    try {
      await clearPlanDay(authToken!, planWeekId!, dayIndex!);
      onAssigned?.();
      onClose();
    } catch (e: any) {
      Alert.alert('Could not clear', e?.message ?? 'Try again later.');
    } finally {
      setBusyId(null);
    }
  };

  const onClearAssignment = () => {
    if (!canCall || busyId) return;
    Alert.alert(
      'Clear this day?',
      'This removes the assigned workout or rest choice and returns the day to unassigned.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear day', style: 'destructive', onPress: runClearAssignment },
      ],
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
          paddingTop: 12, paddingBottom: 28, maxHeight: '80%',
        }}>
          <View style={{ alignItems: 'center', paddingBottom: 8 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: tc.border }} />
          </View>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 18, paddingBottom: 10,
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }}>
                {alreadyAssigned ? 'Change this day' : 'Assign a workout'}
              </Text>
              {dayLabel ? (
                <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }}>{dayLabel}</Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
            <TouchableOpacity
              testID="assign-template-generate-toggle"
              disabled={!!busyId}
              onPress={() => setGeneratorOpen(v => !v)}
              activeOpacity={0.78}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 12,
                padding: 14, marginBottom: 8, borderRadius: radius.md,
                backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                opacity: busyId && busyId !== '__generate__' ? 0.5 : 1,
              }}>
              <View style={{
                width: 36, height: 36, borderRadius: 8,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: tc.primary + '18',
              }}>
                <Ionicons name="sparkles-outline" size={18} color={tc.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                  Generate workout
                </Text>
                <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                  Build a focused day from your equipment and settings
                </Text>
              </View>
              {busyId === '__generate__'
                ? <ActivityIndicator color={tc.primary} />
                : <Ionicons name={generatorOpen ? 'chevron-down' : 'chevron-forward'} size={18} color={tc.textMuted} />}
            </TouchableOpacity>

            {generatorOpen && (
              <View style={{
                padding: 12, marginBottom: 10, borderRadius: radius.md,
                borderWidth: 1, borderColor: tc.border, backgroundColor: tc.surface,
              }}>
                <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textMuted, marginBottom: 8 }}>
                  Focus
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  {GENERATED_FOCUS_OPTIONS.map(opt => {
                    const active = generatedFocus === opt.id;
                    return (
                      <TouchableOpacity
                        key={opt.id}
                        testID={`assign-generate-focus-${opt.id}`}
                        disabled={!!busyId}
                        onPress={() => setGeneratedFocus(opt.id)}
                        activeOpacity={0.78}
                        style={{
                          flexDirection: 'row', alignItems: 'center', gap: 6,
                          paddingVertical: 8, paddingHorizontal: 10, borderRadius: 999,
                          backgroundColor: active ? tc.primary : tc.background,
                          borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                        }}>
                        <Ionicons name={opt.icon} size={14} color={active ? onPrimary : tc.textMuted} />
                        <Text style={{
                          fontSize: 12, fontWeight: '800',
                          color: active ? onPrimary : tc.textPrimary,
                        }}>
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={{ fontSize: 12, fontWeight: '800', color: tc.textMuted, marginBottom: 8 }}>
                  Intent
                </Text>
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
                  {GENERATED_STIMULUS_OPTIONS.map(opt => {
                    const active = generatedStimulus === opt.id;
                    return (
                      <TouchableOpacity
                        key={opt.id}
                        testID={`assign-generate-stimulus-${opt.id}`}
                        disabled={!!busyId}
                        onPress={() => setGeneratedStimulus(opt.id)}
                        activeOpacity={0.78}
                        style={{
                          flex: 1, alignItems: 'center',
                          paddingVertical: 9, paddingHorizontal: 8, borderRadius: 10,
                          backgroundColor: active ? tc.primary + '18' : tc.background,
                          borderWidth: 1, borderColor: active ? tc.primary : tc.border,
                        }}>
                        <Text style={{
                          fontSize: 12, fontWeight: '800',
                          color: active ? tc.primary : tc.textPrimary,
                        }}>
                          {opt.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <TouchableOpacity
                  testID="assign-generate-submit"
                  disabled={!!busyId}
                  onPress={onGenerateWorkout}
                  activeOpacity={0.78}
                  style={{
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
                    paddingVertical: 12, borderRadius: 10, backgroundColor: tc.primary,
                    opacity: busyId && busyId !== '__generate__' ? 0.5 : 1,
                  }}>
                  {busyId === '__generate__'
                    ? <ActivityIndicator color={onPrimary} />
                    : <Ionicons name="flash-outline" size={16} color={onPrimary} />}
                  <Text style={{ fontSize: 13, fontWeight: '900', color: onPrimary }}>
                    Generate Day
                  </Text>
                </TouchableOpacity>
              </View>
            )}

            {sortedTemplates.length === 0 ? (
              <View style={{
                padding: 20, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed' as any,
                borderColor: tc.border, backgroundColor: tc.surface, alignItems: 'center',
              }}>
                <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center' }}>
                  You don't have any saved templates yet. Generate a workout above or create one in Library → Templates.
                </Text>
              </View>
            ) : sortedTemplates.map((t) => {
              const exCount = t.workout?.exercises?.length ?? 0;
              const templateFocus = t.workout ? displayFocusForWorkout(t.workout) : 'Workout';
              const isBusy = busyId === t.id;
              return (
                <TouchableOpacity
                  key={t.id}
                  testID={`assign-template-${t.id}`}
                  disabled={!!busyId}
                  onPress={() => onPickTemplate(t)}
                  activeOpacity={0.78}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    padding: 14, marginBottom: 8, borderRadius: radius.md,
                    backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                    opacity: busyId && !isBusy ? 0.5 : 1,
                  }}>
                  <View style={{
                    width: 36, height: 36, borderRadius: 8,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: tc.primary + '18',
                  }}>
                    <Ionicons name="bookmark-outline" size={18} color={tc.primary} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }} numberOfLines={1}>
                      {t.name}
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                      {templateFocus} · {exCount} exercise{exCount === 1 ? '' : 's'}
                    </Text>
                  </View>
                  {isBusy
                    ? <ActivityIndicator color={tc.primary} />
                    : <Ionicons name="chevron-forward" size={18} color={tc.textMuted} />}
                </TouchableOpacity>
              );
            })}

            <TouchableOpacity
              testID="assign-template-rest"
              disabled={!!busyId}
              onPress={onPickRest}
              activeOpacity={0.78}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 12,
                padding: 14, marginTop: 4, borderRadius: radius.md,
                backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                opacity: busyId && busyId !== '__rest__' ? 0.5 : 1,
              }}>
              <View style={{
                width: 36, height: 36, borderRadius: 8,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: tc.textMuted + '22',
              }}>
                <Ionicons name="moon-outline" size={18} color={tc.textMuted} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>Mark as rest day</Text>
                <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }}>
                  No workout — recovery counts toward fatigue calculations.
                </Text>
              </View>
              {busyId === '__rest__'
                ? <ActivityIndicator color={tc.textMuted} />
                : <Ionicons name="chevron-forward" size={18} color={tc.textMuted} />}
            </TouchableOpacity>

            {alreadyAssigned && (
              <TouchableOpacity
                testID="assign-template-clear"
                disabled={!!busyId}
                onPress={onClearAssignment}
                activeOpacity={0.78}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  padding: 14, marginTop: 8, borderRadius: radius.md,
                  backgroundColor: tc.surface,
                  borderWidth: 1, borderColor: (tc.error ?? '#EF4444') + '55',
                  opacity: busyId && busyId !== '__clear__' ? 0.5 : 1,
                }}>
                <View style={{
                  width: 36, height: 36, borderRadius: 8,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: (tc.error ?? '#EF4444') + '22',
                }}>
                  <Ionicons name="close-circle-outline" size={18} color={tc.error ?? '#EF4444'} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: tc.error ?? '#EF4444' }}>Clear assignment</Text>
                  <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }}>
                    Revert to unassigned so you can pick again.
                  </Text>
                </View>
                {busyId === '__clear__'
                  ? <ActivityIndicator color={tc.error ?? '#EF4444'} />
                  : <Ionicons name="chevron-forward" size={18} color={tc.textMuted} />}
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
