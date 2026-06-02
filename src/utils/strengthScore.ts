// Comprehensive strength score derived from estimated 1RMs across the
// canonical compound + machine-compound lifts. Score is on a 0–100
// scale where the practical recreational benchmark anchors at 70
// (top of Intermediate). Beating the benchmark moves you into
// Advanced / Elite; the score caps at 100 so monster lifters don't
// run away with the average.
//
// Per-lift formula: clamp(round((ratio / target_ratio) × 70), 0, 100).
// Hitting the target bw-ratio exactly → 70. ~1.14× target → 80
// (Advanced). ~1.36× target → 95 (Elite). ~1.43× target → 100 (cap).
//
// Category contract — ONLY `main_compound` and `machine_compound`
// lifts feed this score. Isolation lifts (curls, lateral raises, leg
// extensions, etc.) are intentionally excluded because Epley
// overshoots wildly on tendon-bound movements; including them would
// lie about overall strength. The tile + detail modal stay honest by
// listing the canonical lifts the user hasn't logged yet rather than
// substituting an isolation in.
//
// Bands map intuitively onto the 0–100 scale:
//
//     <  40  Novice
//    40–59  Developing
//    60–79  Intermediate     ← benchmark anchor lives at 70
//    80–94  Advanced
//    95–100 Elite
//
// Confidence reports completeness so the UI can show a partial score
// honestly. Missing lifts are NEVER penalized — only logged lifts
// feed the average — but a tile that says "Intermediate · 75" off
// one bench press is misleading without context. The confidence pill
// fixes that.
//
// Why this and not a Wilks / DOTS coefficient: those are powerlifting
// total scores (squat + bench + deadlift only) and miss broader
// pulling, overhead, and posterior-chain capacity. The bodyweight-
// ratio approach covers more ground and stays intuitive ("am I
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

export type StrengthMovementPattern =
  | 'squat'
  | 'hinge'
  | 'horizontal_push'
  | 'vertical_push'
  | 'horizontal_pull'
  | 'vertical_pull';

export type StrengthBand =
  | 'novice'
  | 'developing'
  | 'intermediate'
  | 'advanced'
  | 'elite'
  | 'unknown';

export type StrengthConfidence =
  | 'unknown'    // 0 lifts logged
  | 'partial'    // 1–2
  | 'low'        // 3–4
  | 'medium'     // 5–6
  | 'high';      // 7–8

interface LiftDef {
  key: StrengthLiftKey;
  display: string;
  /** Category this lift falls into. Used as a sanity tag — every entry
   *  in `STRENGTH_LIFTS` must be `main_compound` or `machine_compound`.
   *  Isolation lifts intentionally don't appear here. */
  category: 'main_compound' | 'machine_compound';
  /** Movement pattern grouping. Aggregate uses the BEST score per
   *  pattern, then averages across populated patterns — keeps the
   *  upper / lower body balance honest even when the user logs
   *  multiple variants of the same pattern. */
  pattern: StrengthMovementPattern;
  /** Practical recreational benchmark expressed as a multiple of
   *  bodyweight. A score of 100 on a lift means the user hits this
   *  ratio exactly. Sources: StrengthLevel.com / ExRx aggregate norms,
   *  cross-checked against the practical "is this a respectable lift
   *  for a recreational lifter" reference points. Female norms run
   *  ~80% of these; we apply a single bodyweight axis and accept some
   *  drift rather than gating on sex (sex-aware scoring is a future
   *  setting, not in this pass). */
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
    pattern: 'squat',
    bwRatioTarget: 1.5,
    patterns: { positive: ['back squat'], negative: ['front'] },
  },
  {
    key: 'bench',
    display: 'Bench Press',
    category: 'main_compound',
    pattern: 'horizontal_push',
    bwRatioTarget: 1.25,
    patterns: { positive: ['bench press', 'bench'] },
  },
  {
    key: 'deadlift',
    display: 'Deadlift',
    category: 'main_compound',
    pattern: 'hinge',
    bwRatioTarget: 2.0,
    // Conventional / sumo / barbell deadlift — but NOT romanian.
    patterns: { positive: ['deadlift'], negative: ['romanian', 'rdl', 'stiff'] },
  },
  {
    key: 'overhead_press',
    display: 'Shoulder Press',
    category: 'main_compound',
    pattern: 'vertical_push',
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
    pattern: 'horizontal_pull',
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
    pattern: 'squat',
    bwRatioTarget: 1.25,
    patterns: { positive: ['front squat'] },
  },
  {
    key: 'romanian_deadlift',
    display: 'Romanian Deadlift',
    category: 'main_compound',
    pattern: 'hinge',
    bwRatioTarget: 1.5,
    patterns: { positive: ['romanian deadlift', 'romanian dl', 'rdl'] },
  },
  {
    key: 'lat_pulldown',
    display: 'Lat Pulldown',
    category: 'machine_compound',
    pattern: 'vertical_pull',
    bwRatioTarget: 1.0,
    patterns: { positive: ['lat pulldown', 'lat pull-down', 'lat pull down', 'pulldown'] },
  },
];

/** Maximum displayable score. 0–100 scale was chosen over the
 *  prior 0–130 internal scale so "X / 100" reads as the percentage
 *  most users expect. Trade-off: elite lifters compress against the
 *  cap; the dedicated 1RM detail view still shows the raw ratio so
 *  granularity isn't lost. */
const SCORE_CAP = 100;
/** What score corresponds to hitting the practical recreational
 *  benchmark exactly (the bw-ratio target for each lift). Sits at
 *  the top of "Intermediate" so beating the benchmark moves the
 *  user into Advanced / Elite. */
const BENCHMARK_ANCHOR = 70;

export interface StrengthLiftRow {
  key: StrengthLiftKey;
  display: string;
  pattern: StrengthMovementPattern;
  /** Best 1RM we found for this slot, in lbs. */
  oneRepMaxLbs: number;
  /** 1RM ÷ bodyweight, rounded to 2 decimals. */
  ratio: number;
  /** Benchmark target ratio. */
  targetRatio: number;
  /** Per-lift score (0–`SCORE_CAP`). */
  score: number;
  /** Human-readable band for this lift's score. */
  band: StrengthBand;
  /** Source name as recognized in the user's data — useful for the
   *  detail modal so users can confirm we matched the right exercise. */
  matchedName: string;
}

export interface StrengthPatternScore {
  pattern: StrengthMovementPattern;
  /** Best score across all logged lifts in this pattern. */
  score: number;
  band: StrengthBand;
  /** Which lift contributed the best score. */
  bestLiftKey: StrengthLiftKey;
}

export interface StrengthScoreResult {
  /** Aggregate score: average of pattern scores across patterns the
   *  user has at least one logged lift in. Missing patterns don't
   *  drag the average down — confidence reports completeness instead. */
  score: number;
  band: StrengthBand;
  /** Confidence in the score based on how many lifts were logged.
   *  See `StrengthConfidence` for thresholds. */
  confidence: StrengthConfidence;
  /** Number of canonical lifts the user has logged. */
  loggedLiftCount: number;
  /** Total possible canonical lifts (currently 8). */
  totalLiftCount: number;
  /** Backwards-compat aliases for `loggedLiftCount` / `totalLiftCount`. */
  liftsCovered: number;
  liftsTotal: number;
  /** Per-lift breakdown — order matches `STRENGTH_LIFTS`. */
  rows: StrengthLiftRow[];
  /** Lifts the user hasn't logged yet — surfaces "log X to expand
   *  your score's coverage" affordance in the UI. Note: missing lifts
   *  do NOT lower the aggregate score; only confidence reflects
   *  incompleteness. */
  missing: { key: StrengthLiftKey; display: string }[];
  /** Per-pattern best scores. Drives the aggregate via mean over
   *  populated patterns. Useful for the detail modal to surface
   *  "your strongest pattern" / "your weakest pattern" at a glance. */
  patternScores: StrengthPatternScore[];
}

function bandFor(score: number): StrengthBand {
  if (score < 40) return 'novice';
  if (score < 60) return 'developing';
  if (score < 80) return 'intermediate';
  if (score < 95) return 'advanced';
  return 'elite';
}

function confidenceFor(loggedLifts: number): StrengthConfidence {
  if (loggedLifts <= 0) return 'unknown';
  if (loggedLifts <= 2) return 'partial';
  if (loggedLifts <= 4) return 'low';
  if (loggedLifts <= 6) return 'medium';
  return 'high';
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

function emptyResult(): StrengthScoreResult {
  return {
    score: 0,
    band: 'unknown',
    confidence: 'unknown',
    loggedLiftCount: 0,
    totalLiftCount: STRENGTH_LIFTS.length,
    liftsCovered: 0,
    liftsTotal: STRENGTH_LIFTS.length,
    rows: [],
    missing: STRENGTH_LIFTS.map(l => ({ key: l.key, display: l.display })),
    patternScores: [],
  };
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
    return emptyResult();
  }

  for (const def of STRENGTH_LIFTS) {
    const match = bestMatch(def, input);
    if (!match) {
      missing.push({ key: def.key, display: def.display });
      continue;
    }
    const ratio = match.lbs / bw;
    // Anchor: hitting the target bw-ratio exactly = BENCHMARK_ANCHOR
    // (currently 70). The score = ratio / target × anchor, capped at
    // SCORE_CAP. So someone at 1.43× their target ratio caps at 100.
    const rawScore = (ratio / def.bwRatioTarget) * BENCHMARK_ANCHOR;
    const score = Math.max(0, Math.min(SCORE_CAP, Math.round(rawScore)));
    rows.push({
      key: def.key,
      display: def.display,
      pattern: def.pattern,
      oneRepMaxLbs: Math.round(match.lbs),
      ratio: Math.round(ratio * 100) / 100,
      targetRatio: def.bwRatioTarget,
      score,
      band: bandFor(score),
      matchedName: match.name,
    });
  }

  if (rows.length === 0) {
    const empty = emptyResult();
    empty.missing = missing;
    return empty;
  }

  // Group rows by movement pattern, take the best score per pattern.
  // Multiple lifts in the same pattern (e.g. Back Squat + Front
  // Squat in `squat`) collapse to the higher of the two so a user
  // who's strong on both squat variants doesn't "double-count" them.
  const byPattern = new Map<StrengthMovementPattern, StrengthLiftRow>();
  for (const row of rows) {
    const prev = byPattern.get(row.pattern);
    if (!prev || row.score > prev.score) {
      byPattern.set(row.pattern, row);
    }
  }
  const patternScores: StrengthPatternScore[] = Array.from(byPattern.values()).map(row => ({
    pattern: row.pattern,
    score: row.score,
    band: row.band,
    bestLiftKey: row.key,
  }));

  // Aggregate: mean of pattern scores across populated patterns.
  // Missing patterns are NOT penalized — confidence reports
  // completeness via the logged-lift count instead.
  const avg = Math.round(
    patternScores.reduce((sum, p) => sum + p.score, 0) / patternScores.length
  );
  const loggedLifts = rows.length;

  return {
    score: avg,
    band: bandFor(avg),
    confidence: confidenceFor(loggedLifts),
    loggedLiftCount: loggedLifts,
    totalLiftCount: STRENGTH_LIFTS.length,
    liftsCovered: loggedLifts,
    liftsTotal: STRENGTH_LIFTS.length,
    rows,
    missing,
    patternScores,
  };
}

/** Display copy for a band. Kept here so UI stays consistent between
 *  the tile and the detail modal. */
export function strengthBandLabel(band: StrengthBand): string {
  switch (band) {
    case 'novice': return 'Novice';
    case 'developing': return 'Developing';
    case 'intermediate': return 'Intermediate';
    case 'advanced': return 'Advanced';
    case 'elite': return 'Elite';
    case 'unknown': return '—';
  }
}

/** Display copy for a confidence level. Used in the tile + modal so
 *  users see "Score 92 · Intermediate (low confidence — 4 of 8 logged)"
 *  rather than feeling like a partial score is the full picture. */
export function strengthConfidenceLabel(confidence: StrengthConfidence): string {
  switch (confidence) {
    case 'unknown': return '—';
    case 'partial': return 'Partial';
    case 'low': return 'Low';
    case 'medium': return 'Medium';
    case 'high': return 'High';
  }
}
