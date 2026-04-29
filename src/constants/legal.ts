// Bump this whenever the body of any LEGAL_SECTIONS entry changes. The
// frontend compares the active user's accepted version against this and
// shows the LegalDisclosureModal on next launch when they differ.
export const LEGAL_VERSION = '2026-04-29.2';
export const SUPPORT_EMAIL = 'support@thallo.app';

export const LEGAL_SECTIONS = [
  {
    title: 'Terms of Service',
    body: 'Thallo is a fitness and nutrition planning app. You are responsible for using the app safely, keeping your account secure, and choosing workouts, meals, supplements, and recovery actions that fit your situation.',
  },
  {
    title: 'Privacy Policy',
    body: 'Thallo stores account, profile, workout, nutrition, weight, recovery, supplement, social, photo-derived, and Apple Health-related data so the app can personalize your experience. Health and nutrition data should stay private unless you explicitly share workout-only social activity.',
  },
  {
    title: 'Third-Party Services',
    body: 'Thallo uses OpenAI to power meal parsing, coach chat, food photo scanning, and gear photo identification — anonymized prompts, not your name or email, are sent. Food nutrition data comes from the USDA FoodData Central database. Apple Health data stays on your device unless you explicitly share workout-only activity with a friend. We do not sell your data to advertisers and do not share calorie, macro, or weight data outside your account.',
  },
  {
    title: 'Health And Fitness Disclaimer',
    body: 'Thallo is not medical care and does not diagnose, treat, or prevent disease. Talk with a qualified professional before starting a new training, nutrition, supplement, or weight-change plan, especially if you have a medical condition, injury, or are pregnant.',
  },
  {
    title: 'AI Disclosure',
    body: 'Thallo uses AI for meal help, coaching, scans, classification, and workout feedback. Workout plan structure and exercise selection are deterministic rules, not AI-generated. AI output can be wrong, so review recommendations before acting on them.',
  },
  {
    title: 'Account Deletion And Retention',
    body: 'You can delete your account from Settings at any time. After deletion we anonymize your account immediately and permanently remove personal data within 30 days. Aggregate, non-identifying analytics may persist for product improvement.',
  },
] as const;

export function legalAcceptanceLabel(): string {
  return `I agree to Thallo's Terms, Privacy Policy, Health Disclaimer, and AI Disclosure (version ${LEGAL_VERSION}).`;
}

/** Shape of legal-acceptance state surfaced by `/auth/me` so the app can
 *  decide whether to prompt for re-acceptance after a version bump. */
export type LegalAcceptanceState = {
  terms_version?: string | null;
  privacy_version?: string | null;
  health_disclaimer_version?: string | null;
  ai_disclaimer_version?: string | null;
};

/** Returns true when any accepted legal version is older than the current
 *  one. Used at app launch to gate a re-acceptance modal. */
export function needsLegalReAcceptance(state: LegalAcceptanceState | null | undefined): boolean {
  if (!state) return false;  // pre-login or unknown — defer until profile loads
  const current = LEGAL_VERSION;
  return (
    (state.terms_version ?? '') !== current
    || (state.privacy_version ?? '') !== current
    || (state.health_disclaimer_version ?? '') !== current
    || (state.ai_disclaimer_version ?? '') !== current
  );
}
