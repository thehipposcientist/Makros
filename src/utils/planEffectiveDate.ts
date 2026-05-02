// Pure helpers for "when does a plan change take effect?"
//
// Plan changes (goal, workout settings, mealplan) made mid-week don't
// disrupt the active PlanWeek — the new settings apply to the NEXT
// generated week, which is anchored to the user's sign-up day-of-week
// (NOT a calendar Monday). The right answer for "when does my new
// setting kick in" is `active_plan_week.end_date + 1` whenever we know
// the active week. Falls back to a 7-day rolling boundary from today
// only when no plan-week end is available (free users, brand-new
// signups).
//
// Pure date math — no React, no AsyncStorage. Tested in
// `src/utils/__tests__/planEffectiveDate.test.ts`.

/** Return the local YYYY-MM-DD for when a plan change should take effect.
 *
 *  @param activePlanWeekEnd ISO YYYY-MM-DD of the current PlanWeek's
 *  `end_date`. When provided, the result is `end_date + 1` — i.e., the
 *  first day of the NEXT plan week, on the user's actual cadence.
 *
 *  @param from Reference date. Defaults to today. Only used in the
 *  fallback path when `activePlanWeekEnd` is absent.
 */
export function nextPlanWeekStart(
  activePlanWeekEnd?: string | null,
  from: Date = new Date(),
): string {
  if (activePlanWeekEnd) {
    // Parse local-noon to avoid TZ rollover making the result off by a day.
    const [y, m, d] = activePlanWeekEnd.split('-').map(Number);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      const next = new Date(y, (m ?? 1) - 1, (d ?? 1));
      next.setDate(next.getDate() + 1);
      return _toIso(next);
    }
  }
  // Fallback when we don't know the active plan-week end — assume a
  // 7-day cycle from today (the user's "earliest possible" next-week
  // boundary). Better than hard-coding Monday for the new sign-up-day
  // cadence; not perfect, but only hit for users who haven't generated
  // a plan yet.
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 7);
  return _toIso(d);
}

function _toIso(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** "Mon, May 5" — short-form display for the modal copy. Locale-aware
 *  on iOS via Intl. Falls back to plain MM/DD for environments that
 *  lack Intl. */
export function formatPlanStartDateShort(yyyymmdd: string): string {
  try {
    const d = new Date(`${yyyymmdd}T12:00:00`);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    const [y, m, dd] = yyyymmdd.split('-');
    return `${m}/${dd}/${y}`;
  }
}
