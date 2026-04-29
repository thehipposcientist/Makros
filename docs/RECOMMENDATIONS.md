# Thallo Recommendations

Last updated: 2026-04-29
Audience: product, engineering, launch planning

This is the direct recommendations list after reviewing the app, backend, native modules, Watch target, HealthKit surface, auth flow, account settings, subscription helpers, deployment notes, and architecture docs.

The short version: Thallo has a real product foundation. The next work should not be another broad feature push. It should be a launch-readiness pass: legal/account basics, signed-build native reliability, production entitlements, observability, and performance cleanup around the biggest screens.

## Highest Priority Summary

Do these before a broad beta or paid launch:

1. Ship and test a fresh signed iOS/TestFlight build so the Watch sync and Live Activity native modules are actually present.
2. Add Terms of Service, Privacy Policy, health disclaimer, and AI disclaimer acceptance during signup.
3. Add first name and last name to signup, not just profile editing after onboarding.
4. Replace security-question-only password reset with email-based reset or magic-link reset.
5. Add account deletion, full account data export, support contact, and billing management surfaces.
6. Replace the dev subscription tier toggle with real StoreKit 2 or RevenueCat entitlements.
7. Stop defaulting missing subscription data to Pro before paid launch.
8. Add crash reporting, analytics, native bridge logging, Watch sync metrics, and AI cost/error tracking.
9. Split and lazy-load the largest screens, especially `HomeScreen` and `ActiveWorkoutScreen`.
10. Fix user-facing copy that says "AI workout plans" because workout planning must remain deterministic.

## What I Confirmed In The Codebase

- Backend `User` already has `first_name` and `last_name`, but `UserCreate`, `UserRead`, `/auth/register`, and frontend `register()` do not include them.
- The signup screen collects email, username, password, confirm password, and a security question answer. It does not collect first name, last name, Terms acceptance, Privacy Policy acceptance, or health disclaimer acceptance.
- Name editing exists later through `/profile/name`, so the backend is already close to supporting first/last name at signup.
- Client signup only tells users "at least 8 characters" for passwords, while the backend also requires a digit. This creates avoidable signup failures.
- Password reset currently depends on security questions. That is weak for a public consumer app and creates support/privacy risk.
- The subscription helper returns Pro when the tier is missing: `profile?.subscriptionTier ?? 'pro'`. That is fine for development, but unsafe for production billing.
- Account settings show email, username, recovery question status, and a developer subscription toggle. They do not appear to expose full account deletion, full account data export, Terms/Privacy links, billing restore/manage, or support contact.
- A local workout history export exists, but that is not the same as full account data export.
- `HomeScreen.tsx` is about 11.7k lines and `ActiveWorkoutScreen.tsx` is about 5.9k lines. These are product risk areas for startup time, re-render churn, maintainability, and regression risk.
- Watch and Live Activity code exists, but the current user-reported issue points to a stale or incomplete native build path. A signed rebuild and real-device checklist should be treated as a P0 gate.
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

## P0: Trust, Legal, And Account Basics

These are straightforward launch-readiness items. They are not flashy, but they make the app feel real and reduce App Store, billing, support, and trust risk.

| Recommendation | Why it matters | Concrete next step |
|---|---|---|
| Add Terms of Service acceptance on signup | Needed for a serious public app and paid product | Add checkbox, link, accepted timestamp, accepted version |
| Add Privacy Policy acceptance on signup | App handles health, nutrition, weight, photos, and account data | Add checkbox, link, accepted timestamp, accepted version |
| Add a health and fitness disclaimer | The app gives training, nutrition, recovery, and supplement guidance | Add non-medical disclaimer and acceptance timestamp; have counsel review copy |
| Add an AI disclosure/disclaimer | Users should understand where AI is used and where it is not | Explain AI meal/chat/scan support and deterministic workout planning |
| Add first name and last name to signup | Backend model already supports it; personalization improves UX | Extend `UserCreate`, `/auth/register`, `UserRead`, `register()`, and `AuthScreen` |
| Keep username as handle, not identity | Username is useful for social/search, but real names are better for greeting and support | Collect both name and username; use first name in app copy |
| Add email verification | Reduces fake accounts, support issues, and password-reset risk | Send verification email after signup; gate sensitive flows if unverified |
| Replace security-question reset | Security questions are easy to guess and hard to support | Add email reset token or magic link; keep recovery question only as temporary fallback |
| Align password validation | Current client copy is weaker than backend policy | Client should require and display the same rules as backend: length plus digit |
| Add account deletion | Public apps need a user-visible way to leave | Add account deletion endpoint and settings UI; soft-delete where data retention requires it |
| Add full account data export | Workout-only export is not enough for account/data rights | Export profile, workouts, meals, weight, supplements, sleep/readiness, and social metadata |
| Add support contact | Users need help with billing, HealthKit, Watch sync, and data concerns | Add Settings > Help & Support with email/contact link |
| Add Terms/Privacy links in settings | Users must be able to review what they accepted | Add links in Account or Legal section |
| Add billing management and restore purchases | Required for real subscriptions | Add manage subscription, restore purchase, entitlement status, and failure messaging |

## P0: Monetization And Entitlements

Current subscription state is useful for development, but it is not production billing.

Required before charging:

- Integrate StoreKit 2 or RevenueCat.
- Verify entitlements server-side.
- Default unknown or missing entitlement to Free, not Pro.
- Remove or hide the developer tier toggle from production builds.
- Add restore purchases.
- Handle expiration, cancellation, billing retry, grace period, refunds, and entitlement lookup failures.
- Add paywall analytics for impressions, starts, purchases, restores, cancellations, and failures.
- Audit all Pro gates against the pricing and marketing promise.

Recommended copy correction:

- Avoid "AI workout plans" because the workout planner is deterministic.
- Safer wording: "personalized training plans" or "deterministic training plans with AI coaching support."

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

Recommended engineering work:

- Add phone/watch payload schema regression tests.
- Add command delivery metrics for Watch commands.
- Add visible sync status: synced, waiting for phone, watch unreachable, retrying, failed.
- Add a manual "sync now" button for the account/device screen.
- Keep a release checklist in docs so this does not regress every build.

## P0: Observability

The app is too feature-rich to rely on user screenshots and console logs.

Add:

- Frontend crash reporting.
- Backend error reporting.
- Native module error reporting for HealthKit, Watch bridge, and Live Activities.
- Watch command success/failure metrics.
- HealthKit permission and sync metrics.
- Onboarding funnel analytics.
- PlanWeek creation and activation analytics.
- Active workout start, completion, cancel, and crash/recovery analytics.
- Meal score, food scan, barcode, and AI parsing failure analytics.
- AI request count, latency, token/cost estimate, and fallback rate.
- Paywall and entitlement analytics.

Track these launch metrics first:

- Signup started to onboarding complete.
- Onboarding complete to first PlanWeek active.
- First workout started to completed.
- First meal logged.
- Watch connected and first Watch workout action.
- HealthKit permission granted.
- Live Activity start success.
- Seven-day retention.

## P0: Build And Type Safety

Recommended gate before broader TestFlight:

- `npx tsc --noEmit` has a known baseline.
- iOS prebuild is reproducible.
- Pods install cleanly after a clean prebuild.
- Production-profile iOS build includes HealthKit, Watch target, Live Activities, and notification capabilities.
- Backend tests run with the known baseline documented separately.
- Native module changes are verified in the generated iOS project before submitting a build.

## P1: Performance Recommendations

These are the clearest performance and maintainability risks from the review.

| Recommendation | Why it matters | Concrete next step |
|---|---|---|
| Split `HomeScreen.tsx` | At about 11.7k lines, it is likely to re-render too much and is hard to safely change | Move account, social, nutrition, grocery, progress, and settings surfaces into focused containers |
| Split `ActiveWorkoutScreen.tsx` | At about 5.9k lines, active workout logic, timers, native sync, and UI are tightly coupled | Extract rest timer, exercise list, set logger, Watch sync, Live Activity sync, and completion flow |
| Lazy-load heavy tabs/modals | Many users do not need every modal and card at app startup | Dynamic import low-frequency modals and heavy analytics cards |
| Virtualize long lists | Exercise, meal, history, social, and grocery lists can become expensive | Use FlatList/SectionList/FlashList where applicable instead of large mapped ScrollView content |
| Reduce startup network fanout | Home appears to fetch many domains of state | Batch startup endpoints or defer non-critical calls until after first paint |
| Cache exercise and food media aggressively | Exercise videos/images and food scans can create slow screens | Add image/video thumbnail caching and predictable loading states |
| Throttle HealthKit refresh | Health data sync can be expensive and redundant | Refresh on app active with a time window, not every render path |
| Isolate timer state | Rest timers should not cause full workout or home re-renders | Keep timer state in a dedicated hook/store and publish minimal derived values |
| Add performance marks | Hard to improve what is not measured | Track app launch, home first contentful render, workout screen mount, and meal scan round trip |
| Add offline queues for critical actions | Watch/workout actions happen during lock/background/network loss | Queue log set, end workout, meal check, supplement check, and weight log with idempotent replay |

## P1: Feature Recommendations

These are product improvements that make the existing app feel complete without violating the core architecture.

| Recommendation | Why it matters | Concrete next step |
|---|---|---|
| Add device sync status screen | Watch sync is a core differentiator and current user pain point | Show paired status, last sync time, last command, and retry/sync now |
| Add workout recovery/resume banner | Active workouts can be interrupted by locks, app kills, or Watch disconnects | Show "resume active workout" with clear source of truth |
| Improve onboarding save/resume | Long onboarding can be abandoned | Persist partial progress and show progress indicators |
| Add pre-permission HealthKit education | Improves acceptance and reduces fear | Explain reads/writes before Apple permission sheet |
| Add notification preferences | Users need control over meal, workout, rest, and recovery nudges | Settings toggles with quiet hours |
| Add legal/settings section | Makes the app feel production-ready | Terms, Privacy, disclaimer, support, delete account, export data |
| Add saved meal shortcuts | Nutrition retention depends on speed | One-tap repeat meals and common meal templates |
| Improve grocery list check-off | Grocery exists, but polish matters | Persist checked items, group by aisle/category, support restore removed |
| Add readiness explanations | Scores need trust | Show top drivers and plain-language reasons; avoid medical claims |
| Add coach action history | AI advice should be auditable | Show what changed, when, and why; keep changes routed through apply-action |
| Add weekly recap | Reinforces progress and retention | Summarize workouts, consistency, weight trend, and safe social digest |
| Add referral or invite later | Good growth lever after retention is proven | Do not build before metrics show the core loop works |

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
- Automatic Apple Watch workout import/reconciliation.
- Pantry tracking.
- Restaurant ordering suggestions.
- Wearable integrations beyond Apple Health.
- Advanced coach memory beyond the existing coaching state model.
- Major redesigns that do not improve activation, workout completion, meal logging, retention, or reliability.

## Practical 30-Day Plan

1. Build and install a fresh signed iOS/TestFlight build; verify Watch sync and Live Activity behavior.
2. Add signup legal acceptance, first name, last name, and matching password rules.
3. Add Terms, Privacy, health disclaimer, support contact, delete account, and full data export to settings.
4. Replace security-question-only password reset with email-based reset.
5. Add crash/error reporting and the first analytics events.
6. Remove production access to the developer subscription toggle and default missing tier to Free.
7. Choose StoreKit 2 or RevenueCat and implement server-verified entitlements.
8. Split the largest screen responsibilities enough to reduce performance and regression risk.
9. Run a 10-20 person TestFlight with a written QA checklist.

## Practical 60-Day Plan

1. Tighten Watch command delivery, queueing, and sync status.
2. Improve meal logging speed with saved meals, repeat meal shortcuts, and better grocery check-off.
3. Add onboarding resume and HealthKit pre-permission education.
4. Add paywall analytics and trial/annual pricing experiments only after entitlements are real.
5. Add weekly recap and readiness explanations.
6. Use retention and completion data to choose the next feature, not hunches.

## Launch Gate

Thallo is ready for a small closed beta when:

- Onboarding reliably creates a valid PlanWeek.
- A user can complete at least one workout from phone and one from Watch.
- Watch sync recovers from app backgrounding and lock state.
- Live Activity rest timer works on a signed build.
- HealthKit denied, partial, and granted states all work.
- Meal logging and scoring work after app relaunch.
- Local notifications work or fail gracefully.
- Crash/error reporting is enabled.
- The team can see activation, retention, Watch sync, and meal logging metrics.

Thallo is ready to charge when:

- The beta gate is passing.
- Terms, Privacy Policy, health disclaimer, and support flows are in place.
- Account deletion and full account export exist.
- StoreKit/RevenueCat is integrated.
- Backend entitlement checks exist.
- Restore purchases works.
- Missing entitlement defaults to Free.
- Paywall analytics are live.
- Billing, cancellation, and privacy copy is clear.

## Bottom Line

The strongest next move is not more features. It is making the current product trustworthy: signed-build native reliability, legal/account basics, production subscriptions, observability, and performance cleanup. Once those are stable, the best product bets are faster nutrition logging, clearer Watch sync, readiness explanations, weekly recaps, and carefully scoped social accountability.
