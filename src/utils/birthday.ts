// Pure helpers for the "Happy birthday" banner. Compares MM-DD of the
// stored birthdate against today's local MM-DD so the banner fires
// regardless of year. Year-aware logic lives here too if we ever add a
// "celebrating your N-th birthday" copy variant.
//
// Birthdate is stored as YYYY-MM-DD on `UserProfile.physicalStats.birthdate`.
// Tests live in `src/utils/__tests__/birthday.test.ts`.

/** Does `today` (a Date) fall on the same MM-DD as `birthdateISO`? */
export function isBirthdayToday(birthdateISO: string | null | undefined, today: Date = new Date()): boolean {
  if (!birthdateISO) return false;
  const parts = birthdateISO.split('-');
  if (parts.length < 3) return false;
  const bMonth = Number(parts[1]);
  const bDay = Number(parts[2]);
  if (!Number.isFinite(bMonth) || !Number.isFinite(bDay)) return false;
  // Feb 29 birthdays celebrate Feb 28 in non-leap years so the user
  // doesn't go four years between greetings. Common app convention.
  if (bMonth === 2 && bDay === 29) {
    const isLeap = _isLeapYear(today.getFullYear());
    if (!isLeap) {
      return today.getMonth() === 1 && today.getDate() === 28;
    }
  }
  return today.getMonth() + 1 === bMonth && today.getDate() === bDay;
}

/** Age the user is turning today (or already turned this year). Returns
 *  null when birthdate is missing or today isn't their birthday — we
 *  only call it from the banner so non-bday days short-circuit. */
export function ageOnBirthday(birthdateISO: string | null | undefined, today: Date = new Date()): number | null {
  if (!isBirthdayToday(birthdateISO, today)) return null;
  const parts = (birthdateISO ?? '').split('-');
  const bYear = Number(parts[0]);
  if (!Number.isFinite(bYear)) return null;
  const age = today.getFullYear() - bYear;
  if (age < 0 || age > 130) return null;  // sanity bound
  return age;
}

/** Storage-key suffix for "did the user dismiss today's banner?" The
 *  banner re-appears next year on the same MM-DD. */
export function birthdayDismissKey(today: Date = new Date()): string {
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  return `birthday_dismissed_${yyyy}-${mm}-${dd}`;
}

function _isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const BIRTHDAY_GREETINGS = [
  'Happy birthday',
  'It\'s your day',
  'Many happy returns',
  'Cheers to you',
];

/** Pick a greeting that's stable for a given (year, name) so reloading
 *  the page doesn't shuffle the copy. */
export function pickBirthdayGreeting(name: string | null | undefined, today: Date = new Date()): string {
  const seed = `${today.getFullYear()}-${(name ?? '').toLowerCase().trim()}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  }
  return BIRTHDAY_GREETINGS[Math.abs(h) % BIRTHDAY_GREETINGS.length];
}
