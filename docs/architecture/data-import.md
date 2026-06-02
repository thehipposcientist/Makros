# Importing User Data from Competitor Apps

Last updated: 2026-05-12
Audience: product + engineering, for "easy migration from <app>" planning.

When a user switches from MyFitnessPal, Cronometer, Hevy, Strong, Strava, etc., they bring history — meals, foods, workouts, body weight, PRs. Letting them import that history is one of the highest-leverage retention features: it removes the "I'd switch but I'd lose 4 years of meal logs" objection.

This doc covers what's importable from which app, how hard each pathway is, and a recommended phased sequence.

## TL;DR

| Source | What we'd import | API? | CSV export? | Effort | Priority |
|---|---|---|---|---|---|
| **Apple Health** | Detected workouts, weight, sleep, HR | n/a (native) | n/a | ✅ Shipped | Done |
| **MyFitnessPal** | Meals, foods, recent weight | ❌ paid-only / shut down | ⚠️ via website | High | High value, hard path |
| **Cronometer** | Meals, foods, biometrics | ✅ paid Gold API | ✅ CSV | Medium | Niche but enthusiast users |
| **Hevy** | Workouts, sets, PRs | ✅ public | ✅ CSV | Low | High value for strength users |
| **Strong** | Workouts, sets, PRs | ❌ | ✅ CSV (paid feature) | Low | High value for strength users |
| **Strava** | Activities (runs, rides) | ✅ OAuth | ⚠️ bulk download | Low-Medium | Endurance cohort |
| **Garmin Connect** | Activities, sleep, body comp | ⚠️ partnership | ✅ TCX/GPX bulk | High direct / Low via Health Connect | Skip direct |
| **WHOOP** | Workouts, recovery (paid HK pipe) | ⚠️ approval | ❌ no bulk export | Medium-High | Defer |
| **Oura** | Sleep, readiness, activities | ✅ self-serve | ✅ CSV | Low-Medium | Phase 2 with API integration |
| **Fitbit** | Activities, sleep, weight | ✅ rate-limited | ✅ Google Takeout | Medium | Android only — via Health Connect |
| **Generic CSV** | Meals, weight, workouts | n/a | ✅ | Low | Catch-all worth building |

**Strategic recommendation:** the MFP, Strong, and Strava v1 import paths are now shipped. The next import work should be activation and trust: pending-import reminders, manual review for unmatched foods/exercises, clear success/failure summaries, and import telemetry. Hevy and generic CSV follow as the third tier. Direct OAuth integrations beyond Strava are a Phase 3 luxury.

---

## Why Imports Matter

Three reasons users hesitate to switch apps:

1. **Loss of history.** "I've been logging on MFP for 5 years."
2. **Re-entering preferences / favorites.** Their 50 frequent foods, their custom recipes, their default workouts.
3. **Inertia.** Even if Thallo is better, switching has activation energy.

A good import flow attacks all three. The bar isn't perfect fidelity — it's "enough that the first week in Thallo feels populated, not empty."

---

## MyFitnessPal — The Big One

### State of MFP's API

- The public Diary API was sunset in 2020. Existing partners are grandfathered; new applications are rejected.
- The paid `mfp-api` (premium-tier scraping endpoint) is technically reverse-engineered, not officially supported. Using it risks Terms of Service violations.
- Users *can* export their own data via web → Settings → "Request a copy of my data" (GDPR/CCPA flow). Returns a ZIP with `Food_Diary.csv`, `Exercise_Diary.csv`, `Measurements.csv`, `Recipes.csv`.

### Recommended approach: CSV upload

1. Settings → "Import from MyFitnessPal" → instruction screen with screenshots of the MFP export flow.
2. User receives email from MFP (1-7 day wait), uploads the ZIP into Thallo.
3. Backend parser maps MFP food entries → Thallo `Food` + `Meal` rows. Matching strategy:
   - Exact-name match against the seeded `Food` table first.
   - USDA FDC lookup fallback (already integrated; serves as the authoritative nutrition source).
   - AI fallback (gpt-4o-mini) for unmatched custom foods — same path as the existing `/ai/food-classify` route.
4. Imported meals get `Meal.import_source='myfitnesspal'` and a separate `Meal.imported_at` timestamp so they're visually distinct from native logs (greyed out, "imported" badge).
5. Body weight rows map directly into `WeightEntry`.

**Effort: 4-7 days.**
- 1 day: parser + USDA matching pipeline.
- 1-2 days: AI classification fallback (mostly reuse existing).
- 1 day: idempotency (re-uploading same ZIP doesn't duplicate).
- 1 day: UI / instruction flow.
- 1-2 days: edge cases (custom recipes that reference other custom foods, missing serving sizes, encoding issues).

**Risk:** MFP changes their export format every ~12 months. Build the parser to be forgiving and log unparseable rows for debugging.

### Companion mode: Apple Health pass-through

For users who do not want to leave MyFitnessPal, use Apple Health as the live-ish bridge. MyFitnessPal writes meal summaries to Apple Health; Thallo reads dietary calories/protein/carbs/fat through HealthKit and shows the setup/status in Progress → Health. This path is summary-only: no individual foods, recipes, or MFP timestamps are imported, and the values should be modeled as external daily nutrition snapshots before they influence server-authoritative meal scoring.

### Alternative: deep-link import without CSV

`mfp://` URLs work on iOS if the user has MFP installed. We could in theory deep-link `mfp://browse/food/<food_id>` and screen-scrape. **Don't do this.** Brittle and an obvious ToS violation.

---

## Cronometer

### State of the API

- Cronometer offers a Gold-tier API ($9.99/mo per user). The user needs Gold to authorize Thallo.
- Self-serve developer registration; OAuth 2.0.
- Endpoints for foods, meals, biometrics, exercises.

### Recommended approach: CSV import first, API later

Cronometer's CSV export is comprehensive and free (no Gold required):
- Settings → Account → "Export Data"
- Returns daily food intake, biometrics, and notes as CSV files.

**Effort: 2-3 days for CSV import** (reuse the MFP parser with minor schema differences).

OAuth integration is Phase 3 only and only if a meaningful Cronometer-Gold cohort emerges. Cronometer users are typically more enthusiast-tier than MFP users — smaller cohort, higher willingness to pay.

---

## Strength App Imports — Hevy, Strong

Strength athletes are extremely attached to their PR history. Importing it well is the difference between a switch and a non-switch.

### Hevy

- Public API at `https://api.hevyapp.com/v1` — free, OAuth 2.0, generous limits.
- CSV export also available in-app (Settings → Export workouts).
- Schema: workouts → exercises → sets (weight, reps, RPE).

### Strong

- No public API.
- CSV export is a paid-tier feature in Strong (Pro subscription).
- Schema: similar to Hevy — workouts → exercises → sets.

### Mapping to Thallo

Both apps export sets with `weight` + `reps` + sometimes `RPE`. Thallo's `WorkoutCompletion` + `ExerciseSet` schema accepts these directly. The hard part is the **exercise name match**:

1. Exact-name match against seeded `Exercise.name` + `aliases`.
2. Fuzzy match using the same token-set algorithm in `demo_resolver.py`.
3. If no high-confidence match, ask the user once: "We don't recognize 'Cossack Squat' — map to 'Bulgarian Split Squat' or skip?" and persist the mapping in `UserPreferences.imported_exercise_map`.

Imported workouts feed the same fatigue/progression pipeline as native logs. PRs surface in the existing performance views without special handling.

**Effort: 3-5 days per source** for CSV. The Hevy direct API is ~2 extra days on top of the CSV parser (reuses the mapping logic).

---

## Strava — Activities

Important for the endurance / hybrid cohort. Imports running, cycling, swimming, hiking activities with GPS, pace, HR, and (for some watches) power.

### API

- Public, self-serve OAuth 2.0.
- Webhooks supported for new activities going forward.
- Bulk historical import via `/athlete/activities?per_page=200&page=N` (paginate).
- Each activity has `type`, `distance`, `moving_time`, `average_heartrate`, `average_speed`, `average_watts`, etc.

### Mapping to Thallo

Strava activities → `WorkoutCompletion` rows with `focus='cardio'` + `category` derived from `type` (Run, Ride, Swim, Hike, etc.).

GPS / HR streams (`average_speed`, `heartrate`) feed Thallo's cardio performance service when that ships (see `docs/product/roadmap.md` → "Cardio performance service").

**Effort: 4-6 days.** Includes the OAuth flow, paginated backfill, mapping table, and idempotency.

---

## Apple Health — Already Shipped

`workoutAutoImport.ts` + `DetectedWorkoutsCard` already lets users import HK workouts (their own Apple Watch sessions, WHOOP-sourced sessions, third-party app workouts that write to HK). See [`healthkit.md`](./healthkit.md).

This is the universal iOS fallback — anything that writes to HK is importable. No additional work needed except expanding the detected-workout mapping table when new categories emerge.

---

## WHOOP / Oura / Garmin — Background Sync, Not Import

These are continuous-sync devices, not import sources. For each:

- **WHOOP & Oura**: covered by Apple Health on iOS. The "import" question becomes "should we backfill the last 6 months of HK data on first install?" Answer: yes, on first onboarding, run a backfill against the existing HK readers.
- **Garmin**: HK passthrough only via Health Sync ($3 third-party app). Document this for users.
- See [`wearable-integrations.md`](./wearable-integrations.md) for the direct-API discussion.

---

## Generic CSV Import — Catch-All

For users coming from less popular apps (LoseIt, FatSecret, Jefit, custom spreadsheets), a generic CSV upload solves the long tail.

### Schema expectation

Document a simple, opinionated format:

```csv
date,meal_type,name,calories,protein_g,carbs_g,fat_g
2026-05-08,breakfast,Greek yogurt,120,20,8,2
2026-05-08,lunch,Chicken bowl,650,55,80,15
```

Plus separate optional files for weight, workouts, etc. Generic CSV import doesn't try to be smart — it accepts what the user gives.

**Effort: 1-2 days** (mostly the parser is the same as MFP, just with a simpler schema).

---

## Implementation Notes Common to All Imports

### Source-of-truth boundary

Imported data goes into the *same* tables as native data (`Meal`, `WeightEntry`, `WorkoutCompletion`, `ExerciseSet`) — never a parallel "imported_meals" table. This keeps the rest of the app (scoring, fatigue, progression) source-agnostic.

The discriminator is a `source` column (`'native' | 'myfitnesspal' | 'cronometer' | 'hevy' | 'strong' | 'strava' | 'csv' | 'apple_health'`) plus an `imported_at` timestamp. Already partially in place — extend as new sources are added.

### Idempotency

Re-uploading the same export file must not duplicate rows. Strategy: compute a stable `import_hash` per row (e.g. `sha256(source + external_id + date + name)`) and dedupe on insert. Imports include their own `import_batch_id` for "undo the last import" UX.

### Visual distinction in UI

Imported entries should look different — greyed out, smaller "imported" badge, optionally clustered. They're useful for history but shouldn't compete with native logs visually. Users can convert an imported meal to native by editing it (drops the `source` flag).

### Privacy

User-uploaded ZIPs may contain PII, GPS, and health data. Process them:
- In-memory if small enough; temp file with explicit cleanup if not.
- Never persist the raw upload — only the parsed rows.
- Log only counts/error categories, never row contents.
- Reject obvious junk (size limits, malformed CSV).

### "Failed to import" surfacing

Imports rarely match 100%. Show a per-source summary:
> Imported 1,247 of 1,302 meals from MyFitnessPal.
> 55 entries couldn't be matched to a food — review or skip.

A "review failed imports" screen lets the user manually match the misses. Don't silently drop them.

---

## Recommended Phased Sequence

**Phase 0 — Awareness layer (2 days). 🚧 In progress.**
0a. ✅ `UserPreferences.pending_imports` schema + migration (shipped 2026-05-10).
0b. Onboarding "Coming from another app?" multi-select step that opens MFP's data-export page in a WebBrowser, marks `pending_imports`, and continues onboarding. **Skipped per 2026-05-10 priority — Settings → Import is the path for now.**
0c. HomeScreen `PendingImportBanner` + 3-day / 7-day local notification reminders. **Deferred.**

**Phase 1 — MyFitnessPal (5-7 days).** ✅ **Backend + frontend shipped 2026-05-10.**
1. ✅ MFP CSV parser (`backend/app/services/imports/mfp_parser.py`) — pure-function, 16 tests pass. Handles 90-day web export + GDPR ZIP, multiple date/encoding formats, embedded vs separate-column quantity.
2. ✅ Matcher (`mfp_matcher.py`) — exact / alias / token-containment / Jaccard against local `Food` table. 14 tests pass. USDA + AI fallback hooks present, unwired (returns fallback rows with parsed macros).
3. ✅ Pipeline + upload endpoint (`mfp_pipeline.py` + `routers/imports.py`) — `POST /imports/myfitnesspal/upload` accepts multipart, runs parse → match → idempotent Meal+MealItem insert, returns `ImportBatch` with counters.
4. ✅ Frontend `ImportScreen.tsx` (Settings → IMPORT → "Import from another app") + `services/imports.ts` API client + per-source instruction cards + file picker via `expo-document-picker` + status polling at 2s intervals + history list with per-batch rollback. Manual-review modal for unmatched rows is deferred — current fallback path imports raw macros without a Food link, which is good enough for v1.

**Phase 2 — Strong + Strava.** ✅ **Backend + frontend shipped 2026-05-10.**
5. ✅ **Strong CSV import**. `strong_parser.py` + `strong_matcher.py` + `strong_pipeline.py`. Parses Strong export (12 tests pass), kg→lbs normalization, multi-format duration parsing ("30m", "1h 15m", "1:15:00", bare minutes), exercise-name token-set match against seeded `Exercise` table. `POST /imports/strong/upload` creates `WorkoutSession` + `WorkoutExercise` + `ExerciseSet` + `WorkoutCompletion` rows. Idempotent on (date + workout_name + exercise + set_order + weight + reps) hash.
6. ✅ **Strava OAuth + bulk-activity backfill**. `IntegrationCredential` table for per-user OAuth tokens. `strava_client.py` owns authorize URL build, code exchange, token refresh. `strava_mapper.py` (15 tests pass) — pure-function activity dict → `WorkoutCompletion` shape with focus-label routing (Run → Run, Ride → Cycling, etc.), cardio_style heuristic from HR ratios. `strava_pipeline.py` paginates `GET /athlete/activities`, idempotent on Strava activity ID. Endpoints: `GET /imports/strava/authorize`, `GET /imports/strava/callback`, `POST /imports/strava/backfill?days=180`. Frontend uses `WebBrowser.openAuthSessionAsync` to capture the OAuth redirect back through the `thallo://imports/strava` scheme. **Requires `STRAVA_CLIENT_ID` + `STRAVA_CLIENT_SECRET` env vars** (register at strava.com/settings/api); without them, authorize returns 503 with config hint.

**Phase 3 — Long tail (1-2 weeks).**
7. Hevy CSV import (3 days). Same shape as Strong; covers users who don't pay for Strong Pro.
8. Generic CSV import (1-2 days). Catches LoseIt / FatSecret / spreadsheets.
9. Cronometer CSV import (2-3 days). Enthusiast cohort.

**Near-term import UX recommendations (May 12, 2026).**
- Pending-import banner on Home/You after onboarding or source selection.
- 3-day and 7-day local reminders when `pending_imports` has not completed.
- Import-success recap: counts imported, unmatched rows, rollback affordance, and next best action.
- Manual review for unmatched MFP foods and Strong exercises before building the next parser.
- Per-source telemetry: upload started, parse failed, rows imported, rows unmatched, rollback used.

**Phase 4 — Direct OAuth integrations (case-by-case).**
10. Hevy direct API — only if app feels limited by CSV cadence.
11. Cronometer Gold API — only if subscribed cohort exists.
12. Oura, WHOOP — see [`wearable-integrations.md`](./wearable-integrations.md). These are sync, not import.

**Phase 5 — Apple Health backfill.** ✅ Shipped 2026-05-10.
13. On first onboarding (and on Progress-tab Connect Health), runs a **180-day** backfill against the existing `healthDataSummary` readers so the body-check / readiness / weekly-review UIs are populated from day one. Chunked into two 90-day batches so the recent window paints first; older window backfills in the background. Existing users auto-catch-up via `ensureBackfillWindow(180)` on next Home open. Implementation: `backfillSnapshotsToBackend(180)` in `src/services/healthDataSummary.ts`. See `docs/architecture/healthkit.md` § Backend Persistence.

---

## What NOT to do

- **Don't reverse-engineer private APIs.** Users get banned, you get a cease-and-desist. CSV exports are the legitimate path.
- **Don't try to import recipes verbatim.** MFP recipes reference custom foods that reference other custom foods. Just import the meal as a single entry; let the user re-create recipes natively if they want.
- **Don't auto-merge identical-looking entries.** Two `"Chicken breast"` entries on different dates from MFP might be different cuts. Preserve them.
- **Don't import without idempotency.** Users will absolutely upload the same ZIP twice.
- **Don't gate import behind a paywall.** This is a switching-cost killer; making it free is the whole point.
