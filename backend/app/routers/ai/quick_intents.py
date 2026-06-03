"""Quick-action intent router for the trainer chat.

Catches common user asks with deterministic handlers so the LLM
doesn't have to handle them (faster + consistent + free). Falls
through to the general trainer path when no intent matches.

Each handler returns (answer, action) where:
  - answer: short text the UI shows in the chat bubble.
  - action: optional structured dict the client can send through
            /coach/apply-action without a second LLM call. Shape mirrors
            plan_review_v2.Recommendation.action.

Design:
  - Pattern match is coarse on purpose. False positives are cheaper
    than false negatives — worst case the user gets a useful canned
    response they can ignore.
  - Every handler is pure. No DB writes here; the client decides
    whether to auto-apply.
  - Never invent workouts / meals. Quick intents return safe actions or
    guidance; they do not ask chat to rewrite the active PlanWeek.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any


@dataclass
class IntentResponse:
    """Structured response matching the TrainerQuestionResponse shape
    so the endpoint can return it as-is without reshaping."""
    intent: str
    answer: str
    action_items: list[str]
    needs_plan_update: bool = False
    safety_note: str | None = None
    # Optional structured edit the client can apply. Matches the
    # plan_review_v2 action vocabulary where possible.
    action: dict[str, Any] | None = None

    def to_dict(self) -> dict:
        out: dict[str, Any] = {
            "answer": self.answer,
            "action_items": self.action_items,
            # Active PlanWeeks are fixed; quick actions mutate durable
            # settings/day-state only after the user taps Apply.
            "needs_plan_update": False,
            "intent": self.intent,
        }
        if self.safety_note:
            out["safety_note"] = self.safety_note
        if self.action:
            out["action"] = self.action
        return out


# Intent patterns. Keyed by intent slug. Each value is a list of
# regex fragments — the message is lower-cased first, then any
# fragment match wins. Ordered: first match wins.
_INTENT_PATTERNS: list[tuple[str, list[str]]] = [
    ("time_limited",       [r"only.*(\d+).*(min|minute)", r"(30|15|20|45).*(min|minute).*(today|have)", r"short on time", r"in a rush"]),
    ("slept_badly",        [r"slept (bad|poor|like)", r"didn'?t sleep", r"bad sleep", r"only.*hours.*sleep", r"barely slept"]),
    ("too_sore",           [r"too sore", r"really sore", r"sore as", r"my (legs|arms|body).*sore", r"can'?t move"]),
    ("missed_workout",     [r"missed (my |a )?workout", r"skipped (yesterday|today|my workout)", r"didn'?t work out"]),
    ("travel_mode",        [r"travel(ing)?", r"vacation", r"out of town", r"hotel", r"pause.*(week|workouts?|training)", r"take.*week.*off"]),
    ("less_cardio",        [r"less cardio", r"reduce.*cardio", r"cut.*cardio", r"want.*less.*cardio", r"don'?t want.*more.*cardio", r"no more cardio", r"avoid.*cardio"]),
    ("more_cardio",        [r"more cardio", r"add.*cardio", r"want.*(?:more|extra|additional).*cardio", r"increase.*cardio"]),
    ("deload",             [r"deload", r"need.*rest week", r"need a break", r"feel (burnt ?out|fried|overtraining)"]),
    ("more_core",          [r"more (core|abs)", r"add.*(core|abs)", r"want.*(core|abs).*work"]),
    ("hard_tomorrow",      [r"hard workout tomorrow", r"big (day|workout) tomorrow", r"tomorrow.*(hard|heavy|big)"]),
    ("losing_too_fast",    [r"losing.*too fast", r"dropping.*too fast", r"lost.*too much", r"too much weight"]),
    ("strength_dropping",  [r"strength.*(drop|down|decreas)", r"getting weaker", r"lifts.*(dropping|down)"]),
    ("hungrier",           [r"(so |really )?hungrier", r"constantly hungry", r"hungry.*all.*time", r"can'?t stop eating"]),
]


def match_intent(question: str) -> str | None:
    q = question.lower()
    for slug, patterns in _INTENT_PATTERNS:
        for frag in patterns:
            if re.search(frag, q):
                return slug
    return None


def handle_intent(
    intent: str,
    question: str,
    *,
    profile: dict | None = None,
    plan_context: dict | None = None,
    workout_plan: dict | None = None,
) -> IntentResponse | None:
    """Return a deterministic response for a matched intent, or None
    if the intent needs the full LLM path (too much context-specific
    judgment for a canned response)."""
    handler = _INTENT_HANDLERS.get(intent)
    if handler is None:
        return None
    if intent == "slept_badly":
        return handler(question, profile or {}, plan_context=plan_context, workout_plan=workout_plan)
    return handler(question, profile or {})


# ── Individual handlers ────────────────────────────────────────────

def _human_label(value: Any) -> str:
    text = str(value or "").replace("_", " ").replace("-", " ").strip()
    return " ".join(text.split()).title()


def _today_mapping(plan_context: dict | None) -> dict | None:
    if not isinstance(plan_context, dict):
        return None
    mapping = plan_context.get("scheduleMapping")
    if not isinstance(mapping, list):
        return None
    today_iso = date.today().isoformat()
    for item in mapping:
        if not isinstance(item, dict):
            continue
        if str(item.get("dayLabel") or "").strip().lower() == "today":
            return item
        if str(item.get("calendarDate") or "")[:10] == today_iso:
            return item
    return None


def _matching_workout_day(today_map: dict | None, workout_plan: dict | None) -> dict | None:
    if not isinstance(today_map, dict) or not isinstance(workout_plan, dict):
        return None
    days = workout_plan.get("days")
    if not isinstance(days, list):
        return None
    plan_day = str(today_map.get("planDay") or "").strip().lower()
    focus = str(today_map.get("focus") or "").strip().lower()
    if plan_day:
        for day in days:
            if isinstance(day, dict) and str(day.get("day") or "").strip().lower() == plan_day:
                return day
    if focus:
        for day in days:
            if isinstance(day, dict) and str(day.get("focus") or "").strip().lower() == focus:
                return day
    return None


def _is_heavy_workout_day(day: dict | None) -> bool:
    if not isinstance(day, dict):
        return False
    stimulus = str(day.get("stimulus") or "").strip().lower()
    if stimulus in {"strength", "power"}:
        return True
    archetype = str(day.get("archetype") or "").strip().lower()
    if "heavy" in archetype or "strength" in archetype:
        return True
    exercises = day.get("exercises")
    if not isinstance(exercises, list):
        return False
    for ex in exercises:
        if not isinstance(ex, dict):
            continue
        scheme = ex.get("setScheme") or ex.get("set_scheme")
        if isinstance(scheme, list) and any(
            isinstance(s, dict) and "heavy" in str(s.get("setType") or s.get("set_type") or "").lower()
            for s in scheme
        ):
            return True
        reps = str(ex.get("reps") or "").lower()
        match = re.search(r"\d+", reps)
        sets = ex.get("sets")
        try:
            set_count = int(sets)
        except (TypeError, ValueError):
            set_count = 0
        if match and int(match.group(0)) <= 6 and set_count >= 3:
            return True
    return False


def _today_workout_context(plan_context: dict | None, workout_plan: dict | None) -> dict[str, Any]:
    today_map = _today_mapping(plan_context)
    day = _matching_workout_day(today_map, workout_plan)
    focus = (
        _human_label((today_map or {}).get("focus"))
        or _human_label((day or {}).get("focus"))
        or "Workout"
    )
    return {
        "date": str((today_map or {}).get("calendarDate") or date.today().isoformat())[:10],
        "focus": focus,
        "is_heavy": _is_heavy_workout_day(day),
    }

def _h_time_limited(q: str, _p: dict) -> IntentResponse:
    # Pull minutes out of the message if present; default to 30.
    m = re.search(r"(\d+)\s*(min|minute)", q.lower())
    mins = int(m.group(1)) if m else 30
    mins = max(10, min(90, mins))
    return IntentResponse(
        intent="time_limited",
        answer=(
            f"Got it — {mins} minutes today. For today's active workout, keep the main compounds "
            "at the planned load, skip long warmups, and cut accessories first. If this should be "
            f"your normal cap going forward, Apply will set future generated weeks to ~{mins} minutes."
        ),
        action_items=[
            f"Today: keep compounds and cut accessories to fit ~{mins} minutes",
            f"Future: set generated workouts to ~{mins} minutes",
            "Keep main compounds, drop accessories + core finisher",
        ],
        action={"type": "shorten_workout", "minutes": mins},
    )


def _h_slept_badly(
    _q: str,
    _p: dict,
    *,
    plan_context: dict | None = None,
    workout_plan: dict | None = None,
) -> IntentResponse:
    today_ctx = _today_workout_context(plan_context, workout_plan)
    if today_ctx["is_heavy"]:
        focus = today_ctx["focus"]
        return IntentResponse(
            intent="slept_badly",
            answer=(
                f"I see today is a heavy {focus} day, and last night's sleep was not good. "
                "I recommend making today light cardio or mobility and coming back to the hard lift tomorrow if your schedule allows. "
                "Apply will mark today as recovery; your fixed PlanWeek is not rewritten."
            ),
            action_items=[
                "Today: easy walk, zone 2, or mobility",
                f"Tomorrow: return to the {focus} session if you feel recovered",
                "If you still lift today, keep it RPE 6-7 with no grinders",
            ],
            action={
                "type": "swap_to_recovery",
                "date": today_ctx["date"],
                "reason": "Recovery guidance after poor sleep",
            },
        )
    return IntentResponse(
        intent="slept_badly",
        answer=(
            "Rough night. I wouldn't skip by default, but I recommend dialing "
            "today down: same exercises, knock 10-15% off the loads, and "
            "drop one accessory to keep the session short. If anything "
            "feels off, stop. Recovery > any single session."
        ),
        action_items=[
            "Reduce today's loads by ~10-15%",
            "Skip the accessory / core finisher",
            "Hit 8+ hours tonight if at all possible",
        ],
        action={"type": "reduce_intensity", "pct": 12},
    )


def _h_too_sore(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="too_sore",
        answer=(
            "Soreness tells us we hit something. If you can barely move, "
            "swap today for a walk or mobility session — real recovery. "
            "If it's moderate, go lighter: same plan, 15-20% less load, "
            "stop early if joints complain. A true deload week is smart "
            "if this has been a multi-week pattern."
        ),
        action_items=[
            "Option A: swap to zone 2 cardio or mobility",
            "Option B: keep the plan, cut loads 15-20%",
            "Flag the muscle that's worst so the planner can space it",
        ],
        action={"type": "swap_to_recovery_or_reduce", "alternative": "zone2_30min"},
    )


def _h_missed_workout(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="missed_workout",
        answer=(
            "One miss is nothing. Don't double up to 'catch up' — that's "
            "where plans fall apart. Tap 'Skip' on that day's card if you "
            "haven't already; the planner handles the current week from "
            "there. Apply will save this as a rebalance note for the next "
            "plan review."
        ),
        action_items=[
            "Tap Skip on the missed day (if not already)",
            "Do today's planned workout as scheduled",
            "Don't try to cram extra volume this week",
        ],
        action={"type": "rebalance_week", "reason": "missed_workout"},
    )


def _h_travel_mode(q: str, _p: dict) -> IntentResponse:
    m = re.search(r"(\d+)\s*(day|days)", q.lower())
    days = int(m.group(1)) if m else 7
    days = max(1, min(14, days))
    return IntentResponse(
        intent="travel_mode",
        answer=(
            f"Apply can pause the next {days} day{'' if days == 1 else 's'} for travel without regenerating your week. "
            "Those dates are marked skipped, your PlanWeek stays intact, and the next normal week picks up from your durable preferences."
        ),
        action_items=[
            f"Mark the next {days} day{'' if days == 1 else 's'} as travel / paused",
            "Keep the active 7-day plan fixed",
            "Resume normal training after the pause",
        ],
        needs_plan_update=False,
        action={"type": "travel_mode", "days": days},
    )


def _h_more_cardio(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="more_cardio",
        answer=(
            "Happy to add. For most goals, more zone 2 (easy, conversational "
            "pace) is higher-leverage than more intervals — aerobic base is "
            "what plateaus get stuck on. Apply can add one future weekly "
            "training day for zone 2 unless you want HIIT."
        ),
        action_items=[
            "Add 1-2 zone 2 sessions (20-40 min each) next week",
            "Easy pace — nose-breathing or hold a conversation",
        ],
        action={"type": "add_cardio_session", "minutes": 30, "style": "zone2", "count": 2},
    )


def _h_less_cardio(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="less_cardio",
        answer=(
            "Got it — I recommend trimming cardio on future weeks. Heads up: "
            "some baseline cardio protects recovery + heart health even "
            "on hypertrophy-focused weeks. Keep at least 1-2 short sessions "
            "unless you explicitly want zero."
        ),
        action_items=[
            "Cut cardio to 1-2 short sessions next week",
            "Keep strength volume unchanged",
        ],
        action={"type": "reduce_cardio", "target_count": 1},
    )


def _h_deload(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="deload",
        answer=(
            "A deload makes sense. Apply can schedule it for future generated weeks: keep the same exercise "
            "selection but cut loads ~40% and sets ~30%. Reps stay in "
            "range — the point is to move well with less fatigue. "
            "Expect to feel sharper by end of the week."
        ),
        action_items=[
            "Next week = deload: loads -40%, sets -30%",
            "Same exercises + reps",
            "Extra sleep + food; hydrate",
        ],
        action={"type": "schedule_deload", "duration_days": 7, "load_pct": 60, "set_pct": 70},
    )


def _h_more_core(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="more_core",
        answer=(
            "Apply can set core frequency to 4 days/week for future plans. "
            "The planner will favor anti-extension + anti-rotation work "
            "(planks, Pallofs, carries), balanced so no single session gets overloaded."
        ),
        action_items=[
            "Core added 3-4x/week next week",
            "Mix of anti-extension + anti-rotation + carries",
        ],
        action={"type": "set_core_frequency", "days_per_week": 4},
    )


def _h_hard_tomorrow(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="hard_tomorrow",
        answer=(
            "Set yourself up: eat 20-30% more carbs today (especially "
            "dinner), hit your protein target, sleep 8+ hours. If today's "
            "a lift, keep it standard — don't go harder 'in preparation.' "
            "Light movement > extra volume pre-big-day."
        ),
        action_items=[
            "Add ~75-100g carbs to today's macros",
            "Sleep 8+ hours tonight",
            "Keep today's workout at standard intensity",
        ],
        needs_plan_update=False,
        action={"type": "carb_bump_today", "extra_g": 80},
    )


def _h_losing_too_fast(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="losing_too_fast",
        answer=(
            "Losing faster than ~1% bodyweight per week hurts strength + "
            "muscle. Bump calories up ~200 kcal/day (mostly from carbs) "
            "and hold for 2 weeks. If weight loss slows to target and "
            "strength returns, stay here. If it speeds up, we'll tune again."
        ),
        action_items=[
            "Add ~200 kcal/day (mostly carbs)",
            "Hold for 2 weeks before adjusting",
            "Prioritize protein — aim for 0.9-1g per lb bodyweight",
        ],
        action={"type": "raise_calories", "kcal": 200},
        safety_note=(
            "Rapid weight loss with poor recovery is the setup for "
            "under-eating disorders — tell your doctor if it feels off."
        ),
    )


def _h_strength_dropping(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="strength_dropping",
        answer=(
            "Strength drop in a cut usually means either deficit too deep, "
            "recovery too low, or volume too high for the deficit. I'd "
            "bump calories 150 kcal (carbs), cut one accessory per "
            "session, and protect sleep this week. Re-test in 10 days."
        ),
        action_items=[
            "Add 150 kcal/day",
            "Drop one accessory per session",
            "Protect 8+ hours sleep this week",
            "Re-test lifts in 10 days",
        ],
        action={"type": "strength_preservation", "kcal": 150, "reduce_accessories": 1},
    )


def _h_hungrier(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="hungrier",
        answer=(
            "Hunger spikes usually come from low protein, low fiber, or "
            "recent training load. Aim for 30g+ protein per meal, 25-35g "
            "fiber/day, and enough volume-dense low-calorie foods "
            "(vegetables, fruit, broth-based soups). If it persists "
            "past a few days, we should raise your calorie floor."
        ),
        action_items=[
            "30g+ protein per meal",
            "25-35g fiber/day (veg, legumes, berries)",
            "Volume foods: leafy greens, broth soups, popcorn",
            "If hunger lasts 3+ days, raise calories 100-150",
        ],
        needs_plan_update=False,
    )


_INTENT_HANDLERS = {
    "time_limited":      _h_time_limited,
    "slept_badly":       _h_slept_badly,
    "too_sore":          _h_too_sore,
    "missed_workout":    _h_missed_workout,
    "travel_mode":       _h_travel_mode,
    "more_cardio":       _h_more_cardio,
    "less_cardio":       _h_less_cardio,
    "deload":            _h_deload,
    "more_core":         _h_more_core,
    "hard_tomorrow":     _h_hard_tomorrow,
    "losing_too_fast":   _h_losing_too_fast,
    "strength_dropping": _h_strength_dropping,
    "hungrier":          _h_hungrier,
}
