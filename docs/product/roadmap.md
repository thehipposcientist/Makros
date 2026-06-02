# Roadmap + Next Improvements

Last updated: 2026-05-24

> See `docs/product/backlog-review.md` for items whose shipped status is ambiguous.

---

## Recently Shipped

- **Outdoor cardio GPS route capture (May 2026)** — phone-side live/custom cardio tracking now uses `expo-location` only for outdoor run/walk/ride/hike sessions, capturing distance, pace, route coordinates, and altitude when available. Indoor cardio avoids GPS and uses manual/device distance. ActiveWorkout and LiveActivityTracker can pass `routeCoords` through workout completion; backend stores them on `WorkoutCompletion.route_coords`; HealthKit writes can include the route so Apple Fitness gets the workout path when present. Privacy docs must treat Location as collected for workout-scoped fitness use.
- **Fine-grained muscle emphasis tagging (May 11, 2026)** — new `Exercise.emphasis: list[str]` JSONB column with display-only fine-grained tags (front_delt / side_delt / rear_delt, upper/mid/lower chest, lats / upper_back / traps / lower_back, brachialis, gastroc / soleus, obliques / abs / lower_abs, adductors / abductors). Inference helper (`services/workout/emphasis_inference.py`) uses 108-entry override table + name-token rules. Always-re-infer backfill on startup so rule edits propagate without manual flush. 155/451 seed exercises tagged at ship; rest are correctly empty (cardio, full-body, already-specific primaries). Critical invariant: planner/fatigue model unchanged — still reads `primary_muscle` + `secondary_muscles` only. 25 pure-function tests pass. HomeScreen library detail card surfaces tags as a third meta row under primary/secondary. Drive-by fix: `plateau_detection._weekly_peaks_for_user` now threads `today` through (was using `date.today()` regardless of test-passed value — pre-existing flake that surfaced when calendar moved past test fixture dates).
- **Import UI shipped (May 10, 2026)** — Settings → IMPORT → "Import from another app" opens `ImportScreen` (multi-source picker, per-source step-by-step instructions, `expo-document-picker` for CSV/ZIP uploads, `WebBrowser.openAuthSessionAsync` for Strava OAuth, 2s status polling, history list with per-batch rollback). `src/services/imports.ts` is the typed API client. Auth-gated, theme-aware, ~360 lines of self-contained screen code; no new TS errors against baseline.
- **MFP / Strong / Strava import pipelines (May 10, 2026)** — full backend stack for all three sources. Schema: `ImportBatch` + `IntegrationCredential` tables, `Meal.import_*` + `WorkoutCompletion.import_*` columns with partial-unique-index idempotency. Parsers: `mfp_parser` (CSV + GDPR ZIP), `strong_parser` (workout CSV w/ kg→lbs normalization, multi-format duration), `strava_mapper` (activity dict → `WorkoutCompletion`). Matchers: token-set fuzzy match for foods + exercises against seeded `Food`/`Exercise` tables. Pipelines wire parse → match → idempotent insert + `ImportBatch` counter updates. Router endpoints: `/imports/{myfitnesspal,strong}/upload`, `/imports/strava/{authorize,callback,backfill}`, `/imports/{id}/status`, `/imports/` list, `DELETE /imports/{id}` rollback (dispatches per `data_type`). 53 pure-function tests across 4 new test modules; all pass. Strava endpoints stub when `STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET` are unset (clean 503 with config hint).
- **Pending-imports schema (May 10, 2026)** — `UserPreferences.pending_imports` added as JSONB (idempotent migration `_ensure_user_preferences_pending_imports_column`) with matching `PreferencesUpsert` pydantic field and preserve-on-empty upsert semantics. First piece of the MFP/Strong/Strava import awareness flow. Each entry is `{source, requested_at, notified_at?, completed_at?, dismissed_at?}` and drives the upcoming onboarding step + HomeScreen banner + 3d/7d local-notification reminders. All backend tests pass. See `docs/architecture/data-import.md` § Recommended Phased Sequence.
- **Apple Health 180-day backfill on first connect (May 10, 2026)** — `backfillSnapshotsToBackend` default raised from 30 → 180 days at both call sites (Onboarding "Connect Apple Health" success, Progress-tab connect flow). Implementation chunks into two sequential 90-day batches (backend `/health/snapshot/batch` caps at 90) with the most recent window pushing first so body-check / readiness / weekly-review surfaces populate immediately for switchers from Watch / WHOOP / Oura. Per-chunk failures don't abort the rest. See `docs/architecture/healthkit.md` § Backend Persistence.
- **Bundled local form demos (May 10, 2026)** — replaced GitHub raw hot-linking with bundled `assets/exercise-demos/<id>/{0,1}.jpg` frames (~21 MB ipa add, 174 ids). Hot-links worked in Expo Go but failed silently in TestFlight prod due to ATS + New Architecture image handling. Added `scripts/sync-exercise-demos.sh` to regenerate the static `exerciseDemoAssets.ts` require() map after seed edits. Also fixed dead `demoExerciseDbId` prop on `FormVideoModal` (it now actually renders the 2-frame demo card at the top per its JSDoc), and corrected aspect-ratio mismatches (4:3 containers wrapping 3:2 source photos = letterbox/zoom artifacts on detail surfaces). See `docs/architecture/workout-system.md` § Form Demo Asset Pipeline.
- **PlanWeek migration (Apr 28, 2026)** — front-page schedule moved from
  the legacy rolling-from-today cycling-array model to a fixed 7-day
  PlanWeek with dated `PlanDay` rows. Daily fresh-day regen on app open
  removed. Auto-renew at week end. Past days render as done / skipped
  from history; today highlighted by date match. See
  `docs/architecture/plan-persistence.md`.
- **Active workout recommendation cleanup (Apr 29, 2026)** — rest-time recommendations now refresh without waiting on a bottom "How did it feel?" prompt, that prompt was removed, RIR is only asked on significant overshoots, and the refreshed recommendation is pushed to Apple Watch during the rest window.
- **Watch complication + Smart Stack widget (May 3, 2026)** — Watch app now mirrors workout / readiness / hydration state into App Group SharedDefaults, embeds `ThalloWatchComplication`, and supports widget links for Start/Rejoin Workout and +8 oz hydration.
- **Sign-up-day PlanWeek cadence (May 2026)** — first `PlanWeek` now starts on the user's start day and auto-renew uses `prev.end_date + 1`, preserving a personal 7-day cadence instead of snapping to Monday.
- **Cycle-aware readiness/planning (May 2026)** — Apple Health menstrual-flow phase is now transiently passed into server readiness and PlanWeek generation/auto-renew for soft deterministic adjustments.

---

## Recommended Next Stack — May 18, 2026

These are the best next moves by leverage. They deliberately favor activation, speed, and trust over broad new feature surface.

### Performance

- **Split HomeScreen by product domain.** `src/screens/HomeScreen.tsx` is now ~20.8k lines with 164 `useState` occurrences. Extract Workout Plan, Meals, Friends, You/Settings, trainer chat, saved meals, imports, custom activity/GPS tracker handoff, and library/detail modal surfaces into focused containers and hooks.
- **Virtualize Progress history surfaces.** `src/screens/ProgressScreen.tsx` is ~13.1k lines with map-heavy `ScrollView` sections. Convert workout history, PR lists, imported activity history, body-scan history, health-insight lists, and plateau lists to `FlatList` / `SectionList`.
- **Centralize Active Workout timers.** `src/screens/ActiveWorkoutScreen.tsx` is ~13.3k lines with 4 `setInterval` references and 27 `setTimeout` references. Move rest/render ticks, autosave, Watch sync debounce, sidecar queue drains, GPS lifecycle, and modal handoffs into one owned timer/side-effect layer.
- **Measure before and after the split.** Add client marks for Home first paint, PlanWeek paint, workout-start-ready, and import-screen ready; add backend route timing for `/plans/week/active`, `/meals/score`, `/workouts/weekly-review`, `/imports/*/status`, and `/ai/*`.

### UI / UX

- **Finish the Settings hub.** `SettingsScreen` is now present for notifications, units, HealthKit, app settings, and account actions. Route Import, Data & Privacy, Watch/Health status, Gear, Theme, and Legal through the same stable Settings surface and retire duplicated Home/You modal controls.
- **Add pending-import activation UI.** The schema and ImportScreen exist; add Home/You banner, local 3-day/7-day reminders, and a post-import success recap.
- **Make effort/readiness surfaces actionable.** Show in-workout e1RM and deterministic next-set load suggestions from captured RIR; route plateau/readiness suggestions into the existing apply-action/check-in flow instead of ending in "Got it."
- **Show cache/offline state.** When Home paints from AsyncStorage because the backend is unreachable, display a small non-blocking cached/offline pill.
- **Do the beta accessibility sweep.** Icon-only buttons need labels, color-coded chips need text fallbacks, and workout/meal/Settings flows need Dynamic Type checks.

### Features

- **Finish import activation before adding the next parser.** Manual review for unmatched MFP foods plus pending-import reminders will convert more switchers than another long-tail source right now.
- **Make detected/imported workouts editable.** Any future Watch auto-detected cardio prompt, motion-assisted strength log, Apple Health import, or Strava import needs a review/edit path so users can correct activity type, duration, distance, sets/reps/weight, and notes before bad data becomes trusted progress history.
- **Make meal logging faster.** One-tap recent/favorite/routine meals, "save as favorite" after repeats, and grocery check-off improvements should be the next nutrition work.
- **Add optional coarse weather context for hydration/recovery.** Hydration already adapts to body size, age/sex, planned/completed workouts, active energy, protein, alcohol, sodium, and supplements. The pure function supports heat, but no weather source is wired. Add an opt-in setting that uses city/ZIP or OS approximate location to fetch weather facts (`temp_f`, `humidity_pct`, `heat_index_f`, `altitude_m`, `observed_at`) and stores those facts instead of raw coordinates. Use it for heat/humidity hydration add-ons, electrolyte copy, and outdoor-cardio recovery cautions.
- **Finish preference propagation.** Settings now has workout/meal/hydration reminders, quiet hours, weight unit, and distance unit. Apply those units consistently across history/charts/share/export surfaces, then add privacy-aware weather preference controls.
- **Persist coach transcript + undo applied actions.** Keep recent coach messages, show action history, and provide a short undo window after apply-action mutations.
- **Ship cardio/HR-zone progression.** Strava imports, Apple Health, and `hr_summary` already provide the raw data for pace/power/Zone 2 trend cards.

## Performance / Observability

- **Backend log structuring**: `KeyError("Attempt to overwrite 'created'")` from `gut_backfill` startup pollutes Sentry. Move to `extra={...}` keys that don't collide with `LogRecord` reserved names.
- **Per-route latency budgets**: `/workouts/weekly-review` and `/meals/score` are hot paths. Add `time.perf_counter()` log line with route + duration.
- **AI cost tracking**: `ai_classify.estimate_amounts` runs once per unique food forever. Add counter so "AI calls per week per user" is auditable.
- **Home / Progress / Active Workout split metrics**: track first paint, PlanWeek paint, workout-start-ready, and import-screen-ready before and after extraction so the refactor earns its keep.
- **Watch sync batching**: `syncInProgressWorkout` batched to every 3 sets via `lastSyncedSetCountRef` (Apr 28). Verify on next high-volume session that watch updates still feel responsive at the 3-set cadence.
- **Animation ref pruning in ActiveWorkoutScreen**: pruning hooked into `playExerciseCompleteStamp` (Apr 28); confirms refs for 20 slots cleared on exercise complete. Long sessions should no longer accumulate hundreds of stale `Animated.Value` refs.

---

## Tests to Add (minimal-effort, high-leverage)

- `plan_review_v2._build_headline` — pure-function, no DB.
- `carb_distribution.classify_day` + `redistribute_macros` — pure-function, no DB.
- AI estimator regression — mock OpenAI, verify collagen ≤30g + CFU ≤200B + confidence enum.
- Plan review snapshot — 5 completions over 7 days, expect specific rec keys.
- Watch payload schema — `WatchWorkoutPayload` JSON round-trip through Swift `Codable`.
- Week check-in logic — `compute_checkin_recommendations` with low-adherence + time blocker, too-easy + high adherence, pain area, missed cardio. Pure functions, no DB.

---

## Workout Data Gaps — Collected But Not Surfaced

These fields are written to the DB on every session but are never queried or shown to the user. Each is a low-cost unlock because the data pipeline already exists.

### RIR (Reps in Reserve)
- **`actual_rir` is captured per set** in ActiveWorkoutScreen ("how many more reps could you have done?") and written to `ExerciseSet.actual_rir`.
- **`rolling_e1rm.py`** already filters on `actual_rir IN [0, 4]` to exclude warmup sets.
- **Not surfaced**: no historical RIR trend, no "last 4 sessions you averaged 2 RIR at 185 lbs — ready to add load" signal.
- **Unlock**: feed `actual_rir` into the in-workout set recommendation card so it reads "you had 2 reps left last time at this weight — same or +2.5?" This is the highest-leverage single data connection in the app.

### Cardio Metrics
- Treadmill distance/pace/incline, bike cadence/output/watt, rowing SPM, swimming laps are all collected via `MetricField` in ActiveWorkoutScreen and written to the completion payload.
- **Now collected for outdoor cardio**: phone/Watch GPS can capture route-backed distance and pace for outdoor run/walk/ride/hike sessions.
- **Not surfaced**: no pace trend chart, no output progression, no "your 5k pace improved 8 seconds" signal.
- **Unlock**: a simple cardio performance tab on ProgressScreen. Pace/power over time by activity type. Especially valuable for endurance-goal users.

### Heart Rate Data
- `hr_summary: {avgBpm, maxBpm, zoneMinutes}` is written on every `WorkoutCompletion` row.
- **Not surfaced**: no zone breakdown per session, no "time in Zone 2 vs Zone 4" history, no resting HR trend.
- **Unlock**: Zone 2 time-in-zone history chart. Zone2TargetCard exists but uses Apple Health minutes, not workout-logged HR. Workout-logged HR would be more accurate.

### Soreness Tracking
- `soreness_areas` is captured on WorkoutCompletion (e.g. `["lower_back", "quads"]`).
- **Now wired**: shown in workout history / recent body insights and fed into `compute_rolling_fatigue` as a small next-day fatigue bump.
- **Remaining unlock**: make soreness visually distinct on the body heat map so users can compare "reported sore" vs "model says fatigued" instead of seeing only one recovery layer.

### Comfort Rating (Mobility/Stretch)
- `ExerciseSet.comfort_rating` field exists and is in the payload schema (`CompletedSetPayload`).
- **Not captured**: frontend never prompts for it during mobility or stretch exercises.
- **Not surfaced**: never queried.
- **Unlock**: for exercises flagged as `mobility` or `flexibility`, show a 3-tap comfort rating (tight / neutral / loose) instead of weight/reps. Feed into recovery insights.

---

## In-Workout UX Gaps

- **Live estimated 1RM after each set**: `rolling_e1rm.py` and `performance.py` are production-ready. Just needs a small chip on the active exercise card: "Est. 1RM: 225 lbs ↑3 from last session". Already on roadmap, infrastructure is done.

- **RIR → next-set load suggestion**: RIR is asked but the answer is never used in the same session. The in-workout review (`in_workout_review.py`) already has a two-stage suspicion detector. The next step is: when RIR is 0–1, suggest same weight; when RIR ≥3, suggest +2.5–5 lbs on the next set note. Simple rule, no AI needed.

- **Cardio metric field context**: MetricField options exist for treadmill/bike/row but no conditional rendering tells the user which fields apply to which exercise. A `"Fill in what's relevant"` hint with equipment-aware defaults would reduce cognitive load.

- **RIR signal is still underused**: recommendations no longer block on the RIR prompt, which fixed the main UX issue. The remaining gap is using `actual_rir` more directly inside same-session deterministic load logic instead of mostly as a review/input signal.

- **Plateau detection → actionable response**: `plateau_detection.py` correctly identifies stalls and suggests deload/volume/swap. The UI loads plateau data into a modal state but responds with a "Got it" alert instead of routing to the weekly check-in or directly applying a recommendation. Wire plateau detection into the check-in modal's recommendation step.

---

## Near-Complete Features (Wire-Up Only)

These are built on the backend or partially built on the frontend but not connected end-to-end.

| Feature | Status | What's Missing |
|---|---|---|
| **In-workout 1RM display** | Backend done (`rolling_e1rm`, `performance.py`) | Small UI chip on active exercise card |
| **RIR → load suggestion** | Data collected, prompt flow cleaned up | Use `actual_rir` directly in the deterministic same-session load note instead of only as an overshoot/review signal |
| **Plateau detection response** | Detection done, modal state tracked | Wire to check-in recommendation instead of "Got it" alert |
| **Quick-intent action auto-apply** | Coach returns structured action | Apply on confirm instead of showing "Got it" |
| **Readiness-based auto-deload** | Readiness computed, deload logic exists | Trigger when readiness < threshold for 3+ consecutive days |
| **Weekly check-in → planner** | Writes to `UserCoachingState` / `UserPreferences`; `auto_renew_week` reads `volume_adjustment_pct` and applies a -20 deload trigger when readiness < 40 | Verify the deload propagates into the next PlanWeek's prescribed sets (sanity-check on a real low-readiness account) |
| **PlanWeek migration cleanup** | New PlanWeek path is live and the daily regen block removed | Retire the legacy `get7DaySchedule` fallback once telemetry shows zero callers; same for the legacy `generateWorkoutDay` API client. Ensure all Change Focus paths call `PATCH /plans/days/{day_date}/workout` instead of the old `generateWorkoutWeek`. |
| **Social workout share entrypoint** | Friends feed/posts endpoints and feed UI are live; `ShareWorkoutModal` exists but is not mounted from completed workouts | Add the share button/entrypoint and decide whether photos/captions ship for beta |

---

## Feature Work (not yet shipped)

- **actual_rir trend surfacing** — per-set capture now exists; the next step is trend/history UI and clearer progress coaching based on the stored effort signal.
- **Siri intent build pass** — Intents extension target + deep-link handler (#111).
- **Pre/post-workout time-aware fueling card** — fires when planned workout is in next 2–3h or just finished.
- **Optional weather-aware hydration** — opt-in approximate location or manual climate setting; never continuous GPS. Activate heat/humidity/altitude hydration guidance without changing nutrition scoring authority.
- **Functional-pattern archetypes** — `HYBRID_KB_COMPLEX`, `HYBRID_CARRY_FOCUS` for kettlebell/sled users.

---

## Medium-Impact Workout Enhancements

- **Tempo prescription** — eccentric/pause/concentric tempos per exercise. Store `tempo` on ExerciseSet. DB schema may already have the column; needs planner + UI.
- **Dropsets / Rest-pause / Myo-reps** — advanced set types defined in schema but UI and recommender don't handle them.
- **Equipment upgrade recommendations** — "gear to consider" card: e.g. "barbell access would let you do X and Y that your current plan can't prescribe."
- **Readiness-based auto-deload** — deload week when readiness < threshold for 3+ days. Logic exists, trigger missing.
- **Wave loading / periodization** — multi-week loading patterns + mesocycle tracking. Phase 2 placeholder in planner; nothing built.
- **Cycle-phase-aware training** — auto-adjust volume/intensity by menstrual phase via `healthDataSummary` → planner.
- **Cardio performance service** — pace trend, distance progression, output efficiency per cardio type. Data is being written; no analysis service or UI exists.
- **Weather-aware hydration context** — wire an optional coarse weather snapshot into `compute_hydration_target_oz(ambient_temp_f=...)` and electrolyte/recovery copy. Store weather facts, not raw background location.
- **HR zone analysis** — zone time-in-band history (Zone 2 / Zone 4 / Zone 5) from `hr_summary` on completions. More granular than Apple Health minutes.
- **Soreness heat-map overlay** — soreness now feeds fatigue; remaining UX is a separate visual layer for reported soreness vs modeled fatigue.

---

## UI Polish

- **Settings hub**: make Import / Notifications / Units / Weather & Hydration / Data & Privacy / Watch & Health / Account stable first-class rows.
- **Pending import banner**: drive users back to MFP / Strong / Strava imports after onboarding or source selection.
- **Offline/cache pill**: make cached Home data visible when backend reads fail.
- Migrate remaining one-off direct `readHealthSummary` consumers where they do not need raw HealthKit details; keep direct reads only for permission/connect flows and raw-detail refreshes.
- **Quick-intent action wiring**: auto-apply on user confirm when chat returns structured action (e.g. `shorten_workout`).
- **Cardio metric hints**: show contextual field labels in the MetricField list based on exercise type (e.g. hide "watts" for treadmill, show pace/incline).
- **Body heat map dual overlay**: show both model-computed fatigue AND user-reported soreness as separate color layers so the user can see where the model and their body agree or diverge.

---

## AI Improvements

See `docs/architecture/ai-coach-system.md` → Recommended AI Improvements.
