// Weekly review - informational scorecard with explicit plan setup controls.
//
// This surface does not submit coach answers or apply recommendation logic.
// Users can review the week, optionally save durable plan setup preferences,
// and choose whether those setup changes affect only future weeks or rebuild
// the remaining unlocked days of the already-generated current week.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import {
  applyPlanWeekCheckinSettings,
  getActivePlanWeek,
  getWeekSummary,
  CheckinPlanSettingsResponse,
  PlanWeekCheckinRecord,
  PlanWeekResponse,
  WeekCheckinResponse,
  WeekSummaryResponse,
} from '../services/api';

interface Props {
  visible: boolean;
  authToken: string;
  planWeekId?: number | null;
  weekStart?: string | null;
  weekEnd?: string | null;
  goal?: string;
  themeName?: AppThemeName;
  weightSlopeLbsPerWeek?: number | null;
  avgSleepHours?: number | null;
  avgRestingHr?: number | null;
  avgSteps?: number | null;
  onClose: () => void;
  onComplete: (applied: boolean, result?: WeekCheckinResponse | PlanWeekCheckinRecord) => void;
  onSkip?: () => void;
}

type Step = 1 | 2 | 3 | 4;

interface PlanSetupDraft {
  goal: string;
  daysPerWeek: number;
  sessionMinutes: number;
  preferredSplit: string;
}

type SetupMode = 'keep' | 'tune';

const SETUP_GOALS = [
  { value: 'body_recomp', label: 'Recomp' },
  { value: 'lose_fat', label: 'Fat loss' },
  { value: 'build_muscle', label: 'Build muscle' },
  { value: 'build_strength', label: 'Strength' },
  { value: 'improve_cardio', label: 'Endurance' },
  { value: 'improve_athleticism', label: 'Athleticism' },
  { value: 'longevity', label: 'Health' },
];

const SETUP_SPLITS = [
  { value: 'auto', label: 'Auto' },
  { value: 'full_body', label: 'Full body' },
  { value: 'upper_lower', label: 'Upper / lower' },
  { value: 'ppl', label: 'PPL' },
  { value: 'ppl_upper_lower', label: 'PPL + UL' },
  { value: 'bro', label: 'Bro split' },
];

const SESSION_MINUTES = [30, 45, 60, 75, 90];

function dayMs(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(`${value.slice(0, 10)}T00:00:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function setupGoalForPicker(value: string): string {
  const goal = String(value || '').trim().toLowerCase();
  const map: Record<string, string> = {
    fat_loss: 'lose_fat',
    muscle_gain: 'build_muscle',
    strength: 'build_strength',
    endurance: 'improve_cardio',
    athletic_performance: 'improve_athleticism',
    general_health: 'longevity',
    maintain: 'longevity',
  };
  return map[goal] ?? goal;
}

function setupFromPlanWeek(planWeek: PlanWeekResponse | null, fallbackGoal: string): PlanSetupDraft {
  return {
    goal: setupGoalForPicker(planWeek?.goal ?? fallbackGoal),
    daysPerWeek: Math.max(1, Math.min(7, Number(planWeek?.days_per_week ?? 4) || 4)),
    sessionMinutes: Math.max(20, Math.min(120, Number(planWeek?.session_minutes ?? 45) || 45)),
    preferredSplit: planWeek?.preferred_split ?? 'auto',
  };
}

function setupChanged(base: PlanSetupDraft, draft: PlanSetupDraft | null, enabled: boolean): boolean {
  if (!enabled || !draft) return false;
  return base.goal !== draft.goal
    || base.daysPerWeek !== draft.daysPerWeek
    || base.sessionMinutes !== draft.sessionMinutes
    || base.preferredSplit !== draft.preferredSplit;
}

export default function WeeklyCheckinModal({
  visible,
  authToken,
  goal = 'body_recomp',
  themeName,
  onClose,
  onComplete,
  planWeekId,
  weekEnd,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const primaryTextColor = getContrastingTextColor(tc.primary);

  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<WeekSummaryResponse | null>(null);
  const [activePlanWeek, setActivePlanWeek] = useState<PlanWeekResponse | null>(null);
  const [setupMode, setSetupMode] = useState<SetupMode>('keep');
  const [planSetup, setPlanSetup] = useState<PlanSetupDraft | null>(null);
  const [applySetupToCurrent, setApplySetupToCurrent] = useState(false);
  const [settingsResult, setSettingsResult] = useState<CheckinPlanSettingsResponse | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [savingSetup, setSavingSetup] = useState(false);

  useEffect(() => {
    if (!visible || !authToken) return;
    setStep(1);
    setActivePlanWeek(null);
    setSetupMode('keep');
    setPlanSetup(null);
    setApplySetupToCurrent(false);
    setSettingsResult(null);
    setSettingsError(null);
    setSavingSetup(false);
    setLoading(true);

    getWeekSummary(authToken, { planWeekId, endDate: weekEnd })
      .then(s => setSummary(s))
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));

    getActivePlanWeek(authToken)
      .then(pw => {
        setActivePlanWeek(pw);
        setPlanSetup(setupFromPlanWeek(pw, goal));
      })
      .catch(() => {
        setActivePlanWeek(null);
        setPlanSetup(setupFromPlanWeek(null, goal));
      });
  }, [visible, authToken, planWeekId, weekEnd, goal]);

  const effectiveGoal = summary?.goal ?? activePlanWeek?.goal ?? goal;
  const baselineSetup = setupFromPlanWeek(activePlanWeek, effectiveGoal);
  const hasSetupChanges = setupChanged(baselineSetup, planSetup, setupMode === 'tune');
  const currentWeekAlreadyGenerated = (() => {
    const end = dayMs(weekEnd);
    const activeStart = dayMs(activePlanWeek?.start_date);
    return !!(end && activeStart && activeStart > end && activePlanWeek?.id !== planWeekId);
  })();

  const handleFinishReview = useCallback(async () => {
    if (!authToken) return;
    setSettingsResult(null);
    setSettingsError(null);

    if (!hasSetupChanges || !planSetup) {
      setStep(4);
      return;
    }

    setSavingSetup(true);
    try {
      const base = baselineSetup;
      const settings = await applyPlanWeekCheckinSettings(authToken, {
        goal: planSetup.goal !== base.goal ? planSetup.goal : null,
        daysPerWeek: planSetup.daysPerWeek !== base.daysPerWeek ? planSetup.daysPerWeek : null,
        preferredSplit: planSetup.preferredSplit !== base.preferredSplit ? planSetup.preferredSplit : null,
        sessionMinutes: planSetup.sessionMinutes !== base.sessionMinutes ? planSetup.sessionMinutes : null,
        applyToCurrentWeek: applySetupToCurrent,
        reason: 'weekly_review',
      });
      setSettingsResult(settings);
      setActivePlanWeek(settings.plan_week);
    } catch (e: any) {
      setSettingsError(e?.message ?? 'Plan setup changes could not be saved.');
    } finally {
      setSavingSetup(false);
      setStep(4);
    }
  }, [authToken, hasSetupChanges, planSetup, baselineSetup, applySetupToCurrent]);

  const StatBox = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <View style={{
      flex: 1,
      alignItems: 'center',
      padding: 12,
      backgroundColor: tc.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: tc.border,
    }}>
      <Text style={{ fontSize: 22, fontWeight: '900', color: tc.primary }}>{value}</Text>
      <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.4 }}>{label}</Text>
      {sub ? <Text style={{ fontSize: 9, color: tc.textMuted, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  );

  const FindingRow = ({ icon, text, color }: { icon: string; text: string; color: string }) => (
    <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10, alignItems: 'flex-start' }}>
      <Ionicons name={icon as any} size={16} color={color} style={{ marginTop: 2 }} />
      <Text style={{ flex: 1, fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>{text}</Text>
    </View>
  );

  const renderStep1 = () => {
    if (loading || !summary) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <ActivityIndicator color={tc.primary} />
          <Text style={{ color: tc.textMuted, fontSize: 13 }}>Loading your week...</Text>
        </View>
      );
    }

    const adherencePct = Math.round(summary.workout_adherence_pct ?? summary.adherence_pct);
    const adherenceColor = adherencePct >= 80 ? tc.success : adherencePct >= 60 ? tc.warning : tc.error;
    const nutritionLoggingPct = Math.round(summary.nutrition_logging_pct ?? summary.nutrition_adherence_pct);

    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
        <Text style={{ fontSize: 13, color: tc.textMuted, lineHeight: 20 }}>{summary.headline}</Text>

        <View style={{ backgroundColor: tc.surface, borderRadius: radius.md, padding: 16, borderWidth: 1, borderColor: tc.border }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={{ fontSize: 12, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.5 }}>WORKOUT ADHERENCE</Text>
            <Text style={{ fontSize: 16, fontWeight: '900', color: adherenceColor }}>{adherencePct}%</Text>
          </View>
          <View style={{ height: 6, backgroundColor: tc.border, borderRadius: 3, overflow: 'hidden' }}>
            <View style={{ height: '100%', width: `${adherencePct}%`, backgroundColor: adherenceColor, borderRadius: 3 }} />
          </View>
          <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 8 }}>
            {summary.completed_workouts} of {summary.planned_workouts} planned workouts completed
            {summary.missed_workouts > 0 ? ` - ${summary.missed_workouts} missed` : ''}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <StatBox label="CARDIO" value={`${Math.round(summary.cardio_minutes)}m`} />
          <StatBox label="ZONE 2" value={`${Math.round(summary.zone2_minutes)}m`} />
          {summary.avg_sleep_hours != null && (
            <StatBox label="AVG SLEEP" value={`${summary.avg_sleep_hours.toFixed(1)}h`} />
          )}
        </View>

        <View style={{ backgroundColor: tc.surface, borderRadius: radius.md, padding: 12, borderWidth: 1, borderColor: tc.border }}>
          <Text style={{ fontSize: 11, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.4 }}>NUTRITION LOGGING</Text>
          <Text style={{ fontSize: 13, color: tc.textSecondary, marginTop: 4, lineHeight: 18 }}>
            {nutritionLoggingPct}% coverage - {summary.days_logged} of 7 day{summary.days_logged !== 1 ? 's' : ''} tracked
          </Text>
          {summary.nutrition_summary ? (
            <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 6, lineHeight: 17 }}>
              {summary.nutrition_summary}
            </Text>
          ) : summary.days_logged > 0 ? (
            <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 6, lineHeight: 17 }}>
              Avg {Math.round(summary.avg_calories ?? 0)} kcal - {Math.round(summary.avg_protein_g ?? 0)}g protein - {Math.round(summary.avg_fiber_g ?? 0)}g fiber.
            </Text>
          ) : (
            <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 6, lineHeight: 17 }}>
              No nutrition data yet, so this review keeps calorie and macro guidance informational.
            </Text>
          )}
        </View>

        {summary.goal_forecast && (
          <View style={{ backgroundColor: tc.surface, borderRadius: radius.md, padding: 12, borderWidth: 1, borderColor: tc.primary + '44' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <Text style={{ fontSize: 11, color: tc.primary, fontWeight: '900', letterSpacing: 0.5 }}>GOAL ESTIMATE</Text>
              <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '800', textTransform: 'uppercase' }}>
                {summary.goal_forecast.confidence}
              </Text>
            </View>
            <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginTop: 6, lineHeight: 18 }}>
              {summary.goal_forecast.headline}
            </Text>
            <Text style={{ fontSize: 12, color: tc.textSecondary, marginTop: 5, lineHeight: 17 }}>
              {summary.goal_forecast.update_reason}
            </Text>
            <Text style={{ fontSize: 11, color: tc.textMuted, marginTop: 4, lineHeight: 15 }}>
              {summary.goal_forecast.assumption}
            </Text>
          </View>
        )}
      </ScrollView>
    );
  };

  const renderStep2 = () => {
    const findings = summary?.coach_findings;
    const hasFindings = !!findings && (
      findings.wins.length > 0
      || findings.needs_attention.length > 0
      || findings.recovery_notes.length > 0
      || findings.nutrition_notes.length > 0
    );

    if (!hasFindings) {
      return (
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
          <View style={{ backgroundColor: tc.surface, borderRadius: radius.md, padding: 16, borderWidth: 1, borderColor: tc.border }}>
            <Text style={{ fontSize: 14, fontWeight: '800', color: tc.textPrimary }}>No major review notes</Text>
            <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 20, marginTop: 6 }}>
              There are no flagged coaching actions from this week. You can still tune the plan setup on the next screen.
            </Text>
          </View>
        </ScrollView>
      );
    }

    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }} showsVerticalScrollIndicator={false}>
        {findings.wins.length > 0 && (
          <View>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.success, letterSpacing: 0.6, marginBottom: 10 }}>WINS</Text>
            {findings.wins.map((w, i) => <FindingRow key={i} icon="checkmark-circle" text={w} color={tc.success} />)}
          </View>
        )}
        {findings.needs_attention.length > 0 && (
          <View>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.warning, letterSpacing: 0.6, marginBottom: 10 }}>NEEDS ATTENTION</Text>
            {findings.needs_attention.map((n, i) => <FindingRow key={i} icon="alert-circle" text={n} color={tc.warning} />)}
          </View>
        )}
        {findings.recovery_notes.length > 0 && (
          <View>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.primary, letterSpacing: 0.6, marginBottom: 10 }}>RECOVERY</Text>
            {findings.recovery_notes.map((r, i) => <FindingRow key={i} icon="bed" text={r} color={tc.primary} />)}
          </View>
        )}
        {findings.nutrition_notes.length > 0 && (
          <View>
            <Text style={{ fontSize: 11, fontWeight: '800', color: '#F59E0B', letterSpacing: 0.6, marginBottom: 10 }}>NUTRITION</Text>
            {findings.nutrition_notes.map((n, i) => <FindingRow key={i} icon="nutrition" text={n} color="#F59E0B" />)}
          </View>
        )}
      </ScrollView>
    );
  };

  const renderStep3 = () => {
    const draft = planSetup ?? baselineSetup;
    const updateDraft = (patch: Partial<PlanSetupDraft>) => {
      setPlanSetup(current => ({ ...(current ?? baselineSetup), ...patch }));
    };
    const setupIntro = currentWeekAlreadyGenerated
      ? 'Your new week is already generated. You can keep it, save setup changes for later, or rebuild the remaining unlocked days.'
      : 'These choices save to your profile now, so the next generated week can use them.';
    const Pill = ({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) => (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.75}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 9,
          borderRadius: radius.md,
          borderWidth: 1.5,
          borderColor: active ? tc.primary : tc.border,
          backgroundColor: active ? tc.primary + '16' : tc.surface,
          marginRight: 8,
          marginBottom: 8,
        }}
      >
        <Text style={{ fontSize: 13, fontWeight: '700', color: active ? tc.primary : tc.textSecondary }}>
          {label}
        </Text>
      </TouchableOpacity>
    );

    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 18 }} showsVerticalScrollIndicator={false}>
        <View style={{ backgroundColor: tc.surface, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: tc.border }}>
          <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 20 }}>{setupIntro}</Text>
        </View>

        <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary }}>Do you want to adjust the plan setup?</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity
            onPress={() => { setSetupMode('keep'); setApplySetupToCurrent(false); }}
            style={{
              flex: 1,
              padding: 14,
              borderRadius: radius.md,
              borderWidth: 1.5,
              borderColor: setupMode === 'keep' ? tc.primary : tc.border,
              backgroundColor: setupMode === 'keep' ? tc.primary + '16' : tc.surface,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '800', color: setupMode === 'keep' ? tc.primary : tc.textPrimary }}>Keep setup</Text>
            <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 3 }}>No schedule changes</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setSetupMode('tune')}
            style={{
              flex: 1,
              padding: 14,
              borderRadius: radius.md,
              borderWidth: 1.5,
              borderColor: setupMode === 'tune' ? tc.primary : tc.border,
              backgroundColor: setupMode === 'tune' ? tc.primary + '16' : tc.surface,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '800', color: setupMode === 'tune' ? tc.primary : tc.textPrimary }}>Tune setup</Text>
            <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 3 }}>Goal, days, split</Text>
          </TouchableOpacity>
        </View>

        {setupMode === 'tune' && (
          <>
            <View>
              <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 10 }}>GOAL</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {SETUP_GOALS.map(option => (
                  <Pill
                    key={option.value}
                    label={option.label}
                    active={draft.goal === option.value}
                    onPress={() => updateDraft({ goal: option.value })}
                  />
                ))}
              </View>
            </View>

            <View>
              <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 10 }}>TRAINING DAYS</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <TouchableOpacity
                  onPress={() => updateDraft({ daysPerWeek: Math.max(1, draft.daysPerWeek - 1) })}
                  disabled={draft.daysPerWeek <= 1}
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: radius.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 1,
                    borderColor: tc.border,
                    opacity: draft.daysPerWeek <= 1 ? 0.45 : 1,
                  }}
                >
                  <Ionicons name="remove" size={18} color={tc.textPrimary} />
                </TouchableOpacity>
                <View style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={{ fontSize: 28, fontWeight: '900', color: tc.textPrimary }}>{draft.daysPerWeek}</Text>
                  <Text style={{ fontSize: 12, color: tc.textMuted }}>day{draft.daysPerWeek !== 1 ? 's' : ''} per week</Text>
                </View>
                <TouchableOpacity
                  onPress={() => updateDraft({ daysPerWeek: Math.min(7, draft.daysPerWeek + 1) })}
                  disabled={draft.daysPerWeek >= 7}
                  style={{
                    width: 42,
                    height: 42,
                    borderRadius: radius.md,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderWidth: 1,
                    borderColor: tc.border,
                    opacity: draft.daysPerWeek >= 7 ? 0.45 : 1,
                  }}
                >
                  <Ionicons name="add" size={18} color={tc.textPrimary} />
                </TouchableOpacity>
              </View>
            </View>

            <View>
              <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 10 }}>SESSION LENGTH</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {SESSION_MINUTES.map(minutes => (
                  <Pill
                    key={minutes}
                    label={`${minutes} min`}
                    active={draft.sessionMinutes === minutes}
                    onPress={() => updateDraft({ sessionMinutes: minutes })}
                  />
                ))}
              </View>
            </View>

            <View>
              <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 10 }}>SPLIT</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                {SETUP_SPLITS.map(option => (
                  <Pill
                    key={option.value}
                    label={option.label}
                    active={draft.preferredSplit === option.value}
                    onPress={() => updateDraft({ preferredSplit: option.value })}
                  />
                ))}
              </View>
            </View>

            {hasSetupChanges ? (
              <View style={{ gap: 10 }}>
                <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary }}>When should these changes apply?</Text>
                <TouchableOpacity
                  onPress={() => setApplySetupToCurrent(false)}
                  style={{
                    padding: 13,
                    borderRadius: radius.md,
                    borderWidth: 1.5,
                    borderColor: !applySetupToCurrent ? tc.primary : tc.border,
                    backgroundColor: !applySetupToCurrent ? tc.primary + '14' : tc.surface,
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '800', color: !applySetupToCurrent ? tc.primary : tc.textPrimary }}>
                    Future generated weeks
                  </Text>
                  <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 3 }}>Current week stays as generated.</Text>
                </TouchableOpacity>
                {currentWeekAlreadyGenerated && (
                  <TouchableOpacity
                    onPress={() => setApplySetupToCurrent(true)}
                    style={{
                      padding: 13,
                      borderRadius: radius.md,
                      borderWidth: 1.5,
                      borderColor: applySetupToCurrent ? tc.primary : tc.border,
                      backgroundColor: applySetupToCurrent ? tc.primary + '14' : tc.surface,
                    }}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '800', color: applySetupToCurrent ? tc.primary : tc.textPrimary }}>
                      Rebuild remaining days this week
                    </Text>
                    <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 3 }}>
                      Completed, skipped, and started days stay locked.
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : (
              <Text style={{ fontSize: 12, color: tc.textMuted, lineHeight: 18 }}>
                No setup changes selected.
              </Text>
            )}
          </>
        )}
      </ScrollView>
    );
  };

  const renderStep4 = () => {
    const setupMessage = settingsError
      ?? settingsResult?.explanation
      ?? 'No plan setup changes were saved. Your generated week stays as-is.';

    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
        <View style={{
          backgroundColor: tc.success + '18',
          borderRadius: radius.md,
          padding: 16,
          borderWidth: 1,
          borderColor: tc.success + '40',
        }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: tc.success, marginBottom: 6 }}>
            Review complete
          </Text>
          <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 20 }}>
            This was informational only. No coach recommendations were applied.
          </Text>
        </View>

        <View style={{
          backgroundColor: settingsError ? tc.error + '12' : tc.primary + '12',
          borderRadius: radius.md,
          padding: 14,
          borderWidth: 1,
          borderColor: settingsError ? tc.error + '55' : tc.primary + '44',
        }}>
          <Text style={{ fontSize: 11, fontWeight: '900', color: settingsError ? tc.error : tc.primary, letterSpacing: 0.5, marginBottom: 6 }}>
            PLAN SETUP
          </Text>
          <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 19 }}>
            {setupMessage}
          </Text>
        </View>

        <TouchableOpacity
          style={{
            backgroundColor: tc.primary,
            borderRadius: radius.md,
            padding: 16,
            alignItems: 'center',
            marginTop: 8,
          }}
          onPress={() => { onComplete(false); onClose(); }}
        >
          <Text style={{ fontSize: 15, fontWeight: '800', color: primaryTextColor }}>Done</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  };

  const STEP_TITLES: Record<Step, string> = {
    1: 'Weekly Scorecard',
    2: 'Review Notes',
    3: 'Plan Setup',
    4: 'Summary',
  };

  const canAdvance: Record<Step, boolean> = {
    1: !!summary && !loading,
    2: true,
    3: true,
    4: true,
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tc.background }}>
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 16,
          paddingTop: Platform.OS === 'ios' ? 8 : 24,
          paddingBottom: 12,
          borderBottomWidth: 1,
          borderBottomColor: tc.border,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.6 }}>
              WEEK IN REVIEW  -  {step}/4
            </Text>
            <Text style={{ fontSize: 17, fontWeight: '800', color: tc.textPrimary }}>
              {STEP_TITLES[step]}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={24} color={tc.textPrimary} />
          </TouchableOpacity>
        </View>

        <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 8, gap: 4 }}>
          {([1, 2, 3, 4] as Step[]).map(s => (
            <View
              key={s}
              style={{
                flex: 1,
                height: 3,
                borderRadius: 2,
                backgroundColor: s <= step ? tc.primary : tc.border,
              }}
            />
          ))}
        </View>

        <View style={{ flex: 1 }}>
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
          {step === 4 && renderStep4()}
        </View>

        {step < 3 && (
          <View style={{
            flexDirection: 'row',
            gap: 12,
            padding: 16,
            borderTopWidth: 1,
            borderTopColor: tc.border,
          }}>
            {step > 1 && (
              <TouchableOpacity
                style={{
                  flex: 1,
                  padding: 14,
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: tc.border,
                  alignItems: 'center',
                }}
                onPress={() => setStep((step - 1) as Step)}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textSecondary }}>Back</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={{
                flex: 2,
                padding: 14,
                borderRadius: radius.md,
                backgroundColor: canAdvance[step] ? tc.primary : tc.border,
                alignItems: 'center',
              }}
              onPress={() => canAdvance[step] && setStep((step + 1) as Step)}
              disabled={!canAdvance[step]}
            >
              <Text style={{ fontSize: 14, fontWeight: '800', color: canAdvance[step] ? primaryTextColor : tc.textMuted }}>
                {step === 2 ? 'Plan setup' : 'Next'}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 3 && (
          <View style={{
            flexDirection: 'row',
            gap: 12,
            padding: 16,
            borderTopWidth: 1,
            borderTopColor: tc.border,
          }}>
            <TouchableOpacity
              style={{
                flex: 1,
                padding: 14,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: tc.border,
                alignItems: 'center',
              }}
              onPress={() => setStep(2)}
              disabled={savingSetup}
            >
              <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textSecondary }}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{
                flex: 2,
                padding: 14,
                borderRadius: radius.md,
                backgroundColor: tc.primary,
                alignItems: 'center',
                opacity: savingSetup ? 0.7 : 1,
              }}
              onPress={handleFinishReview}
              disabled={savingSetup}
            >
              {savingSetup ? (
                <ActivityIndicator size="small" color={primaryTextColor} />
              ) : (
                <Text style={{ fontSize: 14, fontWeight: '800', color: primaryTextColor }}>
                  {hasSetupChanges ? 'Save setup' : 'Done'}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}
