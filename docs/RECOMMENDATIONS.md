# Thallo — Recommendations & Roadmap

Last updated: 2026-04-18

## Immediate Actions

### 1. Get a USDA API Key (5 minutes)
Go to https://fdc.nal.usda.gov/api-key-signup. Paste into `backend/.env` as `USDA_FDC_API_KEY=your_key`. Currently rate-limited on DEMO_KEY.

### 2. Commit and Push
Large batch of changes across the full stack.

### 3. Add Sentry Error Monitoring (30 minutes)
`npx expo install @sentry/react-native` and configure. Zero crash reporting currently.

### 4. Production SECRET_KEY
Generate a real 64-character random string for `backend/.env` before deploying.

### 5. Create EAS Development Build
Required to test Apple Health, barcode scanning (camera), and push notifications on a real device. `eas build --platform ios --profile development`

---

## High Impact — Build Next

### Apple Health Auto-Import Workouts
Code exists for reading health data. Missing: auto-importing workouts from Apple Watch/WHOOP into the fatigue system, and writing Thallo workouts back to Apple Health. See `docs/HEALTH_INTEGRATIONS.md`.

### Reminder Time Picker
Workout reminders are wired but default to 8:00 AM. Add a time picker so users can choose their preferred reminder time.

### Offline Fatigue Computation
Currently fatigue requires a backend call. Compute it client-side from local workout history so the readiness score works offline.

### App Store Screenshots
Need 6.7" (iPhone 15 Pro Max) and 5.5" (iPhone 8 Plus) screenshots for App Store submission. 5-6 screenshots showing: workout plan, active workout, meal plan, progress, coach, fatigue score.

---

## Medium Impact — Polish

### Social Sharing
`react-native-view-shot` + `expo-sharing` installed. Let users share workout summaries, PRs, body scan results as images to Instagram/Stories.

### Workout-Aware Macro Adjustment
Currently shows tips. Phase 2: adjust actual macro targets by +/-10% on hard vs rest days.

### HRV Reading
Add `HeartRateVariabilitySDNN` to Apple Health reads. Strong recovery signal especially for WHOOP/Apple Watch users.

### Exercise Image Coverage
32/201 exercises have wger images. Could supplement with AI-generated exercise illustrations or a stock image library.

---

## Lower Priority — Future

### Direct Garmin API
Requires Garmin Health API business application (weeks). Apple Health bridge covers most Garmin users already.

### Android Support
`react-native-health` is iOS only. Would need `react-native-health-connect` for Android. Backend and all non-health features work cross-platform already.

### Subscription Infrastructure
Revenue Cat or similar for managing subscriptions. AI features (coach, food scan, plan generation) behind paywall; deterministic features (planner, tracking) stay free.

---

## Technical Debt

| Issue | Severity |
|-------|----------|
| USDA on DEMO_KEY | High — get prod key |
| SECRET_KEY is dev default | High for production |
| No error monitoring | High — add Sentry |
| Tests require Docker | Medium |
| Exercise images 32/201 | Low |

---

## Feature Completeness

| Feature | Status |
|---------|--------|
| Auth (login/signup) | Done |
| Onboarding (5 steps, compressed) | Done |
| Training day selector (pick specific days) | Done |
| Goal selection (10 goals + HYROX) | Done |
| Deterministic workout planner | Done |
| Per-day generation with history | Done |
| Day swap (deterministic UI) | Done |
| Active workout tracking (sets/reps/timer) | Done |
| Timed exercise support (boxing, yoga) | Done |
| Exercise images from wger.de | Done (32/201) |
| Exercise search (wger + AI) | Done |
| 12-muscle-group fatigue system | Done |
| Recovery readiness + muscle bars | Done |
| In-app workout -> fatigue pipeline | Done |
| Progressive overload display | Done |
| Manual activity logging (5 categories) | Done |
| Weight tracking (unified) | Done |
| Food search (USDA + AI fallback) | Done |
| Barcode scanning (OpenFoodFacts) | Done |
| Meal planning (AI, 5 templates) | Done |
| Food photo scanning | Done |
| Nutrition tracking (macros + micros) | Done |
| Workout-aware nutrition tips | Done |
| AI coach (unified) | Done |
| Body scan (AI photo analysis) | Done |
| Progress history + PRs | Done |
| Data export (CSV) | Done |
| 27 themes (20 dark, 7 light) | Done |
| Weekly check-in | Done |
| Push notification reminders | Done |
| Splash screen (Thallo logo) | Done |
| Onboarding "worked out recently" | Done |
| Add Food unified flow (barcode/photo/search) | Done |
| Apple Health read (HR, steps, sleep) | Done (needs dev build) |
| Apple Health auto-import workouts | Not wired |
| Apple Health write workouts | Not wired |
| Error monitoring | Not configured |
| App icon (designed) | Needs design |
| Social sharing | Not built |
| Subscription/paywall | Not built |
