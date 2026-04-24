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
import { getTheme, radius } from '../constants/theme';
import { cleanAiText } from '../utils/aiText';
import type { AppThemeName } from '../types';
import {
  submitCoachCheckin,
  CoachCheckinFeedback,
  CoachCheckinResponse,
  getWeeklyReview,
  WeeklyReviewResponse,
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
  onCompleted?: (response: CoachCheckinResponse) => void;
  /** Active theme — falls back to `midnight` when not provided. */
  themeName?: AppThemeName;
}

type Scale = 1 | 2 | 3 | 4 | 5;

const SCALE_LABELS: Record<string, string[]> = {
  energy:     ['Drained', 'Low',  'OK',     'Good',  'Great'],
  hunger:     ['None',    'Mild', 'Normal', 'High',  'Ravenous'],
  soreness:   ['None',    'Mild', 'Some',   'High',  'Severe'],
  motivation: ['Zero',    'Low',  'OK',     'Good',  'Fired up'],
};

export default function CoachCheckinModal({ visible, authToken, onClose, onCompleted, themeName }: Props) {
  const theme = getTheme(themeName);
  const colors = theme.colors;
  const styles = React.useMemo(() => createStyles(colors), [colors]);
  const [energy, setEnergy] = useState<Scale | null>(null);
  const [hunger, setHunger] = useState<Scale | null>(null);
  const [soreness, setSoreness] = useState<Scale | null>(null);
  const [motivation, setMotivation] = useState<Scale | null>(null);
  const [scheduleIssue, setScheduleIssue] = useState(false);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<CoachCheckinResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setScheduleIssue(false);
    setNote('');
    setShowNote(false);
    setResponse(null);
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const feedback: CoachCheckinFeedback = {};
      if (energy !== null) feedback.energy = energy;
      if (hunger !== null) feedback.hunger = hunger;
      if (soreness !== null) feedback.soreness = soreness;
      if (motivation !== null) feedback.motivation = motivation;
      if (scheduleIssue) feedback.schedule_issue = true;
      if (note.trim()) feedback.note = note.trim();

      const res = await submitCoachCheckin(authToken, {
        checkin_type: 'manual',
        feedback,
      });
      setResponse(res);
      onCompleted?.(res);
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
          <Text style={styles.title}>Check in</Text>
          <View style={{ width: 50 }} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled">

            {!response ? (
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
                              </View>
                            </View>
                          ))
                        }
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
              </>
            ) : (
              <>
                <View style={[styles.responseHeader, { borderLeftColor: responseColor(response.response_type) }]}>
                  <Text style={styles.responseType}>{response.response_type.replace('_', ' ')}</Text>
                  <Text style={styles.responseMessage}>{cleanAiText(response.message)}</Text>
                </View>

                {response.delta && (
                  <View style={styles.deltaBlock}>
                    <Text style={styles.deltaLabel}>Plan adjustment</Text>
                    {Object.entries(response.delta).map(([k, v]) => (
                      <Text key={k} style={styles.deltaLine}>
                        {k}: {typeof v === 'number' && v > 0 ? '+' : ''}{String(v)}
                      </Text>
                    ))}
                    {response.applied_kcal_adjustment_total !== null && (
                      <Text style={styles.deltaFootnote}>
                        New total coaching offset: {response.applied_kcal_adjustment_total >= 0 ? '+' : ''}
                        {response.applied_kcal_adjustment_total} kcal/day
                      </Text>
                    )}
                  </View>
                )}

                {response.flags.length > 0 && (
                  <View style={styles.flagsBlock}>
                    <Text style={styles.flagsLabel}>Active flags</Text>
                    {response.flags.map((f) => (
                      <View key={f.key} style={styles.flagRow}>
                        <Text style={styles.flagKey}>{f.key.replace(/_/g, ' ')}</Text>
                        <Text style={[styles.flagSeverity, {
                          color: f.severity === 'high' ? '#ef4444' : f.severity === 'med' ? '#F59E0B' : colors.textMuted,
                        }]}>{f.severity}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {response.overrides.length > 0 && (
                  <View style={styles.overridesBlock}>
                    <Text style={styles.overridesLabel}>Safety overrides</Text>
                    {response.overrides.map((o, i) => (
                      <Text key={i} style={styles.overrideLine}>• {o}</Text>
                    ))}
                  </View>
                )}

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
  scaleDotTextActive: { color: '#fff' },
  scaleHint: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
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
    color: '#fff',
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
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
