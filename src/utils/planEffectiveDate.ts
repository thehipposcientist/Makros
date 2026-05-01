// Pure helpers for "when does a plan change take effect?"
//
// Plan changes (goal, workout settings, mealplan) made mid-week don't
// disrupt the active PlanWeek — the new settings apply to the NEXT
// generated week, which always starts on a Monday. We compute that
// next-Monday date here so the confirmation modal can show the user
// exactly when their change kicks in, and the change-history view can
// label entries with their effective date.
//
// Pure date math — no React, no AsyncStorage. Tested in
// `src/utils/__tests__/planEffectiveDate.test.ts`.

/** Return the local YYYY-MM-DD for the upcoming Monday relative to
 *  `from`. If `from` IS a Monday, returns the Monday a week later
 *  (since today's plan is already in flight). */
export function nextPlanWeekStart(from: Date = new Date()): string {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();           // 0 = Sun, 1 = Mon, ..., 6 = Sat
  // Days until next Monday. If today is Monday (dow=1) → 7 days later
  // (the active week is already underway). Otherwise → distance to Mon.
  const daysUntilNextMonday = dow === 1 ? 7 : ((1 - dow + 7) % 7);
  d.setDate(d.getDate() + daysUntilNextMonday);
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
