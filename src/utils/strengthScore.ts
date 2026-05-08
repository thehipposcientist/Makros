// Comprehensive strength score derived from estimated 1RMs across the
// canonical compound + machine-compound lifts. Each lift's score is
// its 1RM expressed as a percentage of an "intermediate trainee"
// bodyweight ratio, capped at 130 so very strong lifters get headroom
// without running away with the average. The aggregate score is the
// unweighted mean of available lifts — users only get scored on what
// they've actually logged.
//
// Category contract — ONLY `main_compound` and `machine_compound`
// lifts feed this score. Isolation lifts (curls, lateral raises, leg
// extensions, etc.) are intentionally excluded because Epley
// overshoots wildly on tendon-bound movements; including them would
// lie about overall strength. The tile + detail modal stay honest by
// missing list of the canonical 8 lifts the user hasn't logged yet
// rather than substituting an isolation in.
//
// Why this and not a Wilks / DOTS coefficient: those are powerlifting
// total scores (squat + bench + deadlift only) and miss broader
// pulling, overhead, and posterior-chain capacity. The bodyweight-
// ratio average covers more ground while staying intuitive ("am I
// hitting 1.5× squat?").

export type StrengthLiftKey =
  | 'squat'
  | 'bench'
  | 'deadlift'
  | 'overhead_press'
  | 'row'
  | 'front_squat'
  | 'romanian_deadlift'
  | 'lat_pulldown';

interface LiftDef {
  key: StrengthLiftKey;
  display: string;
  /** Category this lift falls into. Used as a sanity tag — every entry
   *  in `STRENGTH_LIFTS` must be `main_compound` or `machine_compound`.
   *  Isolation lifts intentionally don't appear here. */
  category: 'main_compound' | 'machine_compound';
  /** Intermediate trainee target as a multiple of bodyweight. Sources:
   *  StrengthLevel.com / ExRx aggregate norms for a male intermediate
   *  trainee. Female norms run ~80% of these; we apply a single
   *  bodyweight axis and accept some drift rather than gating on sex. */
  bwRatioTarget: number;
  /** Substring patterns matched (case-insensitive) against an exercise
   *  name to recognize the lift. Listed broadest-first so we don't
   *  pick up "front squat" inside "back squat" by accident — the
   *  matcher checks that no NEGATIVE pattern is present. */
  patterns: { positive: string[]; negative?: string[] };
}

// Order matters for display priority. Squat / Bench / Deadlift sit at
// the top so the user's eye lands on the big three first.
export const STRENGTH_LIFTS: readonly LiftDef[] = [
  {
    key: 'squat',
    display: 'Back Squat',
    category: 'main_compound',
    bwRatioTarget: 1.5,
    patterns: { positive: ['back squat'], negative: ['front'] },
  },
  {
    key: 'bench',
    display: 'Bench Press',
    category: 'main_compound',
    bwRatioTarget: 1.25,
    patterns: { positive: ['bench press', 'bench'] },
  },
  {
    key: 'deadlift',
    display: 'Deadlift',
    category: 'main_compound',
    bwRatioTarget: 2.0,
    // Conventional / sumo / barbell deadlift — but NOT romanian.
    patterns: { positive: ['deadlift'], negative: ['romanian', 'rdl', 'stiff'] },
  },
  {
    key: 'overhead_press',
    display: 'Shoulder Press',
    category: 'main_compound',
    bwRatioTarget: 0.75,
    patterns: {
      positive: ['overhead press', 'shoulder press', 'standing press', 'military press', 'ohp'],
      // Exclude dumbbell-only / machine variants from this slot — those
      // 1RMs aren't comparable to a barbell OHP target.
      negative: ['dumbbell', 'machine', 'smith'],
    },
  },
  {
    key: 'row',
    display: 'Barbell Row',
    category: 'main_compound',
    bwRatioTarget: 1.0,
    patterns: {
      positive: ['barbell row', 'pendlay row', 'bent over row', 'bent-over row'],
      negative: ['dumbbell', 'cable', 'seated', 'machine', 'tbar', 't-bar'],
    },
  },
  {
    key: 'front_squat',
    display: 'Front Squat',
    category: 'main_compound',
    bwRatioTarget: 1.25,
    patterns: { positive: ['front squat'] },
  },
  {
    key: 'romanian_deadlift',
    display: 'Romanian Deadlift',
    category: 'main_compound',
    bwRatioTarget: 1.5,
    patterns: { positive: ['romanian deadlift', 'romanian dl', 'rdl'] },
  },
  {
    key: 'lat_pulldown',
    display: 'Lat Pulldown',
    category: 'machine_compound',
    bwRatioTarget: 1.0,
    patterns: { positive: ['lat pulldown', 'lat pull-down', 'lat pull down', 'pulldown'] },
  },
];

const SCORE_CAP = 130;

export interface StrengthLiftRow {
  key: StrengthLiftKey;
  display: string;
  /** Best 1RM we found for this slot, in lbs. */
  oneRepMaxLbs: number;
  /** 1RM ÷ bodyweight, rounded to 2 decimals. */
  ratio: number;
  /** Intermediate target ratio. */
  targetRatio: number;
  /** Per-lift score (0–`SCORE_CAP`). */
  score: number;
  /** Human-readable band based on score: novice / intermediate / advanced / elite. */
  band: 'novice' | 'intermediate' | 'advanced' | 'elite';
  /** Source name as recognized in the user's data — useful for the
   *  detail modal so users can confirm we matched the right exercise. */
  matchedName: string;
}

export interface StrengthScoreResult {
  score: number;                    // 0–`SCORE_CAP`, mean of available lifts
  liftsCovered: number;             // how many of `STRENGTH_LIFTS` were scored
  liftsTotal: number;               // total possible (8 right now)
  band: 'novice' | 'intermediate' | 'advanced' | 'elite' | 'unknown';
  rows: StrengthLiftRow[];
  /** Lifts the user hasn't logged yet — surfaces "log X to add Y points"
   *  affordance in the UI. */
  missing: { key: StrengthLiftKey; display: string }[];
}

function bandFor(score: number): StrengthLiftRow['band'] {
  if (score < 60) return 'novice';
  if (score < 90) return 'intermediate';
  if (score < 115) return 'advanced';
  return 'elite';
}

function nameMatches(name: string, def: LiftDef): boolean {
  const n = name.toLowerCase();
  if (def.patterns.negative?.some(neg => n.includes(neg))) return false;
  return def.patterns.positive.some(pos => n.includes(pos));
}

export interface StrengthInput {
  /** Highest priority — server-authoritative rolling-e1RM map keyed by
   *  lowercased exercise name. Lat pulldown lives here. */
  bulkE1RMMap?: Record<string, number> | null;
  /** Showcase lifts from `/ai/strength/one-rep-max`. Used as a
   *  fallback when bulk map doesn't have the entry. */
  showcase?: Array<{ name: string; oneRepMaxLbs: number }> | null;
  /** User bodyweight in lbs. Required — score is meaningless without
   *  a denominator. */
  bodyweightLbs: number | null | undefined;
}

/** Find the highest 1RM matching `def` across the input sources. */
function bestMatch(def: LiftDef, input: StrengthInput): { lbs: number; name: string } | null {
  let best: { lbs: number; name: string } | null = null;
  // Bulk map — exhaustive over every logged exercise.
  for (const [name, lbs] of Object.entries(input.bulkE1RMMap ?? {})) {
    if (!Number.isFinite(lbs) || lbs <= 0) continue;
    if (!nameMatches(name, def)) continue;
    if (!best || lbs > best.lbs) best = { lbs, name };
  }
  // Showcase fallback — covers the case where the bulk endpoint isn't
  // wired or hasn't loaded yet.
  for (const lift of input.showcase ?? []) {
    if (!Number.isFinite(lift.oneRepMaxLbs) || lift.oneRepMaxLbs <= 0) continue;
    if (!nameMatches(lift.name, def)) continue;
    if (!best || lift.oneRepMaxLbs > best.lbs) best = { lbs: lift.oneRepMaxLbs, name: lift.name };
  }
  return best;
}

/** Compute the comprehensive strength score from available 1RMs.
 *
 *  Returns `score = 0` and `band = 'unknown'` when bodyweight is
 *  missing or no recognized lifts have data — the UI should treat
 *  that as a "log a few key lifts" empty state, not a "you scored 0"
 *  failure. */
export function computeStrengthScore(input: StrengthInput): StrengthScoreResult {
  const bw = input.bodyweightLbs;
  const rows: StrengthLiftRow[] = [];
  const missing: { key: StrengthLiftKey; display: string }[] = [];

  if (!bw || bw <= 0 || !Number.isFinite(bw)) {
    return {
      score: 0,
      liftsCovered: 0,
      liftsTotal: STRENGTH_LIFTS.length,
      band: 'unknown',
      rows: [],
      missing: STRENGTH_LIFTS.map(l => ({ key: l.key, display: l.display })),
    };
  }

  for (const def of STRENGTH_LIFTS) {
    const match = bestMatch(def, input);
    if (!match) {
      missing.push({ key: def.key, display: def.display });
      continue;
    }
    const ratio = match.lbs / bw;
    const rawScore = (ratio / def.bwRatioTarget) * 100;
    const score = Math.max(0, Math.min(SCORE_CAP, Math.round(rawScore)));
    rows.push({
      key: def.key,
      display: def.display,
      oneRepMaxLbs: Math.round(match.lbs),
      ratio: Math.round(ratio * 100) / 100,
      targetRatio: def.bwRatioTarget,
      score,
      band: bandFor(score),
      matchedName: match.name,
    });
  }

  if (rows.length === 0) {
    return {
      score: 0,
      liftsCovered: 0,
      liftsTotal: STRENGTH_LIFTS.length,
      band: 'unknown',
      rows: [],
      missing,
    };
  }

  const avg = Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length);
  return {
    score: avg,
    liftsCovered: rows.length,
    liftsTotal: STRENGTH_LIFTS.length,
    band: bandFor(avg),
    rows,
    missing,
  };
}

/** Display copy for a band. Kept here so UI stays consistent between
 *  the tile and the detail modal. */
export function strengthBandLabel(band: StrengthScoreResult['band']): string {
  switch (band) {
    case 'novice': return 'Novice';
    case 'intermediate': return 'Intermediate';
    case 'advanced': return 'Advanced';
    case 'elite': return 'Elite';
    case 'unknown': return '—';
  }
}
