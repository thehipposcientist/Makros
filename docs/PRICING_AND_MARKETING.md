# Thallo Pricing And Marketing Strategy

Last updated: 2026-04-29
Audience: product, marketing, launch planning

This document reflects the current app after reviewing the frontend, backend, native modules, Apple Watch target, and architecture notes. It intentionally avoids treating Thallo as a pre-core prototype. The product now has enough substance to support a premium positioning, but production billing and native reliability still need to be proven before a paid public launch.

## Executive Summary

Thallo should be positioned as a premium body-recomposition companion for people who want a clear weekly plan, guided workout execution, nutrition structure, and recovery feedback without juggling five apps.

Recommended launch pricing:

- Monthly: $12.99
- Annual: $79.99
- Founding member annual: $59.99 for the first launch cohort
- Closed beta: free

Do not charge publicly until StoreKit/RevenueCat, server-side entitlements, restore purchases, and paywall analytics are implemented. The current subscription state should be treated as a dev/product tier simulation, not real monetization.

Decision as of 2026-05-01: the external beta is free and should run with `expo.extra.freeBetaFullAccess=true` so testers can exercise the full guided plan, AI, readiness, and Watch loop without billing infrastructure.

## Product Reality That Changes Pricing

Thallo is stronger than the older pricing draft assumed.

Current value drivers:

- Deterministic 7-day workout PlanWeeks backed by the database.
- Active workout logging with sets, rest, progression, and completion state.
- Nutrition planning, meal scoring, food classification, scanning, and grocery-list support.
- Recovery/readiness/sleep surfaces.
- Supplement tracking.
- Apple Health integration code for reading health context and writing workouts.
- Apple Watch companion app with workout, meals, supplements, sleep, readiness, quick start, and weight surfaces.
- Local notification foundations for rest timers and reminders.
- Social accountability with strict privacy boundaries.

Current monetization limits:

- No production IAP/RevenueCat flow yet.
- No server-verified paid entitlement source yet.
- No restore-purchases flow yet.
- Paywall analytics and conversion instrumentation are not launch-ready.
- Native capabilities still need signed TestFlight and real-device validation.

Pricing can be premium, but launch should be disciplined.

## Positioning

Primary positioning:

> Thallo turns your goal into a clear training week, guides every workout on your phone or Apple Watch, and keeps meals, recovery, and progress in sync.

Short version:

> A weekly fitness plan you can actually follow.

Best customer:

- Beginner to intermediate lifters.
- Body recomposition, fat loss, or lean muscle goals.
- People who want structure without hiring a coach.
- Apple Watch users who want guided lifting, not just passive rings.
- Users who are willing to log meals if the app makes the feedback useful.

Core emotional promise:

- "I know what to do today."
- "My workouts and meals finally fit together."
- "My Watch helps me execute the plan instead of just recording chaos."

Avoid these claims:

- "AI creates your workouts."
- "Medical-grade readiness."
- "Diagnoses sleep, hormones, or recovery."
- "Fully automatic workout tracking."
- "Pro is available" before real purchase infrastructure exists.

## Recommended Free And Pro Split

The free tier should prove the product, not replace it. The paid tier should own guided planning, AI assistance, ongoing adaptation, and advanced insight. Today this split is still a client/dev-tier simulation; before public billing, StoreKit or RevenueCat plus server-side entitlement checks must enforce the same gates.

### Current Implemented Split

This is the accurate in-app split as of May 1, 2026.

### Free

Current free access:

- Account creation and onboarding.
- Manual workouts and custom activity logging.
- Manual meals, hydration, and meal routines.
- Weight and body measurement tracking.
- Basic history and progress views.
- Exercise library, equipment, injury, and preference settings.
- Up to 3 saved workout templates.

Free should not promise full generated programming or AI help. In the current client, free users see manual tracking scaffolds while Pro surfaces are prompted at use.

### Pro

Current Pro access:

- Visible generated workout PlanWeeks.
- Change Focus, deterministic swaps, and day rebuilds.
- AI meal plans, meal swaps, and grocery help.
- Food photo scanning and AI food lookup.
- Coach chat for training and nutrition.
- Body and form photo analysis.
- Nutrition scoring, gut insights, and weekly digest surfaces.
- Readiness, fatigue, sleep, and recovery cards.

### Launch Target

For a paid public launch, keep the same shape but make the backend authoritative:

- Free gets onboarding, manual tracking, basic history, basic progress, and a limited starter experience.
- Pro gets ongoing PlanWeek auto-renewal, AI meals/scans/coach, readiness and recovery insight, advanced analytics, and the full Watch-guided workflow if Watch convenience is positioned as a paid benefit.

Pro should sell "the loop keeps going": next week, better context, faster logging, and less friction.

## Pricing Recommendation

### Launch Price

Use $12.99/month and $79.99/year for the first public paid launch.

Why:

- It signals premium without creating the expectation of a full human coach replacement.
- The annual plan gives a meaningful discount while keeping lifetime value healthy.
- It leaves room to raise price later after Watch reliability, HealthKit insights, and retention are proven.

### Founding Offer

Use $59.99/year for the first 250-500 paying users.

Rules:

- Make it time- or cohort-limited.
- Keep the copy simple: "Founding annual price."
- Do not promise lifetime pricing unless you are comfortable supporting it forever.

### Future Price Test

After native reliability and 30-day retention are strong, test:

- $14.99/month
- $99.99/year

Do not start there unless the Watch and HealthKit experience is demonstrably reliable. Higher pricing will increase support expectations.

## Trials And Paywalls

Recommended trial:

- Closed beta: free, full access.
- Soft launch: 7-day Pro trial.
- Public launch: test 7-day trial versus starter-week-first paywall.

Best first paywall moments:

- After the user completes the starter PlanWeek.
- When the user tries to generate the next week.
- When the user tries to use full Watch-guided workout mode.
- When the user hits a scan or AI meal cap.
- When the user opens advanced readiness/sleep insights.

Avoid paywalling:

- Account creation.
- Manual workout logging.
- Manual meal logging.
- Viewing completed history.
- Safety-critical or privacy settings.

## AI Usage And Cost Controls

AI is valuable, but the workout planner must remain deterministic.

Good Pro AI surfaces:

- Meal generation.
- Meal swaps.
- Coach chat.
- Food classification fallback.
- Food scanning interpretation.
- In-workout set review.
- Preference recommendations routed through apply-action.

Do not use AI for:

- Exercise selection.
- Weekly split logic.
- PlanWeek recipe generation.
- Direct mutation of active PlanWeek rows.

Recommended controls:

- Monthly scan cap for Free.
- Reasonable coach-chat cap or abuse protection.
- AI request telemetry by feature.
- Fallback UX for AI failure.
- Cost per activated Pro user dashboard.

## Marketing Narrative

### Homepage/App Store Headline Options

- "Your week of training, meals, and recovery in one place."
- "A smarter fitness plan for people who actually lift."
- "Plan the week. Train from your Watch. Log meals without losing the plot."
- "Body recomposition without spreadsheet chaos."

### Value Pillars

Plan:

Thallo builds a clear 7-day training week from your goal, schedule, equipment, and preferences.

Train:

Start workouts from your phone or Apple Watch, log sets, manage rest, and keep the session moving.

Fuel:

Use meal targets, scoring, AI meal help, and grocery lists to make nutrition less vague.

Recover:

Use sleep, readiness, HealthKit context, and check-ins to understand when to push or adjust.

Improve:

Review progress, streaks, completions, and trends without exposing private nutrition or weight data socially.

### Privacy Message

Recommended copy:

> Share accountability, not private body data. Thallo keeps calories, macros, meals, and weight out of social surfaces.

This is a real differentiator and should stay true in product.

## Launch Sequence

### Phase 0: Reliability And Monetization Gate

Before charging:

- Validate HealthKit on signed TestFlight builds.
- Validate Watch install, sync, workout start, set logging, cancel, end, and reconnect flows.
- Validate Live Activities and local notifications.
- Add error reporting.
- Add product analytics.
- Implement StoreKit/RevenueCat.
- Add server-side entitlement checks.
- Add restore purchases.

### Phase 1: Closed Beta

Audience: 10-30 users.

Goal: prove the core loop works.

Access: free, full-feature beta access. Keep paid language out of tester instructions and do not enable real IAP until entitlement infrastructure is ready.

Track:

- Onboarding completion.
- First PlanWeek activation.
- First workout started.
- First workout completed.
- First meal logged.
- Watch workout success.
- HealthKit permission grant.
- Day 7 return.
- User-reported confusion.

Do not charge this group unless support capacity and billing flows are ready.

### Phase 2: Paid-Intent Test

Audience: 50-150 users.

Goal: measure willingness to pay without risking broad launch.

Options:

- Fake paywall with "join waitlist" or "claim founding price."
- Real trial if IAP and entitlements are complete.

Track:

- Paywall view rate.
- Trial start or intent rate.
- Annual selection rate.
- Feature that triggered paywall.
- Drop-off after paywall.

### Phase 3: App Store Soft Launch

Audience: narrow geography or limited acquisition.

Goal: validate conversion and retention.

Required:

- App Store screenshots reflect real current features.
- Billing and restore flows pass review.
- Support documentation exists.
- Privacy copy is accurate.
- HealthKit and Watch claims are conservative.

### Phase 4: Public Launch

Only expand once:

- Watch-guided workouts are reliable.
- Paid entitlement bugs are rare.
- Day 7 and day 30 retention are acceptable.
- AI cost per Pro user is understood.
- The team can support billing and sync issues.

## Metrics To Watch

Activation:

- Onboarding completion rate.
- PlanWeek created rate.
- First workout start rate.
- First workout completion rate.
- First meal logged rate.
- Watch connected rate.
- HealthKit permission grant rate.

Engagement:

- Workouts completed per active user per week.
- Meal logs per active user per week.
- PlanWeek renewal rate.
- Watch workout start-to-first-set success.
- Workout finish rate.
- Grocery list open and check-off rate.
- Readiness/sleep surface repeat views.

Retention:

- Day 1, Day 7, Day 14, and Day 30 retention.
- Week 2 PlanWeek activation.
- Workout completion in week 2.
- Meal logging in week 2.

Monetization:

- Paywall impression rate.
- Trial start rate.
- Trial-to-paid conversion.
- Monthly versus annual selection.
- Restore purchase success.
- Entitlement lookup failures.
- Refund/cancellation reasons.

Cost and reliability:

- AI cost per activated user.
- AI cost per Pro user.
- Backend latency.
- Meal score failure rate.
- Watch command failure rate.
- HealthKit sync failure rate.
- Crash-free sessions.

## 30-Day Plan

1. Finish native reliability QA on real devices.
2. Run the external beta free with full access.
3. Implement production IAP/RevenueCat if charging is still the goal.
4. Add product analytics and crash/error reporting.
5. Define Free versus Pro gates in code.
6. Update App Store copy around Watch and HealthKit conservatively.
7. Run a small TestFlight with hands-on user interviews.

## 60-Day Plan

1. Use beta data to fix onboarding, Watch sync, and meal logging friction.
2. Add paywall experiments only after activation is healthy.
3. Tighten grocery list and readiness explanations.
4. Add support docs for Watch sync, HealthKit permissions, billing, and data privacy.
5. Prepare soft-launch screenshots and onboarding video.

## 90-Day Plan

1. Soft launch paid Pro if retention and reliability are strong.
2. Test annual discount and founding offer.
3. Add smarter reminders and weekly recap if users are completing workouts.
4. Consider Watch complications or Siri only after the core Watch workout flow is stable.
5. Expand acquisition only after AI cost and support load are predictable.

## Competitive Framing

Avoid competing as "another calorie tracker" or "another AI workout app."

Use this frame instead:

> Thallo is the plan-execution layer between your goal, your workouts, your meals, and your Apple Watch.

Competitor prices change often. Verify current competitor pricing before publishing comparison claims in marketing materials.

## Final Recommendation

Keep the premium target. Launch at $12.99/month and $79.99/year, with a $59.99 founding annual offer. Do not launch paid until billing, entitlement, analytics, and native reliability gates are complete.

The strongest marketing angle is not generic AI fitness. It is a deterministic weekly plan with phone and Apple Watch execution, nutrition support, recovery context, and privacy-safe accountability.
