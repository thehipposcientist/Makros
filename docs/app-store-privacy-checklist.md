# App Store Privacy Checklist

Last updated: 2026-05-06

Internal checklist for App Store Connect privacy labels and HealthKit review. Final answers need founder/legal review before submission.

Official references:

- [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [App Store Connect App Privacy Overview](https://developer.apple.com/help/app-store-connect/reference/app-privacy-overview/)
- [App Review Guidelines: Health and Health Research](https://developer.apple.com/app-store/review/guidelines/#health-and-health-research)

## Likely App Privacy Label Categories

| Apple category | Likely applies | Current Thallo examples | Linked to user | Used for tracking | Founder/legal review |
|---|---:|---|---:|---:|---|
| Contact Info | Yes | Email, name | Yes | No | Confirm support/email provider handling |
| User ID | Yes | Backend user id, username, Apple/Google subject ids | Yes | No | Confirm Apple/Google sign-in disclosure |
| Health | Yes | Body weight, body metrics, goals, sleep, HRV, RHR, blood oxygen, respiratory rate, menstrual/cycle summary, recovery/check-ins | Yes | No | High priority review |
| Fitness | Yes | Workouts, exercises, sets, reps, weights, steps, active energy, workout minutes, VO2 max, HR zones | Yes | No | High priority review |
| User Content | Yes | Food/equipment/body/form photos, social captions/photos, notes, coach messages, meal descriptions | Yes | No | Confirm body/form photo treatment |
| Audio Data | Yes if speech-to-meal ships | Meal voice recordings sent to `/ai/speech-to-meal` for transcription | Yes | No | Confirm retention of audio blobs |
| Identifiers | Possibly | Optional first-party install marker for telemetry if populated; auth tokens are credentials, not label data | Possibly | No | Verify `installMarker` lifecycle |
| Usage Data | Yes | In-app telemetry events, API errors, HealthKit permission result, onboarding completion | Yes when signed in | No | Confirm event payload minimization |
| Diagnostics | Yes | JS error message/stack, API/network error telemetry | Yes when signed in | No | Confirm crash/error retention |
| Purchases | Not yet, likely later | `subscription_tier` exists, but no StoreKit/RevenueCat purchase flow found | Yes if implemented | No | Required before paid public launch |
| Search History | Needs review | Food/exercise search terms may hit backend/USDA/OpenAI paths; retention unclear beyond server logs | Possibly | No | Review server logs and external food lookup behavior |
| Location | Not found | No GPS/location permission found | No | No | Re-check if route tracking is added |
| Contacts | Not found | No contacts permission found | No | No | Re-check before social expansion |
| Browsing History | Not found | No web browsing history collection found | No | No | Low risk |
| Sensitive Info | Needs review | Health, body photos, menstrual/cycle data, injuries, pregnancy references in disclaimers | Yes | No | Legal should decide label interpretation |

## HealthKit Checklist

- HealthKit connection is optional in onboarding, Progress, and Settings copy.
- In-app HealthKit explanation lists the actual read categories requested by `READ_TYPES`.
- Write explanation says Thallo writes completed workouts plus workout energy/distance when present.
- Do not use HealthKit data for advertising, tracking, or social disclosure.
- Do not claim raw Apple Health samples are uploaded. Current behavior: raw reads happen on device, while daily/nightly summaries can sync to the backend.
- Confirm App Store Connect privacy answers match `ios/Thallo/Info.plist` Health usage strings.

## AI And Vendor Checklist

- OpenAI is a third-party AI vendor for coach chat, scans, parsing, classification, supplements, summaries, and check-ins.
- Do not claim data is never shared. Use "may be sent to our AI vendor to generate the requested recommendation."
- Direct account identifiers are stripped from server-generated coach check-in payloads, but workout, nutrition, macro, recovery, Health summary, supplement, image, audio, and transcript context can be sent when relevant.
- USDA FoodData Central and Open Food Facts can receive food lookup queries.
- Google and Apple sign-in providers receive sign-in data when users choose those options.

## Current Gaps Before App Store Submission

- App privacy label answers need founder/legal review.
- `ios/Thallo/PrivacyInfo.xcprivacy` currently declares required API access but no collected data types. Update it if the final privacy manifest should mirror collected data categories.
- Confirm server logs, backups, and OpenAI retention policies for deletion/export wording.
- Confirm no third-party analytics/crash SDK is added before public launch. If added, update this checklist and the in-app Privacy/Data page.
- Paid launch needs real purchase disclosure once StoreKit/RevenueCat or another billing provider is implemented.
