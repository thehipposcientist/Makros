/**
 * Pending plan change helpers — shared by ProgressScreen's full
 * change-history view and the workout-Home discoverability banner.
 *
 * "Pending" = a user-authored PlanChangeEntry whose effectiveDate is
 * still in the future. Mid-week settings edits (Goal, Workout,
 * Mealplan) defer to the next plan-week boundary, so until that date
 * arrives the row is a *scheduled request* the user can still cancel.
 *
 * Pure functions, no React. Tested via the per-helper consumers (the
 * banner + the Plan Change Requests & History card both depend on
 * this contract).
 */

import type { PlanChangeEntry, UserProfile } from '../types';

/** Local YYYY-MM-DD for `d`. Centralized so we don't drift between
 *  callers (some use Intl, some use template strings). */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function normalizeGlp1Support(support: Partial<UserProfile>['glp1Support'] | null | undefined): Record<string, unknown> | null {
  if (!support?.enabled) return null;
  return {
    enabled: true,
    appetite: support.appetite ?? 'normal',
    sideEffects: [...(support.sideEffects ?? [])].sort(),
  };
}

/** True when this entry represents a user-scheduled change that hasn't
 *  taken effect yet. Coach-driven changes apply immediately, so they're
 *  excluded — those rows are history, not pending. */
export function planChangeIsScheduled(change: PlanChangeEntry, today: Date = new Date()): boolean {
  return change.changedBy === 'user'
    && !!change.effectiveDate
    && change.effectiveDate > dateKey(today);
}

/** Snapshot the subset of profile fields that a given scope cares about
 *  so equality checks aren't fooled by unrelated profile edits. */
export function planScopeSnapshot(
  profile: Partial<UserProfile>,
  scope?: PlanChangeEntry['scope'],
): Record<string, unknown> {
  if (scope === 'goal') {
    return {
      goal: profile.goal ?? null,
      goalSelection: profile.goalSelection ?? null,
      goalDetails: profile.goalDetails ?? null,
      secondaryGoal: profile.secondaryGoal ?? null,
      focusedMuscleGroup: profile.focusedMuscleGroup ?? null,
    };
  }
  if (scope === 'workout') {
    return {
      priorityRegion: profile.priorityRegion ?? null,
      daysPerWeek: profile.daysPerWeek ?? null,
      trainingDays: profile.trainingDays ?? null,
      workoutDurationMinutes: profile.workoutDurationMinutes ?? null,
      equipment: profile.equipment ?? [],
      equipmentSettings: profile.equipmentSettings ?? null,
      injuries: profile.injuries ?? null,
      injuryEntries: profile.injuryEntries ?? [],
      experienceLevel: profile.experienceLevel ?? null,
      preferredSplit: profile.preferredSplit ?? null,
      dislikedExercises: profile.dislikedExercises ?? [],
    };
  }
  if (scope === 'mealplan') {
    return {
      foodsAvailable: profile.foodsAvailable ?? [],
      customFoods: profile.customFoods ?? [],
      cookingSkill: profile.cookingSkill ?? null,
      prepTimeMinutes: profile.prepTimeMinutes ?? null,
      dietaryPreference: profile.dietaryPreference ?? null,
      mealVariety: profile.mealVariety ?? null,
      savedMeals: profile.savedMeals ?? [],
      mealRoutine: profile.mealRoutine ?? null,
      customMacros: profile.customMacros ?? null,
      glp1Support: normalizeGlp1Support(profile.glp1Support),
      allergies: profile.allergies ?? [],
    };
  }
  return profile as unknown as Record<string, unknown>;
}

/** True when `current` matches the `scheduled` snapshot for `scope`.
 *  We use this to detect supersession: if the user made a *newer* edit
 *  to the same surface after scheduling, "Cancel" can no longer safely
 *  restore the previous values without clobbering the newer change. */
export function planScopeMatches(
  current: UserProfile,
  scheduled: Partial<UserProfile>,
  scope?: PlanChangeEntry['scope'],
): boolean {
  return JSON.stringify(planScopeSnapshot(current, scope))
    === JSON.stringify(planScopeSnapshot(scheduled, scope));
}

/** Apply a previous-state snapshot back onto the current profile,
 *  scoped so we only revert the fields the original change touched. */
export function restorePlanScope(
  current: UserProfile,
  previous: Partial<UserProfile>,
  scope?: PlanChangeEntry['scope'],
): UserProfile {
  if (scope === 'goal') {
    return {
      ...current,
      goal: previous.goal ?? current.goal,
      goalSelection: previous.goalSelection,
      goalDetails: previous.goalDetails ?? current.goalDetails,
      secondaryGoal: previous.secondaryGoal,
      focusedMuscleGroup: previous.focusedMuscleGroup,
    };
  }
  if (scope === 'workout') {
    return {
      ...current,
      priorityRegion: previous.priorityRegion,
      daysPerWeek: previous.daysPerWeek ?? current.daysPerWeek,
      trainingDays: previous.trainingDays,
      workoutDurationMinutes: previous.workoutDurationMinutes ?? current.workoutDurationMinutes,
      equipment: previous.equipment ?? current.equipment,
      equipmentSettings: previous.equipmentSettings ?? current.equipmentSettings,
      injuries: previous.injuries ?? current.injuries,
      injuryEntries: previous.injuryEntries ?? current.injuryEntries,
      experienceLevel: previous.experienceLevel ?? current.experienceLevel,
      preferredSplit: previous.preferredSplit ?? current.preferredSplit,
      dislikedExercises: previous.dislikedExercises ?? current.dislikedExercises,
    };
  }
  if (scope === 'mealplan') {
    return {
      ...current,
      foodsAvailable: previous.foodsAvailable ?? current.foodsAvailable,
      customFoods: previous.customFoods ?? current.customFoods,
      cookingSkill: previous.cookingSkill ?? current.cookingSkill,
      prepTimeMinutes: previous.prepTimeMinutes ?? current.prepTimeMinutes,
      dietaryPreference: previous.dietaryPreference ?? current.dietaryPreference,
      mealVariety: previous.mealVariety ?? current.mealVariety,
      savedMeals: previous.savedMeals ?? current.savedMeals,
      mealRoutine: previous.mealRoutine ?? current.mealRoutine,
      customMacros: previous.customMacros ?? current.customMacros,
      glp1Support: Object.prototype.hasOwnProperty.call(previous, 'glp1Support')
        ? ((previous as any).glp1Support ?? undefined)
        : current.glp1Support,
      allergies: previous.allergies ?? current.allergies,
    };
  }
  return { ...current, ...previous } as UserProfile;
}

/** Display label for the scope — used by the banner and history rows. */
export function planScopeLabel(scope?: PlanChangeEntry['scope']): string {
  switch (scope) {
    case 'goal':     return 'Goal';
    case 'workout':  return 'Workout settings';
    case 'mealplan': return 'Meal plan';
    default:         return 'Settings';
  }
}

/** Return true when the profile fields that the given scope cares about
 *  haven't actually changed between `prev` and `next`. Used as a guard
 *  to skip writing a "phantom" plan-change row when the user opens
 *  settings, makes no real edit, and taps Save — workout-mode in
 *  particular previously always wrote a row regardless of diff. */
export function planScopeIsUnchanged(
  prev: Partial<UserProfile> | null | undefined,
  next: Partial<UserProfile>,
  scope?: PlanChangeEntry['scope'],
): boolean {
  if (!prev) return false;
  return JSON.stringify(planScopeSnapshot(prev, scope))
    === JSON.stringify(planScopeSnapshot(next, scope));
}

// ─── Human-readable diff summaries ──────────────────────────────────────────
//
// Used by both the save-confirmation modal copy and the per-row summary
// in the change history / pending-change banner. Replaces the previous
// "Goal updated to moderate" line that lacked any before/after context.

function fmtVal(v: unknown): string {
  if (v == null || v === '') return '—';
  if (Array.isArray(v)) return v.length > 0 ? v.join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string') return v.replace(/_/g, ' ');
  return String(v);
}

function diffLine(label: string, before: unknown, after: unknown): string | null {
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return null;
  return `${label}: ${fmtVal(before)} → ${fmtVal(after)}`;
}

/** Build a "what actually changed" summary scoped to the relevant
 *  profile surfaces. Returns up to 3 lines; falls back to a generic
 *  scope label when no field-level diff is detectable (e.g. nested
 *  object reshape we don't pretty-print). */
export function summarizeScopeDiff(
  prev: Partial<UserProfile> | null | undefined,
  next: Partial<UserProfile>,
  scope?: PlanChangeEntry['scope'],
): string {
  const base = prev ?? {};
  const lines: string[] = [];
  if (scope === 'goal') {
    const gPrev = (base as any).goal as string | undefined;
    const gNext = next.goal;
    const pPrev = (base as any).goalDetails?.pace as string | undefined;
    const pNext = next.goalDetails?.pace;
    const sPrev = (base as any).secondaryGoal as string | undefined;
    const sNext = next.secondaryGoal;
    const fPrev = (base as any).focusedMuscleGroup as string | undefined;
    const fNext = next.focusedMuscleGroup;
    const candidates = [
      diffLine('Goal', gPrev, gNext),
      diffLine('Pace', pPrev, pNext),
      diffLine('Secondary', sPrev, sNext),
      diffLine('Focus', fPrev, fNext),
    ].filter((s): s is string => !!s);
    lines.push(...candidates);
  } else if (scope === 'workout') {
    const candidates = [
      diffLine('Days / week', (base as any).daysPerWeek, next.daysPerWeek),
      diffLine('Session length', (base as any).workoutDurationMinutes != null ? `${(base as any).workoutDurationMinutes} min` : undefined,
                                  next.workoutDurationMinutes != null ? `${next.workoutDurationMinutes} min` : undefined),
      diffLine('Split', (base as any).preferredSplit, next.preferredSplit),
      diffLine('Experience', (base as any).experienceLevel, next.experienceLevel),
      // Equipment + injury edits are common but ugly to render as full
      // arrays — use a count-based diff so the row stays readable.
      (() => {
        const a = ((base as any).equipment ?? []) as string[];
        const b = (next.equipment ?? []) as string[];
        return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
          ? null : `Equipment: ${a.length} → ${b.length} item${b.length === 1 ? '' : 's'}`;
      })(),
      (() => {
        const a = ((base as any).injuryEntries ?? []) as unknown[];
        const b = (next.injuryEntries ?? []) as unknown[];
        return JSON.stringify(a) === JSON.stringify(b)
          ? null : `Injuries: ${a.length} → ${b.length}`;
      })(),
    ].filter((s): s is string => !!s);
    lines.push(...candidates);
  } else if (scope === 'mealplan') {
    const candidates = [
      diffLine('Variety', (base as any).mealVariety, next.mealVariety),
      diffLine('Cooking', (base as any).cookingSkill, next.cookingSkill),
      diffLine('Prep time', (base as any).prepTimeMinutes != null ? `${(base as any).prepTimeMinutes} min` : undefined,
                            next.prepTimeMinutes != null ? `${next.prepTimeMinutes} min` : undefined),
      diffLine('Diet', (base as any).dietaryPreference, next.dietaryPreference),
      (() => {
        const a = normalizeGlp1Support((base as any).glp1Support);
        const b = normalizeGlp1Support(next.glp1Support);
        if (JSON.stringify(a) === JSON.stringify(b)) return null;
        return `GLP-1 support: ${a ? 'On' : 'Off'} → ${b ? 'On' : 'Off'}`;
      })(),
      (() => {
        const a = ((base as any).allergies ?? []) as string[];
        const b = (next.allergies ?? []) as string[];
        return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
          ? null : `Allergies: ${a.length} → ${b.length}`;
      })(),
    ].filter((s): s is string => !!s);
    lines.push(...candidates);
  }
  if (lines.length === 0) {
    return `${planScopeLabel(scope)} updated`;
  }
  // Cap at 3 to keep the row readable; the rest of the diff is implicit
  // in the underlying snapshot the row carries for restore.
  return lines.slice(0, 3).join(' · ');
}
