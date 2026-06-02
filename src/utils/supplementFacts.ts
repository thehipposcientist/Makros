// Client mirror of backend/app/services/nutrition/supplement_facts.py.
// Credits a stored Supplement Facts panel toward today's micronutrient
// PREVIEW totals. Preview only — the server score is authoritative for
// logged days. Kept deliberately in sync with the Python module.

export type NutrientContentLike = {
  serving_size?: { count?: number | null; unit?: string | null } | null;
  nutrients?: Array<{ key?: string; nutrient?: string; amount?: number; unit?: string }> | null;
} | null | undefined;

// Suffixed micro key → canonical unit. Matches MICRO_KEY_UNIT in the
// Python module.
const MICRO_KEY_UNIT: Record<string, 'mg' | 'mcg' | 'g'> = {
  calcium_mg: 'mg', iron_mg: 'mg', potassium_mg: 'mg', magnesium_mg: 'mg',
  phosphorus_mg: 'mg', zinc_mg: 'mg', copper_mg: 'mg', manganese_mg: 'mg',
  boron_mg: 'mg', vitamin_c_mg: 'mg', vitamin_e_mg: 'mg', vitamin_b6_mg: 'mg',
  thiamin_b1_mg: 'mg', riboflavin_b2_mg: 'mg', niacin_b3_mg: 'mg',
  pantothenic_acid_b5_mg: 'mg', selenium_mcg: 'mcg', vitamin_d_mcg: 'mcg',
  vitamin_b12_mcg: 'mcg', vitamin_a_mcg: 'mcg', vitamin_k_mcg: 'mcg',
  folate_mcg: 'mcg', biotin_b7_mcg: 'mcg', omega_3_g: 'g',
};

const IU_FACTORS: Record<string, number> = {
  vitamin_d_mcg: 40, vitamin_a_mcg: 3.33, vitamin_e_mg: 1.49,
};

const MASS_TO_MCG: Record<string, number> = { g: 1_000_000, mg: 1_000, mcg: 1 };

const COUNT_UNITS = new Set([
  'capsule', 'cap', 'tablet', 'tab', 'softgel', 'gel',
  'gummy', 'gummie', 'pill', 'scoop', 'lozenge', 'drop',
]);

function normUnit(unit: string | undefined | null): string {
  let s = String(unit ?? '').trim().toLowerCase().replace(/[µμ]/g, 'u');
  s = s.replace(/[^a-z]/g, '');
  if (!s) return '';
  if (s.startsWith('iu')) return 'iu';
  if (s.startsWith('mcg') || s.startsWith('ug')) return 'mcg';
  if (s.startsWith('mg')) return 'mg';
  if (s.startsWith('g')) return 'g';
  return '';
}

function normDoseUnit(unit: string | undefined | null): string {
  let s = String(unit ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (s.length > 1 && s.endsWith('s')) s = s.slice(0, -1);
  return s;
}

/** Convert `amount` (in `unit`) to `microKey`'s canonical unit. */
export function convertAmount(amount: number, unit: string | undefined | null, microKey: string): number {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  const target = MICRO_KEY_UNIT[microKey];
  if (!target) return 0;
  const u = normUnit(unit);
  if (u === 'iu') {
    const factor = IU_FACTORS[microKey];
    return factor ? amt / factor : 0;
  }
  const src = u in MASS_TO_MCG ? u : target;
  return (amt * MASS_TO_MCG[src]) / MASS_TO_MCG[target];
}

function servingScale(servingSize: any, doseAmount?: number, doseUnit?: string): number {
  const dose = Number(doseAmount);
  const du = normDoseUnit(doseUnit);
  if (du === 'serving') return Number.isFinite(dose) && dose > 0 ? dose : 1;
  if (COUNT_UNITS.has(du) && servingSize && typeof servingSize === 'object') {
    const count = Number(servingSize.count);
    const su = normDoseUnit(servingSize.unit);
    if (Number.isFinite(dose) && dose > 0 && Number.isFinite(count) && count > 0 && du === su) {
      return dose / count;
    }
  }
  return 1;
}

/** Credit a stored nutrient_content blob → { suffixedMicroKey: amount }. */
export function creditedMicrosFromContent(
  nutrientContent: NutrientContentLike,
  doseAmount?: number,
  doseUnit?: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!nutrientContent || typeof nutrientContent !== 'object') return out;
  const nutrients = nutrientContent.nutrients;
  if (!Array.isArray(nutrients)) return out;
  const scale = servingScale(nutrientContent.serving_size, doseAmount, doseUnit);
  for (const entry of nutrients) {
    if (!entry || typeof entry !== 'object') continue;
    const key = entry.key;
    if (!key || !(key in MICRO_KEY_UNIT)) continue;
    const amount = convertAmount(Number(entry.amount), entry.unit, key);
    if (amount <= 0) continue;
    out[key] = (out[key] || 0) + amount * scale;
  }
  return out;
}
