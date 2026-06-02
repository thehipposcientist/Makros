# Thallo Recommendations

Last updated: 2026-05-18 (current app-state, privacy, hydration/weather recommendation refresh)
Audience: product, engineering, launch planning

This is the running launch-readiness list for Thallo. The doc was originally written after a high-level review. The 2026-04-29 refresh adds findings from a deep audit covering legal/auth/privacy, performance/code quality, and feature/UX gaps, plus marks items completed in the current session.
The 2026-05-12 refresh updates current screen-size/timer facts and adds a prioritized recommendation stack for performance, UI polish, and feature work.
The 2026-05-18 refresh reconciles the docs with the current app state: Settings now exists as its own screen, location is already used for outdoor cardio route/distance/pace, hydration targets are server-authoritative and adaptive, subscription defaults moved to a 7-day server trial plus RevenueCat entitlement sync, and the remaining location opportunity is optional coarse weather context for hydration/recovery.

The short version remains the same: Thallo has a real product foundation. The next work should not be a broad feature push. It should be a launch-readiness pass — legal/account basics, signed-build native reliability, production entitlements, observability, and performance cleanup around the biggest screens.

Billing decision as of 2026-05-18: production defaults are `expo.extra.freeBetaFullAccess=false`, `BETA_FULL_ACCESS_ENABLED=0`, and `SIGNUP_TRIAL_DAYS=7`. RevenueCat is the planned store/payment layer; beta full access is now an explicit override only.

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
8. Keep the beta free/full-access only through explicit client + backend beta flags; replace the beta access override with real StoreKit 2 or RevenueCat entitlements before charging.
9. Add crash reporting, analytics, native bridge logging, Watch sync metrics, and AI cost/error tracking.
10. Split and lazy-load the largest screens, especially `HomeScreen`, `ActiveWorkoutScreen`, and `ProgressScreen`.
11. Consolidate ActiveWorkoutScreen timer ownership — current code has 4 `setInterval` references and 27 `setTimeout` references across workout sync, rest timing, autosave, modal handoffs, and deferred queues.
12. Run `npm install` to pull in the new test dev deps (jest, jest-expo, @testing-library/react-native), then run `npm test` to verify the smoke suite passes (A5 scaffolded).

## Current State Snapshot (2026-05-18)

- **Outdoor cardio location is shipped.** The phone-side `cardioGpsTracker` and Watch `HeartRateStore` use location only for outdoor cardio sessions (run/walk/ride/hike) to capture distance, pace, route coordinates, and altitude/elevation when available. Indoor cardio avoids GPS and uses manual or device distance.
- **Hydration is adaptive but not weather-fed yet.** `/meals/hydration` and `/meals/adjusted-daily-target` use body size/sex/age, planned or completed workout demand, active energy, protein, alcohol, sodium, and supplement context. The hydration pure function already has a heat add-on, but current callers do not pass ambient temperature, humidity, or altitude.
- **Location privacy docs needed correction.** App Store/privacy docs previously said location was not found; that is stale. Current location collection is workout-scoped and should be labeled as Fitness/Location data, not tracking.
- **Largest screen facts changed.** `HomeScreen.tsx` is ~20.8k lines with 164 `useState` occurrences, `ActiveWorkoutScreen.tsx` is ~13.3k lines, and `ProgressScreen.tsx` is ~13.1k lines.

## Recommendation Stack (2026-05-18)

These are the best next bets after the latest code/doc pass. Ordered by user impact divided by implementation risk.

### Performance

1. **Split `HomeScreen.tsx` by top-level route surface before adding more features.** It is now ~20.8k lines with 164 `useState` occurrences. Extract Friends, Meals, Workout Plan, You/Settings, trainer chat, saved meals, imports, GPS/custom tracker handoff, and library/detail modal domains into focused containers with their own hooks. Keep `HomeScreen` as route orchestration only. This is the highest-leverage client performance and maintainability move.
2. **Turn Progress history views into virtualized lists.** `ProgressScreen.tsx` is ~13.1k lines and still relies heavily on mapped rows inside `ScrollView`. Convert chronological workout history, PR lists, imported activity history, body-scan history, health-insight lists, and plateau lists to `FlatList` / `SectionList` so large imported histories do not render hundreds of nodes at once.
3. **Create one owned timer layer for Active Workout.** Keep the timestamp-based rest timer, but move polling, autosave flush, watch sync debounce, sidecar queue drains, GPS lifecycle cleanup, and modal-handoff timers into a small `useWorkoutTimers` / `useWorkoutSideEffects` module with explicit cleanup. Add a regression test or dev assertion that no timer remains after unmount.
4. **Defer cold-start network fanout on Home.** Paint the active PlanWeek, today meals, and resume-workout state first; lazy-load social counts, supplement library, imports history, trainer context, and deep progress analytics after first interaction or idle time.
5. **Add route-level performance marks before refactors.** Log client-side first paint / plan paint / workout-start-ready timing and backend `time.perf_counter()` for `/plans/week/active`, `/meals/score`, `/workouts/weekly-review`, `/imports/*/status`, and `/ai/*`. This makes the split work measurable instead of vibes-based.

### UI / UX

1. **Finish making Settings the real hub.** `SettingsScreen` now exists and covers notifications, units, HealthKit, app settings, and account actions. The remaining polish is navigation consistency: route Import, Data & Privacy, Watch/Health status, Gear, Theme, Legal, and Account from the same stable Settings surface instead of leaving duplicate controls in You/Home modals.
2. **Surface pending imports as an activation banner.** `pending_imports` exists and ImportScreen is shipped. Add a Home/You banner plus 3-day and 7-day reminders for users who said they are coming from MFP, Strong, or Strava but have not uploaded/connected yet.
3. **Use captured effort signals in the live workout UI.** Show an estimated 1RM chip and a deterministic next-set note after logged sets: RIR 0-1 means hold load; RIR 3+ suggests a small increase when readiness and target reps allow. No AI needed.
4. **Make readiness and plateau cards actionable.** Plateau detection and weekly recommendations exist; avoid "Got it" dead ends. Route deload/swap/volume suggestions into the existing check-in apply flow with confirmation and undo.
5. **Add explicit offline/cache states.** Home falls back to cached plan/meal state when backend is unreachable. Show a small, non-blocking offline/cache pill so users know they are viewing cached data and can trust what happened.
6. **Do an accessibility sweep before beta expansion.** Add labels to icon-only buttons, pair color-coded score chips with text labels, and test Dynamic Type for workout logging, meal logging, and Settings. This is also App Review insurance.

### Features

1. **Finish import activation rather than building another import parser.** Manual review for unmatched MFP foods, Home pending-import banner, and import-success recap will convert more switchers than Hevy/Cronometer v1 right now.
2. **Saved meals and routine meal one-tap logging.** Meal logging speed is the most obvious daily retention lever. Promote "save as favorite" after repeated meals, put recent/favorite meals above food search, and preserve server-authoritative `/meals/score`.
3. **Add optional coarse weather context for hydration and recovery.** Do not request continuous GPS for hydration. Add a user-controlled setting like "Use local weather to adjust hydration and recovery targets"; accept city/ZIP or OS approximate location; fetch/store weather facts (`temp_f`, `humidity_pct`, `heat_index_f`, `altitude_m`, `observed_at`, source), not raw coordinates. Use it to activate the existing heat add-on, flag hot/humid outdoor cardio, and tune electrolyte copy. Keep manual fallback choices: hot/humid climate, dry climate, high altitude, mostly indoors. Never expose location/weather context socially, and do not send precise coordinates to AI prompts.
4. **Finish preference propagation.** Settings now has workout/meal/hydration reminders, quiet hours, weight unit, and distance unit. Finish applying those units across every history/chart/share surface, then add the weather/hydration preference described above. This is small product work with high trust value, especially outside the US.
5. **Coach transcript, undo, and action history.** Persist recent coach messages and give applied changes a short undo window. This makes AI-assisted coaching feel accountable while preserving the rule that AI mutates only user-editable state.
6. **Cardio and HR-zone progression.** Strava imports, Apple Health, GPS route capture, and workout `hr_summary` make this cheap now. Add pace/power/Zone 2 trend cards for runners, cyclists, and hybrid users.
7. **Body-scan comparison + soreness overlay.** Body scans and soreness/fatigue already exist. A before/after comparison and a separate "reported sore" layer on the body map would make Progress feel much more alive without changing planner logic.

## New Recommendations (2026-05-10)

Surfaced during the form-demo audit + the wearables/import planning passes. Ordered by leverage-per-effort.

### Form demos / exercise media

1. **Fix the 8 stale `_OVERRIDES` in `demo_resolver.py`.** Eight overrides point at upstream ids that 404 (`Glute_Bridge`, `Pendlay_Row`, `Dumbbell_Bench_Step`, `Dumbbell_Bent_Over_Row`, `Romanian_Deadlift_with_Dumbbells`, `Step_ups_With_Bands`, `Sumo_Squat_With_Dumbbell`, `Thoracic_Rotation`). The sync script silently prunes them so the client gracefully shows no card, but those exercises currently have no demo at all. Fix the override values against the actual manifest, run `./scripts/sync-exercise-demos.sh`, and coverage climbs above the current 53% (174 of 451 seeded exercises). Effort: <2 hours.
2. **Add a coverage-report endpoint or test.** `demo_resolver.py::coverage_report` already exists. Wire it as a backend test or `/admin/coverage` debug endpoint so the next "did we cover the new seed entries" question takes ten seconds instead of a manual script. Effort: <1 hour.
3. **Ship a 6-month seed expansion to push coverage to 70%+.** The remaining 212 unmatched seed exercises are mostly variant grips, kettlebell flows, and bodyweight progressions — many have close-but-not-exact matches in free-exercise-db that token-set fuzzy matching misses. Spending half a day hand-curating overrides for the top 50 missed exercises (by plan frequency) is high-leverage. Effort: 4-6 hours.
4. **Don't migrate to a CDN unless usage justifies it.** Bundling is working. If ipa size becomes a problem (it shouldn't until ~50 MB+ of demos), revisit S3+CloudFront — but only after demos are commodity enough that storage cost is below the user pain of "first-launch download." Status: no action.

### Wearables / Health integrations

5. **Ship the Health Connect (Android) reader before any direct OAuth integration.** It covers Wear OS, Fitbit, Galaxy, Garmin Android, Pixel Watch — all in one native module. Direct Oura/WHOOP/Garmin APIs should wait until Health Connect parity is done. See `docs/architecture/wearable-integrations.md` for the full sequencing.
6. ~~**Backfill 6 months of Apple Health on first onboarding.**~~ ✅ **Shipped 2026-05-10.** `backfillSnapshotsToBackend(180)` now runs after both onboarding Connect-Health success and Progress-tab connect. Chunked into two 90-day batches so the recent window populates the UI before the older window finishes. See roadmap "Recently Shipped" and `docs/architecture/healthkit.md`.
7. **HRV reader.** Already documented as a missing piece in `HEALTH_INTEGRATIONS.md`. Strong recovery signal for WHOOP/Watch users. Effort: 1-2 hours.

### Data imports

8. ~~**MyFitnessPal CSV import is the single highest-leverage retention feature unbuilt.**~~ ✅ **Shipped 2026-05-10.** Backend parser/matcher/pipeline plus Settings → Import UI are live. Remaining work: manual review for unmatched foods, success recap, and pending-import reminders.
9. **Awareness layer — `pending_imports` on `UserPreferences`.** ✅ Schema shipped 2026-05-10 (idempotent `ADD COLUMN IF NOT EXISTS pending_imports JSONB`, PreferencesUpsert pydantic shape, profile upsert handler with preserve-on-empty semantics matching `injuries_structured`). Next: Home/You banner + local notification reminders. Effort remaining: ~1-2 days.
10. ~~**Strong + Strava imports.**~~ ✅ **Shipped 2026-05-10.** Strong CSV upload and Strava OAuth/backfill now have backend pipelines and frontend entry points. Remaining work: unmatched-exercise review, per-source telemetry, and production Strava env validation.
11. **Hevy + Generic CSV** follow only after import activation is working. Effort: 3 days + 1-2 days.

### Cleanup carried from earlier passes

12. **Backend log structuring** — `KeyError("Attempt to overwrite 'created'")` in `gut_backfill`. Still polluting Sentry per the roadmap doc.
13. **Per-route latency budgets** — log `time.perf_counter()` on `/workouts/weekly-review` and `/meals/score` (both hot paths). Cheap, high observability win.
14. **HomeScreen / ActiveWorkoutScreen split-and-lazy-load** — both screens are still the largest performance risk in the app. No new diagnosis needed; just the implementation.
15. **`actual_rir` → next-set load suggestion** — RIR data has been captured for weeks; nothing reads it during the live session. Wiring the deterministic suggestion (RIR 0-1 → same weight; RIR ≥3 → +2.5-5 lbs) is small.
16. **In-workout 1RM display** — `rolling_e1rm.py` is production-ready; UI chip is a few hours.

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
- **A6 — Backend startup gating + timing.** Startup is schema-readiness only by default. Data maintenance now requires `STARTUP_DATA_MAINTENANCE_ENABLED=1`, startup backfills require `STARTUP_BACKFILLS_ENABLED=1`, and OpenAI enrichment / historical AI backfill hooks have been removed from deploy startup.
- **B1 — Tighter Info.plist usage descriptions.** `NSCameraUsageDescription`, `NSFaceIDUsageDescription`, `NSMicrophoneUsageDescription`, and `NSPhotoLibraryUsageDescription` rewritten in both `app.json` (so Expo regenerates correctly on next prebuild) and `ios/Thallo/Info.plist` (raw). Each now explains the specific use case, which App Review expects.
- **B2 — Legal version re-acceptance.** `LEGAL_VERSION` bumped to trigger a re-accept on existing accounts. `needsLegalReAcceptance()` helper added to `src/constants/legal.ts`. `POST /auth/accept-legal` endpoint stamps fresh acceptance timestamps + versions on all four sections and writes a versioned `legal_acceptance_events` audit row. Frontend `acceptLegal()` helper added to `services/api.ts`. Legal sections also now include a Third-Party Services entry and an Account Deletion And Retention entry — bumping the version forces existing users to re-accept.
- **B3 — Third-party data sharing disclosure.** New "Third-Party Services" section in `LEGAL_SECTIONS` names OpenAI (meal/coach/scan AI), USDA (food data), and Apple Health (on-device only), and explicitly states that calorie/macro/weight data is not shared.
- **B5 — Hard-delete schedule.** `_purge_expired_soft_deletes` startup task added to `backend/app/main.py`. Runs as a daemon thread; hard-deletes any user with `is_active=False` and `account_deleted_at < now − 30 days`. Window configurable via `ACCOUNT_HARD_DELETE_DAYS`, gate via `ACCOUNT_HARD_DELETE_ENABLED=0`. Retention timeline now documented in the new "Account Deletion And Retention" legal section so users see it on next acceptance.
- **B6 — Tighter rate limits.** `/auth/email-verification/request` lowered from `5/hour` to `3/hour`. `/auth/recovery-question` lowered from `20/hour` to `10/hour`. Reduces account-enumeration and email-bombing surface.
- **B8 — DEV_EMAIL_TOKENS isolation test.** New `backend/tests/test_auth_dev_token_isolation.py` (4 cases) pins the gating logic so dev tokens never leak when the env var is unset, set to `0`, or set to a truthy-but-not-`1` value. Registered in `run_all.py`.
- **B9 — Gear photo EXIF strip.** `pickGearPhoto` in `GearScreen.tsx` now passes `exif: false` to both `launchCameraAsync` and `launchImageLibraryAsync`. Matches the existing `MealEditModal` photo path. Uploaded gear photos no longer carry GPS coordinates or device metadata.
- **C4 — Startup background data jobs removed.** Schema migrations and account-retention cleanup still run on boot, but food micronutrient enrichment, exercise image refresh, muscle-fatigue backfill, gut-health backfill, and food-classification backfill are no longer wired into startup env flags. The pure startup config helper is covered by `test_startup_maintenance`.
- **D17 — Watch-selected custom activity handoff.** Watch quick-start payloads now pass their selected category/subtype into `LiveActivityTracker`, which auto-starts the matching phone tracker activity instead of making the user pick again.
- **D20 — Per-session gear picker.** Active workout completion now prompts when multiple active gear items match a session and passes selected `gear_ids` through `/workouts/complete`, so the backend credits only chosen gear instead of double-counting keyword matches.

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

Implemented in the 2026-05-10 session (form demos, imports, wearables planning):

- **Bundled local form demos.** Replaced GitHub raw hot-linking with `assets/exercise-demos/<id>/{0,1}.jpg` baked into the ipa (~21 MB, 174 ids × 2 frames). Hot-links worked in Expo Go but silently failed in TestFlight/App Runner prod builds. `src/utils/exerciseDemoAssets.ts` is the auto-generated `require()` map (Metro requires static literal paths). `scripts/sync-exercise-demos.sh` regenerates it after seed/resolver edits.
- **Fixed dead `demoExerciseDbId` prop on `FormVideoModal`.** It was declared on the props interface but never rendered; modal now actually shows the 2-frame `ExerciseDemoCard` at the top of the video grid as the original JSDoc promised.
- **Fixed aspect-ratio mismatches across demo surfaces.** Source frames are 3:2 (850×567); detail surfaces used 4:3 containers and small tiles used `contain`. Caused letterboxing on detail views and "tiny figure in a square white box" on small tiles. Corrected to 3:2 containers (no letterbox) for large surfaces and `cover` on small tiles (figure-centred crop). Also fixed `ExerciseDemoCard` `<Image>` styling — under New Architecture, `position: 'absolute' + top/left/right/bottom: 0` without explicit width/height fell back to intrinsic 850×567 and looked "super zoomed in" inside smaller parents.
- **MFP / Strong / Strava import paths.** Backend parsers, matchers, idempotent pipelines, rollback-aware import batches, and Settings → Import UI are shipped for MyFitnessPal CSV/GDPR ZIP, Strong CSV, and Strava OAuth/backfill. Remaining import work is activation, review, telemetry, and production Strava env validation.
- **New planning docs.** `docs/architecture/wearable-integrations.md` (coverage matrix + difficulty + recommendation tiering for Apple Health / Health Connect / Oura / WHOOP / Garmin / Fitbit / Polar / Galaxy / Coros / Strava / etc.). `docs/architecture/data-import.md` (import paths from MyFitnessPal, Cronometer, Hevy, Strong, Strava, plus generic CSV — phased sequence, idempotency, source boundary rules).
- **CLAUDE.md updated.** Added invariant #12 ("Form demos are bundled, not hot-linked") and indexed the two new docs.

Deferred by owner decision:

- StoreKit, RevenueCat, restore purchases, billing management, entitlement verification, and production subscription gating.

## What I Confirmed In The Codebase

- Backend `User` already has `first_name` and `last_name`. Signup flow now uses them.
- Workout planner is fully deterministic per `CLAUDE.md`. AI plan review is permanently disabled (`PLAN_REVIEW_ENABLED=0` is a no-op).
- The subscription helper now defaults missing tiers to Free, but Pro is still a client/dev-tier simulation until StoreKit or RevenueCat and server-side entitlements are wired.
- `HomeScreen.tsx` is ~20.8k lines with 164 `useState` occurrences. `ActiveWorkoutScreen.tsx` is ~13.3k lines with 4 `setInterval` references and 27 `setTimeout` references. `ProgressScreen.tsx` is ~13.1k lines and remains map-heavy inside `ScrollView` surfaces.
- Location is already used for workout-scoped outdoor cardio route/distance/pace capture on phone and Watch. Hydration has a heat add-on in the pure function, but no ambient weather/location feed is wired into the endpoint yet.
- Watch and Live Activity code exists. Recent diagnostic improvements should make next-build sync issues visible without Console.app.
- `docs/DEPLOYMENT.md` already notes that a public App Store release needs hosted Privacy Policy and Terms URLs; source drafts live in `docs/legal/`.

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
| A6 | Backend startup used to run migrations + data backfills + possible OpenAI calls | `backend/app/database.py:create_db_and_tables` and legacy `app/main.py` startup jobs | ✓ Done — startup no longer exposes AI backfill/enrichment hooks; data maintenance is explicit. |

## B. Legal, Privacy, Auth & Account

| # | Issue | Location | Fix |
|---|---|---|---|
| B1 | Weak Info.plist usage descriptions | `ios/Thallo/Info.plist`, `app.json`, Watch `Info.plist` | ✓ Done — camera, photo library, microphone, Face ID, HealthKit, route/location, motion, and Watch Health writes now explain specific app use. Keep App Store labels synced. |
| B2 | Legal versions hardcoded, not enforced post-signup | `src/constants/legal.ts`, `backend/app/routers/auth.py` | ✓ Done — re-accept terms flow plus `legal_acceptance_events` audit trail. |
| B3 | No third-party data sharing disclosure in legal copy | `src/constants/legal.ts`, `docs/legal/` | ✓ Done — in-app copy and public drafts disclose OpenAI, USDA/Open Food Facts/wger, Apple/Google sign-in, RevenueCat/app stores, HealthKit/Health Connect boundaries, and no sale/tracking. |
| B4 | Legal copy is "launch-ready product copy, not attorney-reviewed" | `src/constants/legal.ts`, `docs/legal/` | Public Privacy Policy and Terms source drafts added; founder/legal review and hosted URLs still required before paid launch. |
| B5 | Soft-delete has no hard-delete schedule | `backend/app/routers/profile.py`, `backend/app/main.py` | ✓ Done — hard-delete window exists; deletion/retention copy now also calls out anonymized shells, backups, logs, vendor records, billing/security/fraud/moderation exceptions. |
| B6 | Email-verification rate limit too loose | `backend/app/limiter.py` (`5/hour` for verification request) | Tighten to `3/hour` per user/IP. Same for `/auth/recovery-question` lookup. |
| B7 | COPPA/GDPR-K age gate is self-reported only | `src/utils/age.ts:46` | Acceptable for soft launch. For EU/UK distribution add explicit parental-consent flow for 13–16. |
| B8 | DEV_EMAIL_TOKENS path leaks tokens in JSON | `backend/app/routers/auth.py:252,416` | Confirm env check is airtight; add tests that ensure tokens are NOT in response when `DEV_EMAIL_TOKENS` unset. |
| B9 | EXIF stripping verified ✓ | `src/components/MealEditModal.tsx` (`exif: false` on pick + camera) | Already correct — no action. Apply same flag to gear photos (`src/screens/GearScreen.tsx:pickGearPhoto`). |
| B10 | No support contact endpoint or email destination wired | Settings exposes a contact link but where does it go? | Set up a real `support@thallo.app` mailbox and link it from settings. |

## C. Performance Hotspots

| # | Issue | Location | Fix |
|---|---|---|---|
| C1 | ActiveWorkoutScreen timer ownership is still spread out | `src/screens/ActiveWorkoutScreen.tsx` — 4 `setInterval` references, 27 `setTimeout` references | Consolidate polling, autosave, sync debounce, sidecar drains, GPS lifecycle, rest timing, and modal handoffs behind one owned timer/side-effect layer. Track cleanup explicitly on unmount and resume. |
| C2 | HomeScreen is now a ~20.8k-line route container | `src/screens/HomeScreen.tsx` — 164 `useState` occurrences; some rows are memoized, but orchestration remains monolithic | Split by domain (workout / meals / settings / social / trainer / imports / custom activity tracker) into route-level containers and hooks. Keep HomeScreen as shell/orchestrator. |
| C3 | Backend startup re-seeds equipment/exercises/foods on every hot restart | `backend/app/database.py:1164-1169` | Idempotent already, but adds 5–15s to every container restart. Skip if marker row exists. |
| C4 | OpenAI call in startup background thread | legacy `backend/app/main.py:_startup_enrich_food_micros` | ✓ Done — startup AI backfill/enrichment hooks and the food-micro maintenance script were removed. |
| C5 | N+1 queries on workout-detail fetch | `backend/app/routers/workouts.py:2406` (loop + `db.exec(select(ExerciseSet)…)` per exercise) | Single `IN` query then group by exercise id. ✓ Done — `_build_session_responses_batch` collapses list/detail to 3 queries; `progression_insights` collapses nested loop to 2; `delete_workout` uses bulk DELETE WHERE id IN(...). |
| C6 | N+1 in social digest builder | `backend/app/services/social/digest.py:92-104` | ✓ Already batched (verified — uses `.in_(friend_ids)` for profiles, users, goals, completions). Doc was stale. |
| C7 | N+1 in meal item fetch | `backend/app/routers/meals.py:743` (per-meal MealItem query) | ✓ Mostly batched (`day_summary` uses `.in_(meal_ids)`); only remaining per-row pattern is `delete_meal` cascade which is single-meal so not a true N+1. |
| C8 | Long lists rendered via `.map()` inside ScrollView | `HomeScreen.tsx`, `ProgressScreen.tsx` | Convert workout history, meal/import history, PR lists, body-scan history, plateau lists, and library rows to `FlatList`/`SectionList`. Imports make this more urgent because users can arrive with years of history. |
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
| D1 | Notification preference UI missing | `SettingsScreen.tsx` | ✓ Mostly done — Settings has workout, meal, hydration, and quiet-hours controls. Remaining work is route-level polish and ensuring reminder scheduling respects these settings everywhere. |
| D2 | Unit preferences missing | `SettingsScreen.tsx`, `UserProfile.weightUnit`, `UserProfile.distanceUnit` | ✓ Mostly done — Settings can update weight and distance units. Remaining work is applying display formatters across every history/chart/share/export surface. |
| D3 | Dietary restriction collection in onboarding | `OnboardingScreen.tsx`, `UserProfile.allergies` | ✓ Done — onboarding collects allergies/restrictions and backend meal planning/filtering reads them. |
| D4 | Onboarding resume after abandonment | `OnboardingScreen.tsx` | ✓ Done — versioned `onboardingDraft_v1` persists setup state, prompts to continue, expires stale drafts, and clears on completion. |
| D5 | Live Activity permission education | `ActiveWorkoutScreen.tsx` | ✓ Done — one-time permission education alert explains Lock Screen/Dynamic Island rest-timer impact and links to Settings. |
| D6 | Mid-workout exercise swap | `ActiveWorkoutScreen.tsx` | ✓ Done — active workout swap flow preserves logged sets and ranks same-session alternatives locally. |
| D7 | Plan pause/resume for travel or illness | `PlanWeek.paused_until`, `SettingsScreen.tsx`, `plan_weeks.py` | ✓ Done — Settings can pause/resume the active week; backend suspends auto-renew, auto-skip, and reminders while paused. |
| D8 | Coach chat has no transcript history | `CoachCheckinModal.tsx` doesn't persist a log | Add a `CoachMessage` table; show recent messages. |
| D9 | Apply-action has no undo | Coach actions mutate `UserPreferences` / `UserCoachingState` directly | Add a 30-second undo banner after each apply-action. |
| D10 | No body-scan comparison view | `ProgressScreen` shows scans but no side-by-side or trend graph | Add scan timeline + before/after comparison. |
| D11 | Body fat % and muscle mass have no timeline | Only weight has a chart | Add lightweight charts for body comp metrics. |
| D12 | Barcode scan "Product not found" has no fallback | `MealEditModal.tsx:714` | Offer "Search by name" fallback or "Add to USDA submission queue." |
| D13 | Saved meals not exposed as one-tap repeat from recents | `SavedMealsSection.tsx` | After logging a meal, prompt "Save as favorite?" Then expose saved meals as a horizontal scroll above the meal entry. |
| D14 | No friend invite link / friend-code generation | `FriendsModal.tsx` only supports username search | Add deep-link invites with reusable per-user codes. |
| D15 | Block/report UX | FriendsModal social surface | ✓ Done — long-press friend row exposes Remove / Block / Report; `POST /social/report-user` stores open moderation reports. |
| D16 | Watch complications / Siri shortcuts | Watch complication target / Siri intent target | Partial — Watch complication + Smart Stack widget shipped. Siri shortcuts / intents build pass remains deferred. |
| D17 | TODO: pass watch-selected activity through to LiveActivityTracker | `HomeScreen.tsx` / `LiveActivityTracker.tsx` | ✓ Done — watch quick-start category/subtype resolves to the matching tracker option and starts it directly. |
| D18 | TODO: persist protein preference once UserCoachingState supports it | `backend/app/services/nutrition/weekly_review.py:402` | Add `preferred_protein_g` to `UserCoachingState`. |
| D19 | TODO: wire DayState.session_rpe_avg | `ProgressScreen.tsx:547` | Plumb the field through; surface RPE trend. |
| D20 | Per-session gear picker | Gear auto-tracks via keyword matching, but two pairs of running shoes both match "run" → double-counting | ✓ Done — matching gear prompts on completion; selected IDs bypass keyword auto-match and explicit "none today" credits nothing. |
| D21 | Hydration heat/weather context not wired | `backend/app/services/nutrition/hydration.py` supports `ambient_temp_f`, but `/meals/hydration` does not provide weather | Add optional coarse weather setting. Store weather observations, not precise background location. Use for heat/humidity/altitude hydration and outdoor-cardio recovery copy. |

## E. UX Rough Edges

| # | Issue | Location | Fix |
|---|---|---|---|
| E1 | Dedicated Settings screen cleanup | `SettingsScreen.tsx` plus duplicate Home/You controls | ✓ Mostly done — `SettingsScreen` exists. Remaining work is retiring duplicate Home/You modal controls and making Import/Data & Privacy/Watch/Gear/Legal consistently route through Settings. |
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
| Improve onboarding save/resume | ✓ Done — see D4 |
| Add pre-permission HealthKit education | Pending — see E8 |
| Add notification preferences | Mostly done — see D1 |
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
7. Finish Settings hub cleanup and preference propagation (D1, D2, E1), including the new weather/hydration opt-in if prioritized.
8. Add HealthKit pre-permission education in onboarding and keep the shipped onboarding draft/restriction flows covered in QA (D3, D4, E8).
9. Keep `freeBetaFullAccess` off by default; validate the 7-day signup trial and RevenueCat entitlement sync in paid TestFlight/internal testing.
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
