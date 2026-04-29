# Roadmap + Next Improvements

Last updated: 2026-04-29

> See `docs/product/backlog-review.md` for items whose shipped status is ambiguous.

---

## Recently Shipped

- **PlanWeek migration (Apr 28, 2026)** — front-page schedule moved from
  the legacy rolling-from-today cycling-array model to a fixed 7-day
  PlanWeek with dated `PlanDay` rows. Daily fresh-day regen on app open
  removed. Auto-renew at week end. Past days render as done / skipped
  from history; today highlighted by date match. See
  `docs/architecture/plan-persistence.md`.
- **Active workout recommendation cleanup (Apr 29, 2026)** — rest-time recommendations now refresh without waiting on a bottom "How did it feel?" prompt, that prompt was removed, RIR is only asked on significant overshoots, and the refreshed recommendation is pushed to Apple Watch during the rest window.

---

## Performance / Observability

- **Backend log structuring**: `KeyError("Attempt to overwrite 'created'")` from `gut_backfill` startup pollutes Sentry. Move to `extra={...}` keys that don't collide with `LogRecord` reserved names.
- **Per-route latency budgets**: `/workouts/weekly-review` and `/meals/score` are hot paths. Add `time.perf_counter()` log line with route + duration.
- **AI cost tracking**: `ai_classify.estimate_amounts` runs once per unique food forever. Add counter so "AI calls per week per user" is auditable.
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
- **Not surfaced**: no pace trend chart, no output progression, no "your 5k pace improved 8 seconds" signal.
- **Unlock**: a simple cardio performance tab on ProgressScreen. Pace/power over time by activity type. Especially valuable for endurance-goal users.

### Heart Rate Data
- `hr_summary: {avgBpm, maxBpm, zoneMinutes}` is written on every `WorkoutCompletion` row.
- **Not surfaced**: no zone breakdown per session, no "time in Zone 2 vs Zone 4" history, no resting HR trend.
- **Unlock**: Zone 2 time-in-zone history chart. Zone2TargetCard exists but uses Apple Health minutes, not workout-logged HR. Workout-logged HR would be more accurate.

### Soreness Tracking
- `soreness_areas` is captured on WorkoutCompletion (e.g. `["lower_back", "quads"]`).
- **Not surfaced**: not shown on history, not fed into the fatigue model.
- **Unlock**: feed `soreness_areas` into `compute_rolling_fatigue` as a fatigue signal multiplier. A user reporting quad soreness should raise quad fatigue independently of volume-load decay. Also: show soreness history on the body heat map (overlay of "reported sore" vs "model says fatigued").

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
| **PlanWeek migration cleanup** | New PlanWeek path is live and the daily regen block removed | Retire the legacy `get7DaySchedule` fallback once telemetry shows zero callers; same for the legacy `generateWorkoutDay` API client. Migrate Switch Day to call `PATCH /plans/days/{day_date}/workout` instead of the old `generateWorkoutWeek`. |
| **Social workout sharing** | `ShareWorkoutModal` component exists but disabled | Re-enable when social feed launches |

---

## Feature Work (not yet shipped)

- **actual_rir trend surfacing** — per-set capture now exists; the next step is trend/history UI and clearer progress coaching based on the stored effort signal.
- **Watch complication build pass** — finish SharedDefaults wiring + entitlements (#110).
- **Siri intent build pass** — Intents extension target + deep-link handler (#111).
- **Pre/post-workout time-aware fueling card** — fires when planned workout is in next 2–3h or just finished.
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
- **HR zone analysis** — zone time-in-band history (Zone 2 / Zone 4 / Zone 5) from `hr_summary` on completions. More granular than Apple Health minutes.
- **Soreness → fatigue feedback** — feed `soreness_areas` on WorkoutCompletion into `compute_rolling_fatigue` as a per-muscle fatigue signal. Reported soreness is a direct proxy for muscle damage that decay-only models miss.

---

## UI Polish

- Migrate remaining direct `readHealthSummary` consumers (HomeScreen, ActiveWorkoutScreen) to `getHealthDataSummary`.
- **Quick-intent action wiring**: auto-apply on user confirm when chat returns structured action (e.g. `shorten_workout`).
- **Cardio metric hints**: show contextual field labels in the MetricField list based on exercise type (e.g. hide "watts" for treadmill, show pace/incline).
- **Body heat map dual overlay**: show both model-computed fatigue AND user-reported soreness as separate color layers so the user can see where the model and their body agree or diverge.

---

## AI Improvements

See `docs/architecture/ai-coach-system.md` → Recommended AI Improvements.
