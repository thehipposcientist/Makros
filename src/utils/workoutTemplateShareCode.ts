/**
 * Workout-template share-code helpers.
 *
 * Pure-function module so the parsing logic stays testable and reusable
 * across the import modal, the deep-link handler, and the bundle share
 * surface. Backend canonical alphabet + lengths live in
 * backend/app/routers/workout_templates.py.
 */

/** Ambiguity-stripped alphabet — no 0/O, no 1/I/L. Mirrors
 *  `_SHARE_CODE_ALPHABET` server-side. */
export const SHARE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/** 6-char per-template share code length. */
export const SINGLE_CODE_LENGTH = 6;
/** 8-char bundle share code length. */
export const BUNDLE_CODE_LENGTH = 8;

export type ShareCodeShape = 'single' | 'bundle' | null;

/** Strip whitespace + ambiguous characters, uppercase, and clip to the
 *  bundle (= maximum allowed) length. Suitable for the import TextInput
 *  `onChangeText` so paste-from-clipboard normalizes regardless of how
 *  the sender shared it. */
export function normalizeShareCode(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toUpperCase()
    .split('')
    .filter(c => SHARE_CODE_ALPHABET.includes(c))
    .slice(0, BUNDLE_CODE_LENGTH)
    .join('');
}

/** Classify a normalized code by length — single (6), bundle (8), or
 *  null when the code is incomplete / unrecognizable. */
export function classifyShareCode(code: string): ShareCodeShape {
  if (code.length === SINGLE_CODE_LENGTH) return 'single';
  if (code.length === BUNDLE_CODE_LENGTH) return 'bundle';
  return null;
}
