// Bump this whenever the body of any LEGAL_SECTIONS entry changes. The
// frontend compares the active user's accepted version against this and
// shows the LegalDisclosureModal on next launch when they differ.
export const LEGAL_VERSION = '2026-05-31.1';
export const SUPPORT_EMAIL = 'thallosupport@gmail.com';

export const LEGAL_SECTIONS = [
  {
    title: 'Terms of Service',
    body: 'Thallo is a fitness and nutrition planning app for personal wellness use. You must be at least 13 years old, and if you are under the age of majority where you live, use Thallo only with parent or guardian permission. You are responsible for using the app safely, keeping your account secure, and choosing workouts, meals, supplements, lab-report uploads, and recovery actions that fit your situation. Do not use Thallo for emergencies, medical decisions, illegal activity, harassment, or content you do not have the right to upload.',
  },
  {
    title: 'Privacy Policy',
    body: 'Thallo stores account, profile, workout, nutrition, weight, recovery, supplement, social, import, search/selection, photo-derived, voice-derived, telemetry, diagnostic, purchase, legal-acceptance, optional lab marker, optional workout-route/location, optional cycle, optional motion/activity, and optional connected health-platform data so the app can personalize your experience, sync across devices, secure your account, provide support, process billing, and improve reliability. Health, nutrition, weight, body, route, cycle, lab, and meal data stay private unless you explicitly share workout-only social activity.',
  },
  {
    title: 'Lab Reports And Sensitive Health Data',
    body: 'Lab report scanning is optional. Uploaded report photos, screenshots, or text-based PDFs are processed to extract candidate marker rows; Thallo is designed to store reviewed lab marker values, units, dates, and reference ranges, not raw report files. Lab reports may contain sensitive identifiers, so crop or redact names, account numbers, addresses, or provider details when practical.',
  },
  {
    title: 'Third-Party Services',
    body: 'Thallo uses OpenAI to power meal parsing, coach chat, scans, classification, lab report extraction, and workout feedback. Prompts may include relevant workout, nutrition, macro, recovery, supplement, Health summary, lab marker, image, audio, transcript, PDF text, and photo-derived context needed for the feature. Direct account identifiers such as your name or email are not required and are stripped from server-generated coach check-in payloads. Food and exercise data can come from USDA FoodData Central, Open Food Facts, wger, and configured restaurant/branded food providers. Apple or Google receive sign-in data when you choose their login. RevenueCat and app stores process subscription status when paid billing is enabled. Optional connected health-platform reads happen on your device, and daily summaries may sync to your account for trends and check-ins. We do not sell your data to advertisers, use HealthKit data for advertising, or use your data for third-party ad tracking.',
  },
  {
    title: 'Location And Routes',
    body: 'Location access is optional and used for active outdoor cardio distance, pace, route maps, elevation, Apple Health workout route writes, and optional sun exposure estimates. Thallo does not use continuous location tracking outside features you start or enable. Stored workout routes and coarse sun-exposure location signals are account data and are included in export and deletion flows.',
  },
  {
    title: 'Social And User Content',
    body: 'Social sharing is optional and friends-only. When enabled, Thallo may show workout activity such as completed sessions, focus, duration, exercises, sets, reps, load, cardio time, distance, pace, streaks, captions, comments, and photos you choose to post. Calories, macros, meals, weight, body measurements, body photos, route coordinates, lab data, cycle data, recovery flags, private notes, and account data do not cross the social boundary. You can delete your posts and comments, block users, report abuse, and Thallo may remove content or restrict accounts to protect users or comply with law.',
  },
  {
    title: 'Subscriptions And Trials',
    body: 'Free trials and Pro subscription status are server-authoritative. When paid billing is enabled, purchases, renewals, cancellations, expirations, restores, product identifiers, entitlement identifiers, and store environment metadata may sync between Thallo, RevenueCat, and the app stores so access can be granted or restored. Store purchase sheets show price, renewal, and cancellation details before purchase.',
  },
  {
    title: 'Health And Fitness Disclaimer',
    body: 'Thallo is not medical care and does not diagnose, treat, monitor, cure, or prevent disease. Lab markers, Health trends, scores, body estimates, cycle-aware suggestions, supplement content, and AI responses are wellness context only, not medical interpretation. Talk with a qualified professional before starting a new training, nutrition, supplement, or weight-change plan, and discuss abnormal, concerning, or persistent symptoms or lab results with a clinician.',
  },
  {
    title: 'AI Disclosure',
    body: 'Thallo uses AI for meal help, coaching, scans, lab report extraction, classification, and workout coaching feedback. Workout plan structure, exercise selection, split logic, and live load/reps guidance are deterministic rules, not AI-generated. AI output can be wrong, including misread foods, equipment, bodies, form cues, supplements, lab values, units, dates, or reference ranges, so review extracted data and recommendations before saving or acting on them.',
  },
  {
    title: 'Data Choices, Export, And Security',
    body: 'You can manage optional permissions in device settings, disconnect Apple Health or Health Connect categories, turn off social sharing, export account data, and request deletion from Settings. Thallo uses reasonable safeguards for account and health data and records legal acceptance events with version, timestamp, IP address, and user-agent for audit and security. If a security incident requires notice, Thallo will provide notices required by applicable law.',
  },
  {
    title: 'Account Deletion And Retention',
    body: 'You can delete your account from Settings at any time. When deletion is requested, Thallo removes app-created profile, plan, workout, meal, weight, health-summary, lab, supplement, social, telemetry, and settings rows, disables login, and anonymizes account identifiers. An anonymized account shell may remain for up to 30 days for deletion safety and database integrity before hard deletion. Backups, server logs, vendor records, aggregate non-identifying analytics, and records needed for security, billing, fraud prevention, or moderation may follow separate retention schedules.',
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
