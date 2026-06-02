// Smoke tests for legal version re-acceptance gating.

import { LEGAL_SECTIONS, LEGAL_VERSION, needsLegalReAcceptance, legalAcceptanceLabel } from '../legal.ts';

describe('legal helpers', () => {
  describe('needsLegalReAcceptance', () => {
    it('returns false when state is null (pre-login)', () => {
      expect(needsLegalReAcceptance(null)).toBe(false);
      expect(needsLegalReAcceptance(undefined)).toBe(false);
    });

    it('returns true when any version is older', () => {
      expect(needsLegalReAcceptance({
        terms_version: '2020-01-01',
        privacy_version: LEGAL_VERSION,
        health_disclaimer_version: LEGAL_VERSION,
        ai_disclaimer_version: LEGAL_VERSION,
      })).toBe(true);
    });

    it('returns true when any version is missing', () => {
      expect(needsLegalReAcceptance({
        terms_version: LEGAL_VERSION,
        privacy_version: null,
        health_disclaimer_version: LEGAL_VERSION,
        ai_disclaimer_version: LEGAL_VERSION,
      })).toBe(true);
    });

    it('returns false when all four versions match the current LEGAL_VERSION', () => {
      expect(needsLegalReAcceptance({
        terms_version: LEGAL_VERSION,
        privacy_version: LEGAL_VERSION,
        health_disclaimer_version: LEGAL_VERSION,
        ai_disclaimer_version: LEGAL_VERSION,
      })).toBe(false);
    });
  });

  describe('legalAcceptanceLabel', () => {
    it('includes the current version', () => {
      expect(legalAcceptanceLabel()).toContain(LEGAL_VERSION);
    });
  });

  describe('legal sections', () => {
    it('discloses lab report handling and AI extraction', () => {
      const copy = LEGAL_SECTIONS.map(section => `${section.title} ${section.body}`).join(' ').toLowerCase();
      expect(copy).toContain('lab report');
      expect(copy).toContain('lab marker');
      expect(copy).toContain('raw report files');
      expect(copy).toContain('openai');
      expect(copy).toContain('location');
      expect(copy).toContain('revenuecat');
      expect(copy).toContain('30 days');
      expect(copy).toContain('does not diagnose');
      expect(copy).toContain('13 years old');
      expect(copy).toContain('social');
      expect(copy).toContain('calories, macros, meals, weight');
      expect(copy).toContain('security incident');
      expect(copy).toContain('ip address');
    });
  });
});
