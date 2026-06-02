export const SAVED_MEAL_SHARE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const SAVED_MEAL_CODE_LENGTH = 6;

export function normalizeSavedMealShareCode(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toUpperCase()
    .split('')
    .filter(c => SAVED_MEAL_SHARE_CODE_ALPHABET.includes(c))
    .slice(0, SAVED_MEAL_CODE_LENGTH)
    .join('');
}
