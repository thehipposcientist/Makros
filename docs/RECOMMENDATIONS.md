# Thallo — Recommendations & Roadmap

Last updated: 2026-04-18

## Immediate Actions

### 1. Get a USDA API Key (5 minutes)
Go to https://fdc.nal.usda.gov/api-key-signup. Paste into `backend/.env` as `USDA_FDC_API_KEY=your_key`. Currently rate-limited on DEMO_KEY.

### 2. Commit Your Work
Large batch of uncommitted changes.

### 3. Add Error Monitoring (30 minutes)
Add Sentry free tier — `npx expo install @sentry/react-native`.

### 4. Change SECRET_KEY for Production
Generate a real 64-character random string in `backend/.env`.

---

## Recently Completed

### In-App Workout -> Fatigue Pipeline [DONE]
ActiveWorkoutScreen now sends `activity_category`, `activity_subtype`, and `activity_intensity` with every workout completion. The backend resolves per-exercise muscle fatigue from the exercise list using `resolve_exercise_fatigue()`.

### Progressive Overload Display [DONE]
Each exercise card in ActiveWorkoutScreen now shows "Last: 135x8 -> Try 140 lbs" when previous session data exists and the planner has a target weight recommendation.

### Barcode Scanning [DONE]
OpenFoodFacts integration via `POST /ai/barcode-lookup`. Backend service in `services/openfoodfacts.py`. Frontend API call `lookupBarcode()` ready. Frontend barcode scanner UI needs `expo-camera` to be wired.

### Data Export [DONE]
CSV export for workout history and weight history. Available in Profile > Data section. Uses `expo-sharing` + `expo-file-system` to generate and share CSV files.

### Workout-Aware Nutrition Tips [DONE]
Daily nutrition targets now show contextual tips based on today's workout:
- Heavy training day: "Extra carbs around your workout for fuel"
- Cardio day: "Stay hydrated and replenish electrolytes"
- Rest day: "Prioritize protein and recovery nutrition"
- Regular training: "Keep protein high for muscle recovery"

### Weekly Check-In [ALREADY WORKING]
`CoachCheckinModal` triggers after 7 days from `weekStartDate`. Asks about energy, sleep, adherence.

### Offline Resilience [ALREADY WORKING]
Exercise library cached 24h. Workout plan in AsyncStorage. `generateWorkoutDay` fails gracefully to cached plan. Fatigue endpoint defaults to "Fresh" on failure.

---

## High Impact — Build Next

### Apple Health Auto-Import
`react-native-health` installed, HealthKit permissions configured, but no auto-import of workouts/steps/sleep. Would feed the fatigue system automatically.

### Push Notification Reminders
`expo-notifications` installed but unused. "Time for your Pull day" would boost engagement.

### Splash Screen and App Icon
Still using Expo defaults. Need designed assets for `icon.png` (1024x1024) and `splash.png` (1284x2778).

### Barcode Scanner UI
Backend is ready (`lookupBarcode` API). Need to add camera-based barcode scanning in the MealEditModal. Requires `expo-camera`.

### Onboarding Compression
Currently 10+ steps. Consider collapsing to: goal + physicals (step 1), schedule + equipment (step 2), foods (step 3). Smart defaults for the rest.

---

## Medium Impact — Polish

### Social/Sharing
`react-native-view-shot` + `expo-sharing` installed. Let users share workout summaries, PRs, body scan results as images.

### Workout-Aware Macro Adjustment
Currently tips only. Phase 2: actually adjust macro targets by +/- 10% on hard vs rest days. Simple multiplier on existing targets.

---

## Technical Debt

| Issue | Severity | Status |
|-------|----------|--------|
| USDA on DEMO_KEY | High | Needs prod key |
| SECRET_KEY is dev default | High (prod) | Needs real secret |
| No error monitoring | High | Needs Sentry |
| Tests broken locally | Medium | Need Docker runner |
| Exercise images: 32/201 | Low | wger coverage limit |

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
| Training day selector | Done |
| Active workout tracking | Done |
| Timed exercise support | Done |
| Exercise images from wger.de | Done (32/201) |
| 12-muscle-group fatigue system | Done |
| Recovery readiness + muscle bars | Done |
| In-app workout -> fatigue pipeline | Done |
| Progressive overload display | Done |
| Manual activity logging | Done |
| Weight tracking (unified) | Done |
| Food search (USDA + AI) | Done |
| Barcode lookup (OpenFoodFacts) | Done (backend) |
| Meal planning (AI, 5 templates) | Done |
| Food photo scanning | Done |
| Nutrition tracking (macros + micros) | Done |
| Workout-aware nutrition tips | Done |
| AI coach (unified) | Done |
| Body scan | Done |
| Progress history + PRs | Done |
| Data export (CSV) | Done |
| 27 themes (20 dark, 7 light) | Done |
| Weekly check-in | Done |
| Apple Health auto-import | Not wired |
| Push notifications | Not wired |
| Barcode scanner UI | Needs expo-camera |
| Error monitoring | Not configured |
| App icon/splash | Defaults |
| Social sharing | Not built |
