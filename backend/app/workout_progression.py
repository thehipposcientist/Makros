from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class GoalType(str, Enum):
    HYPERTROPHY = "hypertrophy"
    STRENGTH = "strength"
    FAT_LOSS = "fat_loss"
    MAINTAIN = "maintain"
    ENDURANCE = "endurance"


class ExperienceLevel(str, Enum):
    BEGINNER = "beginner"
    INTERMEDIATE = "intermediate"
    ADVANCED = "advanced"


class RecoveryLevel(str, Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"


class ProgressionPace(str, Enum):
    CONSERVATIVE = "conservative"
    MODERATE = "moderate"
    AGGRESSIVE = "aggressive"


class PhaseType(str, Enum):
    ACCUMULATION = "accumulation"
    INTENSIFICATION = "intensification"
    DELOAD = "deload"


class WorkoutFocus(str, Enum):
    PUSH = "push"
    PULL = "pull"
    LEGS = "legs"
    UPPER = "upper"
    LOWER = "lower"
    FULL_BODY = "full_body"


class ExerciseCategory(str, Enum):
    COMPOUND = "compound"
    ISOLATION = "isolation"
    MACHINE = "machine"
    BODYWEIGHT = "bodyweight"


class SetType(str, Enum):
    WARMUP = "warmup"
    STRAIGHT = "straight"
    TOP_SET = "top_set"
    BACKOFF = "backoff"


class ProgressionPriority(str, Enum):
    REPS_FIRST = "reps_first"
    LOAD_FIRST = "load_first"
    HYBRID = "hybrid"


class EffortFeedback(str, Enum):
    EASY = "easy"
    GOOD = "good"
    HARD = "hard"
    FAILURE = "failure"
    PAIN = "pain"
    FORM_BREAKDOWN = "form_breakdown"


class RecommendationAction(str, Enum):
    INCREASE = "increase"
    HOLD = "hold"
    DECREASE = "decrease"
    END_EXERCISE = "end_exercise"
    DELOAD = "deload"


@dataclass
class UserTrainingProfile:
    primary_goal: GoalType
    experience_level: ExperienceLevel
    recovery_level: RecoveryLevel
    progression_pace: ProgressionPace


@dataclass
class ReadinessInput:
    sleep_hours: Optional[float] = None
    energy_1_to_5: Optional[int] = None
    soreness_1_to_5: Optional[int] = None
    stress_1_to_5: Optional[int] = None
    calories_on_target_recently: Optional[bool] = None


@dataclass
class WorkoutContext:
    workout_name: str
    focus: WorkoutFocus
    phase: PhaseType
    week_number: int


@dataclass
class PlannedSet:
    set_number: int
    set_type: SetType
    # Optional rep-range override from the plan, e.g. "3-5" for a heavy top
    # set. When present, the progression engine honors this instead of
    # deriving the range from the user's primary goal + exercise category.
    # This is what keeps "heavy 3-5" on a hypertrophy-goal user from being
    # misclassified as "missed the 6-8 target".
    target_reps_override: Optional[str] = None


@dataclass
class ExercisePrescription:
    exercise_name: str
    category: ExerciseCategory
    planned_sets: list[PlannedSet]
    increment_lbs: float
    progression_priority: ProgressionPriority
    default_start_weight_lbs: Optional[float] = None
    fatigue_drop_threshold_reps: int = 3
    max_live_increase_pct: float = 0.05
    max_live_decrease_pct: float = 0.10


@dataclass
class SetResult:
    set_number: int
    weight_lbs: float
    reps: int
    rir: Optional[float] = None
    feedback: Optional[EffortFeedback] = None


@dataclass
class SetTarget:
    set_number: int
    set_type: SetType
    rep_min: int
    rep_max: int
    rir_min: float
    rir_max: float


@dataclass
class NextSetRecommendation:
    action: RecommendationAction
    next_set_number: Optional[int]
    recommended_weight_lbs: Optional[float]
    target_rep_min: Optional[int]
    target_rep_max: Optional[int]
    user_message: str
    coach_message: str
    debug: dict[str, Any] = field(default_factory=dict)


class WorkoutProgressionEngine:
    @staticmethod
    def round_to_increment(weight: float, increment: float) -> float:
        if increment <= 0:
            return round(weight, 2)
        return round(weight / increment) * increment

    @staticmethod
    def clamp_weight_change(current_weight: float, proposed_weight: float, max_up_pct: float, max_down_pct: float) -> float:
        max_up = current_weight * (1 + max_up_pct)
        max_down = current_weight * (1 - max_down_pct)
        return max(min(proposed_weight, max_up), max_down)

    @staticmethod
    def get_planned_set(planned_sets: list[PlannedSet], set_number: int) -> PlannedSet:
        for planned_set in planned_sets:
            if planned_set.set_number == set_number:
                return planned_set
        raise ValueError(f"No planned set found for set_number={set_number}")

    @staticmethod
    def get_next_planned_set(planned_sets: list[PlannedSet], current_set_number: int) -> Optional[PlannedSet]:
        sorted_sets = sorted(planned_sets, key=lambda x: x.set_number)
        found_current = False
        for planned_set in sorted_sets:
            if found_current:
                return planned_set
            if planned_set.set_number == current_set_number:
                found_current = True
        return None

    @staticmethod
    def get_working_sets(results: list[SetResult], planned_sets: list[PlannedSet]) -> list[SetResult]:
        planned_by_num = {planned.set_number: planned for planned in planned_sets}
        return [
            result
            for result in results
            if planned_by_num.get(result.set_number) and planned_by_num[result.set_number].set_type != SetType.WARMUP
        ]

    def readiness_score(self, readiness: Optional[ReadinessInput]) -> float:
        if readiness is None:
            return 0.0

        score = 0.0
        if readiness.sleep_hours is not None:
            if readiness.sleep_hours >= 8:
                score += 0.75
            elif readiness.sleep_hours < 6:
                score -= 1.0

        if readiness.energy_1_to_5 is not None:
            if readiness.energy_1_to_5 >= 4:
                score += 0.5
            elif readiness.energy_1_to_5 <= 2:
                score -= 0.75

        if readiness.soreness_1_to_5 is not None:
            if readiness.soreness_1_to_5 >= 4:
                score -= 0.75
            elif readiness.soreness_1_to_5 <= 2:
                score += 0.25

        if readiness.stress_1_to_5 is not None:
            if readiness.stress_1_to_5 >= 4:
                score -= 0.5
            elif readiness.stress_1_to_5 <= 2:
                score += 0.25

        if readiness.calories_on_target_recently is not None:
            score += 0.25 if readiness.calories_on_target_recently else -0.25

        return score

    def readiness_label(self, readiness: Optional[ReadinessInput]) -> str:
        score = self.readiness_score(readiness)
        if score <= -1.5:
            return "poor"
        if score <= -0.5:
            return "low"
        if score < 0.75:
            return "normal"
        return "high"

    def build_set_target(
        self,
        profile: UserTrainingProfile,
        workout: WorkoutContext,
        prescription: ExercisePrescription,
        set_number: int,
    ) -> SetTarget:
        planned = self.get_planned_set(prescription.planned_sets, set_number)

        # Prefer the plan's explicit rep range when present. The workout
        # planner emits per-set target_reps like "3-5" for heavy top sets,
        # "8-12" for volume, etc. Ignoring these in favor of goal-based
        # defaults was misclassifying correct sets (e.g. 225×5 on target 3-5
        # was being compared to hypertrophy's 6-8 and flagged as a miss).
        override_range = self._parse_rep_range_override(planned.target_reps_override)
        if override_range is not None:
            rep_min, rep_max = override_range
        else:
            rep_min, rep_max = self._base_rep_range(profile.primary_goal, prescription.category, planned.set_type)
        rir_min, rir_max = self._base_rir_range(profile.primary_goal, prescription.category, planned.set_type)

        rep_min, rep_max, rir_min, rir_max = self._apply_phase_adjustment(
            rep_min,
            rep_max,
            rir_min,
            rir_max,
            workout.phase,
        )
        # Focus adjustment skipped when an explicit override is present —
        # the plan already accounted for focus when it emitted the range.
        if override_range is None:
            rep_min, rep_max = self._apply_focus_adjustment(rep_min, rep_max, workout.focus, prescription.category)

        return SetTarget(
            set_number=set_number,
            set_type=planned.set_type,
            rep_min=rep_min,
            rep_max=rep_max,
            rir_min=rir_min,
            rir_max=rir_max,
        )

    @staticmethod
    def _parse_rep_range_override(raw: Optional[str]) -> Optional[tuple[int, int]]:
        """Parse a plan-supplied rep-target string (e.g. "3-5", "8", "6-8").
        Returns None when the string is empty / non-numeric / reversed."""
        if not raw:
            return None
        s = str(raw).strip().replace(" ", "")
        if not s:
            return None
        try:
            if "-" in s:
                lo_str, hi_str = s.split("-", 1)
                lo, hi = int(lo_str), int(hi_str)
            else:
                lo = hi = int(s)
        except ValueError:
            return None
        if lo <= 0 or hi <= 0 or hi < lo:
            return None
        return lo, hi

    def _base_rep_range(self, goal: GoalType, category: ExerciseCategory, set_type: SetType) -> tuple[int, int]:
        if goal == GoalType.STRENGTH:
            if category == ExerciseCategory.COMPOUND:
                if set_type == SetType.TOP_SET:
                    return (3, 6)
                if set_type in (SetType.BACKOFF, SetType.STRAIGHT):
                    return (4, 6)
                return (5, 8)
            if set_type == SetType.WARMUP:
                return (8, 10)
            return (6, 10)

        if goal == GoalType.HYPERTROPHY:
            if category == ExerciseCategory.COMPOUND:
                if set_type == SetType.TOP_SET:
                    return (6, 8)
                if set_type == SetType.BACKOFF:
                    return (8, 12)
                if set_type == SetType.STRAIGHT:
                    return (6, 10)
                return (8, 10)
            if category in (ExerciseCategory.ISOLATION, ExerciseCategory.MACHINE):
                if set_type == SetType.WARMUP:
                    return (10, 12)
                return (10, 15)
            if set_type == SetType.WARMUP:
                return (8, 10)
            return (8, 15)

        if goal in (GoalType.FAT_LOSS, GoalType.MAINTAIN):
            if category == ExerciseCategory.COMPOUND:
                if set_type == SetType.TOP_SET:
                    return (5, 8)
                if set_type == SetType.BACKOFF:
                    return (8, 10)
                if set_type == SetType.STRAIGHT:
                    return (6, 10)
                return (8, 10)
            if category in (ExerciseCategory.ISOLATION, ExerciseCategory.MACHINE):
                if set_type == SetType.WARMUP:
                    return (10, 12)
                return (10, 15)
            if set_type == SetType.WARMUP:
                return (8, 10)
            return (8, 15)

        if goal == GoalType.ENDURANCE:
            if category == ExerciseCategory.COMPOUND:
                if set_type == SetType.WARMUP:
                    return (8, 10)
                return (10, 15)
            if set_type == SetType.WARMUP:
                return (10, 12)
            return (12, 20)

        return (8, 12)

    def _base_rir_range(self, goal: GoalType, category: ExerciseCategory, set_type: SetType) -> tuple[float, float]:
        if set_type == SetType.WARMUP:
            return (3.0, 5.0)

        if goal == GoalType.STRENGTH:
            if set_type == SetType.TOP_SET:
                return (1.0, 2.0)
            if set_type == SetType.BACKOFF:
                return (2.0, 3.0)
            return (1.0, 2.0)

        if goal == GoalType.HYPERTROPHY:
            if category == ExerciseCategory.COMPOUND:
                if set_type == SetType.TOP_SET:
                    return (1.0, 2.0)
                if set_type == SetType.BACKOFF:
                    return (1.0, 3.0)
                return (1.0, 2.0)
            return (1.0, 2.0)

        if goal in (GoalType.FAT_LOSS, GoalType.MAINTAIN):
            return (2.0, 3.0)

        if goal == GoalType.ENDURANCE:
            return (2.0, 4.0)

        return (1.0, 3.0)

    def _apply_phase_adjustment(
        self,
        rep_min: int,
        rep_max: int,
        rir_min: float,
        rir_max: float,
        phase: PhaseType,
    ) -> tuple[int, int, float, float]:
        if phase == PhaseType.ACCUMULATION:
            return rep_min, rep_max + 1, rir_min, rir_max + 0.5
        if phase == PhaseType.INTENSIFICATION:
            return max(2, rep_min - 1), max(3, rep_max - 1), max(0.5, rir_min - 0.5), rir_max
        if phase == PhaseType.DELOAD:
            return rep_min, rep_max, 3.0, 4.0
        return rep_min, rep_max, rir_min, rir_max

    def _apply_focus_adjustment(
        self,
        rep_min: int,
        rep_max: int,
        focus: WorkoutFocus,
        category: ExerciseCategory,
    ) -> tuple[int, int]:
        if focus in (WorkoutFocus.PUSH, WorkoutFocus.PULL, WorkoutFocus.UPPER) and category == ExerciseCategory.ISOLATION:
            return rep_min, rep_max + 1
        return rep_min, rep_max

    def score_set_against_target(self, actual: SetResult, target: SetTarget) -> tuple[float, str]:
        score = 0.0

        if actual.feedback in (EffortFeedback.PAIN, EffortFeedback.FORM_BREAKDOWN):
            return -3.0, "safety_issue"

        if actual.feedback == EffortFeedback.FAILURE:
            score -= 2.0

        if actual.reps > target.rep_max:
            score += 2.0
        elif actual.reps == target.rep_max:
            score += 1.5
        elif target.rep_min <= actual.reps < target.rep_max:
            score += 1.0
        elif actual.reps == target.rep_min - 1:
            score -= 1.0
        else:
            score -= 2.0

        if actual.rir is not None:
            if target.rir_min <= actual.rir <= target.rir_max:
                score += 1.0
            elif actual.rir > target.rir_max:
                # Too easy (more reps in reserve than target) — signal underloaded
                score += 1.5
            elif actual.rir < target.rir_min - 1:
                score -= 1.0
        else:
            if actual.feedback == EffortFeedback.EASY:
                score += 1.0
            elif actual.feedback in (EffortFeedback.HARD, EffortFeedback.FAILURE) and actual.reps < target.rep_min:
                score -= 1.0

        if score >= 2.5:
            return score, "underloaded_or_strong"
        if score >= 1.5:
            return score, "top_of_range"
        if score >= 0.5:
            return score, "on_target"
        if score >= -0.5:
            return score, "slightly_off"
        return score, "too_heavy_or_fatigued"

    @staticmethod
    def fatigue_drop_reps(prior_working_sets: list[SetResult], current_set: SetResult) -> int:
        if not prior_working_sets:
            return 0
        best_reps_so_far = max(work_set.reps for work_set in prior_working_sets)
        return best_reps_so_far - current_set.reps

    def recommend_next_set(
        self,
        profile: UserTrainingProfile,
        workout: WorkoutContext,
        prescription: ExercisePrescription,
        sets_completed_this_workout: list[SetResult],
        readiness: Optional[ReadinessInput] = None,
        target_rep_override: Optional[tuple[int, int]] = None,
    ) -> NextSetRecommendation:
        if not sets_completed_this_workout:
            first_set = sorted(prescription.planned_sets, key=lambda s: s.set_number)[0]
            first_target = self.build_set_target(profile, workout, prescription, first_set.set_number)
            rep_min, rep_max = target_rep_override if target_rep_override else (first_target.rep_min, first_target.rep_max)
            return NextSetRecommendation(
                action=RecommendationAction.HOLD,
                next_set_number=first_set.set_number,
                recommended_weight_lbs=prescription.default_start_weight_lbs,
                target_rep_min=rep_min,
                target_rep_max=rep_max,
                user_message=f"Start {prescription.exercise_name} at {prescription.default_start_weight_lbs} lb for {rep_min}-{rep_max} reps.",
                coach_message="Starting with baseline load.",
                debug={"first_set_type": first_set.set_type.value},
            )

        current_set = sets_completed_this_workout[-1]
        current_planned = self.get_planned_set(prescription.planned_sets, current_set.set_number)
        next_planned = self.get_next_planned_set(prescription.planned_sets, current_set.set_number)

        if next_planned is None:
            return NextSetRecommendation(
                action=RecommendationAction.END_EXERCISE,
                next_set_number=None,
                recommended_weight_lbs=None,
                target_rep_min=None,
                target_rep_max=None,
                user_message=f"{prescription.exercise_name} is complete.",
                coach_message="No more planned sets remain for this exercise.",
                debug={},
            )

        current_target = self.build_set_target(profile, workout, prescription, current_set.set_number)
        next_target = self.build_set_target(profile, workout, prescription, next_planned.set_number)
        if target_rep_override:
            next_target = SetTarget(
                set_number=next_target.set_number,
                set_type=next_target.set_type,
                rep_min=target_rep_override[0],
                rep_max=target_rep_override[1],
                rir_min=next_target.rir_min,
                rir_max=next_target.rir_max,
            )

        prior_working_sets = self.get_working_sets(sets_completed_this_workout[:-1], prescription.planned_sets)
        score, classification = self.score_set_against_target(current_set, current_target)
        readiness_label = self.readiness_label(readiness)
        # Adjust readiness for chronic recovery level
        if profile.recovery_level == RecoveryLevel.LOW and readiness_label in ("normal", "high"):
            readiness_label = "low"  # downgrade one tier
        elif profile.recovery_level == RecoveryLevel.HIGH and readiness_label == "low":
            readiness_label = "normal"  # upgrade one tier
        fatigue_drop = self.fatigue_drop_reps(prior_working_sets, current_set)

        current_weight = current_set.weight_lbs
        proposed_weight = current_weight
        action = RecommendationAction.HOLD
        reason = ""
        coach_note = ""

        if current_set.feedback in (EffortFeedback.PAIN, EffortFeedback.FORM_BREAKDOWN):
            proposed_weight = current_weight * 0.90
            action = RecommendationAction.DECREASE
            reason = "Reduced weight because you reported pain or form breakdown."
            coach_note = "Safety override triggered."
        elif classification == "underloaded_or_strong":
            # Apply pace: conservative = half increment, aggressive = full + 50%
            pace_mult = {ProgressionPace.CONSERVATIVE: 0.5, ProgressionPace.MODERATE: 1.0, ProgressionPace.AGGRESSIVE: 1.5}.get(profile.progression_pace, 1.0)
            increment = prescription.increment_lbs * pace_mult

            # Conservative pace requires at least "normal" readiness; aggressive allows "low"
            min_readiness = "normal" if profile.progression_pace == ProgressionPace.CONSERVATIVE else "poor"
            readiness_ok = readiness_label != min_readiness

            if readiness_ok and fatigue_drop < prescription.fatigue_drop_threshold_reps:
                proposed_weight = current_weight + increment
                action = RecommendationAction.INCREASE
                reason = "You were above target with room left, so increase the load."
                coach_note = "Clearly underloaded or very strong set."
            else:
                proposed_weight = current_weight
                action = RecommendationAction.HOLD
                reason = "Set was strong, but fatigue/readiness says hold steady."
                coach_note = "Strong set but not a good time to push live."
        elif classification == "top_of_range":
            pace_mult = {ProgressionPace.CONSERVATIVE: 0.5, ProgressionPace.MODERATE: 1.0, ProgressionPace.AGGRESSIVE: 1.5}.get(profile.progression_pace, 1.0)
            increment = prescription.increment_lbs * pace_mult

            if prescription.progression_priority == ProgressionPriority.LOAD_FIRST:
                min_readiness = "normal" if profile.progression_pace == ProgressionPace.CONSERVATIVE else "poor"
                if readiness_label != min_readiness:
                    proposed_weight = current_weight + increment
                    action = RecommendationAction.INCREASE
                    reason = "You hit the top of the rep range, so increase the load."
                    coach_note = "Load-first progression."
                else:
                    proposed_weight = current_weight
                    action = RecommendationAction.HOLD
                    reason = "Top of range, but readiness is low, so hold."
                    coach_note = "Would normally increase, but readiness is poor."
            elif prescription.progression_priority == ProgressionPriority.HYBRID:
                # Aggressive: increase on set 2 even with "low" readiness; conservative: only on "high"
                hybrid_ok_readiness = {"conservative": ("high",), "moderate": ("normal", "high"), "aggressive": ("low", "normal", "high")}
                ok_labels = hybrid_ok_readiness.get(profile.progression_pace.value, ("normal", "high"))
                if current_set.set_number == 2 and readiness_label in ok_labels:
                    proposed_weight = current_weight + increment
                    action = RecommendationAction.INCREASE
                    reason = "Top of range on an early working set, so increase slightly."
                    coach_note = "Hybrid progression increased live."
                else:
                    proposed_weight = current_weight
                    action = RecommendationAction.HOLD
                    reason = "Top of range, but hold for now and likely increase next workout."
                    coach_note = "Hybrid progression saving increase for next session."
            else:
                proposed_weight = current_weight
                action = RecommendationAction.HOLD
                reason = "You hit the top of the rep range. Hold today and likely increase next workout."
                coach_note = "Reps-first progression."
        elif classification == "on_target":
            proposed_weight = current_weight
            action = RecommendationAction.HOLD
            reason = "You hit the intended target, so keep the same weight."
            coach_note = "Good set. Hold the load."
        elif classification == "slightly_off":
            if fatigue_drop >= prescription.fatigue_drop_threshold_reps:
                proposed_weight = current_weight - prescription.increment_lbs
                action = RecommendationAction.DECREASE
                reason = "Fatigue is building, so reduce slightly."
                coach_note = "Small fatigue adjustment."
            else:
                proposed_weight = current_weight
                action = RecommendationAction.HOLD
                reason = "Close enough to target to keep the same weight."
                coach_note = "Slightly off, but acceptable."
        else:
            proposed_weight = current_weight - prescription.increment_lbs
            action = RecommendationAction.DECREASE
            reason = "You missed the target or hit too much fatigue, so reduce the load."
            coach_note = "Weight was likely too high for today's target."

        if action != RecommendationAction.DECREASE and fatigue_drop >= prescription.fatigue_drop_threshold_reps:
            if action == RecommendationAction.INCREASE:
                # Scale back the increase instead of forcing a decrease
                proposed_weight = current_weight
                action = RecommendationAction.HOLD
                reason = f"Reps dropped by {fatigue_drop} — holding weight instead of increasing."
                coach_note = "Fatigue override: cancelled increase."
            else:
                proposed_weight = current_weight - prescription.increment_lbs
                action = RecommendationAction.DECREASE
                reason = f"Reps dropped by {fatigue_drop}, so reduce the next set slightly."
                coach_note = "Fatigue override triggered."

        if workout.phase == PhaseType.DELOAD and action == RecommendationAction.INCREASE:
            proposed_weight = current_weight
            action = RecommendationAction.HOLD
            reason = "Deload week: do not push load upward."
            coach_note = "Deload override triggered."

        proposed_weight = self.clamp_weight_change(
            current_weight=current_weight,
            proposed_weight=proposed_weight,
            max_up_pct=prescription.max_live_increase_pct,
            max_down_pct=prescription.max_live_decrease_pct,
        )
        proposed_weight = self.round_to_increment(proposed_weight, prescription.increment_lbs)

        return NextSetRecommendation(
            action=action,
            next_set_number=next_planned.set_number,
            recommended_weight_lbs=proposed_weight,
            target_rep_min=next_target.rep_min,
            target_rep_max=next_target.rep_max,
            user_message=(
                f"{prescription.exercise_name}: {action.value.replace('_', ' ')} to {proposed_weight} lb for set {next_planned.set_number}. "
                f"Aim for {next_target.rep_min}-{next_target.rep_max} reps. {reason}"
            ),
            coach_message=coach_note or reason,
            debug={
                "classification": classification,
                "score": round(score, 2),
                "fatigue_drop_reps": fatigue_drop,
                "current_set_type": current_planned.set_type.value,
                "next_set_type": next_planned.set_type.value,
                "readiness": readiness_label,
                "current_feedback": current_set.feedback.value if current_set.feedback else None,
            },
        )
