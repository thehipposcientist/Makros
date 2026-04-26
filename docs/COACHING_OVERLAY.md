# Coaching Overlay — Architecture & Rationale

## What this doc covers
1. The problem we were solving
2. How the system works end-to-end
3. **The big question: doesn't the planner already do this?** (Why the overlay doesn't conflict with deterministic intent)
4. What stays deterministic vs what gets AI personalization
5. How recommendations flow through to real plan changes
6. Test coverage
7. What's next

---

## 1. Problem we were solving

The weekly coaching card had an `Apply` button on every recommendation. Users tapped it expecting their plan to change. **Most of the time, nothing happened.**

`apply_action.py` had a "descriptive-only" dict for ~17 action types (`add_cardio_session`, `reduce_muscle_volume`, `set_core_frequency`, `schedule_deload`, `raise_protein_target`, etc.). Tapping Apply on any of these wrote a `CoachMemory(event_type="recommendation_acked")` row and returned a friendly "Logged" message. The planner never read those rows. Next regen produced the identical recipe.

Only 4 recommendation types actually mutated state: `change_days_per_week` → `UserPreferences`, `raise_calories` / `lower_calories` → `UserCoachingState.calorie_adjustment`, `swap_to_recovery` → `UserDayState`. Every other Apply was a placebo with a paper trail.

**The user's framing**: "we shouldn't be making recommendations that can't be applied — this is deceiving."

---

## 2. How the system works

### `UserCoachingOverlay` table
One row per user. JSONB + scalar fields the planner reads on every regen.

| Field | Type | Purpose |
|---|---|---|
| `muscle_volume_bias` | JSONB `{muscle: float}` | Per-muscle multiplier on weekly hard-set target. Range 0.7–1.3. |
| `cardio_minutes_target` | int? | Total weekly cardio override |
| `zone2_minutes_target` | int? | Subset of total that should be zone 2 |
| `core_sessions_target` | int? | Per-week core block count override |
| `intensity_bias` | str? | strength / hypertrophy / endurance / balanced |
| `deload_until_date` | date? | Active deload window |
| `nutrition_adjustments` | JSONB `{protein_delta_g, fiber_delta_g}` | Macro target deltas |
| `last_refreshed_at` / `expires_at` | timestamp | Drives decay sweep |

### Two services
- **`apply_overlay_action(db, user_id, action_type, payload, rec_key)`** — handles 11 action types. Clamps every value (volume bias [0.7, 1.3], cardio [0, 360], protein delta [-30, +60], etc.). Records a `CoachMemory(event_type="ai_apply")` audit row with old + new values. Bumps `expires_at` 4 weeks forward. Returns `OverlayApplyResult` with a concrete summary string.
- **`snapshot_for_planner(db, user_id, run_decay=True)`** — returns a frozen dict shaped for `PlannerInputs.coaching_overlay`. Runs the decay sweep first.

### Planner reads (4 hook sites)
1. **`weekly_set_targets`** — applies `muscle_volume_bias` after region multipliers. Cuts every target 30% when `deload_active`.
2. **`_inject_hybrid_cardio`** — accepts `target_override` derived from `cardio_minutes_target / 20` (≈20 min cardio finisher per hybrid).
3. **`program_core_across_week`** — `core_target_override` overrides the goal × days table.
4. **`prescribe_for_slot`** — wrapped in `_apply_deload` (cuts 1 set, bumps RIR +2) when `deload_active`. `_prescribe_lifting` routes through stimulus prescriber when `intensity_bias` is set.

### Three regen entry points (all load the snapshot)
- `routers/ai/plans.py::_build_deterministic_workout` — full weekly regen
- `routers/workouts.py::generate_single_day` — single-day swap regen
- `routers/workouts.py::generate_full_week` — switch-day full-week regen

### Apply pipeline
```
WeeklyCoachingCard / CoachCheckinModal
        │
        ▼
POST /coach/apply-action  (single rec)
POST /coach/apply-bulk    (NEW — many recs in one batch, single regen at end)
        │
        ▼
apply_action.py
  ├── change_days_per_week / raise_calories / swap_to_recovery / hold / noop  →  legacy paths
  ├── unknown action  →  hard reject ("That recommendation can't be auto-applied")
  └── everything else  →  apply_overlay_action  →  UserCoachingOverlay
                                  │
                                  ▼
                          CoachMemory audit row
```

### Decay
Every regen calls `snapshot_for_planner(run_decay=True)`. If `expires_at` has passed, every field steps half a stride toward neutral (volume biases by 0.05, cardio targets by 15 min, intensity bias clears entirely, past deload dates clear). Without this, a user who taps Apply once and never logs a follow-up would carry that bias forever.

### Audit trail
Every successful apply writes `CoachMemory(event_type="ai_apply", details={action, from, to, rec_key})`. Future "undo last rec" UI is one query.

---

## 3. The big question: doesn't the planner already aim for muscle balance?

**Yes — and that's exactly why the overlay layers ON TOP of it instead of replacing it.**

Here's what stays deterministic:

| Already in the planner | Overlay does NOT touch this |
|---|---|
| Goal × experience baseline volume tables (`_WEEKLY_VOLUME`) | ✅ Untouched |
| Region priority multipliers (`upper_body` → upper +20%, lower −10%) | ✅ Untouched |
| Focus profile (`focused_muscle` adds +30% on top of the above) | ✅ Untouched |
| Adjacency repair (no back-to-back push days) | ✅ Untouched |
| Split identity guards (PPL stays PPL) | ✅ Untouched |
| Recovery / mobility / rest-day injection at high days/week | ✅ Untouched |
| Movement-pattern injury blocks | ✅ Untouched |

Here's what the overlay adds — and **only as deltas on top** of the above:

| User signal | Overlay translation | Where it hits the planner |
|---|---|---|
| "More quads" rec accepted | `muscle_volume_bias["quads"] = 1.1` | After region + focus profile in `weekly_set_targets`. Quads target jumps from baseline-after-region-after-focus by another 10%. |
| "Add cardio" rec accepted | `cardio_minutes_target = 30` | `_inject_hybrid_cardio` derives `target_override = round(30/20) = 2` instead of reading the goal × days table. |
| "Reduce chest volume" | `muscle_volume_bias["chest"] = 0.9` | Same place as quads — the bias multiplier. |
| "Schedule deload" | `deload_until_date = today + 7d` | All targets cut 30%, all RIRs bumped +2, all primary set counts -1 for 7 days. |

### Concrete example: quad volume

A muscle_gain user, intermediate, lower_body region priority, focused_muscle="quads":

```
Baseline (muscle_gain, intermediate)         → quads = 16 sets
× region priority (lower_body, +20%)         → quads = 19 sets
× focus profile (+30%, min +2)               → quads = 25 sets
× overlay muscle_volume_bias["quads"] = 1.1  → quads = 28 sets
× advanced-cap + 5 ceiling                   → quads = min(28, ceiling)
```

The overlay does **NOT replace** the deterministic stack. It's the LAST multiplier — and only when the user has explicitly accepted a rec that asked for it. If they never tap Apply, the overlay map is empty and the planner produces the exact same plan it produced before this system existed.

### The architectural rule
> AI can only do what the user can do via existing app UI.

The overlay maps each "Apply" to a setting the user could in theory adjust manually — same way `change_days_per_week` is just an automated equivalent of editing the profile. The planner doesn't know an AI was involved; it only sees inputs.

**The deterministic algorithm stays in charge of the structure of the plan** (which days, which patterns, which adjacencies). The overlay only nudges the dimensions the user has explicitly said they want nudged.

---

## 4. Deterministic vs AI split

| Layer | Deterministic? | Notes |
|---|---|---|
| Weekly review math (volume by muscle, cardio mins, weight slope, adherence %) | ✅ 100% | `compute_weekly_review` in `plan_review_v2.py` |
| Recommendation set (which recs are emitted) | ✅ 100% | Rules-driven from the math |
| Action type each rec carries | ✅ 100% | Hard-coded per rule. AI cannot invent action types. |
| Apply layer (the actual mutations) | ✅ 100% | Clamping, audit, decay all bounded |
| Planner output given an overlay snapshot | ✅ 100% | Same inputs → same plan, always |
| **Weekly check-in narrative** (hero summary, wins, gaps, rec rewrites, closer) | 🤖 AI (gpt-5-mini) | Wraps the deterministic data in a personal story |
| Rec **titles + details** the user reads | 🤖 AI rewrites optional | If the AI returns `rec_overrides[rec.key]`, we use the personalized version. If it doesn't, we use the deterministic title/detail. |

### What the AI is allowed to do
- Write the hero summary referencing specific numbers from the math
- Pick top 3 wins and top 3 gaps from the metrics
- Rewrite rec titles/details for personal framing
- Write a closer line
- Decide a `rationale_key`

### What the AI is NOT allowed to do
- Invent new recommendations (the `rec_overrides` dict is filtered against the deterministic rec key set — hallucinated keys are dropped)
- Change `action.type` (the action object itself never goes through the AI)
- Push deltas larger than the apply-layer caps (they get clamped regardless)
- Skip the audit trail (every accepted rec writes a `CoachMemory` row)

### Cost
~ once per week per user × ~$0.05–0.10 per call = trivial. The user explicitly OK'd heavy AI for the once-a-week moment.

---

## 5. End-to-end: what the user experiences

**Today** (just shipped):
1. User opens the app on Sunday/Monday.
2. `WeeklyCoachingCard` (Progress tab) shows the deterministic recommendations with Apply buttons that **actually work now**. Tapping `Apply` writes to the overlay → next regen reflects the change.
3. Recommendations that have no real apply path (e.g., advisory `noop` recs like "log more meals") render with a single `Got it` button — **no Apply button**, so the user is never deceived again.

**Next** (the check-in flow we just built backend for):
1. User opens the weekly check-in modal.
2. Backend computes the deterministic review, then `compose_weekly_narrative` (gpt-5-mini) wraps it in a personal narrative.
3. User sees: hero summary → wins → gaps → recommendations as checkboxes → one CTA: `Apply N changes & rebuild plan`.
4. Tapping the CTA fires `/coach/apply-bulk` with the checked items. Backend runs each through `apply_action`, aggregates results, returns one `needs_regen` flag.
5. Client kicks one regen (not N) and the user sees the new plan reflecting their accepted recs.

The frontend modal rewrite for step 1–4 is queued — backend is ready and tested.

---

## 6. Test coverage (104 tests, all green)

| File | Tests | What it locks down |
|---|---|---|
| `test_apply_action.py` (updated) | 29 | Every action type's safety cap, the new "unsupported actions are rejected" contract, every overlay-routed action persists to UserCoachingOverlay |
| `test_coach_overlay.py` (new) | 35 | Clamping bounds, repeat-apply accumulation, neutral-entry cleanup, missing-payload rejection, decay-on-expiry (in both directions), snapshot shape stability, audit-trail guarantee |
| `test_overlay_planner_integration.py` (new) | 24 | Volume bias actually changes `weekly_set_targets`. Deload actually trims sets/RIR. Cardio override actually changes hybrid count. Core override actually places that many core blocks. Intensity bias actually routes through stimulus prescriber. Empty/None overlays produce identical baseline output. |
| `test_weekly_checkin_apply_bulk.py` (new) | 16 | Bulk apply runs every item independently, partial failures don't abort, `needs_regen` aggregates with OR, AI rec_overrides are sanitized against hallucinated keys, AI output wins/needs are capped at 3 each, fallback returns identical shape on AI error |

Live verified end-to-end against the running container before tests landed: applied 7 different overlay actions via Python REPL, all wrote durable state, snapshot read everything back correctly. Caught and fixed a real tz-naive vs tz-aware datetime bug in the decay sweep.

---

## 7. What's next

**Frontend**:
- Rewrite `CoachCheckinModal` with the 5 blocks (hero / wins / gaps / rec checkboxes / CTA)
- Wire the modal to call `compose_weekly_narrative` then `/coach/apply-bulk`
- Show concrete summary on success ("Applied 4 changes — plan refreshes on next open")

**Optional polish**:
- After Apply, one extra AI turn that says "here's what your plan looks like next week and why" — makes the change feel intentional, not magical
- "Undo last week's recs" UI that reads the `CoachMemory` audit trail
- Surface the `fiber_g_target` from `PlanSnapshot` in `NutritionCard` so the bumped fiber actually shows up in the macro UI (currently still hard-coded "28g")

**Eventual**:
- Per-day overlay (`UserDayState.session_minutes_override` etc) to enable `shorten_workout` / `reduce_intensity` / `carb_bump_today` quick-intent actions, which are currently rejected as unknown
