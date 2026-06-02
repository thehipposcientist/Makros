"""Exercise metadata helpers for live workout recommendation paths.

The active-workout recommendation endpoints often receive only a display
name plus an equipment string. Set programming needs richer metadata
(`is_compound`, movement pattern, primary muscle, canonical equipment
bucket) to pick the correct load increment.
"""
from __future__ import annotations

from app.seed_exercises_data import SEED_EXERCISES


def _normalize_name(value: str | None) -> str:
    if not value:
        return ""
    import re
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value).lower())).strip()


def _enum_value(value) -> str | None:
    if value is None:
        return None
    if hasattr(value, "value"):
        return str(value.value)
    return str(value)


def _infer_exercise_category(exercise_name: str) -> str:
    name = (exercise_name or "").lower()
    if any(x in name for x in [
        "machine", "cable", "smith", "leg press", "pulldown", "lat pull",
        "seated row machine", "pec deck", "leg extension", "leg curl",
        "hack squat machine", "chest press machine",
    ]):
        return "machine"
    if any(x in name for x in [
        "push up", "push-up", "pushup", "pull up", "pull-up", "pullup",
        "chin up", "chin-up", "chinup", "plank", "dip", "bodyweight",
        "muscle up", "handstand", "pistol squat", "l-sit", "hollow",
    ]):
        return "bodyweight"
    if any(x in name for x in [
        "curl", "extension", "raise", "fly", "flye", "kickback", "lateral",
        "pec deck", "face pull", "shrug", "calf raise", "wrist",
        "concentration", "preacher", "skull crusher", "pushdown",
    ]):
        return "isolation"
    return "compound"


def _seed_exercise_row(exercise_name: str, exercise_slug: str | None) -> dict | None:
    if exercise_slug:
        row = next((ex for ex in SEED_EXERCISES if ex.get("slug") == exercise_slug), None)
        if row is not None:
            return row
    if exercise_name:
        lname = _normalize_name(exercise_name)
        return next(
            (
                ex for ex in SEED_EXERCISES
                if _normalize_name(ex.get("name")) == lname
                or any(_normalize_name(alias) == lname for alias in (ex.get("aliases") or []))
            ),
            None,
        )
    return None


def resolve_seed_exercise_slug(exercise_name: str | None, exercise_slug: str | None = None) -> str | None:
    row = _seed_exercise_row(exercise_name or "", exercise_slug)
    slug = row.get("slug") if row else None
    return str(slug) if slug else None


def _primary_equipment_slug(seed_row: dict | None) -> str | None:
    equipment = (seed_row or {}).get("equipment")
    if not isinstance(equipment, list):
        return None
    primary = next(
        (
            item for item in equipment
            if isinstance(item, dict) and item.get("role") == "primary"
        ),
        None,
    )
    if isinstance(primary, dict) and primary.get("slug"):
        return str(primary.get("slug"))
    first = next((item for item in equipment if isinstance(item, dict)), None)
    return str(first.get("slug")) if first and first.get("slug") else None


def _equipment_slugs(exercise: dict | None) -> list[str]:
    equipment = (exercise or {}).get("equipment")
    if not isinstance(equipment, list):
        return []
    slugs: list[str] = []
    for item in equipment:
        if isinstance(item, dict):
            raw = item.get("slug") or item.get("name")
        else:
            raw = item
        if raw:
            slugs.append(str(raw).strip().lower().replace("-", "_").replace(" ", "_"))
    return [slug for slug in slugs if slug]


_NON_NUMERIC_EQUIPMENT = {
    "bodyweight",
    "body_weight",
    "none",
    "bw",
    "resistance_bands",
    "resistance_band",
    "bands",
    "band",
    "mini_band",
    "loop_band",
}

_NUMERIC_LOAD_EQUIPMENT_TOKENS = (
    "barbell",
    "dumbbell",
    "kettlebell",
    "cable",
    "machine",
    "plate",
    "smith",
    "landmine",
    "trap_bar",
    "ez_curl",
    "lat_pulldown",
    "pulldown",
    "leg_press",
)


def uses_numeric_load(exercise: dict | None) -> bool:
    """Whether pounds are a meaningful progression unit for this movement."""
    if not isinstance(exercise, dict):
        return True
    explicit = str(exercise.get("load_semantics") or "").strip().lower()
    if explicit in {"non_numeric", "band", "band_resistance", "bodyweight", "none"}:
        return False
    if explicit in {"resistance", "assistance", "counterweight"}:
        return True

    tracking_mode = str(
        exercise.get("default_tracking_mode") or exercise.get("defaultTrackingMode") or ""
    ).strip().lower()
    if tracking_mode in {"time", "distance", "calories"}:
        return False

    bucket = str(exercise.get("equipment_bucket") or "").strip().lower()
    if bucket in {"bodyweight", "none", "bw"}:
        return False
    if any(token in bucket for token in _NUMERIC_LOAD_EQUIPMENT_TOKENS):
        return True

    slugs = _equipment_slugs(exercise)
    if slugs:
        if any(any(token in slug for token in _NUMERIC_LOAD_EQUIPMENT_TOKENS) for slug in slugs):
            return True
        if all(slug in _NON_NUMERIC_EQUIPMENT for slug in slugs):
            return False

    text = " ".join(
        str(exercise.get(key) or "")
        for key in ("equipment", "equipment_bucket", "name", "slug")
    ).strip().lower().replace("-", "_").replace(" ", "_")
    if text and not any(token in text for token in _NUMERIC_LOAD_EQUIPMENT_TOKENS):
        if any(token in text for token in ("resistance_band", "mini_band", "loop_band")):
            return False

    return True


def equipment_bucket_for_set_programming(raw: str | None) -> str | None:
    text = (raw or "").strip().lower().replace("-", "_").replace(" ", "_")
    if not text:
        return None
    if any(token in text for token in ("bodyweight", "body_weight", "none", "bw")):
        return "bodyweight"
    if any(token in text for token in ("barbell", "trap_bar", "ez_curl", "landmine")):
        return "barbell"
    if "dumbbell" in text:
        return "dumbbell"
    if "cable" in text:
        return "cable"
    if any(token in text for token in (
        "machine", "leg_press", "lat_pulldown", "pulldown",
        "smith", "hack_squat", "chest_press", "shoulder_press",
    )):
        return "machine"
    if "plate" in text:
        return "plate"
    return text


def _db_exercise_row(db, exercise_name: str):
    if db is None or not exercise_name:
        return None
    try:
        from sqlmodel import select
        from app.models import Exercise
        return db.exec(select(Exercise).where(Exercise.name.ilike(exercise_name))).first()
    except Exception:
        return None


def set_programming_exercise_metadata(
    db,
    exercise_name: str,
    exercise_slug: str | None = None,
    equipment: str | None = None,
    primary_muscle: str | None = None,
) -> dict:
    """Build the exercise shape expected by set_programming.py."""
    seed_row = _seed_exercise_row(exercise_name, exercise_slug)
    db_row = _db_exercise_row(db, exercise_name) if seed_row is None else None

    seed_primary_equipment = _primary_equipment_slug(seed_row)
    equipment_bucket = (
        equipment_bucket_for_set_programming(equipment)
        or equipment_bucket_for_set_programming(seed_primary_equipment)
        or equipment_bucket_for_set_programming((seed_row or {}).get("equipment_bucket"))
        or equipment_bucket_for_set_programming(_enum_value(getattr(db_row, "equipment", None)))
    )

    category = _infer_exercise_category(exercise_name)
    if seed_row is not None and seed_row.get("is_compound") is not None:
        is_compound = bool(seed_row.get("is_compound"))
    elif db_row is not None:
        is_compound = bool(getattr(db_row, "is_compound", False))
    else:
        is_compound = category == "compound"

    resolved_primary = (
        primary_muscle
        or _enum_value((seed_row or {}).get("primary_muscle"))
        or _enum_value(getattr(db_row, "primary_muscle", None))
    )
    movement_pattern = (
        (seed_row or {}).get("movement_pattern")
        or getattr(db_row, "movement_pattern", None)
    )

    if equipment_bucket is None:
        if category == "bodyweight":
            equipment_bucket = "bodyweight"
        elif category == "machine":
            equipment_bucket = "machine"
        elif category == "isolation":
            equipment_bucket = "dumbbell"
        else:
            equipment_bucket = "barbell"

    return {
        "name": exercise_name,
        "slug": exercise_slug or (seed_row or {}).get("slug") or getattr(db_row, "slug", None),
        "equipment_bucket": equipment_bucket,
        "equipment": (seed_row or {}).get("equipment"),
        "load_semantics": (seed_row or {}).get("load_semantics"),
        "default_tracking_mode": (seed_row or {}).get("default_tracking_mode"),
        "is_compound": is_compound,
        "movement_pattern": movement_pattern,
        "primary_muscle": resolved_primary,
    }
