// Tests for the share-code parsing helpers shared by the import modal
// and the deep-link handler. The functions are tiny but they're load-
// bearing for any flow that takes a user-pasted code, so coverage is
// worth it.

import {
  BUNDLE_CODE_LENGTH,
  SHARE_CODE_ALPHABET,
  SINGLE_CODE_LENGTH,
  classifyShareCode,
  normalizeShareCode,
} from '../workoutTemplateShareCode.ts';

describe('normalizeShareCode', () => {
  it('uppercases and strips ambiguous characters', () => {
    // 0/O and 1/I/L are intentionally outside the alphabet.
    expect(normalizeShareCode('abc234')).toBe('ABC234');
    expect(normalizeShareCode('a-b c.2_3 4')).toBe('ABC234');
    // 0 and 1 are not in the alphabet, so they're dropped.
    expect(normalizeShareCode('A0BC10I')).toBe('ABC');
  });

  it('trims to the bundle (= maximum) length', () => {
    const stuffed = normalizeShareCode('ABCDEFGHJKMNPQRS');
    expect(stuffed.length).toBe(BUNDLE_CODE_LENGTH);
  });

  it('returns empty string for null / undefined / blank', () => {
    expect(normalizeShareCode(null)).toBe('');
    expect(normalizeShareCode(undefined)).toBe('');
    expect(normalizeShareCode('')).toBe('');
    expect(normalizeShareCode('   ')).toBe('');
  });

  it('every character of the result is in the canonical alphabet', () => {
    const result = normalizeShareCode('hello world ABCD234');
    for (const c of result) {
      expect(SHARE_CODE_ALPHABET.includes(c)).toBe(true);
    }
  });
});

describe('classifyShareCode', () => {
  it('classifies a 6-char code as single', () => {
    expect(classifyShareCode('ABC234')).toBe('single');
    expect(SINGLE_CODE_LENGTH).toBe(6);
  });

  it('classifies an 8-char code as bundle', () => {
    expect(classifyShareCode('ABC23456')).toBe('bundle');
    expect(BUNDLE_CODE_LENGTH).toBe(8);
  });

  it('returns null for incomplete or unknown lengths', () => {
    expect(classifyShareCode('')).toBe(null);
    expect(classifyShareCode('AB')).toBe(null);
    expect(classifyShareCode('ABC23')).toBe(null);    // 5
    expect(classifyShareCode('ABC2345')).toBe(null);  // 7
    expect(classifyShareCode('ABC234567')).toBe(null); // 9
  });

  it('round-trips with normalizeShareCode for typical inputs', () => {
    // Receiver-side flow: user pastes "abc 234", the input normalizes
    // to "ABC234", the modal classifies as single.
    expect(classifyShareCode(normalizeShareCode('abc 234'))).toBe('single');
    // Bundle deep link: "thallo://template-bundle/abc23456" — the
    // handler extracts "abc23456", normalize uppercases it, classify
    // says bundle.
    expect(classifyShareCode(normalizeShareCode('abc23456'))).toBe('bundle');
  });
});
