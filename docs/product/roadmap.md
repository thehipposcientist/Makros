# Roadmap + Next Improvements

Last synced from CLAUDE.md: 2026-04-27

> See `docs/product/backlog-review.md` for items whose shipped status is ambiguous.

## Performance / Observability

- **Backend log structuring**: `KeyError("Attempt to overwrite 'created'")` from `gut_backfill` startup pollutes Sentry. Move to `extra={...}` keys that don't collide with `LogRecord` reserved names.
- **Per-route latency budgets**: `/workouts/weekly-review` and `/meals/score` are hot paths. Add `time.perf_counter()` log line with route + duration.
- **AI cost tracking**: `ai_classify.estimate_amounts` runs once per unique food forever. Add counter so "AI calls per week per user" is auditable.
- **DB query budget**: `compute_weekly_volume` runs 4 queries. Consider aggregated SQL rollup at 28-day windows on heavy users.

## Tests to Add (minimal-effort, high-leverage)

- `plan_review_v2._build_headline` — pure-function, no DB.
- `carb_distribution.classify_day` + `redistribute_macros` — pure-function, no DB.
- AI estimator regression — mock OpenAI, verify collagen ≤30g + CFU ≤200B + confidence enum.
- Plan review snapshot — 5 completions over 7 days, expect specific rec keys.
- Watch payload schema — `WatchWorkoutPayload` JSON round-trip through Swift `Codable`.

## Feature Work (not yet shipped)

- **actual_rir capture on log-set screen** — column and helper exist; UI capture missing. Unlocks smarter progression + real-effort signal.
- **Watch complication build pass** — finish SharedDefaults wiring + entitlements (#110).
- **Siri intent build pass** — Intents extension target + deep-link handler (#111).
- **Pre/post-workout time-aware fueling card** — fires when planned workout is in next 2-3h or just finished.
- **Functional-pattern archetypes** — `HYBRID_KB_COMPLEX`, `HYBRID_CARRY_FOCUS` for kettlebell/sled users.

## Medium-Impact Workout Enhancements

- **Tempo prescription** — eccentric/pause/concentric tempos per exercise. Store `tempo` on ExerciseSet.
- **Dropsets / Rest-pause / Myo-reps** — advanced set types.
- **Equipment upgrade recommendations** — "gear to consider" card.
- **Readiness-based auto-deload** — deload week when readiness <threshold for 3+ days.
- **In-workout 1RM display** — estimated 1RM on active exercise card after each set.
- **Wave loading / periodization** — multi-week loading patterns + mesocycle tracking.
- **Cycle-phase-aware training** — auto-adjust volume by phase via `healthDataSummary` → planner.

## UI Polish

- Migrate remaining direct `readHealthSummary` consumers (HomeScreen, ActiveWorkoutScreen) to `getHealthDataSummary`.
- **Weekly review Apply-action wiring**: `WeeklyCoachingCard` "Apply" button currently shows "Got it" alert — wire each `action.type` to a real state mutation.
- **Quick-intent action wiring**: auto-apply on user confirm when chat returns structured action (e.g. `shorten_workout`).

## AI Improvements

See `docs/architecture/ai-coach-system.md` → Recommended AI Improvements.
