# Fatigue System v2.1 — Design & Implementation

Last updated: 2026-04-18

## Overview

The fatigue system uses 12 muscle-group dimensions as its source of truth. Readiness for any split type is DERIVED from the underlying muscle state — this works for PPL, bro splits, chest+back days, glute-focused users, and custom splits because the muscles are the atoms, not the patterns.

## Source-of-Truth Buckets (12)

| Bucket | Why Separate |
|--------|-------------|
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

## Fatigue Production

### Per-Exercise Resolution (Primary Path)
When per-exercise data is available from a completed workout:
- Primary muscle: **1.0x fatigue_load** per set
- Secondary muscle: **0.3x fatigue_load** per set
- Systemic: compounds **0.4x**, isolation **0.15x**
- Base per set: **0.08 x intensity_multiplier**
- Intensity: easy = 0.5x, moderate = 1.0x, hard = 1.4x
- Duration scaling: 0.5x-1.5x (baseline 60 min)

### Focus-Label Fallback (Secondary Path)
When only a focus label exists (manual activities, legacy data), static mapping estimates fatigue:

| Focus | Fatigue Distribution |
|-------|---------------------|
| Push | chest 0.6, shoulders 0.4, triceps 0.35, systemic 0.25 |
| Pull | back 0.6, biceps 0.35, shoulders 0.15, systemic 0.25 |
| Legs | quads 0.6, glutes 0.5, hamstrings 0.45, calves 0.2, systemic 0.35 |
| Upper | chest 0.45, back 0.45, shoulders 0.35, biceps 0.25, triceps 0.25, systemic 0.25 |
| Lower | quads 0.55, glutes 0.5, hamstrings 0.45, calves 0.2, systemic 0.3 |
| Full Body | chest 0.3, back 0.3, shoulders 0.25, quads 0.3, glutes 0.25, hamstrings 0.25, systemic 0.35 |
| Cardio | cardio 0.5, quads 0.15, hamstrings 0.1, calves 0.1, systemic 0.2 |
| Running | cardio 0.5, quads 0.2, hamstrings 0.15, calves 0.15, systemic 0.25 |
| Cycling | cardio 0.45, quads 0.25, glutes 0.15, systemic 0.2 |

### Active Activities (NEW)
Physical work and daily activities with realistic fatigue values:

| Activity | Key Muscles | Systemic |
|----------|------------|----------|
| Yard Work | back 0.25, shoulders 0.2, core 0.15, quads 0.15 | 0.2 |
| Chopping Wood | back 0.35, shoulders 0.3, core 0.25, biceps 0.15 | 0.3 |
| Moving/Lifting | back 0.3, quads 0.25, glutes 0.2, shoulders 0.2, core 0.2 | 0.35 |
| Gardening | back 0.15, quads 0.1, core 0.1 | 0.1 |
| House Cleaning | cardio 0.15, core 0.1 | 0.1 |
| Construction | back 0.3, shoulders 0.25, core 0.2, quads 0.15 | 0.3 |
| Shoveling | back 0.35, shoulders 0.25, core 0.2, quads 0.15 | 0.3 |
| Playing w/ Kids | cardio 0.25, quads 0.15 | 0.15 |
| Dancing | cardio 0.3, quads 0.15, calves 0.1, core 0.1 | 0.15 |

### Sports (Expanded)

| Sport | Key Muscles | Systemic |
|-------|------------|----------|
| Pickleball | cardio 0.3, shoulders 0.2, quads 0.15, calves 0.1 | 0.15 |
| Surfing | back 0.3, shoulders 0.25, core 0.2 | 0.2 |
| Skiing | quads 0.4, glutes 0.25, hamstrings 0.2, core 0.15 | 0.25 |
| Hiking | cardio 0.35, quads 0.2, glutes 0.15, calves 0.15 | 0.2 |
| Swimming | cardio 0.4, back 0.2, shoulders 0.15 | 0.2 |

Keyword fallback matching handles free-text activity names (e.g., "wood chopping" matches chopping_wood profile).

### Recovery and Mobility (Negative Fatigue)
Recovery and mobility activities REDUCE existing fatigue — they carry negative values:

| Activity | Per-Muscle | Systemic |
|----------|-----------|----------|
| Recovery | -0.08 (chest, back, quads, hamstrings), -0.06 (shoulders, glutes), -0.05 (core) | -0.10 |
| Mobility | -0.05 (all muscles) | -0.08 |

Key behaviors:
- Negative fatigue values are NOT scaled by intensity or duration (a recovery session helps the same at any length)
- The fatigue floor is clamped at **0.0** — fatigue can never go below zero
- This means recovery days actively accelerate return to baseline, not just "zero stress"

## Two-Pass Rolling Fatigue (NEW)

The `compute_rolling_fatigue()` function uses a two-pass approach:

### Pass 1: Positive Fatigue Accumulation
- Iterates through all completions within the 3-day decay window
- Accumulates only positive fatigue values (workouts, cardio, sports, active activities)
- Each value is multiplied by the time-decay factor

### Pass 2: Recovery Application
- Processes completions with negative values (recovery/mobility sessions)
- **Max one recovery session per day** — prevents stacking (5 saunas = same benefit as 1)
- Recovery benefit is **proportional**: removes 15% of current fatigue per muscle
- Capped at 0.15 per session per muscle — diminishing returns built in
- Cannot recover below 0.0 (can't recover what isn't fatigued)
- Decay factor still applies (recovery from 3 days ago has less effect)

This prevents the exploit where multiple recovery sessions could wipe out a heavy training day's fatigue.

## Time Decay

| Days Ago | Multiplier |
|----------|-----------|
| 0 (today) | 1.00 |
| 1 (yesterday) | 0.50 |
| 2 | 0.25 |
| 3 | 0.10 |
| 4+ | 0.00 |

**Known limitation**: Systemic (CNS) fatigue should decay over 5-6 days for heavy compound sessions. Currently uses the same 3-day window as all other muscles. See RECOMMENDATIONS.md #16.

## Nutrition Recovery Integration (NEW)

The fatigue endpoint returns a `nutrition_context` object based on rolling protein intake from the meal history system:

| Protein Avg (3-day) | Status | Fatigue Modifier | Message |
|---------------------|--------|-----------------|---------|
| >= 130g | excellent | -5% fatigue bonus | "Protein intake strong (Xg avg) — accelerating recovery" |
| >= 100g | good | -3% fatigue bonus | "Protein adequate (Xg avg) — supporting recovery" |
| 50-99g | low | +3% fatigue penalty | "Protein low (Xg avg) — recovery is slower. Aim for 130g+" |
| < 50g | very_low | No change | "Protein very low (Xg avg) — significantly slowing recovery" |
| No data | no_data | No change | "Log meals to unlock nutrition-powered recovery insights" |

The recovery bonus/penalty adjusts muscle fatigue values directly, then recalculates readiness score and focus readiness. The UI shows the nutrition insight as a colored message with icon in the expanded recovery card.

## Derived Focus Readiness

Each focus type derives readiness from its constituent muscles via importance-weighted average:

| Focus | Muscles (importance weight) |
|-------|---------------------------|
| Push | chest(1.0), shoulders(0.8), triceps(0.6) |
| Pull | back(1.0), biceps(0.7), shoulders(0.3) |
| Legs | quads(1.0), glutes(0.8), hamstrings(0.8), calves(0.3) |
| Upper | chest(0.8), back(0.8), shoulders(0.7), biceps(0.5), triceps(0.5) |
| Lower | quads(1.0), glutes(0.9), hamstrings(0.9), calves(0.4) |
| Full Body | all major groups(0.4-0.5), systemic(0.8) |
| Chest/Back | chest(1.0), back(1.0) |
| Arms | biceps(1.0), triceps(1.0) |
| Shoulders | shoulders(1.0) |
| Glute Focus | glutes(1.0), hamstrings(0.4), quads(0.3) |
| Cardio | cardio(1.0), systemic(0.3) |

**Overall readiness** = weighted blend of average muscle fatigue (60%) and systemic fatigue (40%), inverted to 0-100%.

## Graduated Planner Response

| Readiness | Action |
|-----------|--------|
| >= 60% | Proceed as planned |
| 40-60% | Downgrade: heavy -> hypertrophy, hypertrophy -> volume |
| 20-40% | Swap to most-ready alternative focus |
| < 20% | Force recovery/mobility |

Examples:
- Quads 0.8, glutes 0.4 -> Legs readiness ~44% (downgraded), Glute Focus readiness ~53% (workable)
- Chest fatigued, back fresh -> Push low, Pull high -> planner swaps to Pull
- All lower fatigued, upper fresh -> Upper day proceeds normally

## Focus Auto-Correction

On workout completion, the backend infers the correct focus from the exercises actually performed:
1. Resolve per-exercise muscle fatigue to get top worked muscles
2. `_infer_focus_from_muscles()` maps the top 4 muscles to a focus label
3. Rules: lower-body muscles without upper = "Legs"; lower + upper = "Full Body"; chest/triceps without back/biceps = "Push"; back/biceps without chest/triceps = "Pull"; mixed upper = "Upper Body"
4. If inferred focus differs from the original label, it's corrected (e.g., prevents "Recovery" label persisting on what was actually a leg day)

## Multiple Completions Per Day (NEW)

The workout completion upsert key changed from `(user_id, workout_date)` to `(user_id, workout_date, focus_label)`:
- Legs morning + sauna evening = 2 separate rows
- Both affect fatigue correctly via the rolling computation
- Prevents second activity from overwriting the first
- WorkoutSession upsert also uses (user, date, focus) to match

## Activity Completion Schema

```python
class WorkoutCompletion(SQLModel, table=True):
    user_id: int
    workout_date: date
    focus_label: str
    duration_seconds: int
    stimulus: str | None              # strength/hypertrophy/volume/conditioning
    activity_category: str | None     # strength/cardio/mobility/sport/recovery/active
    activity_subtype: str | None      # push/pull/legs/ride/yoga/yard_work/etc.
    activity_intensity: str | None    # easy/moderate/hard
    activity_source: str | None       # manual/peloton/apple_health
    cardio_style: str | None          # recovery/steady/intervals/class
    resolved_muscle_fatigue: dict | None  # {"chest": 0.6, "triceps": 0.18, ...}
    completed_at: datetime
```

### Resolution Flow
1. Per-exercise data exists -> `resolve_exercise_fatigue()` maps each exercise's primary/secondary muscles
2. Only focus_label exists -> `resolve_focus_fatigue()` estimates from static mapping (includes active/sport/recovery types)
3. Result stored as `resolved_muscle_fatigue` JSON on the completion row
4. `compute_rolling_fatigue()` reads these dicts with two-pass approach (positive first, then recovery)

## UI

### Workout Tab
- Readiness badge: battery icon + "Recovery: Ready (72%)" — expandable
- Per-muscle fatigue bars when badge is expanded
- "Overall Load" label (replaces former "CNS / Systemic")
- Color coding: green (<40%), yellow (40-70%), red (>70%)
- Nutrition insight shown when expanded: colored message with icon from `nutrition_context`

### Progress > Body Check
- Full muscle recovery card with per-muscle progress bars
- Cardio fatigue shown separately in blue

## Code Files

| File | Purpose |
|------|---------|
| `activity_impact.py` | MuscleFatigue dataclass, resolve functions, two-pass rolling fatigue, derived readiness, negative recovery values, active/sport fatigue profiles, keyword fallbacks |
| `history.py` | `get_recent_completions_for_fatigue` DB query |
| `workouts.py` | Complete endpoint (resolve + store, upsert by user/date/focus), generate-day (graduated response), fatigue endpoint (with nutrition_context), focus auto-correction via `_infer_focus_from_muscles()` |
| `models.py` | `WorkoutCompletion.resolved_muscle_fatigue` JSON column |
| `main.py` | Startup backfill for historical completions |
| `meal_history.py` | `get_rolling_averages()` — provides protein data for nutrition recovery integration |

## What's Not Built Yet

1. **Per-slot adaptation** — when a Chest/Back day has low chest readiness but fresh back, reduce chest volume instead of swapping the whole day (Phase 2)
2. **Within-day exercise substitution** — swap squat for hip thrust because quads > glutes fatigue (Phase 2)
3. **Weekly recipe rotation from fatigue** — if lower body is still fatigued from Friday, Monday's recipe starts with Upper (day-of adaptation already handles this)
4. **Extended CNS decay** — systemic fatigue should decay over 5-6 days for heavy compounds
5. **Injury-based fatigue boost** — active injuries +0.5, recovering +0.25 to affected muscles (designed, not yet wired into rolling fatigue)
6. **Apple Health auto-import** — wearable data feeding fatigue automatically
