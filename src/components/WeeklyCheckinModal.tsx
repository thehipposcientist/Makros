// Weekly end-of-week coach check-in — 5-step structured flow.
//
// Step 1: Scorecard — adherence, cardio, strength summary + coach headline
// Step 2: Coach findings — wins, needs attention, recovery notes
// Step 3: Quick questions — 3-4 tap-based questions (no text input)
// Step 4: Recommended adjustments — concrete next-week changes
// Step 5: Decision — apply / customize / keep / easier / harder
//
// No free-text input. All questions are tap-option selections.
// Deterministic backend; no AI calls in this flow.

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, Modal, ScrollView, TouchableOpacity,
  ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { getTheme, radius } from '../constants/theme';
import { AppThemeName } from '../types';
import { humanizeToken } from '../utils/exerciseGuide';
import {
  getWeekSummary, postWeekCheckin,
  WeekSummaryResponse, WeekCheckinAnswers,
  WeekCheckinResponse, RecommendedAdjustments,
  DifficultyRating, BlockerType, PainArea, CheckinDecision,
  submitPlanWeekCheckin, PlanWeekCheckinRecord,
} from '../services/api';

interface Props {
  visible: boolean;
  authToken: string;
  planWeekId?: number | null;
  weekStart?: string | null;
  weekEnd?: string | null;
  goal?: string;
  themeName?: AppThemeName;
  // Optional health signals to pass to backend
  weightSlopeLbsPerWeek?: number | null;
  avgSleepHours?: number | null;
  avgRestingHr?: number | null;
  avgSteps?: number | null;
  onClose: () => void;
  onComplete: (applied: boolean, result?: WeekCheckinResponse | PlanWeekCheckinRecord) => void;
  onSkip?: () => void;
}

type Step = 1 | 2 | 3 | 4 | 5;

interface Answers {
  difficulty?: DifficultyRating;
  blocker?: BlockerType;
  pain?: PainArea;
  goalQ4?: string;
}

const DIFFICULTY_OPTIONS: Array<{ value: DifficultyRating; label: string }> = [
  { value: 'too_easy',           label: 'Too easy' },
  { value: 'about_right',        label: 'About right' },
  { value: 'too_hard',           label: 'Too hard' },
  { value: 'too_time_consuming', label: 'Too time-consuming' },
  { value: 'did_not_like_plan',  label: 'Didn\'t like the plan' },
];

const BLOCKER_OPTIONS: Array<{ value: BlockerType; label: string }> = [
  { value: 'none',                 label: 'No blocker' },
  { value: 'time',                 label: 'Time' },
  { value: 'fatigue',              label: 'Fatigue / low energy' },
  { value: 'soreness',             label: 'Soreness' },
  { value: 'equipment',            label: 'Equipment' },
  { value: 'motivation',           label: 'Motivation' },
  { value: 'cardio_boring',        label: 'Cardio was boring' },
  { value: 'exercise_discomfort',  label: 'Exercise discomfort' },
  { value: 'nutrition_hard',       label: 'Nutrition was hard' },
];

const PAIN_OPTIONS: Array<{ value: PainArea; label: string }> = [
  { value: 'none',        label: 'None' },
  { value: 'shoulder',    label: 'Shoulder' },
  { value: 'elbow_wrist', label: 'Elbow / wrist' },
  { value: 'low_back',    label: 'Low back' },
  { value: 'knee',        label: 'Knee' },
  { value: 'hip',         label: 'Hip' },
  { value: 'foot_ankle',  label: 'Foot / ankle' },
  { value: 'other',       label: 'Other' },
];

const GOAL_Q4: Record<string, { question: string; options: Array<{ value: string; label: string }> }> = {
  muscle_gain: {
    question: 'Which muscle to prioritize next week?',
    options: [
      { value: 'no_preference', label: 'No preference' },
      { value: 'chest',         label: 'Chest' },
      { value: 'back',          label: 'Back' },
      { value: 'shoulders',     label: 'Shoulders' },
      { value: 'arms',          label: 'Arms' },
      { value: 'legs',          label: 'Legs' },
      { value: 'core',          label: 'Core' },
    ],
  },
  body_recomp: {
    question: 'Which muscle to prioritize next week?',
    options: [
      { value: 'no_preference', label: 'No preference' },
      { value: 'chest',         label: 'Chest' },
      { value: 'back',          label: 'Back' },
      { value: 'shoulders',     label: 'Shoulders' },
      { value: 'arms',          label: 'Arms' },
      { value: 'legs',          label: 'Legs' },
    ],
  },
  fat_loss: {
    question: 'What was hardest to stick to?',
    options: [
      { value: 'hunger',        label: 'Hunger' },
      { value: 'energy',        label: 'Low energy' },
      { value: 'meal_logging',  label: 'Logging meals' },
      { value: 'cardio',        label: 'Cardio sessions' },
      { value: 'weekend_eating',label: 'Weekend eating' },
      { value: 'protein',       label: 'Hitting protein' },
    ],
  },
  strength: {
    question: 'How did the heavy sets feel?',
    options: [
      { value: 'too_light',     label: 'Too light — could go heavier' },
      { value: 'about_right',   label: 'About right' },
      { value: 'too_heavy',     label: 'Too heavy — form suffered' },
    ],
  },
  endurance: {
    question: 'Preferred cardio mode?',
    options: [
      { value: 'running',       label: 'Running' },
      { value: 'cycling',       label: 'Cycling / bike' },
      { value: 'incline_walk',  label: 'Incline walk' },
      { value: 'rowing',        label: 'Rowing' },
      { value: 'mixed',         label: 'Mixed / no preference' },
    ],
  },
  general_health: {
    question: 'What should next week focus on?',
    options: [
      { value: 'zone2',          label: 'More Zone 2 cardio' },
      { value: 'steps',          label: 'Daily step goal' },
      { value: 'sleep',          label: 'Better sleep alignment' },
      { value: 'mobility',       label: 'Mobility work' },
      { value: 'strength',       label: 'Strength consistency' },
      { value: 'reduce_fatigue', label: 'Reduce fatigue' },
    ],
  },
  longevity: {
    question: 'What should next week focus on?',
    options: [
      { value: 'zone2',          label: 'Zone 2 cardio' },
      { value: 'mobility',       label: 'Mobility / flexibility' },
      { value: 'strength',       label: 'Strength' },
      { value: 'reduce_fatigue', label: 'Reduce fatigue' },
      { value: 'sleep',          label: 'Sleep quality' },
    ],
  },
};

const DECISION_OPTIONS: Array<{ value: CheckinDecision; label: string; sub: string }> = [
  { value: 'apply_recommendations', label: 'Apply recommendations', sub: 'Let the coach adjust next week' },
  { value: 'keep_current_style',    label: 'Keep current style',    sub: 'Same structure, no changes' },
  { value: 'make_easier',           label: 'Make it easier',        sub: 'Lighter loads and shorter sessions' },
  { value: 'make_harder',           label: 'Make it harder',        sub: 'More volume and intensity' },
];

function humanList(items: string[]): string {
  return items.map(item => humanizeToken(item).toLowerCase()).join(', ');
}

export default function WeeklyCheckinModal({
  visible, authToken, goal = 'body_recomp', themeName, onClose, onComplete,
  planWeekId, weekEnd, onSkip,
  weightSlopeLbsPerWeek, avgSleepHours, avgRestingHr, avgSteps,
}: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;

  const [step, setStep] = useState<Step>(1);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<WeekSummaryResponse | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [checkinResult, setCheckinResult] = useState<WeekCheckinResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Fetch summary on open
  useEffect(() => {
    if (!visible || !authToken) return;
    setStep(1);
    setAnswers({});
    setCheckinResult(null);
    setLoading(true);
    getWeekSummary(authToken, { planWeekId, endDate: weekEnd })
      .then(s => setSummary(s))
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, [visible, authToken, planWeekId, weekEnd]);

  const goalQ4Config = GOAL_Q4[goal] ?? GOAL_Q4.general_health;

  const handleSubmit = useCallback(async (decision: CheckinDecision) => {
    if (!authToken) return;
    setSubmitting(true);
    try {
      const payload: WeekCheckinAnswers = {
        overall_difficulty: answers.difficulty,
        biggest_blocker: answers.blocker,
        pain_area: answers.pain,
        goal_q4: answers.goalQ4,
        user_decision: decision,
        weight_slope_lbs_per_week: weightSlopeLbsPerWeek ?? null,
        avg_sleep_hours: avgSleepHours ?? null,
        avg_resting_hr: avgRestingHr ?? null,
        avg_steps: avgSteps ?? null,
      };
      if (planWeekId) {
        const result = await submitPlanWeekCheckin(authToken, planWeekId, {
          overall_difficulty: answers.difficulty,
          biggest_blocker: answers.blocker,
          pain_area: answers.pain,
          goal_q4: answers.goalQ4,
          user_decision: decision,
        });
        const normalized = normalizePlanWeekCheckinResult(result);
        setCheckinResult(normalized);
      } else {
        const result = await postWeekCheckin(authToken, payload);
        setCheckinResult(result);
      }
      setStep(5);
    } catch {
      // Still move to step 5 so user can close
      setStep(5);
    } finally {
      setSubmitting(false);
    }
  }, [authToken, planWeekId, answers, weightSlopeLbsPerWeek, avgSleepHours, avgRestingHr, avgSteps]);

  const emptyAdjustment = (): RecommendedAdjustments => ({
    difficulty_adjustment: 'same',
    volume_adjustment_pct: 0,
    intensity_adjustment: 'maintain',
    session_length_adjustment: null,
    cardio_adjustment: null,
    mobility_adjustment: null,
    nutrition_adjustment: null,
    muscle_priorities: [],
    avoid_patterns: [],
    preferred_cardio_modes: [],
    summary: 'No saved setting changes.',
  });

  const normalizePlanWeekCheckinResult = (record: PlanWeekCheckinRecord): WeekCheckinResponse => {
    const snap = record.review_snapshot_json ?? {};
    const summary = (snap.structured_adjustment ?? emptyAdjustment()) as RecommendedAdjustments;
    const appliedRaw = Array.isArray(snap.structured_applied) ? snap.structured_applied : [];
    const applied = appliedRaw.map((item: any) => ({
      type: String(item?.type ?? 'applied'),
      summary: String(item?.summary ?? item?.type ?? 'Applied'),
      changed_fields: item?.changed_fields,
      verified: item?.verified,
    }));
    return {
      summary,
      applied,
      coach_message: record.ai_message ?? summary.summary ?? 'Your weekly check-in has been saved.',
    };
  };

  // ── Shared UI helpers ────────────────────────────────────────────────────────

  const chipStyle = (selected: boolean) => ({
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: selected ? tc.primary : tc.border,
    backgroundColor: selected ? tc.primary + '18' : tc.surface,
    marginBottom: 8,
  });

  const chipTextStyle = (selected: boolean) => ({
    fontSize: 14,
    fontWeight: selected ? '700' as const : '500' as const,
    color: selected ? tc.primary : tc.textSecondary,
  });

  const renderChips = <T extends string>(
    options: Array<{ value: T; label: string }>,
    selected: T | undefined,
    onSelect: (v: T) => void,
  ) => (
    <View style={{ gap: 0 }}>
      {options.map(o => (
        <TouchableOpacity
          key={o.value}
          style={chipStyle(selected === o.value)}
          onPress={() => onSelect(o.value)}
          activeOpacity={0.75}
        >
          <Text style={chipTextStyle(selected === o.value)}>{o.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  const StatBox = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
    <View style={{
      flex: 1, alignItems: 'center', padding: 12,
      backgroundColor: tc.surface, borderRadius: radius.md,
      borderWidth: 1, borderColor: tc.border,
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

  // ── Step content ─────────────────────────────────────────────────────────────

  const renderStep1 = () => {
    if (loading || !summary) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <ActivityIndicator color={tc.primary} />
          <Text style={{ color: tc.textMuted, fontSize: 13 }}>Loading your week…</Text>
        </View>
      );
    }
    const adherencePct = Math.round(summary.workout_adherence_pct ?? summary.adherence_pct);
    const adherenceColor = adherencePct >= 80 ? tc.success : adherencePct >= 60 ? tc.warning : tc.error;
    const nutritionLoggingPct = Math.round(summary.nutrition_logging_pct ?? summary.nutrition_adherence_pct);
    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
        <Text style={{ fontSize: 13, color: tc.textMuted, lineHeight: 20 }}>{summary.headline}</Text>

        {/* Adherence bar */}
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
            {summary.missed_workouts > 0 ? ` · ${summary.missed_workouts} missed` : ''}
          </Text>
        </View>

        {/* Stat grid */}
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
            {nutritionLoggingPct}% coverage — {summary.days_logged} of 7 day{summary.days_logged !== 1 ? 's' : ''} tracked
          </Text>
          {summary.nutrition_summary ? (
            <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 6, lineHeight: 17 }}>
              {summary.nutrition_summary}
            </Text>
          ) : summary.days_logged > 0 ? (
            <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 6, lineHeight: 17 }}>
              Avg {Math.round(summary.avg_calories ?? 0)} kcal · {Math.round(summary.avg_protein_g ?? 0)}g protein · {Math.round(summary.avg_fiber_g ?? 0)}g fiber.
            </Text>
          ) : (
            <Text style={{ fontSize: 12, color: tc.textMuted, marginTop: 6, lineHeight: 17 }}>
              No nutrition data yet, so the coach will hold calorie and macro changes.
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
    if (!findings) return null;
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

  const renderStep3 = () => (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 24 }} showsVerticalScrollIndicator={false}>
      <View>
        <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginBottom: 12 }}>
          How did this week feel?
        </Text>
        {renderChips(DIFFICULTY_OPTIONS, answers.difficulty, v => setAnswers(a => ({ ...a, difficulty: v })))}
      </View>

      <View>
        <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginBottom: 12 }}>
          Biggest blocker?
        </Text>
        {renderChips(BLOCKER_OPTIONS, answers.blocker, v => setAnswers(a => ({ ...a, blocker: v })))}
      </View>

      <View>
        <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginBottom: 12 }}>
          Any pain or discomfort?
        </Text>
        {renderChips(PAIN_OPTIONS, answers.pain, v => setAnswers(a => ({ ...a, pain: v })))}
      </View>

      <View>
        <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary, marginBottom: 12 }}>
          {goalQ4Config.question}
        </Text>
        {renderChips(goalQ4Config.options, answers.goalQ4, v => setAnswers(a => ({ ...a, goalQ4: v })))}
      </View>
    </ScrollView>
  );

  const renderAdjRow = (label: string, value: string | null | undefined, icon: string) => {
    if (!value) return null;
    return (
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10, alignItems: 'flex-start' }}>
        <Ionicons name={icon as any} size={14} color={tc.primary} style={{ marginTop: 3 }} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 11, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.4 }}>{label}</Text>
          <Text style={{ fontSize: 13, color: tc.textSecondary, marginTop: 2 }}>{value}</Text>
        </View>
      </View>
    );
  };

  const renderStep4 = () => {
    if (submitting) {
      return (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <ActivityIndicator color={tc.primary} />
          <Text style={{ color: tc.textMuted, fontSize: 13 }}>Computing next week…</Text>
        </View>
      );
    }

    // Build a preview from the answers without submitting
    const adherence = summary?.adherence_pct ?? 0;
    const difficulty = answers.difficulty;
    const blocker = answers.blocker;
    const pain = answers.pain;

    let previewMessage = 'Continuing with the same plan structure.';
    if (pain && pain !== 'none') previewMessage = `Adjusting to protect the ${pain.replace('_', '/')} area.`;
    else if (adherence < 65 && blocker === 'time') previewMessage = 'Shortening sessions and trimming accessories.';
    else if (difficulty === 'too_hard') previewMessage = 'Dialing back intensity — finishable sessions.';
    else if (difficulty === 'too_easy' && adherence >= 80) previewMessage = 'Stepping up load and volume.';
    else if (difficulty === 'did_not_like_plan') previewMessage = 'Prioritizing exercise variety.';
    else if (blocker === 'nutrition_hard') previewMessage = 'Keeping training steady and simplifying the nutrition target.';

    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 20 }} showsVerticalScrollIndicator={false}>
        <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 20 }}>
          Based on your answers, here's what I recommend for next week:
        </Text>

        <View style={{
          backgroundColor: tc.surface, borderRadius: radius.md,
          padding: 16, borderWidth: 1, borderColor: tc.primary + '40',
        }}>
          <Text style={{ fontSize: 14, fontWeight: '700', color: tc.primary, marginBottom: 8 }}>Coach Note</Text>
          <Text style={{ fontSize: 14, color: tc.textPrimary, lineHeight: 21 }}>{previewMessage}</Text>
        </View>

        <Text style={{ fontSize: 13, fontWeight: '800', color: tc.textPrimary }}>How do you want to proceed?</Text>

        {DECISION_OPTIONS.map(d => (
          <TouchableOpacity
            key={d.value}
            style={{
              padding: 14, borderRadius: radius.md,
              borderWidth: 1.5, borderColor: tc.border,
              backgroundColor: tc.surface, gap: 2,
            }}
            onPress={() => handleSubmit(d.value)}
            activeOpacity={0.75}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textPrimary }}>{d.label}</Text>
            <Text style={{ fontSize: 12, color: tc.textMuted }}>{d.sub}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    );
  };

  const renderStep5 = () => {
    const adj = checkinResult?.summary;
    return (
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} showsVerticalScrollIndicator={false}>
        <View style={{
          backgroundColor: tc.success + '18', borderRadius: radius.md,
          padding: 16, borderWidth: 1, borderColor: tc.success + '40',
        }}>
          <Text style={{ fontSize: 15, fontWeight: '800', color: tc.success, marginBottom: 6 }}>
            Check-in complete
          </Text>
          <Text style={{ fontSize: 13, color: tc.textSecondary, lineHeight: 20 }}>
            {checkinResult?.coach_message ?? 'Your answers have been recorded.'}
          </Text>
        </View>

        {adj && (
          <View style={{ backgroundColor: tc.surface, borderRadius: radius.md, padding: 16, borderWidth: 1, borderColor: tc.border }}>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 12 }}>NEXT WEEK CHANGES</Text>
            {renderAdjRow('VOLUME', adj.volume_adjustment_pct !== 0 ? `${adj.volume_adjustment_pct > 0 ? '+' : ''}${adj.volume_adjustment_pct}%` : 'No change', 'barbell-outline')}
            {renderAdjRow('INTENSITY', adj.intensity_adjustment !== 'maintain' ? adj.intensity_adjustment : undefined, 'trending-up-outline')}
            {renderAdjRow('SESSION LENGTH', adj.session_length_adjustment ?? undefined, 'time-outline')}
            {renderAdjRow('CARDIO', adj.cardio_adjustment ?? undefined, 'bicycle-outline')}
            {renderAdjRow('NUTRITION', adj.nutrition_adjustment ?? undefined, 'nutrition-outline')}
            {adj.muscle_priorities.length > 0 && renderAdjRow('PRIORITY MUSCLE', humanList(adj.muscle_priorities), 'body-outline')}
            {adj.avoid_patterns.length > 0 && renderAdjRow('AVOIDING', humanList(adj.avoid_patterns), 'shield-outline')}
          </View>
        )}

        {checkinResult && checkinResult.applied.length > 0 && (
          <View>
            <Text style={{ fontSize: 11, fontWeight: '800', color: tc.textMuted, letterSpacing: 0.5, marginBottom: 8 }}>APPLIED NOW</Text>
            {checkinResult.applied.map((a, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <Ionicons name="checkmark-circle" size={14} color={tc.success} />
                <Text style={{ fontSize: 13, color: tc.textSecondary, flex: 1 }}>{a.summary}</Text>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity
          style={{
            backgroundColor: tc.primary, borderRadius: radius.md,
            padding: 16, alignItems: 'center', marginTop: 8,
          }}
          onPress={() => { onComplete(!!checkinResult?.applied.length, checkinResult ?? undefined); onClose(); }}
        >
          <Text style={{ fontSize: 15, fontWeight: '800', color: '#FFF' }}>Done</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  };

  const STEP_TITLES: Record<Step, string> = {
    1: 'Weekly Scorecard',
    2: 'Coach Review',
    3: 'Quick Check-In',
    4: 'Recommendations',
    5: 'Summary',
  };

  const canAdvance: Record<Step, boolean> = {
    1: !!summary && !loading,
    2: true,
    3: true,
    4: true,
    5: true,
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: tc.background }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          paddingHorizontal: 16,
          paddingTop: Platform.OS === 'ios' ? 8 : 24,
          paddingBottom: 12,
          borderBottomWidth: 1, borderBottomColor: tc.border,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 10, color: tc.textMuted, fontWeight: '700', letterSpacing: 0.6 }}>
              WEEK IN REVIEW  ·  {step}/5
            </Text>
            <Text style={{ fontSize: 17, fontWeight: '800', color: tc.textPrimary }}>
              {STEP_TITLES[step]}
            </Text>
          </View>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
            <Ionicons name="close" size={24} color={tc.textPrimary} />
          </TouchableOpacity>
        </View>

        {/* Step indicator */}
        <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 8, gap: 4 }}>
          {([1, 2, 3, 4, 5] as Step[]).map(s => (
            <View
              key={s}
              style={{
                flex: 1, height: 3, borderRadius: 2,
                backgroundColor: s <= step ? tc.primary : tc.border,
              }}
            />
          ))}
        </View>

        {/* Content */}
        <View style={{ flex: 1 }}>
          {step === 1 && renderStep1()}
          {step === 2 && renderStep2()}
          {step === 3 && renderStep3()}
          {step === 4 && renderStep4()}
          {step === 5 && renderStep5()}
        </View>

        {/* Footer nav — not shown on steps 4 (decisions are the nav) and 5 */}
        {step < 4 && (
          <View style={{
            flexDirection: 'row', gap: 12, padding: 16,
            borderTopWidth: 1, borderTopColor: tc.border,
          }}>
            {step > 1 && (
              <TouchableOpacity
                style={{
                  flex: 1, padding: 14, borderRadius: radius.md,
                  borderWidth: 1, borderColor: tc.border, alignItems: 'center',
                }}
                onPress={() => setStep((step - 1) as Step)}
              >
                <Text style={{ fontSize: 14, fontWeight: '700', color: tc.textSecondary }}>Back</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={{
                flex: 2, padding: 14, borderRadius: radius.md,
                backgroundColor: canAdvance[step] ? tc.primary : tc.border,
                alignItems: 'center',
              }}
              onPress={() => canAdvance[step] && setStep((step + 1) as Step)}
              disabled={!canAdvance[step]}
            >
              <Text style={{ fontSize: 14, fontWeight: '800', color: canAdvance[step] ? '#FFF' : tc.textMuted }}>
                {step === 3 ? 'See Recommendations' : 'Next'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
        {step === 4 && onSkip && (
          <TouchableOpacity
            onPress={onSkip}
            style={{ alignItems: 'center', paddingBottom: 14 }}
          >
            <Text style={{ fontSize: 13, color: tc.textMuted, fontWeight: '600' }}>
              Skip this week's check-in
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </Modal>
  );
}
