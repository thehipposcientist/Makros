# Fatigue System v1.5 — Design & Implementation Status

## SECTION 1 — Honest Diagnosis

### What's Already Built (Status: Implemented)

The muscle-group fatigue system is already live. It uses 12 dimensions as the source of truth:

```
chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, cardio, systemic
```

This is correct. Pattern-only buckets (upper_push, upper_pull, lower_squat, lower_hinge) would break for bro splits, chest+back days, glute-focused users, and custom splits. Muscle-group fatigue works for all of them because readiness for any split type is DERIVED from the underlying muscle state.

### What's Acceptable As-Is

- **12 fatigue dimensions** — correct granularity. Matches your MuscleGroup enum minus ultra-granular ones (traps→back, forearms→biceps).
- **Decay model** — 100% today, 50% at 24h, 25% at 48h, 10% at 72h. Good.
- **Exercise resolution** — `resolve_exercise_fatigue()` maps exercises via primary_muscle (1.0×) and secondary_muscles (0.3×). Compounds add 0.4× systemic, isolation 0.15×. Working correctly.
- **Focus-label fallback** — `resolve_focus_fatigue()` estimates from "Push"/"Pull"/etc. when no per-exercise data exists. Working.
- **Derived readiness** — `derive_focus_readiness()` and `derive_all_readiness()` compute per-focus readiness from the muscle state. Supports push, pull, legs, upper, lower, full_body, chest_back, arms, shoulders, glute_focus, cardio, mobility, recovery. Working.
- **Graduated planner response** — readiness ≥60% proceed, 40-60% downgrade stimulus, 20-40% swap focus, <20% force recovery. Working.
- **Backfill** — existing completions get `resolved_muscle_fatigue` populated on startup. Working.
- **API endpoint** — `GET /workouts/fatigue` returns per-muscle breakdown, focus readiness, top fatigued muscles. Working.
- **UI** — readiness badge with muscle-group fatigue bars on workout tab and Progress > Body Check. Working.

### What Needs Immediate Change

1. **In-app workout completions now send structured data** — `ActiveWorkoutScreen` sends `activity_category`, `activity_subtype`, `activity_intensity` with every completion. The backend resolves per-exercise muscle fatigue. **Status: Done.**

2. **Weekly recipe does not use fatigue** — the `generate_weekly_recipe` function is purely deterministic from goal + days + split. It does NOT check recent fatigue to influence day 1 of the recipe. **Status: Not built. Low priority — day-of adaptation handles this.**

3. **Some edge cases in focus normalization** — `normalize_focus_to_family` maps to coarse families (push/pull/legs/upper/lower). The fatigue system's `focus_readiness` uses richer keys. There's a slight mismatch when the planner normalizes "Chest" to "push" but the fatigue system has a separate "chest_back" key. **Status: Works but could be tighter.**

## SECTION 2 — Fatigue Architecture (Current Implementation)

### Source-of-Truth Buckets (12)

| Bucket | Why It Exists |
|--------|--------------|
| chest | Bench, fly, dip — separate from shoulders/triceps |
| back | Row, pulldown, pull-up — separate from biceps |
| shoulders | OHP, lateral raise — hit by push AND pull |
| biceps | Curls, chin-ups — small muscle, recovers fast |
| triceps | Pushdowns, close-grip — small muscle, recovers fast |
| quads | Squat, leg press, lunge — highest volume lower muscle |
| hamstrings | RDL, leg curl — separate from quads for split flexibility |
| glutes | Hip thrust, bridge — MUST be separate for glute-focused users |
| calves | Calf raise — isolatable, low systemic cost |
| core | Plank, crunch — recovers fast, rarely rate-limiting |
| cardio | Aerobic system load — separate from any muscle |
| systemic | CNS/whole-body drain — heavy compounds, high-intensity anything |

### Derived Readiness (Computed, Not Stored)

| Focus Type | Derived From (importance weights) |
|-----------|----------------------------------|
| Push | chest(1.0), shoulders(0.8), triceps(0.6) |
| Pull | back(1.0), biceps(0.7), shoulders(0.3) |
| Legs | quads(1.0), glutes(0.8), hamstrings(0.8), calves(0.3) |
| Upper | chest(0.8), back(0.8), shoulders(0.7), biceps(0.5), triceps(0.5) |
| Lower | quads(1.0), glutes(0.9), hamstrings(0.9), calves(0.4) |
| Full Body | all(0.4-0.5), systemic(0.8) |
| Chest/Back | chest(1.0), back(1.0) |
| Arms | biceps(1.0), triceps(1.0) |
| Shoulders | shoulders(1.0) |
| Glute Focus | glutes(1.0), hamstrings(0.4), quads(0.3) |
| Cardio | cardio(1.0), systemic(0.3) |

## SECTION 3 — Exercise Mapping (Current Implementation)

### Contribution Model

- Primary muscle: **1.0× fatigue_load** per set
- Secondary muscle: **0.3× fatigue_load** per set
- Systemic: compounds **0.4×**, isolation **0.15×**
- Base per set: **0.08 × intensity_multiplier**
- Intensity: easy=0.5×, moderate=1.0×, hard=1.4×
- Duration scaling: 0.5×-1.5× (baseline 60 min)

### Exercise Examples

| Exercise | Primary (1.0×) | Secondary (0.3×) | Systemic | Cardio |
|----------|---------------|-------------------|----------|--------|
| Bench Press | chest | triceps, shoulders | 0.4× | 0 |
| Overhead Press | shoulders | triceps | 0.4× | 0 |
| Pull-up | back | biceps | 0.4× | 0 |
| Barbell Row | back | biceps | 0.4× | 0 |
| Lateral Raise | shoulders | — | 0.15× | 0 |
| Curls | biceps | — | 0.15× | 0 |
| Skull Crushers | triceps | — | 0.15× | 0 |
| Squat | quads | glutes, hamstrings | 0.4× | 0 |
| Leg Press | quads | glutes, hamstrings | 0.3× | 0 |
| RDL | hamstrings | glutes, back | 0.4× | 0 |
| Deadlift | hamstrings | glutes, back, quads | 0.5× | 0 |
| Hip Thrust | glutes | hamstrings | 0.3× | 0 |
| Lunge | quads | glutes, hamstrings | 0.35× | 0 |
| Calf Raise | calves | — | 0.1× | 0 |
| Plank | core | — | 0.1× | 0 |
| Running | — | quads(0.2×), hamstrings(0.15×), calves(0.15×) | 0.3× | full |
| HIIT Bike | — | quads(0.3×) | 0.4× | full |
| Walking | — | — | 0.05× | 0.1 |

## SECTION 4 — Activity Completion Contract (Current Implementation)

### Backend Schema

```python
class WorkoutCompletion(SQLModel, table=True):
    user_id: int
    workout_date: date
    focus_label: str
    duration_seconds: int
    stimulus: str | None              # strength/hypertrophy/volume/conditioning
    activity_category: str | None     # strength/cardio/mobility/sport/recovery
    activity_subtype: str | None      # push/pull/legs/ride/yoga/etc.
    activity_intensity: str | None    # easy/moderate/hard
    activity_source: str | None       # manual/peloton/apple_health
    cardio_style: str | None          # recovery/steady/intervals/class
    resolved_muscle_fatigue: dict | None  # {"chest": 0.6, "triceps": 0.18, ...}
    completed_at: datetime
```

### Resolution Flow

1. If per-exercise data exists → `resolve_exercise_fatigue()` maps each exercise's primary/secondary muscles
2. If only focus_label exists → `resolve_focus_fatigue()` estimates from static mapping
3. Result stored as `resolved_muscle_fatigue` JSON on the completion row
4. `compute_rolling_fatigue()` reads these dicts with time decay to produce the current state

## SECTION 5 — Planner Logic (Current Implementation)

### Decision Ladder

```
readiness = derive_focus_readiness(fatigue, planned_focus)

if readiness >= 0.6:  → proceed as planned
if 0.4 <= readiness < 0.6:  → downgrade: heavy→hypertrophy, hypertrophy→volume
if 0.2 <= readiness < 0.4:  → swap to most-ready alternative day from recipe
if readiness < 0.2:  → force recovery/mobility
```

### What the Planner CAN Do

- Quads fatigued (0.8) but glutes moderate (0.4) → Legs readiness ~44%, downgraded but not blocked. Glute-focus readiness ~53%, workable.
- Chest fatigued but back fresh → Push readiness low, Pull readiness high. Planner swaps to Pull.
- Lower fatigued, upper fresh → Upper day proceeds normally.

### What the Planner CANNOT Do Yet

- Partial day modification (reduce chest volume but keep back volume on a Chest/Back day). This would require per-slot readiness within a single day. **Phase 2.**
- Within-day exercise substitution based on fatigue (swap squat for hip thrust because quads > glutes fatigue). **Phase 2.**

## SECTION 6 — Weekly Planner Behavior

### Current: Day-of Adaptation Only

The weekly recipe is deterministic (goal + split + days). Fatigue only influences execution at the point of `generate-day`, not recipe construction. This is intentional:

- **Stable split identity**: users see the same PPL/UL/FB structure every week
- **Day-of flexibility**: the actual workout adapts if fatigue demands it
- **No random chaos**: the weekly plan doesn't shuffle based on yesterday's workout

### Future Consideration

The weekly recipe COULD use recent fatigue to influence day-1 rotation (e.g., if quads are still fatigued from Friday, rotate the recipe so Monday starts with Upper instead of Legs). The `_rotate_recipe_to_avoid_recent` function already does this for focus families. Extending it to muscle-group fatigue is possible but not urgent because day-of adaptation already handles the same problem.

## SECTION 7 — UI (Current Implementation)

### Workout Tab
- Readiness badge: battery icon + "Recovery: Ready (72%)"
- Top fatigued muscles: mini bars showing e.g., "quads 78%  hamstrings 57%"

### Progress > Body Check
- Full muscle recovery card with per-muscle progress bars
- Color coding: green (<40%), yellow (40-70%), red (>70%)
- Cardio fatigue shown separately in blue

## SECTION 8 — Rollout Status

| Step | Status | Notes |
|------|--------|-------|
| 1. Fix workout completion fatigue wiring | **Done** | ActiveWorkoutScreen sends category/intensity, backend resolves per-exercise |
| 2. Refactor fatigue to muscle groups | **Done** | 12 dimensions, MuscleFatigue dataclass, resolve/derive functions |
| 3. Refactor planner to graduated fatigue | **Done** | 4-tier readiness ladder, per-focus readiness |
| 4. Weekly generator fatigue awareness | **Not done** | Low priority — day-of adaptation covers it |
| 5. UI muscle breakdown | **Done** | Readiness badge + Body Check muscle bars |
| 6. Backfill existing completions | **Done** | Runs on startup |

## SECTION 9 — Code Deliverables (All Exist)

| File | Purpose | Status |
|------|---------|--------|
| `activity_impact.py` | MuscleFatigue, resolve functions, rolling fatigue, derived readiness | Done |
| `core_planning.py` | Weekly core targets, insertion priority, pattern rotation | Done |
| `history.py` → `get_recent_completions_for_fatigue` | DB query returning resolved_muscle_fatigue | Done |
| `workouts.py` → complete endpoint | Resolves and stores muscle fatigue on completion | Done |
| `workouts.py` → generate-day endpoint | Graduated readiness response | Done |
| `workouts.py` → fatigue endpoint | Returns per-muscle breakdown + focus readiness | Done |
| `models.py` → WorkoutCompletion | `resolved_muscle_fatigue` JSON column | Done |
| `main.py` → startup backfill | Populates muscle fatigue for historical completions | Done |

## SECTION 10 — Acceptance Criteria

| Criterion | Status |
|-----------|--------|
| Heavy squat day raises quads/glutes/systemic fatigue appropriately | **Pass** — quads 0.784, glutes 0.336, systemic 0.498 |
| Next-day heavy lower is downgraded | **Pass** — legs readiness 44%, downgraded to volume |
| Upper day proceeds when lower fatigued | **Pass** — push 100%, pull 95% after leg day |
| Glute-focused users not blocked by quad fatigue | **Pass** — glute_focus 53% vs legs 44% |
| Chest/back day can be partially adapted | **Not yet** — full-day swap only, not per-slot. Phase 2. |
| Fatigue in UI matches backend | **Pass** — readiness badge + muscle bars |
| Weekly planner considers fatigue | **Not yet** — day-of adaptation only |

## Side Questions

**1. Is muscle-group fatigue the right source of truth?**
Yes. Already implemented this way. Movement patterns are useful for split naming but wrong for fatigue modeling. A lateral raise and a bench press are both "push" but fatigue completely different muscles.

**2. Should movement pattern still exist as derived concept?**
Yes. "Push day readiness" = f(chest, shoulders, triceps fatigue). The pattern is the question, muscle fatigue is the answer. This is how the system works now.

**3. Should meal planning respond to fatigue?**
Yes, lightly. Currently shows contextual tips ("Heavy training day — extra carbs around your workout"). Phase 2: actual macro multiplier (+10% carbs on heavy days, -10% on rest days). Your instinct is correct — more carbs on hard days, recovery nutrition on rest days, hydration nudge on cardio days.

## SECTION 11 — What to Do Next

The fatigue system is built and working. The highest-value next moves are:

1. **Test with real training data** — use the app for 2 weeks, complete workouts, check that readiness scores match your subjective recovery
2. **Tune thresholds** — the 0.08 per-set base, 0.3× secondary, 0.4× systemic might need adjustment based on real user feedback
3. **Per-slot adaptation (Phase 2)** — when a Chest/Back day has low chest readiness but fresh back, reduce chest compound volume instead of swapping the whole day
4. **Weekly recipe rotation from fatigue (Phase 2)** — if lower body is still fatigued from Friday, Monday's recipe starts with Upper
5. **Apple Health auto-import** — wearable data feeding fatigue automatically without manual logging
