from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import openai
from openai import OpenAI
from fastapi import BackgroundTasks, HTTPException, Depends
from sqlmodel import Session, select

from app.auth import get_current_user
from app.database import engine, get_session
from app.models import PlanJob, User

from .router import router
from .models import PlanRequest, WorkoutOnlyRequest, NutritionOnlyRequest, ParseWorkoutsRequest
from .utils import (
    get_openai_api_key, model_plan_generation, model_plan_update,
    _build_chat_kwargs, _chat_create, _looks_truncated, _extract_json,
    _log_openai_error, enrich_foods_with_macros, compute_tdee_and_targets,
    map_goal_type, map_experience_level, map_progression_pace, map_recovery_level,
    SCHEMA_WORKOUT,
)
from .prompts import build_workout_prompt
from app.services.nutrition.meal_assembler import assemble_nutrition_response
from app.services.workout.planner import (
    PlannerInputs, generate_workout_plan as planner_generate_workout_plan,
)
from app.services.workout.history import (
    build_history_familiarity, db_history_lookup, propagate_session_targets,
    recent_exercise_slugs_by_muscle,
)
from app.services.workout.performance import build_performance_profile
from app.workout_progression import UserTrainingProfile, WorkoutProgressionEngine
from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES


def _validate_plans_legacy(plans: dict, req: PlanRequest) -> None:
    """Legacy single-plan validator — unused in parallel flow."""
    if "workout_plan" not in plans:
        raise ValueError("AI response missing 'workout_plan'")
    if "nutrition_plan" not in plans:
        raise ValueError("AI response missing 'nutrition_plan'")

    wp = plans["workout_plan"]
    days = wp.get("days", [])
    # Accept if AI generates at least 1 day (it may round down on very long plans)
    if not days:
        raise ValueError("workout_plan.days is empty")
    if len(days) < req.daysPerWeek - 1:
        raise ValueError(
            f"workout_plan.days has only {len(days)} entries, expected {req.daysPerWeek}"
        )

    np_ = plans["nutrition_plan"]
    if "targets" not in np_:
        raise ValueError("nutrition_plan missing 'targets'")

    # Require at least one meal — accept either the new `meals[]` shape or
    # the legacy slot keys for backwards compat with cached responses.
    if not _iter_meals(np_):
        raise ValueError("nutrition_plan has no meal entries")

    # Notes and supplementStack are logged but NOT blocking — the plan works without them
    trainer_note = plans.get("trainerNote", "") or wp.get("trainerNote", "")
    nutritionist_note = plans.get("nutritionistNote", "") or np_.get("nutritionistNote", "")
    if not trainer_note:
        print("[AI /plans] WARNING: trainerNote missing from response")
    if not nutritionist_note:
        print("[AI /plans] WARNING: nutritionistNote missing from response")
    if not np_.get("supplementStack"):
        print("[AI /plans] WARNING: supplementStack missing from response")



def build_user_exercise_library(equipment_slugs: list[str] | None) -> list[dict]:
    """Build the exercise library the AI is allowed to choose from.

    Filters `SEED_EXERCISES` by the user's owned equipment: an exercise is
    eligible if every `required=True` equipment entry on it is in the
    user's owned set, OR the exercise has no required equipment (pure
    bodyweight). Bodyweight-bucket exercises are always eligible.

    Each returned entry is the minimum the prompt + canonicalizer need:
        {
          "slug": str,
          "name": str,                 # canonical display name (e.g. "Barbell Squat")
          "primary_muscle": str,
          "equipment_label": str,      # human-readable equipment list
          "equipment_slugs": list[str],
        }

    Without this filter the AI used to invent exercises like "Squats" with
    no qualifier or "Leg Press" listed under the leg extension machine.
    Forcing the choice into a closed set kills both classes of bug.
    """
    from app.seed_exercises_data import SEED_EQUIPMENT, SEED_EXERCISES

    # The frontend stores `UserProfile.equipment` as DISPLAY NAMES
    # ("Dumbbells", "Flat bench") while the seed exercise library is keyed
    # by SLUGS ("dumbbells", "flat_bench"). If we filter raw names against
    # required-slug lists, NOTHING matches and the only exercises that
    # survive are the bodyweight-bucket ones — so a fully-equipped recomp
    # user ends up with an all-bodyweight plan even though they own a gym.
    # Build a name → slug index from SEED_EQUIPMENT and translate the
    # incoming list before any matching happens.
    name_to_slug = {e["name"].lower(): e["slug"] for e in SEED_EQUIPMENT}
    slug_to_name = {e["slug"]: e["name"] for e in SEED_EQUIPMENT}
    valid_slugs = set(slug_to_name.keys())

    owned: set[str] = set()
    for raw in (equipment_slugs or []):
        if not raw:
            continue
        if raw in valid_slugs:
            owned.add(raw)
            continue
        # Try as a display name (case-insensitive)
        slug = name_to_slug.get(raw.lower())
        if slug:
            owned.add(slug)

    # Also accept the legacy bucket strings so a user with `equipment:
    # ["bodyweight"]` still gets bodyweight exercises even though
    # "bodyweight" isn't an Equipment slug.
    owned_buckets = {"bodyweight", "home", "dumbbells", "gym", "other"} & set(equipment_slugs or [])

    print(f"[workout_library] resolved {len(owned)}/{len(equipment_slugs or [])} equipment entries → slugs: {sorted(owned)[:8]}{'...' if len(owned) > 8 else ''}")

    library: list[dict] = []
    for ex in SEED_EXERCISES:
        eq_entries = ex.get("equipment") or []
        required_slugs = [e["slug"] for e in eq_entries if e.get("required")]

        # Eligibility:
        #   - bodyweight bucket → always eligible (no required equipment, or
        #     all required equipment is owned)
        #   - other buckets → every required slug must be in `owned`
        bucket = ex.get("equipment_bucket")
        if required_slugs and not all(s in owned for s in required_slugs):
            # Required equipment missing — skip unless it's bodyweight
            # bucket AND the user owns "bodyweight" as a legacy bucket.
            if not (bucket == "bodyweight" and "bodyweight" in owned_buckets):
                continue

        # Build a human-readable equipment label from the primary + support
        # entries. Optional entries are deliberately omitted to keep the
        # prompt tight.
        labels = []
        for e in eq_entries:
            if e.get("role") in ("primary", "support") and e.get("required", True):
                labels.append(slug_to_name.get(e["slug"], e["slug"]))
        if not labels:
            labels.append("bodyweight")

        library.append({
            "slug": ex["slug"],
            "name": ex["name"],
            "primary_muscle": ex.get("primary_muscle", ""),
            "equipment_label": ", ".join(labels),
            "equipment_slugs": [e["slug"] for e in eq_entries],
        })
    return library


def _normalize_token(s: str) -> str:
    return " ".join(s.lower().replace("-", " ").replace("(", " ").replace(")", " ").split())


# Tokens that mark a library entry as a SPECIALIZED variant rather than a
# base movement. When the AI uses a generic name ("squats", "rows"), we
# don't want to promote it to the jump/single-leg/pause variant by accident.
_VARIANT_TOKENS = {
    "jump", "jumping", "single", "alternating", "pause", "tempo", "deficit",
    "decline", "incline", "weighted", "banded", "explosive", "depth", "tuck",
    "split", "lateral", "curtsy", "reverse",
}

# Tokens that mark an entry as a DEFAULT / canonical loaded variant. When
# the AI says "Squats" we prefer the barbell version over goblet → dumbbell
# → bodyweight when all three would otherwise tie.
_PRIMARY_LOAD_PRIORITY = ["barbell", "dumbbell", "machine", "cable", "kettlebell", "bodyweight"]


def _singular_token(t: str) -> str:
    return t[:-1] if len(t) > 3 and t.endswith("s") else t


def _match_library_exercise(name: str, library: list[dict]) -> dict | None:
    """Resolve an AI-returned exercise name to a real library entry.

    Three-tier match:
      1. Exact normalized name
      2. All AI-name tokens (singular-normalized) are a subset of a library
         entry's tokens — picks the BEST candidate by score, not the first
      3. Largest token-overlap fallback for fuzzy cases

    Tier-2 scoring prefers:
      * fewer specialty-variant tokens (no "jump", "single", "pause", etc.
        unless the AI name explicitly includes them)
      * smaller token count (closer to a base movement)
      * higher load-priority (barbell > dumbbell > machine > bodyweight)
    """
    if not name or not library:
        return None
    target = _normalize_token(name)
    target_tokens = {_singular_token(t) for t in target.split()}

    # Tier 1: exact normalized match (still uses raw tokens)
    for ex in library:
        if _normalize_token(ex["name"]) == target:
            return ex

    # Tier 2: AI tokens (singular-normalized) are a subset of library tokens.
    # Score each candidate; lowest score wins.
    candidates: list[tuple[tuple, dict]] = []
    for ex in library:
        ex_tokens_raw = set(_normalize_token(ex["name"]).split())
        ex_tokens = {_singular_token(t) for t in ex_tokens_raw}
        if not target_tokens or not target_tokens.issubset(ex_tokens):
            continue
        # Penalty for variant tokens that the AI didn't ask for.
        unwanted_variants = (ex_tokens - target_tokens) & _VARIANT_TOKENS
        variant_penalty = len(unwanted_variants)
        # Smaller token count → closer to a base movement.
        size_penalty = len(ex_tokens) - len(target_tokens)
        # Load priority: lower index = preferred (barbell first).
        load_index = len(_PRIMARY_LOAD_PRIORITY)  # default: worst
        for i, load in enumerate(_PRIMARY_LOAD_PRIORITY):
            if load in ex_tokens:
                load_index = i
                break
        score = (variant_penalty, size_penalty, load_index)
        candidates.append((score, ex))
    if candidates:
        candidates.sort(key=lambda c: c[0])
        return candidates[0][1]

    # Tier 3: best overlap fallback
    best: tuple[int, dict] | None = None
    for ex in library:
        ex_tokens = {_singular_token(t) for t in _normalize_token(ex["name"]).split()}
        if not ex_tokens:
            continue
        overlap = len(target_tokens & ex_tokens)
        if overlap < 2:
            continue
        if overlap / max(len(target_tokens), 1) < 0.5:
            continue
        if best is None or overlap > best[0]:
            best = (overlap, ex)
    return best[1] if best else None


def canonicalize_workout_exercises(workout_data: dict, library: list[dict]) -> dict:
    """Walk every day's exercises and rewrite each to match a library entry.

    For each exercise: try to resolve it to a library entry. If matched,
    overwrite the `name` and `equipment` fields with the canonical values.
    If not matched, log loudly but keep the AI's output as-is so we never
    drop an exercise outright.

    This kills the "Leg Press shown on the leg extension machine" class of
    bug because the equipment string can no longer drift from the seed.
    """
    if not library:
        return workout_data
    wp = workout_data.get("workout_plan") or {}
    days = wp.get("days") or []
    rewrites = 0
    misses = 0
    for day in days:
        for ex in day.get("exercises") or []:
            ai_name = str(ex.get("name") or "")
            match = _match_library_exercise(ai_name, library)
            if match:
                if ai_name != match["name"]:
                    rewrites += 1
                    print(f"[workout-canonicalize] '{ai_name}' → '{match['name']}'")
                ex["name"] = match["name"]
                ex["equipment"] = match["equipment_label"]
            else:
                misses += 1
                print(f"[workout-canonicalize] no match for '{ai_name}' — keeping AI output")
    if rewrites or misses:
        print(f"[workout-canonicalize] {rewrites} rewritten, {misses} unmatched")
    return workout_data


def _resolve_owned_equipment_slugs(equipment: list[str] | None) -> set[str]:
    """Translate the frontend's mixed equipment list (display names AND
    legacy bucket strings) into a set of canonical Equipment slugs the
    planner understands. Mirrors the logic inside
    `build_user_exercise_library` so both the AI-prompt path and the
    deterministic-planner path resolve equipment identically."""
    name_to_slug = {e["name"].lower(): e["slug"] for e in SEED_EQUIPMENT}
    valid_slugs = {e["slug"] for e in SEED_EQUIPMENT}
    owned: set[str] = set()
    for raw in (equipment or []):
        if not raw:
            continue
        if raw in valid_slugs:
            owned.add(raw)
            continue
        slug = name_to_slug.get(raw.lower())
        if slug:
            owned.add(slug)
    # Legacy bucket pass-through so `equipment: ["bodyweight"]` still
    # unlocks bodyweight exercises even though it isn't an Equipment slug.
    for bucket in ("bodyweight", "home", "dumbbells", "gym", "other"):
        if bucket in (equipment or []):
            owned.add(bucket)
    return owned


class _PlanReviewDisabled(Exception):
    """Sentinel raised inside `_build_deterministic_workout` when the
    AI plan review feature flag is off. Caught and silently swallowed
    so the deterministic plan ships unchanged. Not a real error."""


def _build_deterministic_workout(
    req: PlanRequest,
    db: Session | None,
    user_id: int | None,
) -> dict:
    """Build a workout plan deterministically from `workout_planner` and
    decorate it with history-aware next-session targets.

    Returns the same shape `_call_workout_ai` used to return:
        {"trainerNote": "", "workout_plan": {...}}
    except `trainerNote` is left blank — the caller fills it in with a
    small AI call that sees the already-built plan.

    `db` and `user_id` are optional so tests can call this without a
    Session. When they're missing, history familiarity and next-session
    target propagation are skipped gracefully (the planner still emits a
    valid plan, just without continuity bias or target weights)."""
    owned_slugs = _resolve_owned_equipment_slugs(req.equipment)
    # Priority region: new field takes precedence, fall back to legacy focused_muscle
    from app.services.workout.region_priority import normalize_region
    priority_region = normalize_region(
        getattr(req, "priorityRegion", None)
        or getattr(req.goalSelection, "targetFocus", None) if req.goalSelection else None
        or req.focusedMuscleGroup
    )
    focused: str | None = None
    if req.goalSelection is not None:
        focused = getattr(req.goalSelection, "targetFocus", None) or req.focusedMuscleGroup
    else:
        focused = req.focusedMuscleGroup

    # Query the user's most recent ~2 completed sessions (within the
    # last 36 hours), normalized to coarse training buckets. The
    # weekly recipe uses these to rotate day 0 away from anything
    # the user already trained recently. Empty tuple = no recent
    # signal; fresh week is fine.
    recent_focus_buckets: tuple[str, ...] = ()
    recent_focus_families: tuple[str, ...] = ()
    if db is not None and user_id is not None:
        try:
            from app.services.workout.history import most_recent_completed_focus
            # Expanded to 10 days / 10 entries so the planner can see
            # the full prior week for freshness, stimulus spacing, and
            # smarter rotation. Was 36h/2 which only saw the last 1-2
            # sessions — not enough for a 5-6 day program.
            buckets, families = most_recent_completed_focus(user_id, db, hours=240, limit=10)
            recent_focus_buckets = tuple(buckets)
            recent_focus_families = tuple(families)
            if recent_focus_buckets:
                print(
                    f"[plan-gen workout] recent focus (10d): "
                    f"buckets={list(recent_focus_buckets)} families={list(recent_focus_families)}"
                )
            else:
                print("[plan-gen workout] recent focus (10d): none")
        except Exception as e:
            print(f"[plan-gen workout] recent-focus lookup failed (non-fatal): {e}")
            recent_focus_buckets = ()
            recent_focus_families = ()

    print(
        f"[plan-gen workout] region={priority_region} focused={focused!r}"
    )
    inputs = PlannerInputs(
        goal=req.goal,
        days_per_week=max(1, min(7, req.daysPerWeek)),
        session_minutes=max(20, min(180, req.workoutDurationMinutes or 60)),
        experience=(req.experienceLevel or "intermediate").lower(),
        equipment_slugs=tuple(sorted(owned_slugs)),
        preferred_split=req.preferredSplit,
        focused_muscle=focused,
        priority_region=priority_region,
        preferred_exercises=tuple(req.preferredExercises or ()),
        disliked_exercises=tuple(req.dislikedExercises or ()),
        injuries=tuple(req.injuriesOrLimitations or ()),
        rng_seed=int(user_id or 0),
        recent_focus_buckets=recent_focus_buckets,
        recent_focus_families=recent_focus_families,
    )

    history_familiarity: dict[str, int] = {}
    recent_muscle_exercises: dict[str, set[str]] = {}
    perf_profiles_for_planner = None
    if db is not None and user_id is not None:
        try:
            history_familiarity = build_history_familiarity(user_id, db)
        except Exception as e:
            print(f"[plan-gen workout] history familiarity lookup failed (non-fatal): {e}")
            history_familiarity = {}
        try:
            recent_muscle_exercises = recent_exercise_slugs_by_muscle(user_id, db)
            if recent_muscle_exercises:
                print(f"[plan-gen workout] recent exercises by muscle: {', '.join(f'{k}={len(v)}' for k, v in recent_muscle_exercises.items())}")
        except Exception as e:
            print(f"[plan-gen workout] recent-muscle-exercises lookup failed (non-fatal): {e}")
            recent_muscle_exercises = {}
        try:
            # Performance profiles also power the in-planner
            # starting-weight + set-scheme pass so the FIRST plan
            # emitted already carries target loads for exercises with
            # history. The downstream `propagate_session_targets`
            # call below refines these using double-progression rules
            # — it is NOT redundant, it runs on different inputs.
            perf_profiles_for_planner = build_performance_profile(user_id, db)
        except Exception as e:
            print(f"[plan-gen workout] pre-plan performance profile lookup failed (non-fatal): {e}")
            perf_profiles_for_planner = None

    plan = planner_generate_workout_plan(
        inputs,
        SEED_EXERCISES,
        history_familiarity=history_familiarity,
        perf_profiles=perf_profiles_for_planner,
        recent_muscle_exercises=recent_muscle_exercises,
    )

    # Stamp each exercise with target_weight_lbs, progression_action,
    # progression_reason, recommendation_source, recommendation_confidence,
    # and recommendation_reason. The propagator uses the layered
    # recommendation pipeline so exercises without exact history still
    # get a transferred estimate from a substitution-group swap, a
    # same-pattern lift, or a same-muscle / same-equipment fallback.
    if db is not None and user_id is not None:
        try:
            profile = UserTrainingProfile(
                primary_goal=map_goal_type(req.goal),
                experience_level=map_experience_level(req.experienceLevel),
                recovery_level=map_recovery_level(req.recoveryLevel),
                progression_pace=map_progression_pace(None),
            )
            lookup = db_history_lookup(user_id, db)
            perf_profiles = build_performance_profile(user_id, db)
            all_by_slug = {ex["slug"]: ex for ex in SEED_EXERCISES}
            propagate_session_targets(
                plan,
                profile=profile,
                history_lookup=lookup,
                engine=WorkoutProgressionEngine(),
                perf_profiles=perf_profiles,
                all_exercises_by_slug=all_by_slug,
                experience=(req.experienceLevel or "intermediate"),
            )
        except Exception as e:
            print(f"[plan-gen workout] propagate_session_targets failed (non-fatal): {e}")

    # Enrich exercises with image URLs from the DB
    if db is not None:
        try:
            from app.models import Exercise as ExModel
            ex_names = set()
            for d in plan.get("workout_plan", {}).get("days", []):
                for ex in d.get("exercises", []):
                    ex_names.add(ex.get("name", ""))
            if ex_names:
                img_rows = db.exec(
                    select(ExModel.name, ExModel.image_url)
                    .where(ExModel.name.in_(ex_names))
                    .where(ExModel.image_url != None)
                ).all()
                img_map = {r[0]: r[1] for r in img_rows}
                for d in plan.get("workout_plan", {}).get("days", []):
                    for ex in d.get("exercises", []):
                        url = img_map.get(ex.get("name"))
                        if url:
                            ex["image_url"] = url
        except Exception:
            pass

    # ── Recent-history query (unconditional) ───────────────────────
    # MUST run regardless of whether the AI plan review is enabled,
    # because the trainer-note LLM call reads it too. Previously this
    # query lived inside the review try-block, so when review was
    # disabled (or when the block raised early) the trainer note
    # received `_recent_completed=None` and told the user they had
    # no recent sessions even when they had three. The result is
    # stashed on `plan["_recent_completed"]` so downstream consumers
    # (trainer note, optional review, optional AI regenerate) all
    # read from the same source.
    recent_completed_rows: list[dict] = []
    if db is not None and user_id is not None:
        try:
            from datetime import datetime, timedelta
            from sqlmodel import select
            from app.models import (
                ExerciseSet as _ExerciseSet,
                WorkoutCompletion as _WorkoutCompletion,
                WorkoutExercise as _WorkoutExercise,
                WorkoutSession as _WorkoutSession,
            )
            cutoff_date = (datetime.utcnow() - timedelta(hours=72)).date()

            # Query BOTH tables and merge by date. The lightweight
            # WorkoutCompletion row is the presence marker (every
            # finished workout writes one); the structured
            # WorkoutSession row carries per-exercise detail when the
            # mobile app posts exercises in the /workouts/complete
            # payload. Dropped the `completed_at IS NOT NULL` filter
            # on WorkoutSession because some write paths leave it
            # unset and that was hiding real data.
            comp_rows = db.exec(
                select(_WorkoutCompletion)
                .where(_WorkoutCompletion.user_id == user_id)
                .where(_WorkoutCompletion.workout_date >= cutoff_date)
                .order_by(_WorkoutCompletion.completed_at.desc())
                .limit(6)
            ).all()
            sess_rows = db.exec(
                select(_WorkoutSession)
                .where(_WorkoutSession.user_id == user_id)
                .where(_WorkoutSession.workout_date >= cutoff_date)
                .order_by(_WorkoutSession.workout_date.desc())
                .limit(12)
            ).all()

            sessions_by_key: dict[tuple, _WorkoutSession] = {}
            for s in sess_rows:
                key = (s.workout_date, (s.focus or "").strip())
                existing = sessions_by_key.get(key)
                if existing is None or (
                    (s.completed_at or s.created_at)
                    > (existing.completed_at or existing.created_at)
                ):
                    sessions_by_key[key] = s

            def _exercises_for_session(session_row) -> list[dict]:
                ex_rows = db.exec(
                    select(_WorkoutExercise)
                    .where(_WorkoutExercise.session_id == session_row.id)
                    .order_by(_WorkoutExercise.order_index.asc())
                ).all()
                out: list[dict] = []
                for er in ex_rows:
                    set_rows = db.exec(
                        select(_ExerciseSet)
                        .where(_ExerciseSet.workout_exercise_id == er.id)
                        .order_by(_ExerciseSet.set_number.asc())
                    ).all()
                    kept_sets = []
                    for sr in set_rows:
                        reps = sr.actual_reps or 0
                        weight = sr.actual_weight_lbs or 0
                        if reps == 0 and weight == 0:
                            continue
                        kept_sets.append({
                            "set_number": sr.set_number,
                            "reps": reps,
                            "weight_lbs": weight,
                        })
                    if kept_sets:
                        out.append({
                            "name": er.name,
                            "equipment": er.equipment,
                            "target_reps": er.target_reps_text,
                            "sets": kept_sets,
                        })
                return out

            enriched_hit = 0
            for r in comp_rows:
                key = (r.workout_date, (r.focus_label or "").strip())
                matching_session = sessions_by_key.get(key)
                ex_out: list[dict] = []
                if matching_session is not None:
                    ex_out = _exercises_for_session(matching_session)
                    if ex_out:
                        enriched_hit += 1
                recent_completed_rows.append({
                    "focus": r.focus_label,
                    "workout_date": r.workout_date,
                    "duration_seconds": r.duration_seconds,
                    "exercises": ex_out,
                })

            # Belt-and-braces: any leftover sessions without a
            # matching completion row (user used POST /workouts
            # directly) get appended so the trainer note still
            # sees them.
            seen_keys = {(r["workout_date"], (r["focus"] or "").strip()) for r in recent_completed_rows}
            for key, s in sessions_by_key.items():
                if key in seen_keys:
                    continue
                ex_out = _exercises_for_session(s)
                recent_completed_rows.append({
                    "focus": s.focus,
                    "workout_date": s.workout_date,
                    "duration_seconds": None,
                    "exercises": ex_out,
                })
                if ex_out:
                    enriched_hit += 1

            recent_completed_rows.sort(
                key=lambda r: r.get("workout_date") or "",
                reverse=True,
            )
            recent_completed_rows = recent_completed_rows[:6]

            print(
                f"[plan-gen workout] recent history: "
                f"{len(recent_completed_rows)} days, "
                f"{enriched_hit} with structured exercise data, "
                f"sessions_indexed={len(sessions_by_key)}"
            )
        except Exception as e:
            print(f"[plan-gen workout] recent history query failed (non-fatal): {e}")
            recent_completed_rows = []

    if not recent_completed_rows:
        # Fallback: focus-bucket list already computed for the
        # continuity-rotation path.
        recent_completed_rows = [
            {"focus": r, "workout_date": None, "duration_seconds": None, "exercises": []}
            for r in (recent_focus_buckets or ())
        ]

    # Stash unconditionally so the trainer-note call downstream (which
    # runs AFTER _build_deterministic_workout returns) reads real data
    # whether or not the AI review/regenerate is enabled. Underscore-
    # prefixed so nothing client-side renders it and the plan
    # validators leave it alone.
    plan["_recent_completed"] = recent_completed_rows
    print(
        f"[plan-gen workout] stashed _recent_completed: "
        f"{len(recent_completed_rows)} entries "
        f"(first focus={recent_completed_rows[0].get('focus') if recent_completed_rows else None!r})"
    )

    # ── Query skipped days (last 7 days) ─────────────────────────────
    # Passed into the AI reviewer brief so it knows what the user
    # deliberately skipped. A pattern of skipped sessions (e.g. 3 legs
    # skips in a row) signals the reviewer to swap the focus or flag
    # adherence concerns.
    skipped_days: list[dict] = []
    if db is not None and user_id is not None:
        try:
            from datetime import datetime, timedelta
            from sqlmodel import select
            from app.models import UserDayState as _UDS
            cutoff = (datetime.utcnow() - timedelta(days=7)).date()
            skip_rows = db.exec(
                select(_UDS).where(
                    _UDS.user_id == user_id,
                    _UDS.day_key >= cutoff,
                    _UDS.skipped_focus.isnot(None),
                )
            ).all()
            for sr in skip_rows:
                skipped_days.append({
                    "date": str(sr.day_key),
                    "focus": sr.skipped_focus,
                })
            if skipped_days:
                print(f"[plan-gen workout] skipped days (7d): {skipped_days}")
        except Exception as e:
            print(f"[plan-gen workout] skip query failed (non-fatal): {e}")
    plan["_skipped_days"] = skipped_days

    # ── AI plan review (final QA pass) — GATED BY ENV VAR ───────────
    # Disabled by default; set `PLAN_REVIEW_ENABLED=1` in the backend
    # env to re-enable. When enabled, the review call + AI regenerate
    # fallback run against the same `recent_completed_rows` computed
    # above. When disabled, only the deterministic plan ships.
    import os as _os
    _plan_review_enabled = _os.getenv("PLAN_REVIEW_ENABLED", "0") == "1"
    if not _plan_review_enabled:
        print("[plan-gen workout] AI plan review DISABLED (set PLAN_REVIEW_ENABLED=1 to re-enable)")

    try:
        if not _plan_review_enabled:
            raise _PlanReviewDisabled()
        from app.services.workout.plan_review import (
            apply_patches,
            build_plan_brief,
            review_plan,
        )

        # Resolve focused muscle from the same precedence chain the
        # deterministic planner uses: goalSelection.targetFocus wins
        # if present, otherwise fall back to the legacy
        # `focusedMuscleGroup` field. Previously this used
        # `getattr(req, "focusedMuscle", None)` which is a field that
        # DOES NOT EXIST on PlanRequest — so the AI review was always
        # blind to the user's muscle focus.
        _focused_for_ai: str | None = None
        if req.goalSelection is not None:
            _focused_for_ai = (
                getattr(req.goalSelection, "targetFocus", None)
                or req.focusedMuscleGroup
            )
        else:
            _focused_for_ai = req.focusedMuscleGroup

        # Extra goal context passed through so the reviewer can judge
        # secondary goals + goal details in addition to the primary
        # bucket. Secondary goal might be "maintain strength" on a fat
        # loss plan, for example — changes what a balanced plan looks
        # like to the reviewer.
        # secondaryGoal is deprecated (always None). targetFocus is the
        # only active "secondary" context the reviewer can use.
        _secondary_goal = _focused_for_ai  # pass target focus as secondary context
        _goal_details = None
        try:
            _goal_details = req.goalDetails.model_dump() if req.goalDetails else None
        except Exception:
            _goal_details = None

        brief = build_plan_brief(
            plan,
            goal=req.goal or "muscle_gain",
            days_per_week=int(req.daysPerWeek or 3),
            experience=(req.experienceLevel or "intermediate"),
            recent_completed=recent_completed_rows,
            injuries=tuple(req.injuriesOrLimitations or ()),
            focused_muscle=_focused_for_ai,
            secondary_goal=_secondary_goal,
            goal_details=_goal_details,
        )
        # Inject the user's chosen split so the reviewer doesn't
        # propose patches that conflict with the split structure.
        if req.preferredSplit:
            brief["user_preferred_split"] = req.preferredSplit
        # Inject skipped-day data so the reviewer can see patterns
        # (e.g. user keeps skipping legs → flag or swap).
        if skipped_days:
            brief["skipped_days_7d"] = skipped_days
        # Debug: full brief + AI verdict so we can iterate on the
        # reviewer prompt and the plan's structural choices.
        try:
            import json as _json
            print(
                "[plan-review] brief →\n"
                + _json.dumps(brief, indent=2, default=str)
            )
        except Exception:
            print(f"[plan-review] brief (unprintable): {brief}")

        review = review_plan(brief)
        print(
            f"[plan-review] AI verdict: status={review.status} "
            f"patches={len(review.patches)} error={review.error!r}"
        )
        print(f"[plan-review] AI notes: {review.notes}")
        for i, p in enumerate(review.patches):
            print(
                f"[plan-review] patch {i}: action={p.action} "
                f"day={p.day_index} ex={p.exercise_index} "
                f"new_name={p.new_name!r} new_sets={p.new_sets} "
                f"new_reps={p.new_reps!r} reason={p.reason!r}"
            )
        if review.status == "modify" and review.patches:
            # Belt-and-braces: any plan_day whose focus matches a
            # session the user ALREADY completed today gets blocked
            # from patches. The prompt is told to skip these, but the
            # AI occasionally ignores the rule — filter defensively.
            completed_today = set(brief.get("completed_today_focuses") or [])
            blocked_day_indices: set[int] = set()
            if completed_today:
                for day_meta in brief.get("plan_days") or []:
                    plan_focus = (day_meta.get("focus") or "").strip().lower()
                    if plan_focus in completed_today:
                        idx = day_meta.get("index")
                        if isinstance(idx, int):
                            blocked_day_indices.add(idx)
                if blocked_day_indices:
                    print(
                        f"[plan-review] blocking patches on day_indices "
                        f"{sorted(blocked_day_indices)} — user already "
                        f"completed those focuses today"
                    )
            _, applied = apply_patches(
                plan, review.patches,
                blocked_day_indices=blocked_day_indices,
            )
            for msg in applied:
                print(f"[plan-gen workout] review patch: {msg}")
            # Re-stamp load metadata on any patched exercises so the
            # new exercises inherit set schemes + target weights.
            try:
                from app.services.workout.planner import _stamp_load_metadata
                from app.services.workout.set_programming import build_set_scheme
                goal_bucket = plan.get("workout_plan", {}).get("goal_bucket") or "muscle_gain"
                all_by_slug_local = {ex["slug"]: ex for ex in SEED_EXERCISES if ex.get("slug")}
                for day in plan.get("workout_plan", {}).get("days", []) or []:
                    for ex_out in day.get("exercises", []) or []:
                        if not ex_out.get("_review_patched"):
                            continue
                        # Minimal exercise stub for set-scheme logic —
                        # swapped-in exercises from AI may not match a
                        # seed row, so we fall back to conservative
                        # defaults (isolation dumbbell) for the scheme.
                        exercise_stub = {
                            "slug": None,
                            "equipment_bucket": "dumbbell",
                            "is_compound": ex_out.get("_role") in ("primary", "compound"),
                            "movement_pattern": None,
                            "primary_muscle": ex_out.get("_primary_muscle"),
                        }
                        scheme = build_set_scheme(
                            exercise_stub,
                            total_sets=int(ex_out.get("sets") or 3),
                            reps=ex_out.get("reps", "8-12"),
                            rir_target=float(ex_out.get("_rir_target") or 2.0),
                            target_weight_lbs=ex_out.get("targetWeightLbs"),
                            goal_bucket=goal_bucket,
                            role=ex_out.get("_role") or "accessory",
                            experience=(req.experienceLevel or "intermediate"),
                        )
                        ex_out["setScheme"] = [s.to_dict() for s in scheme]
            except Exception as e:
                print(f"[plan-gen workout] re-stamp after patch failed (non-fatal): {e}")
        plan.setdefault("workout_plan", {})["review"] = {
            "status": review.status,
            "notes": review.notes,
            "patch_count": len(review.patches),
            "error": review.error,
        }
        # Attach the FULL brief + verdict + patches to the response
        # under `_debug.review` so the client can log it directly from
        # its own console. Backend also prints the same data so you
        # can cross-reference server-side logs. The field name is
        # underscore-prefixed so the frontend treats it as a debug
        # sidecar and ignores it when rendering.
        plan["_debug"] = {
            "review": {
                "brief": brief,
                "verdict": {
                    "status": review.status,
                    "notes": review.notes,
                    "error": review.error,
                    "patches": [
                        {
                            "action": p.action,
                            "day_index": p.day_index,
                            "exercise_index": p.exercise_index,
                            "new_name": p.new_name,
                            "new_equipment": p.new_equipment,
                            "new_sets": p.new_sets,
                            "new_reps": p.new_reps,
                            "new_rest_seconds": p.new_rest_seconds,
                            "new_focus": p.new_focus,
                            "reason": p.reason,
                        }
                        for p in review.patches
                    ],
                },
            },
        }

        # ── AI plan regenerate fallback ────────────────────────────
        # When the reviewer flags the deterministic plan as broken —
        # either status=modify (patches emitted) OR status=ok with
        # contradictory complaints in notes — ask the AI to build a
        # replacement plan from the equipment catalog. This is the
        # escape hatch for when the deterministic planner's output
        # is wrong in a way surgical patches can't fix (e.g. "5
        # lifting days for fat loss but no cardio"). AI success
        # replaces the plan wholesale; AI failure keeps the
        # deterministic (and possibly patched) plan.
        # Only regenerate from scratch when the reviewer said "ok" but
        # described real problems in notes (the ok-with-complaints
        # contradiction). When status="modify" AND patches were applied,
        # the plan is already fixed — regenerating would REPLACE the
        # patched deterministic plan with a free-form AI plan that
        # loses the user's chosen split, stimulus structure, etc.
        # NEVER regenerate the plan from scratch. The AI regenerate
        # path replaces the entire deterministic plan with a free-form
        # AI plan that loses the user's chosen split, stimulus types,
        # exercise families, and all planner invariants we enforce.
        # The deterministic planner + surgical patches is the source
        # of truth. The ok-with-complaints contradiction is logged
        # for debugging but does NOT trigger regen — the reviewer
        # frequently hallucinates issues (e.g. "no cardio days" when
        # there are 2 cardio days in the plan).
        should_regenerate = False
        if should_regenerate:
            try:
                from app.services.workout.plan_ai_regenerate import (
                    regenerate_plan_with_ai,
                )
                regen = regenerate_plan_with_ai(
                    failed_plan=plan,
                    review_notes=review.notes,
                    goal=req.goal or "muscle_gain",
                    days_per_week=int(req.daysPerWeek or 3),
                    experience=(req.experienceLevel or "intermediate"),
                    injuries=tuple(req.injuriesOrLimitations or ()),
                    # Same focus resolution as the review brief above.
                    focused_muscle=_focused_for_ai,
                    secondary_goal=_secondary_goal,
                    goal_details=_goal_details,
                    session_minutes=getattr(req, "workoutDurationMinutes", None),
                    recent_completed=recent_completed_rows,
                    all_exercises=SEED_EXERCISES,
                    owned_equipment_slugs=owned_slugs,
                )
            except Exception as e:
                print(f"[plan-gen workout] AI regenerate failed (non-fatal): {e}")
                regen = None

            if regen is not None:
                print(
                    f"[plan-gen workout] AI regenerate accepted — "
                    f"replacing deterministic plan with AI plan "
                    f"({len(regen.plan['workout_plan']['days'])} days)"
                )
                # Preserve the debug sidecar from the original review
                # so the client can still log what triggered the
                # regeneration.
                old_debug = plan.get("_debug")
                plan = regen.plan
                if old_debug:
                    plan["_debug"] = old_debug
                    plan["_debug"]["regenerated"] = {
                        "reason": "review flagged issues",
                        "notes": regen.notes,
                        "source": "ai_regenerate",
                    }
                # Re-stamp load metadata so set schemes and target
                # weights land on the AI-generated exercises (using
                # the same perf_profiles we loaded earlier for the
                # deterministic pass).
                try:
                    from app.services.workout.planner import _stamp_load_metadata
                    from app.seed_exercises_data import SEED_EXERCISES as _seed
                    from app.routers.ai.utils import infer_exercise_category  # noqa: F401 (touch to ensure import path)
                    _all_by_slug = {ex["slug"]: ex for ex in _seed if ex.get("slug")}
                    class _PresStub:
                        __slots__ = ("sets", "reps", "rest_seconds", "rir_target")
                        def __init__(self, s, r, rs, rir):
                            self.sets, self.reps, self.rest_seconds, self.rir_target = s, r, rs, rir
                    for day in plan.get("workout_plan", {}).get("days", []) or []:
                        for ex_out in day.get("exercises", []) or []:
                            slug = ex_out.get("_slug")
                            seed_ex = _all_by_slug.get(slug, {})
                            pres = _PresStub(
                                s=int(ex_out.get("sets") or 3),
                                r=str(ex_out.get("reps") or "8-12"),
                                rs=int(ex_out.get("restSeconds") or 90),
                                rir=float(ex_out.get("_rir_target") or 2.0),
                            )
                            _stamp_load_metadata(
                                ex_out,
                                exercise=seed_ex,
                                prescription=pres,
                                role=ex_out.get("_role") or "accessory",
                                goal_bucket=req.goal or "muscle_gain",
                                experience=(req.experienceLevel or "intermediate"),
                                perf_profiles=perf_profiles_for_planner,
                                all_exercises_by_slug=_all_by_slug,
                            )
                except Exception as e:
                    print(f"[plan-gen workout] re-stamp after AI regenerate failed (non-fatal): {e}")
            else:
                print(
                    "[plan-gen workout] AI regenerate rejected — "
                    "keeping deterministic plan"
                )
    except _PlanReviewDisabled:
        pass  # Silently skip — the disabled log already fired above.
    except Exception as e:
        print(f"[plan-gen workout] plan review failed (non-fatal): {e}")

    days = plan.get("workout_plan", {}).get("days") or []
    print(
        f"[plan-gen workout] deterministic — goal={req.goal} days={len(days)} "
        f"focused_muscle={focused!r} "
        f"history_exercises={len(history_familiarity)} "
        f"owned_eq={sorted(owned_slugs)[:6]}{'...' if len(owned_slugs) > 6 else ''}"
    )
    return plan


def _generate_trainer_note(
    client: OpenAI,
    req: PlanRequest,
    plan: dict,
    model: str | None = None,
) -> str:
    """Small LLM call that writes a 120-180 word note describing the
    already-built deterministic plan. Keeping this as an LLM call (vs. a
    template) because it's the one piece of the response users actually
    read, and a personalized description reads very differently from a
    "Day 1: Push / 5 exercises / progressive overload" string.

    Failure here is non-fatal — we return an empty string and the client
    falls back to the deterministic plan on its own. The plan itself is
    the contract; the note is a bonus."""
    try:
        wp = plan.get("workout_plan", {})
        days_summary: list[str] = []
        for d in wp.get("days", [])[:7]:
            ex_names = ", ".join(
                (ex.get("name") or "").strip()
                for ex in d.get("exercises", [])[:6]
            )
            days_summary.append(f"  {d.get('day', '?')} ({d.get('focus', '?')}): {ex_names}")
        days_block = "\n".join(days_summary) if days_summary else "  (no days)"

        # ── Recent 3-day history block ──────────────────────────────
        # Pulled from plan["_recent_completed"] which is stamped by
        # _build_deterministic_workout. Contains focus label, date,
        # duration, AND per-exercise sets (reps × weight) when the
        # user logged them via the structured completion path.
        recent = plan.get("_recent_completed") or []
        print(
            f"[plan-gen trainer-note] received {len(recent)} recent history entries "
            f"(first focus={recent[0].get('focus') if recent else None!r})"
        )
        recent_lines: list[str] = []
        for r in recent[:3]:
            focus = r.get("focus") or "?"
            date = str(r.get("workout_date") or "")
            dur = r.get("duration_seconds")
            dur_str = f" ({round(dur / 60)} min)" if dur else ""
            exs = r.get("exercises") or []
            if exs:
                ex_bits: list[str] = []
                for e in exs[:6]:
                    sets = e.get("sets") or []
                    if sets:
                        top = max(sets, key=lambda s: (s.get("weight_lbs") or 0, s.get("reps") or 0))
                        ex_bits.append(
                            f"{e.get('name')} {len(sets)}×"
                            f"top {int(top.get('reps') or 0)}@{int(top.get('weight_lbs') or 0)}lb"
                        )
                    else:
                        ex_bits.append(str(e.get('name') or ''))
                recent_lines.append(f"  {date} {focus}{dur_str}: {'; '.join(ex_bits)}")
            else:
                recent_lines.append(f"  {date} {focus}{dur_str}: (per-set data not captured)")
        recent_block = "\n".join(recent_lines) if recent_lines else "  (no recent sessions)"

        goal = (
            req.goalSelection.primaryGoal
            if req.goalSelection is not None
            else req.goal
        )
        injuries = ", ".join(req.injuriesOrLimitations or []) or "none"
        focused = None
        if req.goalSelection is not None:
            focused = getattr(req.goalSelection, "targetFocus", None) or req.focusedMuscleGroup
        else:
            focused = req.focusedMuscleGroup
        focus_line = f"Muscle focus: {focused} (boosted volume + exercise priority)\n" if focused else ""
        prompt = (
            "Write a 120-180 word explanation of this pre-built training plan to the user.\n\n"
            f"Goal: {goal}\n"
            f"Days/week: {req.daysPerWeek}\n"
            f"Session length: {req.workoutDurationMinutes or 60} min (INCLUDES warm-up — the deterministic planner reserves ~5 min of warm-up/ramp-up time inside every session's budget, so the user should NOT add extra time on top)\n"
            f"Experience: {req.experienceLevel or 'intermediate'}\n"
            f"{focus_line}"
            f"Injuries/limits: {injuries}\n"
            f"Split: {wp.get('name', 'custom split')}\n"
            f"Days:\n{days_block}\n\n"
            f"Recent 3-day history (what they actually trained):\n{recent_block}\n\n"
            "Cover: (1) WHY this split fits their goal and weekly frequency, "
            + (f"(1b) HOW the plan addresses their {focused} focus — cite specific exercises and extra volume, " if focused else "") +
            "(2) WHY the chosen exercises work for their equipment and any injuries — name 2 exercises, "
            "(3) HOW progression will work over the next 4 weeks, "
            "(4) what the user should FEEL by the end of a session so they can self-assess, "
            "(5) briefly reference ONE recent session to show you looked at their history "
            "(e.g. 'since you hit pull yesterday, day 1 leads with legs'). "
            "Speak directly to the user ('you'). No generic platitudes. "
            "FORMATTING: Return a SINGLE flowing paragraph of plain prose. "
            "No markdown, bold, headings, bullet points, numbered lists, or line "
            "breaks inside the note. One paragraph, 120-180 words. "
            'Return JSON: {"trainerNote": "..."}'
        )
        kwargs = _build_chat_kwargs(
            model or model_plan_generation(),
            [
                {"role": "system", "content": "You are an expert fitness coach. Be concise. Return only the required JSON."},
                {"role": "user", "content": prompt},
            ],
            max_tokens=450,
            timeout_secs=45,
        )
        response = _chat_create(client, **kwargs)
        raw = response.choices[0].message.content
        data = _extract_json(raw)
        note = (data or {}).get("trainerNote") or ""
        return str(note).strip()
    except Exception as e:
        print(f"[plan-gen trainer-note] failed (non-fatal): {e}")
        return ""


def _generate_nutritionist_note(
    client: OpenAI,
    req: PlanRequest,
    nutrition_data: dict,
    target_macros: tuple[int, int, int, int],
    review_summary: list[dict] | None = None,
    model: str | None = None,
) -> str:
    """Parallel to `_generate_trainer_note`. Writes a 200-280 word
    nutritionist note grounded in: (1) the deterministic targets from
    `compute_tdee_and_targets`, (2) a per-meal summary of the FIRST
    finalized template (post-review, post-normalize), (3) any patches
    the nutrition reviewer applied so the note can acknowledge the fix,
    (4) the user's goal / secondary goal / diet preference / allergies,
    (5) training load (days/week) so the note can connect fueling to
    the workout volume.

    Failure here is non-fatal — returns an empty string and the caller
    keeps whatever note the meal assembler already produced."""
    try:
        tgt_cal, tgt_prot, tgt_carbs, tgt_fat = target_macros
        plans_list = nutrition_data.get("nutrition_plans") or []
        first_np = plans_list[0] if plans_list else {}
        meals_in = first_np.get("meals") if isinstance(first_np, dict) else None
        if not isinstance(meals_in, list):
            meals_in = []

        meal_lines: list[str] = []
        for m in meals_in[:6]:
            if not isinstance(m, dict):
                continue
            name = m.get("name") or m.get("label") or "meal"
            cal = int(round(float(m.get("calories") or 0)))
            prot = int(round(float(m.get("protein") or 0)))
            carbs = int(round(float(m.get("carbs") or 0)))
            fat = int(round(float(m.get("fat") or 0)))
            items = m.get("items") or []
            item_names = ", ".join(
                str(it.get("name") or "") for it in items[:4] if isinstance(it, dict)
            )
            meal_lines.append(
                f"  {name}: {cal} cal / {prot}p / {carbs}c / {fat}f"
                + (f" — {item_names}" if item_names else "")
            )
        meals_block = "\n".join(meal_lines) if meal_lines else "  (no meals)"

        # ── Compute strengths + gaps from micronutrient totals ──
        # Mirror of the client-side nutritionLayers.ts rules. Sums the
        # first template's micronutrients and identifies anything notably
        # low (fiber, omega3, potassium, calcium, magnesium) or high
        # (sodium, saturated fat) so the note can cite real numbers.
        def _sum_micros(template: dict) -> dict[str, float]:
            """Sum micronutrients across meals. Reads BOTH snake_case
            (canonical backend) and camelCase (legacy) keys so we never
            miss data regardless of which path generated the meal."""
            totals: dict[str, float] = {}
            # Map canonical display keys → list of source keys to try.
            # The first match wins per-meal.
            KEY_MAP: dict[str, list[str]] = {
                "fiber":        ["fiber"],
                "sodium":       ["sodium"],
                "sugar":        ["sugar"],
                "saturated_fat":["saturated_fat", "saturatedFat"],
                "omega_3":      ["omega_3", "omega3"],
                "potassium":    ["potassium"],
                "calcium":      ["calcium"],
                "magnesium":    ["magnesium"],
                "iron":         ["iron"],
                "vitamin_d":    ["vitamin_d", "vitaminD"],
                "vitamin_c":    ["vitamin_c", "vitaminC"],
                "vitamin_b12":  ["vitamin_b12", "vitaminB12"],
            }
            for m in template.get("meals") or []:
                if not isinstance(m, dict):
                    continue
                micros = m.get("micronutrients") if isinstance(m.get("micronutrients"), dict) else {}
                for canonical, alts in KEY_MAP.items():
                    val = 0.0
                    # Check top-level meal keys first (fiber/sodium/sugar
                    # live there), then nested micronutrients dict.
                    for alt in alts:
                        v = m.get(alt) if alt in ("fiber", "sodium", "sugar") else None
                        if v is None:
                            v = micros.get(alt)
                        if v is not None:
                            try:
                                val = float(v)
                            except (TypeError, ValueError):
                                val = 0.0
                            break
                    totals[canonical] = totals.get(canonical, 0.0) + val
            return totals

        MIN_TARGETS = {  # daily target: higher-is-better nutrients
            "fiber": 28, "omega_3": 1600, "potassium": 3400,
            "calcium": 1000, "magnesium": 400, "vitamin_d": 15,
        }
        MAX_TARGETS = {  # lower-is-better
            "sodium": 2300, "saturated_fat": 20, "sugar": 50,
        }
        LABELS = {
            "fiber": "fiber", "omega_3": "omega-3", "potassium": "potassium",
            "calcium": "calcium", "magnesium": "magnesium", "vitamin_d": "vitamin D",
            "sodium": "sodium", "saturated_fat": "saturated fat", "sugar": "sugar",
        }

        micros = _sum_micros(first_np) if isinstance(first_np, dict) else {}
        strengths: list[str] = []
        gaps: list[str] = []
        for key, target in MIN_TARGETS.items():
            actual = micros.get(key, 0.0)
            if actual <= 0:
                continue
            if actual >= target * 1.15:
                strengths.append(f"{LABELS[key]} {int(round(actual))}")
            elif actual < target * 0.70:
                gaps.append(f"{LABELS[key]} {int(round(actual))} (target {target})")
        for key, target in MAX_TARGETS.items():
            actual = micros.get(key, 0.0)
            if actual <= 0:
                continue
            if actual > target * 1.15:
                gaps.append(f"{LABELS[key]} {int(round(actual))} (over {target})")

        strengths_line = "; ".join(strengths[:2]) if strengths else "none stand out"
        gaps_line      = "; ".join(gaps[:2])      if gaps      else "none significant"

        review_block = ""
        if review_summary:
            patch_bits: list[str] = []
            for rs in review_summary[:3]:
                patches_applied = rs.get("patches_applied") or 0
                if patches_applied:
                    patch_bits.append(
                        f"template {rs.get('template_index', '?')}: "
                        f"{patches_applied} fix(es) — {rs.get('notes', '')[:140]}"
                    )
            if patch_bits:
                review_block = (
                    "\n\nNutrition review corrections applied:\n  "
                    + "\n  ".join(patch_bits)
                    + "\n(You may briefly reference that the plan was reviewed and tuned.)"
                )

        goal = (
            req.goalSelection.primaryGoal
            if req.goalSelection is not None
            else req.goal
        )
        # The active goal model uses primaryGoal + targetFocus only.
        # secondaryGoal and modifiers are deprecated (always empty).
        target_focus = (
            getattr(req.goalSelection, "targetFocus", None)
            if req.goalSelection is not None
            else getattr(req, "focusedMuscleGroup", None)
        )
        diet = getattr(req, "dietaryPreference", None) or "no specific preference"
        allergens = ", ".join(getattr(req, "allergies", None) or []) or "none"
        goal_details = None
        try:
            goal_details = req.goalDetails.model_dump() if req.goalDetails else None
        except Exception:
            goal_details = None

        # Precompute derived numbers so the AI narrates real values
        # instead of drifting into generic "high protein" language.
        bw = float(getattr(req, "weightLbs", 0) or 0)
        prot_per_lb = round(tgt_prot / bw, 2) if bw > 0 else None
        total_cal_from_macros = (tgt_prot * 4) + (tgt_carbs * 4) + (tgt_fat * 9)
        pct_prot = round((tgt_prot * 4) / tgt_cal * 100) if tgt_cal else 0
        pct_carbs = round((tgt_carbs * 4) / tgt_cal * 100) if tgt_cal else 0
        pct_fat = round((tgt_fat * 9) / tgt_cal * 100) if tgt_cal else 0

        # Goal-specific rationale the AI should lean on so the note
        # isn't a generic "balanced nutrition" blurb. One short line
        # per goal that the prompt tells the AI to *expand on*, not
        # parrot verbatim.
        goal_key = (goal or "").lower()
        if "fat" in goal_key or "loss" in goal_key or "cut" in goal_key:
            goal_rationale = (
                f"{tgt_cal} kcal creates a moderate deficit for fat loss without "
                f"nuking training quality; {tgt_prot}g protein "
                f"({prot_per_lb or '?'} g/lb) preserves muscle while calories are low."
            )
        elif "gain" in goal_key or "bulk" in goal_key or "muscle" in goal_key:
            goal_rationale = (
                f"{tgt_cal} kcal gives a controlled surplus for lean muscle gain; "
                f"{tgt_prot}g protein ({prot_per_lb or '?'} g/lb) drives synthesis on "
                f"a {req.daysPerWeek or 3}-day lifting schedule."
            )
        elif "recomp" in goal_key:
            goal_rationale = (
                f"{tgt_cal} kcal is set near maintenance so you can add muscle and "
                f"drop fat simultaneously; high protein ({tgt_prot}g / "
                f"{prot_per_lb or '?'} g/lb) is the lever that makes recomp possible."
            )
        else:
            goal_rationale = (
                f"{tgt_cal} kcal is set at maintenance; {tgt_prot}g protein "
                f"({prot_per_lb or '?'} g/lb) supports performance on a "
                f"{req.daysPerWeek or 3}-day training schedule."
            )

        # Build supplement stack summary for the note. The skeleton AI
        # generates a supplementStack on every plan gen; the note should
        # reference the top 2-3 supplements so the user sees WHY they're
        # recommended.
        supp_stack = nutrition_data.get("supplementStack") or []
        if isinstance(supp_stack, list) and supp_stack:
            supp_lines = []
            for s in supp_stack[:3]:
                if isinstance(s, dict):
                    supp_lines.append(
                        f"  {s.get('name', '?')}: {s.get('dose', '?')}, "
                        f"{s.get('timing', '?')} — {s.get('purpose', '?')}"
                    )
            supp_block = "\n".join(supp_lines) if supp_lines else "  (none)"
        else:
            supp_block = "  (none generated)"

        # Build shared nutrition context (bodyweight, adherence, etc.)
        user_context_block = ""
        try:
            from app.services.nutrition.context import build_nutrition_context, format_for_prompt
            _nctx = build_nutrition_context(
                goal=goal,
                secondary_goal=target_focus,
                experience=getattr(req, "experienceLevel", None),
                bodyweight_lbs=bw,
                dietary_preference=diet,
                allergies=getattr(req, "allergies", None),
            )
            user_context_block = format_for_prompt(_nctx)
        except Exception:
            pass

        days_per_week = req.daysPerWeek or 3
        prompt = (
            "Write a 200-280 word grounded nutrition explanation for this user. "
            "This note must read like a registered dietitian explaining a plan "
            "tailored to THEIR specific goal and numbers.\n\n"
            "=== USER CONTEXT ===\n"
            f"Primary goal: {goal}\n"
            + (f"Target muscle focus: {target_focus}\n" if target_focus else "") +
            f"Bodyweight: {bw or '?'} lbs\n"
            f"Diet preference: {diet}\n"
            f"Allergies: {allergens}\n"
            f"Training: {days_per_week} lifting days/week, "
            f"{req.workoutDurationMinutes or 60} min/session\n"
            + (f"\n{user_context_block}\n" if user_context_block else "") +
            "\n=== DAILY TARGETS ===\n"
            f"Calories: {tgt_cal} kcal\n"
            f"Protein:  {tgt_prot} g  ({pct_prot}% of kcal, {prot_per_lb or '?'} g/lb bodyweight)\n"
            f"Carbs:    {tgt_carbs} g  ({pct_carbs}% of kcal)\n"
            f"Fat:      {tgt_fat} g  ({pct_fat}% of kcal)\n\n"
            "=== GOAL-SPECIFIC RATIONALE (expand on this, do not parrot) ===\n"
            f"{goal_rationale}\n\n"
            "=== FIRST TEMPLATE MEALS ===\n"
            f"{meals_block}\n\n"
            "=== MICRONUTRIENT STRENGTHS + GAPS ===\n"
            f"Strengths: {strengths_line}\n"
            f"Gaps: {gaps_line}\n"
            f"{review_block}\n\n"
            "=== SUPPLEMENT STACK ===\n"
            f"{supp_block}\n\n"
            "=== REQUIREMENTS (exactly 5) ===\n"
            f"1. Start with: \"At {tgt_cal} kcal and {tgt_prot}g protein "
            f"({prot_per_lb or '?'} g/lb)...\" — these exact numbers must appear "
            "in the first sentence.\n"
            f"2. Explain why this calorie level fits {goal} with {days_per_week} "
            "training days.\n"
            "3. Name one meal from the list and explain its role.\n"
            "4. If there are nutrient gaps, mention the top one with a specific "
            "food fix.\n"
            "5. If supplements are recommended, mention 1-2 and why.\n\n"
            "FORMATTING: Return a SINGLE flowing paragraph of plain prose. "
            "Do NOT use markdown, bold, headings, bullet points, numbered lists, "
            "or line breaks inside the note. One paragraph, 200-280 words, "
            "plain text only.\n\n"
            'Return JSON: {"nutritionistNote": "..."}'
        )
        kwargs = _build_chat_kwargs(
            model or model_plan_generation(),
            [
                {"role": "system", "content": "You are a registered dietitian and sports nutritionist. Be concise and direct. Return only the required JSON."},
                {"role": "user", "content": prompt},
            ],
            max_tokens=450,
            timeout_secs=45,
        )
        response = _chat_create(client, **kwargs)
        raw = response.choices[0].message.content
        data = _extract_json(raw)
        note = (data or {}).get("nutritionistNote") or ""
        return str(note).strip()
    except Exception as e:
        print(f"[plan-gen nutritionist-note] failed (non-fatal): {e}")
        return ""


def _call_workout_ai(client: OpenAI, prompt: str, model: str | None = None, max_tokens: int = 2000) -> dict:
    """Synchronous OpenAI call for the workout plan (run in a thread)."""
    last_error: Exception | None = None
    _model = model or model_plan_generation()
    token_limits = [max_tokens, max_tokens + 500]  # retry with more tokens if truncated
    for attempt, tok_limit in enumerate(token_limits, start=1):
        try:
            kwargs = _build_chat_kwargs(
                _model,
                [
                    {"role": "system", "content": "You are an expert fitness coach. Be concise. Return only the required JSON."},
                    {"role": "user", "content": prompt},
                ],
                json_schema=SCHEMA_WORKOUT,
                max_tokens=tok_limit,
                timeout_secs=120,
            )
            response = _chat_create(client, **kwargs)
            raw = response.choices[0].message.content
            if _looks_truncated(raw):
                print(f"[AI /plans workout] attempt {attempt} TRUNCATED (tok_limit={tok_limit}) — retrying with more tokens")
                last_error = ValueError(f"response truncated at {tok_limit} tokens")
                continue
            data = _extract_json(raw)
            if not data.get("workout_plan") or not data["workout_plan"].get("days"):
                raise ValueError("workout_plan missing or has no days")
            print(f"[AI /plans workout] attempt {attempt} OK — {len(data['workout_plan']['days'])} days")
            return data
        except json.JSONDecodeError as e:
            last_error = ValueError(f"invalid JSON attempt {attempt}: {e}")
            print(f"[AI /plans workout] attempt {attempt} JSON decode error: {e}")
        except ValueError as e:
            last_error = e
            print(f"[AI /plans workout] attempt {attempt} value error: {e}")
        except (openai.APIStatusError, openai.APIConnectionError, openai.APITimeoutError) as e:
            diag = _log_openai_error("AI /plans workout", attempt, _model, e)
            raise ValueError(diag) from e
        except Exception as e:
            print(f"[AI /plans workout] attempt {attempt} unexpected {type(e).__name__}: {e}")
            raise
    raise ValueError(f"Workout AI failed after {len(token_limits)} attempts: {last_error}")


_FOOD_STOPWORDS = {"and", "or", "the", "with", "of", "in", "a", "an", "raw", "cooked", "fresh", "plain"}


def _food_tokens(s: str) -> list[str]:
    """Tokenize a food name into significant stemmed words (plural-normalized)."""
    out: list[str] = []
    for w in s.lower().replace("-", " ").replace(",", " ").split():
        if not w.isalpha():
            continue
        if w in _FOOD_STOPWORDS:
            continue
        if len(w) <= 2:
            continue
        # Cheap plural normalization
        if len(w) > 3 and w.endswith("s"):
            w = w[:-1]
        out.append(w)
    return out


def _food_covered(item: str, allowed_lower: list[str]) -> bool:
    """
    Return True if this food item is covered by at least one entry in allowed_lower.
    Rule: every significant token of an allowed phrase must appear in the item's
    tokens. This prevents "ground chicken" (allowed) from matching "ground beef"
    (item) — the shared "ground" word is no longer enough; "chicken" must also
    be present.
    """
    item_tokens = set(_food_tokens(item))
    if not item_tokens:
        return False
    for a in allowed_lower:
        a_tokens = _food_tokens(a)
        if not a_tokens:
            continue
        if all(tok in item_tokens for tok in a_tokens):
            return True
    return False


_LEGACY_MEAL_KEYS = ("breakfast", "lunch", "dinner", "snack", "snack_1", "snack_2")


def _adjusted_target_for_normalization(
    req: PlanRequest,
    full_target: tuple[int, int, int, int],
) -> tuple[int, int, int, int]:
    """Return the macro target the normalizer should scale assembled meals to.

    The assembler subtracts pinned-routine macros from the daily target
    before sizing meals. The normalizer then re-scales meal totals onto
    a target — and if that target is the FULL daily target, it cancels
    out the assembler's routine subtraction and produces a plan that
    overlays to double calories.

    The right behavior:
      * full_target → drives the calorie calculator + UI display
      * adjusted target (= full_target − routine_macros) → drives the
        normalizer math, so generated meals + routine overlay sums
        back to full_target.
    """
    routine_macros = getattr(req, "routineMacros", None) or {}
    if not isinstance(routine_macros, dict) or not routine_macros:
        return full_target
    t_cal, t_prot, t_carbs, t_fat = full_target
    r_cal  = int(routine_macros.get("calories", 0) or 0)
    r_prot = int(routine_macros.get("protein", 0) or 0)
    r_carb = int(routine_macros.get("carbs", 0) or 0)
    r_fat  = int(routine_macros.get("fat", 0) or 0)
    return (
        max(0, t_cal  - r_cal),
        max(0, t_prot - r_prot),
        max(0, t_carbs - r_carb),
        max(0, t_fat  - r_fat),
    )


def _iter_meals(nutrition_plan: dict) -> list[dict]:
    """Return the meal dicts for a nutrition template regardless of shape.

    New shape:    {"meals": [ {...}, {...} ]}
    Legacy shape: {"breakfast": {...}, "lunch": {...}, ...}

    The migration to a generic meals[] list is one-way — new responses
    always use the new shape — but the helpers in this module also run
    over cached / replayed responses, so we tolerate both here.
    """
    meals = nutrition_plan.get("meals")
    if isinstance(meals, list):
        return [m for m in meals if isinstance(m, dict)]
    out: list[dict] = []
    for k in _LEGACY_MEAL_KEYS:
        m = nutrition_plan.get(k)
        if isinstance(m, dict):
            out.append(m)
    return out


def _collect_unknown_foods(nutrition_plan: dict, allowed_foods: list[str]) -> list[str]:
    """Return food names in the plan that are NOT in the user's allowed foods.

    Reads both the canonical structured `items[]` shape (new prompt) AND
    the legacy `foods[]` parallel array, because different AI responses
    (and older cached payloads) use different shapes. Missing either one
    meant we silently let unknown foods through.
    """
    if not allowed_foods:
        return []
    allowed_lower = [f.lower() for f in allowed_foods]
    unknown: list[str] = []
    seen: set[str] = set()
    for meal in _iter_meals(nutrition_plan):
        # Prefer structured items[] when the AI emits the new shape.
        items = meal.get("items")
        if isinstance(items, list) and items:
            for it in items:
                if not isinstance(it, dict):
                    continue
                name = str(it.get("name", "")).strip()
                if not name:
                    continue
                if name.lower() not in seen and not _food_covered(name, allowed_lower):
                    unknown.append(name)
                    seen.add(name.lower())
        # Also check legacy foods[] for compatibility with older responses.
        for food_item in meal.get("foods", []):
            name = str(food_item).strip()
            if not name:
                continue
            if name.lower() not in seen and not _food_covered(name, allowed_lower):
                unknown.append(name)
                seen.add(name.lower())
    return unknown


def _build_custom_foods(
    result: dict,
    allowed_foods: list[str],
    enriched: dict | None,
) -> list[dict]:
    """
    Find foods in the generated plan that aren't in the user's food list,
    look up their macros from the enrichment data, and return them as
    custom food entries the frontend can add to the user's library.
    """
    # Collect unknown foods across all nutrition templates. Prefer the new
    # `nutrition_plans` array; fall back to the legacy A/B/C keys for
    # responses that still use the old shape.
    plans_list = result.get("nutrition_plans")
    if not isinstance(plans_list, list) or not plans_list:
        plans_list = [
            result.get("nutrition_plan_a"),
            result.get("nutrition_plan_b"),
            result.get("nutrition_plan_c"),
        ]
    all_unknown: set[str] = set()
    for np_ in plans_list:
        if not isinstance(np_, dict):
            continue
        unknowns = _collect_unknown_foods(np_, allowed_foods)
        all_unknown.update(u.lower() for u in unknowns)

    if not all_unknown:
        return []

    # Build a lookup from enriched data
    enriched_lookup: dict[str, dict] = {}
    if enriched:
        for f in enriched.get("foods", []):
            enriched_lookup[f.get("name", "").lower()] = f
        for rm in enriched.get("routine_meals", []):
            for fi in rm.get("foods", []):
                enriched_lookup[fi.get("name", "").lower()] = fi

    # Also scrape macros directly from the generated plan meals.
    plan_food_macros: dict[str, dict] = {}
    for np_ in plans_list:
        if not isinstance(np_, dict):
            continue
        for meal in _iter_meals(np_):
            foods_list = meal.get("foods", [])
            # If the meal has per-food macro breakdowns (some schemas do)
            per_food = meal.get("per_food_macros", [])
            if per_food and len(per_food) == len(foods_list):
                for name, macros in zip(foods_list, per_food):
                    if isinstance(macros, dict):
                        plan_food_macros[str(name).lower()] = macros

    # Canonical micronutrient fields we'll copy through when the
    # enrichment path supplied them. Clients store these alongside
    # macros so the insight engine has day-level rollup data.
    _MICRO_KEYS = (
        "fiber", "sugar", "sodium", "cholesterol",
        "saturated_fat", "monounsaturated_fat", "polyunsaturated_fat",
        "omega_3", "omega_6",
        "potassium", "calcium", "iron", "magnesium",
        "vitamin_c", "vitamin_d", "vitamin_b12",
    )

    custom_foods: list[dict] = []
    for name_lower in all_unknown:
        # Try enriched data first, then plan-extracted macros
        info = enriched_lookup.get(name_lower) or plan_food_macros.get(name_lower)
        if info:
            micros: dict[str, float] = {}
            for k in _MICRO_KEYS:
                v = info.get(k)
                if v is None:
                    continue
                try:
                    fv = float(v)
                    if fv != 0:
                        micros[k] = fv
                except (TypeError, ValueError):
                    continue
            entry = {
                "name": info.get("name", name_lower.title()),
                "unit": info.get("serving") or info.get("quantity") or "1 serving",
                "calories": info.get("calories", 0),
                "protein": info.get("protein", 0),
                "carbs": info.get("carbs", 0),
                "fat": info.get("fat", 0),
                # Tag verification status so the client's UI can show
                # a badge and the validate endpoint knows whether this
                # food has already been through verification.
                "verificationStatus": "ai_estimated",
            }
            if micros:
                entry["micronutrients"] = micros
            custom_foods.append(entry)
        else:
            # No macro data available — include with zeros so frontend knows about it
            custom_foods.append({
                "name": name_lower.title(),
                "unit": "1 serving",
                "calories": 0, "protein": 0, "carbs": 0, "fat": 0,
                "verificationStatus": "insufficient_data",
            })

    return custom_foods


def _sum_meal_macros(nutrition_plan: dict) -> tuple[int, int, int, int]:
    """Sum (calories, protein, carbs, fat) across every meal in a single
    nutrition template. Reads the meal-level totals (`meal.calories`,
    etc.), not per-item item macros — those are assembled data that
    the meal totals should already reflect, and the top-level values
    are what the user actually sees.
    """
    cal = prot = carbs = fat = 0
    for meal in _iter_meals(nutrition_plan):
        cal   += int(round(float(meal.get("calories", 0) or 0)))
        prot  += int(round(float(meal.get("protein",  0) or 0)))
        carbs += int(round(float(meal.get("carbs",    0) or 0)))
        fat   += int(round(float(meal.get("fat",      0) or 0)))
    return cal, prot, carbs, fat


def _normalize_template_to_target(
    nutrition_plan: dict,
    target_kcal: int,
    target_prot: int,
    target_carbs: int,
    target_fat: int,
) -> str | None:
    """Scale every meal (and every item inside it) by a uniform ratio so
    the template's meal-level sums match the computed targets exactly.

    Runs whenever the assembled meals don't already hit the target. The
    scale guard is wide ([0.2, 5.0]) because the deterministic variety=1
    path may produce a meal that's significantly under-target when only
    one or two foods cover a category, or routine meals eat most of the
    daily budget leaving small generated meals that still need scaling.

    Returns a human-readable summary of what was normalized (for logs),
    or None if no normalization was needed / possible.
    """
    actual_kcal, actual_prot, actual_carbs, actual_fat = _sum_meal_macros(nutrition_plan)
    if actual_kcal <= 0 or target_kcal <= 0:
        return None

    scale = target_kcal / actual_kcal
    # Wide guard — only bail when the assembled meal is so wrong it
    # almost certainly indicates a structural failure (missing meals,
    # nonsense input).
    if scale < 0.2 or scale > 5.0:
        return None
    # If we're already within 1%, skip — no need to mutate for rounding.
    if abs(scale - 1.0) < 0.01:
        return None

    def _mul(v, factor: float) -> int:
        if v is None:
            return 0
        try:
            return int(round(float(v) * factor))
        except (TypeError, ValueError):
            return 0

    for meal in _iter_meals(nutrition_plan):
        # Scale meal-level totals.
        meal["calories"] = _mul(meal.get("calories"), scale)
        meal["protein"]  = _mul(meal.get("protein"),  scale)
        meal["carbs"]    = _mul(meal.get("carbs"),    scale)
        meal["fat"]      = _mul(meal.get("fat"),      scale)
        if meal.get("fiber") is not None:
            meal["fiber"] = _mul(meal.get("fiber"), scale)
        # Scale every structured item's macros AND quantity so the
        # portions on screen reflect the new totals. Leaving quantity
        # alone and scaling macros would be physically wrong ("150 cal
        # eggs, 2 pieces" is a unit lie).
        items = meal.get("items")
        if isinstance(items, list):
            for it in items:
                if not isinstance(it, dict):
                    continue
                it["calories"] = _mul(it.get("calories"), scale)
                it["protein"]  = _mul(it.get("protein"),  scale)
                it["carbs"]    = _mul(it.get("carbs"),    scale)
                it["fat"]      = _mul(it.get("fat"),      scale)
                # Quantity: scale with a 2-decimal round so we don't
                # end up with "2.7283 eggs" in the display.
                q = it.get("quantity")
                if isinstance(q, (int, float)):
                    it["quantity"] = round(float(q) * scale, 2)

    _round_items_to_nice_units(nutrition_plan)

    # After scaling, verify we hit the target within 1% (rounding error).
    new_kcal, new_prot, new_carbs, new_fat = _sum_meal_macros(nutrition_plan)
    return (
        f"kcal {actual_kcal}→{new_kcal} (target {target_kcal}, scale {scale:.3f}); "
        f"prot {actual_prot}→{new_prot}g, carbs {actual_carbs}→{new_carbs}g, "
        f"fat {actual_fat}→{new_fat}g"
    )


# Rounding step per unit. Keys are the lowercased `unit` strings used by the
# assembler. Values are the increment to snap quantities to. After the
# normalizer scales quantities by fractional ratios ("2.0 eggs" becoming
# "1.99 eggs" to hit calorie target), this snaps each back to something a
# human would write on a shopping list — then rescales item macros so the
# numbers still match the displayed portion.
_UNIT_ROUND_STEPS: dict[str, float] = {
    "piece": 1.0,
    "slice": 1.0,
    "scoop": 0.5,
    "cup":   0.25,
    "tbsp":  0.5,
    "tsp":   0.25,
    "oz":    1.0,
    "fl_oz": 1.0,
    "lb":    0.25,
    "g":     5.0,
    "ml":    5.0,
    "serving": 0.5,
}


def _round_items_to_nice_units(nutrition_plan: dict) -> None:
    """Walk every meal's items and snap each quantity to a human-readable
    step based on its unit. Item macros rescale proportionally so the
    numbers on screen match the rounded portion.

    This is a trade: we accept ~1-2% drift from the exact calorie target in
    exchange for never showing "1.99 eggs" or "0.73 cups of rice". The
    calorie target is already an estimate (BMR formulas have ~5% error),
    so sub-percent precision isn't worth making meals read like a lab
    result.
    """
    for meal in _iter_meals(nutrition_plan):
        items = meal.get("items")
        if not isinstance(items, list):
            continue
        for it in items:
            if not isinstance(it, dict):
                continue
            unit = str(it.get("unit") or "").lower()
            step = _UNIT_ROUND_STEPS.get(unit, 0.25)
            q = it.get("quantity")
            if not isinstance(q, (int, float)) or q <= 0:
                continue
            # Snap to the nearest step, with a floor so items don't round
            # to zero and disappear.
            snapped = round(float(q) / step) * step
            if snapped < step:
                snapped = step
            if snapped == q:
                continue
            ratio = snapped / float(q)
            # Trim trailing float noise: "2.0" not "2.0000000004".
            it["quantity"] = round(snapped, 3)
            for macro_key in ("calories", "protein", "carbs", "fat"):
                v = it.get(macro_key)
                if isinstance(v, (int, float)):
                    it[macro_key] = int(round(float(v) * ratio)) if macro_key == "calories" else round(float(v) * ratio, 1)

        # Recompute meal-level totals from the re-rounded items so meal
        # cards match item-sum.
        recomputed = {"calories": 0.0, "protein": 0.0, "carbs": 0.0, "fat": 0.0}
        for it in items:
            if not isinstance(it, dict):
                continue
            for m in recomputed:
                v = it.get(m)
                if isinstance(v, (int, float)):
                    recomputed[m] += float(v)
        meal["calories"] = int(round(recomputed["calories"]))
        meal["protein"]  = round(recomputed["protein"],  1)
        meal["carbs"]    = round(recomputed["carbs"],    1)
        meal["fat"]      = round(recomputed["fat"],      1)


def _check_macro_drift(
    plans_list: list[dict],
    target_kcal: int,
    target_prot: int,
    target_carbs: int,
    target_fat: int,
) -> list[str]:
    """Return a list of human-readable drift messages, one per template
    whose meal sums are outside the acceptable tolerance from the
    computed targets. An empty list means every template is within spec.

    Tolerances (percent of target):
        calories: 2%    — tight; we have a deterministic normalization
                          pass that cleans up anything that slips past
                          this after retries, so we can afford to be
                          strict here
        protein:  7%
        carbs:    10%
        fat:      10%

    These thresholds are intentionally forgiving on macros but strict on
    calories. If calories drift, the deficit/surplus is wrong and the
    whole goal is off. Macros can wiggle a bit within the same calorie
    envelope and still hit the user's goal.
    """
    TOLERANCE_KCAL_PCT  = 0.02
    TOLERANCE_PROT_PCT  = 0.07
    TOLERANCE_CARBS_PCT = 0.10
    TOLERANCE_FAT_PCT   = 0.10

    drifts: list[str] = []
    for idx, np_ in enumerate(plans_list):
        if not isinstance(np_, dict):
            continue
        actual_kcal, actual_prot, actual_carbs, actual_fat = _sum_meal_macros(np_)
        if actual_kcal == 0 and actual_prot == 0:
            # Empty / unreadable template — let the existing validator
            # catch this, not us.
            continue

        issues: list[str] = []
        kcal_drift  = abs(actual_kcal - target_kcal)
        prot_drift  = abs(actual_prot - target_prot)
        carbs_drift = abs(actual_carbs - target_carbs)
        fat_drift   = abs(actual_fat - target_fat)

        if target_kcal > 0 and kcal_drift > target_kcal * TOLERANCE_KCAL_PCT:
            issues.append(f"calories={actual_kcal} (target {target_kcal}, off by {actual_kcal - target_kcal:+d})")
        if target_prot > 0 and prot_drift > target_prot * TOLERANCE_PROT_PCT:
            issues.append(f"protein={actual_prot}g (target {target_prot}g, off by {actual_prot - target_prot:+d})")
        if target_carbs > 0 and carbs_drift > target_carbs * TOLERANCE_CARBS_PCT:
            issues.append(f"carbs={actual_carbs}g (target {target_carbs}g, off by {actual_carbs - target_carbs:+d})")
        if target_fat > 0 and fat_drift > target_fat * TOLERANCE_FAT_PCT:
            issues.append(f"fat={actual_fat}g (target {target_fat}g, off by {actual_fat - target_fat:+d})")

        if issues:
            label = chr(ord("A") + idx)  # A / B / C / ...
            drifts.append(f"Template {label}: " + "; ".join(issues))
    return drifts



def _validate_plans(result: dict, req: PlanRequest) -> None:
    """Raise ValueError if the assembled plan result is structurally invalid."""
    wp = result.get("workout_plan")
    if not wp or not isinstance(wp, dict):
        raise ValueError("workout_plan missing from result")
    days = wp.get("days", [])
    if not days:
        raise ValueError("workout_plan has no days")
    if len(days) != req.daysPerWeek:
        print(f"[_validate_plans] WARN: expected {req.daysPerWeek} days, got {len(days)}")
    for d in days:
        if not d.get("exercises"):
            raise ValueError(f"Day '{d.get('day', '?')}' has no exercises")

    plans_list = result.get("nutrition_plans")
    if not isinstance(plans_list, list) or len(plans_list) == 0:
        raise ValueError("nutrition_plans missing or empty in result")
    for idx, np_ in enumerate(plans_list):
        if not isinstance(np_, dict):
            raise ValueError(f"nutrition_plans[{idx}] is not an object")
        if not np_.get("targets"):
            raise ValueError(f"nutrition_plans[{idx}] missing targets")
        # An empty meals[] is allowed when every meal is a routine
        # overlay handled by the client. We only reject the structural
        # case where neither shape is present at all.
        if "meals" not in np_ and not _iter_meals(np_):
            raise ValueError(f"nutrition_plans[{idx}] has no meal entries")


async def run_full_plan_generation(
    req: PlanRequest,
    *,
    db: Session | None = None,
    user_id: int | None = None,
) -> dict:
    """Shared plan-generation pipeline. Callable from both the sync /plans
    endpoint and the async background job worker. No auth, no HTTP — pure
    data in, data out. Raises ValueError on validation / generation errors.

    Runs enrichment, workout, and nutrition concurrently. The old flow
    waited for enrichment+workout before starting nutrition, turning a
    ~30s workout + ~30s nutrition into ~55s total wall time. Running all
    three in parallel drops it to ~max(workout, nutrition) ≈ 30s. The
    nutrition prompt is built *without* the enriched food block — the AI
    estimates macros on its own, which we've been doing successfully in
    production already. Enriched data still gets used for the
    `custom_foods` backfill at the end.
    """
    api_key = get_openai_api_key()
    if not api_key:
        raise ValueError("OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    _m = model_plan_generation()
    print(f"[plan-gen] parallel — goal={req.goal}, days={req.daysPerWeek}, model={_m}")
    # Loud diagnostic — routine accounting inputs. If this prints
    # `routineMacros=None routineSlots=[] mealRoutine=None` when the
    # user expects routines, the client → backend plumbing dropped
    # them and the assembler will build a full-target plan.
    print(
        f"[plan-gen] routine inputs — mealsPerDay={getattr(req, 'mealsPerDay', None)} "
        f"routineMacros={getattr(req, 'routineMacros', None)} "
        f"routineSlots={getattr(req, 'routineSlots', None)} "
        f"mealRoutine={bool(getattr(req, 'mealRoutine', None))}"
    )

    # Workout plan is now built deterministically from `workout_planner`,
    # seeded with the user's id for stable tie-breaking and decorated with
    # history-aware next-session targets. The LLM is used for the trainer
    # note below AND for the plan-review + AI-regenerate passes inside
    # `_build_deterministic_workout`. Those inner AI calls are SYNC
    # (openai SDK's blocking API), so we must wrap the whole function in
    # `asyncio.to_thread` or the background task hogs the event loop and
    # poll requests from the client start timing out at 30s.
    workout_data = await asyncio.to_thread(_build_deterministic_workout, req, db, user_id)

    # Deterministic target macros (source of truth for the assembler).
    targets_for_check = compute_tdee_and_targets(req)
    nutrition_target_macros = (
        int(targets_for_check["calories"]),
        int(targets_for_check["protein"]),
        int(targets_for_check["carbs"]),
        int(targets_for_check["fat"]),
    )

    variety_n = max(1, min(7, int(getattr(req, "mealVariety", 5) or 5)))

    # Hybrid nutrition pipeline: AI picks meal skeletons, algorithm solves
    # portions and hits macro targets. Runs in parallel with the trainer
    # note LLM call so the two AI round-trips overlap instead of
    # serializing.
    async def _run_nutrition() -> dict:
        enriched_local = await asyncio.to_thread(
            enrich_foods_with_macros, client, req.foodsAvailable, req.mealRoutine
        )
        nut = await asyncio.to_thread(
            assemble_nutrition_response,
            client, req, nutrition_target_macros, variety_n, req.foodsAvailable, enriched_local,
        )
        return {"enriched": enriched_local, "nutrition": nut}

    nutrition_bundle, trainer_note = await asyncio.gather(
        _run_nutrition(),
        asyncio.to_thread(_generate_trainer_note, client, req, workout_data, _m),
    )
    enriched = nutrition_bundle["enriched"]
    nutrition_data = nutrition_bundle["nutrition"]
    workout_data["trainerNote"] = trainer_note
    # Deterministic planner already emits canonical names and equipment
    # labels straight from the seed — no canonicalization pass needed.

    plans_list = nutrition_data.get("nutrition_plans") or []
    # Back-compat fallback in case the model still emits the legacy A/B/C keys.
    if not plans_list:
        legacy = [nutrition_data.get("nutrition_plan_a"), nutrition_data.get("nutrition_plan_b"), nutrition_data.get("nutrition_plan_c")]
        plans_list = [p for p in legacy if isinstance(p, dict)]
    # Deterministic backstop: scale each template exactly onto the target
    # macros. The assembler's solver gets us within a few percent; this
    # closes any residual drift so meal totals match the calorie calculator.
    #
    # CRITICAL: when pinned routines exist, the assembler already sized the
    # generated meals against `full_target − routine_macros`. The normalizer
    # must use the SAME adjusted target — using the full target would scale
    # the meals back UP and undo the routine subtraction. The full target is
    # still used for the `targets` field on each template so the UI shows
    # the user's actual daily goal.
    # ── AI nutrition-plan review (runs BEFORE normalization) ──
    # Gated by NUTRITION_REVIEW_ENABLED. Catches per-item macro
    # nonsense (e.g. "50 cal ribeye 8oz") so the numbers the user
    # sees reflect reality. Fixes propagate through normalization.
    import os as _os_n
    _nutrition_review_enabled = _os_n.getenv("NUTRITION_REVIEW_ENABLED", "0") == "1"
    _nutrition_review_summary: list[dict] = []
    if not _nutrition_review_enabled:
        print("[plan-gen nutrition] AI nutrition review DISABLED (set NUTRITION_REVIEW_ENABLED=1 to re-enable)")
    else:
        try:
            from app.services.nutrition.plan_review import (
                apply_nutrition_patches,
                build_nutrition_brief,
                review_nutrition_plan,
            )
            tgt_cal, tgt_prot, tgt_carbs, tgt_fat = nutrition_target_macros
            for idx, np_ in enumerate(plans_list):
                if not isinstance(np_, dict):
                    continue
                if np_.get("nutrition_validation", {}).get("ok"):
                    continue
                # Build shared nutrition context for the reviewer so it
                # knows bodyweight, experience, weight trend, adherence,
                # and recent workouts. Same blob the skeleton AI now sees.
                _review_ctx_str = ""
                try:
                    from app.services.nutrition.context import build_nutrition_context, format_for_prompt
                    _review_nctx = build_nutrition_context(
                        goal=req.goal,
                        secondary_goal=target_focus,  # target focus is the only active "secondary" context
                        experience=getattr(req, "experienceLevel", None),
                        bodyweight_lbs=getattr(getattr(req, "physicalStats", None), "weightLbs", None) if hasattr(req, "physicalStats") else None,
                        dietary_preference=getattr(req, "dietaryPreference", None),
                        allergies=getattr(req, "allergies", None),
                        db=db,
                        user_id=user_id,
                    )
                    _review_ctx_str = format_for_prompt(_review_nctx)
                except Exception:
                    pass
                brief = build_nutrition_brief(
                    np_,
                    goal=req.goal or "muscle_gain",
                    target_calories=tgt_cal,
                    target_protein=tgt_prot,
                    target_carbs=tgt_carbs,
                    target_fat=tgt_fat,
                    allowed_foods=req.foodsAvailable or [],
                    allergens=getattr(req, "allergies", None) or [],
                    diet_preference=getattr(req, "dietaryPreference", None),
                    nutrition_context=_review_ctx_str,
                )
                review = review_nutrition_plan(brief)
                print(
                    f"[nutrition-review] template {idx}: status={review.status} "
                    f"patches={len(review.patches)} error={review.error!r}"
                )
                print(f"[nutrition-review] notes: {review.notes}")
                if review.status == "modify" and review.patches:
                    _, applied = apply_nutrition_patches(np_, review.patches)
                    for msg in applied:
                        print(f"[nutrition-review] patch: {msg}")
                np_["nutrition_validation"] = {
                    "ok": review.status == "ok",
                    "reviewer": "ai",
                    "notes": review.notes,
                    "patches_applied": len(review.patches) if review.status == "modify" else 0,
                    "error": review.error,
                }
                _nutrition_review_summary.append({
                    "template_index": idx,
                    "status": review.status,
                    "notes": review.notes,
                    "patches_applied": len(review.patches) if review.status == "modify" else 0,
                })
        except Exception as exc:
            print(f"[nutrition-review] skipped due to error: {exc}")

    norm_target = _adjusted_target_for_normalization(req, nutrition_target_macros)
    t_kcal, t_prot, t_carbs, t_fat = norm_target
    for idx, np_ in enumerate(plans_list):
        if isinstance(np_, dict):
            summary = _normalize_template_to_target(np_, t_kcal, t_prot, t_carbs, t_fat)
            if summary:
                print(f"[plan-gen] normalized template {idx}: {summary}")

    # ── Grounded nutritionist note (mirrors the trainer note) ──
    # Regenerate the nutritionist note now that templates are reviewed
    # + normalized, so the note can reference the FINAL macros + meals
    # the user will actually see, plus any reviewer corrections. Falls
    # back to whatever the assembler produced if this call fails.
    try:
        grounded_note = await asyncio.to_thread(
            _generate_nutritionist_note,
            client,
            req,
            {"nutrition_plans": plans_list},
            nutrition_target_macros,
            _nutrition_review_summary,
            _m,
        )
        if grounded_note:
            nutrition_data["nutritionistNote"] = grounded_note
            print(f"[plan-gen] grounded nutritionist note generated ({len(grounded_note)} chars)")
            print(f"[plan-gen] note preview: {grounded_note[:200]}...")
        else:
            print("[plan-gen] grounded nutritionist note returned empty — keeping assembler's note")
    except Exception as exc:
        import traceback
        print(f"[plan-gen] grounded nutritionist note FAILED: {exc}")
        traceback.print_exc()

    result = {
        "trainerNote":      workout_data.get("trainerNote", ""),
        "nutritionistNote": nutrition_data.get("nutritionistNote", ""),
        "supplementStack":  nutrition_data.get("supplementStack", []),
        "workout_plan":     workout_data["workout_plan"],
        "nutrition_plans":  plans_list,
    }
    # Forward plan-review debug sidecar so the client can log what
    # the reviewer saw + decided. Absent when the reviewer skipped.
    if "_debug" in workout_data:
        result["_debug"] = workout_data["_debug"]
    _validate_plans(result, req)   # raises ValueError

    custom_foods = _build_custom_foods(result, req.foodsAvailable, enriched)
    if custom_foods:
        result["custom_foods"] = custom_foods

    # ── Post-assembly micro enrichment ─────────────────────────────
    # Walk every meal item in every template. Any item missing Layer 2
    # micros gets enriched via a batched AI call. This catches:
    # - Items from thin DB foods the lazy enrichment missed
    # - Items from routine meals that bypassed the enrichment path
    # - Items from custom/scanned foods with macros-only
    # Results are written directly onto the item dicts so the client
    # sees full micros on every item.
    try:
        _MICRO_CHECK = ("saturated_fat", "omega_3", "potassium", "calcium", "iron", "vitamin_d")
        thin_items: list[dict] = []
        for np_ in plans_list:
            if not isinstance(np_, dict):
                continue
            for meal in np_.get("meals") or []:
                if not isinstance(meal, dict):
                    continue
                # Check meal-level micros
                mn = meal.get("micronutrients") or {}
                has_layer2 = sum(1 for k in _MICRO_CHECK if isinstance(mn.get(k), (int, float)) and mn[k] > 0)
                if has_layer2 >= 3:
                    continue  # meal already has decent micros
                # Check per-item micros
                for it in meal.get("items") or []:
                    if not isinstance(it, dict):
                        continue
                    it_mn = it.get("micronutrients") or {}
                    it_has = sum(1 for k in _MICRO_CHECK if isinstance(it_mn.get(k), (int, float)) and it_mn[k] > 0)
                    if it_has < 2 and it.get("name"):
                        thin_items.append(it)

        if thin_items:
            print(f"[plan-gen] {len(thin_items)} meal items missing Layer 2 micros — enriching")
            from app.routers.ai.utils import _ai_backfill_micros
            # Build food-shaped dicts for the backfill function
            # Batch in groups of 20 to cover ALL thin items, not just the first 20
            all_backfill: dict[str, dict] = {}
            for batch_start in range(0, len(thin_items), 20):
                batch = thin_items[batch_start:batch_start + 20]
                food_dicts = [{"name": it.get("name"), "serving": f"{it.get('quantity',1)} {it.get('unit','serving')}"} for it in batch]
                chunk = _ai_backfill_micros(client, food_dicts)
                if chunk:
                    all_backfill.update(chunk)
            if all_backfill:
                for it in thin_items:
                    key = str(it.get("name", "")).strip().lower()
                    micros = all_backfill.get(key)
                    if not micros:
                        continue
                    # Write micros onto the item
                    it_mn = it.get("micronutrients") or {}
                    for mk, mv in micros.items():
                        if mk not in it_mn or not it_mn[mk]:
                            it_mn[mk] = mv
                            it[mk] = mv  # also top-level for legacy readers
                    it["micronutrients"] = it_mn
                # Re-sum meal-level micros from enriched items
                for np_ in plans_list:
                    if not isinstance(np_, dict):
                        continue
                    for meal in np_.get("meals") or []:
                        if not isinstance(meal, dict):
                            continue
                        items = meal.get("items") or []
                        if not items:
                            continue
                        resummed: dict[str, float] = {}
                        for it in items:
                            it_mn = it.get("micronutrients") or {}
                            for mk, mv in it_mn.items():
                                try:
                                    resummed[mk] = resummed.get(mk, 0.0) + float(mv or 0)
                                except (TypeError, ValueError):
                                    continue
                        if resummed:
                            meal["micronutrients"] = {k: round(v, 2) for k, v in resummed.items()}
                            if "fiber" in resummed:
                                meal["fiber"] = round(resummed["fiber"], 1)
                print(f"[plan-gen] enriched {len(backfill)} items, re-summed meal micros")
    except Exception as exc:
        print(f"[plan-gen] post-assembly micro enrichment failed (non-fatal): {exc}")

    # ── Classify food quality on each item ─────────────────────────────
    try:
        from app.services.nutrition.nutrition_score import classify_food_quality
        for np_ in plans_list:
            if not isinstance(np_, dict):
                continue
            for meal in np_.get("meals") or []:
                if not isinstance(meal, dict):
                    continue
                for it in meal.get("items") or []:
                    if not isinstance(it, dict) or it.get("food_quality"):
                        continue
                    it["food_quality"] = classify_food_quality(it)
    except Exception:
        pass

    # ── Allergen safety net — remove items matching user allergens ───────
    try:
        from app.services.nutrition.allergen_filter import filter_allergens
        user_allergens = getattr(req, "allergies", None) or []
        if user_allergens:
            filter_allergens(plans_list, allergens=user_allergens)
    except Exception as exc:
        print(f"[plan-gen] allergen filter failed (non-fatal): {exc}")

    print(f"[plan-gen] done — workout days={len(result['workout_plan'].get('days', []))}, nutrition templates={len(plans_list)}")
    return result


@router.get("/plans/split-options")
def get_split_options_endpoint(
    goal: str,
    daysPerWeek: int,
    experienceLevel: str = "intermediate",
    targetFocus: str | None = None,
    current_user: User = Depends(get_current_user),
):
    """Return scored split options for the user's goal + days + focus.

    Each option includes a fit_score, rationale, pros/cons, day labels,
    and a stimulus_note. When `targetFocus` is set (e.g. "glutes"),
    splits that give higher frequency for that muscle score higher.

    No plan is generated — this is a lightweight picker call."""
    from app.services.workout.split_options import get_split_options
    options = get_split_options(
        goal=goal,
        days_per_week=daysPerWeek,
        target_focus=targetFocus,
        experience=experienceLevel,
    )
    return {
        "options": [o.to_dict() for o in options],
        "recommended": next((o.id for o in options if o.is_recommended), None),
    }


from pydantic import BaseModel as _BaseModel

class EnrichItemsRequest(_BaseModel):
    items: list[dict]


@router.post("/plans/enrich-items")
async def enrich_items_endpoint(
    req: EnrichItemsRequest,
    current_user: User = Depends(get_current_user),
):
    """Enrich a list of food items with micronutrients.

    Accepts items like [{name, quantity, unit}] and returns them with
    full Layer 2 micros filled in. Used by the client to enrich routine
    meals and custom foods that bypass the normal plan gen enrichment."""
    if not req.items:
        return {"items": []}

    try:
        api_key = get_openai_api_key()
        client = OpenAI(api_key=api_key)
    except Exception:
        return {"items": []}

    from app.routers.ai.utils import _ai_backfill_micros
    food_dicts = [
        {
            "name": it.get("name"),
            "serving": f"{it.get('quantity', 1)} {it.get('unit', 'serving')}",
        }
        for it in req.items[:20]
        if it.get("name")
    ]
    if not food_dicts:
        return {"items": []}

    backfill = _ai_backfill_micros(client, food_dicts)
    enriched = []
    for it in req.items[:20]:
        name = str(it.get("name", "")).strip().lower()
        micros = backfill.get(name, {})
        enriched.append({
            "name": it.get("name", ""),
            "micronutrients": micros,
        })
    print(f"[enrich-items] enriched {len([e for e in enriched if e['micronutrients']])} of {len(enriched)} items")
    return {"items": enriched}


@router.post("/plans")
async def generate_plans(  # CODE_VERSION=NO_TEMP_2
    req: PlanRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Sync plan generation (legacy). New client code should use the job
    queue at `/ai/plans/enqueue` so long-running work survives app kill."""
    try:
        return await run_full_plan_generation(req, db=db, user_id=current_user.id)
    except ValueError as e:
        print(f"[AI /plans] FAILED — {e}")
        raise HTTPException(status_code=502, detail=str(e))


async def run_workout_only_generation(
    plan_req: PlanRequest,
    *,
    db: Session | None = None,
    user_id: int | None = None,
) -> dict:
    """Shared workout-only generator — callable from sync endpoint and job worker.

    Same deterministic-planner pipeline as `run_full_plan_generation`.
    The trainer note is generated by a small AI call that sees the
    already-built plan; failures there are non-fatal and return an empty
    string."""
    print(f"[plan-gen workout] goal={plan_req.goal}, days={plan_req.daysPerWeek}")
    # Wrap the deterministic+review+regenerate pipeline in a thread so
    # its internal SYNC OpenAI calls (plan_review, ai_regenerate) don't
    # block the event loop — otherwise poll requests stack up behind
    # the background task and the client hits its 30s abort. See the
    # matching note in `run_full_plan_generation`.
    workout_data = await asyncio.to_thread(_build_deterministic_workout, plan_req, db, user_id)

    api_key = get_openai_api_key()
    note = ""
    if api_key:
        client = OpenAI(api_key=api_key)
        note = await asyncio.to_thread(
            _generate_trainer_note, client, plan_req, workout_data, model_plan_update(),
        )
    workout_data["trainerNote"] = note
    out = {
        "trainerNote":  workout_data.get("trainerNote", ""),
        "workout_plan": workout_data["workout_plan"],
    }
    # Preserve the plan-review debug sidecar so the client can log
    # what the reviewer saw and what it decided. Only present when
    # the reviewer actually ran.
    if "_debug" in workout_data:
        out["_debug"] = workout_data["_debug"]
    return out


@router.post("/plans/workout")
async def generate_workout_plan(
    req: WorkoutOnlyRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Generate a workout plan only — called when equipment changes (sync legacy)."""
    plan_req = PlanRequest(
        goal=req.goal,
        secondaryGoal=req.secondaryGoal,
        focusedMuscleGroup=req.focusedMuscleGroup,
        goalDetails=req.goalDetails,
        physicalStats=req.physicalStats,
        daysPerWeek=req.daysPerWeek,
        workoutDurationMinutes=req.workoutDurationMinutes,
        equipment=req.equipment,
        foodsAvailable=[],
        experienceLevel=req.experienceLevel,
        injuriesOrLimitations=req.injuriesOrLimitations,
        userContext=req.userContext,
    )
    try:
        return await run_workout_only_generation(plan_req, db=db, user_id=current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")


async def run_nutrition_only_generation(plan_req: PlanRequest) -> dict:
    """Shared nutrition-only generator — callable from sync endpoint and job worker."""
    api_key = get_openai_api_key()
    if not api_key:
        raise ValueError("OpenAI API key not configured")
    client = OpenAI(api_key=api_key)
    _m = model_plan_update()
    print(f"[plan-gen nutrition] goal={plan_req.goal}, foods={len(plan_req.foodsAvailable)}")
    enriched = await asyncio.to_thread(
        enrich_foods_with_macros, client, plan_req.foodsAvailable, plan_req.mealRoutine
    )
    # Target macros for drift verification (see `_call_nutrition_ai`).
    targets_for_check = compute_tdee_and_targets(plan_req)
    nutrition_target_macros = (
        int(targets_for_check["calories"]),
        int(targets_for_check["protein"]),
        int(targets_for_check["carbs"]),
        int(targets_for_check["fat"]),
    )
    variety_n = max(1, min(7, int(getattr(plan_req, "mealVariety", 5) or 5)))
    nutrition_data = await asyncio.to_thread(
        assemble_nutrition_response,
        client, plan_req, nutrition_target_macros, variety_n, plan_req.foodsAvailable, enriched,
    )
    plans_list = nutrition_data.get("nutrition_plans") or []
    if not plans_list:
        legacy = [nutrition_data.get("nutrition_plan_a"), nutrition_data.get("nutrition_plan_b"), nutrition_data.get("nutrition_plan_c")]
        plans_list = [p for p in legacy if isinstance(p, dict)]
    # See `run_full_plan_generation` for the full explanation of why we use
    # the adjusted target (full minus routine macros) here instead of the
    # full daily target.
    norm_target = _adjusted_target_for_normalization(plan_req, nutrition_target_macros)
    t_kcal, t_prot, t_carbs, t_fat = norm_target
    for idx, np_ in enumerate(plans_list):
        if isinstance(np_, dict):
            summary = _normalize_template_to_target(np_, t_kcal, t_prot, t_carbs, t_fat)
            if summary:
                print(f"[plan-gen nutrition] normalized template {idx}: {summary}")
    # ── Grounded nutritionist note (same as full plan gen path) ──
    # Without this, nutrition-only regens keep the skeleton AI's generic
    # note, which doesn't cite actual numbers, nutrients, or supplements.
    try:
        _focused = (
            getattr(plan_req.goalSelection, "targetFocus", None)
            if plan_req.goalSelection else plan_req.focusedMuscleGroup
        )
        grounded_note = await asyncio.to_thread(
            _generate_nutritionist_note,
            client,
            plan_req,
            {"nutrition_plans": plans_list, "supplementStack": nutrition_data.get("supplementStack", [])},
            nutrition_target_macros,
            [],  # no review summary on nutrition-only path
            _m,
        )
        if grounded_note:
            nutrition_data["nutritionistNote"] = grounded_note
            print(f"[plan-gen nutrition] grounded note generated ({len(grounded_note)} chars)")
    except Exception as exc:
        print(f"[plan-gen nutrition] grounded note skipped: {exc}")

    result = {
        "nutritionistNote": nutrition_data.get("nutritionistNote", ""),
        "supplementStack":  nutrition_data.get("supplementStack", []),
        "nutrition_plans":  plans_list,
    }
    custom_foods = _build_custom_foods(result, plan_req.foodsAvailable, enriched)
    if custom_foods:
        result["custom_foods"] = custom_foods

    # Post-assembly micro enrichment (same as full plan gen path)
    try:
        _MICRO_CHECK = ("saturated_fat", "omega_3", "potassium", "calcium", "iron", "vitamin_d")
        thin_items: list[dict] = []
        for np_ in plans_list:
            if not isinstance(np_, dict):
                continue
            for meal in np_.get("meals") or []:
                if not isinstance(meal, dict):
                    continue
                mn = meal.get("micronutrients") or {}
                if sum(1 for k in _MICRO_CHECK if isinstance(mn.get(k), (int, float)) and mn[k] > 0) >= 3:
                    continue
                for it in meal.get("items") or []:
                    if not isinstance(it, dict):
                        continue
                    it_mn = it.get("micronutrients") or {}
                    if sum(1 for k in _MICRO_CHECK if isinstance(it_mn.get(k), (int, float)) and it_mn[k] > 0) < 2 and it.get("name"):
                        thin_items.append(it)
        if thin_items:
            print(f"[plan-gen nutrition] {len(thin_items)} items missing micros — enriching")
            from app.routers.ai.utils import _ai_backfill_micros
            # Batch in groups of 20 to cover ALL thin items
            all_backfill: dict[str, dict] = {}
            for batch_start in range(0, len(thin_items), 20):
                batch = thin_items[batch_start:batch_start + 20]
                food_dicts = [{"name": it.get("name"), "serving": f"{it.get('quantity',1)} {it.get('unit','serving')}"} for it in batch]
                chunk = _ai_backfill_micros(client, food_dicts)
                if chunk:
                    all_backfill.update(chunk)
            if all_backfill:
                for it in thin_items:
                    key = str(it.get("name", "")).strip().lower()
                    micros = all_backfill.get(key)
                    if not micros:
                        continue
                    it_mn = it.get("micronutrients") or {}
                    for mk, mv in micros.items():
                        if mk not in it_mn or not it_mn[mk]:
                            it_mn[mk] = mv
                            it[mk] = mv
                    it["micronutrients"] = it_mn
                for np_ in plans_list:
                    if not isinstance(np_, dict):
                        continue
                    for meal in np_.get("meals") or []:
                        if not isinstance(meal, dict):
                            continue
                        items = meal.get("items") or []
                        if not items:
                            continue
                        resummed: dict[str, float] = {}
                        for it in items:
                            for mk, mv in (it.get("micronutrients") or {}).items():
                                try:
                                    resummed[mk] = resummed.get(mk, 0.0) + float(mv or 0)
                                except (TypeError, ValueError):
                                    continue
                        if resummed:
                            meal["micronutrients"] = {k: round(v, 2) for k, v in resummed.items()}
                            if "fiber" in resummed:
                                meal["fiber"] = round(resummed["fiber"], 1)
                print(f"[plan-gen nutrition] enriched {len(backfill)} items")
    except Exception as exc:
        print(f"[plan-gen nutrition] post-assembly enrichment failed: {exc}")

    # ── Allergen safety net ───────────────────────────────────────────
    try:
        from app.services.nutrition.allergen_filter import filter_allergens
        user_allergens = getattr(plan_req, "allergies", None) or []
        if user_allergens:
            filter_allergens(plans_list, allergens=user_allergens)
    except Exception as exc:
        print(f"[plan-gen nutrition] allergen filter failed (non-fatal): {exc}")

    return result


@router.post("/plans/nutrition")
async def generate_nutrition_plan(
    req: NutritionOnlyRequest,
    current_user: User = Depends(get_current_user),
):
    """Generate a nutrition plan only — called when foods change (sync legacy).

    Forward every field the assembler uses for routine accounting and
    variety. Previously `routineMacros`, `routineSlots`, and `mealVariety`
    were silently dropped here, so the nutrition-only regen path entirely
    lost pinned routines and the assembler built a full-target plan that
    overlaid to double calories.
    """
    plan_req = PlanRequest(
        goal=req.goal,
        goalDetails=req.goalDetails,
        physicalStats=req.physicalStats,
        daysPerWeek=req.daysPerWeek,
        equipment=[],
        foodsAvailable=req.foodsAvailable,
        supplementsAvailable=req.supplementsAvailable,
        dietaryPreference=req.dietaryPreference,
        allergies=req.allergies,
        mealsPerDay=req.mealsPerDay,
        mealVariety=getattr(req, "mealVariety", 5) or 5,
        mealRoutine=req.mealRoutine,
        routineMacros=getattr(req, "routineMacros", None),
        routineSlots=list(getattr(req, "routineSlots", None) or []),
        customMacros=req.customMacros,
        userContext=req.userContext,
    )
    try:
        result = await run_nutrition_only_generation(plan_req)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")
        print(f"[AI /plans/nutrition] {len(custom_foods)} custom foods enriched")

    print(f"[AI /plans/nutrition] done — nutritionistNote={bool(result['nutritionistNote'])}")
    return result


@router.post("/parse-workouts")
def parse_recent_workouts(
    body: ParseWorkoutsRequest,
    current_user: User = Depends(get_current_user),
):
    """Parse natural language like 'legs yesterday, recovery today' into WorkoutSession objects."""
    api_key = get_openai_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="OpenAI API key not configured")

    client = OpenAI(api_key=api_key)
    today = body.currentDate or __import__("datetime").date.today().isoformat()

    prompt = f"""Parse the user's description of recent workouts into structured session data.
Today's date is {today}.

User said: "{body.text}"

Return a JSON array of workout sessions. For each workout mentioned:
- "date": ISO date string (YYYY-MM-DD). "today" = {today}, "yesterday" = the day before, etc.
- "focus": EXACTLY what the user said. Use their exact words for the focus. Common values: "Push", "Pull", "Legs", "Upper Body", "Lower Body", "Chest", "Back", "Shoulders", "Arms", "Full Body", "Cardio", "Recovery". Do NOT change or reinterpret the user's words — if they said "push", the focus is "Push".
- "completed": true (they did it)
- "durationSeconds": estimated duration in seconds (default 3600 if not mentioned)
- "exercises": array of exercises if mentioned, each with:
  - "name": exercise name
  - "sets": array of completed sets, each with "weightLbs" (number) and "reps" (number)

If the user just says a body part or type (e.g. "legs yesterday"), create the session with an empty exercises array — just log the date and focus.
If they mention specific exercises/weights (e.g. "benched 185 for 3x8"), include those.
If they say "rest day" or "off day", do NOT create a session for that day.

Return ONLY a valid JSON object with a "sessions" key — no markdown, no explanation:
{{
  "sessions": [
    {{
      "date": "YYYY-MM-DD",
      "focus": "string",
      "completed": true,
      "durationSeconds": 3600,
      "exercises": []
    }}
  ]
}}

If nothing parseable, return: {{"sessions": []}}"""

    try:
        resp = client.chat.completions.create(
            model=model_plan_generation(),
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            max_tokens=800,
        )
        raw = resp.choices[0].message.content or "[]"
        data = json.loads(raw)
        # Handle both {"sessions": [...]} and direct array
        sessions = data if isinstance(data, list) else data.get("sessions", data.get("workouts", []))
        print(f"[parse-workouts] parsed {len(sessions)} sessions from: {body.text[:80]}")
        return {"sessions": sessions}
    except Exception as e:
        print(f"[parse-workouts] error: {e}")
        return {"sessions": []}



# ──────────────────────────────────────────────────────────────────────────────
# Async job queue — plan generation that survives client app kills.
#
# The client enqueues a job, disconnects freely, then polls the status
# endpoint when it comes back. The backend owns the lifecycle, so a phone
# being locked, backgrounded, or even force-closed mid-generation doesn't
# interrupt the work — it keeps running in a FastAPI BackgroundTask and the
# result is persisted to `plan_jobs.result_json`.
#
# BackgroundTasks run in the same process, so if the backend container
# restarts, in-flight jobs are lost. On startup we mark any orphaned
# `running` jobs as `failed` (see `mark_orphaned_jobs_failed` below).
# For MVP that's fine — users can just retry.
# ──────────────────────────────────────────────────────────────────────────────


def _job_to_dict(job: PlanJob) -> dict:
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "error": job.error,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "updated_at": job.updated_at.isoformat() if job.updated_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "completed_at": job.completed_at.isoformat() if job.completed_at else None,
        # result is intentionally omitted from summary endpoints — callers
        # fetch it via the status endpoint only once per completed job
        "has_result": job.result_json is not None,
    }


async def _run_plan_job(job_id: int) -> None:
    """Background worker — runs one plan-gen job to completion.

    Opens its own DB session because BackgroundTasks run outside the
    request context. Status transitions:
        queued → running → completed | failed
    Cancellation (status=cancelled) is checked at the top; if the client
    cancelled before the worker picked up, we exit without doing work.
    """
    with Session(engine) as db:
        job = db.get(PlanJob, job_id)
        if not job:
            print(f"[plan-job {job_id}] not found")
            return
        if job.status == "cancelled":
            print(f"[plan-job {job_id}] cancelled before start")
            return

        job.status = "running"
        job.started_at = datetime.now(timezone.utc)
        job.updated_at = job.started_at
        db.add(job)
        db.commit()

        try:
            req_dict = job.request_json or {}
            # Re-hydrate the PlanRequest from stored JSON. PlanRequest is a
            # pydantic BaseModel so .model_validate accepts a dict.
            req = PlanRequest.model_validate(req_dict)
            if job.kind == "workout":
                result = await run_workout_only_generation(req, db=db, user_id=job.user_id)
            elif job.kind == "nutrition":
                result = await run_nutrition_only_generation(req)
            else:
                result = await run_full_plan_generation(req, db=db, user_id=job.user_id)

            # Re-check cancellation before saving — user might have cancelled
            # while the OpenAI call was in flight.
            db.refresh(job)
            if job.status == "cancelled":
                print(f"[plan-job {job_id}] cancelled mid-flight, discarding result")
                return

            # Stale per-day nutrition_plan rows from previous plan runs would
            # otherwise win over the fresh templates on the client (HomeScreen
            # checks day-state before AI templates). Clear them now so the new
            # plan is actually what the user sees across all days.
            if job.kind in ("nutrition", "full"):
                from app.models import UserDayState
                stale = db.exec(
                    select(UserDayState).where(UserDayState.user_id == job.user_id)
                ).all()
                cleared = 0
                for row in stale:
                    if row.nutrition_plan is not None:
                        row.nutrition_plan = None
                        db.add(row)
                        cleared += 1
                if cleared:
                    print(f"[plan-job {job_id}] cleared {cleared} stale day-state nutrition plans")

            job.status = "completed"
            job.result_json = result
            job.completed_at = datetime.now(timezone.utc)
            job.updated_at = job.completed_at
            db.add(job)
            db.commit()
            print(f"[plan-job {job_id}] completed")
        except Exception as e:
            db.refresh(job)
            if job.status == "cancelled":
                return
            job.status = "failed"
            job.error = str(e)[:500]
            job.completed_at = datetime.now(timezone.utc)
            job.updated_at = job.completed_at
            db.add(job)
            db.commit()
            print(f"[plan-job {job_id}] FAILED — {e}")


@router.post("/plans/enqueue")
async def enqueue_plan_job(
    req: PlanRequest,
    background_tasks: BackgroundTasks,
    kind: str = "full",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Enqueue a background plan-generation job. Returns the job id
    immediately; client polls `/ai/plans/job/{id}` for the result.

    `kind` is one of: full | workout | nutrition. Workout-only and
    nutrition-only jobs use the same PlanRequest body; the worker picks the
    appropriate generator. Kept as a query param (not body field) so the
    request shape stays identical to the legacy sync endpoints.
    """
    if kind not in ("full", "workout", "nutrition"):
        raise HTTPException(status_code=400, detail=f"Invalid kind: {kind}")

    # Cancel any earlier running jobs for this user so we don't stack work —
    # the client always wants the most recent request.
    pending = db.exec(
        select(PlanJob).where(
            PlanJob.user_id == current_user.id,
            PlanJob.status.in_(["queued", "running"]),
        )
    ).all()
    now = datetime.now(timezone.utc)
    for p in pending:
        p.status = "cancelled"
        p.updated_at = now
        db.add(p)

    job = PlanJob(
        user_id=current_user.id,
        kind=kind,
        status="queued",
        request_json=req.model_dump(),
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    background_tasks.add_task(_run_plan_job, job.id)
    print(f"[plan-job {job.id}] enqueued kind={kind} for user={current_user.id}")
    return _job_to_dict(job)


@router.get("/plans/job/{job_id}")
def get_plan_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Poll for job status. On `completed`, the full result payload is
    included; on other statuses, result is omitted."""
    job = db.get(PlanJob, job_id)
    if not job or job.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Job not found")
    out = _job_to_dict(job)
    if job.status == "completed":
        out["result"] = job.result_json
    return out


@router.delete("/plans/job/{job_id}")
def cancel_plan_job(
    job_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Cancel a queued or running job. If already completed / failed /
    cancelled, this is a no-op that still returns 200."""
    job = db.get(PlanJob, job_id)
    if not job or job.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status in ("queued", "running"):
        job.status = "cancelled"
        job.updated_at = datetime.now(timezone.utc)
        db.add(job)
        db.commit()
    return _job_to_dict(job)


@router.get("/plans/jobs/latest")
def get_latest_plan_job(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_session),
):
    """Return the most recent plan job for this user, if any. Client uses
    this on cold start to resume displaying a loading overlay if a job is
    still running from a previous session."""
    job = db.exec(
        select(PlanJob)
        .where(PlanJob.user_id == current_user.id)
        .order_by(PlanJob.created_at.desc())
    ).first()
    if not job:
        return {"job": None}
    out = _job_to_dict(job)
    if job.status == "completed":
        out["result"] = job.result_json
    return {"job": out}
