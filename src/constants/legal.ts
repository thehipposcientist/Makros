// Bump this whenever the body of any LEGAL_SECTIONS entry changes. The
// frontend compares the active user's accepted version against this and
// shows the LegalDisclosureModal on next launch when they differ.
export const LEGAL_VERSION = '2026-05-06.2';
export const SUPPORT_EMAIL = 'thallosupport@gmail.com';

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
    body: 'Thallo uses OpenAI to power meal parsing, coach chat, scans, classification, and workout feedback. Prompts may include relevant workout, nutrition, macro, recovery, supplement, Health summary, and photo-derived context needed for the feature; direct account identifiers such as your name or email are not required and are stripped from server-generated coach check-in payloads. Food nutrition data comes from the USDA FoodData Central database. Apple Health reads happen on your device, and daily summaries may sync to your account for trends and check-ins. We do not sell your data to advertisers, and calorie, macro, and weight data never crosses the social sharing boundary.',
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
    body: 'You can delete your account from Settings at any time. After deletion we remove Thallo-created profile and log data, disable login, and anonymize account identifiers. Aggregate, non-identifying analytics and records needed for security or moderation may persist for product safety.',
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
