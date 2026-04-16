# AI Usage & Cost

**Model:** gpt-4o-mini ($0.15/1M input, $0.60/1M output tokens)  
**Design principle:** Deterministic first, AI for quality/content only. Every AI call has a fallback.

---

## At a Glance

| What | AI? | Cost per event |
|---|---|---|
| Workout plan structure | **No** — fully deterministic | $0 |
| Exercise selection & scoring | **No** — rule-based | $0 |
| Sets / reps / rest | **No** — stimulus-aware prescriptions | $0 |
| Split recommendation | **No** — scoring engine | $0 |
| Calorie / macro targets | **No** — TDEE calculator | $0 |
| Meal portion solving | **No** — linear solver | $0 |
| Trainer note | Yes | ~$0.0005 |
| Nutritionist note | Yes | ~$0.0006 |
| Meal skeleton (names/concepts) | Yes (variety > 1) | ~$0.0015 |
| Food micronutrient enrichment | Yes (first time only, cached) | ~$0.0005/batch |
| Post-assembly micro enrichment | Yes (items missing micros) | ~$0.001 |
| Workout review + patches | Yes (if enabled) | ~$0.001 |
| Nutrition review + patches | Yes (if enabled) | ~$0.0009/template |
| In-workout recommendation | Yes (suspicious sets only) | ~$0.0004 |
| Food photo scan | Yes | ~$0.001 |
| Trainer/nutritionist chat | Yes | ~$0.001/message |
| Post-workout summary | Yes | ~$0.0007 |
| Weekly check-in | Yes | ~$0.0005 |

---

## Cost per Event (detailed)

### Full Plan Generation (workout + nutrition)

| Step | AI calls | Est. cost | Notes |
|---|---|---|---|
| Workout plan (deterministic) | 0 | $0 | Split, recipe, slots, exercises, prescriptions |
| Trainer note | 1 | $0.0005 | Grounded in actual plan + recent history |
| Food enrichment (unknown foods) | 0-1 | $0-0.001 | Only for foods not in DB |
| Lazy micro backfill | 0-4 | $0-0.002 | Batches of 5, cached in DB after first hit |
| Meal skeleton AI | 0-1 | $0-0.0015 | Skipped when variety=1 (deterministic) |
| Post-assembly micro enrichment | 0-4 | $0-0.002 | Catches items routine/custom foods missed |
| Nutritionist note | 1 | $0.0006 | Cites exact targets, meals, nutrients |
| Plan review (workout) | 0-1 | $0-0.001 | Only if `PLAN_REVIEW_ENABLED=1` |
| Plan review (nutrition) | 0-3 | $0-0.003 | Only if `NUTRITION_REVIEW_ENABLED=1` |
| **Total (flags off)** | **2-6** | **$0.002-0.006** | |
| **Total (flags on)** | **3-10** | **$0.004-0.012** | |

### Nutrition-Only Regen

| Step | AI calls | Est. cost |
|---|---|---|
| Food enrichment | 0-1 | $0-0.001 |
| Lazy micro backfill | 0-4 | $0-0.002 |
| Meal skeleton AI | 0-1 | $0-0.0015 |
| Post-assembly enrichment | 0-4 | $0-0.002 |
| Nutritionist note | 1 | $0.0006 |
| Nutrition review | 0-3 | $0-0.003 |
| **Total** | **1-10** | **$0.001-0.010** |

### Workout-Only Regen

| Step | AI calls | Est. cost |
|---|---|---|
| Workout plan (deterministic) | 0 | $0 |
| Trainer note | 1 | $0.0005 |
| Plan review | 0-1 | $0-0.001 |
| **Total** | **1-2** | **$0.0005-0.0015** |

### Active Workout Session

| Step | AI calls | Est. cost |
|---|---|---|
| AI warmup generation | 0-1 | $0-0.0003 (cached per day) |
| Next-set recommendation | 0-3 | $0-0.0012 (only suspicious sets) |
| Post-workout summary | 1 | $0.0007 |
| **Total per session** | **1-5** | **$0.001-0.002** |

---

## Monthly Cost Estimates

### Moderate User
4 workouts/week, 1 plan regen/month, 10 chat messages, 20 food scans, 4 check-ins

| Category | Calls/mo | Cost/mo |
|---|---|---|
| Plan generation | 1 full + 2 nutrition | ~$0.02 |
| Active workouts (16) | ~20 | ~$0.02 |
| Chat (10 messages) | 10 | ~$0.01 |
| Food scans (20) | 20 | ~$0.02 |
| Check-ins (4) | 4 | ~$0.002 |
| **Total (flags off)** | | **~$0.07/mo** |
| **Total (flags on)** | | **~$0.10/mo** |

### Heavy User
6 workouts/week, weekly plan regens, 40 chat messages, 60 food scans

| Category | Calls/mo | Cost/mo |
|---|---|---|
| Plan generation (4 full + 4 nutrition) | ~60 | ~$0.06 |
| Active workouts (24) | ~30 | ~$0.03 |
| Chat (40 messages) | 40 | ~$0.04 |
| Food scans (60) | 60 | ~$0.06 |
| Check-ins (4) | 4 | ~$0.002 |
| **Total** | | **~$0.20-0.40/mo** |

### Power User (worst case)
Daily food scans, multiple chats/day, frequent plan tweaks

| | **~$0.80-1.50/mo** |

**Dominant cost driver:** image-based food scans, not text chat or plan generation.

---

## Feature Flags

| Flag | Default | Effect |
|---|---|---|
| `PLAN_REVIEW_ENABLED=1` | Off | Enables workout AI review (surgical patches only, no regen) |
| `NUTRITION_REVIEW_ENABLED=1` | Off | Enables per-template nutrition QA (macro + micro patches) |
| `STARTUP_ENRICH_FOODS_ENABLED=1` | On | Background food micro enrichment on server boot |
| `OPENAI_API_KEY` missing | — | All AI calls degrade gracefully; deterministic paths still work |

---

## What's Fully Deterministic (zero AI, zero cost)

These systems produce identical output for identical input with no AI involvement:

- **Workout plan structure** — split selection, weekly recipe, day sequencing, exercise scoring, filtering, volume tracking
- **Stimulus programming** — heavy/hypertrophy/volume day assignment, prescription dispatch
- **Set programming** — heavy_top / backoff / volume / technique set roles
- **Split recommendation** — scoring, fit percentages, rationale text
- **Calorie / macro targets** — TDEE computation, goal-adjusted macros
- **Meal portion solving** — linear optimization to hit macro targets
- **Nutrition macro normalization** — scale meals to exact targets
- **Exercise adjacency repair** — focus-family-aware day spacing
- **Intensity cost spacing** — prevents back-to-back hard days
- **Plan validation** — 5 invariant checks before plan ships
- **Focus muscle volume boost** — +30% target, +1 set per exercise, deficit backfill

---

## AI Regenerate (disabled)

The AI plan regenerate path (`regenerate_plan_with_ai`) has been permanently disabled (`should_regenerate = False`). It previously replaced entire deterministic plans with free-form AI output, destroying split structure, stimulus types, and exercise family integrity. The AI reviewer can still apply surgical patches (swap one exercise, add an accessory) but can never replace the full plan.
