# Thallo — Recommendations & Roadmap

Last updated: 2026-04-18

## Immediate Actions

### 1. Get a USDA API Key (5 minutes)
Go to https://fdc.nal.usda.gov/api-key-signup, enter your email, get a key instantly. Paste into `backend/.env` as `USDA_FDC_API_KEY=your_key`. Currently on DEMO_KEY (30 req/hr) which means food search fails for active users. A real key gives 1,000 req/hr free.

### 2. Commit Your Work
18 uncommitted files with ~670 lines of changes including the muscle fatigue system, food fixes, exercise images, day selector, and more.

### 3. Add Error Monitoring (30 minutes)
Zero crash reporting currently. Add Sentry free tier — `npx expo install @sentry/react-native` and configure in `app/_layout.tsx`. This tells you what breaks before users report it.

### 4. Change SECRET_KEY for Production
`backend/.env` still has `dev-secret-change-me`. Generate a real 64-character random string before any production deployment.

---

## High Impact Features — Build Next

### Apple Health Auto-Import
`react-native-health` is installed, HealthKit permissions configured, but no auto-import. Wiring this feeds the fatigue system automatically without manual logging. Steps, sleep, and resting heart rate would enrich the recovery score.

### Push Notification Reminders
`expo-notifications` is installed but unused. "Time for your Pull day — you're 92% recovered" at the user's preferred workout time would boost engagement significantly.

### In-App Workout -> Fatigue Pipeline
When a user finishes a workout via ActiveWorkoutScreen, wire the exercise list through `resolve_exercise_fatigue()` and send it with the completion payload. Currently only manual logs and the backfill populate muscle fatigue.

### Progressive Overload Display
The progression engine exists (`set_programming.py`, `recommendation.py`) but the UI doesn't prominently surface it. Show "Last time: 135x8. Today: try 140x8" on each exercise card before the user starts.

---

## Medium Impact — Polish

### Splash Screen and App Icon
Still using Expo defaults. First impressions matter for App Store and user trust.

### Offline Resilience
Cache the workout plan, exercise library, and meal templates more aggressively. If the backend is unreachable, the app should still show the user's plan and let them log workouts locally.

### Weekly Check-In Flow
`CoachCheckinModal` exists but the weekly review cadence isn't consistent. A Sunday evening prompt that asks about energy, sleep, adherence and adjusts next week's intensity would make the app feel alive.

### Onboarding Compression
Currently 10+ steps. Consider: goal + physicals on step 1, schedule + equipment on step 2, foods on step 3, done. Smart defaults for everything else.

---

## Lower Priority — Future

### Social/Sharing
`react-native-view-shot` + `expo-sharing` installed. Let users share workout summaries, PRs, body scan results.

### Barcode Scanning
OpenFoodFacts API for packaged foods. Scan barcode -> get exact nutrition for branded products that USDA doesn't carry.

### Data Export
Users will want CSV/PDF export of workout history, weight log, nutrition data.

### Workout-Aware Nutrition
Light touch: more carbs on hard lifting days, recovery nutrition on rest days, hydration nudge on cardio days. Not a full nutrition overhaul — just a multiplier on existing targets.

### Subscription/Paywall
AI features (coach, food scan, plan generation) are the natural paywall. Deterministic features (planner, tracking, history) stay free.

---

## Technical Debt

| Issue | Severity | Fix |
|-------|----------|-----|
| Tests broken locally | Medium | Fix import paths or add `make test` that runs in Docker |
| CLAUDE.md was outdated | Fixed | Updated to reflect current architecture |
| SECRET_KEY is dev default | High (prod) | Generate real secret before deploying |
| No error monitoring | High | Add Sentry free tier |
| Exercise images: 32/201 | Low | wger.de only has ~100 with images; rest use icon fallback |
| USDA on DEMO_KEY | High | Get free production key |

---

## Feature Completeness

| Feature | Status |
|---------|--------|
| Auth (login/signup) | Done |
| Onboarding with training day selector | Done |
| Goal selection (10 goals + HYROX) | Done |
| Deterministic workout planner | Done |
| Per-day generation with history | Done |
| Day swap (deterministic UI) | Done |
| Training day selector (pick specific days) | Done |
| Active workout tracking (sets/reps/timer) | Done |
| Timed exercise support (boxing, yoga, etc.) | Done |
| Exercise images from wger.de | Done (32/201) |
| 12-muscle-group fatigue system | Done |
| Recovery readiness score + muscle bars | Done |
| Manual activity logging (5 categories) | Done |
| Weight tracking (unified) | Done |
| Food search (USDA + AI fallback) | Done (needs prod key) |
| Meal planning (AI-generated, 5 templates) | Done |
| Food photo scanning | Done |
| Nutrition tracking with macros + micros | Done |
| AI coach (unified workout + nutrition) | Done |
| Body scan (AI photo analysis) | Done |
| Progress history + PRs | Done |
| 27 themes (20 dark, 7 light) | Done |
| Intensity stacking prevention | Done |
| 7-day recovery-aware scheduling | Done |
| Cardio exercise classification | Done |
| Apple Health auto-import | Not wired |
| Push notifications | Not wired |
| Error monitoring | Not configured |
| App icon/splash | Defaults |
| Offline mode | Partial |
| Barcode scanning | Not built |
| Data export | Not built |
