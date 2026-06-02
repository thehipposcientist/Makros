/**
 * UseTemplateThisWeekModal — pick which days of the active PlanWeek a
 * given template should fill. Shown when the user taps "Use this week"
 * on a template card in Library → Templates while in workout manual
 * mode.
 *
 * Behavior:
 *  - Shows the 7 days of the active PlanWeek with status pills.
 *  - Done/started days are visible but unselectable (tapping is a no-op
 *    + a brief explanatory toast via Alert).
 *  - Other days toggle a checkbox; the Apply button POSTs use-template
 *    for each selected day in sequence.
 *  - On error mid-batch, surfaces which day failed and stops; partial
 *    assignments stay (the user can retry the rest).
 */
import { useMemo, useState } from 'react';
import {
  View, Text, Modal, TouchableOpacity, ScrollView, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName, SavedWorkoutTemplate } from '../types';
import {
  useTemplateForPlanDay,
  type PlanWeekResponse,
} from '../services/api';
import { displayFocusForWorkout } from '../utils/workoutFocusDisplay';


const DOW_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dowLabelFromISO(iso: string): string {
  // PlanWeek.day_date is YYYY-MM-DD. Construct local-midnight to match
  // the rest of the app's local-time DOW math.
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  const date = new Date(y, m - 1, d);
  // JS getDay: 0=Sun..6=Sat → remap to Mon=0..Sun=6 to match DOW_ABBR.
  const js = date.getDay();
  return DOW_ABBR[(js + 6) % 7] ?? '';
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  if (!m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}`;
}

interface DayRow {
  dayIndex: number;
  dayDate: string;
  status: string;
  isRest: boolean;
  isToday: boolean;
  currentFocus: string | null;
  selectable: boolean;
  blockReason?: string;
}

function buildRows(planWeek: PlanWeekResponse, todayISO: string): DayRow[] {
  return (planWeek.days ?? []).map((d) => {
    const status = d.status ?? '';
    const focus = d.workout ? displayFocusForWorkout(d.workout as any) : null;
    let selectable = true;
    let blockReason: string | undefined;
    if (status === 'completed') {
      selectable = false;
      blockReason = 'Already completed';
    } else if (status === 'started' || status === 'in_progress') {
      selectable = false;
      blockReason = 'In progress';
    }
    return {
      dayIndex: d.day_index,
      dayDate: d.day_date,
      status,
      isRest: !!d.is_rest,
      isToday: d.day_date === todayISO,
      currentFocus: focus,
      selectable,
      blockReason,
    };
  });
}

interface Props {
  visible: boolean;
  themeName?: AppThemeName;
  authToken: string | null;
  template: SavedWorkoutTemplate | null;
  planWeek: PlanWeekResponse | null;
  onClose: () => void;
  /** Called after at least one day was successfully assigned, so the
   *  parent can refetch the active PlanWeek and re-render the schedule. */
  onApplied?: (assignedDayIndexes: number[]) => void;
}

export default function UseTemplateThisWeekModal({
  visible, themeName, authToken, template, planWeek, onClose, onApplied,
}: Props) {
  const tc = getTheme(themeName).colors;
  const onPrimary = getContrastingTextColor(tc.primary);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);

  const todayISO = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);
  const rows = useMemo(
    () => (planWeek ? buildRows(planWeek, todayISO) : []),
    [planWeek, todayISO],
  );

  const toggle = (row: DayRow) => {
    if (!row.selectable) {
      Alert.alert('Not available', row.blockReason ?? 'This day cannot be reassigned.');
      return;
    }
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(row.dayIndex)) next.delete(row.dayIndex);
      else next.add(row.dayIndex);
      return next;
    });
  };

  const onApply = async () => {
    if (!authToken || !template || !planWeek || selected.size === 0) return;
    setApplying(true);
    const ordered = [...selected].sort((a, b) => a - b);
    const succeeded: number[] = [];
    let failedAt: { dayIndex: number; message: string } | null = null;
    for (const dayIdx of ordered) {
      try {
        await useTemplateForPlanDay(authToken, planWeek.id, dayIdx, template.id);
        succeeded.push(dayIdx);
      } catch (e: any) {
        failedAt = { dayIndex: dayIdx, message: e?.message ?? 'Unknown error' };
        break;
      }
    }
    setApplying(false);
    if (succeeded.length > 0) onApplied?.(succeeded);
    if (failedAt) {
      const dayDate = rows.find(r => r.dayIndex === failedAt!.dayIndex)?.dayDate ?? `day ${failedAt.dayIndex + 1}`;
      Alert.alert(
        'Some days could not be assigned',
        `Stopped at ${dayDate}: ${failedAt.message}\n\nAssigned ${succeeded.length}/${ordered.length} days.`,
      );
    }
    setSelected(new Set());
    onClose();
  };

  const onClear = () => setSelected(new Set());

  const templateFocus = template?.workout ? displayFocusForWorkout(template.workout) : 'Workout';
  const headerSubtitle = template
    ? `${templateFocus} · ${template.workout?.exercises?.length ?? 0} exercises`
    : '';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#0009', justifyContent: 'flex-end' }}>
        <View style={{
          backgroundColor: tc.background,
          borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
          paddingTop: 12, paddingBottom: 28, maxHeight: '85%',
        }}>
          <View style={{ alignItems: 'center', paddingBottom: 8 }}>
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: tc.border }} />
          </View>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 18, paddingBottom: 10,
          }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '800', color: tc.textPrimary }} numberOfLines={1}>
                Use {template?.name ?? 'template'} this week
              </Text>
              <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                {headerSubtitle}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close" size={22} color={tc.textMuted} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 12 }}>
            {!planWeek ? (
              <Text style={{ fontSize: 13, color: tc.textMuted, textAlign: 'center', padding: 18 }}>
                No active week.
              </Text>
            ) : rows.map((row) => {
              const isSelected = selected.has(row.dayIndex);
              const willOverwrite = row.selectable && row.currentFocus
                && row.currentFocus.toLowerCase() !== templateFocus.toLowerCase();
              return (
                <TouchableOpacity
                  key={row.dayIndex}
                  testID={`use-this-week-day-${row.dayIndex}`}
                  onPress={() => toggle(row)}
                  activeOpacity={0.78}
                  disabled={applying}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    padding: 12, marginBottom: 6, borderRadius: radius.md,
                    borderWidth: 1.5,
                    borderColor: isSelected ? tc.primary : tc.border,
                    backgroundColor: isSelected ? tc.primary + '14'
                      : (row.selectable ? tc.surface : tc.surface + '88'),
                    opacity: row.selectable ? 1 : 0.55,
                  }}>
                  <View style={{
                    width: 22, height: 22, borderRadius: 6, borderWidth: 2,
                    borderColor: isSelected ? tc.primary : tc.border,
                    backgroundColor: isSelected ? tc.primary : 'transparent',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    {isSelected ? <Ionicons name="checkmark" size={14} color={onPrimary} /> : null}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>
                      {dowLabelFromISO(row.dayDate)} · {shortDate(row.dayDate)}
                      {row.isToday ? '  ·  Today' : ''}
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 2 }} numberOfLines={1}>
                      {row.blockReason
                        ? row.blockReason
                        : row.isRest ? 'Rest day'
                        : row.currentFocus ? (willOverwrite ? `Will replace: ${row.currentFocus}` : row.currentFocus)
                        : 'Unassigned'}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 18, paddingTop: 8,
          }}>
            <TouchableOpacity
              onPress={onClear}
              disabled={applying || selected.size === 0}
              style={{
                paddingVertical: 11, paddingHorizontal: 14, borderRadius: radius.md,
                backgroundColor: tc.surface, borderWidth: 1, borderColor: tc.border,
                opacity: selected.size === 0 ? 0.55 : 1,
              }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: tc.textPrimary }}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="use-this-week-apply"
              onPress={onApply}
              disabled={applying || selected.size === 0}
              style={{
                flex: 1,
                paddingVertical: 13, borderRadius: radius.md,
                alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
                backgroundColor: selected.size > 0 && !applying ? tc.primary : tc.primary + '55',
              }}>
              {applying
                ? <ActivityIndicator color={onPrimary} />
                : <Ionicons name="calendar-outline" size={16} color={onPrimary} />}
              <Text style={{ color: onPrimary, fontSize: 14, fontWeight: '800', letterSpacing: 0.3 }}>
                {applying
                  ? `Assigning…`
                  : selected.size === 0
                    ? 'Pick days to assign'
                    : `Assign to ${selected.size} day${selected.size === 1 ? '' : 's'}`}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
