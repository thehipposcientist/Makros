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
  movement_pattern?: string | null;
  is_compound?: boolean | null;
  description?: string | null;
  image_url?: string | null;
  video_id?: string | null;
  is_custom?: boolean;
}

function equipmentClass(eq?: string | null): string {
  const s = (eq ?? '').toLowerCase();
  if (s.includes('barbell')) return 'barbell';
  if (s.includes('dumbbell') || s.includes('db')) return 'dumbbell';
  if (s.includes('kettlebell') || s.includes('kb')) return 'kettlebell';
  if (s.includes('cable')) return 'cable';
  if (s.includes('machine') || s.includes('selectorized')) return 'machine';
  if (s.includes('band')) return 'band';
  if (s.includes('bodyweight') || s === 'none' || s === 'bw') return 'bodyweight';
  return 'other';
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
  const be = equipmentClass(base.equipment);
  const ce = equipmentClass(cand.equipment);
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
  const owned = new Set((ownedEquipment ?? []).map(e => e.toLowerCase()));
  owned.add('bodyweight');
  owned.add('none');
  const ranked: Array<{ ex: ExerciseLibraryItem; score: number }> = [];
  for (const ex of library) {
    if (ex.name === base.name) continue;
    // Equipment filter — skip candidates that need gear the user doesn't own.
    const eq = (ex.equipment ?? '').toLowerCase();
    if (eq && !owned.has(eq) && !eq.includes('bodyweight')) continue;
    const score = scoreSwapCandidate(base, ex);
    if (score > 0) ranked.push({ ex, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map(r => ({
    ...r.ex,
    _overlap: Math.min(100, Math.round((r.score / MAX_SWAP_SCORE) * 100)),
  }));
}
