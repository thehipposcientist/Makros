# Workout System — Architecture

Last updated: 2026-04-29

## Pipeline

```
User Profile → GoalProfile → WeeklyRecipe → DayArchetype → Slots → ExerciseSelection → Prescription
```

## Persistence Model: PlanWeek (NEW)

The front-page schedule is driven by a fixed 7-day **PlanWeek** with dated
`PlanDay` rows. The 7 days are generated together and **never regenerated
mid-week** — past days accumulate as done / skipped, today is highlighted,
forward days remain queued. A new PlanWeek only generates when the
current one's `end_date < today`. See
[`plan-persistence.md`](./plan-persistence.md) for the full model.

The deterministic planner (this doc) runs at PlanWeek creation /
auto-renew time and at per-day patch time. The legacy "fresh day on app
open" regen is **removed**.

## Key Service Files (`backend/app/services/workout/`)

| File | Purpose |
|---|---|
| `goal_profiles.py` | Maps goals to training mix, allowed archetypes, planner mode. `_PROFILE_OVERRIDES` routes longevity/healthy_aging/heart_health → general_health. |
| `weekly_recipe.py` | Generates weekly archetype sequence. Separate recipe fns per goal family. `_inject_hybrid_cardio` promotes lift days to PLUS_CARDIO AFTER adjacency repair. |
| `archetypes.py` | Every day archetype definition. `LIFT_*`, `COND_*`, `MOBILITY_*`, `RECOVERY_*`, `HYBRID_*`, and v3 `LIFT_*_PLUS_CARDIO`. PLUS_CARDIO categorized as `lift`, `training_type="mixed"`. |
| `focus_profiles.py` / `focus_normalize.py` | FocusProfile (split_bias, volume_bias, min_exposure_days). `_FINE_TO_COARSE` maps push/pull/legs → upper_body/lower_body. |
| `day_templates.py` | Picks splits, maps archetypes to exercise slots. Dispatches PLUS_CARDIO to cardio-finisher slot functions. |
| `slots.py` | Slot definitions + `density_adjust_slots`. Drop order: warmup → core → isolation → secondary. Primaries never dropped. Cardio finisher (isolation role) drops first on SHORT (≤30 min) sessions. |
| `planner.py` | Orchestrator: slot filling, scoring, exercise selection, injury blocking, dislike filtering. `build_planner_exercise` is the canonical exercise dict helper — all code paths must use it. Also houses `generate_recovery_day()`, `generate_mobility_day()`, `generate_cardio_day()`. |
| `prescriptions.py` | Sets/reps/rest per archetype + slot role. Warmup always emits short DYNAMIC flow (2 sets × 6-8 reps, no rest, no static holds). |
| `set_programming.py` | Intra-workout set scheme, load increments, next-set recommendations. |
| `load_equipment.py` | Deterministic load snapping for adjustable dumbbells and plate-loaded equipment constraints. |
| `in_workout_review.py` | Next-set suggestions — deterministic first, AI only when suspicious. |
| `activity_impact.py` | 12-muscle-group fatigue model with decay, negative fatigue for recovery/mobility. |
| `fitness_score.py` | 4-pillar fitness score: strength 30, cardio 30, consistency 25, recovery 15. |
| `cardio.py` | Classifies exercises as intervals / steady / easy. |
| `plan_review.py` / `plan_ai_regenerate.py` | AI plan review PERMANENTLY DISABLED. These files are dead code entry points. |
| `plan_review_v2.py` | Deterministic weekly review. Emits `Recommendation[]` with structured `action` dicts. Exposed via `GET /workouts/weekly-review`. |
| `weekly_volume.py` | Per-muscle hard-set tracker. 5 tiers: undertrained/in_range/high/excessive/spike. 7d/14d/28d windows. `GET /workouts/weekly-volume`. |
| `core_programmer.py` | Intentional core placement. Goal × days frequency, category rotation, never-core archetypes. Supersedes `core_planning.py`. |
| `ai_first_time_weight.py` | AI starting-weight rec when transfer pipeline finds nothing. Returns weight only (rounded to 2.5 lb). Errors fall through to deterministic tier-6/7 defaults. |
| `rolling_e1rm.py` | `compute_rolling_e1rm(sets, role)` — Epley + RIR, recency-weighted median over last 6–10 usable sets. Returns `E1RMEstimate(e1rm_lbs, sample_count, confidence)` or `None` (<3 usable). |
| `switch_day.py` | `_canonical_cycle_for_split()` returns repeating rotation per split (PPL, UL, full_body, ppl_upper_lower, bro). Returns `None` only when no split is set. |
| `change_day_type.py` | Pure-function service: `DaySlot`, `Conflict`, `ChangeResult`. `detect_conflicts()`, `smart_adjust_remaining()`, `change_day_type()` orchestrator. |

## Hybrid Cardio Promotion (goal × days × duration)

- `_HYBRID_PAIR` maps lift archetypes (push/pull/upper/full_body + variants + bro-split + strength_maintenance) to PLUS_CARDIO equivalents. **Legs are never mapped** (hard lower + cardio = bad).
- `_DIRECT_PROMOTE_COUNT`: muscle_gain 5d→1, 6d→1, 7d→2; strength 5d→1, 6d→1, 7d→1; general_health 3d→1, 4-7d→2.
- body_recomp/fat_loss use `_promote_same_day_cardio` (merges adjacent lift+cardio pairs).
- Density trim: PLUS_CARDIO on SHORT session drops cardio finisher before any lift slot.

## Weekly Recipe Repair + Rotation

- `PLANNER_VERSION` stamped on every `WorkoutPlan`. Format `YYYY.MM.DD.nn`. Bump on archetype/slot/rep/rest/adjacency rule changes.
- `_repair_adjacent_duplicates` — three-tier sweep (Tier A strict safe swap, Tier B net-reducing, Tier C forced triple-break). Runs after interleaving cardio, after recent-focus rotation, and after intensity spacing.
- U/L forced-even-lift-days rule; PPL forced-multiple-of-3 rule; PPL→UL auto-convert at 4 lift days.
- Body_recomp on U/L = 2 heavy + 4 hypertrophy.
- 7-day allocation: add cardio, do NOT steal recovery. `_derive_recovery_days` forces 1 recovery day at 7 days.
- Mobility/recovery pinned to end of week.
- `_preserves_split_identity` guard after every post-processing pass — reverts if swap breaks split identity.

## Fatigue System (12 Muscle Groups)

Groups: `chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, cardio, systemic`

- Decay: day 0 = 1.0 / day 1 = 0.50 / day 2 = 0.25 / day 3 = 0.10
- Recovery/mobility days have NEGATIVE fatigue (recovery: -0.08/muscle, -0.10 systemic; mobility: -0.05/muscle, -0.08 systemic)
- Two-pass rolling fatigue: Pass 1 accumulates; Pass 2 applies recovery (max 1 session/day, 15% of current fatigue, capped at 0.15). Fatigue floor clamped at 0.0.
- Focus auto-correction on completion via `_infer_focus_from_muscles`.
- Graduated planner response: ≥60% proceed / 40-60% downgrade / 20-40% swap focus / <20% force recovery.
- `/workouts/fatigue` returns `nutrition_context` (protein status + message). Protein thresholds: excellent ≥95%, good ≥80%, low ≥60%, very_low <60% of target. Bonus reduces fatigue at ≥95%; penalty increases it at 60-80%.

## Multiple Completions Per Day

Upsert key: `(user, date, focus)` — legs morning + sauna evening = 2 rows. Prevents second activity from overwriting first.

## Generation Consistency (PlanWeek create, auto-renew, change-focus, single-day patch)

All entry points must pass the same shape of inputs. Audited Apr 2026:
- All query `most_recent_completed_focus(hours=240, limit=10)` and pass `recent_focus_buckets` + `recent_focus_families`.
- All compute `muscle_fatigue` via `compute_rolling_fatigue` + `injury_muscle_fatigue_boost`.
- All route through `generate_workout_plan` → `generate_weekly_recipe` → `_repair_adjacent_duplicates`.
- All pass optional `load_equipment_settings` from `UserPreferences.equipment_settings` so planned and in-workout loads respect adjustable dumbbell range/step and available plate pairs.
- **Focus mismatch fallback**: when requested focus isn't in recipe, the endpoint regenerates with `preferred_split` forced to the family containing that focus. Old behavior was label-only.

**Entry points (post-PlanWeek migration):**

| Endpoint | Purpose |
|---|---|
| `POST /plans/start-new-week` | Generates a fresh 7-day PlanWeek anchored on the most recent Monday. First-run setup. |
| `POST /plans/week/auto-renew` | When the active PlanWeek's `end_date` has passed, generates the next 7 days. Idempotent while still active. |
| `PATCH /plans/days/{day_date}/workout` | Per-day workout swap (Switch Day, manual edits, AI swaps). |
| `POST /plans/week/review-and-apply` | Applies user-selected weekly check-in recommendations and regenerates remaining days. |
| `POST /workouts/generate-day` | **Legacy** — used by the now-removed daily fresh-day regen. Still defined; no active caller on the front page. |
| `POST /workouts/generate-week` | **Legacy** — used by the legacy Switch Day flow before the PlanWeek model. Active for the migration tail. |

## Recovery/Mobility Day Scaling

`generate_recovery_day()` and `generate_mobility_day()` scale to `session_minutes` (20–60 min progressive exercise additions).

## Injury System (Three Layers)

1. Movement-pattern blocking — active injuries hard-block dangerous patterns.
2. Recovering mode — allows exercises at reduced volume.
3. Muscle-group mapping — each injury maps to affected muscle groups for fatigue.

Coverage: lower_back, knee, shoulder, hip, hamstring, ankle, achilles, elbow, tennis_elbow, golfer_elbow, wrist, chest, neck. Body part picker (not free text). `InjuryEntry` fields: muscleGroups, severity, estimatedRecoveryDays, estimatedRecoveryDate, statusUpdatedAt.

## Plan-View Exercise Swap

- `src/utils/swapScoring.ts` — shared scoring (muscle overlap + compound bucket + movement pattern + equipment class). `rankSwapCandidates(base, library, ownedEquipment, limit)` used by both in-workout and plan-view.
- Client: "Swap" chip on every `WorkoutCard` exercise row → `PlanSwapExerciseModal`.
- Library lazy-fetched via `ensureExerciseLibrary()` on first swap tap.

## actual_rir + Rolling e1RM

- **Column**: `ExerciseSet.actual_rir DOUBLE PRECISION` — migration: `_ensure_exercise_set_actual_rir_column`. Stored separately from `rpe` (RIR = forward-looking; RPE = perceived exertion).
- **Helper**: `rolling_e1rm.py::compute_rolling_e1rm(sets, role)`.
- **Math**: `set_e1rm = w * (1 + (reps + actual_rir) / 30)` (Epley), recency-weighted `exp(-days_since * ln(2) / 14)` (14-day half-life), weighted median across last 6–10 usable sets.
- **Filters**: completed=True, not warmup, role-aware rep band (compound 3–10 / isolation 6–15), RIR in [0,4], weight > 0.
- **Returns**: `E1RMEstimate(e1rm_lbs, sample_count, confidence)` — confidence: high/med/low. `None` if <3 usable sets.
- **Status**: Column and helper implemented. UI capture of actual_rir during log-set not yet wired.

## Change Focus / Day Type

- `services/workout/change_day_type.py` — pure-function service for changing a day's focus within the week.
- `_canonical_cycle_for_split()` in `switch_day.py` returns repeating rotation per split. `None` only when split is unset.
- Smart mode: freezes days before target + completed/locked days; greedy adjacency-aware placement into free slots.
- Single-regen pattern: batch all lift-needed days into one `generate_workout_plan` call, pull matching focus days by family.
- Split override only applies when the focus family is not in the current split's canonical cycle.

## Supported Goals

`fat_loss, muscle_gain, body_recomp, strength, endurance, athletic_performance, hyrox, toning, maintain, general_health, longevity` (UI: "Healthspan"), `flexibility, stress_relief`

Longevity/healthy_aging/heart_health → general_health via `_PROFILE_OVERRIDES`. Flexibility/stress_relief → dedicated mobility + recovery profiles.

## Supported Splits

PPL, Upper/Lower, Full Body, PPL+UL hybrid, Bro split (auto-selected based on goal + days).
