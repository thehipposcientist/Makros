// Exercise swap scoring — shared by the Active Workout swap picker and
// the plan-view swap picker so a "Swap" from the plan feels identical
// to a mid-workout swap (same ranking, same overlap meter).
//
// Higher score = better substitute. Zero or negative = unsuitable.

// Minimal structural shape for an exercise library row. Both HomeScreen
// and ActiveWorkoutScreen define their own ExerciseLibraryItem — rather
// than moving it to `types.ts` (risk of breaking existing importers),
// we declare just the fields the swap scorer actually reads.
export interface ExerciseLibraryItem {
  id?: number | string;
  name: string;
  slug?: string | null;
  primary_muscle?: string | null;
  secondary_muscles?: string[] | null;
  equipment?: string | null;
  gear?: Array<{ slug: string; name: string; category?: string; required?: boolean }> | null;
  movement_pattern?: string | null;
  is_compound?: boolean | null;
  description?: string | null;
  image_url?: string | null;
  video_id?: string | null;
  is_custom?: boolean;
}

function normalizedEquipmentKeys(raw?: string | null): string[] {
  const s = (raw ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return [];
  const compact = s.replace(/\s+/g, '');
  const keys = new Set([s, compact]);
  const aliases: Record<string, string[]> = {
    db: ['dumbbell', 'dumbbells'],
    dumbbell: ['dumbbells'],
    dumbbells: ['dumbbell'],
    adjustabledumbbells: ['adjustable dumbbells', 'adjustable_dumbbells', 'dumbbell', 'dumbbells'],
    adjustable_dumbbells: ['adjustable dumbbells', 'adjustabledumbbells', 'dumbbell', 'dumbbells'],
    kb: ['kettlebell'],
    band: ['bands', 'resistance band', 'resistance bands', 'resistance bands tube', 'resistance_bands'],
    bands: ['band', 'resistance band', 'resistance bands', 'resistance bands tube', 'resistance_bands'],
    resistanceband: ['band', 'bands', 'resistance bands', 'resistance bands tube', 'resistance_bands'],
    resistancebands: ['band', 'bands', 'resistance band', 'resistance bands tube', 'resistance_bands'],
    resistancebandstube: ['band', 'bands', 'resistance band', 'resistance bands', 'resistance_bands'],
    pullupbar: ['pull up bar', 'pull-up bar', 'pull_up_bar'],
    pullup: ['pull up bar', 'pull-up bar', 'pull_up_bar'],
    ezbar: ['ez curl bar', 'ez_curl_bar'],
    ezcurlbar: ['ez bar', 'ez_curl_bar'],
    adjustablebench: ['adjustable bench', 'adjustable_bench', 'flat bench', 'flat_bench', 'incline bench', 'incline_bench', 'decline bench', 'decline_bench'],
    adjustable_bench: ['adjustable bench', 'adjustablebench', 'flat bench', 'flat_bench', 'incline bench', 'incline_bench', 'decline bench', 'decline_bench'],
    flatbench: ['flat bench', 'flat_bench', 'adjustable bench', 'adjustable_bench'],
    flat_bench: ['flat bench', 'flatbench', 'adjustable bench', 'adjustable_bench'],
    inclinebench: ['incline bench', 'incline_bench', 'adjustable bench', 'adjustable_bench'],
    incline_bench: ['incline bench', 'inclinebench', 'adjustable bench', 'adjustable_bench'],
    declinebench: ['decline bench', 'decline_bench', 'adjustable bench', 'adjustable_bench'],
    decline_bench: ['decline bench', 'declinebench', 'adjustable bench', 'adjustable_bench'],
    powerrack: ['power rack', 'power_rack', 'squat rack', 'squat_rack'],
    power_rack: ['power rack', 'powerrack', 'squat rack', 'squat_rack'],
    squatrack: ['squat rack', 'squat_rack', 'power rack', 'power_rack'],
    squat_rack: ['squat rack', 'squatrack', 'power rack', 'power_rack'],
    sturdychair: ['sturdy chair', 'sturdy_chair', 'sturdy chair low surface', 'low surface'],
    sturdy_chair: ['sturdy chair', 'sturdychair', 'sturdy chair low surface', 'low surface'],
    lowsurface: ['low surface', 'sturdy chair', 'sturdy_chair'],
    nordicanchor: ['nordic anchor', 'nordic_anchor', 'nordic strap', 'foot anchor', 'nordic strap foot anchor'],
    nordic_anchor: ['nordic anchor', 'nordicanchor', 'nordic strap', 'foot anchor', 'nordic strap foot anchor'],
    weightplates: ['weight plates', 'weight_plates', 'plates'],
    weight_plates: ['weight plates', 'weightplates', 'plates'],
    stabilityball: ['swiss ball', 'swiss stability ball', 'swiss_ball'],
    swissball: ['stability ball', 'swiss stability ball', 'swiss_ball'],
    swiss_ball: ['swiss ball', 'stability ball', 'stabilityball'],
    rower: ['rowing machine', 'rowing_machine'],
    rowingmachine: ['rower', 'rowing_machine'],
    bike: ['stationary bike', 'stationary_bike'],
    stationarybike: ['bike', 'stationary_bike'],
    cablemachine: ['cable machine', 'cable_machine'],
    cable_machine: ['cable machine', 'cablemachine'],
    machine: [
      'machines',
      'selectorized machine',
      'selectorized machines',
      'leverage machine',
      'leverage machines',
      'leverage_machines',
    ],
    machines: ['machine'],
    gym: ['machine', 'machines', 'barbell', 'dumbbells', 'cable machine'],
    fullgym: ['machine', 'machines', 'barbell', 'dumbbells', 'cable machine'],
  };
  for (const alias of aliases[s] ?? aliases[compact] ?? []) {
    const normalized = alias.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) continue;
    keys.add(normalized);
    keys.add(normalized.replace(/\s+/g, ''));
  }
  return [...keys];
}

function ownedEquipmentKeySet(ownedEquipment: string[] | undefined): Set<string> {
  const owned = new Set<string>();
  for (const item of ownedEquipment ?? []) {
    for (const key of normalizedEquipmentKeys(item)) owned.add(key);
  }
  for (const key of normalizedEquipmentKeys('bodyweight')) owned.add(key);
  for (const key of normalizedEquipmentKeys('none')) owned.add(key);
  return owned;
}

function equipmentMatchesOwned(raw: string | null | undefined, owned: Set<string>): boolean {
  const keys = normalizedEquipmentKeys(raw);
  return keys.length > 0 && keys.some(k => owned.has(k));
}

export function exerciseEquipmentLabel(ex: ExerciseLibraryItem): string | null {
  const gear = ex.gear ?? [];
  if (gear.length > 0) {
    const required = gear.filter(g => g.required !== false);
    const display = (required.length > 0 ? required : gear)
      .map(g => g.name || g.slug)
      .filter(Boolean);
    if (display.length > 0) return display.join(', ');
  }
  return ex.equipment ?? null;
}

function equipmentClass(ex: ExerciseLibraryItem): string {
  const s = (exerciseEquipmentLabel(ex) ?? '').toLowerCase().replace(/[_-]+/g, ' ');
  if (s.includes('barbell') || s.includes('smith')) return 'barbell';
  if (s.includes('dumbbell') || s.includes('db')) return 'dumbbell';
  if (s.includes('kettlebell') || s.includes('kb')) return 'kettlebell';
  if (s.includes('cable')) return 'cable';
  if (s.includes('machine') || s.includes('selectorized')) return 'machine';
  if (s.includes('band') || s.includes('resistance')) return 'band';
  if (s.includes('bodyweight') || s === 'none' || s === 'bw') return 'bodyweight';
  return 'other';
}

export function isExerciseUsableWithEquipment(
  ex: ExerciseLibraryItem,
  ownedEquipment: string[] | undefined,
): boolean {
  const owned = ownedEquipmentKeySet(ownedEquipment);
  if (ex.gear && ex.gear.length > 0) {
    const required = ex.gear.filter(g => g.required !== false);
    if (required.length === 0) return true;
    return required.every(g =>
      equipmentMatchesOwned(g.slug, owned) || equipmentMatchesOwned(g.name, owned),
    );
  }
  const eq = ex.equipment ?? '';
  const keys = normalizedEquipmentKeys(eq);
  if (keys.length === 0) return true;
  if (keys.some(k => k.includes('bodyweight') || k === 'none' || k === 'bw')) return true;
  return keys.some(k => owned.has(k));
}

/** Score how well `cand` substitutes for `base`. Matches ActiveWorkoutScreen
 *  weights exactly so plan-view swaps and in-workout swaps rank the same. */
export function scoreSwapCandidate(base: ExerciseLibraryItem, cand: ExerciseLibraryItem): number {
  let score = 0;
  const bp = (base.primary_muscle ?? '').toLowerCase();
  const cp = (cand.primary_muscle ?? '').toLowerCase();
  const bs = (base.secondary_muscles ?? []).map(m => m.toLowerCase());
  const cs = (cand.secondary_muscles ?? []).map(m => m.toLowerCase());
  if (!bp || !cp) return -1;
  if (bp === cp) score += 12;
  else if (bs.includes(cp) || cs.includes(bp)) score += 6;
  else if (bs.some(m => cs.includes(m))) score += 3;
  else return -1;
  if (base.is_compound === cand.is_compound) score += 5;
  const bpat = (base.movement_pattern ?? '').toLowerCase();
  const cpat = (cand.movement_pattern ?? '').toLowerCase();
  if (bpat && bpat === cpat) score += 6;
  const be = equipmentClass(base);
  const ce = equipmentClass(cand);
  if (be === ce) score += 4;
  else if (
    (be === 'barbell' && ce === 'dumbbell') ||
    (be === 'dumbbell' && ce === 'barbell') ||
    (be === 'machine' && (ce === 'barbell' || ce === 'dumbbell')) ||
    ((be === 'barbell' || be === 'dumbbell') && ce === 'machine')
  ) {
    score += 2;
  }
  return score;
}

export const MAX_SWAP_SCORE = 27;

export interface SwapCandidate extends ExerciseLibraryItem {
  _overlap: number;  // 0-100 display percentage
}

/** Rank alternatives for `base` from `library`, filtered by owned
 *  equipment. Returns top `limit` candidates with overlap percentage. */
export function rankSwapCandidates(
  base: ExerciseLibraryItem,
  library: ExerciseLibraryItem[],
  ownedEquipment: string[] | undefined,
  limit = 12,
): SwapCandidate[] {
  const ranked: Array<{ ex: ExerciseLibraryItem; score: number }> = [];
  for (const ex of library) {
    if (ex.name === base.name) continue;
    if (!isExerciseUsableWithEquipment(ex, ownedEquipment)) continue;
    const score = scoreSwapCandidate(base, ex);
    if (score > 0) ranked.push({ ex, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map(r => ({
    ...r.ex,
    _overlap: Math.min(100, Math.round((r.score / MAX_SWAP_SCORE) * 100)),
  }));
}
