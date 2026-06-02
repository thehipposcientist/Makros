// Single source of truth for set-level e1RM across the app.
//
// Formula — pure Epley with RIR adjustment:
//
//   e1RM = weight × (1 + (reps + rir) / 30)
//
// Why Epley alone (and not the older averaged Epley + Brzycki blend
// the file used to ship):
//
//  • This same Epley equation is what `backend/app/services/workout/
//    rolling_e1rm.py` uses for every set inside its weighted-median
//    rolling estimator. Sharing the math means the displayed per-set
//    1RM, the rolling chart, and the prescribed working-weight engine
//    all read off the same physics. Mixing in Brzycki on the client
//    only made the surfaces drift apart.
//  • Brzycki's term `36 / (37 − r)` blows up near r=10 and was the
//    main reason the legacy averaged value started to lie at higher
//    rep counts — exactly where lifters most want a believable read.
//
// Category-aware rep windows (set-level validity, NOT rolling-window
// filtering — rolling has its own additional filters in
// `rolling_e1rm.py`):
//
//   main_compound      → 1–10 reps    (barbell big lifts; singles are
//                                       the most informative data)
//   machine_compound   → 3–12 reps    (smith / hack squat / pulldown
//                                       cluster; singles on machines
//                                       are noisy because the bar
//                                       path is fixed and you can't
//                                       miss-grind to true failure)
//   isolation          → not scored   (lateral raise, curl, calf, fly
//                                       etc — Epley overshoots
//                                       wildly because these are
//                                       tendon-bound, not strength-
//                                       limited; we surface "best
//                                       set / rep PR / volume trend"
//                                       instead in the UI)
//
// RIR support — when a set was performed with reps in reserve, the
// effective failure-reps is `reps + rir`. Pass `rir` to estimate what
// the lifter could have done, not what they actually did.

export type LiftCategory = 'main_compound' | 'machine_compound' | 'isolation';

/** Inclusive rep window per category. `null` means we refuse to score
 *  this category at all. Exposed so the recommendation engine and any
 *  client-side validators read off the same numbers. */
export const REP_LIMIT_BY_CATEGORY: Record<LiftCategory, { min: number; max: number } | null> = {
  main_compound: { min: 1, max: 10 },
  machine_compound: { min: 3, max: 12 },
  isolation: null,
};

/** Cap on `reps + rir` per category. Without this, a set like 225 × 10
 *  @ 4 RIR would Epley out to a 14-rep equivalent (≈ 330 lb) — too
 *  aggressive for daily prescription math. Mirrors the backend's
 *  `_MAX_EFFECTIVE_REPS` in `rolling_e1rm.py` so the per-set 1RM the
 *  client computes matches what the server sees. `null` for isolation
 *  matches `REP_LIMIT_BY_CATEGORY` — the category refuses to score. */
export const MAX_EFFECTIVE_REPS_BY_CATEGORY: Record<LiftCategory, number | null> = {
  main_compound: 10,
  machine_compound: 12,
  isolation: null,
};

/** Public helper so callers (recommendation engine, validators) can
 *  consult the cap without poking at the const map. */
export function getMaxEffectiveReps(category: LiftCategory): number | null {
  return MAX_EFFECTIVE_REPS_BY_CATEGORY[category];
}

/** Loose hard cap exported for legacy callers that don't yet pass a
 *  category. Equal to the upper bound of `main_compound` since that's
 *  the most common 1RM-bearing surface (PR cards, trend chart). */
export const ONE_RM_REP_LIMIT = REP_LIMIT_BY_CATEGORY.main_compound!.max;

/** Pure Epley over a single set with effective-rep cap.
 *
 *   e1RM = weight × (1 + min(reps + rir, cap) / 30)
 *
 *  No upstream rep-window check — call `estimate1RM` instead when
 *  display correctness matters. `category` defaults to `main_compound`
 *  (the strictest cap = 10 effective reps) so existing call sites that
 *  don't pass a category get the safe behaviour. Isolation returns
 *  null to match the backend's refusal — matches `estimate1RM`.
 *
 *  Returns null only on impossible inputs (zero / negative / NaN) or
 *  when category is `isolation`. */
export function setE1RM(
  weightLbs: number | null | undefined,
  reps: number | null | undefined,
  rir: number | null | undefined,
  category: LiftCategory = 'main_compound',
): number | null {
  const cap = getMaxEffectiveReps(category);
  if (cap == null) return null;  // isolation — refuse

  const w = Number(weightLbs);
  const baseReps = Number(reps);
  if (!Number.isFinite(w) || !Number.isFinite(baseReps)) return null;
  if (w <= 0 || baseReps <= 0) return null;

  // Negative reps-in-reserve doesn't physically mean "failed reps" in
  // a way Epley can handle — clamp to 0 so the formula stays sane.
  const rirRaw = Number(rir);
  const rirSafe = Number.isFinite(rirRaw) && rirRaw > 0 ? rirRaw : 0;
  const effectiveReps = Math.min(baseReps + rirSafe, cap);

  // r = 1 short-circuit. The formula gives 1.033× weight, which is
  // technically correct (a single lifted at 100% has 1RM ≈ 100), but
  // displaying "232 lb 1RM" off a 225 single is jarring. Return the
  // tested weight directly so 1-rep PRs read as PRs.
  if (effectiveReps === 1) return Math.round(w * 100) / 100;

  return Math.round((w * (1 + effectiveReps / 30)) * 100) / 100;
}

/** Display-grade per-set 1RM. Returns null when the set is outside
 *  the category's rep window OR the category is `isolation`. Callers
 *  should treat null as "don't render a 1RM here" — never substitute
 *  a 0 or fall back silently to a different formula.
 *
 *  Backwards compat: when `options.category` is omitted we assume
 *  `main_compound`. Existing call sites (PR cards, local trend chart)
 *  already filter to compounds upstream, so the default keeps them
 *  honest without requiring a code change at every site. */
export function estimate1RM(
  weightLbs: number | null | undefined,
  reps: number | null | undefined,
  options?: { rir?: number | null; category?: LiftCategory },
): number | null {
  const category: LiftCategory = options?.category ?? 'main_compound';
  const window = REP_LIMIT_BY_CATEGORY[category];
  if (!window) return null;  // isolation — refuse

  const w = Number(weightLbs);
  const baseReps = Number(reps);
  if (!Number.isFinite(w) || !Number.isFinite(baseReps)) return null;
  if (w <= 0 || baseReps <= 0) return null;

  const rirRaw = Number(options?.rir);
  const rirSafe = Number.isFinite(rirRaw) && rirRaw > 0 ? rirRaw : 0;
  // Window check uses RAW effective reps so 11+ rep sets still get
  // rejected entirely (we don't want to "rescue" a 12-rep set by
  // capping its effective reps to 10 — that's hiding the fact that
  // it's outside the validity window for main_compound).
  const rawEffective = baseReps + rirSafe;
  if (rawEffective < window.min || rawEffective > window.max) return null;

  // Pass category through so `setE1RM` applies the matching cap.
  return setE1RM(w, baseReps, rirSafe, category);
}

/** Convenience wrapper that returns 0 instead of null. Use ONLY where
 *  the caller needs a numeric default (e.g. for sort comparators).
 *  Display surfaces should use `estimate1RM` directly so they can
 *  hide the row instead of showing a misleading 0. */
export function estimate1RMOrZero(
  weightLbs: number | null | undefined,
  reps: number | null | undefined,
  options?: { rir?: number | null; category?: LiftCategory },
): number {
  return estimate1RM(weightLbs, reps, options) ?? 0;
}

/** Format an estimated 1RM for display. Rounds to nearest pound. */
export function formatEstimated1RM(estimate: number | null): string {
  if (estimate == null || estimate <= 0) return '—';
  return `${Math.round(estimate)} lb`;
}

/** Map an exercise's structured flags to a category. The data model
 *  carries `is_compound` + `is_machine` (snake) or `isCompound` +
 *  `isMachine` (camel) depending on where it came from — accept both.
 *  Returns 'main_compound' as the most common case when flags are
 *  ambiguous, but only on a positive `is_compound` signal. Otherwise
 *  defaults to 'isolation' so we don't incorrectly score a curl.
 *
 *  Heuristic name matcher used as a last-resort tiebreaker for old
 *  history rows that pre-date the structured flags. */
export function categorizeExercise(input: {
  isCompound?: boolean | null;
  is_compound?: boolean | null;
  isMachine?: boolean | null;
  is_machine?: boolean | null;
  name?: string | null;
}): LiftCategory {
  const isCompound = input.isCompound ?? input.is_compound ?? null;
  const isMachine = input.isMachine ?? input.is_machine ?? null;

  if (isCompound === true) {
    return isMachine === true ? 'machine_compound' : 'main_compound';
  }
  if (isCompound === false) return 'isolation';

  // Flags missing — fall back to a name heuristic so legacy rows still
  // get classified. Conservative on the isolation side; we only mark
  // something as a compound when the name clearly is one.
  const n = String(input.name ?? '').toLowerCase();
  if (!n) return 'isolation';

  // Machine-y compound first — a "lat pulldown" or "leg press" is a
  // machine_compound, not a main_compound, even if both regexes would
  // match.
  if (/leg press|hack squat|smith\b|lat pull[-\s]?down|pull[-\s]?down|chest press machine|seated row machine/.test(n)) {
    return 'machine_compound';
  }
  if (
    /\b(squat|deadlift|bench press|overhead press|shoulder press|barbell row|pendlay row|bent[-\s]?over row|romanian deadlift|rdl|front squat|push[-\s]?press|clean|snatch|hip thrust|chin[-\s]?up|pull[-\s]?up|dip)\b/.test(n)
    && !/(curl|fly|raise|extension|kickback|crunch|skullcrusher|crossover|pec\s*deck|leg\s*curl|leg\s*extension)/.test(n)
  ) {
    return 'main_compound';
  }
  return 'isolation';
}
