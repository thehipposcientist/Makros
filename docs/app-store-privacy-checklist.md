# App Store Privacy Checklist

Last updated: 2026-05-31

Internal checklist for App Store Connect privacy labels and HealthKit review. Final answers need founder/legal review before submission.

Official references:

- [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [App Store Connect App Privacy Overview](https://developer.apple.com/help/app-store-connect/reference/app-privacy-overview/)
- [App Review Guidelines: Health and Health Research](https://developer.apple.com/app-store/review/guidelines/#health-and-health-research)
- [FTC Health Breach Notification Rule guidance](https://www.ftc.gov/business-guidance/resources/complying-ftcs-health-breach-notification-rule-0)
- [OpenAI API data controls](https://platform.openai.com/docs/guides/your-data)

## Likely App Privacy Label Categories

| Apple category | Likely applies | Current Thallo examples | Linked to user | Used for tracking | Founder/legal review |
|---|---:|---|---:|---:|---|
| Contact Info | Yes | Email, name | Yes | No | Confirm support/email provider handling |
| User ID | Yes | Backend user id, username, Apple/Google subject ids | Yes | No | Confirm Apple/Google sign-in disclosure |
| Health | Yes | Body weight, body metrics, goals, sleep, HRV, RHR, blood oxygen, respiratory rate, menstrual/cycle summary, recovery/check-ins, saved lab markers/bloodwork values | Yes | No | High priority review |
| Fitness | Yes | Workouts, exercises, sets, reps, weights, steps, active energy, workout minutes, VO2 max, HR zones | Yes | No | High priority review |
| User Content | Yes | Food/equipment/body/form/lab-report photos or videos, text-based lab report PDFs, social captions/photos/comments, notes, coach messages, meal descriptions, import files | Yes | No | Confirm body/form/lab-report upload treatment |
| Audio Data | Yes if speech-to-meal ships | Meal voice recordings sent to `/ai/speech-to-meal` for transcription | Yes | No | Confirm retention of audio blobs |
| Identifiers | Possibly | Optional first-party install marker for telemetry if populated; auth tokens are credentials, not label data | Possibly | No | Verify `installMarker` lifecycle |
| Usage Data | Yes | In-app telemetry events, API errors, HealthKit permission result, onboarding completion | Yes when signed in | No | Confirm event payload minimization |
| Diagnostics | Yes | JS error message/stack, API/network error telemetry | Yes when signed in | No | Confirm crash/error retention |
| Purchases | Yes when billing ships | RevenueCat customer id, product id, entitlement/status, purchase/expiration timestamps | Yes | No | Validate App Store / Play disclosure after live purchase testing |
| Search History | Needs review | Food/exercise/user search terms may hit backend/USDA/OpenAI paths; DB retention is not obvious beyond selections/recent foods and server logs | Possibly | No | Review server logs and external food lookup behavior before answering |
| Location | Yes | Outdoor cardio GPS route/distance/pace on phone and Watch; `WorkoutCompletion.route_coords`; workout route writes to Apple Health when present | Yes | No | Confirm App Store label, background-location wording, and route retention |
| Contacts | Not found | Friend graph is app-created usernames/friendships, not device contacts | No | No | Re-check before contacts/social expansion |
| Browsing History | Not found | No web browsing history collection found | No | No | Low risk |
| Sensitive Info | Likely yes | Pregnancy/support flags, menstrual/cycle data, injuries, allergies, body/lab data, and other sensitive wellness fields in addition to Health/Fitness labels | Yes | No | Legal should confirm final label interpretation |

## HealthKit Checklist

- HealthKit connection is optional in onboarding, Progress, and Settings copy.
- In-app HealthKit explanation lists the actual read categories requested by `READ_TYPES`, including menstrual-flow, daylight, sleep-breathing, wrist-temperature, mindful, standing, and nutrition summary categories.
- Write explanation says Thallo writes completed workouts plus workout energy, distance, and route data when present.
- Do not use HealthKit data for advertising, tracking, or social disclosure.
- Do not claim raw Apple Health samples are uploaded. Current behavior: raw reads happen on device, while daily/nightly summaries can sync to the backend.
- Confirm App Store Connect privacy answers match `ios/Thallo/Info.plist` Health usage strings.
- Completed outdoor-cardio workouts may include route coordinates when the user grants location permission and starts an outdoor cardio session. If written to Apple Health, the route appears with that workout.
- App Store review notes should call out that background location is used only to keep an active outdoor cardio session recording when the screen locks.

## AI And Vendor Checklist

- OpenAI is a third-party AI vendor for coach chat, scans, parsing, classification, supplements, summaries, lab report extraction, and check-ins.
- Do not claim data is never shared. Use "may be sent to our AI vendor to generate the requested recommendation."
- Direct account identifiers are stripped from server-generated coach check-in payloads, but workout, nutrition, macro, recovery, Health summary, lab marker, lab report image/PDF text, supplement, image, audio, transcript, and photo-derived context can be sent when relevant.
- OpenAI API docs currently say API data is not used to train by default unless opted in, with default abuse-monitoring retention up to 30 days unless longer retention is required or allowed by policy. Confirm the production OpenAI project data controls before making stronger claims.
- USDA FoodData Central and Open Food Facts can receive food lookup queries.
- Google and Apple sign-in providers receive sign-in data when users choose those options.
- Future weather-aware hydration should use approximate location or manual city/ZIP and store weather facts instead of continuous GPS. If a weather provider is added, update vendor disclosures and privacy labels before shipping.

## Privacy Manifest Status

- `ios/Thallo/PrivacyInfo.xcprivacy` now declares required API access plus collected data types for contact info, user ID, location, Health, Sensitive Info, Fitness, photos/videos, audio, other user content, purchases, product interaction, crash data, performance data, and other diagnostics.
- The manifest is not a replacement for App Store Connect privacy answers. Keep both in sync with the data inventory and legal review.

## Current Gaps Before App Store Submission

- App privacy label answers need founder/legal review.
- Host founder/legal-reviewed public Privacy Policy and Terms URLs. Draft source copy lives in `docs/legal/`.
- Confirm server logs, backups, OpenAI, RevenueCat/app-store, email provider, and hosting retention policies for deletion/export wording.
- Confirm whether `legal_acceptance_events` IP/user-agent audit fields need additional disclosure or a shorter retention window.
- Confirm FTC Health Breach Notification Rule and state consumer-health-data obligations because Thallo stores user-entered health data and can sync with Apple Health / wearables.
- Confirm the Location privacy label now that outdoor-cardio GPS route capture and optional sun exposure coarse location are shipped.
- If weather-aware hydration ships, update labels for approximate location/weather-provider sharing and make the setting opt-in.
- Confirm no third-party analytics/crash SDK is added before public launch. If added, update this checklist and the in-app Privacy/Data page.
- Paid launch needs real purchase disclosure once StoreKit/RevenueCat purchase testing is live.
