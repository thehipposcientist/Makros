// Single source of truth for per-set 1RM estimation across the app.
//
// Why this exists: prior to this helper, the PR card on Progress used a
// raw Epley inline calc, the showcase tile used a backend Epley result,
// and the rolling e1RM chart used a smoothed RIR-weighted estimate.
// Three numbers, three sources, the user could see them disagree.
//
// Formula choice — averaged Epley + Brzycki, capped at 10 reps:
//
//   Epley:    1RM = w × (1 + r / 30)
//   Brzycki:  1RM = w × 36 / (37 − r)
//   Estimate: (Epley + Brzycki) / 2     for 1 ≤ r ≤ 10
//
// Validation studies — LeSuer (1997), Reynolds (2006), Mayhew (2008),
// Wood (2002) — converge on the same finding: Epley overestimates at
// higher reps, Brzycki underestimates, and their average sits closest
// to a tested 1RM across the 1–10 rep range. Above 10 reps, every
// published equation's error climbs past ±10% and the intra-individual
// scatter exceeds the formula difference; returning `null` is more
// honest than rendering a confident-looking number.
//
// RIR support — when a set was performed with reps in reserve, the
// effective failure-reps is `actualReps + rir`. Pass `rir` to estimate
// what the lifter could have done, not what they actually did.

/** Pure helper. Returns null when inputs are invalid OR reps exceed
 *  the precision window (10) since the literature stops being usable
 *  beyond that. Callers should check for null and either suppress the
 *  display or fall back to "—". Never returns a guess for high reps —
 *  silently wrong is worse than silent. */
export function estimate1RM(
  weightLbs: number | null | undefined,
  reps: number | null | undefined,
  options?: { rir?: number | null },
): number | null {
  const w = Number(weightLbs);
  const baseReps = Number(reps);
  if (!Number.isFinite(w) || !Number.isFinite(baseReps)) return null;
  if (w <= 0 || baseReps <= 0) return null;

  // Apply RIR adjustment if provided. RIR < 0 (negative reps in
  // reserve, i.e. failed reps) clamps to 0 — a negative effective rep
  // count would make the formulas misbehave.
  const rirRaw = Number(options?.rir);
  const rir = Number.isFinite(rirRaw) && rirRaw > 0 ? rirRaw : 0;
  const effectiveReps = baseReps + rir;

  // Hard cap. Brzycki numerically blows up at r=37; Epley is unbounded
  // but unreliable. Both are unreliable past 10.
  if (effectiveReps > 10) return null;

  // For r = 1, both formulas resolve to w (1RM = weight) — short-circuit
  // to avoid floating-point noise.
  if (effectiveReps === 1) return Math.round(w * 100) / 100;

  const epley = w * (1 + effectiveReps / 30);
  const brzycki = w * 36 / (37 - effectiveReps);
  return Math.round(((epley + brzycki) / 2) * 100) / 100;
}

/** Convenience wrapper that returns 0 instead of null. Use ONLY where
 *  the caller needs a numeric default (e.g. for sort comparators).
 *  Display surfaces should use `estimate1RM` directly so they can
 *  hide the row instead of showing a misleading 0. */
export function estimate1RMOrZero(
  weightLbs: number | null | undefined,
  reps: number | null | undefined,
  options?: { rir?: number | null },
): number {
  return estimate1RM(weightLbs, reps, options) ?? 0;
}

/** Hard rep limit beyond which estimation is refused. Exported so UI
 *  can show consistent copy ("3-rep set, est. 1RM…" vs "12-rep set —
 *  est. 1RM not shown"). */
export const ONE_RM_REP_LIMIT = 10;

/** Format an estimated 1RM for display. Rounds to nearest pound. */
export function formatEstimated1RM(estimate: number | null): string {
  if (estimate == null || estimate <= 0) return '—';
  return `${Math.round(estimate)} lb`;
}
