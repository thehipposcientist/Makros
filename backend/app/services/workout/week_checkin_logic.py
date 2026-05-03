"""End-of-week structured check-in logic.

Pure functions — no DB writes. Callers (plan_weeks router) own the DB.

Flow:
  1. compute_checkin_summary_from_review() — wraps WeeklyReview into a
     flat, UI-friendly summary object.
  2. compute_coach_findings() — deterministic wins / needs-attention text
     from adherence + volume data.
  3. compute_checkin_recommendations() — maps user's check-in answers +
     adherence data into concrete next-week adjustments + action_list for
     apply_action().

No LLM calls. All logic is rule-based and deterministic.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

DifficultyRating = Literal[
    "too_easy", "about_right", "too_hard",
    "too_time_consuming", "did_not_like_plan",
]
BlockerType = Literal[
    "time", "fatigue", "soreness", "equipment",
    "motivation", "cardio_boring", "exercise_discomfort",
    "nutrition_hard", "none",
]
PainArea = Literal[
    "none", "shoulder", "elbow_wrist", "low_back",
    "knee", "hip", "foot_ankle", "other",
]


@dataclass
class WeeklyCheckinAnswers:
    overall_difficulty: DifficultyRating | None = None
    biggest_blocker: BlockerType | None = None
    pain_area: PainArea | None = None
    goal_q4: str | None = None  # goal-specific question answer
    user_decision: str = "apply_recommendations"


@dataclass
class CoachFindings:
    wins: list[str] = field(default_factory=list)
    needs_attention: list[str] = field(default_factory=list)
    recovery_notes: list[str] = field(default_factory=list)
    nutrition_notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "wins": self.wins,
            "needs_attention": self.needs_attention,
            "recovery_notes": self.recovery_notes,
            "nutrition_notes": self.nutrition_notes,
        }


@dataclass
class RecommendedAdjustments:
    difficulty_adjustment: str = "same"          # easier | same | harder
    volume_adjustment_pct: int = 0               # -30 to +15
    intensity_adjustment: str = "maintain"       # reduce | maintain | increase
    session_length_adjustment: str | None = None  # shorter | same | longer
    cardio_adjustment: str | None = None
    mobility_adjustment: str | None = None
    nutrition_adjustment: str | None = None
    muscle_priorities: list[str] = field(default_factory=list)
    avoid_patterns: list[str] = field(default_factory=list)
    preferred_cardio_modes: list[str] = field(default_factory=list)
    action_list: list[dict] = field(default_factory=list)
    summary: str = ""

    def to_dict(self) -> dict:
        return {
            "difficulty_adjustment": self.difficulty_adjustment,
            "volume_adjustment_pct": self.volume_adjustment_pct,
            "intensity_adjustment": self.intensity_adjustment,
            "session_length_adjustment": self.session_length_adjustment,
            "cardio_adjustment": self.cardio_adjustment,
            "mobility_adjustment": self.mobility_adjustment,
            "nutrition_adjustment": self.nutrition_adjustment,
            "muscle_priorities": self.muscle_priorities,
            "avoid_patterns": self.avoid_patterns,
            "preferred_cardio_modes": self.preferred_cardio_modes,
            "action_list": self.action_list,
            "summary": self.summary,
        }


@dataclass
class WeeklyCheckinSummary:
    planned_workouts: int = 0
    completed_workouts: int = 0
    missed_workouts: int = 0
    adherence_pct: float = 0.0
    cardio_minutes: float = 0.0
    zone2_minutes: float = 0.0
    strength_sessions: int = 0
    nutrition_adherence_pct: float = 0.0
    nutrition_logging_pct: float = 0.0
    days_logged: int = 0
    avg_calories: float = 0.0
    avg_protein_g: float = 0.0
    avg_fiber_g: float = 0.0
    nutrition_summary: str = ""
    avg_sleep_hours: float | None = None
    avg_resting_hr: float | None = None
    goal: str = ""
    week_start: str = ""
    week_end: str = ""
    headline: str = ""
    coach_findings: CoachFindings = field(default_factory=CoachFindings)
    # Stash raw review for the recommendation engine
    _raw_review: Any = field(default=None, repr=False)

    def to_dict(self) -> dict:
        return {
            "planned_workouts": self.planned_workouts,
            "completed_workouts": self.completed_workouts,
            "missed_workouts": self.missed_workouts,
            "adherence_pct": round(self.adherence_pct, 1),
            "cardio_minutes": round(self.cardio_minutes, 0),
            "zone2_minutes": round(self.zone2_minutes, 0),
            "strength_sessions": self.strength_sessions,
            "nutrition_adherence_pct": round(self.nutrition_adherence_pct, 1),
            "nutrition_logging_pct": round(self.nutrition_logging_pct, 1),
            "days_logged": self.days_logged,
            "avg_calories": round(self.avg_calories, 1),
            "avg_protein_g": round(self.avg_protein_g, 1),
            "avg_fiber_g": round(self.avg_fiber_g, 1),
            "nutrition_summary": self.nutrition_summary,
            "avg_sleep_hours": self.avg_sleep_hours,
            "avg_resting_hr": self.avg_resting_hr,
            "goal": self.goal,
            "week_start": self.week_start,
            "week_end": self.week_end,
            "headline": self.headline,
            "coach_findings": self.coach_findings.to_dict(),
        }


# ── Public API ─────────────────────────────────────────────────────────────────

def compute_checkin_summary_from_review(review: Any) -> WeeklyCheckinSummary:
    """Wrap a WeeklyReview into a flat check-in summary."""
    planned = review.sessions_planned
    completed = review.sessions_completed
    missed = max(0, planned - completed)

    summary = WeeklyCheckinSummary(
        planned_workouts=planned,
        completed_workouts=completed,
        missed_workouts=missed,
        adherence_pct=review.adherence_pct,
        cardio_minutes=review.cardio_minutes,
        zone2_minutes=review.zone2_minutes,
        nutrition_adherence_pct=review.nutrition_adherence_pct,
        nutrition_logging_pct=getattr(review, "nutrition_logging_pct", review.nutrition_adherence_pct),
        days_logged=review.days_logged,
        avg_calories=getattr(review, "avg_calories", 0.0),
        avg_protein_g=getattr(review, "avg_protein_g", 0.0),
        avg_fiber_g=getattr(review, "avg_fiber_g", 0.0),
        nutrition_summary=getattr(review, "nutrition_summary", ""),
        avg_sleep_hours=review.avg_sleep_hours,
        avg_resting_hr=review.avg_resting_hr,
        goal=review.goal,
        week_start=str(review.week_start),
        week_end=str(review.week_end),
        headline=review.headline,
        _raw_review=review,
    )

    # Count strength sessions from completions if available
    try:
        for c in getattr(review, "_completions", []):
            if getattr(c, "activity_category", "strength") != "cardio":
                summary.strength_sessions += 1
    except Exception:
        pass

    summary.coach_findings = _compute_coach_findings(review)
    return summary


def compute_checkin_recommendations(
    summary: WeeklyCheckinSummary,
    answers: WeeklyCheckinAnswers,
    goal: str,
) -> RecommendedAdjustments:
    """Map check-in answers + adherence → concrete next-week adjustments.

    Priority order:
      1. Pain (safety override — always applied first)
      2. Low adherence + time blocker (volume/length reduction)
      3. Low adherence + fatigue/soreness (intensity reduction)
      4. Difficulty too hard
      5. Difficulty too easy + high adherence (progression)
      6. Didn't like plan (variety flag)
      7. Default: maintain
    """
    adj = RecommendedAdjustments()

    adherence = summary.adherence_pct
    difficulty = answers.overall_difficulty
    blocker = answers.biggest_blocker
    pain = answers.pain_area

    # ── 1. Pain area (safety first) ───────────────────────────────────────────
    if pain and pain != "none":
        adj.intensity_adjustment = "reduce"
        adj.avoid_patterns.append(pain)

        _PAIN_NOTES: dict[str, str] = {
            "shoulder":    "Reducing pressing and overhead volume. Prioritizing pulling movements.",
            "elbow_wrist": "Avoiding heavy supination grip. Switching to neutral-grip alternatives.",
            "low_back":    "Reducing axial loading. Prioritizing hip-hinge patterns with lighter loads.",
            "knee":        "Reducing knee-dominant volume. Prefer cycling or incline walk over running.",
            "hip":         "Avoiding deep hip flexion under load. Reducing single-leg and abductor volume.",
            "foot_ankle":  "Removing impact cardio (running, jumping). Bike or upper-body focus.",
            "other":       "Taking a conservative approach — reducing intensity and avoiding new exercises.",
        }
        _PAIN_AVOID: dict[str, list[str]] = {
            "shoulder":    ["overhead_press", "upright_row"],
            "knee":        ["running", "jump", "deep_squat"],
            "low_back":    ["heavy_deadlift", "good_morning"],
            "hip":         ["hip_flexor", "deep_squat", "bulgarian_split_squat"],
        }
        adj.summary = _PAIN_NOTES.get(pain, "Adjusting conservatively for the flagged area.")
        adj.avoid_patterns.extend(_PAIN_AVOID.get(pain, []))
        adj.action_list.append({
            "type": "noop",
            "title": f"Pain flag: {pain}",
            "detail": adj.summary,
        })

    # ── 2. Low adherence + time pressure → shorten + cut volume ──────────────
    if adherence < 65 and (blocker in ("time",) or difficulty == "too_time_consuming"):
        adj.difficulty_adjustment = "easier"
        adj.volume_adjustment_pct = -20
        adj.session_length_adjustment = "shorter"
        adj.intensity_adjustment = adj.intensity_adjustment if pain and pain != "none" else "maintain"
        if not adj.summary:
            adj.summary = "Shortening sessions and trimming accessories so you can fit workouts in."
        adj.action_list.append({
            "type": "shorten_workout",
            "target_minutes_delta": -15,
        })

    # ── 3. Low adherence + fatigue/soreness → dial back intensity ────────────
    elif adherence < 65 and blocker in ("fatigue", "soreness"):
        adj.difficulty_adjustment = "easier"
        adj.volume_adjustment_pct = -10
        adj.intensity_adjustment = "reduce"
        if not adj.summary:
            adj.summary = "Pulling back intensity to let you recover — aim to finish sessions feeling capable, not depleted."

    # ── 4. Too hard (good or low adherence) ──────────────────────────────────
    elif difficulty == "too_hard":
        adj.difficulty_adjustment = "easier"
        adj.volume_adjustment_pct = -10
        adj.intensity_adjustment = "reduce"
        if not adj.summary:
            adj.summary = "Dialing back loads — sessions should feel challenging but finishable."

    # ── 5. Too easy + solid adherence → progress ─────────────────────────────
    elif difficulty == "too_easy" and adherence >= 80:
        adj.difficulty_adjustment = "harder"
        adj.volume_adjustment_pct = 10
        adj.intensity_adjustment = "increase"
        if not adj.summary:
            adj.summary = "Increasing load and volume — you've demonstrated you can handle more."

    # ── 6. Didn't like the plan ───────────────────────────────────────────────
    elif difficulty == "did_not_like_plan":
        if not adj.summary:
            adj.summary = "Noted — exercise variety will be prioritized. Different movements, same muscle targets."
        adj.action_list.append({
            "type": "noop",
            "title": "Exercise variety requested",
            "detail": "Different exercise selections where possible next week.",
        })

    # ── 7. Default: maintain ──────────────────────────────────────────────────
    else:
        if not adj.summary:
            adj.summary = "Plan structure is working — staying the course with consistent execution."

    # ── Cardio ────────────────────────────────────────────────────────────────
    if blocker == "cardio_boring":
        adj.cardio_adjustment = "Switching cardio format — try a different modality."
        adj.preferred_cardio_modes = ["bike", "incline_walk", "row"]

    _CARDIO_NEEDS_GOALS = {"body_recomp", "fat_loss", "endurance", "general_health", "longevity"}
    if summary.cardio_minutes < 20 and goal in _CARDIO_NEEDS_GOALS:
        extra = " Adding one short cardio session (20–30 min)."
        adj.cardio_adjustment = (adj.cardio_adjustment or "") + extra

    # ── Nutrition ─────────────────────────────────────────────────────────────
    if blocker == "nutrition_hard" or summary.nutrition_logging_pct < 50:
        adj.nutrition_adjustment = "Simplifying meal structure — focus on protein and calories first, everything else second."

    # ── Goal-specific Q4 ─────────────────────────────────────────────────────
    if answers.goal_q4:
        _apply_goal_q4(adj, goal, answers.goal_q4)

    # ── User decision override ────────────────────────────────────────────────
    decision = answers.user_decision
    if decision == "make_easier":
        adj.difficulty_adjustment = "easier"
        adj.volume_adjustment_pct = min(adj.volume_adjustment_pct, -10)
        adj.intensity_adjustment = "reduce"
        adj.session_length_adjustment = "shorter"
        adj.summary = "Making next week easier — lighter loads and shorter sessions."
        adj.action_list.append({"type": "shorten_workout", "target_minutes_delta": -10})
    elif decision == "make_harder":
        adj.difficulty_adjustment = "harder"
        adj.volume_adjustment_pct = max(adj.volume_adjustment_pct, 10)
        adj.intensity_adjustment = "increase"
        adj.summary = "Stepping up difficulty — more volume and heavier loads."
    elif decision == "keep_current_style":
        adj.difficulty_adjustment = "same"
        adj.volume_adjustment_pct = 0
        adj.intensity_adjustment = "maintain"
        adj.session_length_adjustment = None
        adj.action_list = []
        adj.summary = "Keeping the same plan structure for next week."

    return adj


# ── Private helpers ────────────────────────────────────────────────────────────

def _compute_coach_findings(review: Any) -> CoachFindings:
    findings = CoachFindings()
    adherence = review.adherence_pct
    planned = review.sessions_planned
    completed = review.sessions_completed
    missed = max(0, planned - completed)

    # Wins
    if adherence >= 90:
        findings.wins.append(f"Completed {completed}/{planned} workouts — near-perfect week.")
    elif adherence >= 75:
        findings.wins.append(f"Completed {completed}/{planned} planned sessions — solid consistency.")
    elif adherence >= 50:
        findings.wins.append(f"Got {completed} session{'s' if completed != 1 else ''} in despite the week — that's progress.")

    if review.cardio_minutes >= 90:
        findings.wins.append(f"{int(review.cardio_minutes)} min of cardio — aerobic base is being maintained.")
    elif review.cardio_minutes >= 40:
        findings.wins.append(f"{int(review.cardio_minutes)} min of cardio logged.")

    if review.zone2_minutes >= 60:
        findings.wins.append(f"{int(review.zone2_minutes)} min Zone 2 — solid aerobic base work.")

    avg_protein = getattr(review, "avg_protein_g", 0) or 0
    avg_fiber = getattr(review, "avg_fiber_g", 0) or 0
    days_logged = getattr(review, "days_logged", 0) or 0
    nutrition_logging_pct = getattr(review, "nutrition_logging_pct", getattr(review, "nutrition_adherence_pct", 0)) or 0
    protein_target_adherence_pct = getattr(review, "protein_target_adherence_pct", None)
    calorie_target_adherence_pct = getattr(review, "calorie_target_adherence_pct", None)
    nutrition_summary = getattr(review, "nutrition_summary", "") or ""
    if avg_protein >= 160:
        findings.wins.append("Protein intake was on point this week.")
    if nutrition_summary:
        findings.nutrition_notes.append(nutrition_summary)
    if days_logged == 0:
        findings.nutrition_notes.append("No meals logged this week — nutrition coaching is data-limited.")
    elif nutrition_logging_pct < 50:
        findings.nutrition_notes.append(
            f"Only {days_logged} day{'s' if days_logged != 1 else ''} logged — get to 4+ days before changing targets."
        )
    else:
        if protein_target_adherence_pct is not None:
            findings.nutrition_notes.append(
                f"Protein target hit on {protein_target_adherence_pct:.0f}% of logged target days."
            )
        elif avg_protein > 0:
            findings.nutrition_notes.append(f"Protein averaged {avg_protein:.0f}g/day.")
        if calorie_target_adherence_pct is not None:
            findings.nutrition_notes.append(
                f"Calories were near target on {calorie_target_adherence_pct:.0f}% of logged target days."
            )
        if avg_fiber > 0 and avg_fiber < 20:
            findings.nutrition_notes.append(f"Fiber averaged {avg_fiber:.0f}g/day — push toward 25g+.")

    # Needs attention
    if missed > 0:
        findings.needs_attention.append(
            f"Missed {missed} planned workout{'s' if missed > 1 else ''}."
        )

    if review.cardio_minutes < 20 and planned > 0:
        findings.needs_attention.append("Cardio was minimal — even 20 min helps recovery and base fitness.")

    if nutrition_logging_pct < 50 and days_logged > 0:
        findings.needs_attention.append("Nutrition tracking was sparse — harder to hit targets without logging.")
    elif days_logged == 0:
        findings.needs_attention.append("No nutrition data this week.")

    # Volume-based
    try:
        for muscle, row in review.volume.by_muscle.items():
            status = getattr(row, "status", "")
            if status == "undertrained":
                findings.needs_attention.append(
                    f"{muscle.replace('_', ' ').title()} volume was low — consider adding a set or two next week."
                )
            elif status in ("excessive", "spike"):
                findings.needs_attention.append(
                    f"{muscle.replace('_', ' ').title()} volume was high — reduce or deload to avoid overuse."
                )
    except Exception:
        pass

    # Recovery notes
    if review.avg_sleep_hours is not None:
        h = review.avg_sleep_hours
        if h < 6.5:
            findings.recovery_notes.append(
                f"Average sleep was {h:.1f}h — below the 7h recovery threshold. "
                "Training adaptations slow significantly under 7h."
            )
        elif h >= 7.5:
            findings.recovery_notes.append(f"Sleep averaged {h:.1f}h — good recovery conditions.")

    if review.avg_resting_hr is not None:
        hr = review.avg_resting_hr
        if hr > 70:
            findings.recovery_notes.append(
                f"Resting HR was {hr:.0f} bpm — slightly elevated, which can indicate incomplete recovery."
            )

    # Defaults if nothing found
    if not findings.wins:
        findings.wins.append("You showed up — consistency is the foundation everything else is built on.")
    if not findings.needs_attention:
        findings.needs_attention.append("No major concerns this week. Keep executing the plan.")

    return findings


def _apply_goal_q4(adj: RecommendedAdjustments, goal: str, answer: str) -> None:
    if goal in ("muscle_gain", "body_recomp"):
        if answer and answer != "no_preference":
            adj.muscle_priorities.append(answer)

    elif goal == "strength":
        if answer == "too_light":
            adj.intensity_adjustment = "increase"
            adj.volume_adjustment_pct = max(adj.volume_adjustment_pct, 5)
        elif answer == "too_heavy":
            adj.intensity_adjustment = "reduce"
            adj.volume_adjustment_pct = min(adj.volume_adjustment_pct, -5)

    elif goal == "endurance":
        _mode_map = {
            "running": "run",
            "cycling": "bike",
            "incline_walk": "incline_walk",
            "rowing": "row",
        }
        mode = _mode_map.get(answer)
        if mode:
            adj.preferred_cardio_modes = [mode]

    elif goal in ("general_health", "longevity"):
        _focus_map = {
            "zone2":          "Prioritizing Zone 2 cardio sessions.",
            "steps":          "Adding daily step target as a goal.",
            "sleep":          "Scheduling sessions earlier to protect sleep windows.",
            "mobility":       "Adding one mobility session per week.",
            "strength":       "Maintaining current strength session frequency.",
            "reduce_fatigue": "Reducing intensity to lower cumulative fatigue.",
        }
        note = _focus_map.get(answer)
        if note:
            adj.cardio_adjustment = f"{adj.cardio_adjustment}; {note}" if adj.cardio_adjustment else note

    elif goal in ("fat_loss",):
        _hard_map = {
            "hunger":          "Adding protein anchors to meals to reduce hunger.",
            "energy":          "Slightly reducing deficit — energy is a compliance signal.",
            "meal_logging":    "Simplifying tracking — log just protein + calories.",
            "cardio":          "Reducing cardio duration, keeping frequency.",
            "weekend_eating":  "Noting weekend eating patterns for the coach context.",
            "protein":         "Prioritizing protein targets above all other macro goals.",
        }
        note = _hard_map.get(answer)
        if note:
            adj.nutrition_adjustment = note
