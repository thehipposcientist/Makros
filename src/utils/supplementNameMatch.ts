// Map free-text supplement names (the user's custom_name on a stack
// row that doesn't link to a seeded ingredient) to canonical
// ingredient slugs. Mirrors `backend/app/services/supplement_name_match.py`
// so the client can credit custom-named supplements toward today's
// micronutrient totals without waiting on a backend round-trip.
//
// Conservative: requires explicit ingredient keywords. Brand-only
// names (e.g. "Pre-Workout XYZ") return null.

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Vitamin D — extremely common as custom adds in IU dosing.
  [/\b(vitamin\s*d3|vit\s*d3|d-?3|cholecalciferol)\b/i, 'vitamin_d3'],
  [/\bvitamin\s*d\b(?!\s*ribose)/i, 'vitamin_d3'],
  // Omega-3 / fish oil / krill / algae oil.
  [/\b(fish\s*oil|fishoil|omega[\s-]*3|epa[\s/&-]*dha|krill\s*oil|algae\s*oil)\b/i, 'omega_3'],
  // Probiotic.
  [/\b(probiotic|lactobacillus|bifidobacterium)\b/i, 'probiotic'],
  // B12.
  [/\b(vitamin\s*b\s*12|b\s*12|cyanocobalamin|methylcobalamin)\b/i, 'vitamin_b12'],
  // Magnesium variants.
  [/\bmagnesium\b/i, 'magnesium'],
  // Iron.
  [/\b(iron|ferrous\s*(?:sulfate|gluconate|bisglycinate))\b/i, 'iron'],
  // Vitamin C.
  [/\b(vitamin\s*c|ascorbic\s*acid)\b/i, 'vitamin_c'],
  // Calcium.
  [/\bcalcium\b/i, 'calcium'],
  // Zinc.
  [/\bzinc\b/i, 'zinc'],
  // Selenium.
  [/\bselenium\b/i, 'selenium'],
  // Potassium.
  [/\bpotassium\b/i, 'potassium'],
  // Folate / B9.
  [/\b(folate|folic\s*acid|methylfolate)\b/i, 'folate'],
  // Creatine.
  [/\bcreatine\b/i, 'creatine_monohydrate'],
  // Whey / casein protein.
  [/\b(whey|whey\s*isolate|whey\s*concentrate)\b/i, 'whey_protein'],
  // Caffeine.
  [/\bcaffeine\b/i, 'caffeine'],
];

const SOURCE_TERM_SLUGS: Record<string, string> = {
  fish: 'omega_3',
  sunlight: 'vitamin_d3',
  citrus: 'vitamin_c',
  banana: 'potassium',
};

/** Return the canonical ingredient slug if `name` clearly identifies a
 *  common supplement, else null. Case-insensitive partial match. */
export function inferSupplementSlug(name: string | null | undefined): string | null {
  if (!name) return null;
  for (const [pattern, slug] of PATTERNS) {
    if (pattern.test(name)) return slug;
  }
  return null;
}

/** Resolve the effective slug for a stack row: prefer the linked
 *  ingredient slug, fall back to inferring from `custom_name` /
 *  `ingredient_name`. */
export function resolveSupplementSlug(sup: {
  ingredient_slug?: string | null;
  ingredient_name?: string | null;
  custom_name?: string | null;
  category?: string | null;
  description?: string | null;
  source_terms?: string[] | null;
  food_sources?: string[] | null;
  log_names?: string[] | null;
}): string | null {
  if (sup.ingredient_slug) return sup.ingredient_slug;
  const direct =
    inferSupplementSlug(sup.custom_name)
    ?? inferSupplementSlug(sup.ingredient_name)
    ?? inferSupplementSlug(sup.category)
    ?? inferSupplementSlug(sup.description);
  if (direct) return direct;
  for (const term of sup.source_terms ?? []) {
    const normalized = String(term || '').trim().toLowerCase().replace(/_/g, ' ');
    const fromTerm = inferSupplementSlug(normalized) ?? SOURCE_TERM_SLUGS[normalized];
    if (fromTerm) return fromTerm;
  }
  for (const source of sup.food_sources ?? []) {
    const fromSource = inferSupplementSlug(source);
    if (fromSource) return fromSource;
  }
  for (const name of sup.log_names ?? []) {
    const fromLog = inferSupplementSlug(name);
    if (fromLog) return fromLog;
  }
  return null;
}
