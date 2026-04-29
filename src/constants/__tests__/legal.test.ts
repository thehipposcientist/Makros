// Smoke tests for legal version re-acceptance gating.

import { LEGAL_VERSION, needsLegalReAcceptance, legalAcceptanceLabel } from '../legal';

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
});
