# Workout System — Architecture

Last updated: 2026-05-10

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
| `in_workout_review.py` | Next-set suggestions — deterministic rule review only. Suspicious sets attach reasons/trace; no AI chooses or persists live load/reps. |
| `activity_impact.py` | 12-muscle-group fatigue model with decay, negative fatigue for recovery/mobility. |
| `fitness_score.py` | 4-pillar fitness score: strength 30, cardio 30, consistency 25, recovery 15. |
| `cardio.py` | Classifies exercises as intervals / steady / easy. |
| `plan_review.py` / `plan_ai_regenerate.py` | AI plan review PERMANENTLY DISABLED. These files are dead code entry points. |
| `plan_review_v2.py` | Deterministic weekly review. Emits `Recommendation[]` with structured `action` dicts. Exposed via `GET /workouts/weekly-review`. |
| `weekly_volume.py` | Per-muscle effortful working-set tracker. 5 tiers: undertrained/in_range/high/excessive/spike. `high` alone is descriptive; `excessive`, `spike`, or high volume with poor recovery is actionable. 7d/14d/28d windows. `GET /workouts/weekly-volume`. |
| `core_programmer.py` | Intentional core placement. Goal × days frequency, category rotation, never-core archetypes. Supersedes `core_planning.py`. |
| `ai_first_time_weight.py` | Legacy AI starting-weight helper, not used by live next-set/pre-set recommendations. If re-enabled by a future caller, errors must fall through to deterministic tier-6/7 defaults. |
| `rolling_e1rm.py` | `compute_rolling_e1rm(sets, role)` — Epley + RIR, recency-weighted median over last 6–10 usable sets. Returns `E1RMEstimate(e1rm_lbs, sample_count, confidence)` or `None` (<3 usable). |
| `switch_day.py` | `_canonical_cycle_for_split()` returns repeating rotation per split (PPL, UL, full_body, ppl_upper_lower, bro). Returns `None` only when no split is set. |
| `change_day_type.py` | Pure-function service: `DaySlot`, `Conflict`, `ChangeResult`. `detect_conflicts()`, `smart_adjust_remaining()`, `change_day_type()` orchestrator. |

## Hybrid Cardio Promotion (goal × days × duration)

- `_HYBRID_PAIR` maps lift archetypes (push/pull/upper/full_body + variants + bro-split + strength_maintenance) to PLUS_CARDIO equivalents. **Legs are never mapped** (hard lower + cardio = bad).
- `_DIRECT_PROMOTE_COUNT`: muscle_gain 5d→1, 6d→1, 7d→2; strength 5d→1, 6d→1, 7d→1; general_health 3d→1, 4-7d→2.
- body_recomp/fat_loss use `_promote_same_day_cardio` (merges adjacent lift+cardio pairs).
- Density trim: PLUS_CARDIO on SHORT session drops cardio finisher before any lift slot.
- Counting vocabulary: selected training days are selected planned sessions, not necessarily hard lifting days. Mobility and recovery are active planned sessions, so passive off days are `7 - selected_planned_sessions`. Dedicated cardio days are `COND_*` sessions. `LIFT_*_PLUS_CARDIO` sessions are `cardio_finisher_lift_days`: lift days with a same-day finisher, not dedicated cardio. For recomp/fat-loss, `cardio_exposures` is the more useful aggregate because it counts dedicated cardio, cardio finishers, and hybrid sessions that actually include conditioning.
- Core programming distinguishes `target_core_days` from `actual_core_days_generated`. Actual direct-core exposure may be lower when the density, lower-day, heavy-lower, time-cap, or incompatible-archetype guards intentionally skip core.

## Session Duration Density

- Duration picker values are the top of a 15-minute range: 45 = 30-45, 60 = 45-60, 75 = 60-75, 90 = 75-90.
- 60-minute sessions do not receive extended-session filler accessories; filler starts at 75+.
- Direct-core circuits treat 60 minutes as medium, not long, and are skipped on already-dense 60-minute days.
- Lower/legs templates include direct calf work. Calf isolation slots are protected during density trimming, so duplicate lower accessories drop before the only direct calf slot.
- Manual switch-to-Cardio days use explicit blocks: warm-up + main work + cooldown. At 60 minutes steady cardio becomes 5 min warm-up + 25 min + 25 min + 5 min cooldown when two owned modalities are available, or one 50 min main block when only one modality is owned. Interval goals use one interval block plus an easy flush instead of multiple full-length primary blocks.

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

- Rolling fatigue keeps raw internal values that may exceed `1.0`; public/readiness display uses a bounded squash so old callers still receive sane 0-1 fatigue.
- Decay is now channel-aware: systemic/acute load clears faster, local muscle load uses exercise/focus half-lives, and delayed damage can peak 24-48h after heavy sessions.
- Heavy lower-body patterns (squat/deadlift/RDL/lunge/split squat/leg press/hip thrust) use longer local half-lives than upper isolation work.
- Forearms are not a separate fatigue bucket; direct forearm/grip exercises map onto the biceps/arm fatigue dimension.
- Recovery/mobility days have NEGATIVE fatigue and recovery activities apply modality-specific capped reductions. Sauna gets only modest credit and is limited when hydration/stress context is poor.
- Two-pass rolling fatigue: Pass 1 accumulates training load + delayed damage; Pass 2 applies recovery (max 1 session/day). Fatigue floor clamped at 0.0.
- Focus auto-correction on completion via `_infer_focus_from_muscles`.
- Graduated planner response: ≥60% proceed / 40-60% downgrade / 20-40% swap focus / <20% force recovery.
- `/workouts/fatigue` returns `nutrition_context`, `raw_muscle_fatigue`, `explanations`, and `recommendations`. Protein thresholds: excellent ≥95%, good ≥80%, low ≥60%, very_low <60% of target. Bonus reduces fatigue at ≥95%; penalty increases it at 60-80%.

## Multiple Completions Per Day

Upsert key: `(user, date, focus)` — legs morning + sauna evening = 2 rows. Prevents second activity from overwriting first.

## Generation Consistency (PlanWeek create, auto-renew, change-focus, single-day patch)

All entry points must pass the same shape of inputs. Audited Apr 2026:
- All query `most_recent_completed_focus(hours=240, limit=10)` and pass `recent_focus_buckets` + `recent_focus_families`.
- All compute `muscle_fatigue` via `compute_rolling_fatigue` + `injury_muscle_fatigue_boost`.
- All route through `generate_workout_plan` → `generate_weekly_recipe` → `_repair_adjacent_duplicates`.
- All pass optional `load_equipment_settings` from `UserPreferences.equipment_settings` so planned and in-workout loads respect adjustable dumbbell range/step and available plate pairs.
- Future generated weeks read accepted `UserCoachingState` deload, volume, muscle-volume, and intensity adjustments through `planner_context`; the active week still stays fixed.
- **Focus mismatch fallback**: when requested focus isn't in recipe, the endpoint regenerates with `preferred_split` forced to the family containing that focus. Old behavior was label-only.

**Entry points (post-PlanWeek migration):**

| Endpoint | Purpose |
|---|---|
| `POST /plans/start-new-week` | Generates a fresh 7-day PlanWeek anchored on **today** for first-run setup / explicit new-week creation. The user's sign-up-day cadence persists across auto-renew. |
| `POST /plans/week/auto-renew` | When the active PlanWeek's `end_date` has passed, generates the next 7 days from `prev.end_date + 1` and snapshots the expired week for the one-day coach check-in/recap. Idempotent while still active. |
| `POST /plans/week/pause` / `POST /plans/week/resume` | Pause/resume auto-renew, auto-skip, and reminder behavior for travel/illness windows without destroying the current week. |
| `PATCH /plans/days/{day_date}/workout` | Per-day workout patch (Change Focus, manual edits, exercise swaps). |
| `POST /plans/week/review-and-apply` | Applies user-selected weekly check-in recommendations to durable settings / coach state only. It does not rewrite the active PlanWeek or regenerate remaining days. |
| `POST /plans/week/checkin-settings` | Saves explicit weekly check-in setup changes (goal, days/week, split, session length). With user confirmation, routes through deterministic remaining-week regeneration and preserves completed/skipped/started days. |
| `POST /plans/week/adapt-remaining` | Re-fills unlocked future workouts using current fatigue while keeping the same recipe. |
| `POST /plans/week/repair-injury-conflicts` | Safety exception that rewrites unlocked current/future exercise lists after injury changes while preserving week structure. |
| `POST /plans/week/repair-equipment-conflicts` | Availability exception after equipment removal. Swaps only incompatible exercises on unlocked current/future workouts while preserving week structure, focus labels, rest/training days, and compatible exercises. |
| `POST /plans/week/update-session-duration` | Time-budget exception after session length changes. Rebuilds only unlocked current/future workouts to fit the new duration and updates `PlanWeek.session_minutes`; dates, rest days, goal, split, completed/started days stay fixed. |
| `POST /plans/week/regenerate-remaining` | New recipe for unlocked future days after explicit days/week or split changes. |
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
- **Status**: Column, helper, and UI capture are shipped. `ActiveWorkoutScreen` now asks for `actual_rir` only on meaningful overshoots (currently `top of target rep range + 2` or more), and next-set recommendations no longer wait on the removed bottom "How did it feel?" prompt.

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

## Fine-Grained Muscle Emphasis (2026-05-11)

Each `Exercise` row carries a JSONB `emphasis: list[str]` column with fine-grained tags (front_delt, side_delt, rear_delt, upper_chest, mid_chest, lower_chest, lats, upper_back, traps, lower_back, brachialis, forearms, obliques, abs, lower_abs, gastrocnemius, soleus, adductors, abductors, vmo).

**Critical invariant: this is analytics/display-only.** The 12-bucket fatigue model still reads `primary_muscle` + `secondary_muscles`. Planner, fatigue accumulator, readiness, and adjacency-repair rules all ignore `emphasis`. Errors in the inference do not change generated plans.

### Inference

`services/workout/emphasis_inference.py::infer_emphasis(name, primary, secondaries) → list[str]`. Pure-function. Strategy:

1. `_OVERRIDES` table — 108 hand-curated seed-name → tag-list entries for cases that rules would mis-tag (Lateral Raise → side_delt only; Face Pull → rear_delt + upper_back; seated vs standing calf raise → soleus vs gastrocnemius).
2. Rule-based augmentation from name tokens (incline/decline/flat for chest splits, row/pulldown for back, pike/handstand for shoulder-dominant push-ups, hammer for brachialis, etc.) combined with primary/secondary muscles.
3. Empty list when nothing matches — UI gracefully omits the emphasis chip row.

### Population

- Seed-time: `seed.py` calls `infer_emphasis()` for each seeded `Exercise`.
- Existing rows: `database._backfill_exercise_emphasis()` runs on every startup. Always re-infers (rule-table edits propagate without manual flushing). Cheap — ~450 rows × pure-function call.
- Coverage today: 155 of 451 seed exercises tagged (~34%). The empty 296 are mostly correctly-empty (cardio, full-body Olympic lifts, already-specific quad/glute/hamstring primaries with no useful sub-split).

### Surfaces

- `HomeScreen` library detail card: third meta-row "Emphasis: front delt, side delt" (under "Primary:" and "Also hits:").
- `/workouts/weekly-volume` returns `by_emphasis` alongside `by_muscle`; this is a set-exposure overlay and can sum above total hard sets because one set can tag both `lats` and `upper_back`.
- `/ai/muscle-balance` returns `detail_muscles` alongside broad `muscles`; Progress > Body renders this beneath Muscle Balance.
- `ExerciseLibraryItem` interface in both `HomeScreen.tsx` and `ActiveWorkoutScreen.tsx` typed with `emphasis?: string[]`.
- `meta.list_exercises` returns the field via `e.model_dump()` — no router change needed since it's a SQLModel column.

### Adding a new tag

1. Append to `EMPHASIS_TAGS` frozenset in `emphasis_inference.py`.
2. Add override entries or extend the rule chunk that should produce it.
3. The next backend restart's backfill picks it up automatically.

## Form Demo Asset Pipeline (Bundled Local, 2026-05-10)

Static exercise form previews (the 2-frame "GIF" + thumbnail tiles) come from the [`yuhonas/free-exercise-db`](https://github.com/yuhonas/free-exercise-db) dataset. Both frames are bundled inside the app — **no runtime network fetch.**

### Why bundled, not hot-linked

Earlier builds hot-linked `https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/<id>/<n>.jpg`. That worked in Expo Go but the form demos failed to render in production TestFlight/App Runner builds because:

1. GitHub raw content is not a sanctioned CDN; throttles non-browser traffic.
2. Production iOS builds have strict ATS (`NSAllowsArbitraryLoads=false`); Expo Go does not.
3. New Architecture (`RCTNewArchEnabled=true`) silently dropped failed image loads.

Bundling adds **~21 MB** to the ipa (174 ids × 2 frames × ~62 KB avg) and removes the network failure mode entirely. Photos work offline.

### Resolver (server-side, seed time)

`backend/app/services/workout/demo_resolver.py::resolve_demo_db_id(seed_name)` maps every seeded `Exercise.name` to a free-exercise-db id and stores it on `Exercise.demo_exercise_db_id` (idempotent migration: `_ensure_exercise_demo_db_id_column`). Match strategy in priority order:

1. `_OVERRIDES` table (hand-curated for known mismatches).
2. Exact normalized-name match against the dataset manifest at `backend/app/data/free_exercise_db.json`.
3. Grip-suffix strip (`"- Medium Grip"` etc.) and re-check.
4. Token-set containment (seed ⊆ dataset, or dataset ⊆ seed, preferring fewest extras).
5. Jaccard fallback at ≥0.75.

Returns `None` when no high-confidence match exists — the client gracefully renders no demo card and falls back to the YouTube thumbnail when one is curated.

### Client assets

```
assets/exercise-demos/<demo_id>/0.jpg   # bottom / start position
assets/exercise-demos/<demo_id>/1.jpg   # top / lockout
src/utils/exerciseDemoAssets.ts         # auto-generated id → [require(0), require(1)] map
src/utils/exerciseDemo.ts               # demoFrameSource() / demoLockoutSource() helpers
src/utils/exerciseThumb.ts              # exerciseThumbSmall/Medium → ImageSourcePropType
scripts/sync-exercise-demos.sh          # regenerator: enumerates seed → downloads → rebuilds map
```

`DEMO_FRAMES` is a static `Record<string, readonly [number, number]>` — Metro requires literal paths in `require()`, so we generate the map at script time rather than dynamically.

### Helper return type

`exerciseThumbSmall` / `exerciseThumbMedium` return `ImageSourcePropType | null`, which transparently handles both:
- `number` — a bundled `require()`'d local module (free-exercise-db demo)
- `{ uri: string }` — a remote YouTube `img.youtube.com` thumbnail

Callers pass the result straight to `<Image source={...}>` without caring which type.

### Rendering surfaces

| Surface | Component | Container | Fit mode |
|---|---|---|---|
| Library detail (cycling) | `ExerciseDemoCard` | 3:2 (matches source 850×567) | `cover` |
| Library detail (no demo, video only) | `ExerciseVideoCard` | 3:2 demo / 16:9 YT | `cover` for YT |
| Live workout (collapsed) | `LiveExerciseDemoThumb` | 52×52 square | `cover` |
| Live workout (expanded) | `LiveExerciseDemoThumb` | 240×160 (3:2) | `contain` for demo |
| Form video modal (top) | `ExerciseDemoCard` | 3:2 | `cover` |
| Plan card / WorkoutCard | `<Image>` | 46×46 square | `cover` |
| HomeScreen library row | `<Image>` | 48×48 square | `cover` |
| Plan swap candidate | `<Image>` | 52×52 square | `cover` |
| Timer modal hero | `<Image>` | 64×64 square | `cover` |

Important: Image styles must include explicit `width: '100%', height: '100%'` (or fixed dims) — under New Architecture, `position: 'absolute'` with `top/left/right/bottom: 0` alone falls back to the source's intrinsic 850×567 and looks heavily zoomed inside smaller parents.

### Regenerating the bundle

After adding/renaming seed exercises or editing `_OVERRIDES`:

```bash
docker compose up -d                              # resolver runs inside the backend container
./scripts/sync-exercise-demos.sh                  # downloads + prunes 404s + regenerates the map
```

The script enumerates ids by running the actual resolver against `SEED_EXERCISES`, so any new seed entries with valid matches automatically pick up frames on next sync.

### Known gap

8 entries in `demo_resolver.py::_OVERRIDES` point at upstream ids that 404 (`Glute_Bridge`, `Pendlay_Row`, `Dumbbell_Bench_Step`, `Dumbbell_Bent_Over_Row`, `Romanian_Deadlift_with_Dumbbells`, `Step_ups_With_Bands`, `Sumo_Squat_With_Dumbbell`, `Thoracic_Rotation`). The sync script silently prunes them and the client gracefully omits the card, but those overrides should be fixed against the actual manifest to lift coverage above the current 53% (174 of 451 seeded exercises).
