# Beta Privacy Readiness

Last updated: 2026-05-31

Practical checklist for getting Thallo safe enough for a controlled beta without pretending the public-launch legal stack is finished.

## Must Have Before Beta

- In-app Privacy & Data page in Settings with plain-English data use, Apple Health, AI, export, deletion, and support contact.
- HealthKit pre-permission screen before the OS prompt, with HealthKit clearly optional.
- HealthKit requested categories match actual app use.
- Account/data deletion endpoint protected by auth and reachable from the app.
- Export data path reachable from the app.
- Legal modal covers Terms, Privacy, Health/Fitness disclaimer, AI disclosure, and account deletion.
- Legal modal covers optional lab report uploads/scans, reviewed lab marker storage, AI extraction, and no-diagnosis/no-medical-interpretation framing.
- Legal modal covers age floor, social sharing/moderation, legal acceptance IP/user-agent audit fields, security incident notices, and optional location/route/sun exposure handling.
- Legal acceptance records preserve a versioned server-side audit trail for signup, OAuth account creation, and re-acceptance.
- No HIPAA compliance claim.
- No medical diagnosis, treatment, or guaranteed-results claims.
- Social surfaces keep calorie, macro, weight, body-composition, and meal data private.
- Location use is clearly explained as outdoor-cardio route/distance/pace only, with no continuous background tracking outside an active workout.
- OpenAI usage documented, including image/audio/photo scan paths and lab report extraction.
- First-party telemetry documented, including JS error messages and stacks.
- `ios/Thallo/PrivacyInfo.xcprivacy` includes collected-data declarations matching the current iOS feature set at a conservative level.

## Should Have Before Public Launch

- Public Privacy Policy and Terms URLs hosted from the drafts in `docs/legal/`, after founder/legal review.
- Founder/legal-reviewed App Store privacy labels.
- Confirm App Store privacy labels against `ios/Thallo/PrivacyInfo.xcprivacy` and `docs/privacy-data-inventory.md`.
- Written data-retention policy for database rows, backups, server logs, telemetry, and AI vendor retention.
- Health breach / consumer health data incident response runbook.
- Account deletion confirmation email or in-app receipt.
- More complete export format with a user-readable summary, not only raw JSON.
- Automated backend test that deletion removes representative rows across workouts, meals, Health summaries, AI decisions, social feed, telemetry, and custom foods.
- Security review for auth token storage, CORS, rate limits, image/audio upload limits, and logging redaction.
- Review any TestFlight analytics/crash tooling before adding it.
- Real purchase/subscription privacy review once billing is implemented.

## Legal Review Needed

- Whether beta Terms/Privacy can ship inside the app only or needs hosted web URLs.
- Whether HealthKit summaries, menstrual/cycle summaries, body photos, and body metrics need special state/country language.
- Whether bloodwork/lab report uploads need additional consent, age, retention, or regional sensitive-health-data language.
- Whether body scan/form photo features need stronger age, consent, or retention wording.
- Whether workout route coordinates need additional retention/export/deletion copy, and whether future weather-aware hydration can use approximate location/manual city without extra consent language.
- Whether nutrition/recovery scoring language is safely framed as estimates and fitness guidance.
- Whether account deletion wording should mention backups, moderation records, AI vendor retention, and aggregate analytics.
- Whether AI vendor terms allow the current photo, audio, Health summary, meal, workout, and check-in payloads.
- Whether App Store privacy labels should classify data as Sensitive Info in addition to Health/Fitness/User Content.
- Whether FTC Health Breach Notification Rule, state consumer-health-data laws, or non-US health privacy laws require extra notices, consent, or breach workflows.
- Whether the app needs stronger age gating at signup, not only the onboarding birthdate floor.
