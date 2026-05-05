# Thallo — Scoring & Score-like Algorithms

Single source of truth for every numeric / tiered output the app shows the user. Each section answers: **what does this score answer? what are the inputs? what's the formula? what bands does the UI render?** If a doc here disagrees with code, the code wins — file a fix to this doc.

Companion docs:
- `NUTRITION_SCORING.md` — full nutrition score deep dive
- `FATIGUE_SYSTEM.md` — full 12-muscle fatigue model deep dive
- `PROGRESSION_SYSTEM.md` — load/rep recommendation pipeline

---

## Table of contents

1. [Sleep Score](#1-sleep-score) — 0–100, last night
2. [Preparedness / Readiness Score](#2-preparedness--readiness-score) — 0–100, today
3. [Nutrition Score](#3-nutrition-score) — 0–100, today + 7-day rolling
4. [Fitness Score](#4-fitness-score) — 0–100, 4-pillar composite
5. [Fatigue / Muscle Recovery](#5-fatigue--muscle-recovery) — 0–1 per muscle, derived 0–100 readiness
6. [Rolling e1RM](#6-rolling-e1rm) — per-exercise working-1RM estimate
7. [Weekly Volume Tiers](#7-weekly-volume-tiers) — undertrained / in_range / high / excessive / spike
8. [Recovery Flags](#8-fueling--recovery-flags-not-scored) — tri-state, not numeric
9. [Cycle Phase](#9-cycle-phase-not-scored) — derived from Apple Health, not numeric
10. [Cross-cutting design rules](#cross-cutting-design-rules)

---

## 1. Sleep Score

**Question:** "How was last night?"
**File:** `src/services/sleepScore.ts`
**Range:** 0–100, returned as `{ score, rating, mode, pillars, insights }`. Returns `null` if `totalSleepHours < 0.5`.
**Mode select:** `personalized` if `hrvHistory.length ≥ 14` AND `bedtimeHistory.length ≥ 14`; else `mvp`.

### MVP mode — 7 pillars, sums to 100 before hard caps

| Pillar | Max | Logic |
|---|---:|---|
| Duration | 32 | Smooth log-normal curve around a 7–9h target. 7–9h → full; below 7h falls faster than above 9h; very short sleep floors near 5% before caps; long sleep floors near 20% before caps |
| Efficiency (asleep÷inBed) | 18 | ≥0.92 → full · ≥0.88 → 85% · ≥0.83 → 65% · ≥0.78 → 42% · else → 15% · missing → 50% |
| HRV (age-adjusted) | 20 | ratio = hrvMs / `ageHrvReference(age)`. ≥1.15 → 20 · ≥1.00 → 16 · ≥0.88 → 11 · ≥0.75 → 6 · else → 2 · missing → 8 |
| Deep sleep | 10 | Full-length nights use absolute minutes: ≥90m full · ≥70m 75% · ≥50m 50% · else 15%. Short nights use deep/total ratio. Missing → 50% |
| REM sleep | 5 | Ratio sweet spot 18–25% full, broad soft bands outside that range. Missing → 50% |
| Recovery vitals | 10 | Deducts for low SpO₂, out-of-range/elevated respiratory rate, elevated resting HR vs baseline, and baseline drops/drifts when history exists |
| Awake fragmentation | 5 | ≤20m full · ≤45m 65% · ≤75m 35% · ≤120m 10% · >120m 0 |

`ageHrvReference`: <30y=70 · <40y=60 · <50y=50 · <60y=40 · 60+=32 (ms).

### Personalized mode — 8 pillars, sums to 100 before hard caps

| Pillar | Max | Difference vs MVP |
|---|---:|---|
| Duration | 28 | Same smooth log-normal curve as MVP, lighter weight |
| Efficiency | 17 | Same band shape as MVP |
| HRV vs personal baseline | 18 | ratio = hrvMs / `rollingMedian(hrvHistory)`. ≥1.10 full · ≥0.98 80% · ≥0.92 60% · ≥0.85 35% · else 10%. Falls back to age-adjusted HRV if baseline invalid |
| **Regularity** *(new)* | 15 | Circular SD of bedtimes, handles midnight wrap. ≤30min → 15 · ≤45 → 11 · ≤60 → 7 · ≤90 → 3 · else → 0 |
| Deep sleep | 9 | Same logic as MVP, lighter weight |
| REM sleep | 4 | Same logic as MVP, lighter weight |
| Recovery vitals | 5 | Lighter, deduction-style, includes RHR/resp/SpO₂ baseline drift where available |
| Awake fragmentation | 4 | Same awake-time bands as MVP, lighter weight |

### Hard caps
Certain red-flag nights cap the final score after pillar summing so one good signal cannot hide a bad recovery night:

- Short sleep: <5h caps at 45; <6h at 59; <6.5h at 69; <7h at 84.
- Long sleep: >10.5h caps at 88; >11.5h caps at 79. 9–10.5h is handled by the smooth duration curve unless recovery markers are also off.
- Low efficiency: <75% caps at 59; <80% at 69; <85% at 79.
- Wake after sleep onset: ≥180m caps at 35; ≥135m at 44; ≥105m at 49; ≥75m at 59; >45m at 69.
- Corroborating stress markers: multiple off markers (low HRV, elevated RHR vs baseline, elevated respiratory rate vs baseline, low/dropping SpO₂) cap at 49–59.
- Long sleep plus stress markers: >10h plus 2+ off markers caps at 69; >10h plus 1 off marker caps at 84.
- Fragmented sleep plus stress markers: ≥105m awake plus 2+ off markers caps at 39; ≥105m plus 1 off marker caps at 42.

### Rating bands
≥85 Excellent · ≥70 Good · ≥50 Fair · <50 Poor

### Design rules
- Duration + efficiency drive the score (most reliable signals)
- Duration uses a smooth curve, not hard bands, so neighboring nights do not jump categories because of a few minutes of wearable variance.
- Stage data is noisy → light weight, broad bands
- HRV becomes relative as soon as 14-night baseline exists
- SpO₂ + respiratory rate are deduction-only
- Missing data → neutral, never punished

### Persistence
- Per-night sleep snapshots are mirrored to backend `SleepLog` table on every `healthDataSummary` refresh via `POST /sleep/nightly`.
- Survives device wipes / sign-in on a new device — was previously AsyncStorage-only.
- 14+ night baseline for personalized score reads from `GET /sleep/history?days=30`.
- `night_date` keys on the **waking** date so today's row is updated each refresh.

---

## 2. Preparedness / Readiness Score

**Question:** "How ready am I to train hard *today*?"
**File:** `src/services/preparedness.ts`
**Range:** 0–100, returned as `{ score, label, pillars, insights, missing, signalsPresent, signalsTotal, raw, maxPossible }`.

### Data-quality reweighting (Apr 2026)
Earlier versions used neutral fallback points (~60% of pillar max) when an input was missing, which anchored the score at ~60 even when nothing was readable. Now: **missing pillars contribute 0 AND their max is excluded from the divisor**. Score = `raw / maxPossible × 100` where `maxPossible` = sum of pillar maxes for pillars whose input was real (yesterday strain always counts; cycle is a modifier).

If `signalsPresent === 0` the function returns score 0 and the UI shows a "Connect Apple Health" empty-state instead of a misleading "0 Fatigued" dial.

### Pillars (sum to 100 when all 5 user-driven signals are present)

| Pillar | Max | Logic | When missing |
|---|---:|---|---|
| Sleep | 30 | `(sleepScore.score / 100) × 30` | 0 pts, dropped from divisor |
| HRV vs baseline | 20 | If `hrvHistory.length ≥ 7`: ratio = hrvMs / median. ≥1.10 → 20 · ≥0.98 → 17 · ≥0.90 → 13 · ≥0.80 → 8 · else → 3. No baseline → age-adjusted absolute | 0 pts, dropped from divisor |
| Muscle fatigue | 20 | Prefers backend `readinessFromBackend` (0-100): `(value/100) × 20`. Else `(1 - muscleFatigueAvg) × 20` | 0 pts, dropped from divisor |
| Nutrition (protein 8 + calories 7) | 15 | Protein: ≥95% target → 8 · ≥85% → 6 · ≥70% → 3 · else → 1. Calories: within ±10% → 7 · ±20% → 5 · ±30% → 3 · else → 1 | 0 pts, dropped from divisor |
| Resting HR vs baseline | 10 | If `rhrHistory.length ≥ 7`: delta = todayRHR − median. ≤−3 → 10 · ≤+2 → 9 · ≤+5 → 6 · ≤+8 → 3 · else → 1. No baseline → absolute | 0 pts, dropped from divisor |
| Yesterday strain (inverse) | 5 | <30min → 5 · <60 → 4 · <90 → 3 · <120 → 2 · ≥120 → 1 | Always 5 (assume rested) — never dropped |

### UI display
- `PreparednessCard` / `TrainingReadinessCard` show "X/5 signals" badge so users see what's powering the score.
- Pillars where `result.missing.includes(key)` render "—" instead of a fake bar.
- Zero signals → empty-state CTA card.

### Optional cycle modifier (±3)
Pulled from Apple Health (see [Cycle Phase](#9-cycle-phase-not-scored)):
- ovulation: +3
- follicular: +1
- menses: −2
- luteal: 0

### Rating bands (`label`)
≥85 Primed · ≥70 Ready · ≥50 Moderate · <50 Fatigued

### Design rules
- Missing inputs collapse to ~60% of pillar weight (never punish for un-readable signals)
- HRV pillar gracefully degrades from "vs personal baseline" to "vs age-adjusted absolute" to "neutral"
- Backend muscle fatigue (12-muscle model) preferred over flat `muscleFatigueAvg` when available
- Yesterday strain caps total — a heavy session is not double-counted (once via fatigue, again here)

---

## 3. Nutrition Score

**Question:** "How well did I eat today / this week?"
**File:** `backend/app/services/nutrition/nutrition_score.py`, `score_builder.py`
**Range:** 0–100. Server-authoritative for logged meals via `GET /meals/score`. See `NUTRITION_SCORING.md` for the full deep-dive.

### Three sub-scores, weighted by goal

| Sub-score | Inputs | What full credit looks like |
|---|---|---|
| **Adherence** | calorie alignment + protein alignment | Within ±10% of cals, ≥95% of protein target |
| **Food Quality** | 7 inputs: fiber density (14g/1000kcal), added sugar % cals, sat fat % cals, sodium, minimally-processed %, plant diversity, omega-3 signal | All 7 in target zones |
| **Micronutrient Coverage** | Priority-6 micros: calcium, iron, potassium, magnesium, vitamin D, vitamin B12 | All 6 ≥ RDA |

### Goal weights (adherence / quality / micro)
- fat_loss: 45 / 35 / 20
- muscle_gain: 45 / 30 / 25
- body_recomp: 40 / 35 / 25
- endurance: 40 / 35 / 25
- general_health: 30 / 40 / 30
- strength: 45 / 30 / 25

### Versioning
`SCORE_VERSION=3`, `METRICS_VERSION=3`, `CLASSIFIER_VERSION=5`. Bumping any one invalidates `FoodMetadata` cache and re-runs classification on next meal write.

### Design rules
- Protein gets full credit at ≥95% (not 100%) to avoid false penalties for hitting "close enough"
- Vitamin C dropped from priority — trivially hit, told nothing
- Longevity score deleted — Gut & Plants is now a *descriptive* card on Progress→Health, no number
- Protein never moves in carb redistribution; fat absorbs kcal delta

---

## 4. Fitness Score

**Question:** "How fit am I overall?"
**File:** `backend/app/services/workout/fitness_score.py`
**Range:** 0–100 weighted average of 4 pillars. Returns `{ total, rating, pillars: [...] }`.
**Endpoint:** `routers/ai/progression.py::fitness_composite_score`

### Pillar weights
strength **30** · cardio **30** · consistency **25** · recovery **15**

### Strength (0–100, 5 sub-components capped at 100)

| Sub | Max | Logic |
|---|---:|---|
| Compound base | 35 | Avg of `(1RM/BW) / threshold × 100` across showcase lifts, scaled ×0.35. Thresholds: squat 1.5, bench 1.0, OHP 0.66, deadlift 2.0, RDL 1.5, row 1.0, front squat 1.2, DB bench 0.75 |
| Pattern coverage | 20 | 6 fundamental patterns (squat, hinge, h-press, v-press, h-pull, v-pull). `(hit / 6) × 20` |
| Volume load | 15 | Total weight×reps last 28d, scaled by bodyweight. Full credit at 50,000 lb·reps per lb-BW |
| Progression trend | 15 | Fraction of distinct lifts whose recent-window top set > prior-window top set, ×15 |
| Variety | 15 | Distinct exercises last 28d, full credit at 12+ |

**Age adjustment (`_age_strength_threshold_multiplier`)**: thresholds scaled down for older lifters — <35 ×1.00 · <50 ×0.95 · <60 ×0.88 · <70 ×0.78 · 70+ ×0.68. Reasoning: masters tables show ~8–12% per decade drop after 40 is normal.

### Cardio (0–100, ACSM baseline over 14-day window)

| Sub | Max | Logic |
|---|---:|---|
| Z2 minutes | 60 | Target 300 min over 14d (= 150/wk). `min(60, mins/300 × 60)`. Unlabeled cardio counted as 0.5× Z2 |
| Interval sessions | 40 | Target 4 sessions over 14d (= 2/wk). `min(40, sessions/4 × 40)` |

**Age adjustment (`_age_cardio_target_multiplier`)**: <50 ×1.00 · <65 ×0.87 · 65+ ×0.73.

### Consistency (0–100)
`min(100, sessions_14d / (days_per_week × 2) × 100)`. No bonus for going over target.

### Recovery (0–100, partial-credit aware)

| Signal | Max | Logic |
|---|---:|---|
| Sleep avg | 50 | 7–9h → 50 · 6–7 or 9–10 → 30 · 5–6 → 15 · else → 5 |
| Avg session RPE | 50 | ≤8 → 50 · ≤9 → 25 · else → 10 |

If only one signal present, that half is doubled to 100. Both missing → 50 (neutral) with "connect Apple Health" hint.

### Final composite
`total = (strength × 30 + cardio × 30 + consistency × 25 + recovery × 15) / 100`

### Rating bands
≥85 Elite · ≥70 Strong · ≥55 Solid · ≥40 Building · <40 Starting

### Design rules
- Simple weighted average, **not** geometric mean — keeps math explainable
- Recovery weighted lowest because input quality is the worst today
- Each pillar has `data_quality: full | partial | missing` so UI can de-emphasize thin pillars
- Strength pillar rewards what users *actually do* (the old version returned 0 if you never touched showcase lifts)

---

## 5. Fatigue / Muscle Recovery

**Question:** "How fresh is each muscle right now? Should I lift today?"
**File:** `backend/app/services/workout/activity_impact.py`
**Range:** 0.0 (fresh) to 1.0+ (overtrained), per muscle. Derived 0–100 `readiness_score`.
**Endpoint:** `GET /workouts/fatigue` (returns full snapshot + nutrition_context).

### 12 muscle dimensions
`chest, back, shoulders, biceps, triceps, quads, hamstrings, glutes, calves, core, cardio, systemic`

### Decay curve
**Hour-based** with 48h half-life: `decay(h) = 0.5 ^ (h / 48)`. Anything ≥120h (5d) rolls to 0.
**Legacy daily fallback** (rows missing `completed_at`): day 0 → 1.00 · day 1 → 0.50 · day 2 → 0.25 · day 3 → 0.10.

### Two-pass roll-up
1. **Pass 1 — accumulate** all positive (training) fatigue contributions, decayed by recency.
2. **Pass 2 — apply recovery** (negative) values, **max one recovery session per day**, capped at `min(0.15, current × 0.15) × decay`. Prevents recovery stacking.

### Recovery / mobility per-muscle values (negative)

| Day | chest | back | sh. | quads | ham. | glutes | core | systemic |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| recovery | −0.08 | −0.08 | −0.06 | −0.08 | −0.08 | −0.06 | −0.05 | −0.10 |
| mobility | −0.05 | −0.05 | −0.05 | −0.05 | −0.05 | −0.05 | −0.05 | −0.08 |

Negative values are **not** scaled by intensity/duration — a recovery session helps the same whether 30 or 60 minutes.

### Nutrition recovery bonus / penalty
Layered on top of the muscle map. Thresholds are **% of user's protein target** (not absolute grams):

| ratio (protein / target) | status | effect |
|---|---|---|
| ≥0.95 | excellent | recovery bonus reduces fatigue on all muscles |
| ≥0.80 | good | no effect |
| ≥0.60 | low | small penalty (increases fatigue) |
| <0.60 | very_low | larger penalty |
| no meals logged | no_data | no effect, prompts user to log |

### Derived `focus_readiness` per focus type
Weighted by which muscles drive that focus. Examples:
- push → chest 1.0, shoulders 0.8, triceps 0.6
- legs → quads 1.0, glutes 0.8, hamstrings 0.8, calves 0.3
- mobility / recovery → always 1.0

`readiness = 1 - weighted_avg_fatigue`, clamped [0, 1], scaled to 0–100 for UI.

### Planner response (graduated, not binary)
- `readiness ≥ 60%` — proceed normally
- `40–60%` — downgrade intensity
- `20–40%` — swap focus to less-fatigued muscle group
- `<20%` — force recovery day

### Display threshold
`top_fatigued()` shows only muscles with fatigue ≥ 0.12. Lowered from 0.30 in Apr 2026 when we moved to volume-load-based fatigue (heavy 3–5 rep work produces lower per-muscle values, but is real fatigue).

### Design rules
- Recovery / mobility have **negative** fatigue (active recovery > passive rest)
- Two-pass accumulation prevents recovery stacking (one bonus per day, max)
- Fatigue floor clamped at 0.0 — no "negative fatigue" sandbagging
- Multi-completions same day stack; both affect fatigue
- See `FATIGUE_SYSTEM.md` for the full model + injury overlay

---

## 6. Rolling e1RM

**Question:** "What's my honest working 1RM on this lift right now?"
**File:** `backend/app/services/workout/rolling_e1rm.py`
**Range:** lbs as `{ e1rm_lbs, sample_count, confidence }` or `null` (<3 usable sets).

### Formula
```
set_e1rm  = weight × (1 + (reps + actual_rir) / 30)        # Epley with RIR
weight    = exp(-days_since × ln(2) / 14)                  # 14-day half-life
rolling   = weighted median over last 6–10 usable sets
```

### Filters (a set must satisfy ALL to be "usable")
- `completed = True`
- `set_type != "warmup"`
- `actual_weight_lbs > 0`
- `actual_rir ∈ [0, 4]` (falls back to `target_rir` if `actual_rir` null)
- `actual_reps` in role-aware band:
  - compound: 3–10
  - isolation: 6–15

### Confidence tiers
Based on sample count + spread:
- **high** — many recent sets, tight spread
- **med** — moderate evidence
- **low** — few sets or noisy

### Why median, not mean
A single hot session shouldn't lock in a too-high baseline for weeks. Medians ignore outliers; recency-weighting still pulls toward today.

### Why 14-day half-life
Matches mesocycle length — older data still informs but recent performance dominates.

### Caller behavior on `null`
`recommendation.py` falls back to (1) best-ever 1RM if available, then (2) `ai_first_time_weight.py` AI rec, then (3) deterministic tier-6/7 defaults.

### Design rules
- PR display still uses **best-ever** 1RM — that's the achievement
- Daily recs use **rolling** e1RM — that's today's working capacity
- Pure function, no DB writes — caller passes a list of `UsableSet`

---

## 7. Weekly Volume Tiers

**Question:** "Am I undertraining / hitting the right zone / overcooking each muscle this week?"
**File:** `backend/app/services/workout/weekly_volume.py`
**Returns:** per-muscle status + range bounds + spike ratio.
**Endpoint:** `GET /workouts/weekly-volume?days=7` (and 14d / 28d).

### Per-muscle weekly hard-set ranges

| Muscle | lo | hi |
|---|---:|---:|
| chest | 8 | 18 |
| back | 10 | 20 |
| shoulders | 8 | 16 |
| biceps | 6 | 14 |
| triceps | 6 | 14 |
| quads | 8 | 18 |
| hamstrings | 6 | 14 |
| glutes | 6 | 14 |
| calves | 4 | 12 |
| core | 4 | 12 |

`cardio` and `systemic` return `unknown` (we don't range them).

### Set counting
- Primary muscle: 1.0 × set
- Secondary muscle: 0.5 × set
- Warmups filtered out

### Status tiers (in evaluation order)

| Status | Trigger | Meaning |
|---|---|---|
| `spike` | `spike_ratio ≥ 1.5` AND `total ≥ lo` | 1.5×+ jump from 28-day baseline. Strongest early overreach signal. Takes precedence over `high` |
| `undertrained` | `total < lo` | Below evidence-based lower bound |
| `excessive` | `total > hi × 1.5` | Real injury + overreach risk |
| `high` | `total > hi` | Above range but within 1.5× |
| `in_range` | `lo ≤ total ≤ hi` | Sweet spot |
| `unknown` | muscle not in `WEEKLY_RANGES` | cardio/systemic |

### Why spike over absolute
A user ramping from 4 → 12 sets/week (in-range absolute) is the highest injury-risk pattern, even though both endpoints are "fine." The spike flag catches that before the absolute one ever triggers.

### Plan-review consumption
`plan_review_v2.py` reads volume snapshot to emit `reduce_muscle_volume` / `add_muscle_volume` / `hold_muscle_volume` recommendations consumed by the apply-action endpoint.

---

## 8. Fueling & Recovery Flags (NOT scored)

**Question:** "Are there any nutrition red flags I should know about?"
**File:** `backend/app/services/nutrition/recovery_flags.py`
**Returns:** flag-based, never numeric. Tri-state: `green | amber | red | not_enough_data`.
**Endpoint:** `GET /meals/recovery-flags?days=7&thyroid_opt_in=false`

| Flag | What it watches | Red threshold |
|---|---|---|
| `under_fueling` | 7d avg energy availability `EA = (intake − exercise kcal) / FFM kg` | <25 kcal/kg FFM sustained |
| `low_fat` | 7d avg fat % of cals | <15% sustained |
| `recovery_nutrients` | Mg / Zn / vitamin D / Se adequacy | 2+ chronically <50% RDA |
| `metabolic_support` | Composite: added sugar >10% cals, sat fat >10% cals, fiber density <8g/1000kcal, calorie CV >0.30 | 3+ concerns sustained |
| `thyroid_support` (opt-in) | gated by profile setting | — |

### Design rules
- **Never named with hormone/medical terms in UI** — these are wellness flags, not diagnoses
- Iodine not scored (USDA coverage too sparse)
- Hidden when all green
- The footer always reads "not a medical diagnosis"

Why no number: flags are tri-state because the underlying signals don't trade off — having lots of fiber doesn't compensate for severe under-fueling.

---

## 9. Cycle Phase (NOT scored)

**Question:** "Where in the cycle is the user?"
**File:** `src/services/appleHealth.ts::getCycleStatus`
**Source:** Apple HealthKit `HKCategoryType.menstrualFlow` (read via `modules/thallo-healthkit/ios/ThalloHealthKitModule.swift::getMenstrualFlow`).
**Returns:** `{ phase, dayOfCycle, cycleLengthDays, nextExpectedMenses }` or `null` if no data.

### Logic
1. Pull last 90 days of menstrual flow samples
2. Group consecutive flow days (gap ≤ 3d) into period blocks
3. Cycle length = median of gaps between consecutive period starts (defaults to 28 if <2 periods logged)
4. `dayOfCycle = floor((now − lastPeriodStart) / 86400000) + 1`
5. `ovulationDay = cycleLengthDays − 14`

### Phase mapping

| Phase | Day range |
|---|---|
| menses | day 1 to `max(3, min(7, lastPeriodLength))` |
| follicular | post-menses up to ovulation − 1 |
| ovulation | ovulationDay ± 1 |
| luteal | post-ovulation up to cycleLength + 2 |
| unknown | beyond cycleLength + 2 (overdue) or no data |

### Consumed by
- **Preparedness Score** — applies `±3 pt` modifier (ovulation +3, follicular +1, menses −2, luteal 0)
- **CyclePhaseCard** UI — auto-hides if `getCycleStatus()` returns null (men, opted-out users, no data)

### Design rules
- Permission-aware — if HealthKit `menstrualFlow` permission not granted, returns `null` silently
- Card auto-hides when phase is `unknown` or null — never empty-state
- Modifier capped at ±3 of preparedness's 100 — won't dominate the score

---

## Cross-cutting design rules

These principles apply to every score above:

1. **Missing data ≠ bad data.** Default to a neutral subscore (~60% of pillar weight) rather than 0. Show a "connect Apple Health" hint instead of punishing.
2. **Server-authoritative for shared scores.** Anything users compare across devices (Nutrition Score, Weekly Volume) is computed backend. Anything local-only (Sleep Score, Preparedness) can be client-side.
3. **Versioning.** Bump `*_VERSION` constants when formula changes; force re-classification / cache invalidation on next write.
4. **Explainability over precision.** Simple weighted averages beat geometric means; deterministic thresholds beat ML for these scores. The UI must be able to show *why* a number is low.
5. **Pillar bands are deliberately broad.** Wellness scores aren't medical scores — over-precise thresholds make the number jitter.
6. **Recovery-positive bias.** Recovery / mobility days reduce fatigue (negative values); never punish a user for taking a rest day.
7. **Goal-aware weighting.** Nutrition adherence weight is higher for fat_loss; quality is higher for general_health. The same daily intake produces different scores under different goals — by design.
8. **Age-adjusted where evidence-supported.** Strength thresholds and cardio targets scale with age. HRV reference scales with age.
9. **Disclaimers.** Every score that touches health-coded data (recovery flags, sleep score, cycle phase) must say "not a medical diagnosis" in its detail view.
10. **No hormone names in UI.** Recovery flags use words like `under_fueling`, never `RED-S` or `hypothalamic`. Cycle phase tells what *day* the user is on, not what's "wrong."

---

## Where each score is rendered

| Score | Where the user sees it |
|---|---|
| Sleep Score | HomeScreen sleep card · Watch Sleep tab · Progress→Health |
| Preparedness | Progress→Health (`PreparednessCard`, `TrainingReadinessCard`) · Watch Readiness tab |
| Nutrition Score | Meals→Plan (`NutritionCard`) · `/meals/score` API |
| Fitness Score | Progress→Charts |
| Fatigue / Recovery | Progress→Body (`RecoveryCard`) · planner downgrade decisions |
| Rolling e1RM | (internal) — drives daily set recommendations |
| Weekly Volume | Progress→Health (`WeeklyCoachingCard` volume bars) · weekly review |
| Recovery Flags | Meals→Plan (`FuelingRecoveryCard`, hidden when all green) |
| Cycle Phase | HomeScreen `CyclePhaseCard` (auto-hides if no data) · ±3 pt nudge to Preparedness |

---

## When changing a scoring algorithm

1. **Update the formula** in code.
2. **Bump the version constant** if there's one (`SCORE_VERSION`, `METRICS_VERSION`, `CLASSIFIER_VERSION`, `PLANNER_VERSION`).
3. **Update this doc** — every score has a section here. Tables out of sync with code is a regression.
4. **Add or update a pure-function test** in `backend/tests/` (or `src/services/__tests__/` for client scores).
5. **Run** `make test` (backend) — catches regressions on `weekly_volume._classify`, `rolling_e1rm.compute_rolling_e1rm`, etc.
