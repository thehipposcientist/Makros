import { useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WorkoutDay, AppThemeName } from '../types';
import { elevations, getTheme, radius, typography } from '../constants/theme';
import { humanizeToken } from '../utils/exerciseGuide';
import { exerciseThumbSmall } from '../utils/exerciseThumb';
import { shouldHideWeight } from '../utils/exerciseDisplay';
import { estimateWorkoutMinutes } from '../utils/workoutDurationEstimate';
import FadeInView from './FadeInView';

/** Turn a planner-emitted equipment string into a display label.
 *  The planner outputs comma-separated slugs like
 *  `"barbell, flat_bench, squat_rack"` — each piece needs to be run
 *  through `humanizeToken` individually so the underscores become
 *  spaces and every word gets title-cased. */
function formatEquipmentLabel(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .split(',')
    .map(part => humanizeToken(part.trim()))
    .filter(Boolean)
    .join(', ');
}

interface WorkoutCardProps {
  workout: WorkoutDay;
  themeName?: AppThemeName;
  /** Top of the user's chosen duration range (e.g. 60 for "45–60 min").
   *  Used to cap the estimated time display so stale cache or unusual
   *  reps strings can't produce nonsensical values like 246 min. */
  sessionMinutes?: number;
  onOpenExerciseVideo?: (exerciseName: string) => void;
  /** Open the swap picker for the exercise at this index. Enables a
   *  swap button on each exercise row so plan-view swaps use the same
   *  overlap-ranked alternatives as the live Switch Exercise feature. */
  onSwapExercise?: (exerciseIndex: number, exerciseName: string) => void;
  /** Open the exercise info page (description, cues, video) for the
   *  given exercise name. Typically routes to the Library sub-tab with
   *  the exercise pre-selected. */
  onViewExercise?: (exerciseName: string) => void;
  /** Removes the enclosing card shell when this is revealed inside a
   *  selected day card; exercise rows then read as individual cards. */
  embedded?: boolean;
}

export default function WorkoutCard({ workout, themeName, sessionMinutes, onOpenExerciseVideo, onSwapExercise, onViewExercise, embedded = false }: WorkoutCardProps) {
  const theme  = getTheme(themeName);
  const c      = theme.colors;
  const s      = theme.sections.workout;
  const styles = createStyles(c, s);

  const totalSets        = workout.exercises.reduce((sum, ex) => sum + (Number(ex.sets) || 3), 0);

  const estimatedMinutes = useMemo(() => estimateWorkoutMinutes(workout, sessionMinutes), [workout, sessionMinutes]);

  return (
    <View style={[styles.card, embedded && styles.cardEmbedded]}>
      {/* Header removed — the parent DayCard already shows day + focus.
          Stats strip is now a plain inline row, no colored background,
          matching the macros grid on the meal accordion. */}
      <View style={[styles.statsStrip, embedded && styles.statsStripEmbedded]}>
        <StatItem icon="time-outline" value={`~${estimatedMinutes} min`} color={s.strong} testID="workout-estimated-duration" />
        <View style={[styles.statsDivider, { backgroundColor: c.border }]} />
        <StatItem icon="layers-outline" value={`${totalSets} sets`} color={s.strong} />
        <View style={[styles.statsDivider, { backgroundColor: c.border }]} />
        <StatItem icon="barbell-outline" value={`${workout.exercises.length} exercises`} color={s.strong} />
      </View>
      <Text style={styles.warmupHint}>
        Estimate includes warm-up, set rests, and transitions between exercises.
      </Text>

      {/* ── Exercise list ───────────────────────────────────────────────── */}
      <View style={[styles.body, embedded && styles.bodyEmbedded]}>
        {(() => {
          // Group consecutive core-role exercises (2+) into circuit blocks.
          // Single core exercises render as normal rows.
          type Group =
            | { kind: 'single'; exercise: typeof workout.exercises[0]; originalIndex: number }
            | { kind: 'circuit'; exercises: { ex: typeof workout.exercises[0]; originalIndex: number }[] };
          const groups: Group[] = [];
          let i = 0;
          while (i < workout.exercises.length) {
            const ex = workout.exercises[i];
            const role = ((ex as any)._role ?? (ex as any).slot_role ?? '').toLowerCase();
            if (role === 'core') {
              // Collect the run of core exercises
              const run: { ex: typeof ex; originalIndex: number }[] = [{ ex, originalIndex: i }];
              let j = i + 1;
              while (j < workout.exercises.length) {
                const nex = workout.exercises[j];
                const nrole = ((nex as any)._role ?? (nex as any).slot_role ?? '').toLowerCase();
                if (nrole === 'core') { run.push({ ex: nex, originalIndex: j }); j++; }
                else break;
              }
              if (run.length >= 2) {
                groups.push({ kind: 'circuit', exercises: run });
              } else {
                groups.push({ kind: 'single', exercise: ex, originalIndex: i });
              }
              i = j;
            } else {
              groups.push({ kind: 'single', exercise: ex, originalIndex: i });
              i++;
            }
          }

          return groups.map((group, gi) => {
            if (group.kind === 'single') {
              const isLast = gi === groups.length - 1;
              return (
                <FadeInView key={group.originalIndex} delay={group.originalIndex * 40} duration={260} slideDistance={6}>
                  <ExerciseRow
                    index={group.originalIndex}
                    exercise={group.exercise}
                    isLast={isLast}
                    section={s}
                    c={c}
                    styles={styles}
                    onOpenVideo={onOpenExerciseVideo}
                    onSwap={onSwapExercise}
                    onView={onViewExercise}
                  />
                </FadeInView>
              );
            }
            // Circuit block
            const sets = Number(group.exercises[0].ex.sets) || 3;
            const restSeconds = Number((group.exercises[0].ex as any).restSeconds ?? (group.exercises[0].ex as any).rest_seconds) || 0;
            return (
              <FadeInView key={`circuit-${gi}`} delay={group.exercises[0].originalIndex * 40} duration={260} slideDistance={6}>
                <View style={styles.circuitCard}>
                  <View style={styles.circuitHeader}>
                    <View style={styles.circuitTitleRow}>
                      <Ionicons name="repeat" size={13} color={s.strong} />
                      <Text style={styles.circuitTitle}>Core Circuit</Text>
                    </View>
                    <View style={styles.circuitMetaRow}>
                      <View style={[styles.circuitMetaChip, { backgroundColor: s.strong + '12', borderColor: s.strong + '28' }]}>
                        <Text style={[styles.circuitMetaText, { color: s.strong }]}>{sets} rounds</Text>
                      </View>
                      <View style={[styles.circuitMetaChip, { backgroundColor: c.surface, borderColor: c.border }]}>
                        <Text style={[styles.circuitMetaText, { color: c.textSecondary }]}>
                          {restSeconds > 0 ? `${restSeconds}s after each round` : 'Move exercise to exercise'}
                        </Text>
                      </View>
                    </View>
                  </View>
                  {group.exercises.map(({ ex, originalIndex }, ei) => (
                    <View key={originalIndex} style={ei < group.exercises.length - 1 ? {
                      borderBottomWidth: 1, borderBottomColor: c.border,
                    } : undefined}>
                      <ExerciseRow
                        index={originalIndex}
                        exercise={ex}
                        isLast={false}
                        section={s}
                        c={c}
                        styles={styles}
                        onOpenVideo={onOpenExerciseVideo}
                        onSwap={onSwapExercise}
                        onView={onViewExercise}
                        circuitMode
                        circuitStep={ei + 1}
                      />
                    </View>
                  ))}
                </View>
              </FadeInView>
            );
          });
        })()}
      </View>

    </View>
  );
}

// ── StatItem ──────────────────────────────────────────────────────────────────

function StatItem({ icon, value, color, testID }: {
  icon: keyof typeof Ionicons.glyphMap;
  value: string;
  color: string;
  testID?: string;
}) {
  return (
    <View testID={testID} accessibilityLabel={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <Ionicons name={icon} size={12} color={color} />
      <Text style={{ fontSize: 11, fontWeight: '600', color, letterSpacing: 0.2 }}>{value}</Text>
    </View>
  );
}

// ── ExerciseRow ───────────────────────────────────────────────────────────────

function ExerciseRow({ index, exercise, isLast, section, c, styles, onOpenVideo, onSwap, onView, circuitMode, circuitStep }: {
  index: number;
  exercise: WorkoutDay['exercises'][number];
  isLast: boolean;
  section: ReturnType<typeof getTheme>['sections']['workout'];
  c: ReturnType<typeof getTheme>['colors'];
  styles: ReturnType<typeof createStyles>;
  onOpenVideo?: (name: string) => void;
  onSwap?: (exerciseIndex: number, exerciseName: string) => void;
  onView?: (name: string) => void;
  circuitMode?: boolean;
  circuitStep?: number;
}) {
  return (
    <View style={[
      styles.exRow,
      circuitMode ? styles.exRowCircuit : styles.exRowCard,
      !isLast && !circuitMode && styles.exRowStackGap,
    ]}>
      {/* Thumbnail — YouTube video frame when available, numbered tile
          otherwise. Tapping the thumbnail launches the form-video modal
          (separate hit target from the whole row so an accidental tap
          while scrolling the plan doesn't open video). */}
      {(() => {
        const thumbUri = exerciseThumbSmall(exercise as any);
        if (!thumbUri) {
          return (
            <View style={[styles.exNum, { backgroundColor: section.strong }]}>
              <Text style={styles.exNumText}>{String(index + 1).padStart(2, '0')}</Text>
            </View>
          );
        }
        const inner = (
          <View style={{
            width: 58, height: 58, borderRadius: 14,
            backgroundColor: c.surfaceRaised,
            borderWidth: 1.5, borderColor: c.primary,
            position: 'relative',
            // Glow: shadow color matches the themed border so the tile
            // gets a soft coloured halo around it on dark backgrounds.
            // iOS reads shadow*; Android uses elevation (colourless but
            // lifts the tile visually the same way).
            shadowColor: c.primary,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: 0.75,
            shadowRadius: 8,
            elevation: 6,
          }}>
            {/* Inner clip — the outer View can't use overflow:hidden
                because that would chop the glow shadow. Clip here
                instead so the image still stays inside the rounded
                border while the halo can render outside. */}
            <View style={{
              width: '100%', height: '100%', borderRadius: 8,
              overflow: 'hidden',
            }}>
            <Image source={{ uri: thumbUri }} style={{ width: 46, height: 46 }} resizeMode="cover" />
            {/* Brightness lift — YouTube thumbnails often capture gym
                interiors that are dim; a subtle white wash keeps the
                content legible on dark themes without washing out the
                colors. pointerEvents=none so the tap still reaches the
                underlying TouchableOpacity wrapper. */}
            <View pointerEvents="none" style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: 'rgba(255,255,255,0.18)',
            }} />
            <View pointerEvents="none" style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <View style={{
                width: 20, height: 20, borderRadius: 10,
                backgroundColor: 'rgba(0,0,0,0.6)',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Ionicons name="play" size={11} color="#fff" style={{ marginLeft: 1 }} />
              </View>
            </View>
            </View>
          </View>
        );
        if (!onOpenVideo) return inner;
        return (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Play form video for ${exercise.name}`}
            activeOpacity={0.7}
            onPress={() => onOpenVideo(exercise.name)}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            {inner}
          </TouchableOpacity>
        );
      })()}

      {/* Info */}
      <View style={styles.exInfo}>
        <Text style={[styles.exName, { color: c.textPrimary }]}>
          {circuitMode && circuitStep ? `A${circuitStep}. ` : ''}
          {exercise.name}
        </Text>
        {exercise.equipment ? (
          <Text style={[styles.exEquipment, { color: c.textMuted }]}>{formatEquipmentLabel(exercise.equipment)}</Text>
        ) : null}

        {/* Chips */}
        <View style={styles.exChips}>
          <Chip
            icon="repeat-outline"
            label={
              circuitMode
                ? formatCircuitWorkLabel(exercise)
                : shouldHideWeight(exercise) && /^\d+\s*-?\s*\d*\s*s(ec)?$/i.test(String(exercise.reps ?? ''))
                  ? `${exercise.sets} × ${exercise.reps} hold`
                  : `${exercise.sets} × ${exercise.reps}`
            }
            strong={section.strong}
            soft={section.soft}
            text={section.text}
          />
          {!circuitMode && (
            <Chip
              icon="timer-outline"
              label={`${exercise.restSeconds}s rest`}
              strong={section.strong}
              soft={section.soft}
              text={section.text}
            />
          )}
          {/* Muscle chip — driven off `primary_muscle` from the planner.
              Humanized (chest → Chest, full_body → Full Body). Skipped
              for mobility/systemic/cardio exercises where the muscle
              label is already conveyed by the exercise name, AND for
              warm-up rows (whose primary_muscle is whatever the drill
              targets, not the day's focus — chip would mislead). */}
          {(() => {
            const pm = ((exercise as any).primary_muscle ?? '').toLowerCase().replace(/\s+/g, '_');
            if (!pm || pm === 'mobility' || pm === 'systemic' || pm === 'cardio' || pm === 'full_body') return null;
            const role = ((exercise as any)._role ?? (exercise as any).slot_role ?? '').toLowerCase();
            const slot = ((exercise as any)._slot ?? '').toLowerCase();
            if (role === 'warmup' || slot.includes('warm')) return null;
            const label = humanizeToken(pm);
            if (!label) return null;
            return (
              <Chip
                icon="body-outline"
                label={label}
                strong={section.strong}
                soft={section.soft}
                text={section.text}
              />
            );
          })()}
          {onOpenVideo && (
            <Pressable
              style={({ pressed }) => [
                styles.videoChip,
                { borderColor: section.strong, backgroundColor: pressed ? section.strong + '28' : section.strong + '12' },
              ]}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => onOpenVideo(exercise.name)}>
              <Ionicons name="open-outline" size={11} color={section.strong} />
              <Text style={[styles.videoChipText, { color: section.strong }]}>Form</Text>
            </Pressable>
          )}
          {onView && (
            <Pressable
              style={({ pressed }) => [
                styles.videoChip,
                { borderColor: c.textMuted, backgroundColor: pressed ? c.textMuted + '22' : c.surface },
              ]}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => onView(exercise.name)}
              accessibilityLabel={`view-${exercise.name}`}
            >
              <Ionicons name="information-circle-outline" size={11} color={c.textSecondary} />
              <Text style={[styles.videoChipText, { color: c.textSecondary }]}>Info</Text>
            </Pressable>
          )}
          {onSwap && (
            <Pressable
              style={({ pressed }) => [
                styles.videoChip,
                { borderColor: c.textMuted, backgroundColor: pressed ? c.textMuted + '22' : c.surface },
              ]}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={() => onSwap(index, exercise.name)}
              accessibilityLabel={`swap-${exercise.name}`}
            >
              <Ionicons name="swap-horizontal" size={11} color={c.textSecondary} />
              <Text style={[styles.videoChipText, { color: c.textSecondary }]}>Swap</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

function formatCircuitWorkLabel(exercise: WorkoutDay['exercises'][number]): string {
  const reps = String(exercise.reps ?? '').trim();
  if (!reps) return 'Each round';
  if (shouldHideWeight(exercise) && /^\d+\s*-?\s*\d*\s*s(ec)?$/i.test(reps)) {
    return `${reps} hold`;
  }
  return reps;
}

// ── Chip ──────────────────────────────────────────────────────────────────────

function Chip({ icon, label, strong, soft, text }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  strong: string;
  soft: string;
  text: string;
}) {
  return (
    <View style={[chipStyles.chip, { backgroundColor: soft, borderColor: strong + '33' }]}>
      <Ionicons name={icon} size={10} color={text} />
      <Text style={[chipStyles.label, { color: text }]}>{label}</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip:  { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderRadius: radius.full, paddingHorizontal: 9, paddingVertical: 4 },
  label: { fontSize: 11, fontWeight: '600' },
});

// ── Styles ────────────────────────────────────────────────────────────────────

const createStyles = (
  c: ReturnType<typeof getTheme>['colors'],
  s: ReturnType<typeof getTheme>['sections']['workout'],
) => StyleSheet.create({

  card: {
    backgroundColor: c.surface,
    borderRadius: 22,
    marginBottom: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.border,
    ...elevations.card,
  },
  cardEmbedded: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    borderRadius: 0,
    marginBottom: 0,
    overflow: 'visible',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },

  // Stats strip — plain inline row, no colored background. Mirrors the
  // macros grid on the meal accordion: just numbers + dividers, sitting
  // flush at the top of the body.
  statsStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 14,
    marginTop: 14,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: s.soft,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: s.strong + '24',
  },
  statsStripEmbedded: {
    marginHorizontal: 0,
    marginTop: 2,
  },
  statsDivider: { width: 1, height: 14 },

  warmupHint: {
    ...typography.micro,
    color: c.textMuted,
    paddingHorizontal: 18,
    paddingBottom: 8,
  },

  // Body
  body: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 10 },
  bodyEmbedded: { paddingHorizontal: 0, paddingBottom: 0 },

  // Exercise row
  exRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 12,
  },
  exRowCard: {
    backgroundColor: c.surfaceRaised,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 12,
    ...elevations.subtle,
  },
  exRowCircuit: {
    paddingHorizontal: 12,
  },
  exRowStackGap: {
    marginBottom: 8,
  },
  exNum: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  exNumText:   { fontSize: 10, fontWeight: '900', color: '#fff', letterSpacing: 0.5 },
  exInfo:      { flex: 1, gap: 3 },
  exName:      { ...typography.cardTitle, lineHeight: 19 },
  exEquipment: { ...typography.micro, marginBottom: 6 },
  exChips:     { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  circuitCard: {
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: s.strong + '45',
    marginBottom: 10,
    overflow: 'hidden',
    backgroundColor: c.surface,
  },
  circuitHeader: {
    gap: 8,
    backgroundColor: s.soft,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 9,
    borderBottomWidth: 1,
    borderBottomColor: s.strong + '1f',
  },
  circuitTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  circuitTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: s.strong,
    letterSpacing: 0.2,
  },
  circuitMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  circuitMetaChip: {
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  circuitMetaText: {
    ...typography.micro,
    fontWeight: '700',
  },

  videoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 5,
    backgroundColor: c.surfaceRaised,
  },
  videoChipText: { ...typography.micro, fontWeight: '700' },
});
