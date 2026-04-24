// Single source of truth for age math.
//
// We store age two ways: `physicalStats.age` (cached int, kept for every
// existing consumer) and `physicalStats.birthdate` (ISO date, the real
// source when the user has filled it in). The backend re-derives age
// from birthdate on every profile read so the cached int stays fresh
// year-over-year. Client code that needs the "live" age should route
// through here too — that way a stale cached int can't silently feed
// HR zones, TDEE, or progression heuristics when a birthday has passed.

export function deriveAge(birthdate: string | null | undefined, today: Date = new Date()): number | null {
  if (!birthdate) return null;
  // Parse YYYY-MM-DD without timezone shenanigans.
  const parts = birthdate.split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return null;
  let age = today.getFullYear() - y;
  const beforeBirthday =
    today.getMonth() + 1 < m ||
    (today.getMonth() + 1 === m && today.getDate() < d);
  if (beforeBirthday) age -= 1;
  return Math.max(0, age);
}

/** Take whatever the profile currently stores and return the best-available
 *  integer age. Prefers the derived value from `birthdate` so multi-year
 *  users automatically see accurate HR zones / TDEE. Falls back to the
 *  cached `age` int for profiles that haven't been backfilled yet. */
export function effectiveAge(p: { birthdate?: string | null; age?: number | null } | null | undefined): number | null {
  if (!p) return null;
  const fromBirth = deriveAge(p.birthdate ?? null);
  if (fromBirth != null) return fromBirth;
  return typeof p.age === 'number' ? p.age : null;
}

/** Validate a user-entered birthdate. Must be a real date, user must be
 *  13+ (signup age floor) and < 120. Returns null on OK, or an error
 *  message to show in the UI. */
export function validateBirthdate(birthdate: string | null | undefined): string | null {
  if (!birthdate) return 'Please pick your birthday';
  const age = deriveAge(birthdate);
  if (age == null) return 'Please pick a valid date';
  if (age < 13) return 'You must be 13 or older';
  if (age > 120) return 'Please pick a valid date';
  return null;
}
