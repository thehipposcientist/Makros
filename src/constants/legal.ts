export const LEGAL_VERSION = '2026-04-29';
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
    title: 'Health And Fitness Disclaimer',
    body: 'Thallo is not medical care and does not diagnose, treat, or prevent disease. Talk with a qualified professional before starting a new training, nutrition, supplement, or weight-change plan, especially if you have a medical condition, injury, or are pregnant.',
  },
  {
    title: 'AI Disclosure',
    body: 'Thallo uses AI for meal help, coaching, scans, classification, and workout feedback. Workout plan structure and exercise selection are deterministic rules, not AI-generated. AI output can be wrong, so review recommendations before acting on them.',
  },
] as const;

export function legalAcceptanceLabel(): string {
  return `I agree to Thallo's Terms, Privacy Policy, Health Disclaimer, and AI Disclosure (version ${LEGAL_VERSION}).`;
}
