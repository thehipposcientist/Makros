# Beta Privacy Readiness

Last updated: 2026-05-06

Practical checklist for getting Thallo safe enough for a controlled beta without pretending the public-launch legal stack is finished.

## Must Have Before Beta

- In-app Privacy & Data page in Settings with plain-English data use, Apple Health, AI, export, deletion, and support contact.
- HealthKit pre-permission screen before the OS prompt, with HealthKit clearly optional.
- HealthKit requested categories match actual app use.
- Account/data deletion endpoint protected by auth and reachable from the app.
- Export data path reachable from the app.
- Legal modal covers Terms, Privacy, Health/Fitness disclaimer, AI disclosure, and account deletion.
- No HIPAA compliance claim.
- No medical diagnosis, treatment, or guaranteed-results claims.
- Social surfaces keep calorie, macro, weight, body-composition, and meal data private.
- OpenAI usage documented, including image/audio/photo scan paths.
- First-party telemetry documented, including JS error messages and stacks.

## Should Have Before Public Launch

- Public Privacy Policy URL and support/privacy email routed to a real inbox/process.
- Founder/legal-reviewed App Store privacy labels.
- Update `ios/Thallo/PrivacyInfo.xcprivacy` if final manifest should declare collected data categories.
- Written data-retention policy for database rows, backups, server logs, telemetry, and AI vendor retention.
- Account deletion confirmation email or in-app receipt.
- More complete export format with a user-readable summary, not only raw JSON.
- Automated backend test that deletion removes representative rows across workouts, meals, Health summaries, AI decisions, social feed, telemetry, and custom foods.
- Security review for auth token storage, CORS, rate limits, image/audio upload limits, and logging redaction.
- Review any TestFlight analytics/crash tooling before adding it.
- Real purchase/subscription privacy review once billing is implemented.

## Legal Review Needed

- Whether beta Terms/Privacy can ship inside the app only or needs hosted web URLs.
- Whether HealthKit summaries, menstrual/cycle summaries, body photos, and body metrics need special state/country language.
- Whether body scan/form photo features need stronger age, consent, or retention wording.
- Whether nutrition/recovery scoring language is safely framed as estimates and fitness guidance.
- Whether account deletion wording should mention backups, moderation records, AI vendor retention, and aggregate analytics.
- Whether AI vendor terms allow the current photo, audio, Health summary, meal, workout, and check-in payloads.
- Whether App Store privacy labels should classify any data as Sensitive Info in addition to Health/Fitness/User Content.
