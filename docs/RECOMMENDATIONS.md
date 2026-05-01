# Thallo Recommendations

Last updated: 2026-04-29 (deep audit refresh)
Audience: product, engineering, launch planning

This is the running launch-readiness list for Thallo. The doc was originally written after a high-level review. The 2026-04-29 refresh adds findings from a deep audit covering legal/auth/privacy, performance/code quality, and feature/UX gaps, plus marks items completed in the current session.

The short version remains the same: Thallo has a real product foundation. The next work should not be a broad feature push. It should be a launch-readiness pass — legal/account basics, signed-build native reliability, production entitlements, observability, and performance cleanup around the biggest screens.

Beta decision as of 2026-05-01: external beta is free. `app.json` now sets `expo.extra.freeBetaFullAccess=true` so external testers get the full guided plan, AI, readiness, and Watch loop without StoreKit/RevenueCat.

## Highest Priority Summary

Do these before a broad beta or paid launch.

Section A (Critical / Launch-Blocking) and section B (Legal, Privacy, Auth & Account) are now fully implemented; what's left is the items that need infrastructure decisions or longer-running work:

1. ~~Replace the placeholder production API URL~~ ✓ Done (A1).
2. ~~Default missing subscription tier to `'free'`, not `'pro'`~~ ✓ Done (A2).
3. Ship and test a fresh signed iOS/TestFlight build so the Watch sync and Live Activity native modules are actually present.
4. Wire an email provider (SES, Postmark, or similar) so the email-token password reset and email verification endpoints actually deliver. Endpoints already exist.
5. ~~Add an authenticated password-change endpoint for logged-in users~~ ✓ Done (A3).
6. ~~Add session revocation / multi-device logout~~ ✓ Done (A4 — token_version column + bump on logout/change/reset).
7. ~~Tighten Info.plist usage descriptions for Face ID, microphone, and photo library~~ ✓ Done (B1 — both app.json and raw plist).
8. Keep the beta free/full-access; replace the beta access override with real StoreKit 2 or RevenueCat entitlements before charging.
9. Add crash reporting, analytics, native bridge logging, Watch sync metrics, and AI cost/error tracking.
10. Split and lazy-load the largest screens, especially `HomeScreen` and `ActiveWorkoutScreen`.
11. Audit ActiveWorkoutScreen setInterval cleanup — 17 timer instances with overlapping responsibilities risk leaks and double-fires on resume.
12. Run `npm install` to pull in the new test dev deps (jest, jest-expo, @testing-library/react-native), then run `npm test` to verify the smoke suite passes (A5 scaffolded).

## Implementation Status

Implemented in the 2026-04-29 non-payment pass (prior):

- Signup now collects first name and last name.
- Signup now requires acceptance of Terms, Privacy Policy, Health Disclaimer, and AI Disclosure.
- Backend stores legal acceptance timestamps and versions.
- Password validation copy now matches the backend rule: at least eight characters and a number.
- Account settings now expose Legal/Safety, support contact, full account export, account deletion, email verification request, and Watch sync status.
- Backend now has full account JSON export and soft-delete/anonymization endpoints.
- Email verification and email-token password reset endpoints are scaffolded, but automatic email delivery still needs an email provider.
- Watch sync writes a local last-sync status snapshot so Account can show whether the last push succeeded or failed.
- User-facing copy was adjusted away from "AI workout plans" toward personalized training plus AI coaching.

Implemented in the 2026-04-29 launch-readiness pass (current session) — completes all of section A (Critical / Launch-Blocking) and section B (Legal, Privacy, Auth & Account):

- **A1 — Production API URL guard.** `getBaseUrl` in `src/services/api.ts` now throws a loud, distinctive error in production when `expo.extra.apiBaseUrl` is missing or matches a placeholder host (`your-production-api.com`, `example.com`, `localhost`). Misconfigured builds fail at first network call instead of producing silent network errors.
- **A2 — Subscription tier defaults to Free.** `tierOf` in `src/utils/subscription.ts` now returns `'free'` for missing profile data (was `'pro'`). Pure-function smoke tests added at `src/utils/__tests__/subscription.test.ts` to pin the regression.
- **A3 — Authenticated password change.** New `POST /auth/change-password` requires the current password, validates the new one, refuses no-op (same as current), bumps `token_version`, and returns a fresh JWT. Frontend helper `changePassword()` added to `services/api.ts`.
- **A4 — JWT versioning + revocation.** `User.token_version` column added (with idempotent migration). `create_access_token` encodes `tv`; `get_current_user` rejects tokens whose `tv` is below the user's current version. Bumped on logout, password change, and password reset (both flows). `POST /auth/logout` added; frontend `handleSignOut` now calls it best-effort. Old tokens issued before this rollout (no `tv` claim) keep validating against the default 0 until the user's next logout/password event.
- **A5 — Frontend test scaffold.** Added Jest config + `jest-expo` preset to `package.json`, wired up `npm test` and `npm run typecheck` scripts, and seeded two pure-function smoke test files (`src/utils/__tests__/subscription.test.ts`, `src/constants/__tests__/legal.test.ts`). Run `npm install` once to pull in the dev deps; `npm test` after.
- **A6 — Backend startup gating + timing.** Heavy backfills and seed inserts in `create_db_and_tables` are now wrapped behind two env flags: `STARTUP_BACKFILLS_ENABLED` and `STARTUP_SEEDS_ENABLED` (both default to `1`). Each entry logs a `[migration] X took Yms` line when it exceeds 250ms, so slow migrations are visible in container logs without extra tooling.
- **B1 — Tighter Info.plist usage descriptions.** `NSCameraUsageDescription`, `NSFaceIDUsageDescription`, `NSMicrophoneUsageDescription`, and `NSPhotoLibraryUsageDescription` rewritten in both `app.json` (so Expo regenerates correctly on next prebuild) and `ios/Thallo/Info.plist` (raw). Each now explains the specific use case, which App Review expects.
- **B2 — Legal version re-acceptance.** `LEGAL_VERSION` bumped to `2026-04-29.2` to trigger a re-accept on existing accounts. `needsLegalReAcceptance()` helper added to `src/constants/legal.ts`. `POST /auth/accept-legal` endpoint stamps fresh acceptance timestamps + versions on all four sections. Frontend `acceptLegal()` helper added to `services/api.ts`. Legal sections also now include a Third-Party Services entry and an Account Deletion And Retention entry — bumping the version forces existing users to re-accept.
- **B3 — Third-party data sharing disclosure.** New "Third-Party Services" section in `LEGAL_SECTIONS` names OpenAI (meal/coach/scan AI), USDA (food data), and Apple Health (on-device only), and explicitly states that calorie/macro/weight data is not shared.
- **B5 — Hard-delete schedule.** `_purge_expired_soft_deletes` startup task added to `backend/app/main.py`. Runs as a daemon thread; hard-deletes any user with `is_active=False` and `account_deleted_at < now − 30 days`. Window configurable via `ACCOUNT_HARD_DELETE_DAYS`, gate via `ACCOUNT_HARD_DELETE_ENABLED=0`. Retention timeline now documented in the new "Account Deletion And Retention" legal section so users see it on next acceptance.
- **B6 — Tighter rate limits.** `/auth/email-verification/request` lowered from `5/hour` to `3/hour`. `/auth/recovery-question` lowered from `20/hour` to `10/hour`. Reduces account-enumeration and email-bombing surface.
- **B8 — DEV_EMAIL_TOKENS isolation test.** New `backend/tests/test_auth_dev_token_isolation.py` (4 cases) pins the gating logic so dev tokens never leak when the env var is unset, set to `0`, or set to a truthy-but-not-`1` value. Registered in `run_all.py`.
- **B9 — Gear photo EXIF strip.** `pickGearPhoto` in `GearScreen.tsx` now passes `exif: false` to both `launchCameraAsync` and `launchImageLibraryAsync`. Matches the existing `MealEditModal` photo path. Uploaded gear photos no longer carry GPS coordinates or device metadata.

Implemented in the 2026-04-29 feature-gap pass (current session, after launch-readiness pass):

- **D3 — Dietary restrictions in onboarding.** Added an "Allergies & restrictions" section to the foods step in `OnboardingScreen`. 12 canonical category chips (dairy, gluten, nuts, peanuts, shellfish, fish, eggs, soy, sesame, pork, beef, alcohol) tap-to-toggle, stored in new `allergies` state and passed through to `UserProfile.allergies` (which the meal planner already reads — wiring was complete on the backend, just no collection UI). Placed above the photo scan so users see it before picking foods.
- **D5 — Live Activity permission education.** `ActiveWorkoutScreen` mount-time permission check now branches: when `ensureWorkoutNotificationPermission()` returns false (denied OR system-suppressed because they previously denied), shows a one-time alert explaining that the rest-timer Live Activity won't appear on the Lock Screen / Dynamic Island and offers an "Open Settings" CTA. Dismissal is persisted in AsyncStorage (`liveActivityNotifAlertDismissed_v1`) so the alert never repeats.
- **D15 — Block / Report UX.** Long-press on a friend row now opens an action sheet with Remove / Block / Report. Block path uses the existing `POST /social/friends/:id/block` endpoint (was on the backend, never surfaced). Report path is new end-to-end: `UserReport` model + `_ensure_user_reports_table` migration + `POST /social/report-user` endpoint (5 reasons: spam, harassment, impersonation, inappropriate content, other; reports stored at `status='open'` for human moderation, no auto-action). Frontend `reportUser()` API helper added. Self-reports rejected. Required by App Review for any social surface.

Implemented earlier in this session (gear, watch, goal-change pass):

- **Mid-week goal change** now shows clear UX warning that the current week's workouts and nutrition stay unchanged, with the new goal applying next week.
- **PlanWeek schema** now snapshots `goal_pace` and `session_minutes` at week creation so weekly review evaluates against the goal the week was actually built for, not whatever `UserGoal` is active at review time.
- **`auto_renew_week`** captures the expiring week's goal before abandonment and passes it to `compute_weekly_review` as `goal_override`. Explanation message now calls out goal changes between weeks.
- **Apple Watch workout sync diagnostics** rebuilt: `HeartRateStore.saveDiag` is now a 12-entry ring buffer with timestamps; `absorbContext` logs every received key set and now surfaces the previously silent `JSONSerialization.data == nil` failure path; ContentView empty state shows the last 5 diag lines on the wrist.
- **`pushWorkoutToWatch`** logs payload byte size + exercise count so oversized merged contexts are visible.
- **Gear screen** expanded from 9 to 21 types — added lifting shoes, lifting belt, knee sleeves, wrist wraps, lifting straps, chest strap, yoga mat, climbing shoes, resistance bands, foam roller, massage gun, boxing gloves. All session-tracked (null mile threshold).
- **Gear photos** now offer Camera or Library (Camera permission already in Info.plist).
- **AI gear identification** prompt updated to handle session-only items and emit null thresholds where mileage doesn't apply.
- **Gear recommendation copy** for session-only items reads "25 sessions logged" instead of "0 mi logged across 25 sessions."
- **Body measurements** removed from the Goal/Edit Profile screen (was duplicated). Lives only in Progress now.
- **Change focus** now persists to `PlanDay` rows — frontend reads back via `getActivePlanWeek` so the schedule reflects the swap immediately.
- **Day card focus chips** filter against `CHIP_ALLOWED_MUSCLES` so a Pull day no longer shows Chest, etc. `lats` and `rear_delt` added to Pull allowlist.
- **Upper/Push/Pull adjacency warning** added in `change_day_type.detect_conflicts` — flags Upper next to Push/Pull (overlap warning) but deliberately excludes Push↔Pull (standard PPL design).

Deferred by owner decision:

- StoreKit, RevenueCat, restore purchases, billing management, entitlement verification, and production subscription gating.

## What I Confirmed In The Codebase

- Backend `User` already has `first_name` and `last_name`. Signup flow now uses them.
- Workout planner is fully deterministic per `CLAUDE.md`. AI plan review is permanently disabled (`PLAN_REVIEW_ENABLED=0` is a no-op).
- The subscription helper now defaults missing tiers to Free, but Pro is still a client/dev-tier simulation until StoreKit or RevenueCat and server-side entitlements are wired.
- `HomeScreen.tsx` is ~12k lines with 121 `useState` calls. `ActiveWorkoutScreen.tsx` is ~6k lines with 17 active `setInterval` instances.
- Watch and Live Activity code exists. Recent diagnostic improvements should make next-build sync issues visible without Console.app.
- `docs/DEPLOYMENT.md` already notes that a public App Store release needs a privacy policy URL.

## Non-Negotiable Guardrails

Keep these intact while implementing recommendations:

- Workout planning remains deterministic. No AI exercise selection, split generation, or weekly recipe generation.
- The active PlanWeek and its seven PlanDay rows remain the source of truth. AsyncStorage is a hot cache only.
- PlanWeeks stay fixed for seven days. No mid-week regeneration.
- AI actions can update preferences, coaching state, or day state through apply-action paths, but cannot directly mutate the active PlanWeek.
- Nutrition scoring remains server-authoritative through `/meals/score`.
- Cache clearing must stay scoped through plan-cache helpers.
- Social features must never expose calories, macros, weight, or nutrition details.
- Recovery/mobility days must preserve negative fatigue behavior.

---

# Detailed Audit Findings (2026-04-29)

The sections below are concrete punch-list items found by sweeping the codebase. Each item cites a file path or line where the fix should land.

## A. Critical / Launch-Blocking

| # | Issue | Location | Fix |
|---|---|---|---|
| A1 | Placeholder production API URL | `src/services/api.ts:20` (`https://your-production-api.com`) | Confirm EAS env / `app.json.extra.apiBaseUrl` resolves to real endpoint in production builds; add a runtime guard that throws on the placeholder string. |
| A2 | Subscription tier defaults to Pro | `src/utils/subscription.ts` (`tierOf` returns `?? 'pro'`) | Default to `'free'`. Backend must explicitly populate the field. |
| A3 | No authenticated password-change endpoint | `backend/app/routers/auth.py` | Add `POST /auth/change-password` that requires current password, rotates password without invalidating session. |
| A4 | JWT 7-day lifetime, no revocation | `backend/app/auth.py` (`ACCESS_TOKEN_EXPIRE_MINUTES = 10080`) | Add token versioning column on `User` (`token_version`). Bump on logout/password-change. Verify in `get_current_user`. |
| A5 | Frontend has zero test files | `find src -name '*.test.*'` returns nothing | At minimum, add Jest + React Native Testing Library scaffolding and one smoke test for `HomeScreen` mounting. |
| A6 | Backend startup runs 41 migrations + 4 backfills + OpenAI calls sequentially | `backend/app/database.py:create_db_and_tables` and `app/main.py:_startup_enrich_food_micros` | Gate non-essential backfills behind a `--migrate` flag or daily cron. Hot restarts are slow today. |

## B. Legal, Privacy, Auth & Account

| # | Issue | Location | Fix |
|---|---|---|---|
| B1 | Weak Info.plist usage descriptions | `ios/Thallo/Info.plist` — `NSFaceIDUsageDescription`, `NSMicrophoneUsageDescription`, `NSPhotoLibraryUsageDescription` are generic ("Allow $(PRODUCT_NAME) to use Face ID") | Rewrite each to explain specific use (Face ID for fast app sign-in, microphone for speech-to-meal entry, photo library for gear photos and meal scans). App Review flags generic copy. |
| B2 | Legal versions hardcoded, not enforced post-signup | `src/constants/legal.ts:1`, `backend/app/routers/auth.py:18` both `2026-04-29` | When a version bumps, add a "re-accept terms" flow on next launch. Keep an audit trail of every accepted version per user. |
| B3 | No third-party data sharing disclosure in legal copy | `src/constants/legal.ts` | Mention OpenAI (meals/coach/scans), USDA (food data), Apple Health (on-device only). |
| B4 | Legal copy is "launch-ready product copy, not attorney-reviewed" | `src/components/LegalDisclosureModal.tsx:36` | Have counsel review before paid launch. Link to attorney-reviewed copy on website. |
| B5 | Soft-delete has no hard-delete schedule | `backend/app/routers/profile.py` deletion | Add a scheduled job or daily cron that hard-deletes accounts soft-deleted >30 days. Document retention to users. |
| B6 | Email-verification rate limit too loose | `backend/app/limiter.py` (`5/hour` for verification request) | Tighten to `3/hour` per user/IP. Same for `/auth/recovery-question` lookup. |
| B7 | COPPA/GDPR-K age gate is self-reported only | `src/utils/age.ts:46` | Acceptable for soft launch. For EU/UK distribution add explicit parental-consent flow for 13–16. |
| B8 | DEV_EMAIL_TOKENS path leaks tokens in JSON | `backend/app/routers/auth.py:252,416` | Confirm env check is airtight; add tests that ensure tokens are NOT in response when `DEV_EMAIL_TOKENS` unset. |
| B9 | EXIF stripping verified ✓ | `src/components/MealEditModal.tsx` (`exif: false` on pick + camera) | Already correct — no action. Apply same flag to gear photos (`src/screens/GearScreen.tsx:pickGearPhoto`). |
| B10 | No support contact endpoint or email destination wired | Settings exposes a contact link but where does it go? | Set up a real `support@thallo.app` mailbox and link it from settings. |

## C. Performance Hotspots

| # | Issue | Location | Fix |
|---|---|---|---|
| C1 | ActiveWorkoutScreen has 17 setInterval instances | `src/screens/ActiveWorkoutScreen.tsx:758-1471` (HK polling + rest timer + sync debounce) | Consolidate timers behind a single `useTimer` hook. Track owner refs explicitly. Comment at line 1207–1223 admits the intervals "pause when JS suspends" with timestamp fallback parallel logic. |
| C2 | HomeScreen has 121 useState calls and is not memoized | `src/screens/HomeScreen.tsx` | Group state by domain (workout / meals / settings / social) into reducers or context providers. Wrap heavy children in `React.memo`. |
| C3 | Backend startup re-seeds equipment/exercises/foods on every hot restart | `backend/app/database.py:1164-1169` | Idempotent already, but adds 5–15s to every container restart. Skip if marker row exists. |
| C4 | OpenAI call in startup background thread | `backend/app/main.py:_startup_enrich_food_micros:134-210` | Move to a daily cron. Currently runs unbounded re-enrichment on every boot. |
| C5 | N+1 queries on workout-detail fetch | `backend/app/routers/workouts.py:2406` (loop + `db.exec(select(ExerciseSet)…)` per exercise) | Single `IN` query then group by exercise id. ✓ Done — `_build_session_responses_batch` collapses list/detail to 3 queries; `progression_insights` collapses nested loop to 2; `delete_workout` uses bulk DELETE WHERE id IN(...). |
| C6 | N+1 in social digest builder | `backend/app/services/social/digest.py:92-104` | ✓ Already batched (verified — uses `.in_(friend_ids)` for profiles, users, goals, completions). Doc was stale. |
| C7 | N+1 in meal item fetch | `backend/app/routers/meals.py:743` (per-meal MealItem query) | ✓ Mostly batched (`day_summary` uses `.in_(meal_ids)`); only remaining per-row pattern is `delete_meal` cascade which is single-meal so not a true N+1. |
| C8 | Long lists rendered via `.map()` inside ScrollView | `HomeScreen.tsx:5873` workout schedule, `HomeScreen.tsx:6278-6314` muscle library (~240 nodes) | Convert to `FlatList`/`SectionList`. Especially the muscle library. |
| C9 | 6 screens import `expo-image-picker` eagerly | ActiveWorkoutScreen, HomeScreen, ProgressScreen, OnboardingScreen, GearScreen, EditProfileScreen | ✓ Done — replaced eager `import * as ImagePicker` in the 5 remaining screens with a Proxy-backed lazy reference; the underlying `require()` only runs on first property access (consumers are all async). GearScreen already used `await import()`. |
| C10 | base64-encoded photo strings persisted in component state and AsyncStorage | `src/screens/GearScreen.tsx`, `OnboardingScreen.tsx:638` | Validate < 2 MB before encoding. Consider writing to FS and storing path. |
| C11 | bodyScanHistory loaded fully into memory | `src/screens/ProgressScreen.tsx:328` | ✓ Done — initial AsyncStorage + remote merge both `.slice(0, 20)` before `setBodyScanHistory`. Older entries stay persisted; only the recent slice lives in JS heap (each entry carries a base64 image). |
| C12 | exerciseImages cached as one giant JSON value | `src/utils/exerciseImages.ts` | Use SQLite or per-exercise keys to avoid full-blob reads. |
| C13 | Logo embedded as 6KB+ base64 string | `src/utils/logoBase64.ts` | Use a `.png` asset and `<Image>` component. |
| C14 | 375 `as any` + 24 `eslint-disable` markers | Across `src/` (worst: ActiveWorkoutScreen lines 411, 602, 795–802, 1367+) | Set a baseline budget. Drive count down 10/sprint. |
| C15 | 6 `@deprecated` fields still present in `src/types/index.ts` | `primaryGoal`, `targetFocus`, `secondaryGoal`, `focusedMuscleGroup` | Migration is incomplete. Either complete the rename or remove the deprecation tags. |
| C16 | HomeScreen mount-time effects fire many parallel API calls | `src/screens/HomeScreen.tsx` | Audit which can be deferred until first interaction. Add a lightweight skeleton paint that doesn't wait on every fetch. |
| C17 | Backend test baseline is 8 known failures | `backend/tests/run_all.py` | Track each failure in an issue. Don't let baseline grow. |

## D. Feature Gaps

| # | Issue | Location | Fix |
|---|---|---|---|
| D1 | No notification preference UI | `workoutReminders.ts` and `mealReminders.ts` exist but no settings surface | Add Settings → Notifications with workout/meal reminder toggles, time pickers, quiet hours. |
| D2 | No unit preferences | OnboardingScreen hardcodes lbs/feet-inches; distance is hardcoded miles app-wide | Add `weightUnit` and `distanceUnit` to `UserProfile`. Drive display formatters off them. EU users will need this. |
| D3 | No dietary restriction collection in onboarding | `OnboardingScreen.tsx` skips this entirely; `UserProfile.allergies` exists but is never populated | Add an allergy/restriction step. Wire into nutrition planner so meal suggestions filter. |
| D4 | Onboarding can't resume after abandonment | `OnboardingScreen.tsx` keeps state in memory only | Persist partial progress to AsyncStorage. Show progress indicator. Offer "continue where you left off" on re-open. |
| D5 | Live Activity silently fails when notification perms denied | `src/services/liveActivity.ts:72-74` checks but doesn't surface | Show an inline tip during workout start: "Enable notifications to see rest timer on Lock Screen." |
| D6 | No mid-workout exercise swap | Swap-scoring logic exists (`swapScoring.ts`); only pre-workout swap is wired | Expose swap from active workout (long-press on exercise card → swap with same-muscle alternative). |
| D7 | No plan pause/resume for travel | Skip-day exists; pause-week doesn't | Add a "pause plan" flag on PlanWeek that suspends auto-renew and stops generating reminders. |
| D8 | Coach chat has no transcript history | `CoachCheckinModal.tsx` doesn't persist a log | Add a `CoachMessage` table; show recent messages. |
| D9 | Apply-action has no undo | Coach actions mutate `UserPreferences` / `UserCoachingState` directly | Add a 30-second undo banner after each apply-action. |
| D10 | No body-scan comparison view | `ProgressScreen` shows scans but no side-by-side or trend graph | Add scan timeline + before/after comparison. |
| D11 | Body fat % and muscle mass have no timeline | Only weight has a chart | Add lightweight charts for body comp metrics. |
| D12 | Barcode scan "Product not found" has no fallback | `MealEditModal.tsx:714` | Offer "Search by name" fallback or "Add to USDA submission queue." |
| D13 | Saved meals not exposed as one-tap repeat from recents | `SavedMealsSection.tsx` | After logging a meal, prompt "Save as favorite?" Then expose saved meals as a horizontal scroll above the meal entry. |
| D14 | No friend invite link / friend-code generation | `FriendsModal.tsx` only supports username search | Add deep-link invites with reusable per-user codes. |
| D15 | No block/report UX | FriendsModal has remove-via-pending only | Add explicit Block + Report flows. App Review will ask. |
| D16 | Watch complications and Siri Shortcuts disabled | `targets/thallo-watch-complication/` and `expo-target.config.js.disabled` | Defer until post-launch. Document the Xcode wiring needed. |
| D17 | TODO: pass watch-selected activity through to LiveActivityTracker | `HomeScreen.tsx:2464` | Wire the watch-selected category/subtype into the activity picker so the user doesn't have to re-pick. |
| D18 | TODO: persist protein preference once UserCoachingState supports it | `backend/app/services/nutrition/weekly_review.py:402` | Add `preferred_protein_g` to `UserCoachingState`. |
| D19 | TODO: wire DayState.session_rpe_avg | `ProgressScreen.tsx:547` | Plumb the field through; surface RPE trend. |
| D20 | Per-session gear picker | Gear auto-tracks via keyword matching, but two pairs of running shoes both match "run" → double-counting | Add an optional "which gear did you use?" prompt on session save. Default to keyword match. |

## E. UX Rough Edges

| # | Issue | Location | Fix |
|---|---|---|---|
| E1 | No dedicated Settings screen | Settings/preferences are spread across edit-profile + account modal | Create a single Settings hub. |
| E2 | Empty states are bare | First-run, no workouts, no meals, no friends, no measurements | Add contextual hints ("Save a meal as favorite for one-tap repeat next time"). |
| E3 | Error states are silent | HomeScreen falls back to cache on network failure with no banner | Show a small "offline" pill when cached data is in use. |
| E4 | Active-workout force-quit recovery is implicit | `ActiveWorkoutScreen` saves on background; resume banner exists in HomeScreen but is not always offered | Make the resume banner more visible after force quit. |
| E5 | Readiness pillar weights shown but not explained | `TrainingReadinessCard.tsx:401-402` | Add tap-to-expand explainer per pillar. |
| E6 | No dismiss-low-readiness UX | Readiness suggestions are persistent | Allow "Got it, hide for today." |
| E7 | Coach apply-action has no "are you sure?" for big changes | E.g. calorie ±200 | Add confirmation for changes >X% from current. |
| E8 | Onboarding HealthKit pre-permission education absent | OnboardingScreen jumps straight to Apple's permission sheet | Show 1 screen explaining what HK reads/writes and why. |
| E9 | Equipment selection is optional but app behavior assumes some | OnboardingScreen lets users skip | If skipped, default to bodyweight equipment so planner doesn't return empty days. |
| E10 | Onboarding weight ranges loose | `validate()` in OnboardingScreen accepts edge values | Add inline validation hints. |

## F. Accessibility & Localization

| # | Issue | Location | Fix |
|---|---|---|---|
| F1 | Only ~10 `accessibilityLabel` props in entire codebase | Spot-checked | Sweep all icon-only buttons, color-coded chips, score chips. |
| F2 | No Dynamic Type support | Hardcoded font sizes | Use `PixelRatio.getFontScale()` or scale-aware fonts. |
| F3 | Color-coded readiness/score chips have no text fallback | `TrainingReadinessCard`, gear mileage bars | Pair color with a label. VoiceOver-only users currently can't tell tier. |
| F4 | Zero i18n setup | All strings hardcoded English | Defer until after launch. Bake string-extraction into the next refactor pass. |

## G. Watch & Live Activity (post-diagnostic-fix follow-ups)

| # | Issue | Location | Fix |
|---|---|---|---|
| G1 | Watch sync diagnostics now visible — collect real data | New ring buffer in `HeartRateStore` | After next signed build, capture diag entries from a real device to determine which silent-failure path is actually firing. |
| G2 | Add visible sync status to phone | Settings already shows a Watch sync status row | Make it more prominent — surface in HomeScreen when last sync >5 min stale. |
| G3 | Add manual "sync now" button | `pull_state` exists from watch; add reverse button on phone | Single tap pushes the full snapshot. |
| G4 | Watch session token isn't versioned with userId | Watch caches a userId; cross-account leak protection exists but there's no force-clear if userId changes via a different mechanism | Already protected via `handleUserSwitch` in `ConnectivityStore`. Verify in QA. |

## H. Operations & Observability

| # | Issue | Location | Fix |
|---|---|---|---|
| H1 | No crash reporter | `package.json` has no Sentry/Bugsnag | Add Sentry. Gate behind a "Help us improve" toggle. |
| H2 | No analytics platform | None integrated | PostHog or Amplitude. Privacy-first config, opt-out toggle. |
| H3 | No AI cost tracking | `gear.py`, `coach`, `meal_parsing` all hit OpenAI | Add a simple per-user counter on `User` (`ai_calls_today`) so cost overruns surface. |
| H4 | No watch command success/failure metric | Watch issues commands; phone receives but no metric | Once Sentry/PostHog is in, fire an event per command kind. |
| H5 | No HealthKit permission/sync metric | Permission grants/denials are invisible to the team | Track `hk_permission_granted=true/false` as a property. |
| H6 | Observed migration cost on startup | `database.py` | Add timing logs: `[migration] _ensure_X took 250ms`. Helps spot regressions. |

## I. Build, Tests & CI

| # | Issue | Fix |
|---|---|---|
| I1 | No CI pipeline visible | Add GitHub Actions: typecheck + backend tests on PR. |
| I2 | `npx tsc --noEmit` likely has a baseline | Document it. Don't let it grow. |
| I3 | Backend test count: 8 known failures | Each should be a tracked issue with owner. |
| I4 | Frontend has no test framework | Add Jest + RNTL with a minimum smoke test. |
| I5 | Native module changes not always reflected in Xcode project | Document pre-build verification step in `docs/DEPLOYMENT.md`. |

---

# Existing Sections (Preserved)

## P0: Trust, Legal, And Account Basics

These remain valid even with the audit additions above.

| Recommendation | Why it matters | Concrete next step |
|---|---|---|
| Add Terms of Service acceptance on signup | Needed for a serious public app and paid product | ✓ Done — verify version-bump re-accept flow (B2) |
| Add Privacy Policy acceptance on signup | App handles health, nutrition, weight, photos, and account data | ✓ Done — add third-party disclosure (B3) |
| Add a health and fitness disclaimer | The app gives training, nutrition, recovery, and supplement guidance | ✓ Done — counsel review pending (B4) |
| Add an AI disclosure/disclaimer | Users should understand where AI is used and where it is not | ✓ Done — counsel review pending |
| Add first name and last name to signup | Backend model already supports it; personalization improves UX | ✓ Done |
| Add email verification | Reduces fake accounts, support issues, and password-reset risk | Endpoints scaffolded; email provider not wired |
| Replace security-question reset | Security questions are easy to guess and hard to support | Endpoint scaffolded; provider not wired |
| Align password validation | Current client copy is weaker than backend policy | ✓ Done |
| Add account deletion | Public apps need a user-visible way to leave | ✓ Done — add hard-delete schedule (B5) |
| Add full account data export | Workout-only export is not enough for account/data rights | ✓ Done |
| Add support contact | Users need help with billing, HealthKit, Watch sync, and data concerns | UI added; verify destination email exists (B10) |
| Add Terms/Privacy links in settings | Users must be able to review what they accepted | ✓ Done |
| Add billing management and restore purchases | Required for real subscriptions | Deferred (StoreKit/RevenueCat work) |

## P0: Monetization And Entitlements

Required before charging:

- Integrate StoreKit 2 or RevenueCat.
- Verify entitlements server-side.
- **Default unknown or missing entitlement to Free, not Pro** (A2 above — top priority).
- Remove or hide the developer tier toggle from production builds.
- Add restore purchases.
- Handle expiration, cancellation, billing retry, grace period, refunds, and entitlement lookup failures.
- Add paywall analytics for impressions, starts, purchases, restores, cancellations, and failures.
- Audit all Pro gates against the pricing and marketing promise.

## P0: Native Reliability

The Watch and Live Activity work is valuable, but only if a signed build proves the native modules are actually included and reliable.

Run this checklist on real iPhone plus Apple Watch hardware:

- Fresh install from TestFlight or a production-profile local build.
- First phone-to-watch sync after opening Thallo on the phone.
- Watch-to-phone `pull_state` after app launch.
- Start workout on phone, see active workout on Watch.
- Start workout on Watch, see active workout on phone.
- Log set, skip set, cancel workout, and end workout from Watch.
- Background phone, lock phone, lock Watch, then verify queued delivery recovers.
- Start rest timer and verify Live Activity appears on Lock Screen/Dynamic Island.
- Update rest timer, next exercise, next set, and end Live Activity.
- Verify local rest timer notifications with permissions granted and denied.
- Verify HealthKit permission denied, partial, and granted states.
- Verify completed workout writes once to Apple Health and does not duplicate.
- **NEW**: After signed build, capture `HeartRateStore.recentDiag` output to confirm which workout-sync path is firing (G1 above).

## P0: Observability

See section H above for the full punch list. Track these launch metrics first:

- Signup started to onboarding complete.
- Onboarding complete to first PlanWeek active.
- First workout started to completed.
- First meal logged.
- Watch connected and first Watch workout action.
- HealthKit permission granted.
- Live Activity start success.
- Seven-day retention.

## P1: Performance Recommendations

Originally listed:

| Recommendation | Status |
|---|---|
| Split `HomeScreen.tsx` | Pending — see C2 |
| Split `ActiveWorkoutScreen.tsx` | Pending — see C1 |
| Lazy-load heavy tabs/modals | Partial — see C9 |
| Virtualize long lists | Pending — see C8 |
| Reduce startup network fanout | Pending — see C16 |
| Cache exercise and food media aggressively | Pending — see C12 |
| Throttle HealthKit refresh | Pending |
| Isolate timer state | Pending — see C1 |
| Add performance marks | Pending |
| Add offline queues for critical actions | Pending |

## P1: Feature Recommendations

Originally listed (most still valid):

| Recommendation | Status |
|---|---|
| Add device sync status screen | Partial (Account row); make prominent (G2) |
| Add workout recovery/resume banner | Partial (E4) |
| Improve onboarding save/resume | Pending — see D4 |
| Add pre-permission HealthKit education | Pending — see E8 |
| Add notification preferences | Pending — see D1 |
| Add legal/settings section | ✓ Done |
| Add saved meal shortcuts | Pending — see D13 |
| Improve grocery list check-off | Pending |
| Add readiness explanations | Pending — see E5 |
| Add coach action history | Pending — see D8, D9 |
| Add weekly recap | Pending |
| Add referral or invite later | Pending — see D14 |

## P1: Copy And Positioning Fixes

Recommended public promise:

> Thallo turns your goal into a clear training week, guides workouts on your phone or Apple Watch, and keeps meals, recovery, and progress in one place.

Avoid:

- "AI builds your workouts."
- "AI workout plans."
- "Medical-grade readiness."
- "Diagnoses sleep, hormones, recovery, or nutrition."
- "Fully automatic Apple Watch tracking" until import/reconciliation is built and validated.
- "Paid Pro" messaging before StoreKit/RevenueCat and server entitlements exist.

Safer wording:

- "Personalized training plans."
- "AI-assisted meal planning and coaching."
- "Readiness insights based on your logged and connected data."
- "Apple Watch companion for workout guidance and logging."

## P2: Growth And Differentiation

Good later bets after reliability, account/legal, observability, and entitlement work:

- Weekly progress recap.
- Streaks and achievements.
- Friend accountability through private workout-only digests.
- Adaptive reminder timing.
- Coach explanations for missed workouts or high-fatigue weeks.
- Exercise library improvements and cached media.
- Meal-prep planning that builds on grocery list.
- Smart saved meals and routine meals.
- In-app education for progressive overload, recovery, protein, fiber, and hydration.

## Defer For Now

Do not prioritize these before the P0/P1 work above:

- Siri shortcuts.
- Apple Watch complications.
- Public social feeds.
- Comments, likes, reactions, and friend leagues.
- Automatic Apple Watch workout import/reconciliation (note: classify-from-HK already exists; this would be deeper auto-import).
- Pantry tracking.
- Restaurant ordering suggestions.
- Wearable integrations beyond Apple Health.
- Advanced coach memory beyond the existing coaching state model.
- i18n / localization (F4).
- Major redesigns that do not improve activation, workout completion, meal logging, retention, or reliability.

## Practical 30-Day Plan

1. Fix A1 (production API URL guard) and A2 (subscription default to Free). One-day work.
2. Build and install a fresh signed iOS/TestFlight build; verify Watch sync and Live Activity behavior. Capture diag entries (G1).
3. Tighten Info.plist usage descriptions (B1).
4. Add password-change endpoint (A3) and JWT versioning for revocation (A4).
5. Wire an email provider so verification + password reset actually deliver.
6. Add Sentry (H1). One PR.
7. Add a Settings hub with notification preferences and unit preferences (D1, D2, E1).
8. Add onboarding resume + dietary restrictions step (D3, D4).
9. Keep beta access free/full-feature via `freeBetaFullAccess`; choose StoreKit 2 or RevenueCat only when moving toward paid testing.
10. Run a 10–20 person TestFlight with a written QA checklist that includes the Watch native checklist above.

## Practical 60-Day Plan

1. Tighten Watch command delivery, queueing, and sync status (G2, G3, H4).
2. Improve meal logging speed with saved meals, repeat meal shortcuts, and better grocery check-off (D13).
3. Add HealthKit pre-permission education (E8).
4. Add paywall analytics and trial/annual pricing experiments only after entitlements are real.
5. Add weekly recap and readiness explanations (E5).
6. Begin the HomeScreen / ActiveWorkoutScreen split (C1, C2).
7. Use retention and completion data to choose the next feature, not hunches.

## Launch Gate

Thallo is ready for a small closed beta when:

- Onboarding reliably creates a valid PlanWeek.
- A user can complete at least one workout from phone and one from Watch.
- Watch sync recovers from app backgrounding and lock state (G1 confirms via diag).
- Live Activity rest timer works on a signed build.
- HealthKit denied, partial, and granted states all work.
- Meal logging and scoring work after app relaunch.
- Local notifications work or fail gracefully.
- Crash/error reporting is enabled.
- The team can see activation, retention, Watch sync, and meal logging metrics.

Thallo is ready to charge when:

- The beta gate is passing.
- Terms, Privacy Policy, health disclaimer, and support flows are in place.
- Account deletion and full account export exist with a documented retention timeline (B5).
- StoreKit/RevenueCat is integrated.
- Backend entitlement checks exist.
- Restore purchases works.
- **Missing entitlement defaults to Free** (A2).
- Paywall analytics are live.
- Billing, cancellation, and privacy copy is clear.
- Password change + session revocation exist (A3, A4).
- Counsel-reviewed legal copy is live (B4).

## Bottom Line

The strongest next move is not more features. It is making the current product trustworthy: signed-build native reliability, legal/account basics, production subscriptions, observability, and performance cleanup. Once those are stable, the best product bets are faster nutrition logging, clearer Watch sync, readiness explanations, weekly recaps, and carefully scoped social accountability.

The 2026-04-29 deep audit surfaced two true launch blockers (placeholder API URL and Pro-default subscription tier) plus a rich but tractable list of P1 work organized in sections A–I above.
