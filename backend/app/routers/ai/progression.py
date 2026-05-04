from __future__ import annotations

import json
import logging
import os

import openai
from openai import OpenAI
from fastapi import HTTPException, Depends
from sqlmodel import Session, select

from app.database import get_session
from app.entitlements import require_pro_feature
from app.models import Exercise, User

from .router import router
from .models import WeightRecommendRequest, WorkoutSummaryRequest, WarmupRequest, PreSetRecommendRequest, ValidateFoodMacrosRequest
from .utils import (
    get_openai_api_key, model_chat,
    _build_chat_kwargs, _chat_create, _extract_json, _log_openai_error,
    progression_engine,
    map_goal_type, map_feedback, infer_exercise_category, parse_target_reps,
    map_progression_priority, map_workout_focus, map_phase,
    map_progression_pace, map_experience_level, map_recovery_level,
    SCHEMA_WORKOUT_SUMMARY,
)
from app.workout_progression import (
    ExerciseCategory, ExercisePrescription, PlannedSet, ReadinessInput,
    SetResult, SetType, UserTrainingProfile, WorkoutContext,
)
from app.services.workout.performance import build_performance_profile
from app.services.workout.recommendation import (
    apply_fatigue_override,
    recommend_starting_weight,
)
from app.services.workout.exercise_metadata import (
    set_programming_exercise_metadata,
)
from app.services.workout.ai_first_time_weight import (
    ai_first_time_weight_recommendation,
)
from app.seed_exercises_data import SEED_EXERCISES  # noqa: F401  (used inside handler)


logger = logging.getLogger(__name__)


def _try_ai_first_time_branch(
    *,
    user_id: int,
    db: Session,
    exercise_name: str,
    exercise_slug: str | None,
    target_reps: str,
    experience: str,
) -> tuple[float, dict] | None:
    """Try the AI first-time branch. Returns `(weight_lbs, meta)` on
    success, None when we should fall through to the deterministic
    tiers below.

    Pre-conditions enforced:
      1. The resolved exercise has a `primary_muscle` we can look up.
      2. User has NO direct history for the target exercise (we're
         past the exact-history tier by the time this fires).
      3. User DOES have >= 1 recent session for that same muscle.

    On missing API key, empty muscle sessions, or any AI failure we
    return None — the existing tiers 5/6/7 handle fallback.
    """
    if not exercise_name:
        return None

    # Resolve canonical seed row so we know which muscle to look up.
    seed_row: dict | None = None
    from app.seed_exercises_data import SEED_EXERCISES
    if exercise_slug:
        seed_row = next(
            (ex for ex in SEED_EXERCISES if ex.get("slug") == exercise_slug), None
        )
    if seed_row is None:
        lname = (exercise_name or "").strip().lower()
        seed_row = next(
            (ex for ex in SEED_EXERCISES if (ex.get("name") or "").strip().lower() == lname),
            None,
        )
    primary_muscle = (seed_row or {}).get("primary_muscle")
    if isinstance(primary_muscle, str):
        primary_muscle_str = primary_muscle
    elif primary_muscle is not None and hasattr(primary_muscle, "value"):
        primary_muscle_str = str(primary_muscle.value)
    else:
        primary_muscle_str = ""
    if not primary_muscle_str:
        return None

    try:
        from app.services.workout.history import most_recent_sessions_for_muscle
        muscle_sessions = most_recent_sessions_for_muscle(
            user_id, primary_muscle_str, db, limit=3,
        )
    except Exception:
        logger.exception(
            "[recommend-weight] most_recent_sessions_for_muscle failed (non-fatal)"
        )
        muscle_sessions = []
    # NB: we no longer bail on empty sessions — the AI helper has a
    # no-history mode that uses profile + bodyweight + strength-
    # standard ratios to pick a starting weight.

    # Fetch bodyweight + age + sex for the prompt. Bodyweight is
    # mandatory for the no-history path — without it we can't estimate.
    bw_lbs = 0.0
    age_val: int | None = None
    sex_val: str | None = None
    try:
        from app.models import UserProfile as _UP
        row = db.exec(select(_UP).where(_UP.user_id == user_id)).first()
        if row:
            if row.weight_lbs:
                bw_lbs = float(row.weight_lbs)
            if row.age:
                age_val = int(row.age)
            if row.gender:
                # SQLModel enum → value string ("male" / "female" / etc.)
                try:
                    sex_val = str(row.gender.value)
                except Exception:
                    sex_val = str(row.gender)
    except Exception:
        logger.exception(
            "[recommend-weight] profile lookup failed (non-fatal)"
        )

    # Still need SOMETHING to anchor on. If there are no sessions AND
    # no bodyweight, the AI can't do better than the planner default,
    # so we fall through.
    if not muscle_sessions and bw_lbs <= 0:
        return None

    api_key = get_openai_api_key()
    if not api_key:
        return None
    try:
        client = OpenAI(api_key=api_key)
    except Exception:
        logger.exception(
            "[recommend-weight] OpenAI client init failed (non-fatal)"
        )
        return None

    rec = ai_first_time_weight_recommendation(
        exercise_name=exercise_name,
        primary_muscle=primary_muscle_str,
        target_reps=target_reps,
        experience=experience,
        bodyweight_lbs=bw_lbs,
        muscle_sessions=muscle_sessions,
        age=age_val,
        sex=sex_val,
        openai_client=client,
        model=model_chat(),
        chat_kwargs_builder=_build_chat_kwargs,
        chat_invoker=_chat_create,
        json_extractor=_extract_json,
    )
    if rec is None or rec.weight_lbs <= 0:
        return None
    # Weight only. No reason string surfaced — the number IS the answer.
    return rec.weight_lbs, {
        "source": "ai_first_time",
        "confidence": rec.confidence,
        "reason": "",
    }


def _resolve_exercise_slug(db: Session, exercise_name: str, exercise_slug: str | None) -> str | None:
    """Best-effort canonical slug resolution for the recommend-weight
    path. Prefers the client-provided slug, falls back to a
    case-insensitive `Exercise.name` lookup. Returns None when we can't
    find a seed match — downstream code falls back to legacy anchors."""
    if exercise_slug:
        return exercise_slug
    if not exercise_name:
        return None
    row = db.exec(select(Exercise).where(Exercise.name.ilike(exercise_name))).first()
    return row.slug if row else None


def _primary_muscle_for(
    db: Session, exercise_name: str, exercise_slug: str | None
) -> str | None:
    """Best-effort primary-muscle lookup for the fatigue overlay.

    Tries (in order): the client-provided slug against the seed, the
    exercise name against the seed, and finally the Exercise DB row.
    Returns None when we can't find a muscle — the fatigue override
    silently skips in that case.
    """
    try:
        from app.seed_exercises_data import SEED_EXERCISES
        seed_row = None
        if exercise_slug:
            seed_row = next(
                (ex for ex in SEED_EXERCISES if ex.get("slug") == exercise_slug),
                None,
            )
        if seed_row is None and exercise_name:
            lname = exercise_name.strip().lower()
            seed_row = next(
                (
                    ex for ex in SEED_EXERCISES
                    if (ex.get("name") or "").strip().lower() == lname
                ),
                None,
            )
        if seed_row is not None:
            pm = seed_row.get("primary_muscle")
            if hasattr(pm, "value"):
                return str(pm.value)
            if pm:
                return str(pm)
    except Exception:
        logger.exception(
            "[recommend-weight] seed primary_muscle lookup failed (non-fatal)"
        )

    if not exercise_name:
        return None
    try:
        row = db.exec(select(Exercise).where(Exercise.name.ilike(exercise_name))).first()
        if row and row.primary_muscle is not None:
            pm = row.primary_muscle
            return str(pm.value) if hasattr(pm, "value") else str(pm)
    except Exception:
        logger.exception(
            "[recommend-weight] DB primary_muscle lookup failed (non-fatal)"
        )
    return None


def _set_programming_exercise_metadata(
    db: Session | None,
    exercise_name: str,
    exercise_slug: str | None = None,
    equipment: str | None = None,
    primary_muscle: str | None = None,
) -> dict:
    return set_programming_exercise_metadata(
        db,
        exercise_name,
        exercise_slug,
        equipment,
        primary_muscle,
    )


@router.post("/recommend-weight")
def recommend_weight(
    body: WeightRecommendRequest,
    current_user: User = Depends(require_pro_feature("AI weight recommendations")),
    db: Session = Depends(get_session),
):
    """Deterministic next-set recommendation based on recent performance and feedback.

    Anchor priority for the first-set weight (set 1 of the session, when
    no sets have been logged yet):

        1. Current-session completed sets (handled by the progression
           engine below — if `body.lastSets` is non-empty, that's the
           authoritative anchor).
        2. `plannedTargetWeightLbs` propagated by the deterministic
           planner from this user's history + goal-specific progression.
        3. Exact exercise performance profile (live query against the
           user's recent completed sessions in this DB).
        4. Transferred estimate from a similar exercise
           (substitution_group → movement_pattern → muscle_bucket).
        5. `lastSessionBestWeightLbs` (client-provided fallback).
        6. `allTimeBestWeightLbs` (client-provided fallback).
        7. Category default.

    Each step past (1) also populates a `recommendation` field on the
    response so the client can show the user *why* a weight was picked."""
    try:
        exercise_meta = _set_programming_exercise_metadata(
            db,
            body.exerciseName,
            body.exerciseSlug,
            body.equipment,
            body.primaryMuscle,
        )
        from app.services.workout.set_programming import load_increment_for
        metadata_increment_lbs = load_increment_for(exercise_meta)

        # Bodyweight gate: exercises performed with bodyweight (no added load)
        # never get a weight recommendation. Short-circuit before any tier logic.
        # The client also guards via shouldHideWeight(), but this prevents
        # non-zero weights from leaking through edge cases (e.g. historical
        # data with weight for an exercise the user is now doing unloaded).
        if (
            (body.equipment or "").strip().lower() in ("bodyweight", "none", "bw")
            or metadata_increment_lbs <= 0
        ):
            return {
                "weightLbs": 0.0, "reps": 0,
                "tip": "", "action": "continue", "repRange": None,
                "debug": {}, "recommendation": None, "awaitingFeel": False,
                "source": "bodyweight", "suspicionReasons": [], "fatigue_override": False,
            }

        planned_set_count = body.targetSets if body.targetSets and body.targetSets > 0 else max(1, body.nextSetNumber)
        # Forward the plan's per-exercise rep target onto every planned set
        # so the progression engine honors the plan's intent instead of
        # defaulting to goal-based ranges. Also promote heavy ranges to
        # TOP_SET so RIR thresholds match a heavy-top prescription.
        plan_rep_target = (body.targetReps or "").strip() or None
        inferred_set_type = SetType.STRAIGHT
        if plan_rep_target:
            try:
                parts = plan_rep_target.split("-", 1)
                hi = int(parts[-1])
                if hi <= 6:
                    inferred_set_type = SetType.TOP_SET
            except ValueError:
                pass
        planned_sets = [
            PlannedSet(
                set_number=idx + 1,
                set_type=inferred_set_type,
                target_reps_override=plan_rep_target,
            )
            for idx in range(planned_set_count)
        ]

        sets_completed = [
            SetResult(
                set_number=s.setNumber,
                weight_lbs=s.weightLbs,
                reps=s.reps,
                rir=s.rir,
                feedback=map_feedback(s.feedback),
            )
            for s in body.lastSets
        ]
        last_weight = sets_completed[-1].weight_lbs if sets_completed else None

        # Fetch the user's current per-muscle fatigue snapshot once so
        # the fatigue overlay (below) can downshift the first-set anchor
        # when the target muscle is elevated. Non-fatal — on any error
        # we just skip the override. The downstream in-workout path
        # already tolerates a None snapshot.
        muscle_fatigue_dict: dict | None = None
        try:
            from app.services.workout.history import (
                get_recent_completions_for_fatigue,
            )
            from app.services.workout.activity_impact import (
                compute_rolling_fatigue,
            )
            _completions = get_recent_completions_for_fatigue(current_user.id, db)
            if _completions:
                _snap = compute_rolling_fatigue(_completions)
                muscle_fatigue_dict = _snap.muscle_fatigue.to_dict()
        except Exception:
            logger.exception(
                "[recommend-weight] fatigue snapshot lookup failed (non-fatal)"
            )
            muscle_fatigue_dict = None

        goal_type  = map_goal_type(body.goal)
        profile    = UserTrainingProfile(
            primary_goal=goal_type,
            experience_level=map_experience_level(body.experienceLevel),
            recovery_level=map_recovery_level(body.recoveryLevel),
            progression_pace=map_progression_pace(body.progressionPace),
        )
        workout    = WorkoutContext(
            workout_name="Current Workout",
            focus=map_workout_focus(body.workoutFocus),
            phase=map_phase(body.phase),
            week_number=max(1, body.weekNumber or 1),
        )
        ex_category = infer_exercise_category(body.exerciseName)
        equipment_settings: dict | None = None
        try:
            from app.models import UserPreferences as _UserPreferences
            prefs = db.exec(
                select(_UserPreferences).where(_UserPreferences.user_id == current_user.id)
            ).first()
            equipment_settings = getattr(prefs, "equipment_settings", None) if prefs else None
        except Exception:
            equipment_settings = None
        try:
            from app.services.workout.load_equipment import load_increment_lbs, snap_load_lbs
            fallback_increment = (
                metadata_increment_lbs
                if metadata_increment_lbs > 0
                else (
                    float(body.incrementLbs)
                    if body.incrementLbs and body.incrementLbs > 0
                    else (2.5 if "dumbbell" in (body.equipment or "").lower() else 5.0)
                )
            )
            effective_increment_lbs = load_increment_lbs(
                body.equipment,
                equipment_settings,
                fallback=fallback_increment,
            )
        except Exception:
            snap_load_lbs = None  # type: ignore[assignment]
            effective_increment_lbs = max(1.0, body.incrementLbs or 5.0)
        # Layered anchor pipeline for the first set of the session.
        # `recommendation_meta` carries the source + confidence + reason
        # back to the client so the UI can explain the pick.
        recommendation_meta: dict | None = None
        if last_weight is None:
            # Tier 2 — planner-propagated target (already history-aware
            # from the offline propagation step).
            if body.plannedTargetWeightLbs and body.plannedTargetWeightLbs > 0:
                last_weight = float(body.plannedTargetWeightLbs)
                recommendation_meta = {
                    "source": "planned_target",
                    "confidence": 0.90,
                    "reason": "Using the target your plan set for this session",
                }
            else:
                # Tiers 3 + 4 — live query against the user's DB profile
                # for this exact exercise; if no direct history, run the
                # layered transfer pipeline to borrow an estimate from a
                # similar exercise.
                slug = _resolve_exercise_slug(db, body.exerciseName, body.exerciseSlug)
                target_ex: dict | None = None
                profiles: dict = {}
                if slug is not None:
                    by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
                    target_ex = by_slug.get(slug)
                    try:
                        profiles = build_performance_profile(current_user.id, db)
                    except Exception as e:
                        print(f"[recommend-weight] profile build failed (non-fatal): {e}")
                        profiles = {}

                    if target_ex is not None:
                        rec_anchor = recommend_starting_weight(
                            target_ex,
                            profiles=profiles,
                            all_exercises_by_slug=by_slug,
                            target_reps=body.targetReps,
                            experience=(body.experienceLevel or "intermediate"),
                        )
                        # Only accept the recommendation if it comes from
                        # real user data. `default` means we couldn't
                        # find anything — fall through to the
                        # client-provided anchors below.
                        if rec_anchor.source != "default" and rec_anchor.weight_lbs > 0:
                            last_weight = rec_anchor.weight_lbs
                            recommendation_meta = {
                                "source": rec_anchor.source,
                                "confidence": rec_anchor.confidence,
                                "reason": rec_anchor.reason,
                            }

            # Tier 4.5 — AI first-time. No direct history AND no
            # transferable anchor from the seed pipeline, but the user
            # DOES have recent sessions for the same primary_muscle.
            # Hand the recent sessions to the AI and ask for a
            # conservative starting weight. Fail-safe: any failure
            # falls through to the deterministic tiers below.
            if last_weight is None:
                last_weight, recommendation_meta = _try_ai_first_time_branch(
                    user_id=current_user.id,
                    db=db,
                    exercise_name=body.exerciseName,
                    exercise_slug=body.exerciseSlug,
                    target_reps=body.targetReps or "8-12",
                    experience=(body.experienceLevel or "intermediate"),
                ) or (last_weight, recommendation_meta)

            # Tier 5 — client-provided last-session best (oldest code path).
            if last_weight is None and body.lastSessionBestWeightLbs and body.lastSessionBestWeightLbs > 0:
                last_weight = float(body.lastSessionBestWeightLbs)
                recommendation_meta = {
                    "source": "last_session_best",
                    "confidence": 0.60,
                    "reason": "Based on your most recent session's top set",
                }
            # Tier 6 — all-time best.
            if last_weight is None and body.allTimeBestWeightLbs and body.allTimeBestWeightLbs > 0:
                last_weight = float(body.allTimeBestWeightLbs)
                recommendation_meta = {
                    "source": "all_time_best",
                    "confidence": 0.45,
                    "reason": "Based on your all-time best set for this exercise",
                }
            # Tier 7 — category default.
            if last_weight is None:
                last_weight = {
                    ExerciseCategory.COMPOUND: 65.0,
                    ExerciseCategory.ISOLATION: 20.0,
                    ExerciseCategory.MACHINE: 80.0,
                    ExerciseCategory.BODYWEIGHT: 0.0,
                }.get(ex_category, 45.0)
                recommendation_meta = {
                    "source": "default",
                    "confidence": 0.15,
                    "reason": "Starting weight for this movement — adjust after your first set",
                }

        # ── Fatigue overlay ────────────────────────────────────────
        # Only meaningful for the FIRST set of the session (no sets
        # logged yet). Mid-workout, the progression engine is already
        # reacting to what just happened — a fatigue downshift on top
        # would double-count. `sets_completed` being empty is the
        # same guard we use for every tier-resolution branch above.
        fatigue_override_flag = False
        if not sets_completed and last_weight is not None and last_weight > 0:
            primary_muscle_for_fatigue = _primary_muscle_for(
                db, body.exerciseName, body.exerciseSlug
            )
            if primary_muscle_for_fatigue and muscle_fatigue_dict:
                base_conf = (
                    (recommendation_meta or {}).get("confidence")
                    if recommendation_meta else None
                )
                base_reason = (
                    (recommendation_meta or {}).get("reason")
                    if recommendation_meta else ""
                )
                adj = apply_fatigue_override(
                    weight_lbs=float(last_weight),
                    base_confidence=base_conf if base_conf is not None else 0.15,
                    base_reason=base_reason or "",
                    primary_muscle=primary_muscle_for_fatigue,
                    muscle_fatigue=muscle_fatigue_dict,
                    muscle_label=primary_muscle_for_fatigue,
                )
                if adj.fatigue_override:
                    last_weight = adj.weight_lbs
                    fatigue_override_flag = True
                    recommendation_meta = {
                        "source": (recommendation_meta or {}).get("source") or "default",
                        "confidence": adj.confidence,
                        "reason": adj.reason,
                    }

        if snap_load_lbs is not None and last_weight is not None and last_weight > 0:
            snapped_last = snap_load_lbs(
                last_weight,
                body.equipment,
                equipment_settings,
                fallback_increment=effective_increment_lbs,
            )
            if snapped_last is not None:
                last_weight = float(snapped_last)

        prescription = ExercisePrescription(
            exercise_name=body.exerciseName,
            category=ex_category,
            planned_sets=planned_sets,
            increment_lbs=max(1.0, effective_increment_lbs),
            progression_priority=map_progression_priority(goal_type),
            default_start_weight_lbs=last_weight,
        )
        readiness  = ReadinessInput(
            sleep_hours=body.sleepHours,
            energy_1_to_5=body.energy1to5,
            soreness_1_to_5=body.soreness1to5,
            stress_1_to_5=body.stress1to5,
            calories_on_target_recently=body.caloriesOnTargetRecently,
        )
        rec = progression_engine.recommend_next_set(
            profile=profile,
            workout=workout,
            prescription=prescription,
            sets_completed_this_workout=sets_completed,
            readiness=readiness,
            target_rep_override=parse_target_reps(body.targetReps),
        )

        if rec.action.value == "end_exercise":
            return {
                "weightLbs": float(last_weight or 0),
                "reps": 0,
                "tip": f"{body.exerciseName} complete for today.",
                "action": rec.action.value,
                "debug": rec.debug,
                "recommendation": recommendation_meta,
                "fatigue_override": fatigue_override_flag,
            }

        rec_weight = float(rec.recommended_weight_lbs or last_weight or 0)
        rep_min    = int(rec.target_rep_min or 8)
        rep_max    = int(rec.target_rep_max or rep_min)
        rec_reps   = max(1, round((rep_min + rep_max) / 2))

        last_logged = body.lastSets[-1] if body.lastSets else None
        last_logged_feel = (getattr(last_logged, "feedback", None) or None) if last_logged else None

        reviewed_source = "deterministic"
        reviewed_reasons: list[str] = []
        if last_logged is not None:
            try:
                from app.services.workout.in_workout_review import (
                    reviewed_next_set_recommendation,
                )
                from app.services.workout.set_programming import (
                    PlannedSet as SPPlannedSet,
                )
                # Build a minimal planned-set proxy for the reviewer.
                # Heavy rep schemes should review as load-first rather
                # than pretending every set is generic volume work.
                reviewed_set_type = "heavy_top" if inferred_set_type == SetType.TOP_SET else "volume"
                reviewed_progression_mode = "load_first" if inferred_set_type == SetType.TOP_SET else "reps_first"
                spp = SPPlannedSet(
                    set_number=int(last_logged.setNumber or 1),
                    set_type=reviewed_set_type,
                    target_reps=body.targetReps or f"{rep_min}-{rep_max}",
                    target_rir=float(last_logged.rir if last_logged.rir is not None else 2.0),
                    target_weight_lbs=float(last_weight or 0.0) or None,
                    progression_mode=reviewed_progression_mode,
                )
                exercise_stub = {
                    **exercise_meta,
                    "equipment_bucket": exercise_meta.get("equipment_bucket")
                    or ("barbell" if ex_category == ExerciseCategory.COMPOUND else "dumbbell"),
                    "is_compound": bool(exercise_meta.get("is_compound"))
                    or ex_category == ExerciseCategory.COMPOUND,
                }
                prev_sets_this = [
                    {"reps": s.reps, "weight_lbs": s.weightLbs, "rir": s.rir, "feel": s.feedback}
                    for s in body.lastSets[:-1]
                ]
                reviewed = reviewed_next_set_recommendation(
                    exercise=exercise_stub,
                    planned_set=spp,
                    actual_reps=int(last_logged.reps or 0),
                    actual_weight_lbs=float(last_logged.weightLbs or 0.0),
                    actual_rir=float(last_logged.rir) if last_logged.rir is not None else None,
                    feel=last_logged_feel,
                    previous_sets_this_session=prev_sets_this,
                    last_session_sets=[],  # live DB query skipped here — cheap path
                    require_feel=False,
                )
                if reviewed is not None:
                    reviewed_source = reviewed.source
                    reviewed_reasons = reviewed.suspicion_reasons
                    # AI can override weight / rep target / tip.
                    if reviewed.next_set_weight_lbs is not None and reviewed.source != "deterministic":
                        rec_weight = float(reviewed.next_set_weight_lbs)
                    if reviewed.next_set_rep_target and reviewed.source != "deterministic":
                        # Best-effort parse of "6-8" → rep_min / rep_max.
                        r = reviewed.next_set_rep_target
                        if "-" in r:
                            try:
                                lo, hi = r.split("-", 1)
                                rep_min = int(lo.strip())
                                rep_max = int(hi.strip())
                                rec_reps = max(1, round((rep_min + rep_max) / 2))
                            except (ValueError, TypeError):
                                pass
                    if reviewed.explanation and reviewed.source != "deterministic":
                        tip = reviewed.explanation
                    else:
                        tip = rec.coach_message
                else:
                    tip = rec.coach_message
            except Exception as e:
                print(f"[recommend-weight] in-workout review failed (non-fatal): {e}")
                tip = rec.coach_message
        else:
            tip = rec.coach_message

        if snap_load_lbs is not None and rec_weight > 0:
            snapped_rec = snap_load_lbs(
                rec_weight,
                body.equipment,
                equipment_settings,
                fallback_increment=effective_increment_lbs,
            )
            if snapped_rec is not None:
                rec_weight = float(snapped_rec)

        return {
            "weightLbs": rec_weight,
            "reps": rec_reps,
            "tip": tip,
            "action": rec.action.value,
            "repRange": f"{rep_min}-{rep_max}",
            "debug": rec.debug,
            # Null when the anchor came from current-session sets — the
            # progression engine owns that message. Populated for first-set
            # anchors so the UI can show "Based on your last 3 sessions"
            # or "Estimated from similar horizontal pressing work".
            "recommendation": recommendation_meta,
            # New fields for the AI-reviewer pipeline:
            # `awaitingFeel`: frontend hides the rec card while True.
            # `source`: "deterministic" | "ai_override" | "ai_confirmed"
            #           — lets the UI tag an "AI" label on overrides.
            # `suspicionReasons`: debug list of why the reviewer fired.
            "awaitingFeel": False,
            "source": reviewed_source,
            "suspicionReasons": reviewed_reasons,
            # Top-level flag so the UI can style the rec differently
            # (e.g. "recovering" badge) without parsing the reason
            # string. True iff the fatigue overlay downshifted the
            # weight; False in every other case.
            "fatigue_override": fatigue_override_flag,
        }
    except Exception as e:
        print(f"[BACKEND] recommend-weight error: {e}")
        raise HTTPException(status_code=502, detail=f"Recommendation failed: {str(e)}")


# Canonical list of "showcase" compound lifts to surface on the
# Progress screen's 1RM card. Kept as a flat tuple (no config/env)
# so the Progress screen always renders the same set of lifts and
# users don't see the list flap between releases. Ordered by how
# commonly strength standards reference them.
_ONE_RM_SHOWCASE_SLUGS: tuple[str, ...] = (
    "barbell_back_squat",
    "barbell_bench_press",
    "barbell_deadlift",
    "overhead_press",
    "barbell_row",
    "pendlay_row",
    "barbell_front_squat",
    "romanian_deadlift",
)


@router.get("/strength/one-rep-max")
def one_rep_max_showcase(
    current_user: User = Depends(require_pro_feature("Workout analytics")),
    db: Session = Depends(get_session),
):
    """Return estimated 1RM for the user's showcase compound lifts.

    Pulls from `build_performance_profile` which already computes
    Epley 1RMs from recent logged sessions. Only lifts with at least
    one logged session in the performance window are returned — the
    Progress screen card renders those. Lifts with no history are
    skipped entirely (the UI shows its own empty-state when nothing
    comes back).

    Shape:
        {
          "lifts": [
            {
              "slug": "barbell_bench_press",
              "name": "Barbell Bench Press",
              "oneRepMaxLbs": 235.0,
              "topWeightLbs": 205.0,
              "topReps": 8,
              "sessionCount": 4,
              "confidence": 0.77,
              "lastPerformedOn": "2026-04-14"
            },
            ...
          ]
        }
    """
    try:
        profiles = build_performance_profile(current_user.id, db)
    except Exception as e:
        print(f"[one-rep-max] profile build failed: {e}")
        return {"lifts": []}

    # Preserve showcase order so the card always renders the same
    # sequence. Anything without a profile gets dropped silently.
    out: list[dict] = []
    for slug in _ONE_RM_SHOWCASE_SLUGS:
        p = profiles.get(slug)
        if p is None or p.estimated_1rm_lbs <= 0:
            continue
        out.append({
            "slug": p.slug,
            "name": p.name,
            "oneRepMaxLbs": round(p.estimated_1rm_lbs, 1),
            "topWeightLbs": round(p.recent_top_weight_lbs, 1),
            "topReps": int(p.recent_top_reps),
            "sessionCount": int(p.session_count),
            "confidence": round(p.confidence, 2),
            "lastPerformedOn": p.last_performed_on.isoformat() if p.last_performed_on else None,
        })
    return {"lifts": out}


@router.get("/fitness/composite-score")
def fitness_composite_score(
    days_per_week: int = 3,
    bodyweight_lbs: float | None = None,
    recent_sleep_hours: float | None = None,
    avg_session_rpe: float | None = None,
    current_user: User = Depends(require_pro_feature("Advanced fitness score")),
    db: Session = Depends(get_session),
):
    """Compose the 4-pillar fitness score (Strength, Cardio,
    Consistency, Recovery). Each pillar is deterministic and returns
    a 0-100 subscore plus a one-line human reason string.

    Query params:
      - `days_per_week` — user's planned training frequency (powers Consistency pillar target)
      - `bodyweight_lbs` — current bodyweight (powers Strength pillar)
      - `recent_sleep_hours` — last night's sleep (Recovery signal)
      - `avg_session_rpe` — avg RPE across recent sessions (Recovery signal)

    Internal data sources:
      - `build_performance_profile` for Strength pillar (Epley 1RMs)
      - `WorkoutCompletion` last 14 days for Cardio + Consistency

    Returns:
        {
          "total": 70.1,
          "rating": "Strong",
          "pillars": [
            {"name": "Strength", "score": 97.9, "reason": "...", "dataQuality": "full"},
            {"name": "Cardio", "score": 19.0, "reason": "...", "dataQuality": "full"},
            {"name": "Consistency", "score": 80.0, "reason": "...", "dataQuality": "full"},
            {"name": "Recovery", "score": 100.0, "reason": "...", "dataQuality": "full"}
          ]
        }
    """
    from datetime import datetime, timedelta
    from app.services.workout.fitness_score import compute_fitness_score
    from app.models import (
        WorkoutCompletion,
        WorkoutSession,
        WorkoutExercise,
        ExerciseSet,
        Exercise as SeedExercise,
    )

    try:
        profiles = build_performance_profile(current_user.id, db)
    except Exception as e:
        print(f"[fitness-score] profile build failed: {e}")
        profiles = {}

    # Pull the last 14 days of lightweight completion rows for the
    # Cardio + Consistency pillars. Uses the same reliable source
    # the 36-hour continuity rotation already reads from.
    # Naive UTC — matches TIMESTAMP WITHOUT TIME ZONE storage of
    # WorkoutCompletion.completed_at. Replaces deprecated datetime.utcnow().
    from datetime import timezone as _tz
    _now_naive = datetime.now(_tz.utc).replace(tzinfo=None)
    cutoff_14d = _now_naive - timedelta(days=14)
    cutoff_28d = _now_naive - timedelta(days=28)
    cutoff_56d = _now_naive - timedelta(days=56)
    try:
        rows = db.exec(
            select(WorkoutCompletion)
            .where(WorkoutCompletion.user_id == current_user.id)
            .where(WorkoutCompletion.completed_at >= cutoff_14d)
            .order_by(WorkoutCompletion.completed_at.desc())
        ).all()
    except Exception as e:
        print(f"[fitness-score] recent completions query failed: {e}")
        rows = []

    recent_completions = [
        {
            "focus": r.focus_label,
            "duration_seconds": r.duration_seconds,
            "workout_date": r.workout_date.isoformat() if r.workout_date else None,
        }
        for r in rows
    ]
    session_count_14d = len(rows)

    # ── Strength pillar inputs ────────────────────────────────────
    # Walk the structured WorkoutSession + WorkoutExercise + ExerciseSet
    # tables to compute the four sub-component inputs:
    #   - patterns_hit: set of movement patterns trained in the last 28d
    #   - volume_load_lbs: total weight × reps across all sets in 28d
    #   - distinct_exercises: count of unique exercise names in 28d
    #   - progression_ratio: fraction of exercises whose top set
    #     improved from the prior 28-day window to the current one
    # All best-effort; failures degrade strength but don't crash.
    patterns_hit: set[str] = set()
    volume_load_lbs = 0.0
    distinct_exercise_names: set[str] = set()
    progression_ratio = 0.0
    try:
        # Build a slug → movement_pattern map from the seed catalog.
        seed_rows = db.exec(select(SeedExercise)).all()
        slug_to_pattern: dict[str, str] = {}
        name_to_pattern: dict[str, str] = {}
        for sx in seed_rows:
            pat = (getattr(sx, "movement_pattern", None) or "").strip().lower()
            if pat:
                if sx.slug:
                    slug_to_pattern[sx.slug] = pat
                if sx.name:
                    name_to_pattern[sx.name.strip().lower()] = pat

        # Pull all sessions from the last 28 days.
        recent_sessions_28d = db.exec(
            select(WorkoutSession)
            .where(WorkoutSession.user_id == current_user.id)
            .where(WorkoutSession.workout_date >= cutoff_28d.date())
        ).all()
        recent_session_ids = [s.id for s in recent_sessions_28d if s.id is not None]

        if recent_session_ids:
            recent_exs = db.exec(
                select(WorkoutExercise)
                .where(WorkoutExercise.session_id.in_(recent_session_ids))
            ).all()
            ex_id_to_name: dict[int, str] = {}
            for ex in recent_exs:
                if ex.id is None:
                    continue
                ex_id_to_name[ex.id] = (ex.name or "").strip()
                lname = (ex.name or "").strip().lower()
                if lname:
                    distinct_exercise_names.add(lname)
                    pat = name_to_pattern.get(lname)
                    if pat:
                        patterns_hit.add(pat)

            recent_sets = db.exec(
                select(ExerciseSet)
                .where(ExerciseSet.workout_exercise_id.in_(list(ex_id_to_name.keys())))
            ).all()
            # Volume load: sum of (actual_weight × actual_reps) across
            # every set in the window. Ignores zero-weight bodyweight
            # rows since they don't contribute to weight·reps load.
            for s in recent_sets:
                w = s.actual_weight_lbs or 0
                r = s.actual_reps or 0
                if w > 0 and r > 0:
                    volume_load_lbs += w * r

            # Progression ratio: for each exercise name, compute the
            # top-set "score" (weight × reps) in the current 28d window
            # vs the prior 28d window. Fraction of exercises whose
            # current top is >= prior top is the progression ratio.
            current_top: dict[str, float] = {}
            for ex_id, ex_name in ex_id_to_name.items():
                ex_sets = [s for s in recent_sets if s.workout_exercise_id == ex_id]
                if not ex_sets:
                    continue
                top = max(
                    ((s.actual_weight_lbs or 0) * (s.actual_reps or 0))
                    for s in ex_sets
                )
                key = ex_name.lower()
                if top > 0:
                    current_top[key] = max(current_top.get(key, 0.0), top)

            # Prior window: 28-56 days ago
            prior_sessions = db.exec(
                select(WorkoutSession)
                .where(WorkoutSession.user_id == current_user.id)
                .where(WorkoutSession.workout_date >= cutoff_56d.date())
                .where(WorkoutSession.workout_date < cutoff_28d.date())
            ).all()
            prior_session_ids = [s.id for s in prior_sessions if s.id is not None]
            prior_top: dict[str, float] = {}
            if prior_session_ids:
                prior_exs = db.exec(
                    select(WorkoutExercise)
                    .where(WorkoutExercise.session_id.in_(prior_session_ids))
                ).all()
                prior_ex_ids = [e.id for e in prior_exs if e.id is not None]
                prior_ex_id_to_name = {e.id: (e.name or "").strip().lower() for e in prior_exs if e.id}
                if prior_ex_ids:
                    prior_sets = db.exec(
                        select(ExerciseSet)
                        .where(ExerciseSet.workout_exercise_id.in_(prior_ex_ids))
                    ).all()
                    for s in prior_sets:
                        w = s.actual_weight_lbs or 0
                        r = s.actual_reps or 0
                        if w > 0 and r > 0:
                            key = prior_ex_id_to_name.get(s.workout_exercise_id, "")
                            if key:
                                prior_top[key] = max(prior_top.get(key, 0.0), w * r)

            # Compare per exercise. Exercises only in the current window
            # count as "new" — they're a positive signal so we credit them.
            if current_top:
                improved = 0
                for name, cur in current_top.items():
                    prev = prior_top.get(name, 0.0)
                    if prev <= 0 or cur >= prev:
                        improved += 1
                progression_ratio = improved / len(current_top)
    except Exception as e:
        print(f"[fitness-score] strength sub-component query failed (non-fatal): {e}")

    # Look up user's age so the fitness score baselines can be age-banded.
    user_age: int | None = None
    try:
        from app.models import UserProfile as UserProfileModel
        profile_row = db.exec(
            select(UserProfileModel).where(UserProfileModel.user_id == current_user.id)
        ).first()
        user_age = profile_row.age if profile_row else None
    except Exception:
        user_age = None

    score = compute_fitness_score(
        profiles=profiles,
        bodyweight_lbs=bodyweight_lbs,
        recent_completions=recent_completions,
        session_count_14d=session_count_14d,
        days_per_week=int(days_per_week or 3),
        recent_sleep_hours=recent_sleep_hours,
        avg_session_rpe=avg_session_rpe,
        patterns_hit=patterns_hit,
        volume_load_lbs=volume_load_lbs,
        distinct_exercises=len(distinct_exercise_names),
        progression_ratio=progression_ratio,
        user_age=user_age,
    )
    return score.to_dict()


# ── MET classification for calorie estimation ────────────────────────
# Explicit mapping from known focus labels (archetype default_name values)
# to MET categories. Avoids fragile substring matching.
_CARDIO_FOCUS_LABELS: frozenset[str] = frozenset({
    "zone 2 cardio", "short intervals", "long intervals",
    "tempo / threshold", "metabolic circuit", "mixed conditioning",
    "sprint + power",
})
_STRENGTH_FOCUS_LABELS: frozenset[str] = frozenset({
    "full body — strength",
})
# training_type keywords for archetype-derived labels
_CARDIO_TRAINING_TYPES: frozenset[str] = frozenset({
    "conditioning", "cardio",
})
_STRENGTH_TRAINING_TYPES: frozenset[str] = frozenset({
    "strength", "power",
})


def _met_for_focus(focus: str) -> float:
    """Classify workout focus → MET value for calorie estimation.
    Uses explicit label lookup first, falls back to keyword scan."""
    from app.services.workout.archetypes import DayArchetype, ARCHETYPE_META

    focus_l = focus.lower().strip()

    # 1. Try exact match against known archetype default_name values
    if focus_l in _CARDIO_FOCUS_LABELS:
        return 8.0
    if focus_l in _STRENGTH_FOCUS_LABELS:
        return 6.5

    # 2. Try to resolve via archetype enum → training_type
    for arch, meta in ARCHETYPE_META.items():
        if meta.default_name.lower() == focus_l:
            if meta.training_type in _CARDIO_TRAINING_TYPES:
                return 8.0
            if meta.training_type in _STRENGTH_TRAINING_TYPES:
                return 6.5
            return 5.5

    # 3. Fallback for free-text focus labels not matching any archetype
    if any(kw in focus_l for kw in ("cardio", "run", "cycle", "hiit", "conditioning")):
        return 8.0
    if any(kw in focus_l for kw in ("strength", "power", "heavy")):
        return 6.5
    return 5.5


@router.post("/workout-summary")
def generate_workout_summary(
    body: WorkoutSummaryRequest,
    current_user: User = Depends(require_pro_feature("AI workout summaries")),
    db: Session = Depends(get_session),
):
    """AI post-workout summary: calories burned, achievements, and personalised recommendations."""
    weight_kg      = body.weightLbs / 2.205
    duration_hours = body.durationSeconds / 3600

    met = _met_for_focus(body.focus)

    calories_burned = max(1, round(met * weight_kg * duration_hours))

    total_sets     = sum(len(ex.get("sets", [])) for ex in body.exercises)
    exercises_done = sum(1 for ex in body.exercises if len(ex.get("sets", [])) > 0)
    achievements: list[str] = []
    for ex in body.exercises:
        sets = ex.get("sets", [])
        if sets:
            best   = max(sets, key=lambda s: s.get("weightLbs", 0) * s.get("reps", 0))
            weight = best.get("weightLbs", 0)
            reps   = best.get("reps", 0)
            if weight > 0:
                achievements.append(f"{ex['name']}: {weight} lbs × {reps} reps")

    api_key = get_openai_api_key()
    if not api_key:
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": "Solid effort — every set counts toward your goal. Keep showing up!",
            "achievements": achievements[:4],
            "recommendations": [
                "Consume 20–40 g protein within 2 hours for optimal recovery.",
                "Hydrate well — aim for at least 16 oz of water post-workout.",
                "Sleep 7–9 hours tonight to lock in the gains from this session.",
            ],
        }

    # Pull the most recent comparable session (same focus) so the AI can
    # make an honest comparison instead of inventing one. Best-effort —
    # failure here silently falls back to "no comparison".
    last_session_lines = ""
    last_session_date = None
    try:
        from app.models import WorkoutSession, ExerciseSet
        last = db.exec(
            select(WorkoutSession)
            .where(
                WorkoutSession.user_id == current_user.id,
                WorkoutSession.focus == body.focus,
            )
            .order_by(WorkoutSession.workout_date.desc())
            .limit(2)
        ).all()
        # Skip the most recent (that's THIS session that was just logged);
        # the second hit is the previous comparable session.
        prior = last[1] if len(last) >= 2 else None
        if prior:
            last_session_date = str(prior.workout_date)
            prior_sets = db.exec(
                select(ExerciseSet)
                .where(ExerciseSet.session_id == prior.id)
                .order_by(ExerciseSet.exercise_name, ExerciseSet.set_number)
            ).all()
            per_ex: dict[str, list[str]] = {}
            for s in prior_sets:
                per_ex.setdefault(s.exercise_name, []).append(
                    f"{s.reps}×{int(s.weight_lbs)}"
                )
            last_session_lines = "\n".join(
                f"  {name}: {', '.join(sets[:4])}"
                for name, sets in list(per_ex.items())[:6]
            )
    except Exception:
        pass

    client = OpenAI(api_key=api_key)
    try:
        system_prompt = (
            "You are a strength coach writing a grounded 4-part post-workout recap. "
            "You receive today's session + the user's last comparable session (by focus). "
            "Your job: identify what is real in the data, name ONE specific coaching point, "
            "and hedge honestly when the data is mixed.\n\n"
            "FORBIDDEN: 'Great work!', 'Keep pushing!', 'Crush it', generic motivation, "
            "'every rep counts', 'stay consistent'.\n"
            "REQUIRED: Every claim must cite a specific exercise, weight, or rep count "
            "from today or the comparison session. If there is no comparison session, "
            "say so in `comparison` and skip the comparison — do not invent one.\n\n"
            "Return JSON only. Single-sentence values, plain prose, no markdown."
        )
        prompt = (
            f"TODAY:\n"
            f"- Focus: {body.focus}\n"
            f"- Goal: {body.goal}\n"
            f"- Duration: {body.durationSeconds // 60} min\n"
            f"- Exercises completed: {exercises_done}\n"
            f"- Total sets logged: {total_sets}\n"
            f"- Estimated calories burned: {calories_burned}\n"
            f"- Top sets today:\n"
            + ("\n".join(f"  {a}" for a in achievements[:6]) or "  (none logged)")
            + "\n\n"
            f"LAST COMPARABLE {body.focus.upper()} SESSION "
            f"({last_session_date or 'none on file'}):\n"
            + (last_session_lines or "  (no comparable session in history)")
            + "\n\n"
            "Return JSON with these four fields, in this exact order:\n"
            "{\n"
            '  "headline": "<one sentence, ≤100 chars, what actually happened>",\n'
            '  "comparison": "<one sentence comparing to last session, OR empty string if none>",\n'
            '  "coachingPoint": "<one specific cue for next session, names an exercise>",\n'
            '  "motivation": "<one honest sentence — no generic filler>"\n'
            "}"
        )
        _ws_messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ]
        # New structured schema — keep motivationMessage + recommendations
        # populated for back-compat with the mobile client, but also
        # surface the new structured fields.
        schema = {
            "name": "workout_summary_v2",
            "schema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["headline", "comparison", "coachingPoint", "motivation"],
                "properties": {
                    "headline": {"type": "string", "maxLength": 120},
                    "comparison": {"type": "string", "maxLength": 200},
                    "coachingPoint": {"type": "string", "maxLength": 200},
                    "motivation": {"type": "string", "maxLength": 160},
                },
            },
        }
        kwargs = _build_chat_kwargs(model_chat(), _ws_messages, json_schema=schema, max_tokens=400, timeout_secs=30)
        response = _chat_create(client, **kwargs)
        ai = _extract_json(response.choices[0].message.content)
        headline       = str(ai.get("headline") or "").strip()
        comparison     = str(ai.get("comparison") or "").strip()
        coaching_point = str(ai.get("coachingPoint") or "").strip()
        motivation     = str(ai.get("motivation") or "").strip()
        # Back-compat: synthesize motivationMessage + recommendations so
        # the mobile client renders something while it catches up.
        legacy_message = motivation or headline or "Session logged."
        legacy_tips = [s for s in (coaching_point, comparison) if s]
        if len(legacy_tips) < 3:
            legacy_tips += [
                "Hydrate well post-workout.",
                "Consume 20-40 g protein within 2 hours.",
                "Aim for 7-9 hours of sleep tonight.",
            ]
        return {
            # New structured fields the upgraded client renders.
            "headline": headline,
            "comparison": comparison,
            "coachingPoint": coaching_point,
            "motivation": motivation,
            # Legacy fields.
            "caloriesBurned": calories_burned,
            "motivationMessage": legacy_message,
            "achievements": achievements[:4],
            "recommendations": legacy_tips[:3],
        }
    except Exception:
        return {
            "caloriesBurned": calories_burned,
            "motivationMessage": "Strong session — consistency is the key to progress!",
            "achievements": achievements[:4],
            "recommendations": [
                "Consume 20–40 g protein within 2 hours.",
                "Hydrate well post-workout.",
                "Aim for 7–9 hours of sleep tonight.",
            ],
        }


# ── AI warm-up generator ────────────────────────────────────────────
# Returns 4-6 warm-up steps tailored to today's workout (focus +
# first couple of exercises) and the user's injuries. Frontend caches
# the result by workout day so repeated visits to the same day don't
# re-hit the API. Falls back to a deterministic 4-step template if the
# AI call fails or no API key is set — the active workout screen never
# blocks on this.
_WARMUP_SCHEMA = {
    "name": "warmup_steps",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["steps"],
        "properties": {
            "steps": {
                "type": "array",
                "minItems": 3,
                "maxItems": 6,
                "items": {"type": "string"},
            },
        },
    },
}


# ── Warmup body-region classification ─────────────────────────────────
# Maps known focus labels to warmup body regions via archetype metadata.
# Avoids fragile substring scanning of focus strings.
_WARMUP_REGION_LOWER: frozenset[str] = frozenset({
    "legs", "lower",
})
_WARMUP_REGION_PULL: frozenset[str] = frozenset({
    "pull",
})
_WARMUP_REGION_PUSH_UPPER: frozenset[str] = frozenset({
    "push", "upper",
})
_WARMUP_REGION_RECOVERY: frozenset[str] = frozenset({
    "recovery", "mobility",
})


def _classify_warmup_region(focus: str) -> str:
    """Classify focus label → warmup body region category.
    Returns one of: 'lower', 'pull', 'push_upper', 'recovery', 'general'."""
    from app.services.workout.archetypes import DayArchetype, ARCHETYPE_META, ARCHETYPE_TO_FOCUS_FAMILY

    focus_l = (focus or "").lower().strip()

    # 1. Try to resolve via archetype metadata (match default_name)
    for arch, meta in ARCHETYPE_META.items():
        if meta.default_name.lower() == focus_l:
            # Check category first for recovery/mobility
            if meta.category in ("recovery", "mobility"):
                return "recovery"
            family = ARCHETYPE_TO_FOCUS_FAMILY.get(arch, "")
            if family in _WARMUP_REGION_LOWER:
                return "lower"
            if family in _WARMUP_REGION_PULL:
                return "pull"
            if family in _WARMUP_REGION_PUSH_UPPER:
                return "push_upper"
            if meta.category == "cond":
                return "general"
            return "general"

    # 2. Fallback for labels that don't match any archetype default_name
    if any(k in focus_l for k in ("recovery", "mobility", "stretch")):
        return "recovery"
    if any(k in focus_l for k in ("leg", "lower", "squat", "glute", "hinge")):
        return "lower"
    if any(k in focus_l for k in ("pull", "back", "row")):
        return "pull"
    if any(k in focus_l for k in ("push", "chest", "shoulder", "upper")):
        return "push_upper"
    return "general"


def _deterministic_warmup(focus: str, first: str | None, second: str | None,
                            exercise_count: int = 0) -> list[str]:
    """Vary 1-4 steps based on focus + session size + first lift type.
    Recovery/mobility days get a single prep line. Short sessions get
    a tighter warmup. Heavy compounds always get a ramp-up."""
    first_l = (first or "").lower()
    is_heavy_compound = any(k in first_l for k in (
        "squat", "deadlift", "bench", "overhead press", "ohp",
        "barbell press", "clean", "snatch", "hip thrust",
    ))
    ramp = (
        f"2-3 ramp-up sets of {first}" if (first and is_heavy_compound)
        else (f"1 light set of {first}" if first else "2 ramp-up sets at 50%")
    )

    region = _classify_warmup_region(focus)

    if region == "recovery":
        return ["Move slowly through the first round to warm up."]

    if region == "lower":
        pool = ["3 min easy bike or walk", "Hip circles + ankle rocks (10 each)", "Bodyweight squats × 10"]
    elif region == "pull":
        pool = ["3 min light cardio", "Band pull-aparts × 15", "Scap push-ups × 10"]
    elif region == "push_upper":
        pool = ["3 min light cardio", "Arm circles + band dislocates × 10", "Push-ups × 10"]
    else:
        pool = ["2 min light cardio", "Dynamic stretches for major joints"]

    if exercise_count <= 3:
        prep_count = 1
    elif exercise_count <= 5:
        prep_count = 2
    else:
        prep_count = len(pool)

    return pool[:prep_count] + [ramp]


@router.post("/warmup")
def generate_warmup(
    body: WarmupRequest,
    current_user: User = Depends(require_pro_feature("AI warmups")),
):
    """AI-generated warm-up tailored to today's workout + user injuries.
    Cheap call: ~300 input / ~200 output tokens on gpt-4o-mini.
    Falls back to a deterministic template on any failure."""
    first_ex = body.exercises[0].get("name") if body.exercises else None
    second_ex = body.exercises[1].get("name") if len(body.exercises) > 1 else None

    ex_count = len(body.exercises or [])
    api_key = get_openai_api_key()
    if not api_key:
        return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex, ex_count), "source": "fallback"}

    try:
        client = OpenAI(api_key=api_key)
        ex_lines = "\n".join(
            f"  - {e.get('name', '?')} ({e.get('equipment') or 'bodyweight'})"
            for e in body.exercises[:6]
        ) or "  (no exercises)"
        injuries_line = ", ".join(body.injuries) if body.injuries else "none"
        # Step count varies by session length so the warmup doesn't
        # always feel like the same template.
        if ex_count <= 3:
            target_steps = "2-3"
        elif ex_count <= 5:
            target_steps = "3"
        else:
            target_steps = "3-4"
        prompt = (
            f"Write a {target_steps}-step warm-up for today's workout. "
            "Each step must be SHORT — under 8 words, like a gym whiteboard. "
            "No paragraphs, no explanations.\n\n"
            f"Focus: {body.focus}\n"
            f"Total exercises today: {ex_count}\n"
            f"Injuries to avoid: {injuries_line}\n"
            f"First exercise: {first_ex or 'compound lift'}\n"
            f"Today's exercises:\n{ex_lines}\n\n"
            "Format: action + reps/duration. Examples:\n"
            '  "3 min easy bike"\n'
            '  "Hip circles × 10 each"\n'
            '  "Band pull-aparts × 15"\n'
            '  "2 light sets of Bench Press"\n\n'
            f'Return JSON: {{"steps": [...]}} with exactly {target_steps} items.'
        )
        messages = [
            {"role": "system", "content": "You are a strength coach writing a tailored warm-up. Be concise, specific, and injury-aware. Return only the required JSON."},
            {"role": "user", "content": prompt},
        ]
        kwargs = _build_chat_kwargs(
            model_chat(),
            messages,
            json_schema=_WARMUP_SCHEMA,
            max_tokens=500,
            timeout_secs=20,
        )
        response = _chat_create(client, **kwargs)
        data = _extract_json(response.choices[0].message.content or "")
        steps = data.get("steps") if isinstance(data, dict) else None
        if not isinstance(steps, list) or not steps:
            return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex, ex_count), "source": "fallback"}
        cleaned = [str(s).strip() for s in steps if str(s).strip()]
        return {"steps": cleaned[:6], "source": "ai"}
    except Exception as exc:
        print(f"[ai/warmup] failed (non-fatal): {exc}")
        return {"steps": _deterministic_warmup(body.focus, first_ex, second_ex, ex_count), "source": "fallback"}


# ── Pre-set recommendation (deterministic, no AI by default) ────────
# Shown in the active-workout card BEFORE the user logs a set, so the
# user can see recommended weight + reps + set intent (heavy/backoff/
# volume/technique) + a one-sentence rationale. Zero AI cost on the
# normal path — AI only fires when the prior set was suspicious AND the
# user fed back their feel.
@router.post("/pre-set-recommendation")
def pre_set_recommendation(
    body: PreSetRecommendRequest,
    current_user: User = Depends(require_pro_feature("In-workout set review")),
    db: Session = Depends(get_session),
):
    from app.services.workout.set_programming import (
        PlannedSet as PS,
        NextSetRecommendation,
        parse_rep_range,
        recommend_next_set,
    )
    from app.services.workout.recommendation_schema import (
        enrich_to_set_recommendation,
    )

    # 1. Resolve the planned set we're about to do.
    if body.plannedSetNumber < 1 or body.plannedSetNumber > max(1, len(body.plannedSets)):
        raise HTTPException(status_code=400, detail="plannedSetNumber out of range")
    raw = body.plannedSets[body.plannedSetNumber - 1]
    planned = PS(
        set_number=int(raw.get("setNumber") or body.plannedSetNumber),
        set_type=raw.get("setType") or "working",
        target_reps=str(raw.get("targetReps") or "8-12"),
        target_rir=float(raw.get("targetRir") or 2.0),
        target_weight_lbs=(float(raw["targetWeightLbs"]) if raw.get("targetWeightLbs") else None),
        progression_mode=raw.get("progressionMode") or "load_first",
    )

    # 2. Build a minimal exercise dict for the increment helper.
    exercise = _set_programming_exercise_metadata(
        db,
        body.exerciseName,
        body.exerciseSlug,
        body.equipment,
    )

    prior = body.priorSetsThisSession or []
    last_session = body.lastSessionSets or []

    # DB-side fallback: the client's name-based `lastSessionSets` lookup
    # misses when the generated plan exercise name differs from the logged
    # history name (e.g. "Back Squat" vs "Barbell Back Squat"). Before we
    # fall through to the AI first-time branch, ask the DB directly via
    # slug — this is what the /recommend-weight endpoint does and keeps the
    # two endpoints consistent.
    if not last_session:
        try:
            from app.services.workout.history import db_history_lookup
            slug = _resolve_exercise_slug(db, body.exerciseName, body.exerciseSlug)
            if slug:
                hist = db_history_lookup(current_user.id, db)(slug)
                if hist:
                    last_session = [
                        {"reps": int(s.reps or 0), "weightLbs": float(s.weight_lbs or 0.0)}
                        for s in hist
                        if (s.weight_lbs or 0) > 0
                    ]
        except Exception:
            logger.exception("[pre-set] DB history lookup failed (non-fatal)")

    is_first_session = not last_session
    is_first_set = len(prior) == 0

    # 3. Deterministic target weight + reps.
    #    - If there's a prior set this session → feed it into recommend_next_set
    #      (so Set 3 knows what happened on Set 2)
    #    - Else if last session data exists → use that as the anchor
    #    - Else → fall back to planner's target_weight_lbs
    if prior:
        last = prior[-1]
        det = recommend_next_set(
            exercise=exercise,
            planned_set=planned,
            actual_reps=int(last.get("reps") or 0),
            actual_weight_lbs=float(last.get("weightLbs") or 0.0),
            actual_rir=last.get("rir"),
            rep_range=parse_rep_range(planned.target_reps),
        )
    elif last_session:
        # Infer a plausible opening weight from the best comparable last-session set.
        best = max(last_session, key=lambda s: float(s.get("weightLbs") or 0))
        weight = float(best.get("weightLbs") or 0)
        det = NextSetRecommendation(
            next_set_weight_lbs=weight if weight > 0 else planned.target_weight_lbs,
            next_set_rep_target=planned.target_reps,
            action="hold_load",
            explanation=(
                f"Opening at {int(weight)} lb — same as your best working set last "
                f"{body.exerciseName} session."
            ) if weight > 0 else "Opening at the planned weight.",
        )
    else:
        # First-ever session on this exercise — try the AI first-time
        # branch first (uses the user's last 3 same-muscle sessions to
        # infer a sensible starting weight). Falls through to the
        # deterministic planner target on any failure (missing muscle
        # metadata, no prior same-muscle sessions, AI error).
        ai_rec = _try_ai_first_time_branch(
            user_id=current_user.id,
            db=db,
            exercise_name=body.exerciseName,
            exercise_slug=body.exerciseSlug,
            target_reps=str(planned.target_reps or "8-12"),
            experience="intermediate",
        )
        if ai_rec is not None:
            ai_weight, _ = ai_rec
            det = NextSetRecommendation(
                next_set_weight_lbs=float(ai_weight),
                next_set_rep_target=planned.target_reps,
                action="hold_load",
                explanation="",
            )
        else:
            det = NextSetRecommendation(
                next_set_weight_lbs=planned.target_weight_lbs,
                next_set_rep_target=planned.target_reps,
                action="hold_load",
                explanation=(
                    f"First time on {body.exerciseName} — starting at "
                    f"{int(planned.target_weight_lbs or 0) or '?'} lb to calibrate. "
                    "Tell me how it feels after the set."
                ),
            )

    rec = enrich_to_set_recommendation(
        det=det,
        planned=planned,
        actual_reps=None,
        actual_weight=None,
        feel=body.feelFromLastSet,
        is_first_session=is_first_session,
        is_first_set=is_first_set,
        rep_range=parse_rep_range(planned.target_reps),
        source=("ai_first_time" if is_first_session and not prior and "ai_first_time" in (det.explanation or "").lower() else "deterministic"),
    )
    return rec.to_dict()


# ── Custom-food macro + micro validation ────────────────────────────
# Called on-demand from the client when a custom food is tapped or
# when the library runs a batch sanity-check. Returns corrected
# macros/micros + a verification verdict:
#   ok                 — values match USDA within tolerance; no changes
#   corrected          — AI found a meaningful error and returned fixes
#   insufficient_data  — AI couldn't find a USDA reference (e.g. a
#                        brand-specific packaged food it doesn't know)
#
# The client stores the verdict as `verification_status` on the custom
# food row so the UI can show a badge and skip re-validation next time.
_FOOD_VALIDATION_SCHEMA = {
    "name": "food_macro_validation",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["verdict", "notes"],
        "properties": {
            "verdict": {"type": "string", "enum": ["ok", "corrected", "insufficient_data"]},
            "notes": {"type": "string", "maxLength": 200},
            "corrected": {
                "type": ["object", "null"],
                "properties": {
                    "calories": {"type": ["number", "null"]},
                    "protein":  {"type": ["number", "null"]},
                    "carbs":    {"type": ["number", "null"]},
                    "fat":      {"type": ["number", "null"]},
                    "micros":   {"type": ["object", "null"]},
                },
            },
        },
    },
}


@router.post("/enrich-food-db")
def enrich_food_db(
    limit: int = 0,
    current_user: User = Depends(require_pro_feature("AI food enrichment")),
    db: Session = Depends(get_session),
):
    """Bootstrap endpoint — seed every `food_nutrition` row that's
    missing Layer 2 micronutrients with AI-generated USDA values.

    Pass `?limit=N` to process a test batch. Omit for a full pass.
    Writes directly to `FoodNutrition.extra_nutrients` (legacy fiber/
    sugar/sodium columns are also backfilled). Idempotent — skips rows
    already enriched.

    Returns counts so the client can render a progress/result toast.
    Cost: ~$0.0005 per food enriched, batched at 10 per AI call."""
    from app.models import Food, FoodNutrition

    try:
        from openai import OpenAI
        api_key = get_openai_api_key()
        if not api_key:
            raise HTTPException(status_code=503, detail="OpenAI not configured")
        client = OpenAI(api_key=api_key)
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"OpenAI init failed: {e}")

    REQUIRED = (
        "fiber", "sugar", "sodium", "cholesterol",
        "saturated_fat", "monounsaturated_fat", "polyunsaturated_fat",
        "omega_3", "omega_6",
        "potassium", "calcium", "iron", "magnesium",
        "vitamin_c", "vitamin_d", "vitamin_b12",
    )
    BATCH = 10

    def _needs(nut: FoodNutrition) -> bool:
        present = 0
        for k in REQUIRED:
            if k in ("fiber", "sugar"):
                val = getattr(nut, k, None)
            elif k == "sodium":
                val = getattr(nut, "sodium_mg", None)
            else:
                val = (getattr(nut, "extra_nutrients", None) or {}).get(k)
            if val is not None and float(val or 0) > 0:
                present += 1
        return present < 10

    nut_rows = db.exec(select(FoodNutrition)).all()
    candidates = [n for n in nut_rows if _needs(n)]
    if limit > 0:
        candidates = candidates[:limit]

    print(f"[enrich-food-db] {len(candidates)} rows need enrichment (of {len(nut_rows)})")
    if not candidates:
        return {"total": len(nut_rows), "enriched": 0, "skipped": len(nut_rows), "errors": 0}

    food_ids = [n.food_id for n in candidates]
    foods_by_id: dict[int, Food] = {
        f.id: f for f in db.exec(select(Food).where(Food.id.in_(food_ids))).all()
    }

    enriched_count = 0
    error_count = 0

    for start in range(0, len(candidates), BATCH):
        batch = candidates[start : start + BATCH]
        pairs = [(foods_by_id[n.food_id], n) for n in batch if n.food_id in foods_by_id]
        if not pairs:
            continue
        items_payload = [{"food_id": f.id, "name": f.name, "reference_unit": "100g"} for f, _ in pairs]
        prompt = (
            "Return USDA per-100g micronutrient values for each food. Use snake_case "
            "keys exactly as shown. Be accurate — USDA reference data only.\n"
            "Units: fiber/sugar/saturated_fat/monounsaturated_fat/polyunsaturated_fat "
            "in g; sodium/cholesterol/omega_3/omega_6/potassium/calcium/iron/magnesium/"
            "vitamin_c in mg; vitamin_d and vitamin_b12 in mcg.\n\n"
            f"Foods:\n{json.dumps(items_payload, indent=2)}\n\n"
            "Return JSON:\n"
            '{"foods": [{"food_id": int, "name": str, "micros": {"fiber": 0, "sugar": 0, '
            '"sodium": 0, "cholesterol": 0, "saturated_fat": 0, "monounsaturated_fat": 0, '
            '"polyunsaturated_fat": 0, "omega_3": 0, "omega_6": 0, "potassium": 0, '
            '"calcium": 0, "iron": 0, "magnesium": 0, "vitamin_c": 0, "vitamin_d": 0, '
            '"vitamin_b12": 0}}]}'
        )
        try:
            resp = client.chat.completions.create(
                model=os.getenv("MODEL_FOOD_ENRICHMENT") or "gpt-4o-mini",
                messages=[
                    {"role": "system", "content": "You are a USDA nutrition database. Return accurate per-100g micronutrient values. JSON only."},
                    {"role": "user", "content": prompt},
                ],
                response_format={"type": "json_object"},
                max_tokens=2500,
                timeout=30,
            )
            data = json.loads(resp.choices[0].message.content or "{}")
        except Exception as e:
            print(f"[enrich-food-db] batch AI failed: {e}")
            error_count += len(pairs)
            continue

        results: dict[int, dict[str, float]] = {}
        for entry in data.get("foods") or []:
            if not isinstance(entry, dict):
                continue
            fid = entry.get("food_id")
            micros = entry.get("micros") or {}
            if not isinstance(fid, int) or not isinstance(micros, dict):
                continue
            clean: dict[str, float] = {}
            for k, v in micros.items():
                if k not in REQUIRED:
                    continue
                try:
                    clean[k] = float(v)
                except (TypeError, ValueError):
                    continue
            if clean:
                results[fid] = clean

        for food, nut in pairs:
            micros = results.get(food.id)
            if not micros:
                error_count += 1
                continue
            extras = dict(getattr(nut, "extra_nutrients", None) or {})
            for k, v in micros.items():
                if k == "fiber":
                    nut.fiber = v
                elif k == "sugar":
                    nut.sugar = v
                elif k == "sodium":
                    nut.sodium_mg = v
                else:
                    extras[k] = v
            nut.extra_nutrients = extras
            db.add(nut)
            enriched_count += 1
        db.commit()

    # Also pick up any custom foods stored per-user if the table exists.
    print(f"[enrich-food-db] done — enriched={enriched_count} errors={error_count}")
    return {
        "total": len(nut_rows),
        "candidates": len(candidates),
        "enriched": enriched_count,
        "errors": error_count,
        "remaining": max(0, len(candidates) - enriched_count - error_count),
    }


@router.post("/backfill-food-processing")
def backfill_food_processing(
    limit: int = 0,
    current_user: User = Depends(require_pro_feature("Nutrition insights")),
):
    """Classify processing_bucket for every Food row that lacks a FoodMetadata
    entry at the current classifier version. Covers seeded, USDA-imported, and
    custom foods. AI is called only for genuinely ambiguous names.

    Pass ?limit=N to process a test batch. Omit for a full run.
    Idempotent — already-classified rows are skipped."""
    from app.services.nutrition.gut_backfill import backfill_all_food_rows
    max_rows = limit if limit > 0 else None
    return backfill_all_food_rows(allow_ai=True, max_rows=max_rows)


@router.post("/validate-food-macros")
def validate_food_macros(
    body: ValidateFoodMacrosRequest,
    current_user: User = Depends(require_pro_feature("AI food enrichment")),
):
    """Validate one custom food's macros + micros against USDA reference.

    Cheap call (~300 input + ~300 output tokens on gpt-4o-mini ≈ $0.0002).
    The client is expected to call this lazily (e.g. first time the food
    is opened in detail view) and cache the verdict per food."""
    api_key = get_openai_api_key()
    if not api_key:
        return {
            "verdict": "insufficient_data",
            "notes": "AI unavailable (no API key configured).",
            "corrected": None,
        }

    try:
        client = OpenAI(api_key=api_key)
        current_payload = {
            "name": body.name,
            "serving": body.servingLabel,
            "calories": body.calories,
            "protein": body.protein,
            "carbs": body.carbs,
            "fat": body.fat,
            "micronutrients": body.micronutrients or {},
        }
        prompt = (
            "You are a USDA nutrition database. Given a food + serving + claimed "
            "macros + optional micronutrients, decide whether the claimed values "
            "match reference data within tolerance.\n\n"
            "Rules:\n"
            "1. Tolerance: ±15% on calories and macros is ok. Outside that → 'corrected'.\n"
            "2. If micronutrients are missing or ALL zero, return 'corrected' with a\n"
            "   full USDA-derived micronutrient panel for this serving.\n"
            "3. If the food is too generic or brand-specific to verify (e.g. 'my\n"
            "   homemade bowl', 'grandma's stew'), return 'insufficient_data'.\n"
            "4. Use snake_case micronutrient keys: fiber, sugar, sodium, cholesterol,\n"
            "   saturated_fat, monounsaturated_fat, polyunsaturated_fat, omega_3,\n"
            "   omega_6, potassium, calcium, iron, magnesium, vitamin_c, vitamin_d,\n"
            "   vitamin_b12. Units: g for fats/fiber/sugar, mg for sodium/cholesterol/\n"
            "   omega_*/minerals/vitamin_c, mcg for vitamin_d and vitamin_b12.\n\n"
            f"Food to validate:\n{json.dumps(current_payload, indent=2)}\n\n"
            "Return JSON: {\"verdict\": \"ok\"|\"corrected\"|\"insufficient_data\", "
            "\"notes\": \"<one sentence explanation>\", "
            "\"corrected\": null OR {calories, protein, carbs, fat, micros}}"
        )
        kwargs = _build_chat_kwargs(
            model_chat(),
            [
                {"role": "system", "content": "You are a precise USDA nutrition reference. Return only the required JSON."},
                {"role": "user", "content": prompt},
            ],
            json_schema=_FOOD_VALIDATION_SCHEMA,
            max_tokens=500,
            timeout_secs=20,
        )
        response = _chat_create(client, **kwargs)
        data = _extract_json(response.choices[0].message.content or "")
        if not isinstance(data, dict):
            return {"verdict": "insufficient_data", "notes": "invalid response shape", "corrected": None}
        return {
            "verdict": data.get("verdict") or "insufficient_data",
            "notes": str(data.get("notes") or "")[:200],
            "corrected": data.get("corrected"),
        }
    except Exception as exc:
        print(f"[validate_food_macros] failed: {exc}")
        return {"verdict": "insufficient_data", "notes": f"error: {exc}", "corrected": None}
