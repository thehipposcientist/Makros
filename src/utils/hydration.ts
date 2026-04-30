// Hydration target formula. Mirrored on the backend in
// `_compute_hydration_target_oz` (backend/app/routers/meals.py) — keep both
// in sync. The backend value is what the UI actually renders via
// `/meals/hydration`; this client copy exists so client-only previews
// (onboarding, settings) compute the same number.

export type GenderInput = 'male' | 'female' | 'nonbinary' | 'prefer_not_to_say' | string | null | undefined;

export interface HydrationInputs {
  weightLbs: number;
  /** Today's training minutes — pass MAX(planned, actual completed) so
   *  the bonus survives a heavier-than-planned day. */
  workoutMinutes?: number;
  gender?: GenderInput;
  /** Today's protein consumed (grams). High-protein loads raise water
   *  needs because of nitrogen-clearance kidney work. */
  proteinGToday?: number;
  /** Standard drinks logged today. Net diuretic — adds back the fluid
   *  cost so the user replenishes. */
  alcoholServingsToday?: number;
  isHotDay?: boolean;
}

export function dailyWaterOz(input: HydrationInputs | number, legacyWorkoutMinutes?: number, legacyHot?: boolean, legacyGender?: GenderInput): number {
  // Back-compat: original signature was (weightLbs, workoutMinutes, isHotDay, gender).
  const i: HydrationInputs = typeof input === 'number'
    ? { weightLbs: input, workoutMinutes: legacyWorkoutMinutes, isHotDay: legacyHot, gender: legacyGender }
    : input;

  const g = (i.gender ?? '').toString().toLowerCase();
  // 0.52 oz/lb ≈ 35 ml/kg (men), 0.45 oz/lb ≈ 30 ml/kg (women), 0.48
  // neutral midpoint — aligns the per-lb scaling with IOM total-water
  // guidance (~3.7L men, ~2.7L women) at typical bodyweights.
  const ozPerLb = g === 'male' ? 0.52 : g === 'female' ? 0.45 : 0.48;
  const safeWeight = i.weightLbs > 0 ? i.weightLbs : 150;
  // Floor: 64oz (~2L) — IOM lower bound for healthy adults at rest.
  // Ceiling: 140oz (~4.1L) — guards against dilutional hyponatremia for
  // very heavy users where the linear scaling would otherwise spiral.
  const base = Math.max(64, Math.min(140, safeWeight * ozPerLb));

  // Sweat replacement, capped at +48oz so a 90-min session doesn't push
  // toward overhydration. Beyond 90 min the user should be pairing fluid
  // with electrolytes anyway.
  const workoutMinutes = i.workoutMinutes ?? 0;
  const activityBonus = Math.min(48, Math.max(0, workoutMinutes / 30) * 16);

  // Protein bonus — keyed off today's CONSUMED protein, not target. The
  // recommendation rises as the user logs heavy-protein meals through
  // the day; ahead-of-meals it stays at the resting baseline.
  let proteinBonus = 0;
  const protein = i.proteinGToday ?? 0;
  if (protein > 0 && safeWeight > 0) {
    const perLb = protein / safeWeight;
    if (perLb >= 1.5) proteinBonus = 16;
    else if (perLb >= 1.0) proteinBonus = 8;
  }

  // Alcohol bonus — diuretic. Capped at +36oz; a binge has bigger
  // problems than fluid balance.
  const alcoholBonus = Math.min(36, Math.max(0, i.alcoholServingsToday ?? 0) * 12);

  const heatBonus = i.isHotDay ? 16 : 0;
  return Math.round(base + activityBonus + proteinBonus + alcoholBonus + heatBonus);
}

export function dailyWaterLiters(weightLbs: number, workoutMinutes: number = 0, gender: GenderInput = null): number {
  return Math.round(dailyWaterOz({ weightLbs, workoutMinutes, gender }) * 0.0296 * 10) / 10;
}

export function formatWaterTarget(weightLbs: number, workoutMinutes: number = 0, gender: GenderInput = null): string {
  const oz = dailyWaterOz({ weightLbs, workoutMinutes, gender });
  const L = dailyWaterLiters(weightLbs, workoutMinutes, gender);
  const cups = Math.round(oz / 8);
  return `${oz}oz (${L}L / ~${cups} cups)`;
}
