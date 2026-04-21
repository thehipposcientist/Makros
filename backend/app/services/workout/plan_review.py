"""AI plan-review layer.

After the deterministic planner emits a full plan, this module builds
a compact brief and asks an LLM to sanity-check it against the user's
goal + recent training. The LLM returns a structured verdict:

    { "status": "ok" | "modify",
      "notes": str,
      "patches": [ {action, day_index, exercise_index?, ...}, ... ] }

If `status == "modify"`, `apply_patches(plan, patches)` applies the
changes deterministically — no free-form LLM rewrites of the plan.
Patch types are:

    swap_exercise    — replace exercise at (day_index, exercise_index)
    remove_exercise  — drop exercise at (day_index, exercise_index)
    add_exercise     — append exercise to day_index
    change_sets_reps — edit sets/reps/rest on an existing exercise
    change_focus     — retitle a day (no exercise shuffle)

Anything outside this vocabulary is ignored (logged, not applied) so
the AI can't accidentally tear the plan apart. The brief intentionally
only surfaces the next ≤3 days to keep the call cheap.

This module is small and pure except for one AI call. It does NOT
import the planner or DB — the caller builds the brief, calls
`review_plan`, and applies patches back on the plan dict.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal, Optional


# ── Types ────────────────────────────────────────────────────────────

ReviewStatus = Literal["ok", "modify"]

PatchAction = Literal[
    "swap_exercise",
    "remove_exercise",
    "add_exercise",
    "change_sets_reps",
    "change_focus",
]


@dataclass
class PlanPatch:
    action: PatchAction
    day_index: int
    exercise_index: Optional[int] = None  # required for swap/remove/change_sets_reps
    # Payload fields — only the ones relevant to the action are read.
    new_name: Optional[str] = None           # swap_exercise, add_exercise
    new_equipment: Optional[str] = None      # swap_exercise, add_exercise
    new_sets: Optional[int] = None           # swap_exercise, add_exercise, change_sets_reps
    new_reps: Optional[str] = None           # swap_exercise, add_exercise, change_sets_reps
    new_rest_seconds: Optional[int] = None   # swap_exercise, add_exercise, change_sets_reps
    new_focus: Optional[str] = None          # change_focus
    reason: str = ""

    @classmethod
    def from_dict(cls, raw: dict) -> Optional["PlanPatch"]:
        """Parse one patch from the AI's JSON output, tolerating
        missing/unknown fields. Returns None if the patch is too
        malformed to apply (missing action or day_index)."""
        if not isinstance(raw, dict):
            return None
        action = raw.get("action")
        if action not in (
            "swap_exercise", "remove_exercise", "add_exercise",
            "change_sets_reps", "change_focus",
        ):
            return None
        try:
            day_index = int(raw.get("day_index"))
        except (TypeError, ValueError):
            return None
        ex_idx_raw = raw.get("exercise_index")
        exercise_index = None
        if ex_idx_raw is not None:
            try:
                exercise_index = int(ex_idx_raw)
            except (TypeError, ValueError):
                exercise_index = None
        return cls(
            action=action,
            day_index=day_index,
            exercise_index=exercise_index,
            new_name=raw.get("new_name"),
            new_equipment=raw.get("new_equipment"),
            new_sets=_maybe_int(raw.get("new_sets")),
            new_reps=raw.get("new_reps"),
            new_rest_seconds=_maybe_int(raw.get("new_rest_seconds")),
            new_focus=raw.get("new_focus"),
            reason=str(raw.get("reason") or ""),
        )


@dataclass
class PlanReview:
    status: ReviewStatus
    notes: str
    patches: list[PlanPatch] = field(default_factory=list)
    error: Optional[str] = None  # set when the AI call fails; status falls back to "ok"


def _maybe_int(v: Any) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# ── Brief builder ────────────────────────────────────────────────────


# Brief caps. The full plan (all days) is included so the reviewer
# can spot week-level imbalance — recomp with no cardio, strength
# with two arm days and no legs, etc. Per-day exercise count stays
# capped so one day with 14 accessories doesn't blow the token budget.
BRIEF_MAX_EXERCISES_PER_DAY = 10


def build_plan_brief(
    plan: dict,
    *,
    goal: str,
    days_per_week: int,
    experience: str,
    recent_completed: list[dict] | None = None,
    injuries: tuple[str, ...] | list[str] = (),
    focused_muscle: Optional[str] = None,
    secondary_goal: Optional[str] = None,
    goal_details: Optional[dict] = None,
    user_preferred_split: Optional[str] = None,
    skipped_days_7d: Optional[list] = None,
) -> dict:
    """Compact JSON brief the AI reviewer will read.

    Contents (every key is always present — missing data is represented
    by None / empty list so the reviewer prompt has stable field
    lookups):
      - user context: goal, experience, days/week, focused muscle, injuries
      - `user_preferred_split`: the user's chosen split id ("ppl", etc.)
        or None. Reviewer must not propose change_focus patches that
        break this split identity.
      - `skipped_days_7d`: list of focus strings the user has skipped
        in the last 7 days, or None when the caller didn't pass any.
      - `recent_completed`: the user's last ~3 days of finished workouts
        (focus, workout_date, days_ago, duration) so the reviewer can
        reason about time gaps numerically — e.g. "legs 1 day ago" vs
        "legs 4 days ago"
      - `plan_days`: every day of the proposed plan, with up to
        `BRIEF_MAX_EXERCISES_PER_DAY` exercises per day, each stamped
        with `days_from_today` assuming day_index 0 = tomorrow
      - `completed_today_focuses` / `completed_yesterday_focuses`:
        focuses the user completed today / yesterday. Plan days
        matching any "today" focus on day_index 0 are back-to-back
        risks (the reviewer is told not to patch them).

    The brief is a pure function of the plan dict + caller-provided
    context — this module never touches the DB. Callers (e.g. the
    /plans route) may supplement the returned dict with additional
    transient keys before sending to the reviewer.
    """
    from datetime import date as _date

    wp = (plan or {}).get("workout_plan", {}) or {}
    days = wp.get("days", []) or []

    # Build a set of focus labels the user completed TODAY so the
    # reviewer knows not to propose patches that conflict with an
    # already-finished session. Dates are parsed defensively; malformed
    # rows are skipped.
    today = _date.today()
    completed_today_focuses: set[str] = set()
    completed_yesterday_focuses: set[str] = set()
    for r in (recent_completed or []):
        raw_date = r.get("workout_date") or r.get("performed_on")
        if not raw_date:
            continue
        try:
            rd = raw_date if isinstance(raw_date, _date) else _date.fromisoformat(str(raw_date)[:10])
        except Exception:
            continue
        delta = (today - rd).days
        focus = (r.get("focus") or r.get("focus_label") or "").strip().lower()
        if not focus:
            continue
        if delta == 0:
            completed_today_focuses.add(focus)
        elif delta == 1:
            completed_yesterday_focuses.add(focus)

    brief_days: list[dict] = []
    for di, d in enumerate(days):
        exs = d.get("exercises", []) or []
        exs_brief = []
        for ei, e in enumerate(exs[:BRIEF_MAX_EXERCISES_PER_DAY]):
            exs_brief.append({
                "index": ei,
                "name": e.get("name"),
                "sets": e.get("sets"),
                "reps": e.get("reps"),
                "rest_seconds": e.get("restSeconds"),
                "equipment": e.get("equipment"),
                "target_weight_lbs": e.get("targetWeightLbs"),
                "role": e.get("_role"),
                "primary_muscle": e.get("_primary_muscle"),
            })
        plan_focus = (d.get("focus") or "").strip().lower()
        # Day index → days from today. day_index 0 is the next session
        # the user will do — tomorrow. A plan_day whose focus matches
        # something the user finished TODAY is a direct back-to-back
        # continuity risk (1 day gap, same muscle group).
        days_from_today = di + 1
        is_completed_conflict = (
            di == 0 and plan_focus in completed_today_focuses
        )
        brief_days.append({
            "index": di,
            "day": d.get("day"),
            "focus": d.get("focus"),
            "category": d.get("category"),
            "days_from_today": days_from_today,
            "conflicts_with_completed_today": is_completed_conflict,
            "exercises": exs_brief,
        })

    # Recent-completed history — optionally rich. Each entry may
    # carry an `exercises` list (from structured WorkoutSession rows)
    # with real per-set reps/weight, or it may just be a focus label
    # + date (lightweight WorkoutCompletion fallback). Each entry is
    # stamped with `days_ago` so the reviewer can reason about gaps
    # without parsing dates itself.
    recent_brief: list[dict] = []
    for r in (recent_completed or [])[:6]:
        ex_in = r.get("exercises") or []
        ex_out: list[dict] = []
        for e in ex_in[:BRIEF_MAX_EXERCISES_PER_DAY]:
            sets_in = e.get("sets") or []
            sets_out = [
                {
                    "set": s.get("set_number"),
                    "reps": s.get("reps"),
                    "weight_lbs": s.get("weight_lbs"),
                }
                for s in sets_in[:8]
            ]
            ex_out.append({
                "name": e.get("name"),
                "equipment": e.get("equipment"),
                "target_reps": e.get("target_reps"),
                "logged_sets": sets_out,
            })
        raw_date = r.get("workout_date") or r.get("performed_on")
        days_ago: Optional[int] = None
        if raw_date:
            try:
                rd = raw_date if isinstance(raw_date, _date) else _date.fromisoformat(str(raw_date)[:10])
                days_ago = (today - rd).days
            except Exception:
                days_ago = None
        recent_brief.append({
            "focus": r.get("focus") or r.get("focus_label") or r.get("name") or "",
            "workout_date": str(raw_date or ""),
            "days_ago": days_ago,  # 0 = today, 1 = yesterday, etc.
            "duration_minutes": (
                round((r.get("duration_seconds") or 0) / 60)
                if r.get("duration_seconds") else None
            ),
            "exercises": ex_out,
        })

    return {
        "goal": goal,
        "secondary_goal": secondary_goal,
        "goal_details": goal_details,
        "days_per_week": days_per_week,
        "experience": experience,
        "focused_muscle": focused_muscle,
        "injuries": list(injuries or ()),
        # The reviewer prompt references these two fields; always emit
        # them (None when absent) so the prompt's field lookups are safe.
        "user_preferred_split": user_preferred_split,
        "skipped_days_7d": list(skipped_days_7d) if skipped_days_7d else None,
        "recent_completed": recent_brief,
        # Focuses the user has already finished TODAY. Plan days whose
        # focus overlaps with any of these should NEVER be patched —
        # the user is done with them for the calendar day.
        "completed_today_focuses": sorted(completed_today_focuses),
        "completed_yesterday_focuses": sorted(completed_yesterday_focuses),
        "planner_mode": wp.get("planner_mode"),
        "goal_bucket": wp.get("goal_bucket"),
        "plan_days": brief_days,
    }


# ── AI reviewer ──────────────────────────────────────────────────────


_SYSTEM_PROMPT = """You are a strength & conditioning reviewer auditing a deterministic \
workout plan. You are NOT a generator — you never rewrite the plan from scratch. \
You only point out problems and propose small, surgical patches.

You will receive a compact JSON brief describing:
- the user's PRIMARY goal (`goal` / `goal_bucket`) — the dominant driver of plan shape
- `secondary_goal`: optional side-goal (e.g. "maintain strength" on a fat loss plan, \
  "improve conditioning" on a hypertrophy plan). When present, the plan should make \
  room for it without compromising the primary. If absent or null, ignore it.
- `goal_details`: free-form dict the user filled in during onboarding (target \
  bodyweight, deadline, preferences). Use it to refine your read on the plan — do \
  NOT reject it just because it's sparse.
- `focused_muscle`: muscle group the user asked to emphasize (e.g. "chest", "glutes", \
  "back"). When present, the plan MUST show extra exposure to this muscle — either \
  a dedicated isolation accessory on every lifting day OR a higher set count on \
  compounds that hit it. If focused_muscle is set and you don't see clear extra \
  exposure, that's a patch case (add an accessory via add_exercise).
- experience, days/week, injuries
- `recent_completed`: their last three days of finished workouts. Each entry has a \
  `focus` label (e.g. "Pull", "Legs & Core", "Upper Body"), a `workout_date`, a \
  `duration_minutes`, and an `exercises` list. The `exercises` list is OFTEN EMPTY — \
  that means per-set data wasn't captured for that day, NOT that the user did zero \
  exercises. Always treat the `focus` string as the ground truth for what they trained. \
  Do NOT claim a user "did only cardio" or "did nothing" just because `exercises` is \
  empty — use the `focus` label to understand what muscle groups they hit.
- `plan_days`: the FULL proposed plan, every day, with exercises (name, sets, reps, \
  rest, target weight, role). Indexes are 0-based and stable — patches must reference \
  the same index you see here. `target_weight_lbs` is null for cardio, mobility, and \
  timed holds by design — that is NOT a bug, do not patch it.

Use the goal and the last three days of real training to judge fit. Every entry in \
`recent_completed` carries a `days_ago` field: 0 = today, 1 = yesterday, etc. \
Every entry in `plan_days` carries a `days_from_today` field: 1 = tomorrow, 2 = day \
after tomorrow, etc. Use these numbers to reason about TIME GAPS between sessions.

Look for:

- **Muscle proximity / continuity risk** — flag when a plan_day trains the SAME \
  muscle group the user ALREADY trained with too small a gap. Minimum gap rules:
    * Same-muscle compound (push/pull/legs/upper/lower) → **need at least 2 days gap**
    * Same-muscle hypertrophy volume day → **need at least 3 days gap** for recovery
    * Core / calves / forearms → no gap restriction
  Example flags (issue a swap or change_focus patch):
    * recent_completed has `focus="Push"` with `days_ago=0` AND plan_days[0] has \
      `focus="Push"` with `days_from_today=1` → only 1 day gap on push, swap it
    * recent_completed has `focus="Legs"` with `days_ago=1` AND plan_days[0] has \
      `focus="Legs"` with `days_from_today=1` → only 2 days gap but same-day compound \
      legs are usually okay IF the user's goal is high frequency; for beginner/recomp \
      with full recovery this is a 1-day gap issue
  Do NOT flag proximity issues when the gap is ≥3 days.

- **Already-completed today protection** — if `plan_days[i].conflicts_with_completed_today` \
  is TRUE, the user already finished that session earlier today. NEVER patch day[i] \
  under any circumstances — no swap, no remove, no change_sets_reps, no change_focus. \
  The session is done and the plan data for day[i] is historical, not future.

- **Week-level imbalance** relative to the goal: recomp with zero cardio days, strength \
  with only 10-15 rep volume ranges on compounds, endurance with five lifting days \
  and no cardio, muscle gain with only 2 lifting days when days_per_week is 5
- **Missing focused-muscle exposure** when the user asked for it
- **Injury conflicts** (e.g. knee injury but heavy squats programmed)
- **Obviously wrong rep ranges for the goal** (5x5 for fat loss, 4x15 for strength)
- **Any day with zero exercises**
- **Duplicate exercises stacked in the same day**
- **Respect the user's split choice** — if `user_preferred_split` is present (e.g. "ppl" \
  for Push/Pull/Legs), the plan was built around that split intentionally. Do NOT propose \
  change_focus patches that would turn a PPL day into an Upper/Lower day or vice versa. \
  If you see a duplicate focus (e.g. two Push days), that's expected in PPL at 5+ days — \
  only flag it if the duplicates are truly back-to-back with zero recovery between them.
- **Skip patterns** — if `skipped_days_7d` is present and shows the user repeatedly \
  skipping the same focus (e.g. 2+ legs skips in the last week), consider whether the \
  plan is scheduling that focus too aggressively for this user's schedule or motivation. \
  You may propose a change_focus patch to swap a hard-to-attend focus for something the \
  user actually does. Do NOT penalize one-off skips — only flag patterns (2+ of the same).

CRITICAL RULES for the `status` field:
- If the plan has ANY of the issues above → status MUST be "modify" AND you MUST \
  emit at least one patch fixing the biggest issue. It is INVALID to say "status=ok" \
  and then list problems in `notes`. If you identify a problem, fix it with a patch.
- If the plan genuinely has no issues → status="ok" with empty patches and a one-line \
  `notes` confirming the plan looks good.
- Do NOT use phrases like "lacks balance", "does not align", "risk of", \
  "could lead to", "back-to-back", "without adequate recovery", "imbalance", or \
  "continuity risk" in your notes UNLESS status="modify" with at least one patch. \
  These phrases are monitored and a status=ok response containing any of them will \
  be treated as a reviewer failure and the plan will be regenerated from scratch.
- When in doubt between ok and modify, pick modify and emit a patch. Emitting a \
  conservative patch is far better than shipping notes-only complaints.

If it needs fixing, return status "modify" with a SHORT list of patches. Patch actions:
- swap_exercise: replace one exercise; fields: day_index, exercise_index, new_name, new_equipment, new_sets, new_reps, new_rest_seconds, reason
- remove_exercise: drop one exercise; fields: day_index, exercise_index, reason
- add_exercise: append an exercise to a day; fields: day_index, new_name, new_equipment, new_sets, new_reps, new_rest_seconds, reason
- change_sets_reps: retune volume on an existing exercise; fields: day_index, exercise_index, new_sets, new_reps, new_rest_seconds, reason
- change_focus: retitle a day's focus; fields: day_index, new_focus, reason

Return ONLY valid JSON in this shape:
{"status": "ok" | "modify", "notes": "one-paragraph summary of the verdict", "patches": [ ... ]}

Be conservative — prefer 0-2 patches over rewriting the week. Every patch needs a \
one-sentence `reason` explaining why the original was wrong. Patches outside the \
five actions above will be ignored.
"""


_REVIEW_JSON_SCHEMA = {
    "name": "plan_review",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["status", "notes", "patches"],
        "properties": {
            "status": {"type": "string", "enum": ["ok", "modify"]},
            "notes": {"type": "string"},
            "patches": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": True,
                    "required": ["action", "day_index", "reason"],
                    "properties": {
                        "action": {"type": "string"},
                        "day_index": {"type": "integer"},
                        "exercise_index": {"type": ["integer", "null"]},
                        "new_name": {"type": ["string", "null"]},
                        "new_equipment": {"type": ["string", "null"]},
                        "new_sets": {"type": ["integer", "null"]},
                        "new_reps": {"type": ["string", "null"]},
                        "new_rest_seconds": {"type": ["integer", "null"]},
                        "new_focus": {"type": ["string", "null"]},
                        "reason": {"type": "string"},
                    },
                },
            },
        },
    },
}


def review_plan(brief: dict) -> PlanReview:
    """Make one AI call to review the brief. Returns a PlanReview.

    On any exception (no API key, network error, bad JSON) returns
    `PlanReview(status="ok", notes="review unavailable", error=...)`.
    Callers should treat an `error`-bearing review as "no changes" so
    a reviewer outage never blocks plan generation.
    """
    try:
        from openai import OpenAI
        from ...routers.ai.utils import (
            _build_chat_kwargs,
            _chat_create,
            _extract_json,
            get_openai_api_key,
            model_plan_update,
        )
    except Exception as exc:
        return PlanReview(status="ok", notes="reviewer unavailable", error=f"import: {exc}")

    try:
        api_key = get_openai_api_key()
    except Exception as exc:
        return PlanReview(status="ok", notes="reviewer unavailable", error=f"api key: {exc}")
    if not api_key:
        return PlanReview(status="ok", notes="reviewer unavailable", error="no api key")

    try:
        client = OpenAI(api_key=api_key)
        messages = [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    "Review this plan brief and decide whether it needs changes.\n\n"
                    + json.dumps(brief, indent=2)
                ),
            },
        ]
        kwargs = _build_chat_kwargs(
            model_plan_update(),
            messages,
            json_schema=_REVIEW_JSON_SCHEMA,
            max_tokens=1200,
            timeout_secs=35,
        )
        response = _chat_create(client, **kwargs)
        raw = response.choices[0].message.content or ""
        parsed = _extract_json(raw)
    except Exception as exc:
        print(f"[plan_review] AI call failed: {exc}")
        return PlanReview(status="ok", notes="review call failed", error=str(exc))

    status = parsed.get("status")
    if status not in ("ok", "modify"):
        return PlanReview(status="ok", notes=str(parsed.get("notes") or ""), error=f"bad status: {status}")
    notes = str(parsed.get("notes") or "")
    raw_patches = parsed.get("patches") or []
    patches: list[PlanPatch] = []
    if isinstance(raw_patches, list):
        for rp in raw_patches:
            p = PlanPatch.from_dict(rp)
            if p is not None:
                patches.append(p)
    if status == "modify" and not patches:
        # AI said "modify" but gave zero applicable patches — degrade
        # to "ok" so we don't regenerate infinitely.
        status = "ok"
    # Contradiction detector: AI returned status=ok but its notes
    # describe real problems. This is a prompt failure mode we saw in
    # production — the model identifies problems in prose but forgets
    # to emit patches. Logged loudly so we can iterate, surfaced via
    # PlanReview.error so the debug sidecar carries it, and triggers
    # the AI regenerate fallback downstream.
    #
    # The word list is intentionally broad. Every term here was pulled
    # from a real prod log where the reviewer said "ok" while describing
    # actual issues — "back-to-back", "lacks balance", "does not align",
    # "risk of fatigue", "continuity risk", etc. False positives here
    # are cheap (they trigger AI regenerate which is bounded); false
    # negatives ship broken plans.
    if status == "ok" and notes:
        problem_terms = (
            # Imbalance family
            "imbalance", "imbalanced", "lack of", "lacks", "lacking",
            "mismatch", "conflict", "does not align", "doesn't align",
            "not aligned", "out of line", "disproportionate",
            # Missing / insufficient
            "missing", "absent", "no cardio", "no lifting", "no upper",
            "no lower", "no push", "no pull", "no legs",
            "too much", "too many", "too few", "too little",
            "not enough", "insufficient", "inadequate", "needs more",
            "needs to", "should include", "should have", "should add",
            "should be", "recommend adding", "recommend including",
            "would benefit", "would be better",
            # Continuity / recovery risk
            "back-to-back", "back to back", "continuity risk",
            "risk of", "could lead to", "risk of fatigue",
            "without adequate", "without enough", "without proper",
            "insufficient recovery", "inadequate recovery",
            "overlap", "overlaps", "overlapping",
            "same focus", "same muscle",
            # Goal-mismatch
            "not suitable", "not appropriate", "doesn't match",
            "does not match", "mismatched", "wrong for",
        )
        low = notes.lower()
        hits = [t for t in problem_terms if t in low]
        if hits:
            error_msg = f"ok-with-complaints: notes mention {hits[:5]}"
            print(f"[plan_review] CONTRADICTION: AI returned ok but notes describe problems → {error_msg}")
            print(f"[plan_review] full notes: {notes}")
            return PlanReview(status=status, notes=notes, patches=patches, error=error_msg)
    return PlanReview(status=status, notes=notes, patches=patches)


# ── Patch application ───────────────────────────────────────────────


def apply_patches(
    plan: dict,
    patches: list[PlanPatch],
    *,
    blocked_day_indices: frozenset[int] | set[int] | None = None,
) -> tuple[dict, list[str]]:
    """Mutate `plan` in place applying each patch. Returns the plan
    plus a list of human-readable application messages for logging.

    Patches that reference out-of-range indices or missing fields are
    skipped (logged, not applied) so a buggy AI response can't corrupt
    the plan. Order matters: patches are applied in the order received,
    which means later patches see the results of earlier ones — the AI
    is instructed to return a short list so this is fine.

    `blocked_day_indices` — optional set of day_index values the caller
    wants to protect from patches. Use for days the user has already
    completed. Any patch targeting a blocked index is logged + skipped.
    """
    applied: list[str] = []
    wp = (plan or {}).get("workout_plan", {})
    days = wp.get("days", []) if isinstance(wp, dict) else []
    if not isinstance(days, list):
        return plan, ["no days list in plan"]

    blocked = frozenset(blocked_day_indices or ())
    for p in patches:
        if p.day_index in blocked:
            applied.append(
                f"skip {p.action} day={p.day_index}: user already completed "
                f"this session today ({p.reason})"
            )
            continue
        msg = _apply_one(days, p)
        applied.append(msg)
    return plan, applied


def _rehydrate_derived_fields(ex_out: dict) -> None:
    """Rebuild derived planner fields (setScheme) on an existing
    planner-output exercise dict that a patch just mutated. Keeps
    role/slot/muscle metadata from the original untouched.

    Uses `build_set_scheme` directly — we don't have the raw seed row
    here, just the synthesized exercise dict — so starting weights from
    the user's performance profile are NOT re-derived. The setScheme
    still picks up the new sets/reps/rir and carries whatever load was
    stamped on the dict (or null if the swap dropped it).
    """
    try:
        from .set_programming import build_set_scheme  # noqa: WPS433
    except Exception:
        return
    exercise_stub = {
        "slug": ex_out.get("_slug"),
        "name": ex_out.get("name"),
        "primary_muscle": ex_out.get("_primary_muscle"),
        "secondary_muscles": ex_out.get("_secondary_muscles") or [],
        "movement_pattern": ex_out.get("_movement_pattern"),
        "is_compound": ex_out.get("_role") in ("primary", "compound"),
        "equipment_bucket": ex_out.get("_equipment_bucket")
            or ("bodyweight" if (ex_out.get("equipment") or "").lower() == "bodyweight" else None),
    }
    try:
        scheme = build_set_scheme(
            exercise_stub,
            total_sets=int(ex_out.get("sets") or 1),
            reps=str(ex_out.get("reps") or ""),
            rir_target=float(ex_out.get("_rir_target") or 2.0),
            target_weight_lbs=ex_out.get("targetWeightLbs"),
            goal_bucket=str(ex_out.get("_goal_bucket") or ""),
            role=str(ex_out.get("_role") or "accessory"),
            experience=str(ex_out.get("_experience") or "intermediate"),
        )
        ex_out["setScheme"] = [s.to_dict() for s in scheme]
    except Exception:
        # If the rep range is unparsable or other issues, leave
        # setScheme as whatever it was; don't crash patch application.
        ex_out.setdefault("setScheme", [])


def _apply_one(days: list[dict], p: PlanPatch) -> str:
    if not (0 <= p.day_index < len(days)):
        return f"skip {p.action}: day_index {p.day_index} out of range"
    day = days[p.day_index]
    exs = day.get("exercises") or []

    if p.action == "change_focus":
        if not p.new_focus:
            return "skip change_focus: no new_focus provided"
        old = day.get("focus")
        day["focus"] = p.new_focus
        return f"change_focus day={p.day_index} {old!r}→{p.new_focus!r} ({p.reason})"

    if p.action == "remove_exercise":
        if p.exercise_index is None or not (0 <= p.exercise_index < len(exs)):
            return f"skip remove_exercise: bad exercise_index {p.exercise_index}"
        removed = exs.pop(p.exercise_index)
        day["exercises"] = exs
        return f"remove day={p.day_index} idx={p.exercise_index} name={removed.get('name')!r} ({p.reason})"

    if p.action == "swap_exercise":
        if p.exercise_index is None or not (0 <= p.exercise_index < len(exs)):
            return f"skip swap_exercise: bad exercise_index {p.exercise_index}"
        if not p.new_name:
            return "skip swap_exercise: no new_name provided"
        old = exs[p.exercise_index]
        # After a swap we no longer trust the OLD exercise's target
        # weight or slot-specific set scheme — the movement is different
        # (possibly different equipment, different muscle). Drop stale
        # load metadata and let `_rehydrate_derived_fields` rebuild the
        # setScheme with the new sets/reps.
        new_ex = {
            "name": p.new_name,
            "sets": p.new_sets if p.new_sets is not None else old.get("sets", 3),
            "reps": p.new_reps or old.get("reps", "8-12"),
            "restSeconds": p.new_rest_seconds if p.new_rest_seconds is not None else old.get("restSeconds", 90),
            "equipment": p.new_equipment or old.get("equipment", "bodyweight"),
            # Drop stale load / recommendation metadata — the exercise
            # changed, so a weight targeted at the old movement is
            # meaningless. Downstream load recommendation will re-stamp
            # on next load.
            "targetWeightLbs": None,
            "weightRecommendationSource": None,
            "weightRecommendationConfidence": None,
            "weightRecommendationReason": None,
            # Preserve role / slot / muscle metadata so set-scheme
            # stamping still works with the right role context.
            "_role": old.get("_role"),
            "_slot": old.get("_slot"),
            "_rir_target": old.get("_rir_target"),
            "_primary_muscle": old.get("_primary_muscle"),
            "_secondary_muscles": old.get("_secondary_muscles"),
            "_review_patched": True,
        }
        _rehydrate_derived_fields(new_ex)
        exs[p.exercise_index] = new_ex
        return f"swap day={p.day_index} idx={p.exercise_index} {old.get('name')!r}→{p.new_name!r} ({p.reason})"

    if p.action == "change_sets_reps":
        if p.exercise_index is None or not (0 <= p.exercise_index < len(exs)):
            return f"skip change_sets_reps: bad exercise_index {p.exercise_index}"
        ex = exs[p.exercise_index]
        changed = []
        if p.new_sets is not None:
            changed.append(f"sets {ex.get('sets')}→{p.new_sets}")
            ex["sets"] = p.new_sets
        if p.new_reps:
            changed.append(f"reps {ex.get('reps')!r}→{p.new_reps!r}")
            ex["reps"] = p.new_reps
        if p.new_rest_seconds is not None:
            changed.append(f"rest {ex.get('restSeconds')}→{p.new_rest_seconds}")
            ex["restSeconds"] = p.new_rest_seconds
        ex["_review_patched"] = True
        # Rebuild setScheme with the new sets/reps/rir so downstream
        # per-set UI and progression engines see the right shape.
        _rehydrate_derived_fields(ex)
        return f"change_sets_reps day={p.day_index} idx={p.exercise_index} " + ", ".join(changed) + f" ({p.reason})"

    if p.action == "add_exercise":
        if not p.new_name:
            return "skip add_exercise: no new_name provided"
        new_ex = {
            "name": p.new_name,
            "sets": p.new_sets if p.new_sets is not None else 3,
            "reps": p.new_reps or "8-12",
            "restSeconds": p.new_rest_seconds if p.new_rest_seconds is not None else 90,
            "equipment": p.new_equipment or "bodyweight",
            "targetWeightLbs": None,
            "weightRecommendationSource": None,
            "weightRecommendationConfidence": None,
            "weightRecommendationReason": None,
            "_role": "accessory",
            "_rir_target": 2.0,
            "_primary_muscle": None,
            "_secondary_muscles": [],
            "_review_patched": True,
        }
        _rehydrate_derived_fields(new_ex)
        day["exercises"] = list(exs) + [new_ex]
        return f"add day={p.day_index} name={p.new_name!r} ({p.reason})"

    return f"skip unknown action {p.action}"
