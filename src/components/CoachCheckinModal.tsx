import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  ScrollView,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { getContrastingTextColor, getTheme, radius } from '../constants/theme';
import { cleanAiText } from '../utils/aiText';
import type { AppThemeName } from '../types';
import {
  submitCoachCheckin,
  submitPlanWeekCheckin,
  CoachCheckinFeedback,
  CoachCheckinResponse,
  PlanWeekCheckinRecord,
  getWeeklyReview,
  WeeklyReviewResponse,
  applyRecommendationAction,
} from '../services/api';

/**
 * Fast, form-first check-in UX (section 9 of the design doc):
 *   - 4 required taps: energy, hunger, soreness, motivation
 *   - Optional: schedule issue, free-text note
 *   - Submit → POST /coach/checkin → show response message + any flags
 *   - User can tap "Ask a question" later (not implemented yet — phase 5)
 *
 * Aim: a user who doesn't want to type finishes in 4 taps + Submit.
 */

interface Props {
  visible: boolean;
  authToken: string;
  onClose: () => void;
  /** Called after a successful check-in so the parent can refresh state. */
  onCompleted?: (response: CoachCheckinResponse | PlanWeekCheckinRecord) => void;
  /** Active theme — falls back to `midnight` when not provided. */
  themeName?: AppThemeName;
  /** When set, submit hits the durable plan-week check-in endpoint (one-time per week). */
  planWeekId?: number | null;
  /** When true, skip the form and show the saved recap from existingCheckin. */
  readOnly?: boolean;
  existingCheckin?: PlanWeekCheckinRecord | null;
  /** Shown as a secondary link when the user can skip this week's check-in. */
  onSkip?: () => void;
}

type Scale = 1 | 2 | 3 | 4 | 5;
type DifficultyRating = 'too_easy' | 'about_right' | 'too_hard' | 'too_time_consuming' | 'did_not_like_plan';
type BlockerType = 'time' | 'fatigue' | 'soreness' | 'equipment' | 'motivation' | 'cardio_boring' | 'exercise_discomfort' | 'nutrition_hard' | 'none';
type PainArea = 'none' | 'shoulder' | 'elbow_wrist' | 'low_back' | 'knee' | 'hip' | 'foot_ankle' | 'other';

const SCALE_LABELS: Record<string, string[]> = {
  energy:     ['Drained', 'Low',  'OK',     'Good',  'Great'],
  hunger:     ['None',    'Mild', 'Normal', 'High',  'Ravenous'],
  soreness:   ['None',    'Mild', 'Some',   'High',  'Severe'],
  motivation: ['Zero',    'Low',  'OK',     'Good',  'Fired up'],
};

const DIFFICULTY_OPTIONS: Array<{ value: DifficultyRating; label: string }> = [
  { value: 'about_right', label: 'About right' },
  { value: 'too_easy', label: 'Too easy' },
  { value: 'too_hard', label: 'Too hard' },
  { value: 'too_time_consuming', label: 'Too long' },
  { value: 'did_not_like_plan', label: 'Did not like it' },
];

const BLOCKER_OPTIONS: Array<{ value: BlockerType; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'time', label: 'Time' },
  { value: 'fatigue', label: 'Fatigue' },
  { value: 'soreness', label: 'Soreness' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'motivation', label: 'Motivation' },
  { value: 'cardio_boring', label: 'Cardio bored me' },
  { value: 'exercise_discomfort', label: 'Exercise discomfort' },
  { value: 'nutrition_hard', label: 'Nutrition was hard' },
];

const PAIN_OPTIONS: Array<{ value: PainArea; label: string }> = [
  { value: 'none', label: 'No pain' },
  { value: 'shoulder', label: 'Shoulder' },
  { value: 'elbow_wrist', label: 'Elbow/wrist' },
  { value: 'low_back', label: 'Low back' },
  { value: 'knee', label: 'Knee' },
  { value: 'hip', label: 'Hip' },
  { value: 'foot_ankle', label: 'Foot/ankle' },
  { value: 'other', label: 'Other' },
];

export default function CoachCheckinModal({
  visible, authToken, onClose, onCompleted, themeName,
  planWeekId, readOnly, existingCheckin, onSkip,
}: Props) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  const [energy, setEnergy] = useState<Scale | null>(null);
  const [hunger, setHunger] = useState<Scale | null>(null);
  const [soreness, setSoreness] = useState<Scale | null>(null);
  const [motivation, setMotivation] = useState<Scale | null>(null);
  const [difficulty, setDifficulty] = useState<DifficultyRating | null>(null);
  const [blocker, setBlocker] = useState<BlockerType | null>(null);
  const [painArea, setPainArea] = useState<PainArea | null>(null);
  const [scheduleIssue, setScheduleIssue] = useState(false);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<CoachCheckinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applyNotice, setApplyNotice] = useState<string | null>(null);
  // Trainer / nutritionist summary fetched from the deterministic
  // weekly review. Shown above the rating form so the check-in reads
  // as "here's what the coach saw, does this match your experience?"
  // rather than "tell us from scratch." Leads the user into
  // confirming / refining instead of composing.
  const [review, setReview] = useState<WeeklyReviewResponse | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setReviewLoading(true);
    (async () => {
      try {
        const r = await getWeeklyReview(authToken, { days: 7 });
        if (!cancelled) setReview(r);
      } catch { /* non-fatal — check-in still works without it */ }
      finally { if (!cancelled) setReviewLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [visible, authToken]);

  const reset = () => {
    setEnergy(null);
    setHunger(null);
    setSoreness(null);
    setMotivation(null);
    setDifficulty(null);
    setBlocker(null);
    setPainArea(null);
    setScheduleIssue(false);
    setNote('');
    setShowNote(false);
    setResponse(null);
    setError(null);
    setApplyNotice(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (planWeekId) {
        // Durable plan-week check-in — one-time per week, saves AI response
        const res = await submitPlanWeekCheckin(authToken, planWeekId, {
          energy: energy ?? undefined,
          hunger: hunger ?? undefined,
          soreness: soreness ?? undefined,
          motivation: motivation ?? undefined,
          schedule_issue: scheduleIssue,
          note: note.trim() || undefined,
          overall_difficulty: difficulty ?? undefined,
          biggest_blocker: blocker ?? undefined,
          pain_area: painArea ?? undefined,
        });
        setResponse(res as any);
        onCompleted?.(res);
      } else {
        // Legacy manual check-in (non-plan-week context)
        const feedback: CoachCheckinFeedback = {};
        if (energy !== null) feedback.energy = energy;
        if (hunger !== null) feedback.hunger = hunger;
        if (soreness !== null) feedback.soreness = soreness;
        if (motivation !== null) feedback.motivation = motivation;
        if (scheduleIssue) feedback.schedule_issue = true;
        if (note.trim()) feedback.note = note.trim();
        const res = await submitCoachCheckin(authToken, { checkin_type: 'manual', feedback });
        setResponse(res);
        onCompleted?.(res);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Check-in failed');
    } finally {
      setSubmitting(false);
    }
  };

  const renderScale = (
    label: string,
    key: 'energy' | 'hunger' | 'soreness' | 'motivation',
    value: Scale | null,
    setValue: (v: Scale) => void,
  ) => (
    <View style={styles.scaleBlock}>
      <Text style={styles.scaleLabel}>{label}</Text>
      <View style={styles.scaleRow}>
        {[1, 2, 3, 4, 5].map((n) => {
          const active = value === n;
          return (
            <TouchableOpacity
              key={n}
              style={[styles.scaleDot, active && styles.scaleDotActive]}
              onPress={() => setValue(n as Scale)}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
              <Text style={[styles.scaleDotText, active && styles.scaleDotTextActive]}>{n}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <Text style={styles.scaleHint}>
        {value ? SCALE_LABELS[key][value - 1] : 'Tap to rate'}
      </Text>
    </View>
  );

  function renderChipGroup<T extends string>(
    label: string,
    options: Array<{ value: T; label: string }>,
    value: T | null,
    setValue: (next: T) => void,
  ) {
    return (
      <View style={styles.chipBlock}>
        <Text style={styles.scaleLabel}>{label}</Text>
        <View style={styles.chipRow}>
          {options.map((option) => {
            const active = value === option.value;
            return (
              <TouchableOpacity
                key={option.value}
                style={[styles.checkinChip, active && styles.checkinChipActive]}
                onPress={() => setValue(option.value)}>
                <Text style={[styles.checkinChipText, active && styles.checkinChipTextActive]}>
                  {option.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    );
  }

  const responseColor = (type: string) => {
    switch (type) {
      case 'small_adjust':
      case 'deep_review':
        return colors.accent;
      case 'ask_more':
        return '#F59E0B';
      case 'leave_alone':
        return colors.textMuted;
      default:
        return colors.primary;
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={styles.cancelText}>Close</Text>
          </TouchableOpacity>
          <Text style={styles.title}>{readOnly ? 'Weekly recap' : 'Check in'}</Text>
          <View style={{ width: 50 }} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled">

            {/* Read-only recap: show saved check-in without the form */}
            {readOnly && existingCheckin ? (
              <>
                {existingCheckin.review_snapshot_json && (
                  <View style={{
                    backgroundColor: colors.surface, borderRadius: radius.lg,
                    padding: 14, marginBottom: 16,
                    borderWidth: 1, borderColor: colors.primary + '44',
                  }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: colors.primary, marginBottom: 6 }}>
                      WEEKLY REVIEW · {existingCheckin.week_start_date
                        ? `${new Date(existingCheckin.week_start_date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${new Date(existingCheckin.week_end_date + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                        : ''}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 16, marginBottom: existingCheckin.ai_message ? 12 : 0 }}>
                      {existingCheckin.review_snapshot_json.sessions_completed != null && (
                        <View>
                          <Text style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.4, fontWeight: '700' }}>SESSIONS</Text>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginTop: 1 }}>
                            {existingCheckin.review_snapshot_json.sessions_completed}/{existingCheckin.review_snapshot_json.sessions_planned}
                          </Text>
                        </View>
                      )}
                      {existingCheckin.review_snapshot_json.cardio_minutes != null && (
                        <View>
                          <Text style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.4, fontWeight: '700' }}>CARDIO</Text>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginTop: 1 }}>
                            {Math.round(existingCheckin.review_snapshot_json.cardio_minutes)}m
                          </Text>
                        </View>
                      )}
                      {existingCheckin.review_snapshot_json.avg_protein_g != null && existingCheckin.review_snapshot_json.days_logged > 0 && (
                        <View>
                          <Text style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.4, fontWeight: '700' }}>PROTEIN</Text>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginTop: 1 }}>
                            {Math.round(existingCheckin.review_snapshot_json.avg_protein_g)}g
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                )}

                {existingCheckin.ai_message && (
                  <View style={[styles.responseHeader, { borderLeftColor: colors.primary }]}>
                    <Text style={styles.responseType}>coach message</Text>
                    <Text style={styles.responseMessage}>{cleanAiText(existingCheckin.ai_message)}</Text>
                  </View>
                )}

                {existingCheckin.ai_delta && Object.keys(existingCheckin.ai_delta).length > 0 && (
                  <View style={styles.deltaBlock}>
                    <Text style={styles.deltaLabel}>Plan adjustment</Text>
                    {Object.entries(existingCheckin.ai_delta).map(([k, v]) => (
                      <Text key={k} style={styles.deltaLine}>
                        {k}: {typeof v === 'number' && v > 0 ? '+' : ''}{String(v)}
                      </Text>
                    ))}
                  </View>
                )}

                {existingCheckin.commitments_json && existingCheckin.commitments_json.length > 0 && (
                  <View style={styles.deltaBlock}>
                    <Text style={styles.deltaLabel}>Next week commitments</Text>
                    {existingCheckin.commitments_json.map((c, i) => (
                      <Text key={i} style={styles.deltaLine}>• {c.label ?? c.kind}</Text>
                    ))}
                  </View>
                )}

                {existingCheckin.energy != null && (
                  <View style={{ marginBottom: 16 }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.5, marginBottom: 8 }}>YOUR RATINGS</Text>
                    <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
                      {[
                        { label: 'ENERGY', value: existingCheckin.energy },
                        { label: 'HUNGER', value: existingCheckin.hunger },
                        { label: 'SORENESS', value: existingCheckin.soreness },
                        { label: 'MOTIVATION', value: existingCheckin.motivation },
                      ].filter(r => r.value != null).map(r => (
                        <View key={r.label}>
                          <Text style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.4, fontWeight: '700' }}>{r.label}</Text>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginTop: 1 }}>{r.value}/5</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}

                <TouchableOpacity style={styles.doneBtn} onPress={handleClose}>
                  <Text style={styles.doneBtnText}>Done</Text>
                </TouchableOpacity>
              </>
            ) : !response ? (
              <>
                {/* Trainer + nutritionist read for the week — lets the
                    check-in read as "confirm / refine" instead of the
                    old "tell us from scratch" survey. Deterministic
                    server data, no AI. */}
                {reviewLoading ? (
                  <View style={{ padding: 16, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={colors.primary} />
                  </View>
                ) : review ? (
                  <View style={{
                    backgroundColor: colors.surface,
                    borderRadius: radius.lg,
                    padding: 14,
                    marginBottom: 16,
                    borderWidth: 1,
                    borderColor: colors.primary + '44',
                  }}>
                    <Text style={{ fontSize: 10, fontWeight: '800', letterSpacing: 0.8, color: colors.primary, marginBottom: 6 }}>
                      TRAINER'S READ · THIS WEEK
                    </Text>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.textPrimary, lineHeight: 19 }}>
                      {review.headline}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 14, marginTop: 10 }}>
                      <View>
                        <Text style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.4, fontWeight: '700' }}>SESSIONS</Text>
                        <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginTop: 1 }}>
                          {review.sessions_completed}/{review.sessions_planned}
                        </Text>
                      </View>
                      <View>
                        <Text style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.4, fontWeight: '700' }}>CARDIO</Text>
                        <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginTop: 1 }}>
                          {Math.round(review.cardio_minutes)}m
                        </Text>
                      </View>
                      <View>
                        <Text style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.4, fontWeight: '700' }}>HARD SETS</Text>
                        <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginTop: 1 }}>
                          {Math.round(review.volume.total_hard_sets)}
                        </Text>
                      </View>
                      {review.days_logged > 0 && (
                        <View>
                          <Text style={{ fontSize: 9, color: colors.textMuted, letterSpacing: 0.4, fontWeight: '700' }}>PROTEIN</Text>
                          <Text style={{ fontSize: 13, fontWeight: '800', color: colors.textPrimary, marginTop: 1 }}>
                            {Math.round(review.avg_protein_g)}g
                          </Text>
                        </View>
                      )}
                    </View>
                    {/* Top 2 recs — the rest of the list lives on the
                        weekly coaching card. We surface the highest-
                        priority ones here to tee up a conversation. */}
                    {review.recommendations.length > 0 && (
                      <View style={{ marginTop: 12, gap: 6 }}>
                        {[...review.recommendations]
                          .sort((a, b) => {
                            const rank: Record<string, number> = { warn: 0, suggest: 1, info: 2 };
                            return (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9);
                          })
                          .slice(0, 2)
                          .map(rec => (
                            <View key={rec.key} style={{
                              flexDirection: 'row', gap: 8, alignItems: 'flex-start',
                              paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border + '55',
                            }}>
                              <View style={{
                                width: 4, height: 16, borderRadius: 2, marginTop: 2,
                                backgroundColor: rec.priority === 'warn' ? colors.error : rec.priority === 'suggest' ? colors.warning : colors.primary,
                              }} />
                              <View style={{ flex: 1 }}>
                                <Text style={{ fontSize: 12, fontWeight: '800', color: colors.textPrimary }}>
                                  {rec.title}
                                </Text>
                                <Text style={{ fontSize: 11, color: colors.textSecondary, marginTop: 2, lineHeight: 15 }}>
                                  {rec.detail}
                                </Text>
                                {/* Inline apply — same path as the
                                    Progress tab's coaching card. Maps
                                    to durable user settings, not
                                    plan_json. */}
                                {rec.action.type !== 'noop' && (
                                  <TouchableOpacity
                                    onPress={async () => {
                                      try {
                                        const applied = await applyRecommendationAction(authToken, rec.action, rec.key);
                                        // Show concise feedback then
                                        // remove the rec from view so
                                        // it's clear it was handled.
                                        setApplyNotice(applied.summary || 'Applied to your next generated week.');
                                        setReview(prev => prev ? {
                                          ...prev,
                                          recommendations: prev.recommendations.filter(x => x.key !== rec.key),
                                        } : prev);
                                        // Lightweight inline note —
                                        // we don't open an Alert so
                                        // the check-in flow stays smooth.
                                      } catch { /* swallow */ }
                                    }}
                                    style={{
                                      alignSelf: 'flex-start',
                                      marginTop: 6,
                                      paddingHorizontal: 10, paddingVertical: 4,
                                      borderRadius: 6,
                                      backgroundColor: rec.priority === 'warn' ? colors.error : rec.priority === 'suggest' ? colors.warning : colors.primary,
                                    }}>
                                    <Text style={{ fontSize: 10, fontWeight: '800', color: getContrastingTextColor(rec.priority === 'warn' ? colors.error : rec.priority === 'suggest' ? colors.warning : colors.primary) }}>
                                      Apply
                                    </Text>
                                  </TouchableOpacity>
                                )}
                              </View>
                            </View>
                          ))
                        }
                      </View>
                    )}
                    {applyNotice && (
                      <View style={[styles.deltaBlock, { marginTop: 12, marginBottom: 0, borderWidth: 1, borderColor: colors.primary + '44' }]}>
                        <Text style={styles.deltaLabel}>Applied for next plan</Text>
                        <Text style={styles.deltaLine}>{applyNotice}</Text>
                        <Text style={styles.deltaFootnote}>
                          Your current 7-day PlanWeek stays fixed; this changes the next generated week.
                        </Text>
                      </View>
                    )}
                  </View>
                ) : null}

                <Text style={styles.intro}>
                  {review
                    ? 'Does this match how the week felt? Confirm with a few taps.'
                    : "A quick read on how you're doing. Tap to rate — takes 15 seconds."}
                </Text>

                {renderScale('Energy',     'energy',     energy,     setEnergy)}
                {renderScale('Hunger',     'hunger',     hunger,     setHunger)}
                {renderScale('Soreness',   'soreness',   soreness,   setSoreness)}
                {renderScale('Motivation', 'motivation', motivation, setMotivation)}

                {renderChipGroup('How did the plan feel?', DIFFICULTY_OPTIONS, difficulty, setDifficulty)}
                {renderChipGroup('Biggest blocker', BLOCKER_OPTIONS, blocker, setBlocker)}
                {renderChipGroup('Anything hurt?', PAIN_OPTIONS, painArea, setPainArea)}

                <TouchableOpacity
                  style={[styles.toggleRow, scheduleIssue && styles.toggleRowActive]}
                  onPress={() => setScheduleIssue(!scheduleIssue)}>
                  <Text style={styles.toggleLabel}>
                    {scheduleIssue ? '☑ Schedule issues this week' : '☐ Schedule issues this week'}
                  </Text>
                </TouchableOpacity>

                {!showNote ? (
                  <TouchableOpacity onPress={() => setShowNote(true)} style={styles.noteToggle}>
                    <Text style={styles.noteToggleText}>+ Add a note (optional)</Text>
                  </TouchableOpacity>
                ) : (
                  <TextInput
                    style={styles.noteInput}
                    value={note}
                    onChangeText={setNote}
                    placeholder="Anything the coach should know…"
                    placeholderTextColor={colors.textMuted}
                    multiline
                    maxLength={500}
                  />
                )}

                {error && <Text style={styles.errorText}>{error}</Text>}

                <TouchableOpacity
                  style={[styles.submitBtn, submitting && { opacity: 0.6 }]}
                  onPress={handleSubmit}
                  disabled={submitting}>
                  {submitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.submitBtnText}>Submit check-in</Text>
                  )}
                </TouchableOpacity>
                <Text style={styles.submitHint}>
                  The coach will review your trends and let you know if anything needs to change.
                </Text>
                {onSkip && (
                  <TouchableOpacity onPress={onSkip} style={{ alignItems: 'center', paddingVertical: 10 }}>
                    <Text style={{ color: colors.textMuted, fontSize: 13, fontWeight: '600' }}>
                      Skip this week's check-in
                    </Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <>
                {(() => {
                  // Support both CoachCheckinResponse (legacy) and PlanWeekCheckinRecord shapes
                  const r = response as any;
                  const msg = r.ai_message ?? r.message ?? '';
                  const delta = r.ai_delta ?? r.delta ?? null;
                  const responseType = r.response_type ?? null;
                  const flags: any[] = r.flags ?? [];
                  const overrides: string[] = r.overrides ?? [];
                  const commitments: any[] = r.commitments_json ?? [];
                  const structuredApplied: any[] = r.review_snapshot_json?.structured_applied ?? r.review_summary?.structured_applied ?? [];
                  const structuredAdjustment = r.review_snapshot_json?.structured_adjustment ?? r.review_summary?.structured_adjustment ?? null;
                  return (
                    <>
                      <View style={[styles.responseHeader, { borderLeftColor: responseType ? responseColor(responseType) : colors.primary }]}>
                        {responseType && (
                          <Text style={styles.responseType}>{responseType.replace('_', ' ')}</Text>
                        )}
                        <Text style={styles.responseMessage}>{cleanAiText(msg)}</Text>
                      </View>

                      {delta && (
                        <View style={styles.deltaBlock}>
                          <Text style={styles.deltaLabel}>Plan adjustment</Text>
                          {Object.entries(delta).map(([k, v]) => (
                            <Text key={k} style={styles.deltaLine}>
                              {k}: {typeof v === 'number' && (v as number) > 0 ? '+' : ''}{String(v)}
                            </Text>
                          ))}
                          {r.applied_kcal_adjustment_total != null && (
                            <Text style={styles.deltaFootnote}>
                              New total coaching offset: {r.applied_kcal_adjustment_total >= 0 ? '+' : ''}
                              {r.applied_kcal_adjustment_total} kcal/day
                            </Text>
                          )}
                          <Text style={styles.deltaFootnote}>
                            Applies to the next generated plan; this week stays fixed.
                          </Text>
                        </View>
                      )}

                      {commitments.length > 0 && (
                        <View style={styles.deltaBlock}>
                          <Text style={styles.deltaLabel}>Next week commitments</Text>
                          {commitments.map((c, i) => (
                            <Text key={i} style={styles.deltaLine}>• {c.label ?? c.kind}</Text>
                          ))}
                        </View>
                      )}

                      {(structuredApplied.length > 0 || structuredAdjustment?.summary) && (
                        <View style={styles.deltaBlock}>
                          <Text style={styles.deltaLabel}>Check-in adjustments</Text>
                          {structuredAdjustment?.summary ? (
                            <Text style={styles.deltaLine}>{structuredAdjustment.summary}</Text>
                          ) : null}
                          {structuredApplied.map((item, i) => (
                            <Text key={`${item.type ?? 'applied'}-${i}`} style={styles.deltaLine}>
                              • {item.summary ?? item.type}
                            </Text>
                          ))}
                          <Text style={styles.deltaFootnote}>
                            These update your saved preferences and coach state for the next generated week.
                          </Text>
                        </View>
                      )}

                      {flags.length > 0 && (
                        <View style={styles.flagsBlock}>
                          <Text style={styles.flagsLabel}>Active flags</Text>
                          {flags.map((f) => (
                            <View key={f.key} style={styles.flagRow}>
                              <Text style={styles.flagKey}>{f.key.replace(/_/g, ' ')}</Text>
                              <Text style={[styles.flagSeverity, {
                                color: f.severity === 'high' ? '#ef4444' : f.severity === 'med' ? '#F59E0B' : colors.textMuted,
                              }]}>{f.severity}</Text>
                            </View>
                          ))}
                        </View>
                      )}

                      {overrides.length > 0 && (
                        <View style={styles.overridesBlock}>
                          <Text style={styles.overridesLabel}>Safety overrides</Text>
                          {overrides.map((o, i) => (
                            <Text key={i} style={styles.overrideLine}>• {o}</Text>
                          ))}
                        </View>
                      )}
                    </>
                  );
                })()}

                <TouchableOpacity style={styles.doneBtn} onPress={handleClose}>
                  <Text style={styles.doneBtnText}>Done</Text>
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ReturnType<typeof getTheme>['colors']) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cancelText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
  title: { color: colors.textPrimary, fontSize: 17, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 20, paddingBottom: 80 },
  intro: {
    color: colors.textSecondary,
    fontSize: 14,
    marginBottom: 24,
    lineHeight: 20,
  },
  scaleBlock: {
    marginBottom: 22,
  },
  scaleLabel: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 10,
  },
  scaleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 6,
  },
  scaleDot: {
    flex: 1,
    aspectRatio: 1,
    maxWidth: 56,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scaleDotActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  scaleDotText: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  scaleDotTextActive: { color: getContrastingTextColor(colors.primary) },
  scaleHint: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  chipBlock: {
    marginBottom: 20,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  checkinChip: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  checkinChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '18',
  },
  checkinChipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  checkinChipTextActive: {
    color: colors.primary,
  },
  toggleRow: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
  },
  toggleRowActive: {
    borderColor: colors.primary,
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  noteToggle: {
    paddingVertical: 10,
    alignItems: 'center',
    marginBottom: 8,
  },
  noteToggleText: { color: colors.primary, fontSize: 14, fontWeight: '600' },
  noteInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    minHeight: 80,
    color: colors.textPrimary,
    fontSize: 14,
    marginBottom: 16,
    textAlignVertical: 'top',
  },
  errorText: {
    color: '#ef4444',
    fontSize: 13,
    marginBottom: 10,
  },
  submitBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  submitBtnText: {
    color: getContrastingTextColor(colors.primary),
    fontSize: 16,
    fontWeight: '700',
  },
  submitHint: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
  responseHeader: {
    backgroundColor: colors.surface,
    borderLeftWidth: 4,
    borderRadius: radius.md,
    padding: 16,
    marginBottom: 16,
  },
  responseType: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  responseMessage: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 22,
  },
  deltaBlock: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 16,
  },
  deltaLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  deltaLine: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 2,
  },
  deltaFootnote: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 6,
  },
  flagsBlock: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 16,
  },
  flagsLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  flagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  flagKey: {
    color: colors.textPrimary,
    fontSize: 13,
  },
  flagSeverity: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  overridesBlock: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 14,
    marginBottom: 16,
  },
  overridesLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  overrideLine: {
    color: colors.textMuted,
    fontSize: 12,
    marginBottom: 2,
  },
  doneBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 10,
  },
  doneBtnText: {
    color: getContrastingTextColor(colors.primary),
    fontSize: 16,
    fontWeight: '700',
  },
});
