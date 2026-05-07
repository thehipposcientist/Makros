# Privacy Data Inventory

Last updated: 2026-05-06

This is an internal beta-readiness inventory based on the current React Native, Expo, native iOS, Watch, and FastAPI code. It is not legal copy.

## Implementation Notes

- Primary account deletion endpoint: `DELETE /profile/account` in `backend/app/routers/profile.py`.
- Account export endpoint: `GET /profile/export` in `backend/app/routers/profile.py`.
- HealthKit read/write bridge: `modules/thallo-healthkit/ios/ThalloHealthKitModule.swift`.
- Client HealthKit summary persistence: `src/services/healthDataSummary.ts`, `src/services/appleHealth.ts`, `/health/*`, and `/sleep/*`.
- AI vendor calls: OpenAI calls are in `backend/app/routers/ai/*`, `backend/app/services/coach/checkin_ai.py`, `backend/app/services/nutrition/ai_classify.py`, `backend/app/services/nutrition/meal_assembler.py`, `backend/app/services/supplement_ai_recs.py`, and related utility wrappers.
- Analytics/crash-style tracking: no third-party analytics or crash SDK was found. The app sends first-party telemetry to `/telemetry/events`, including API errors and JS error messages/stacks.

## Data Categories

| Category | Source | Purpose | Stored | Retention assumption | Optional | Third-party sharing |
|---|---|---|---|---|---|---|
| Account identifiers | Email/password login, Apple/Google sign-in, profile name | Login, account recovery, support, legal acceptance | Backend `user` table; auth token in SecureStore | Until account deletion; account shell anonymized after deletion | Required for account | Apple/Google sign-in providers when used |
| Profile/body stats | Onboarding and Edit Profile | Calories, macros, workout planning, HR zones, progress | `user_profiles`, `user_goals`, `user_preferences`, client cache | Until deletion | Required for planning | May be included in OpenAI prompts when needed for AI features |
| Workouts and plans | Deterministic planner, user edits, plan weeks | Weekly schedule, training history, adherence | `plan_weeks`, `plan_days`, `workout_plans`, client cache | Until deletion | Core app data | Workout context may be sent to OpenAI for coach/chat/summaries; workout-only social sharing if user opts in |
| Exercises, sets, reps, weights | Active workout logging, imports, manual activity | Progression, fatigue, PRs, e1RM, history | `workout_sessions`, `workout_exercises`, `exercise_sets`, `workout_completions` | Until deletion | Core app data | May be sent to OpenAI for coach/chat, warmups, workout summaries, and set review |
| Nutrition/macros/meals | Meal logging, saved meals, food search, scans, voice meal entry | Meal history, scoring, macro targets, grocery/list insights | `meals`, `meal_items`, `saved_meals`, `daily_rollups`, `daily_nutrition_metrics`, client cache | Until deletion | Optional but central to nutrition features | FoodData Central and Open Food Facts for food lookups; OpenAI for parsing, scans, fallback classification, and enrichment |
| Custom/private foods | Manual entry, AI fallback search, scans | Search ranking, meal logging, meal plans | `foods.owner_user_id`, `food_nutrition`, `food_servings`, `user_recent_foods` | User-owned foods deleted on account deletion | Optional | OpenAI may receive food names/details for classification or enrichment |
| Body weight/body goals/body metrics | Onboarding, weekly check-ins, manual logs, Apple Health, body scans | Goal trajectory, adaptive macros, progress | `user_profiles`, `user_goals`, `weight_entries`, `weekly_checkins`, `body_scans`, `daily_health_snapshots` | Until deletion | Weight/body goals required for many plans; body scans optional | OpenAI for body scan endpoint when user submits a photo |
| Apple Health / HealthKit data | iOS HealthKit permissioned reads | Readiness, recovery, progress trends, weekly check-ins, nutrition/training recommendations | Raw samples read on device; daily summaries in `daily_health_snapshots`; nightly rows in `sleep_logs`; local cache | Until deletion for backend summaries; local cache until app/account cleanup | Optional | Apple Health receives completed workout writes. OpenAI may receive Health summary context for AI recommendations, not raw HealthKit samples |
| Sleep | Apple Health sleep samples and derived sleep score | Sleep score, readiness, recovery, coaching context | `sleep_logs`, local sleep history cache | Until deletion | Optional | Derived sleep/recovery context may be included in OpenAI check-in/coach prompts |
| Steps/activity/energy | Apple Health steps, active energy, basal energy, workouts | Activity adjustment, readiness, progress | `daily_health_snapshots`; Health tab cache | Until deletion | Optional | Derived activity context may be included in OpenAI prompts |
| Heart rate/RHR/HRV/VO2/respiratory/O2 | Apple Health and Watch | Readiness, sleep score, HR zones, workout summaries | `daily_health_snapshots`, `sleep_logs`, workout `hr_summary`/set HR fields | Until deletion | Optional | Derived values may be included in OpenAI prompts |
| Menstrual/cycle signals | Apple Health menstrual-flow samples | Optional cycle-aware guidance and readiness context | Current code derives phase/day on device and passes summary context; no raw menstrual-flow sample table found | Summary context only when used; no raw backend retention identified | Optional | Cycle summary may be sent to backend readiness/planner calls; raw samples are not sent |
| Recovery/check-ins/scores | User check-ins, readiness computations, fatigue, nutrition flags | Recommendations and plan adjustments | `weekly_checkins`, `plan_week_checkins`, `user_coaching_state`, `coach_memory`, `user_flags`, `user_rollups`, `daily_rollups` | Until deletion | Optional | Check-in payloads may be sent to OpenAI with direct account identifiers stripped |
| AI prompts/responses/usage | Coach chat, scans, parsing, classification, summaries, check-ins | Recommendations, parsing, scan results, operational cost tracking | `ai_decisions`, `coach_memory`, `supplement_ai_cache`, `ai_usage_events`, plan job results | Until deletion for user-linked rows; aggregate operational data may persist if not user-linked | Optional by feature | OpenAI receives feature-specific prompts, images, audio, transcripts, and context |
| Photos/images | Food, supplement, equipment, form, body scan, social share photo | Scan results, gear identification, form/body feedback, optional social posts | Some scan results stored; body scan results stored; social post payload may include photo data; transient request payloads in API | Until deletion where stored; server logs/backups need legal review | Optional | OpenAI for AI scans; social photo only if user posts |
| Audio | Speech-to-meal recording | Transcribe meal description and parse foods | Sent to backend `/ai/speech-to-meal`; transcript returned and may become logged meal data | Audio blob appears transient; transcript/meal items retained if logged | Optional | OpenAI transcription and parsing |
| Supplements | User stack, dose logs, supplement scans/recs | Reminders, stack tracking, recommendations | `user_supplement_stack`, `supplement_logs`, `supplement_ai_cache` | Until deletion | Optional | OpenAI for supplement scans and AI recommendations |
| Gear/equipment | Onboarding equipment, gear tracking, equipment scans | Planner equipment fit, mileage/session tracking, retirement suggestions | `user_preferences`, `user_equipment_profiles`, `gear_items` | Until deletion | Optional | OpenAI for equipment/gear photo identification |
| Social/friends | Friend requests, social profile, feed posts, likes | Friends-only workout sharing | `user_social_profiles`, `friendships`, `activity_feed`, `feed_likes`, `social_notifications`, `weekly_digest_cache` | Until deletion; derived digest cache cleared on deletion | Optional | No third-party social sharing found. Workout-only data visible to friends when enabled |
| Telemetry/diagnostics | API helper, global JS error handler, HealthKit permission events | Reliability and debugging | `client_telemetry_events`; app logs | User-linked telemetry deleted on account deletion; anonymous/aggregate retention needs review | Mostly automatic | No third-party analytics SDK found |
| Purchases/subscriptions | Server `subscription_tier`; beta access helpers | Feature gates | `user.subscription_tier`; no StoreKit/RevenueCat implementation found | Until deletion/anonymization | Required for paid features once billing exists | Founder review needed before public launch |

## AI Vendor Payloads

OpenAI payloads may include only the context needed by the feature. Current code paths include:

- Meal text/photo/audio parsing: meal descriptions, photos/audio, transcript, food names, rough quantities, macro context.
- Coach chat and check-ins: profile, goals, recent workout/meal/adherence/recovery context, user notes, and limited history.
- Workout coach, warmups, summaries, and set review: active workout, exercises, sets, reps, weights, RPE/RIR, injuries, recent history.
- Image-analysis endpoints: food, supplement, equipment, form, and body photos submitted by the user.
- Supplement recommendations: profile/goal and supplement stack context.
- Food classification/enrichment fallback: food names and nutrition context.

Direct account identifiers are stripped from server-generated coach check-in payloads. Do not claim that data is never shared with vendors.

## Deletion And Export Status

- Export is implemented through `GET /profile/export` and exposed in the Account modal plus Settings Privacy & Data.
- Account/data deletion is implemented through `DELETE /profile/account`. It deletes user-created profile/log/planning/social/telemetry rows, deletes owned private foods, clears derived digest cache, disables login, and anonymizes email/username/name.
- The user row remains as an anonymized shell for auth uniqueness, audit consistency, and foreign-key stability.
- Needs founder/legal review: backup retention, server log retention, AI vendor retention, moderation records, and whether anonymous telemetry may persist after deletion.
