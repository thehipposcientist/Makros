/**
 * PRCelebrationModal — celebratory modal shown when the user hits one or
 * more personal records at the end of a workout. Replaces the plain
 * Alert that used to fire after `handleFinish`.
 *
 * Animation:
 *   - Drawn trophy burst: rings + rays + icon pop
 *   - PR list: fade-in with 80ms stagger per row
 *   - Backdrop: fade-in
 */
import { useEffect, useMemo, useRef } from 'react';
import { Animated, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppThemeName } from '../types';
import { getTheme, radius } from '../constants/theme';
import type { PRAchievement } from '../services/api';
import CompletionBurst from './CompletionBurst';

interface Props {
  prs: PRAchievement[] | null;
  themeName?: AppThemeName;
  onDismiss: () => void;
}

function formatPRLine(pr: PRAchievement): string {
  if (pr.kind === 'heaviest_weight') {
    return `${pr.exercise_name} — ${pr.new_value} lb` + (pr.old_value > 0 ? ` (prev ${pr.old_value})` : '');
  }
  if (pr.kind === 'estimated_1rm') {
    return `${pr.exercise_name} — est 1RM ${pr.new_value} lb`;
  }
  return `${pr.exercise_name} — set volume ${pr.new_value}`;
}

export default function PRCelebrationModal({ prs, themeName, onDismiss }: Props) {
  const theme = getTheme(themeName);
  const tc = theme.colors;
  const workoutPalette = theme.sections.workout;

  // Dedupe + prioritize — same logic used to live inside handleFinish.
  const display = useMemo(() => {
    if (!prs || prs.length === 0) return [];
    const priority: Record<PRAchievement['kind'], number> = {
      heaviest_weight: 3,
      estimated_1rm: 2,
      volume_record: 1,
    };
    const byExercise: Record<string, PRAchievement> = {};
    for (const pr of prs) {
      const cur = byExercise[pr.exercise_name];
      if (!cur || priority[pr.kind] > priority[cur.kind]) {
        byExercise[pr.exercise_name] = pr;
      }
    }
    return Object.values(byExercise).slice(0, 5);
  }, [prs]);

  const backdrop = useRef(new Animated.Value(0)).current;
  const rowOpacities = useRef<Animated.Value[]>([]).current;

  // Grow the rowOpacities array to match the current PR count so we can
  // stagger fade-ins. Reset all to 0 each time `display` changes.
  if (rowOpacities.length !== display.length) {
    rowOpacities.length = 0;
    for (let i = 0; i < display.length; i += 1) rowOpacities.push(new Animated.Value(0));
  }

  useEffect(() => {
    if (!prs || prs.length === 0) return;

    // Haptic success on mount.
    import('../utils/feedback').then(f => f.hapticSuccess()).catch(() => {});

    backdrop.setValue(0);
    rowOpacities.forEach(v => v.setValue(0));

    Animated.parallel([
      Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.stagger(
        80,
        rowOpacities.map(v => Animated.timing(v, { toValue: 1, duration: 260, useNativeDriver: true })),
      ),
    ]).start();
  }, [prs, backdrop, rowOpacities]);

  if (!prs || prs.length === 0) return null;

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onDismiss}
    >
      <Animated.View style={[styles.backdrop, { opacity: backdrop, backgroundColor: '#00000099' }]}>
        <View style={[styles.card, { backgroundColor: tc.surface, borderColor: workoutPalette.strong + '66' }]}>
          <CompletionBurst
            variant="trophy"
            size={118}
            accentColor={workoutPalette.strong}
            surfaceColor={workoutPalette.strong + '20'}
            iconColor={workoutPalette.strong}
            style={styles.trophyBurst}
          />

          <Text style={[styles.title, { color: tc.textPrimary }]}>
            {display.length === 1 ? 'New PR!' : `${display.length} New PRs!`}
          </Text>
          <Text style={[styles.subtitle, { color: tc.textSecondary }]}>
            You just pushed past your previous best
          </Text>

          <View style={styles.prList}>
            {display.map((pr, i) => (
              <Animated.View
                key={`${pr.exercise_name}-${pr.kind}-${i}`}
                style={[
                  styles.prRow,
                  { backgroundColor: tc.surfaceRaised, borderColor: tc.border, opacity: rowOpacities[i] },
                ]}
              >
                <Ionicons name="trending-up" size={16} color={workoutPalette.strong} />
                <Text style={[styles.prText, { color: tc.textPrimary }]} numberOfLines={2}>
                  {formatPRLine(pr)}
                </Text>
              </Animated.View>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.cta, { backgroundColor: workoutPalette.strong }]}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Dismiss PR celebration"
          >
            <Text style={styles.ctaText}>Keep crushing</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: 24,
    alignItems: 'center',
  },
  trophyBurst: {
    marginBottom: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 0.3,
    marginTop: 2,
  },
  subtitle: {
    fontSize: 13,
    fontWeight: '500',
    marginTop: 4,
    marginBottom: 16,
    textAlign: 'center',
  },
  prList: {
    width: '100%',
    gap: 8,
    marginBottom: 18,
  },
  prRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  prText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
  },
  cta: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: radius.md,
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  ctaText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
});
