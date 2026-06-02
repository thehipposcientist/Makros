"""User-created exercises as deterministic planner candidates.

AI/manual entry can create private exercise rows, but the planner only
consumes normalized candidate dicts. This module is the validation and
adapter layer between those two worlds: AI may enrich a row, then this
pure adapter decides whether the row is structured enough for planning.
"""
from __future__ import annotations

import re
from dataclasses import replace
from typing import Iterable

from sqlmodel import Session, select

from app.enums import MuscleGroup
from app.models import UserCustomExercise
from app.services.workout.equipment import (
    custom_equipment_slug,
    equipment_name_slug_index,
    resolve_equipment_entry,
)
from app.seed_exercises_data import SEED_EQUIPMENT, hydrated_exercise


_VALID_MUSCLES = {m.value for m in MuscleGroup}
_VALID_PATTERNS = {
    "squat",
    "hinge",
    "lunge",
    "horizontal_press",
    "vertical_press",
    "horizontal_pull",
    "vertical_pull",
    "carry",
    "rotation",
    "anti_rotation",
    "anti_extension",
    "flexion",
    "isolation",
    "cardio",
    "mobility",
    "plyometric",
}
_PATTERN_ALIASES = {
    "hip_thrust": "hinge",
    "hip_extension": "hinge",
    "elbow_flexion": "isolation",
    "elbow_extension": "isolation",
    "core": "anti_extension",
    "abs": "flexion",
    "ab": "flexion",
}
_MUSCLE_ALIASES = {
    "abs": "core",
    "obliques": "core",
    "lat": "back",
    "lats": "back",
    "rear_delt": "shoulders",
    "front_delt": "shoulders",
    "side_delt": "shoulders",
}
_BODYWEIGHT_TOKENS = {"", "bodyweight", "body weight", "none", "no equipment", "bw"}
_FREE_WEIGHT_HOME = {
    "dumbbells",
    "adjustable_dumbbells",
    "kettlebell",
    "resistance_bands",
    "mini_band",
    "pull_up_bar",
    "suspension_trainer",
    "sturdy_chair",
    "plyo_box",
    "step_platform",
}
_CARDIO_SLUGS = {
    "treadmill",
    "stationary_bike",
    "elliptical",
    "rowing_machine",
    "stair_climber",
    "assault_bike",
    "swimming_pool",
    "battle_ropes",
    "outdoor_bike",
    "skierg",
    "versaclimber",
    "heavy_bag",
    "ruck_pack",
    "jump_rope",
}


def _text_key(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().lower().replace("_", " ")).strip()


def _slug_key(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")


def normalize_custom_muscle(value: object, fallback: str = "full_body") -> str:
    raw = _slug_key(value)
    raw = _MUSCLE_ALIASES.get(raw, raw)
    return raw if raw in _VALID_MUSCLES else fallback


def normalize_custom_pattern(value: object, name: str = "", primary_muscle: str | None = None) -> str | None:
    raw = _slug_key(value)
    raw = _PATTERN_ALIASES.get(raw, raw)
    if raw in _VALID_PATTERNS:
        return raw

    n = _text_key(name)
    pm = normalize_custom_muscle(primary_muscle, "")
    if re.search(r"\b(run|jog|bike|cycle|rower|rowing|elliptical|stair|swim|rope|sprint|walk)\b", n):
        return "cardio"
    if re.search(r"\b(mobility|stretch|yoga|flow)\b", n):
        return "mobility"
    if re.search(r"\b(plank|dead bug|hollow|rollout|pallof)\b", n):
        return "anti_extension"
    if re.search(r"\b(crunch|sit up|situp|leg raise|knee raise)\b", n):
        return "flexion"
    if re.search(r"\b(squat|leg press|hack squat|v squat)\b", n):
        return "squat"
    if re.search(r"\b(deadlift|rdl|good morning|hip thrust|glute bridge|swing|pull through)\b", n):
        return "hinge"
    if re.search(r"\b(lunge|split squat|step up|stepup)\b", n):
        return "lunge"
    if re.search(r"\b(bench|chest press|push up|pushup|dip)\b", n):
        return "horizontal_press"
    if re.search(r"\b(fly|flye|crossover|curl|extension|raise|kickback|pressdown|pushdown|calf)\b", n):
        return "isolation"
    if re.search(r"\b(overhead press|shoulder press|military press|pike press)\b", n):
        return "vertical_press"
    if re.search(r"\b(row|face pull)\b", n):
        return "horizontal_pull"
    if re.search(r"\b(pull up|pullup|chin up|chinup|pulldown|lat pull)\b", n):
        return "vertical_pull"
    if pm == "core":
        return "anti_extension"
    return None


def _is_compound_default(name: str, pattern: str | None, primary: str, explicit: bool | None) -> bool:
    if explicit is not None:
        return bool(explicit)
    if pattern in {"isolation", "anti_extension", "anti_rotation", "flexion", "mobility", "cardio"}:
        return False
    if pattern in {"squat", "hinge", "lunge", "horizontal_press", "vertical_press", "horizontal_pull", "vertical_pull", "carry"}:
        return True
    n = _text_key(name)
    return bool(re.search(r"\b(squat|deadlift|press|row|pull up|pullup|chin up|lunge|hip thrust)\b", n))


def _raw_equipment_parts(raw: str | None) -> list[str]:
    parts = re.split(r"[,/;]+|\s+\+\s+", str(raw or ""))
    out: list[str] = []
    seen: set[str] = set()
    for part in parts:
        text = part.strip()
        key = _text_key(text)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _infer_machine_slugs(name: str, primary: str, equipment_text: str) -> list[str]:
    text = f"{name} {equipment_text}".lower()
    slugs: list[str] = []
    if any(token in text for token in ("dual cable", "functional trainer", "cable crossover", "dual adjustable pulley")):
        slugs.append("dual_cable_station")
    elif any(token in text for token in ("single cable", "cable column", "single pulley", "single adjustable pulley")):
        slugs.append("single_cable_station")
    elif "cable" in text:
        slugs.append("cable_machine")
    if "smith" in text:
        slugs.append("smith_machine")
    if "leg press" in text:
        slugs.append("leg_press_machine")
    if "hack" in text:
        slugs.append("hack_squat_machine")
    if "belt squat" in text:
        slugs.append("belt_squat_machine")
    if "hip thrust" in text:
        slugs.append("hip_thrust_machine")
    if "kickback" in text:
        slugs.append("glute_kickback_machine")
    if "pullover" in text:
        slugs.append("pullover_machine")
    if "preacher" in text:
        slugs.append("preacher_curl_machine")
    if "lateral raise" in text:
        slugs.append("lateral_raise_machine")
    if "pec deck" in text or "pec fly" in text or "chest fly" in text:
        slugs.append("pec_deck_machine")
    if "lat pulldown" in text or "pulldown" in text:
        slugs.append("lat_pulldown_machine")
    if "high row" in text:
        slugs.append("high_row_machine")
    elif "row" in text:
        slugs.extend(["machine_row_station", "seated_row_machine"])
    if "shoulder press" in text:
        slugs.append("shoulder_press_machine")
    if "chest press" in text or ("press" in text and primary == "chest"):
        slugs.extend(["plate_loaded_chest_press_machine", "chest_press_machine"])
    if "leg extension" in text or ("extension" in text and primary == "quads"):
        slugs.append("leg_extension_machine")
    if "leg curl" in text or ("curl" in text and primary == "hamstrings"):
        slugs.append("leg_curl_machine")
    if "calf" in text:
        slugs.extend(["standing_calf_raise_machine", "seated_calf_raise_machine"])
    if "ab crunch" in text or "crunch machine" in text:
        slugs.append("ab_crunch_machine")
    if "v squat" in text or "v-squat" in text:
        slugs.append("v_squat_machine")
    if "rotary" in text or "torso rotation" in text:
        slugs.append("rotary_torso_machine")
    if any(token in text for token in ("machine", "plate loaded", "plate-loaded", "selectorized", "hammer strength", "prime", "atlantis", "arsenal")):
        slugs.append("leverage_machines")
    return _unique(slugs)


def _unique(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


def custom_exercise_equipment_slugs(row: UserCustomExercise) -> list[str]:
    name_to_slug = equipment_name_slug_index()
    valid_slugs = {e["slug"] for e in SEED_EQUIPMENT}
    slugs: list[str] = []

    stored = getattr(row, "equipment_slugs", None)
    if isinstance(stored, list):
        slugs.extend(str(s) for s in stored if str(s or "").strip())

    raw_equipment = str(getattr(row, "equipment", "") or "")
    for part in _raw_equipment_parts(raw_equipment):
        resolved = resolve_equipment_entry(part, name_to_slug, valid_slugs)
        if resolved:
            slugs.append(resolved)
        custom_slug = custom_equipment_slug(part)
        if custom_slug:
            slugs.append(custom_slug)

    primary = normalize_custom_muscle(getattr(row, "primary_muscle", None))
    slugs.extend(_infer_machine_slugs(getattr(row, "name", ""), primary, raw_equipment))
    return _unique(slugs)


def custom_exercise_equipment_bucket(slugs: list[str], equipment_text: str) -> str:
    text = _text_key(equipment_text)
    if text in _BODYWEIGHT_TOKENS:
        return "bodyweight"
    if any(slug in _CARDIO_SLUGS for slug in slugs):
        return "cardio"
    if any(slug in {"dumbbells", "adjustable_dumbbells"} for slug in slugs):
        return "dumbbells"
    if any(token in text for token in ("bodyweight", "no equipment", "none")):
        return "bodyweight"
    if any(token in text for token in ("dumbbell", "db")):
        return "dumbbells"
    if any(token in text for token in ("machine", "plate loaded", "plate-loaded", "selectorized", "hammer strength", "prime", "atlantis", "arsenal")):
        return "gym"
    if slugs and all(slug in _FREE_WEIGHT_HOME or slug.startswith("custom_equipment__") for slug in slugs):
        return "home"
    return "gym" if slugs else "bodyweight"


def custom_exercise_plan_status(row: UserCustomExercise) -> tuple[bool, str, str | None]:
    name = str(getattr(row, "name", "") or "").strip()
    primary = normalize_custom_muscle(getattr(row, "primary_muscle", None))
    movement = normalize_custom_pattern(getattr(row, "movement_pattern", None), name, primary)
    slugs = custom_exercise_equipment_slugs(row)
    bucket = custom_exercise_equipment_bucket(slugs, getattr(row, "equipment", ""))

    legacy_ai_ready = (
        getattr(row, "source", None) in {"ai", "ai_photo", "scan"}
        and bool(movement)
        and bool(name)
    )
    requested = bool(getattr(row, "plan_eligible", False)) or legacy_ai_ready
    if not requested:
        return False, "needs_review", "Plan use not enabled"
    if not name:
        return False, "blocked", "Exercise name is required"
    if primary not in _VALID_MUSCLES:
        return False, "blocked", "Primary muscle is not supported"
    if not movement:
        return False, "needs_review", "Movement pattern is required"
    if bucket != "bodyweight" and not slugs:
        return False, "needs_review", "Equipment could not be matched"
    return True, "planner_ready", None


def planner_candidate_from_custom(row: UserCustomExercise) -> dict | None:
    ready, status, _reason = custom_exercise_plan_status(row)
    if not ready or status != "planner_ready":
        return None

    name = str(row.name or "").strip()
    primary = normalize_custom_muscle(row.primary_muscle)
    secondaries = [
        m for m in _unique(normalize_custom_muscle(s, "") for s in (row.secondary_muscles or []))
        if m and m != primary
    ]
    movement = normalize_custom_pattern(row.movement_pattern, name, primary)
    slugs = custom_exercise_equipment_slugs(row)
    bucket = custom_exercise_equipment_bucket(slugs, row.equipment)
    exercise_type = "cardio" if movement == "cardio" else "mobility" if movement == "mobility" else "strength"
    tracking = (
        getattr(row, "default_tracking_mode", None)
        or ("time" if exercise_type in {"cardio", "mobility"} or re.search(r"\b(sec|seconds|min|minutes|hold)\b", str(row.reps or ""), re.I) else "reps")
    )
    equipment_entries = [] if bucket == "bodyweight" else [
        {"slug": slug, "role": "primary", "required": False}
        for slug in slugs
    ]

    return hydrated_exercise({
        "slug": f"user_custom_{row.user_id}_{row.id}",
        "name": name,
        "primary_muscle": primary,
        "secondary_muscles": secondaries,
        "equipment_bucket": bucket,
        "movement_pattern": movement,
        "exercise_type": exercise_type,
        "is_compound": _is_compound_default(name, movement, primary, row.is_compound),
        "is_machine": bucket == "gym" and any("machine" in slug or slug == "leverage_machines" for slug in slugs),
        "is_unilateral": False,
        "description": row.description or f"User-added exercise: {name}",
        "equipment": equipment_entries,
        "equipment_label": row.equipment or None,
        "image_url": row.image_url,
        "video_id": row.video_id,
        "demo_exercise_db_id": row.demo_exercise_db_id,
        "default_tracking_mode": tracking if tracking in {"reps", "time", "distance", "calories"} else "reps",
        "substitution_group": f"custom_{movement}_{primary}",
        "aliases": list(row.aliases or []),
        "is_custom": True,
        "user_custom_exercise_id": row.id,
        "difficulty": "intermediate",
    })


def planner_catalog_for_user(
    db: Session,
    user_id: int,
    seed_exercises: list[dict],
) -> tuple[list[dict], set[str]]:
    rows = db.exec(
        select(UserCustomExercise)
        .where(UserCustomExercise.user_id == user_id)
        .order_by(UserCustomExercise.created_at.desc())
    ).all()
    custom_candidates: list[dict] = []
    extra_owned: set[str] = set()
    seen_names = {str(ex.get("name") or "").strip().lower() for ex in seed_exercises}
    for row in rows:
        candidate = planner_candidate_from_custom(row)
        if candidate is None:
            continue
        name_key = str(candidate.get("name") or "").strip().lower()
        if not name_key or name_key in seen_names:
            continue
        seen_names.add(name_key)
        custom_candidates.append(candidate)
        for eq in candidate.get("equipment") or []:
            slug = eq.get("slug")
            if slug and str(slug).startswith("custom_equipment__"):
                extra_owned.add(str(slug))
    return [*custom_candidates, *seed_exercises], extra_owned


def with_custom_catalog_inputs(inputs, extra_owned_slugs: set[str]):
    if not extra_owned_slugs:
        return inputs
    owned = set(getattr(inputs, "equipment_slugs", ()) or ())
    owned.update(extra_owned_slugs)
    return replace(inputs, equipment_slugs=tuple(sorted(owned)))
