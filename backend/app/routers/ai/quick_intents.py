"""Quick-action intent router for the trainer chat.

Catches common user asks with deterministic handlers so the LLM
doesn't have to handle them (faster + consistent + free). Falls
through to the general trainer path when no intent matches.

Each handler returns (answer, action) where:
  - answer: short text the UI shows in the chat bubble.
  - action: optional structured dict the client can apply to the
            active plan without a second LLM call. Shape mirrors
            plan_review_v2.Recommendation.action.

Design:
  - Pattern match is coarse on purpose. False positives are cheaper
    than false negatives — worst case the user gets a useful canned
    response they can ignore.
  - Every handler is pure. No DB writes here; the client decides
    whether to auto-apply.
  - Never invent workouts / meals. If an intent needs plan context,
    the response flags `needs_plan_update: true` so the LLM path
    handles it with the actual plan loaded.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
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
            "needs_plan_update": self.needs_plan_update,
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
    ("more_cardio",        [r"more cardio", r"add.*cardio", r"want.*cardio"]),
    ("less_cardio",        [r"less cardio", r"reduce.*cardio", r"cut.*cardio"]),
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


def handle_intent(intent: str, question: str, *, profile: dict | None = None) -> IntentResponse | None:
    """Return a deterministic response for a matched intent, or None
    if the intent needs the full LLM path (too much context-specific
    judgment for a canned response)."""
    handler = _INTENT_HANDLERS.get(intent)
    if handler is None:
        return None
    return handler(question, profile or {})


# ── Individual handlers ────────────────────────────────────────────

def _h_time_limited(q: str, _p: dict) -> IntentResponse:
    # Pull minutes out of the message if present; default to 30.
    m = re.search(r"(\d+)\s*(min|minute)", q.lower())
    mins = int(m.group(1)) if m else 30
    mins = max(10, min(90, mins))
    return IntentResponse(
        intent="time_limited",
        answer=(
            f"Got it — {mins} minutes today. I'll trim today's workout to fit: "
            "warmup dropped, accessories cut, keep the main compounds at "
            "the planned load. Swipe to today's card and tap 'Switch Day' "
            "→ 'Shorten' to apply, or I'll apply it for you."
        ),
        action_items=[
            f"Shorten today's workout to ~{mins} minutes",
            "Keep main compounds, drop accessories + core finisher",
        ],
        needs_plan_update=True,
        action={"type": "shorten_workout", "minutes": mins},
    )


def _h_slept_badly(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="slept_badly",
        answer=(
            "Rough night. I wouldn't skip — but we'll dial the intensity "
            "down today: same exercises, knock 10-15% off the loads, and "
            "drop one accessory to keep the session short. If anything "
            "feels off, stop. Recovery > any single session."
        ),
        action_items=[
            "Reduce today's loads by ~10-15%",
            "Skip the accessory / core finisher",
            "Hit 8+ hours tonight if at all possible",
        ],
        needs_plan_update=True,
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
        needs_plan_update=True,
        action={"type": "swap_to_recovery_or_reduce", "alternative": "zone2_30min"},
    )


def _h_missed_workout(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="missed_workout",
        answer=(
            "One miss is nothing. Don't double up to 'catch up' — that's "
            "where plans fall apart. I'll rotate this week's remaining "
            "sessions so the muscles you missed get priority on the next "
            "day. Tap 'Skip' on that day's card if you haven't already; "
            "the planner handles the rest."
        ),
        action_items=[
            "Tap Skip on the missed day (if not already)",
            "Do today's planned workout as scheduled",
            "Don't try to cram extra volume this week",
        ],
        needs_plan_update=True,
        action={"type": "rebalance_week", "reason": "missed_workout"},
    )


def _h_travel_mode(q: str, _p: dict) -> IntentResponse:
    m = re.search(r"(\d+)\s*(day|days)", q.lower())
    days = int(m.group(1)) if m else 7
    days = max(1, min(14, days))
    return IntentResponse(
        intent="travel_mode",
        answer=(
            f"I can pause the next {days} day{'' if days == 1 else 's'} for travel without regenerating your week. "
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
            "what plateaus get stuck on. I'll add 1-2 cardio sessions to the "
            "next week's plan targeting zone 2 unless you want HIIT."
        ),
        action_items=[
            "Add 1-2 zone 2 sessions (20-40 min each) next week",
            "Easy pace — nose-breathing or hold a conversation",
        ],
        needs_plan_update=True,
        action={"type": "add_cardio_session", "minutes": 30, "style": "zone2", "count": 2},
    )


def _h_less_cardio(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="less_cardio",
        answer=(
            "Got it — I'll trim cardio from next week's plan. Heads up: "
            "some baseline cardio protects recovery + heart health even "
            "on hypertrophy-focused weeks. I'll keep at least 1-2 short "
            "sessions unless you explicitly want zero."
        ),
        action_items=[
            "Cut cardio to 1-2 short sessions next week",
            "Keep strength volume unchanged",
        ],
        needs_plan_update=True,
        action={"type": "reduce_cardio", "target_count": 1},
    )


def _h_deload(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="deload",
        answer=(
            "Deload confirmed. Next week we keep the same exercise "
            "selection but cut loads ~40% and sets ~30%. Reps stay in "
            "range — the point is to move well with less fatigue. "
            "Expect to feel sharper by end of the week."
        ),
        action_items=[
            "Next week = deload: loads -40%, sets -30%",
            "Same exercises + reps",
            "Extra sleep + food; hydrate",
        ],
        needs_plan_update=True,
        action={"type": "schedule_deload", "duration_days": 7, "load_pct": 60, "set_pct": 70},
    )


def _h_more_core(_q: str, _p: dict) -> IntentResponse:
    return IntentResponse(
        intent="more_core",
        answer=(
            "Added. The core programmer will include anti-extension + "
            "anti-rotation work on 3-4 days next week (planks, Pallofs, "
            "carries), balanced so no single session gets overloaded."
        ),
        action_items=[
            "Core added 3-4x/week next week",
            "Mix of anti-extension + anti-rotation + carries",
        ],
        needs_plan_update=True,
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
        needs_plan_update=True,
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
        needs_plan_update=True,
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
